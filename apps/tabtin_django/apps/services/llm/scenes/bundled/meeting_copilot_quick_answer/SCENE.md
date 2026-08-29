---
scene_key: meeting_copilot_quick_answer
display_name: 会议 Copilot 快速回答
description: 识别会议中的完整问题并直接生成专业答案
capability_domain: chat

capability_requirements:
  requires_json_mode: true
  requires_vision: false
  requires_function_calling: false
  min_context_tokens: 8000
  max_output_tokens: 1200
  latency_class: interactive
  cost_class: cheap

default_params:
  temperature: 0.1
  max_tokens: 320
  response_format:
    type: json_object
  timeout_sec: 12
  thinking:
    type: disabled

template_variables:
  - name: candidate_json
    type: str
    required: true
  - name: transcript_context_before_candidate
    type: str
    required: true
  - name: evidence_catalog_json
    type: str
    required: true
  - name: stability_signals_json
    type: str
    required: true
---
