"""BytePlus Global ASR 双向流式实现。"""

from __future__ import annotations

from dataclasses import replace

from ....config_types import ASRProviderConfig
from ..bytedance.base import build_api_key_auth_headers
from ..bytedance.streaming import ByteDanceStreamingASR
from .base import RESOURCE_ID_STREAMING, WS_BIGMODEL_ASYNC


class BytePlusStreamingASR(ByteDanceStreamingASR):
    """复用 Seed ASR 二进制协议，只替换 Global 端点与 API Key 鉴权。"""

    def __init__(self, config: ASRProviderConfig):
        super().__init__(replace(config, app_id=config.app_id or "tabtin"))
        if not config.ws_url:
            self.ws_url = WS_BIGMODEL_ASYNC
        if not config.resource_id:
            self.resource_id = RESOURCE_ID_STREAMING

    def build_auth_headers(self, *, connect_id: str) -> dict[str, str]:
        return build_api_key_auth_headers(
            api_key=self.access_token,
            resource_id=self.resource_id,
            request_id=connect_id,
        )
