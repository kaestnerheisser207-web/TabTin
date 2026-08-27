from apps.services.llm.interface import ProviderMetadata
from apps.services.llm.registry import ProviderRegistry


ProviderRegistry.register(ProviderMetadata(
    name="byteplus",
    display_name="BytePlus Seed Speech",
    service_class_path=(
        "apps.services.speech.asr.providers.byteplus.streaming.BytePlusStreamingASR"
    ),
    sdk_type="custom",
    default_base_url="https://voice.ap-southeast-1.bytepluses.com",
    icon_emoji="🎙️",
    color_class="text-brand-500",
    supports_openai_compat=False,
    capability_domains=frozenset({"asr"}),
))
