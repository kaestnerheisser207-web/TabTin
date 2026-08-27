from __future__ import annotations

import hashlib
import json
from typing import Any
from uuid import UUID

from django.db.models import Q, QuerySet

from apps.services.common.constants import ROLE_LEVELS
from apps.tabtinspace.models import OrganizationMember

from .models import (
    MeetingAnalysis,
    MeetingPermission,
    MeetingReference,
    MeetingSession,
    MeetingTrack,
    MeetingTranscriptSegment,
)


MEETING_FILE_USAGE_MODULE = "meeting"
MEETING_TRACK_CONTEXT_TYPE = "meeting_track"
MEETING_ANALYSIS_SCENE_KEY = "meeting_post_analysis"
MEETING_ANALYSIS_MAX_TRANSCRIPT_CHARS = 120_000


def meeting_track_context_id(session_id: Any, source: str) -> str:
    if source not in MeetingTrack.Source.values:
        raise ValueError("invalid meeting track source")
    return f"{session_id}:{source}"


class MeetingAccessService:
    """Owner + explicit ACL access without Organization-role fallback."""

    @staticmethod
    def _organization_role(session: MeetingSession, user: Any) -> str | None:
        if not user or not getattr(user, "id", None):
            return None
        if str(session.organization.owner_id) == str(user.id):
            return "owner"
        return (
            OrganizationMember.objects.filter(
                organization_id=session.organization_id,
                user_id=user.id,
            )
            .values_list("role", flat=True)
            .first()
        )

    @classmethod
    def role_for(cls, session: MeetingSession, user: Any) -> str | None:
        if not user or not getattr(user, "id", None):
            return None
        if str(session.created_by_id) == str(user.id):
            return "owner"

        organization_role = cls._organization_role(session, user)
        if not organization_role:
            return None

        permissions = session.permissions.filter(is_active=True)
        matched = list(
            permissions.filter(
                Q(subject_type="user", subject_id=str(user.id))
                | Q(subject_type="role", subject_id=organization_role)
            ).values_list("permission", flat=True)
        )
        if not matched:
            return None
        return max(matched, key=lambda role: ROLE_LEVELS.get(role, 0))

    @classmethod
    def has_access(
        cls,
        session: MeetingSession,
        user: Any,
        required_role: str = "viewer",
    ) -> bool:
        role = cls.role_for(session, user)
        return bool(
            role
            and ROLE_LEVELS.get(role, 0) >= ROLE_LEVELS.get(required_role, 0)
        )

    @staticmethod
    def visible_sessions(
        queryset: QuerySet[MeetingSession],
        user: Any,
        organization_role: str | None,
    ) -> QuerySet[MeetingSession]:
        if not user or not getattr(user, "id", None):
            return queryset.none()
        access_q = Q(created_by_id=user.id) | Q(
            permissions__subject_type="user",
            permissions__subject_id=str(user.id),
            permissions__is_active=True,
        )
        if organization_role:
            access_q |= Q(
                permissions__subject_type="role",
                permissions__subject_id=organization_role,
                permissions__is_active=True,
            )
        return queryset.filter(access_q).distinct()


def serialize_meeting_reference(reference: MeetingReference) -> dict[str, Any]:
    return {
        "id": str(reference.id),
        "reference_type": reference.reference_type,
        "resource_id": str(reference.resource_id),
        "title": reference.title_snapshot,
        "metadata": reference.metadata,
        "created_by_id": (
            str(reference.created_by_id) if reference.created_by_id else None
        ),
        "created_at": reference.created_at,
    }


def resolve_meeting_reference(
    *,
    session: MeetingSession,
    user: Any,
    reference_type: str,
    resource_id: UUID,
) -> dict[str, Any]:
    if reference_type == MeetingReference.ReferenceType.DOCUMENT:
        from apps.tabdoc.services.document_service import DocumentService

        try:
            document = DocumentService(user=user).get_document(
                str(resource_id),
                required_role="viewer",
            )
        except (ValueError, PermissionError) as exc:
            raise ValueError("document reference is unavailable") from exc
        if str(document.organization_id) != str(session.organization_id):
            raise ValueError("document reference belongs to another organization")
        return {
            "title": document.title or "未命名文档",
            "metadata": {
                "organization_id": str(document.organization_id),
                "space_id": str(document.space_id) if document.space_id else None,
            },
        }

    if reference_type == MeetingReference.ReferenceType.TASK:
        from apps.tabtinspace.models import ProjectTask
        from apps.tabtinspace.services.base import ServiceError
        from apps.tabtinspace.services.project_task_service import ProjectTaskService

        task = ProjectTask.objects.select_related("project").filter(id=resource_id).first()
        if task is None or str(task.project.organization_id) != str(session.organization_id):
            raise ValueError("task reference is unavailable")
        try:
            payload = ProjectTaskService(user=user).get_task(
                project_id=task.project_id,
                task_id=task.id,
            )
        except ServiceError as exc:
            raise ValueError("task reference is unavailable") from exc
        return {
            "title": payload.get("title") or task.title,
            "metadata": {
                "organization_id": str(task.project.organization_id),
                "project_id": str(task.project_id),
                "work_status": payload.get("work_status", ""),
            },
        }

    raise ValueError("unsupported meeting reference type")


def _clean_analysis_text(value: Any, *, limit: int) -> str:
    return " ".join(str(value or "").split())[:limit]


def _stable_analysis_item_id(kind: str, text: str, index: int) -> str:
    basis = _clean_analysis_text(text, limit=1000) or str(index)
    digest = hashlib.sha256(f"{kind}:{basis}".encode("utf-8")).hexdigest()[:12]
    return f"{kind}-{digest}"


def _normalize_evidence_ids(value: Any, allowed_ids: set[str]) -> list[str]:
    if not isinstance(value, list):
        return []
    return list(
        dict.fromkeys(
            str(item)
            for item in value
            if str(item) in allowed_ids
        )
    )[:20]


def _normalize_analysis_items(
    *,
    kind: str,
    raw_items: Any,
    allowed_evidence_ids: set[str],
    prior_task_ids: dict[str, str] | None = None,
) -> list[dict[str, Any]]:
    if not isinstance(raw_items, list):
        return []
    normalized: list[dict[str, Any]] = []
    seen_ids: set[str] = set()
    for index, raw in enumerate(raw_items[:50]):
        if isinstance(raw, str):
            raw = {"text": raw}
        if not isinstance(raw, dict):
            continue
        text = _clean_analysis_text(
            raw.get("text") or raw.get("title") or raw.get("summary"),
            limit=2000,
        )
        if not text:
            continue
        item_id = _stable_analysis_item_id(kind, text, index)
        if item_id in seen_ids:
            continue
        seen_ids.add(item_id)
        item: dict[str, Any] = {
            "id": item_id,
            "text": text,
            "evidence_segment_ids": _normalize_evidence_ids(
                raw.get("evidence_segment_ids"),
                allowed_evidence_ids,
            ),
        }
        if kind == "topic":
            item["title"] = _clean_analysis_text(raw.get("title") or text, limit=300)
            item["summary"] = _clean_analysis_text(
                raw.get("summary") or raw.get("text"),
                limit=2000,
            )
        if kind == "action":
            item["title"] = _clean_analysis_text(raw.get("title") or text, limit=200)
            item["description"] = _clean_analysis_text(
                raw.get("description"),
                limit=4000,
            )
            item["responsible_user_id"] = _clean_analysis_text(
                raw.get("responsible_user_id"),
                limit=64,
            )
            item["responsible_name"] = _clean_analysis_text(
                raw.get("responsible_name"),
                limit=255,
            )
            item["due_date"] = _clean_analysis_text(raw.get("due_date"), limit=32)
            priority = str(raw.get("priority") or "medium").lower()
            item["priority"] = (
                priority if priority in {"low", "medium", "high", "urgent"} else "medium"
            )
            item["task_id"] = (prior_task_ids or {}).get(item_id) or None
        normalized.append(item)
    return normalized


def parse_meeting_analysis_result(
    content: str,
    *,
    allowed_evidence_ids: set[str],
    prior_action_items: list[dict[str, Any]] | None = None,
) -> tuple[dict[str, Any], bool]:
    raw_text = str(content or "").strip()
    start = raw_text.find("{")
    end = raw_text.rfind("}")
    if start < 0 or end <= start:
        raise ValueError("meeting analysis did not return a JSON object")
    try:
        value = json.loads(raw_text[start : end + 1])
    except json.JSONDecodeError as exc:
        raise ValueError("meeting analysis returned invalid JSON") from exc
    if not isinstance(value, dict):
        raise ValueError("meeting analysis result must be an object")

    summary = _clean_analysis_text(value.get("summary"), limit=12_000)
    if not summary:
        raise ValueError("meeting analysis summary is empty")
    prior_task_ids = {
        str(item.get("id")): str(item.get("task_id"))
        for item in (prior_action_items or [])
        if isinstance(item, dict) and item.get("id") and item.get("task_id")
    }
    category_map = {
        "topics": "topic",
        "decisions": "decision",
        "action_items": "action",
        "open_questions": "question",
        "risks": "risk",
    }
    result: dict[str, Any] = {"summary": summary}
    complete_shape = True
    for field, kind in category_map.items():
        if not isinstance(value.get(field), list):
            complete_shape = False
        result[field] = _normalize_analysis_items(
            kind=kind,
            raw_items=value.get(field),
            allowed_evidence_ids=allowed_evidence_ids,
            prior_task_ids=prior_task_ids if kind == "action" else None,
        )
    return result, complete_shape


def build_meeting_analysis_transcript(
    session: MeetingSession,
) -> tuple[str, set[str]]:
    segments = MeetingTranscriptSegment.objects.filter(
        session=session,
        is_final=True,
    ).order_by("start_ms", "created_at")
    lines: list[str] = []
    evidence_ids: set[str] = set()
    total_chars = 0
    for segment in segments:
        text = _clean_analysis_text(segment.display_text, limit=4000)
        if not text:
            continue
        source_id = str(segment.external_id)
        speaker = segment.speaker_key or ("我" if segment.source == "local" else "对方")
        line = f"[segment:{source_id}] [{segment.start_ms}-{segment.end_ms}ms] {speaker}: {text}"
        if total_chars + len(line) > MEETING_ANALYSIS_MAX_TRANSCRIPT_CHARS:
            raise ValueError("meeting transcript exceeds the current analysis input limit")
        lines.append(line)
        evidence_ids.add(source_id)
        total_chars += len(line) + 1
    if not lines:
        raise ValueError("meeting has no final transcript to analyze")
    return "\n".join(lines), evidence_ids


def generate_meeting_analysis(
    *,
    analysis: MeetingAnalysis,
    user: Any,
    llm_call=None,
) -> tuple[dict[str, Any], dict[str, Any], bool]:
    transcript, evidence_ids = build_meeting_analysis_transcript(analysis.session)
    if llm_call is None:
        from apps.services.llm.services.chat import unified_llm_call

        llm_call = unified_llm_call
    result = llm_call(
        scene_key=MEETING_ANALYSIS_SCENE_KEY,
        variables={
            "meeting_title": analysis.session.title,
            "meeting_brief": analysis.session.brief or "（未提供）",
            "transcript": transcript,
        },
        user_id=str(user.id),
        organization_id=str(analysis.session.organization_id),
        timeout_sec=120,
        result_validator=lambda content: parse_meeting_analysis_result(
            content,
            allowed_evidence_ids=evidence_ids,
            prior_action_items=analysis.action_items,
        ),
    )
    parsed, complete_shape = parse_meeting_analysis_result(
        result.content,
        allowed_evidence_ids=evidence_ids,
        prior_action_items=analysis.action_items,
    )
    telemetry = {
        "provider": result.telemetry.provider_used,
        "model": result.telemetry.model_used,
    }
    return parsed, telemetry, complete_shape


def deactivate_meeting_audio_usages(
    session: MeetingSession,
    *,
    actor_user_id: str,
    source: str | None = None,
    biz_type: str,
) -> int:
    from apps.services.oss.models import FileUsage
    from apps.services.oss.services.deactivate_utils import (
        deactivate_file_usages_and_release_storage,
    )

    sources = [source] if source else list(MeetingTrack.Source.values)
    context_ids = [meeting_track_context_id(session.id, item) for item in sources]
    count = deactivate_file_usages_and_release_storage(
        module=MEETING_FILE_USAGE_MODULE,
        context_filter={
            "context_type": MEETING_TRACK_CONTEXT_TYPE,
            "context_id__in": context_ids,
        },
        organization_id=str(session.organization_id),
        user_id=actor_user_id,
        biz_type=biz_type,
        biz_id=str(session.id),
        log_prefix="Meeting audio cleanup",
    )
    if FileUsage.objects.filter(
        module=MEETING_FILE_USAGE_MODULE,
        context_type=MEETING_TRACK_CONTEXT_TYPE,
        context_id__in=context_ids,
        is_active=True,
    ).exists():
        raise RuntimeError("meeting audio references could not be safely deactivated")
    return count


__all__ = [
    "MEETING_ANALYSIS_SCENE_KEY",
    "MEETING_FILE_USAGE_MODULE",
    "MEETING_TRACK_CONTEXT_TYPE",
    "MeetingAccessService",
    "build_meeting_analysis_transcript",
    "deactivate_meeting_audio_usages",
    "generate_meeting_analysis",
    "meeting_track_context_id",
    "parse_meeting_analysis_result",
    "resolve_meeting_reference",
    "serialize_meeting_reference",
]
