---
scene_key: meeting_post_analysis
display_name: 会议会后分析
description: 基于完整 final 逐字稿生成可核对的结构化会议档案派生内容
capability_domain: chat

capability_requirements:
  requires_json_mode: true
  requires_vision: false
  requires_function_calling: false
  min_context_tokens: 32000
  max_output_tokens: 5000
  latency_class: batch
  cost_class: standard

default_params:
  temperature: 0.1
  max_tokens: 4096
  response_format:
    type: json_object
  timeout_sec: 120
  max_input_chars: 120000

template_variables:
  - name: meeting_title
    type: str
    required: true
  - name: meeting_brief
    type: str
    required: true
  - name: transcript
    type: str
    required: true
    max_length: 120000
---

## 触发场景

会议停止后，用户明确触发的 Celery 后台分析。
