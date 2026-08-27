"""
ASR streaming handler — asr.stream.start / asr.stream.audio / asr.stream.stop

前端通过 Gateway WebSocket 发送音频数据，后端作为代理连接到
已配置的 Seed Speech WebSocket ASR，将识别结果实时推回前端。

协议流程：
  1. 前端发 asr.stream.start → 后端建立到 ASR Provider 的 WS 连接
     → 返回 asr.stream.started (含 stream_id)
  2. 前端发 asr.stream.audio (payload.data = base64 音频块)
     → 后端转发给 ByteDance
     → Provider 返回识别结果
     → 后端推 asr.stream.event 给前端
  3. 前端发 asr.stream.stop → 后端发最后一包并关闭
     → 最终结果 asr.stream.done
"""

from __future__ import annotations

import asyncio
import base64
from collections import deque
from decimal import Decimal
import logging
import time
import uuid
from typing import Any, Dict, Optional

import aiohttp
from asgiref.sync import sync_to_async

from apps.services.speech.exceptions import SpeechUpstreamError as _SpeechUpstreamError

from apps.services.speech.asr.providers.bytedance.base import (
    build_audio_packet,
    new_request_id,
    parse_stream_event,
    parse_ws_binary_frame,
)

from ._base_stream import _BaseStreamSession, cleanup_streams_for_consumer
from ..protocol import (
    ERROR_CONNECTION_LIMIT,
    ERROR_PERMISSION_DENIED,
    ERROR_RATE_LIMITED,
    ERROR_SCHEMA_INVALID,
    ERROR_INTERNAL,
    build_envelope,
)

logger = logging.getLogger(__name__)

_active_streams: dict[str, "_ASRStreamSession"] = {}
_MAX_CONCURRENT_STREAMS = 200
_MAX_AUDIO_CHUNK_BYTES = 1 * 1024 * 1024  # 1 MB per chunk
_AUDIO_RATE_WINDOW_SECONDS = 10.0
_MAX_AUDIO_MESSAGES_PER_WINDOW = 200
_MAX_AUDIO_BYTES_PER_WINDOW = 1_280_000
_UPSTREAM_IDLE_TIMEOUT_CODE = 45000081

_USER_FACING_ERRORS = {
    "config": "语音识别服务未配置，请联系管理员",
    "connect": "语音识别服务暂时不可用，请稍后重试",
    "internal": "语音识别内部错误，请稍后重试",
}


async def cleanup_asr_streams_for_consumer(channel_name: str) -> None:
    """Clean up all ASR stream sessions owned by a disconnecting consumer."""
    await cleanup_streams_for_consumer(_active_streams, channel_name, "ASR WS")


def create_asr_config_check_handler(consumer):
    """Return ASR configuration readiness without opening an upstream stream."""

    async def handle_asr_config_check(envelope: Dict[str, Any]) -> None:
        request_id = envelope["request_id"]
        payload = envelope.get("payload", {})
        provider = str(payload.get("provider") or "byteplus").strip().lower()

        from apps.services.speech.asr.factory import (
            ASRConfigError,
            ASRCredentialError,
            get_asr_service,
        )

        try:
            service = await sync_to_async(get_asr_service)(
                provider=provider,
                mode="streaming",
            )
        except ASRCredentialError as exc:
            logger.warning(
                "[ASR Config] credential unavailable provider=%s reason=%s",
                provider,
                exc,
            )
            response = build_envelope(
                "asr.config.status",
                request_id,
                {
                    "ready": False,
                    "provider": provider,
                    "reason": "credential_error",
                    "message": str(exc),
                },
            )
        except ASRConfigError as exc:
            logger.info("[ASR Config] not ready provider=%s reason=%s", provider, exc)
            response = build_envelope(
                "asr.config.status",
                request_id,
                {
                    "ready": False,
                    "provider": provider,
                    "reason": "not_configured",
                    "message": _USER_FACING_ERRORS["config"],
                },
            )
        except Exception as exc:
            logger.exception("[ASR Config] readiness check failed: %s", exc)
            response = build_envelope(
                "asr.config.status",
                request_id,
                {
                    "ready": False,
                    "provider": provider,
                    "reason": "internal_error",
                    "message": _USER_FACING_ERRORS["internal"],
                },
            )
        else:
            response = build_envelope(
                "asr.config.status",
                request_id,
                {
                    "ready": True,
                    "provider": provider,
                    "resource_id": service.resource_id,
                    "ws_endpoint": service.ws_endpoint,
                },
            )
        await consumer._send_envelope(response)

    return handle_asr_config_check


def create_asr_stream_handler(consumer):
    """Factory: returns handlers for asr.stream.start / audio / stop."""

    async def handle_asr_stream_start(envelope: Dict[str, Any]) -> None:
        request_id = envelope["request_id"]
        payload = envelope.get("payload", {})

        if len(_active_streams) >= _MAX_CONCURRENT_STREAMS:
            await consumer._send_error(
                request_id, ERROR_CONNECTION_LIMIT,
                f"ASR 并发上限 ({_MAX_CONCURRENT_STREAMS}) 已达到，请稍后重试",
            )
            return

        stream_id = f"asr_{uuid.uuid4().hex[:12]}"

        from apps.services.speech.asr.factory import (
            get_asr_service, ASRConfigError, VALID_WS_ENDPOINTS,
        )

        provider = payload.get("provider", "bytedance")
        ws_endpoint = payload.get("ws_endpoint", "bigmodel_async")
        if ws_endpoint not in VALID_WS_ENDPOINTS:
            await consumer._send_error(
                request_id, ERROR_SCHEMA_INVALID,
                f"无效的 ws_endpoint: {ws_endpoint}，可选: {sorted(VALID_WS_ENDPOINTS)}",
            )
            return

        _ALLOWED_EXTRA_PARAMS = frozenset({
            "enable_itn", "enable_punc", "enable_ddc",
            "show_utterances", "enable_nonstream", "result_type",
            "enable_accelerate_text", "accelerate_score",
            "vad_segment_duration", "end_window_size", "force_to_speech_time",
            "sensitive_words_filter",
            "show_speech_rate", "show_volume",
            "enable_lid", "enable_emotion_detection", "enable_gender_detection",
            "enable_poi_fc", "enable_music_fc",
            "context", "boosting_table_name", "boosting_table_id",
            "correct_table_name", "correct_table_id",
        })

        extra_params = {
            k: v for k, v in payload.items() if k in _ALLOWED_EXTRA_PARAMS
        }

        if extra_params.get("enable_nonstream") and ws_endpoint != "bigmodel_async":
            await consumer._send_error(
                request_id, ERROR_SCHEMA_INVALID,
                "enable_nonstream 仅支持 bigmodel_async 端点",
            )
            return

        try:
            svc = await sync_to_async(get_asr_service)(
                provider=provider,
                mode="streaming",
                config=None,
                config_overrides={"ws_endpoint": ws_endpoint},
            )
        except ASRConfigError as exc:
            logger.warning("[ASR WS] 配置错误: %s", exc)
            await consumer._send_error(
                request_id, ERROR_INTERNAL, _USER_FACING_ERRORS["config"],
            )
            return
        except Exception as exc:
            logger.exception("[ASR WS] 获取 ASR 服务失败: %s", exc)
            await consumer._send_error(
                request_id, ERROR_INTERNAL, _USER_FACING_ERRORS["internal"],
            )
            return

        session = _ASRStreamSession(
            stream_id=stream_id,
            consumer=consumer,
            svc=svc,
            language=payload.get("language", ""),
            audio_format=payload.get("audio_format", "pcm"),
            sample_rate=payload.get("sample_rate", 16000),
            ws_endpoint=ws_endpoint,
            extra_params=extra_params,
            billing_user_id=str(getattr(consumer, "user_id", "") or ""),
            billing_organization_id=getattr(
                consumer, "organization_id", None
            ),
            provider=provider,
        )

        _active_streams[stream_id] = session

        try:
            await session.connect()
        except (
            aiohttp.WSServerHandshakeError,
            aiohttp.ClientError,
            asyncio.TimeoutError,
            _SpeechUpstreamError,
        ) as exc:
            logger.error("[ASR WS] connect 失败: %s stream_id=%s", exc, stream_id)
            _active_streams.pop(stream_id, None)
            await session._cleanup()
            await consumer._send_error(
                request_id, ERROR_INTERNAL, _USER_FACING_ERRORS["connect"],
            )
            return
        except Exception as exc:
            logger.exception("[ASR WS] connect 未知错误: %s stream_id=%s", exc, stream_id)
            _active_streams.pop(stream_id, None)
            await session._cleanup()
            await consumer._send_error(
                request_id, ERROR_INTERNAL, _USER_FACING_ERRORS["internal"],
            )
            return

        response = build_envelope(
            "asr.stream.started",
            request_id,
            {"stream_id": stream_id},
        )
        await consumer._send_envelope(response)

        consumer._track_task(asyncio.create_task(
            session.receive_loop()
        ))

    async def handle_asr_stream_audio(envelope: Dict[str, Any]) -> None:
        request_id = envelope["request_id"]
        payload = envelope.get("payload", {})
        stream_id = payload.get("stream_id", "")

        session = _active_streams.get(stream_id)
        if not session:
            await consumer._send_error(request_id, ERROR_SCHEMA_INVALID, "invalid stream_id")
            return
        if session.owner_channel != getattr(consumer, "channel_name", ""):
            await consumer._send_error(request_id, ERROR_PERMISSION_DENIED, "stream owned by another connection")
            return

        audio_b64 = payload.get("data", "")
        if not audio_b64:
            return

        try:
            audio_bytes = base64.b64decode(audio_b64)
        except Exception:
            await consumer._send_error(request_id, ERROR_SCHEMA_INVALID, "invalid base64 audio data")
            return

        if len(audio_bytes) > _MAX_AUDIO_CHUNK_BYTES:
            await consumer._send_error(
                request_id, ERROR_SCHEMA_INVALID,
                f"音频块大小超限（最大 {_MAX_AUDIO_CHUNK_BYTES // 1024} KB）",
            )
            return

        if not session.accept_audio_chunk(len(audio_bytes)):
            await consumer._send_error(
                request_id,
                ERROR_RATE_LIMITED,
                "too many ASR audio chunks, slow down",
            )
            return

        is_last = payload.get("is_last", False)
        await session.send_audio(audio_bytes, is_last=is_last)

    async def handle_asr_stream_stop(envelope: Dict[str, Any]) -> None:
        request_id = envelope["request_id"]
        payload = envelope.get("payload", {})
        stream_id = payload.get("stream_id", "")

        session = _active_streams.get(stream_id)
        if not session:
            await consumer._send_error(request_id, ERROR_SCHEMA_INVALID, "invalid stream_id")
            return
        if session.owner_channel != getattr(consumer, "channel_name", ""):
            await consumer._send_error(request_id, ERROR_PERMISSION_DENIED, "stream owned by another connection")
            return

        _active_streams.pop(stream_id, None)
        await session.close()

    return handle_asr_stream_start, handle_asr_stream_audio, handle_asr_stream_stop


class _ASRStreamSession(_BaseStreamSession):
    """管理一次 ASR 流式会话：维护到 Seed Speech Provider 的 WS 连接和状态。"""

    _log_prefix = "ASR WS"
    _stream_error_event = "asr.stream.error"

    def __init__(
        self,
        stream_id: str,
        consumer: Any,
        svc: Any,
        language: str,
        audio_format: str,
        sample_rate: int,
        ws_endpoint: str,
        extra_params: dict,
        billing_user_id: str = "",
        billing_organization_id: Optional[str] = None,
        provider: str = "bytedance",
    ):
        super().__init__(stream_id, consumer, svc)
        self.language = language
        self.audio_format = audio_format
        self.sample_rate = sample_rate
        self.ws_endpoint = ws_endpoint
        self.extra_params = extra_params
        self.billing_user_id = billing_user_id
        self.billing_organization_id = billing_organization_id
        self.provider = provider
        self.seq = 1
        self.log_id: str = ""
        self._audio_rate_window: deque[tuple[float, int]] = deque()
        self._audio_rate_window_bytes = 0
        self._audio_bytes_total = 0
        self._started_monotonic = time.monotonic()
        self._final_duration_ms = 0
        self._billing_settled = False

    def accept_audio_chunk(self, byte_count: int) -> bool:
        now = time.monotonic()
        cutoff = now - _AUDIO_RATE_WINDOW_SECONDS
        while (
            self._audio_rate_window
            and self._audio_rate_window[0][0] <= cutoff
        ):
            _, expired_bytes = self._audio_rate_window.popleft()
            self._audio_rate_window_bytes -= expired_bytes

        if (
            len(self._audio_rate_window) >= _MAX_AUDIO_MESSAGES_PER_WINDOW
            or self._audio_rate_window_bytes + byte_count
            > _MAX_AUDIO_BYTES_PER_WINDOW
        ):
            return False

        self._audio_rate_window.append((now, byte_count))
        self._audio_rate_window_bytes += byte_count
        return True

    async def connect(self) -> None:
        connect_id = new_request_id()
        headers = self.svc.build_auth_headers(connect_id=connect_id)

        ws_timeout = getattr(self.svc, "timeout_seconds", 300)
        self._http_session = aiohttp.ClientSession(
            timeout=aiohttp.ClientTimeout(total=ws_timeout, connect=10),
        )
        self._ws = await self._http_session.ws_connect(self.svc.ws_url, headers=headers)

        ws_resp = getattr(self._ws, "response", None) or getattr(self._ws, "_response", None)
        if ws_resp:
            self.log_id = ws_resp.headers.get("X-Tt-Logid", "")
        if self.log_id:
            logger.info(
                "[ASR WS] connected logid=%s connect_id=%s stream_id=%s",
                self.log_id, connect_id, self.stream_id,
            )

        packet = self.svc.build_full_client_request(
            audio_format=self.audio_format,
            sample_rate=self.sample_rate,
            language=self.language,
            seq=self.seq,
            **self.extra_params,
        )
        self.seq += 1

        await self._ws.send_bytes(packet)

        init_msg = await self._ws.receive()
        if init_msg.type == aiohttp.WSMsgType.BINARY:
            parsed = parse_ws_binary_frame(init_msg.data)
            if parsed and "error" in parsed:
                raise _SpeechUpstreamError(
                    f"ASR 上游初始化错误: code={parsed.get('error_code')}"
                )
            logger.debug("[ASR WS] init response received, stream_id=%s", self.stream_id)
        else:
            raise _SpeechUpstreamError(
                f"ASR WS 握手阶段收到意外消息类型: {init_msg.type}"
            )

    async def send_audio(self, audio_bytes: bytes, is_last: bool = False) -> None:
        if self._closed or not self._ws:
            return

        packet = build_audio_packet(seq=self.seq, segment=audio_bytes, is_last=is_last)
        if not is_last:
            self.seq += 1

        try:
            await self._ws.send_bytes(packet)
        except Exception as exc:
            logger.warning("[ASR WS] send_audio failed: %s", exc)
        else:
            self._audio_bytes_total += len(audio_bytes)

    async def _dispatch_binary(self, data: bytes) -> bool:
        """处理一个 ASR BINARY WS 帧。返回 True 继续接收，False 终止循环。"""
        event = self._parse_response(data)
        if not event:
            return True

        if event.get("error"):
            log = logger.debug if event.get("error_code") == _UPSTREAM_IDLE_TIMEOUT_CODE else logger.warning
            log(
                "[ASR WS] 上游错误: code=%s msg=%s stream_id=%s logid=%s",
                event.get("error_code"), event.get("error"),
                self.stream_id, self.log_id,
            )
            await self._send_event("asr.stream.error", {
                "stream_id": self.stream_id,
                "error": _USER_FACING_ERRORS["connect"],
                "isFinal": True,
            })
            return False

        is_final = event.get("isFinal", False)
        if is_final:
            audio_info = event.get("audioInfo") or {}
            final_duration_ms = audio_info.get("duration", 0)
            if final_duration_ms:
                self._final_duration_ms = int(final_duration_ms)
        msg_type = "asr.stream.done" if is_final else "asr.stream.event"
        await self._send_event(msg_type, {
            "stream_id": self.stream_id,
            **event,
        })

        return not is_final

    async def _on_receive_error(self) -> None:
        await self._send_event("asr.stream.error", {
            "stream_id": self.stream_id,
            "error": _USER_FACING_ERRORS["internal"],
            "isFinal": True,
        })

    def _deregister(self) -> None:
        _active_streams.pop(self.stream_id, None)

    async def close(self) -> None:
        """发送最后空包，等 receive_loop 自然退出后再清理。"""
        if self._closed or not self._ws:
            return

        try:
            packet = build_audio_packet(seq=self.seq, segment=b"", is_last=True)
            await self._ws.send_bytes(packet)
        except Exception:
            pass

        await self._wait_and_cleanup()

    def _estimate_duration_ms(self) -> int:
        """回退估算：PCM 只按成功发送的字节数换算，非 PCM 用墙钟时间。"""
        if self.audio_format == "pcm":
            if self.sample_rate <= 0:
                return 0
            bytes_per_second = self.sample_rate * 2  # PCM16 单声道
            return int(self._audio_bytes_total / bytes_per_second * 1000)
        return max(int((time.monotonic() - self._started_monotonic) * 1000), 0)

    async def _settle_billing(self) -> None:
        """流结束时按 speech.asr.seconds 记一次费（幂等，失败不中断主流程）。

        与 HTTP flash/standard 路径共用 _charge_speech_usage 入口；
        idempotency_key 绑定 stream_id，重复结算不会重复扣费。
        时长优先用 provider 最终事件上报的 audioInfo.duration，
        缺失时回退到累计音频字节 / 墙钟估算。
        """
        if self._billing_settled:
            return
        self._billing_settled = True
        if not self.billing_user_id:
            return
        duration_ms = self._final_duration_ms or self._estimate_duration_ms()
        if duration_ms <= 0:
            return

        from apps.services.speech.api import _charge_speech_usage

        await sync_to_async(_charge_speech_usage)(
            user_id=self.billing_user_id,
            organization_id=self.billing_organization_id,
            meter_key="speech.asr.seconds",
            quantity=Decimal(str(max(duration_ms / 1000, 1))),
            unit="seconds",
            provider=self.provider,
            biz_type="asr_stream",
            biz_id=self.stream_id,
            idempotency_key=f"speech:asr_stream:{self.stream_id}",
        )

    async def _cleanup(self) -> None:
        """释放资源后结算费用——正常/异常/断连等所有终结路径都经过 _cleanup。"""
        await super()._cleanup()
        try:
            await self._settle_billing()
        except Exception as exc:
            logger.warning(
                "[ASR WS] billing settlement failed without affecting stream cleanup: %s",
                exc,
            )

    @staticmethod
    def _parse_response(data: bytes) -> Optional[dict]:
        """解析字节跳动 WS 二进制响应，输出归一化 camelCase 格式（与 HTTP API 一致）"""
        parsed = parse_ws_binary_frame(data)
        if parsed is None:
            return None

        if "error" in parsed:
            return parsed

        json_data = parsed.get("json_data")
        is_final = parsed.get("is_final", False)
        sequence = parsed.get("sequence", 0)

        event = parse_stream_event(
            json_data or {},
            is_final=is_final,
            sequence=sequence,
        )
        return event.to_dict()
