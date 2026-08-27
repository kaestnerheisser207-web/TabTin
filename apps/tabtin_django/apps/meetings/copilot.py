"""Meeting Copilot quick-answer service.

This module consumes transcript snapshots and authorized Project previews only.
It never mutates recording, track, or transcription lifecycle state.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from typing import Any, Callable

from django.db.models import Q

from apps.services.llm.models import LLMModel
from apps.tabtinspace.models import ContextItem
from apps.tabtinspace.services.context_item_service import ContextItemService

from .models import MeetingSession

logger = logging.getLogger(__name__)

MAX_RECENT_SEGMENTS = 12
MAX_TRANSCRIPT_CHARS = 4_000
MAX_PROJECT_SOURCES = 3
MAX_SOURCE_EXCERPT_CHARS = 400
MAX_MODEL_ATTEMPTS = 2


class MeetingCopilotError(RuntimeError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


@dataclass(frozen=True)
class MeetingCopilotSource:
    id: str
    kind: str
    title: str
    excerpt: str
    resource_type: str = ""
    resource_id: str = ""

    def as_dict(self) -> dict[str, str]:
        return {
            "id": self.id,
            "kind": self.kind,
            "title": self.title,
            "excerpt": self.excerpt,
            "resource_type": self.resource_type,
            "resource_id": self.resource_id,
        }


def _clean_text(value: Any, *, limit: int) -> str:
    return " ".join(str(value or "").split())[:limit]


def _normalize_segments(raw_segments: list[dict[str, Any]]) -> list[dict[str, Any]]:
    normalized: list[dict[str, Any]] = []
    for index, raw in enumerate(raw_segments[-MAX_RECENT_SEGMENTS:]):
        if not isinstance(raw, dict) or raw.get("is_final") is False:
            continue
        source = str(raw.get("source") or "").strip().lower()
        if source not in {"local", "remote"}:
            continue
        text = _clean_text(raw.get("text") or raw.get("raw_text"), limit=1_500)
        if not text:
            continue
        try:
            start_ms = max(0, int(raw.get("start_ms") or 0))
        except (TypeError, ValueError):
            start_ms = 0
        external_id = _clean_text(raw.get("external_id"), limit=128) or f"segment-{index}"
        normalized.append({
            "external_id": external_id,
            "source": source,
            "start_ms": start_ms,
            "text": text,
        })
    return normalized


def _selected_turn(
    segments: list[dict[str, Any]],
    question_segment_id: str,
) -> dict[str, Any] | None:
    return next(
        (
            segment
            for segment in reversed(segments)
            if segment["external_id"] == question_segment_id
        ),
        None,
    )


def _transcript_context(segments: list[dict[str, Any]]) -> str:
    lines: list[str] = []
    total = 0
    for segment in reversed(segments):
        speaker = "对方" if segment["source"] == "remote" else "我"
        source_id = f"transcript:{segment['external_id']}"
        line = f"[{source_id}] {speaker}: {segment['text']}"
        if lines and total + len(line) > MAX_TRANSCRIPT_CHARS:
            break
        lines.append(line)
        total += len(line)
    return "\n".join(reversed(lines))


def _project_sources(session: MeetingSession, user: Any) -> list[MeetingCopilotSource]:
    if not session.project_id:
        return []
    permission_service = ContextItemService(user=user)
    candidates = list(
        ContextItem.objects.filter(
            project_id=session.project_id,
            is_archived=False,
            trashed_at__isnull=True,
        )
        .exclude(status="trashed")
        .order_by("-is_pinned", "-pinned_at", "-updated_at")[:50]
    )
    sources: list[MeetingCopilotSource] = []
    for item in candidates:
        if not permission_service._check_item_permission(item, "viewer"):
            continue
        excerpt = _clean_text(item.preview, limit=MAX_SOURCE_EXCERPT_CHARS)
        if not excerpt:
            continue
        sources.append(MeetingCopilotSource(
            id=f"project:{item.id}",
            kind="project_resource",
            title=_clean_text(item.title, limit=255) or "未命名资料",
            excerpt=excerpt,
            resource_type=item.item_type,
            resource_id=item.resource_id,
        ))
        if len(sources) >= MAX_PROJECT_SOURCES:
            break
    return sources


def _select_chat_model(
    session: MeetingSession,
    user: Any,
    selected_model_id: str | None = None,
) -> LLMModel:
    organization = session.organization
    settings = organization.settings or {}
    preferred_id = str(settings.get("llm_default_model_id") or "").strip()
    access_filter = (
        Q(provider__scope="global")
        | Q(
            provider__scope="organization",
            provider__organization_id=str(organization.id),
        )
        | Q(
            provider__scope="user",
            provider__organization_id=str(organization.id),
            provider__user_id=str(user.id),
        )
    )
    queryset = (
        LLMModel.objects.select_related("provider")
        .filter(
            access_filter,
            capability_domain="chat",
            wave_status="ready",
            provider__routing_enabled=True,
            provider__capability_domains__contains=["chat"],
        )
        .order_by("-provider__priority", "created_at")
    )
    if selected_model_id:
        selected = queryset.filter(id=selected_model_id).first()
        if selected is None:
            raise MeetingCopilotError(
                "model_unavailable",
                "所选会议 Copilot 模型不可用或不属于当前组织",
            )
        return selected
    if preferred_id:
        preferred = queryset.filter(id=preferred_id).first()
        if preferred is not None:
            return preferred
    model = queryset.first()
    if model is None:
        raise MeetingCopilotError(
            "model_not_configured",
            "当前组织没有可供会议 Copilot 使用的对话模型",
        )
    return model


def _extract_json_object(content: str) -> dict[str, Any]:
    text = str(content or "").strip()
    start = text.find("{")
    end = text.rfind("}")
    if start < 0 or end <= start:
        raise MeetingCopilotError("invalid_model_response", "回答模型没有返回有效 JSON")
    try:
        value = json.loads(text[start : end + 1])
    except json.JSONDecodeError as exc:
        raise MeetingCopilotError("invalid_model_response", "回答模型返回的 JSON 无法解析") from exc
    if not isinstance(value, dict):
        raise MeetingCopilotError("invalid_model_response", "回答模型返回格式不正确")
    return value


def _parse_answer(content: str, source_map: dict[str, MeetingCopilotSource]) -> dict[str, Any]:
    value = _extract_json_object(content)
    should_answer = value.get("should_answer") is True
    if not should_answer:
        return {
            "should_answer": False,
            "answer": "",
            "key_points": [],
            "sources": [],
            "reliability": "low",
            "warning": "",
        }
    answer = _clean_text(value.get("answer"), limit=1_200)
    if not answer:
        raise MeetingCopilotError("invalid_model_response", "回答模型没有给出建议答案")
    key_points = [
        _clean_text(point, limit=300)
        for point in (value.get("key_points") or [])
        if _clean_text(point, limit=300)
    ][:4]
    source_ids = [
        str(source_id)
        for source_id in (value.get("source_ids") or [])
        if str(source_id) in source_map
    ]
    source_ids = list(dict.fromkeys(source_ids))
    reliability = str(value.get("reliability") or "low").strip().lower()
    if reliability not in {"high", "medium", "low"}:
        reliability = "low"
    warning = _clean_text(value.get("warning"), limit=500)
    return {
        "should_answer": True,
        "answer": answer,
        "key_points": key_points,
        "sources": [source_map[source_id].as_dict() for source_id in source_ids],
        "reliability": reliability,
        "warning": warning,
    }


def generate_meeting_copilot_answer(
    *,
    session: MeetingSession,
    user: Any,
    recent_segments: list[dict[str, Any]],
    question_segment_id: str,
    selected_model_id: str | None = None,
    llm_call: Callable[..., Any] | None = None,
) -> dict[str, Any]:
    segments = _normalize_segments(recent_segments)
    candidate = _selected_turn(segments, question_segment_id)
    if candidate is None:
        return {
            "status": "no_question",
            "message": "还没有识别到完整问题",
        }

    question_source = MeetingCopilotSource(
        id=f"transcript:{candidate['external_id']}",
        kind="transcript",
        title="当前发言",
        excerpt=candidate["text"],
    )
    sources = [question_source]
    brief = _clean_text(session.brief, limit=2_000)
    if brief:
        sources.append(MeetingCopilotSource(
            id="meeting:brief",
            kind="meeting_brief",
            title="会前 Brief",
            excerpt=brief,
        ))
    sources.extend(_project_sources(session, user))
    source_map = {source.id: source for source in sources}

    if llm_call is None:
        from apps.services.llm.services.chat import unified_llm_call

        llm_call = unified_llm_call
    model = _select_chat_model(session, user, selected_model_id)
    project_context = "\n".join(
        f"[{source.id}] {source.title}: {source.excerpt}"
        for source in sources
        if source.kind == "project_resource"
    ) or "（当前没有已准备且有权访问的 Project 资料）"
    call_kwargs = {
        "scene_key": "meeting_copilot_quick_answer",
        "variables": {
            "candidate_utterance": candidate["text"],
            "transcript_context": _transcript_context(segments),
            "brief": brief or "（未提供）",
            "project_context": project_context,
            "allowed_source_ids": list(source_map),
        },
        "user_id": str(user.id),
        "organization_id": str(session.organization_id),
        "selected_model_id": str(model.id),
        "timeout_sec": 12,
        "result_validator": lambda content: _parse_answer(content, source_map),
    }
    result = None
    parsed = None
    for attempt in range(MAX_MODEL_ATTEMPTS):
        try:
            result = llm_call(**call_kwargs)
            parsed = _parse_answer(result.content, source_map)
            break
        except MeetingCopilotError as exc:
            if exc.code != "invalid_model_response" or attempt + 1 >= MAX_MODEL_ATTEMPTS:
                raise
            logger.info(
                "[MeetingCopilot] retrying invalid structured response "
                "session=%s attempt=%s",
                session.id,
                attempt + 1,
            )

    if result is None or parsed is None:
        raise MeetingCopilotError(
            "invalid_model_response",
            "回答模型没有返回有效 JSON",
        )
    if not parsed.pop("should_answer"):
        return {
            "status": "no_action",
            "message": "已同步当前会议上下文，暂时不需要建议回答",
            "candidate_segment_id": candidate["external_id"],
        }
    return {
        "status": "answered",
        "question": candidate["text"],
        "question_segment_id": candidate["external_id"],
        "model": result.telemetry.model_used,
        "provider": result.telemetry.provider_used,
        "latency_ms": result.telemetry.latency_ms,
        **parsed,
    }


__all__ = [
    "MeetingCopilotError",
    "MeetingCopilotSource",
    "generate_meeting_copilot_answer",
]
