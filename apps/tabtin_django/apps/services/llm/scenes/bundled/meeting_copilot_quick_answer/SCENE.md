---
scene_key: meeting_copilot_quick_answer
display_name: 会议 Copilot 快速回答
description: 基于最近会议逐字稿、会前 Brief 与已授权 Project 资料生成可说出口的建议答案
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
  temperature: 0.2
  max_tokens: 160
  response_format:
    type: json_object
  timeout_sec: 12
  thinking:
    type: disabled

template_variables:
  - name: candidate_utterance
    type: str
    required: true
  - name: transcript_context
    type: str
    required: true
  - name: brief
    type: str
    required: true
  - name: project_context
    type: str
    required: true
  - name: allowed_source_ids
    type: "list[str]"
    required: true
---
