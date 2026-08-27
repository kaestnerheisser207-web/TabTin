from __future__ import annotations

from unittest.mock import MagicMock, PropertyMock, patch

import pytest
from django.test import SimpleTestCase, override_settings

from apps.services.speech.asr.factory import (
    ASRConfigError,
    ASRCredentialError,
    ASRServiceFactory,
    _resolve_config,
    _try_load_from_db,
    get_asr_service,
)
from apps.services.speech.config_types import ASRProviderConfig
from apps.services.speech._config_cache import invalidate


class TestASRServiceFactory(SimpleTestCase):
    def test_unsupported_provider_raises(self):
        with self.assertRaises(ASRConfigError, msg="不支持的 ASR 提供商"):
            ASRServiceFactory.create_service("unknown", "flash", ASRProviderConfig())

    def test_unsupported_mode_raises(self):
        with self.assertRaises(ASRConfigError, msg="不支持模式"):
            ASRServiceFactory.create_service("bytedance", "nonexistent", ASRProviderConfig())

    def test_missing_app_id_raises(self):
        with self.assertRaises(ASRConfigError, msg="凭证未配置"):
            ASRServiceFactory.create_service("bytedance", "flash", ASRProviderConfig(
                app_id="",
                access_token="token",
            ))

    def test_missing_access_token_raises(self):
        with self.assertRaises(ASRConfigError, msg="凭证未配置"):
            ASRServiceFactory.create_service("bytedance", "flash", ASRProviderConfig(
                app_id="id",
                access_token="",
            ))

    def test_valid_config_creates_flash_service(self):
        svc = ASRServiceFactory.create_service("bytedance", "flash", ASRProviderConfig(
            app_id="test_id",
            access_token="test_token",
        ))
        self.assertEqual(svc.app_id, "test_id")
        self.assertEqual(svc.access_token, "test_token")

    def test_supported_providers(self):
        providers = ASRServiceFactory.get_supported_providers()
        self.assertIn("bytedance", providers)
        modes = providers["bytedance"]
        self.assertIn("flash", modes)
        self.assertIn("standard", modes)
        self.assertIn("streaming", modes)

    def test_byteplus_requires_only_api_key(self):
        svc = ASRServiceFactory.create_service(
            "byteplus",
            "streaming",
            ASRProviderConfig(access_token="test-api-key"),
        )
        self.assertEqual(svc.provider_name, "byteplus")
        self.assertEqual(svc.access_token, "test-api-key")

    def test_byteplus_supported_modes_exclude_flash(self):
        providers = ASRServiceFactory.get_supported_providers()
        self.assertEqual(providers["byteplus"], ["standard", "streaming"])

    def test_byteplus_missing_api_key_raises(self):
        with self.assertRaises(ASRConfigError):
            ASRServiceFactory.create_service(
                "byteplus", "streaming", ASRProviderConfig(),
            )


class TestResolveConfig(SimpleTestCase):
    """v0.1.x：删除 settings fallback 后，未配置 DB 应直接抛错。"""

    def setUp(self):
        invalidate()

    def tearDown(self):
        invalidate()

    @patch("apps.services.speech.asr.factory._try_load_from_db")
    def test_db_config_preferred(self, mock_db):
        mock_db.return_value = ASRProviderConfig(
            app_id="db_id",
            access_token="db_token",
            provider_name="bytedance",
        )
        config = _resolve_config("bytedance", "flash")
        self.assertEqual(config.app_id, "db_id")
        mock_db.assert_called_once()

    @patch("apps.services.speech.asr.factory._try_load_from_db")
    def test_db_miss_raises_no_settings_fallback(self, mock_db):
        mock_db.return_value = None
        with self.assertRaises(ASRConfigError) as ctx:
            _resolve_config("bytedance", "flash")
        self.assertIn("未在 DB 配置", str(ctx.exception))

    @patch("apps.services.speech.asr.factory._discover_provider")
    @patch("apps.services.llm.models.LLMModel.objects.filter")
    def test_credential_decryption_failure_remains_actionable(
        self,
        filter_models,
        discover_provider,
    ):
        from apps.services.llm.models import LLMCredentialDecryptionError

        provider = MagicMock()
        type(provider).api_key = PropertyMock(
            side_effect=LLMCredentialDecryptionError("cannot decrypt")
        )
        discover_provider.return_value = provider
        filter_models.return_value.first.return_value = MagicMock(
            capabilities_config={
                "resource_ids": {"streaming": "volc.seedasr.sauc.duration"},
                "ws_endpoint": "bigmodel_async",
            }
        )

        with self.assertRaises(ASRCredentialError) as ctx:
            _try_load_from_db("byteplus", "streaming")

        self.assertIn("重新保存 API Key", str(ctx.exception))


class TestGetASRService(SimpleTestCase):
    def setUp(self):
        invalidate()

    def tearDown(self):
        invalidate()

    def test_direct_config(self):
        svc = get_asr_service(
            provider="bytedance",
            mode="flash",
            config=ASRProviderConfig(app_id="direct", access_token="direct_t"),
        )
        self.assertEqual(svc.app_id, "direct")

    def test_config_overrides(self):
        svc = get_asr_service(
            provider="bytedance",
            mode="flash",
            config=ASRProviderConfig(app_id="id", access_token="t"),
            config_overrides={"app_id": "overridden"},
        )
        self.assertEqual(svc.app_id, "overridden")
