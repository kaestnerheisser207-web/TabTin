"""Meeting Copilot quick-answer service.

This module consumes transcript snapshots and authorized Project previews only.
It never mutates recording, track, or transcription lifecycle state.
"""

from __future__ import annotations

import json
import logging
import re
import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any, Literal

from django.db.models import Q
from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator

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

ANSWER_REASON_CODES = {
    "explicit_question",
    "implicit_request",
    "follow_up_question",
    "explanation_request",
    "comparison_request",
    "troubleshooting_request",
    "decision_request",
}
NO_ACTION_REASON_CODES = {
    "greeting",
    "acknowledgement",
    "filler",
    "operational_check",
    "statement_without_request",
    "already_answered",
    "duplicate",
}
WAIT_REASON_CODES = {
    "incomplete_fragment",
    "continuation_expected",
    "active_partial",
}
CLARIFY_REASON_CODES = {
    "ambiguous_reference",
    "missing_required_context",
}
META_ANSWER_PREFIX = re.compile(
    r"^(?:可以[，,]?我来|我来(?:简单)?(?:讲讲|说明)|建议(?:你)?先|"
    r"建议(?:你)?(?:这样回答|这么回答)|你可以(?:这样)?(?:说|回答)|"
    r"可以回答为|我建议你的回答是|根据上下文[，,]?你可以|首先需要确认)",
    re.IGNORECASE,
)


class MeetingCopilotError(RuntimeError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


class MeetingCopilotModelOutput(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    action: Literal["answer", "no_action", "wait_for_more", "clarify"]
    reason_code: str = Field(min_length=1, max_length=64)
    resolved_question: str | None = Field(default=None, max_length=500)
    direct_answer: str | None = Field(default=None, max_length=1_200)
    key_points: list[str] | None = Field(default=None, max_length=4)
    knowledge_basis: (
        Literal[
            "general_knowledge",
            "provided_context",
            "mixed",
            "none",
        ]
        | None
    ) = None
    source_ids: list[str] | None = Field(default=None, max_length=8)
    reliability: Literal["high", "medium", "low"] | None = None
    uncertainty: str | None = Field(default=None, max_length=500)
    clarifying_question: str | None = Field(default=None, max_length=300)

    @model_validator(mode="after")
    def validate_action_shape(self):
        scalar_fields = {
            "resolved_question": (self.resolved_question or "").strip(),
            "direct_answer": (self.direct_answer or "").strip(),
            "uncertainty": (self.uncertainty or "").strip(),
            "clarifying_question": (self.clarifying_question or "").strip(),
        }
        for field_name, value in scalar_fields.items():
            if getattr(self, field_name) is not None:
                object.__setattr__(self, field_name, value)
        cleaned_points = [
            point.strip() for point in (self.key_points or []) if point.strip()
        ]
        cleaned_sources = list(
            dict.fromkeys(
                source.strip() for source in (self.source_ids or []) if source.strip()
            )
        )
        if any(len(point) > 300 for point in cleaned_points):
            raise ValueError("key point exceeds the maximum length")
        if any(len(source_id) > 256 for source_id in cleaned_sources):
            raise ValueError("source id exceeds the maximum length")
        object.__setattr__(self, "key_points", cleaned_points)
        object.__setattr__(self, "source_ids", cleaned_sources)

        if self.action == "answer":
            if self.reason_code not in ANSWER_REASON_CODES:
                raise ValueError("answer has an invalid reason_code")
            if (
                not scalar_fields["resolved_question"]
                or not scalar_fields["direct_answer"]
            ):
                raise ValueError(
                    "answer requires a resolved question and direct answer"
                )
            if (
                self.knowledge_basis in {None, "none"}
                or scalar_fields["clarifying_question"]
            ):
                raise ValueError(
                    "answer has an invalid knowledge or clarification shape"
                )
            if (
                self.knowledge_basis in {"provided_context", "mixed"}
                and not self.source_ids
            ):
                raise ValueError("context-backed answers require source_ids")
            if self.reliability is None:
                raise ValueError("answer requires reliability metadata")
            if self.reliability == "low" and not scalar_fields["uncertainty"]:
                raise ValueError("low reliability answers require uncertainty")
            if META_ANSWER_PREFIX.search(scalar_fields["direct_answer"]):
                raise ValueError(
                    "answer starts with meta-advice instead of substantive content"
                )
            object.__setattr__(
                self, "resolved_question", scalar_fields["resolved_question"]
            )
            object.__setattr__(self, "direct_answer", scalar_fields["direct_answer"])
            object.__setattr__(self, "uncertainty", scalar_fields["uncertainty"])
            return self

        if self.action == "no_action":
            allowed_reasons = NO_ACTION_REASON_CODES
        elif self.action == "wait_for_more":
            allowed_reasons = WAIT_REASON_CODES
        else:
            allowed_reasons = CLARIFY_REASON_CODES

        if self.reason_code not in allowed_reasons:
            raise ValueError(f"{self.action} has an invalid reason_code")
        if self.action == "clarify":
            if (
                not scalar_fields["resolved_question"]
                or not scalar_fields["clarifying_question"]
            ):
                raise ValueError("clarify requires a resolved and clarifying question")
            if not scalar_fields["uncertainty"]:
                raise ValueError("clarify requires an uncertainty explanation")
            if scalar_fields["direct_answer"] or self.key_points or self.source_ids:
                raise ValueError("clarify must not include an answer or sources")
            object.__setattr__(
                self, "resolved_question", scalar_fields["resolved_question"]
            )
            object.__setattr__(
                self, "clarifying_question", scalar_fields["clarifying_question"]
            )
            object.__setattr__(self, "uncertainty", scalar_fields["uncertainty"])
        elif any(
            [
                scalar_fields["resolved_question"],
                scalar_fields["direct_answer"],
                self.key_points,
                self.source_ids,
                scalar_fields["uncertainty"],
                scalar_fields["clarifying_question"],
            ]
        ):
            raise ValueError(f"{self.action} requires empty answer fields")
        if self.knowledge_basis not in {None, "none"} or self.reliability not in {
            None,
            "low",
        }:
            raise ValueError(f"{self.action} requires none/low knowledge metadata")
        return self


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
        try:
            end_ms = max(start_ms, int(raw.get("end_ms") or start_ms))
        except (TypeError, ValueError):
            end_ms = start_ms
        external_id = (
            _clean_text(raw.get("external_id"), limit=128) or f"segment-{index}"
        )
        segment_ids = [
            _clean_text(segment_id, limit=128)
            for segment_id in (raw.get("segment_ids") or [external_id])
            if _clean_text(segment_id, limit=128)
        ]
        try:
            revision = max(1, int(raw.get("revision") or 1))
        except (TypeError, ValueError):
            revision = 1
        normalized.append(
            {
                "external_id": external_id,
                "source": source,
                "start_ms": start_ms,
                "end_ms": end_ms,
                "text": text,
                "recorded_at": _clean_text(raw.get("recorded_at"), limit=64),
                "candidate_id": _clean_text(raw.get("candidate_id"), limit=256)
                or external_id,
                "segment_ids": list(dict.fromkeys(segment_ids)),
                "revision": revision,
                "stability": _clean_text(raw.get("stability"), limit=32) or "stable",
                "close_reason": _clean_text(raw.get("close_reason"), limit=64),
            }
        )
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
        speaker = "系统音频" if segment["source"] == "remote" else "本地麦克风"
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
        sources.append(
            MeetingCopilotSource(
                id=f"project:{item.id}",
                kind="project_resource",
                title=_clean_text(item.title, limit=255) or "未命名资料",
                excerpt=excerpt,
                resource_type=item.item_type,
                resource_id=item.resource_id,
            )
        )
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


def _parse_model_output(
    content: Any,
    source_map: dict[str, MeetingCopilotSource],
) -> dict[str, Any]:
    if isinstance(content, dict):
        value = content
    else:
        text = str(content or "").strip()
        if not text:
            raise MeetingCopilotError(
                "invalid_model_response", "回答模型没有返回有效 JSON"
            )
        try:
            value = json.loads(text)
        except json.JSONDecodeError as exc:
            raise MeetingCopilotError(
                "invalid_model_response",
                "回答模型返回的 JSON 无法解析",
            ) from exc
    if not isinstance(value, dict):
        raise MeetingCopilotError("invalid_model_response", "回答模型返回格式不正确")
    try:
        parsed = MeetingCopilotModelOutput.model_validate(value)
    except ValidationError as exc:
        raise MeetingCopilotError(
            "invalid_model_response",
            "回答模型返回的结构不符合会议问答契约",
        ) from exc
    source_ids = parsed.source_ids or []
    unknown_sources = [
        source_id for source_id in source_ids if source_id not in source_map
    ]
    if unknown_sources:
        raise MeetingCopilotError(
            "invalid_model_response",
            "回答模型引用了未授权的会议来源",
        )
    output = parsed.model_dump(exclude_none=True)
    output["sources"] = [source_map[source_id].as_dict() for source_id in source_ids]
    return output


def generate_meeting_copilot_answer(
    *,
    session: MeetingSession,
    user: Any,
    recent_segments: list[dict[str, Any]],
    question_segment_id: str,
    selected_model_id: str | None = None,
    llm_call: Callable[..., Any] | None = None,
) -> dict[str, Any]:
    started_at = time.perf_counter()
    segments = _normalize_segments(recent_segments)
    candidate = _selected_turn(segments, question_segment_id)
    if candidate is None:
        return {
            "status": "no_question",
            "message": "还没有识别到完整问题",
        }
    candidate_index = segments.index(candidate)
    segments = segments[: candidate_index + 1]
    context_segments = segments[:-1]
    sources = [
        MeetingCopilotSource(
            id=f"transcript:{segment['external_id']}",
            kind="transcript",
            title=(
                "当前候选发言"
                if segment is candidate
                else (
                    "会议前文（系统音频）"
                    if segment["source"] == "remote"
                    else "会议前文（本地麦克风）"
                )
            ),
            excerpt=segment["text"],
        )
        for segment in segments
    ]
    brief = _clean_text(session.brief, limit=2_000)
    if brief:
        sources.append(
            MeetingCopilotSource(
                id="meeting:brief",
                kind="meeting_brief",
                title="会前 Brief",
                excerpt=brief,
            )
        )
    sources.extend(_project_sources(session, user))
    source_map = {source.id: source for source in sources}
    context_ready_at = time.perf_counter()

    if llm_call is None:
        from apps.services.llm.services.chat import unified_llm_call

        llm_call = unified_llm_call
    model = _select_chat_model(session, user, selected_model_id)
    candidate_payload = {
        key: candidate[key]
        for key in (
            "candidate_id",
            "revision",
            "external_id",
            "segment_ids",
            "source",
            "start_ms",
            "end_ms",
            "text",
            "recorded_at",
            "stability",
            "close_reason",
        )
    }
    stability_payload = {
        "stability": candidate["stability"],
        "close_reason": candidate["close_reason"],
    }
    call_kwargs = {
        "scene_key": "meeting_copilot_quick_answer",
        "variables": {
            "candidate_json": json.dumps(candidate_payload, ensure_ascii=False),
            "transcript_context_before_candidate": _transcript_context(
                context_segments,
            ),
            "evidence_catalog_json": json.dumps(
                [
                    {
                        "id": source.id,
                        "kind": source.kind,
                        "title": source.title,
                        **(
                            {"excerpt": source.excerpt}
                            if source.kind != "transcript"
                            else {}
                        ),
                    }
                    for source in sources
                ],
                ensure_ascii=False,
            ),
            "stability_signals_json": json.dumps(
                stability_payload,
                ensure_ascii=False,
            ),
        },
        "user_id": str(user.id),
        "organization_id": str(session.organization_id),
        "selected_model_id": str(model.id),
        "timeout_sec": 12,
        "result_validator": lambda content: _parse_model_output(
            content,
            source_map,
        ),
    }
    result = None
    parsed = None
    model_started_at = time.perf_counter()
    attempts = 0
    from apps.services.llm.scenes.exceptions import BYOKResultInvalid

    for attempt in range(MAX_MODEL_ATTEMPTS):
        attempts = attempt + 1
        try:
            result = llm_call(**call_kwargs)
            parsed = _parse_model_output(result.content, source_map)
            break
        except (MeetingCopilotError, BYOKResultInvalid) as exc:
            validation_error = (
                exc if isinstance(exc, MeetingCopilotError) else exc.__cause__
            )
            is_invalid_response = (
                isinstance(validation_error, MeetingCopilotError)
                and validation_error.code == "invalid_model_response"
            )
            if not is_invalid_response or attempt + 1 >= MAX_MODEL_ATTEMPTS:
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
    action = parsed.pop("action")
    completed_at = time.perf_counter()
    logger.info(
        "[MeetingCopilot] completed session=%s segment=%s source=%s "
        "status=%s context_ms=%s model_roundtrip_ms=%s total_ms=%s "
        "provider_latency_ms=%s attempts=%s",
        session.id,
        candidate["external_id"],
        candidate["source"],
        action,
        round((context_ready_at - started_at) * 1_000),
        round((completed_at - model_started_at) * 1_000),
        round((completed_at - started_at) * 1_000),
        max(int(result.telemetry.latency_ms or 0), 0),
        attempts,
    )
    reason_code = parsed.pop("reason_code")
    if action == "no_action":
        return {
            "status": "no_action",
            "message": "当前发言不需要专业回答",
            "candidate_segment_id": candidate["external_id"],
            "reason_code": reason_code,
        }
    if action == "wait_for_more":
        return {
            "status": "wait_for_more",
            "message": "当前发言尚未结束，正在等待后续内容",
            "candidate_segment_id": candidate["external_id"],
            "reason_code": reason_code,
        }
    if action == "clarify":
        return {
            "status": "needs_clarification",
            "question": parsed["resolved_question"],
            "question_segment_id": candidate["external_id"],
            "clarifying_question": parsed["clarifying_question"],
            "uncertainty": parsed["uncertainty"],
            "reason_code": reason_code,
            "model": result.telemetry.model_used,
            "provider": result.telemetry.provider_used,
            "latency_ms": result.telemetry.latency_ms,
        }
    return {
        "status": "answered",
        "question": parsed["resolved_question"],
        "question_segment_id": candidate["external_id"],
        "answer": parsed["direct_answer"],
        "key_points": parsed["key_points"],
        "sources": parsed["sources"],
        "reliability": parsed["reliability"],
        "warning": parsed["uncertainty"],
        "reason_code": reason_code,
        "knowledge_basis": parsed["knowledge_basis"],
        "uncertainty": parsed["uncertainty"],
        "model": result.telemetry.model_used,
        "provider": result.telemetry.provider_used,
        "latency_ms": result.telemetry.latency_ms,
    }


__all__ = [
    "MeetingCopilotError",
    "MeetingCopilotSource",
    "generate_meeting_copilot_answer",
]
