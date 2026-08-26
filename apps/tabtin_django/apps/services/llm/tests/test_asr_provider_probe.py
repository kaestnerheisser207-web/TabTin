from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import patch

from django.test import SimpleTestCase

from apps.services.llm.services.runtime import probe_provider_health


class ASRProviderProbeDispatchTests(SimpleTestCase):
    @patch(
        "apps.services.llm.services.runtime._probe_asr_provider_health",
        return_value={"success": True, "probe": {"is_success": True}},
    )
    @patch(
        "apps.services.llm.services.runtime.provider_supports_llm_capability",
        return_value=False,
    )
    def test_asr_provider_uses_streaming_probe(self, _supports_llm, probe_asr):
        provider = SimpleNamespace(
            id="provider-1",
            name="byteplus",
            display_name="BytePlus ASR",
            capability_domains=["asr"],
        )

        result = probe_provider_health(provider, check_type="manual")

        self.assertTrue(result["success"])
        probe_asr.assert_called_once_with(
            provider,
            check_type="manual",
            extra_details=None,
        )

    @patch(
        "apps.services.llm.services.runtime.provider_supports_llm_capability",
        return_value=False,
    )
    def test_other_non_llm_provider_remains_explicitly_skipped(self, _supports_llm):
        provider = SimpleNamespace(
            id="provider-2",
            name="image-only",
            display_name="Image only",
            capability_domains=["image_gen"],
            runtime_status="unknown",
        )

        result = probe_provider_health(provider, check_type="manual")

        self.assertTrue(result["skipped"])
        self.assertEqual(result["probe"]["reason"], "non_llm_provider")
