"""BytePlus Global ASR 音频文件识别实现。"""

from __future__ import annotations

from dataclasses import replace
from typing import Optional

from ....config_types import ASRProviderConfig
from ..bytedance.base import build_api_key_auth_headers
from ..bytedance.standard import ByteDanceStandardASR
from .base import QUERY_URL, RESOURCE_ID_STANDARD, SUBMIT_URL


class BytePlusStandardASR(ByteDanceStandardASR):
    """复用 Seed ASR 请求与响应协议，只替换 Global 端点和鉴权。"""

    def __init__(self, config: ASRProviderConfig):
        super().__init__(replace(config, app_id=config.app_id or "tabtin"))
        if not config.submit_url:
            self.submit_url = SUBMIT_URL
        if not config.query_url:
            self.query_url = QUERY_URL
        if not config.resource_id:
            self.resource_id = RESOURCE_ID_STANDARD

    def build_auth_headers(
        self,
        *,
        request_id: str,
        sequence: Optional[str] = None,
    ) -> dict[str, str]:
        return build_api_key_auth_headers(
            api_key=self.access_token,
            resource_id=self.resource_id,
            request_id=request_id,
            sequence=sequence,
        )

    @property
    def result_provider(self) -> str:
        return "byteplus"
