"""BytePlus Global Seed Speech ASR 端点与资源常量。"""

BYTEPLUS_API_BASE_URL = "https://voice.ap-southeast-1.bytepluses.com"

SUBMIT_URL = f"{BYTEPLUS_API_BASE_URL}/api/v3/auc/bigmodel/submit"
QUERY_URL = f"{BYTEPLUS_API_BASE_URL}/api/v3/auc/bigmodel/query"
WS_BIGMODEL_ASYNC = (
    "wss://voice.ap-southeast-1.bytepluses.com/api/v3/sauc/bigmodel_async"
)

RESOURCE_ID_STANDARD = "volc.seedasr.auc"
RESOURCE_ID_STREAMING = "volc.seedasr.sauc.duration"
