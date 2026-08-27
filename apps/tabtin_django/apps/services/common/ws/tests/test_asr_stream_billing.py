"""
ASR 流式路径计费回归测试。

背景：asr.stream.*（WS 流式转写）此前完全没有计费代码，转写免费、
成本全由平台承担；HTTP flash/standard 路径一直按 speech.asr.seconds 计费。
修复后：每次流会话终结（正常 stop / 上游错误 / consumer 断连）经 _cleanup
统一结算一次，走 _charge_speech_usage → CreditsService.consume_credits，
幂等 key = speech:asr_stream:{stream_id}。

覆盖用例：
  - 最终事件带 provider 时长 → 按 audioInfo.duration 结算
  - 无 provider 时长 → PCM 按累计字节数精确估算
  - PCM 零字节 / 连接失败 → 不按墙钟时长结算
  - 只有上游 send_bytes 成功的音频才计入时长
  - consumer 断连清理与正常 final 都结算，且重复 cleanup 不重复扣费
  - 时长不足 1 秒 → 按最少 1 秒结算
  - user_id 缺失 → 不结算
  - 计费异常 → 不影响流资源清理
"""
from __future__ import annotations

import asyncio
import os
import sys

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings")

if "test" not in sys.argv:
    sys.argv.append("test")

import django  # noqa: E402

django.setup()

from decimal import Decimal  # noqa: E402
from unittest.mock import AsyncMock, MagicMock, patch  # noqa: E402

from apps.services.common.ws.handlers.asr_stream import (  # noqa: E402
    _ASRStreamSession,
    _active_streams,
    cleanup_asr_streams_for_consumer,
)


def _make_session(
    *,
    user_id: str = "user-1",
    organization_id: str | None = "org-1",
    audio_format: str = "pcm",
    sample_rate: int = 16000,
) -> _ASRStreamSession:
    consumer = MagicMock()
    consumer.user_id = user_id
    consumer.organization_id = organization_id
    consumer.channel_name = "chan-1"
    consumer._send_envelope = AsyncMock()
    return _ASRStreamSession(
        stream_id="asr_test00000001",
        consumer=consumer,
        svc=MagicMock(),
        language="zh",
        audio_format=audio_format,
        sample_rate=sample_rate,
        ws_endpoint="bigmodel_async",
        extra_params={},
        billing_user_id=user_id,
        billing_organization_id=organization_id,
        provider="bytedance",
    )


@patch("apps.users.wallet.services.CreditsService.consume_credits")
def test_charge_uses_provider_reported_duration(mock_consume):
    session = _make_session()
    session._final_duration_ms = 3500
    asyncio.run(session._settle_billing())
    kwargs = mock_consume.call_args.kwargs
    assert kwargs["user_id"] == "user-1"
    assert kwargs["organization_id"] == "org-1"
    assert kwargs["meter_key"] == "speech.asr.seconds"
    assert kwargs["quantity"] == Decimal("3.5")
    assert kwargs["unit"] == "seconds"
    assert kwargs["provider_key"] == "bytedance"
    assert kwargs["biz_type"] == "asr_stream"
    assert kwargs["biz_id"] == session.stream_id
    assert kwargs["idempotency_key"] == f"speech:asr_stream:{session.stream_id}"


@patch("apps.users.wallet.services.CreditsService.consume_credits")
def test_charge_falls_back_to_pcm_bytes(mock_consume):
    session = _make_session()  # pcm 16k 单声道 = 32000 字节/秒
    session._audio_bytes_total = 32000 * 5  # 5 秒
    asyncio.run(session._settle_billing())
    assert mock_consume.call_args.kwargs["quantity"] == Decimal("5")


@patch("apps.users.wallet.services.CreditsService.consume_credits")
def test_zero_pcm_audio_does_not_fall_back_to_wall_clock(mock_consume):
    session = _make_session()
    session._started_monotonic -= 60

    asyncio.run(session._settle_billing())

    mock_consume.assert_not_called()


@patch("apps.users.wallet.services.CreditsService.consume_credits")
def test_invalid_pcm_sample_rate_does_not_fall_back_to_wall_clock(mock_consume):
    session = _make_session(sample_rate=0)
    session._audio_bytes_total = 32000
    session._started_monotonic -= 60

    asyncio.run(session._settle_billing())

    mock_consume.assert_not_called()


@patch("apps.users.wallet.services.CreditsService.consume_credits")
def test_connection_failure_without_audio_does_not_charge(mock_consume):
    session = _make_session()
    session.svc.build_auth_headers.return_value = {}
    session.svc.ws_url = "wss://asr.example.test/stream"
    session.svc.timeout_seconds = 30
    http_session = MagicMock()
    http_session.closed = False
    http_session.ws_connect = AsyncMock(side_effect=RuntimeError("connect failed"))
    http_session.close = AsyncMock()

    async def run() -> None:
        with patch(
            "apps.services.common.ws.handlers.asr_stream.aiohttp.ClientSession",
            return_value=http_session,
        ):
            try:
                await session.connect()
            except RuntimeError as exc:
                assert str(exc) == "connect failed"
            else:
                raise AssertionError("connect() should propagate the upstream failure")
        await session._cleanup()

    asyncio.run(run())

    http_session.close.assert_awaited_once()
    mock_consume.assert_not_called()


def test_audio_bytes_counted_only_after_successful_upstream_send():
    session = _make_session()
    session._ws = MagicMock()
    session._ws.send_bytes = AsyncMock(
        side_effect=[RuntimeError("send failed"), None],
    )
    audio = b"\x00" * 3200

    async def run() -> None:
        await session.send_audio(audio)
        await session.send_audio(audio)

    asyncio.run(run())

    assert session._audio_bytes_total == len(audio)


@patch("apps.users.wallet.services.CreditsService.consume_credits")
def test_send_failure_does_not_charge_unsent_pcm(mock_consume):
    session = _make_session()
    session._ws = MagicMock()
    session._ws.closed = True
    session._ws.send_bytes = AsyncMock(side_effect=RuntimeError("send failed"))

    async def run() -> None:
        await session.send_audio(b"\x00" * 32000)
        await session._cleanup()

    asyncio.run(run())

    assert session._audio_bytes_total == 0
    mock_consume.assert_not_called()


@patch("apps.users.wallet.services.CreditsService.consume_credits")
def test_charge_minimum_one_second(mock_consume):
    session = _make_session()
    session._audio_bytes_total = 3200  # 0.1 秒
    asyncio.run(session._settle_billing())
    assert mock_consume.call_args.kwargs["quantity"] == Decimal("1")


@patch("apps.users.wallet.services.CreditsService.consume_credits")
def test_missing_user_id_skips_charge(mock_consume):
    session = _make_session(user_id="")
    session._final_duration_ms = 1000
    asyncio.run(session._settle_billing())
    mock_consume.assert_not_called()


@patch("apps.users.wallet.services.CreditsService.consume_credits")
def test_settle_is_idempotent(mock_consume):
    session = _make_session()
    session._final_duration_ms = 2000
    asyncio.run(session._settle_billing())
    asyncio.run(session._settle_billing())
    assert mock_consume.call_count == 1


@patch("apps.users.wallet.services.CreditsService.consume_credits")
def test_consumer_disconnect_settles_successfully_sent_audio_once(mock_consume):
    session = _make_session()
    session._audio_bytes_total = 64000  # 2 秒 PCM16 单声道
    _active_streams[session.stream_id] = session

    async def run() -> None:
        await cleanup_asr_streams_for_consumer(session.owner_channel)
        await session._cleanup()

    try:
        asyncio.run(run())
    finally:
        _active_streams.pop(session.stream_id, None)

    assert session.stream_id not in _active_streams
    assert mock_consume.call_count == 1
    assert mock_consume.call_args.kwargs["quantity"] == Decimal("2")


@patch("apps.users.wallet.services.CreditsService.consume_credits")
def test_normal_final_uses_provider_duration_and_cleanup_is_idempotent(mock_consume):
    session = _make_session()
    event = {
        "isFinal": True,
        "audioInfo": {"duration": 2750},
        "text": "final transcript",
    }

    async def run() -> None:
        with patch.object(session, "_parse_response", return_value=event):
            should_continue = await session._dispatch_binary(b"provider frame")
        assert should_continue is False
        await session._cleanup()
        await session._cleanup()

    asyncio.run(run())

    assert session._final_duration_ms == 2750
    assert mock_consume.call_count == 1
    assert mock_consume.call_args.kwargs["quantity"] == Decimal("2.75")


def test_billing_failure_does_not_interrupt_stream_cleanup():
    session = _make_session()
    session._settle_billing = AsyncMock(side_effect=RuntimeError("billing down"))

    asyncio.run(session._cleanup())

    assert session._closed is True
    session._settle_billing.assert_awaited_once()
