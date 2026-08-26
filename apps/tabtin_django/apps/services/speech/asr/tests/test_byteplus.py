from __future__ import annotations

import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import aiohttp

from django.test import SimpleTestCase

from apps.services.speech.asr.providers.byteplus.base import (
    QUERY_URL,
    RESOURCE_ID_STANDARD,
    RESOURCE_ID_STREAMING,
    SUBMIT_URL,
    WS_BIGMODEL_ASYNC,
)
from apps.services.speech.asr.providers.byteplus.standard import BytePlusStandardASR
from apps.services.speech.asr.providers.byteplus.streaming import BytePlusStreamingASR
from apps.services.speech.config_types import ASRProviderConfig


class BytePlusStreamingASRTest(SimpleTestCase):
    def test_uses_global_endpoint_and_api_key_auth_without_app_id(self):
        service = BytePlusStreamingASR(ASRProviderConfig(
            provider_name="byteplus",
            access_token="test-api-key",
        ))

        self.assertEqual(service.ws_url, WS_BIGMODEL_ASYNC)
        self.assertEqual(service.resource_id, RESOURCE_ID_STREAMING)
        self.assertEqual(service.app_id, "tabtin")
        self.assertEqual(service.build_auth_headers(connect_id="connect-1"), {
            "X-Api-Key": "test-api-key",
            "X-Api-Resource-Id": RESOURCE_ID_STREAMING,
            "X-Api-Request-Id": "connect-1",
        })

    def test_explicit_resource_and_ws_url_override_defaults(self):
        service = BytePlusStreamingASR(ASRProviderConfig(
            provider_name="byteplus",
            access_token="test-api-key",
            resource_id="custom-resource",
            ws_url="wss://voice.example.test/custom",
        ))

        self.assertEqual(service.ws_url, "wss://voice.example.test/custom")
        self.assertEqual(service.resource_id, "custom-resource")


class BytePlusStreamingProbeTest(unittest.IsolatedAsyncioTestCase):
    @patch(
        "apps.services.speech.asr.providers.bytedance.streaming.parse_ws_binary_frame",
        return_value={"json_data": {}, "is_final": False},
    )
    @patch("apps.services.speech.asr.providers.bytedance.streaming.aiohttp.ClientSession")
    async def test_probe_uses_byteplus_api_key_handshake(self, session_cls, _parse):
        ws = MagicMock()
        ws.send_bytes = AsyncMock()
        ws.receive = AsyncMock(return_value=SimpleNamespace(
            type=aiohttp.WSMsgType.BINARY,
            data=b"response-frame",
        ))
        ws.close = AsyncMock()
        ws.response = SimpleNamespace(headers={"X-Tt-Logid": "log-1"})
        session = MagicMock()
        session.ws_connect = AsyncMock(return_value=ws)
        session.close = AsyncMock()
        session_cls.return_value = session
        service = BytePlusStreamingASR(ASRProviderConfig(
            provider_name="byteplus",
            access_token="test-api-key",
        ))

        result = await service.probe_connection()

        self.assertEqual(result["log_id"], "log-1")
        headers = session.ws_connect.call_args.kwargs["headers"]
        self.assertEqual(headers["X-Api-Key"], "test-api-key")
        self.assertEqual(headers["X-Api-Resource-Id"], RESOURCE_ID_STREAMING)
        self.assertIn("X-Api-Request-Id", headers)
        ws.send_bytes.assert_awaited_once()
        ws.close.assert_awaited_once()
        session.close.assert_awaited_once()


class BytePlusStandardASRTest(SimpleTestCase):
    def test_uses_global_file_endpoints_and_api_key_auth(self):
        service = BytePlusStandardASR(ASRProviderConfig(
            provider_name="byteplus",
            access_token="test-api-key",
        ))

        self.assertEqual(service.submit_url, SUBMIT_URL)
        self.assertEqual(service.query_url, QUERY_URL)
        self.assertEqual(service.resource_id, RESOURCE_ID_STANDARD)
        self.assertEqual(
            service.build_auth_headers(request_id="request-1", sequence="-1"),
            {
                "X-Api-Key": "test-api-key",
                "X-Api-Resource-Id": RESOURCE_ID_STANDARD,
                "X-Api-Request-Id": "request-1",
                "X-Api-Sequence": "-1",
            },
        )

    @patch("apps.services.speech.asr.providers.bytedance.standard.requests.post")
    def test_submit_sends_byteplus_headers_without_legacy_credentials(self, mock_post):
        response = MagicMock()
        response.headers = {
            "X-Api-Status-Code": "20000000",
            "X-Tt-Logid": "log-1",
        }
        mock_post.return_value = response
        service = BytePlusStandardASR(ASRProviderConfig(
            provider_name="byteplus",
            access_token="test-api-key",
        ))

        status = service.submit(audio_url="https://example.test/audio.wav", audio_format="wav")

        self.assertEqual(status.status, "queued")
        _, kwargs = mock_post.call_args
        self.assertEqual(mock_post.call_args.args[0], SUBMIT_URL)
        self.assertEqual(kwargs["headers"]["X-Api-Key"], "test-api-key")
        self.assertNotIn("X-Api-App-Key", kwargs["headers"])
        self.assertNotIn("X-Api-Access-Key", kwargs["headers"])
        self.assertEqual(kwargs["json"]["user"]["uid"], "tabtin")
