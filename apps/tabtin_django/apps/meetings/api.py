import logging
import json
from datetime import date, datetime, time, timedelta
from typing import Optional
from uuid import UUID

from django.db import IntegrityError, transaction
from django.db.models import F, Q
from django.http import HttpResponse
from django.utils import timezone
from ninja import Router, Schema
from ninja.errors import HttpError

from apps.services.oss.models import FileRecord, FileUsage
from apps.services.oss.services.file_access import resolve_authorized_file
from apps.tabtinspace.models import Organization, OrganizationMember, Project
from apps.tabtinspace.services.space_visibility import user_can_access_space
from apps.users.auth.api import jwt_auth

from .models import (
    MeetingAnalysis,
    MeetingCopilotAnswer,
    MeetingSession,
    MeetingPermission,
    MeetingReference,
    MeetingTrack,
    MeetingTranscriptRun,
    MeetingTranscriptSegment,
)
from .services import (
    MEETING_FILE_USAGE_MODULE,
    MEETING_TRACK_CONTEXT_TYPE,
    MeetingAccessService,
    deactivate_meeting_audio_usages,
    meeting_track_context_id,
    resolve_meeting_reference,
    serialize_meeting_reference,
)

router = Router(tags=["Meeting Records"])
logger = logging.getLogger(__name__)

MAX_TRANSCRIPT_SEGMENTS_PER_BATCH = 500

ALLOWED_LIFECYCLE_TRANSITIONS = {
    MeetingSession.LifecycleStatus.DRAFT: {
        MeetingSession.LifecycleStatus.PREPARING,
        MeetingSession.LifecycleStatus.CANCELLED,
    },
    MeetingSession.LifecycleStatus.PREPARING: {
        MeetingSession.LifecycleStatus.RECORDING,
        MeetingSession.LifecycleStatus.CANCELLED,
        MeetingSession.LifecycleStatus.INTERRUPTED,
    },
    MeetingSession.LifecycleStatus.RECORDING: {
        MeetingSession.LifecycleStatus.STOPPED,
        MeetingSession.LifecycleStatus.INTERRUPTED,
    },
    MeetingSession.LifecycleStatus.INTERRUPTED: {
        MeetingSession.LifecycleStatus.STOPPED,
        MeetingSession.LifecycleStatus.CANCELLED,
    },
    MeetingSession.LifecycleStatus.STOPPED: set(),
    MeetingSession.LifecycleStatus.CANCELLED: set(),
}


class CreateMeetingSessionIn(Schema):
    id: UUID
    organization_id: UUID
    project_id: Optional[UUID] = None
    title: str
    brief: str = ""
    consent_confirmed: bool = False
    copilot_enabled: bool = False


class MeetingLifecycleIn(Schema):
    status: str
    expected_version: int
    duration_ms: int = 0


class MeetingCopilotStateIn(Schema):
    enabled: bool
    expected_version: int


class MeetingCopilotTranscriptSegmentIn(Schema):
    external_id: str
    source: str
    start_ms: int = 0
    text: str
    is_final: bool = True


class MeetingCopilotAnswerIn(Schema):
    request_id: Optional[UUID] = None
    question_segment_id: str
    model_id: Optional[UUID] = None
    recent_segments: list[MeetingCopilotTranscriptSegmentIn] = []


class MeetingPermissionIn(Schema):
    subject_type: str
    subject_id: str
    permission: str = "viewer"


class MeetingReferenceIn(Schema):
    reference_type: str
    resource_id: UUID


class MeetingTrackIn(Schema):
    source: str
    capture_status: str
    storage_status: str = MeetingTrack.StorageStatus.LOCAL_ONLY
    local_available: bool = False
    device_id: str = ""
    device_label: str = ""
    sample_rate: int = 0
    channel_count: int = 0
    codec: str = ""
    container: str = ""
    duration_ms: int = 0
    file_size: int = 0
    content_hash: str = ""
    file_record_id: Optional[UUID] = None
    error_code: str = ""
    error_message: str = ""


class CreateTranscriptRunIn(Schema):
    id: UUID
    track_id: Optional[UUID] = None
    mode: str
    provider: str = ""
    model: str = ""
    language: str = ""
    metadata: dict = {}


class TranscriptSegmentIn(Schema):
    external_id: str
    track_id: Optional[UUID] = None
    source: str
    speaker_key: str = ""
    start_ms: int
    end_ms: int
    raw_text: str
    is_final: bool
    confidence: Optional[float] = None
    metadata: dict = {}


class TranscriptSegmentBatchIn(Schema):
    segments: list[TranscriptSegmentIn]


class TranscriptRunStateIn(Schema):
    status: str
    error_code: str = ""
    error_message: str = ""


def is_lifecycle_transition_allowed(current: str, target: str) -> bool:
    if current == target:
        return True
    return target in ALLOWED_LIFECYCLE_TRANSITIONS.get(current, set())


def _require_organization_access(request, organization_id: UUID) -> Organization:
    organization = Organization.objects.filter(id=organization_id).first()
    if organization is None:
        raise HttpError(404, "organization not found")
    if str(organization.owner_id) == str(request.auth.id):
        return organization
    if not OrganizationMember.objects.filter(
        organization_id=organization_id,
        user_id=request.auth.id,
    ).exists():
        raise HttpError(403, "organization access denied")
    return organization


def _resolve_project(request, organization_id: UUID, project_id: Optional[UUID]) -> Optional[Project]:
    if project_id is None:
        return None
    project = Project.objects.select_related("organization").filter(id=project_id).first()
    if project is None:
        raise HttpError(404, "project not found")
    if project.organization_id != organization_id:
        raise HttpError(422, "project does not belong to organization")
    if not user_can_access_space(request.auth, project, "viewer"):
        raise HttpError(403, "project access denied")
    return project


def _owned_session(request, session_id: UUID, *, for_update: bool = False) -> MeetingSession:
    """Return a creator-owned session for device-authoritative write endpoints."""
    queryset = MeetingSession.objects
    if for_update:
        queryset = queryset.select_for_update()
    else:
        queryset = queryset.select_related("project")
    session = queryset.filter(id=session_id, created_by_id=request.auth.id).first()
    if session is None:
        raise HttpError(404, "meeting session not found")
    return session


def _accessible_session(
    request,
    session_id: UUID,
    *,
    required_role: str = "viewer",
    for_update: bool = False,
) -> MeetingSession:
    queryset = MeetingSession.objects.select_related("organization")
    if for_update:
        queryset = queryset.select_for_update()
    else:
        queryset = queryset.select_related("project")
    session = queryset.filter(id=session_id).first()
    if session is None or not MeetingAccessService.has_access(
        session,
        request.auth,
        required_role,
    ):
        raise HttpError(404, "meeting session not found")
    return session


def _serialize_track(track: MeetingTrack) -> dict:
    return {
        "id": str(track.id),
        "source": track.source,
        "capture_status": track.capture_status,
        "storage_status": track.storage_status,
        "local_available": track.local_available,
        "device_id": track.device_id,
        "device_label": track.device_label,
        "sample_rate": track.sample_rate,
        "channel_count": track.channel_count,
        "codec": track.codec,
        "container": track.container,
        "duration_ms": track.duration_ms,
        "file_size": track.file_size,
        "content_hash": track.content_hash,
        "file_record_id": str(track.file_record_id) if track.file_record_id else None,
        "last_checkpoint_at": track.last_checkpoint_at,
        "error_code": track.error_code,
        "error_message": track.error_message,
    }


def _serialize_session(session: MeetingSession, *, include_tracks: bool = True) -> dict:
    result = {
        "id": str(session.id),
        "organization_id": str(session.organization_id),
        "project_id": str(session.project_id) if session.project_id else None,
        "project_name": session.project.name if session.project else session.project_name_snapshot,
        "title": session.title,
        "brief": session.brief,
        "lifecycle_status": session.lifecycle_status,
        "copilot_initially_enabled": session.copilot_initially_enabled,
        "copilot_enabled": session.copilot_enabled,
        "consent_confirmed_at": session.consent_confirmed_at,
        "started_at": session.started_at,
        "ended_at": session.ended_at,
        "duration_ms": session.duration_ms,
        "transcript_revision": session.transcript_revision,
        "version": session.version,
        "created_at": session.created_at,
        "updated_at": session.updated_at,
    }
    if include_tracks:
        result["tracks"] = [_serialize_track(track) for track in session.tracks.all()]
    return result


def _serialize_analysis(analysis: MeetingAnalysis) -> dict:
    return {
        "id": str(analysis.id),
        "session_id": str(analysis.session_id),
        "status": analysis.status,
        "summary": analysis.summary,
        "topics": analysis.topics,
        "decisions": analysis.decisions,
        "action_items": analysis.action_items,
        "open_questions": analysis.open_questions,
        "risks": analysis.risks,
        "source_transcript_revision": analysis.source_transcript_revision,
        "provider": analysis.provider,
        "model": analysis.model,
        "error_code": analysis.error_code,
        "error_message": analysis.error_message,
        "requested_by_id": str(analysis.requested_by_id) if analysis.requested_by_id else None,
        "started_at": analysis.started_at,
        "completed_at": analysis.completed_at,
        "created_at": analysis.created_at,
        "updated_at": analysis.updated_at,
    }


def _serialize_permission(permission: MeetingPermission) -> dict:
    return {
        "id": str(permission.id),
        "subject_type": permission.subject_type,
        "subject_id": permission.subject_id,
        "permission": permission.permission,
        "is_active": permission.is_active,
        "granted_by": permission.granted_by,
        "created_at": permission.created_at,
        "updated_at": permission.updated_at,
    }


def _serialize_transcript_run(run: MeetingTranscriptRun) -> dict:
    return {
        "id": str(run.id),
        "track_id": str(run.track_id) if run.track_id else None,
        "mode": run.mode,
        "status": run.status,
        "provider": run.provider,
        "model": run.model,
        "language": run.language,
        "metadata": run.metadata,
        "error_code": run.error_code,
        "error_message": run.error_message,
        "started_at": run.started_at,
        "completed_at": run.completed_at,
        "created_at": run.created_at,
        "updated_at": run.updated_at,
    }


def _serialize_transcript_segment(segment: MeetingTranscriptSegment) -> dict:
    return {
        "id": str(segment.id),
        "run_id": str(segment.run_id),
        "track_id": str(segment.track_id) if segment.track_id else None,
        "external_id": segment.external_id,
        "source": segment.source,
        "speaker_key": segment.speaker_key,
        "start_ms": segment.start_ms,
        "end_ms": segment.end_ms,
        "raw_text": segment.raw_text,
        "edited_text": segment.edited_text,
        "display_text": segment.display_text,
        "is_final": segment.is_final,
        "confidence": segment.confidence,
        "metadata": segment.metadata,
        "edited_by_id": str(segment.edited_by_id) if segment.edited_by_id else None,
        "edited_at": segment.edited_at,
        "created_at": segment.created_at,
        "updated_at": segment.updated_at,
    }


def _serialize_copilot_answer(answer: MeetingCopilotAnswer) -> dict:
    return {
        "id": str(answer.id),
        "request_id": str(answer.request_id),
        "question_segment_id": answer.question_segment_id,
        "question_text": answer.question_text,
        "status": answer.status,
        "result_snapshot": answer.result_snapshot,
        "model": answer.model,
        "provider": answer.provider,
        "latency_ms": answer.latency_ms,
        "created_at": answer.created_at,
    }


def _validate_meeting_track_file_binding(
    *,
    session: MeetingSession,
    source: str,
    file_record_id: UUID | None,
    user_id: UUID,
) -> FileRecord | None:
    if file_record_id is None:
        return None
    file_record = FileRecord.objects.filter(
        id=file_record_id,
        status="completed",
    ).first()
    if file_record is None:
        raise HttpError(422, "meeting audio file does not exist")
    if file_record.is_public:
        raise HttpError(422, "meeting audio file must be private")
    if not file_record.mime_type.lower().startswith("audio/"):
        raise HttpError(422, "meeting track requires an audio file")
    if str(file_record.organization_id) != str(session.organization_id):
        raise HttpError(422, "meeting audio file belongs to another organization")
    context_id = meeting_track_context_id(session.id, source)
    if not FileUsage.objects.filter(
        file_record=file_record,
        user_id=user_id,
        module=MEETING_FILE_USAGE_MODULE,
        context_type=MEETING_TRACK_CONTEXT_TYPE,
        context_id=context_id,
        is_active=True,
    ).exists():
        raise HttpError(422, "meeting audio file is not bound to this track upload")
    return file_record


@router.post("/sessions", auth=jwt_auth)
@transaction.atomic
def create_meeting_session(request, data: CreateMeetingSessionIn):
    title = data.title.strip()
    if not title or len(title) > 255:
        raise HttpError(422, "title is required and must not exceed 255 characters")

    existing = MeetingSession.objects.select_for_update().filter(id=data.id).first()
    if existing is not None:
        if str(existing.created_by_id) != str(request.auth.id):
            raise HttpError(409, "meeting session id is already in use")
        return _serialize_session(existing)

    organization = _require_organization_access(request, data.organization_id)
    project = _resolve_project(request, organization.id, data.project_id)
    now = timezone.now()
    session = MeetingSession.objects.create(
        id=data.id,
        organization=organization,
        created_by_id=request.auth.id,
        project=project,
        project_name_snapshot=project.name if project else "",
        title=title,
        brief=data.brief,
        consent_confirmed_at=now if data.consent_confirmed else None,
        copilot_initially_enabled=data.copilot_enabled,
        copilot_enabled=data.copilot_enabled,
    )
    MeetingTrack.objects.bulk_create([
        MeetingTrack(session=session, source=MeetingTrack.Source.LOCAL),
        MeetingTrack(session=session, source=MeetingTrack.Source.REMOTE),
    ])
    return _serialize_session(MeetingSession.objects.prefetch_related("tracks").get(id=session.id))


@router.get("/sessions", auth=jwt_auth)
def list_meeting_sessions(
    request,
    organization_id: UUID,
    project_id: Optional[UUID] = None,
    lifecycle_status: str = "",
    status: str = "",
    query: str = "",
    date_from: Optional[date] = None,
    date_to: Optional[date] = None,
):
    organization = _require_organization_access(request, organization_id)
    organization_role = (
        "owner"
        if str(organization.owner_id) == str(request.auth.id)
        else OrganizationMember.objects.filter(
            organization_id=organization_id,
            user_id=request.auth.id,
        ).values_list("role", flat=True).first()
    )
    queryset = MeetingAccessService.visible_sessions(
        MeetingSession.objects.filter(
            organization_id=organization_id,
        ).select_related("project"),
        request.auth,
        organization_role,
    )
    if project_id is not None:
        queryset = queryset.filter(project_id=project_id)
    if lifecycle_status and status and lifecycle_status != status:
        raise HttpError(422, "conflicting meeting status filters")
    effective_status = status or lifecycle_status
    if effective_status:
        if effective_status not in MeetingSession.LifecycleStatus.values:
            raise HttpError(422, "invalid lifecycle_status")
        queryset = queryset.filter(lifecycle_status=effective_status)
    normalized_query = query.strip()
    if normalized_query:
        if len(normalized_query) > 200:
            raise HttpError(422, "meeting query is too long")
        queryset = queryset.filter(
            Q(title__icontains=normalized_query)
            | Q(
                transcript_segments__is_final=True,
                transcript_segments__raw_text__icontains=normalized_query,
            )
            | Q(
                transcript_segments__is_final=True,
                transcript_segments__edited_text__icontains=normalized_query,
            )
        )
    if date_from:
        queryset = queryset.filter(
            created_at__gte=timezone.make_aware(datetime.combine(date_from, time.min))
        )
    if date_to:
        if date_from and date_to < date_from:
            raise HttpError(422, "date_to must not precede date_from")
        queryset = queryset.filter(
            created_at__lt=timezone.make_aware(
                datetime.combine(date_to + timedelta(days=1), time.min)
            )
        )
    rows = list(queryset.distinct()[:200])
    return {"sessions": [_serialize_session(row, include_tracks=False) for row in rows]}


@router.get("/sessions/{session_id}", auth=jwt_auth)
def get_meeting_session(request, session_id: UUID):
    session = _accessible_session(request, session_id)
    return _serialize_session(session)


@router.get("/sessions/{session_id}/transcript", auth=jwt_auth)
def get_meeting_transcript(
    request,
    session_id: UUID,
    limit: int = 500,
    offset: int = 0,
):
    session = _accessible_session(request, session_id)
    normalized_limit = min(max(limit, 1), 1000)
    normalized_offset = max(offset, 0)
    segment_queryset = MeetingTranscriptSegment.objects.filter(
        session=session,
    ).select_related("run", "track")
    total = segment_queryset.count()
    segments = list(
        segment_queryset[normalized_offset : normalized_offset + normalized_limit]
    )
    runs = list(MeetingTranscriptRun.objects.filter(session=session))
    next_offset = normalized_offset + len(segments)
    return {
        "runs": [_serialize_transcript_run(run) for run in runs],
        "segments": [_serialize_transcript_segment(segment) for segment in segments],
        "total": total,
        "offset": normalized_offset,
        "limit": normalized_limit,
        "next_offset": next_offset if next_offset < total else None,
    }


@router.get("/sessions/{session_id}/analysis", auth=jwt_auth)
def get_meeting_analysis(request, session_id: UUID):
    session = _accessible_session(request, session_id)
    analysis = MeetingAnalysis.objects.filter(session=session).first()
    if analysis is None:
        raise HttpError(404, "meeting analysis not found")
    return _serialize_analysis(analysis)


def _enqueue_meeting_analysis(
    analysis_id: UUID,
    transcript_revision: int,
) -> None:
    from .tasks import run_meeting_analysis_task

    try:
        run_meeting_analysis_task.delay(str(analysis_id), transcript_revision)
    except Exception as exc:
        logger.exception("Failed to enqueue meeting analysis: analysis=%s", analysis_id)
        MeetingAnalysis.objects.filter(
            id=analysis_id,
            status=MeetingAnalysis.Status.PENDING,
        ).update(
            status=MeetingAnalysis.Status.FAILED,
            error_code="analysis_enqueue_failed",
            error_message=str(exc)[:2000],
            completed_at=timezone.now(),
            updated_at=timezone.now(),
        )


@router.post("/sessions/{session_id}/analysis", auth=jwt_auth)
@transaction.atomic
def request_meeting_analysis(request, session_id: UUID):
    session = _accessible_session(
        request,
        session_id,
        required_role="editor",
        for_update=True,
    )
    if session.lifecycle_status not in {
        MeetingSession.LifecycleStatus.STOPPED,
        MeetingSession.LifecycleStatus.INTERRUPTED,
    }:
        raise HttpError(409, "meeting must be stopped before analysis")
    if not MeetingTranscriptSegment.objects.filter(
        session=session,
        is_final=True,
    ).exclude(raw_text="", edited_text="").exists():
        raise HttpError(409, "meeting has no final transcript to analyze")

    analysis = MeetingAnalysis.objects.select_for_update().filter(session=session).first()
    if analysis is not None and analysis.status == MeetingAnalysis.Status.PENDING:
        return _serialize_analysis(analysis)
    if analysis is not None and analysis.status == MeetingAnalysis.Status.RUNNING:
        from .tasks import MEETING_ANALYSIS_LEASE_SECONDS

        lease_cutoff = timezone.now() - timedelta(
            seconds=MEETING_ANALYSIS_LEASE_SECONDS,
        )
        if analysis.started_at is not None and analysis.started_at >= lease_cutoff:
            return _serialize_analysis(analysis)
        logger.warning(
            "Reclaiming stale meeting analysis lease: analysis=%s session=%s started_at=%s",
            analysis.id,
            session.id,
            analysis.started_at,
        )
    if analysis is None:
        analysis = MeetingAnalysis(session=session)
    analysis.status = MeetingAnalysis.Status.PENDING
    analysis.source_transcript_revision = session.transcript_revision
    analysis.requested_by = request.auth
    analysis.error_code = ""
    analysis.error_message = ""
    analysis.started_at = None
    analysis.completed_at = None
    analysis.save()
    transaction.on_commit(
        lambda: _enqueue_meeting_analysis(
            analysis.id,
            analysis.source_transcript_revision,
        )
    )
    return _serialize_analysis(analysis)


@router.get("/sessions/{session_id}/references", auth=jwt_auth)
def list_meeting_references(request, session_id: UUID):
    session = _accessible_session(request, session_id)
    return {
        "references": [
            serialize_meeting_reference(reference)
            for reference in session.references.select_related("created_by").all()
        ]
    }


@router.post("/sessions/{session_id}/references", auth=jwt_auth)
@transaction.atomic
def add_meeting_reference(
    request,
    session_id: UUID,
    data: MeetingReferenceIn,
):
    session = _accessible_session(
        request,
        session_id,
        required_role="editor",
        for_update=True,
    )
    if data.reference_type not in MeetingReference.ReferenceType.values:
        raise HttpError(422, "invalid meeting reference type")
    try:
        resolved = resolve_meeting_reference(
            session=session,
            user=request.auth,
            reference_type=data.reference_type,
            resource_id=data.resource_id,
        )
    except ValueError as exc:
        raise HttpError(404, str(exc)) from exc
    reference, _ = MeetingReference.objects.update_or_create(
        session=session,
        reference_type=data.reference_type,
        resource_id=data.resource_id,
        defaults={
            "title_snapshot": str(resolved["title"])[:255],
            "metadata": resolved["metadata"],
            "created_by": request.auth,
        },
    )
    return serialize_meeting_reference(reference)


@router.delete("/sessions/{session_id}/references/{reference_id}", auth=jwt_auth)
@transaction.atomic
def delete_meeting_reference(
    request,
    session_id: UUID,
    reference_id: UUID,
):
    session = _accessible_session(
        request,
        session_id,
        required_role="editor",
        for_update=True,
    )
    deleted, _ = MeetingReference.objects.filter(
        id=reference_id,
        session=session,
    ).delete()
    if not deleted:
        raise HttpError(404, "meeting reference not found")
    return {"deleted": True, "reference_id": str(reference_id)}


def _meeting_export_payload(session: MeetingSession) -> dict:
    analysis = MeetingAnalysis.objects.filter(session=session).first()
    transcript = MeetingTranscriptSegment.objects.filter(
        session=session,
        is_final=True,
    ).order_by("start_ms", "created_at")
    return {
        "schema_version": 1,
        "meeting": _serialize_session(session),
        "transcript": [
            _serialize_transcript_segment(segment) for segment in transcript
        ],
        "analysis": _serialize_analysis(analysis) if analysis else None,
        "references": [
            serialize_meeting_reference(reference)
            for reference in session.references.all()
        ],
    }


def _meeting_export_markdown(payload: dict) -> str:
    meeting = payload["meeting"]
    lines = [
        f"# {meeting['title']}",
        "",
        f"- Meeting ID: {meeting['id']}",
        f"- Status: {meeting['lifecycle_status']}",
        f"- Started: {meeting['started_at'] or ''}",
        f"- Ended: {meeting['ended_at'] or ''}",
        "",
    ]
    analysis = payload.get("analysis")
    if analysis:
        lines.extend(["## Summary", "", analysis.get("summary") or "", ""])
        for field, title in (
            ("decisions", "Decisions"),
            ("action_items", "Action Items"),
            ("open_questions", "Open Questions"),
            ("risks", "Risks"),
        ):
            lines.extend([f"## {title}", ""])
            items = analysis.get(field) or []
            lines.extend(
                f"- {item.get('title') or item.get('text') or ''}"
                for item in items
                if isinstance(item, dict)
            )
            lines.append("")
    lines.extend(["## Transcript", ""])
    for segment in payload["transcript"]:
        speaker = segment.get("speaker_key") or segment.get("source")
        lines.append(
            f"- [{segment['start_ms']}ms] **{speaker}**: {segment['display_text']}"
        )
    if payload["references"]:
        lines.extend(["", "## References", ""])
        lines.extend(
            f"- {reference['reference_type']}: {reference['title']} ({reference['resource_id']})"
            for reference in payload["references"]
        )
    return "\n".join(lines).rstrip() + "\n"


@router.get("/sessions/{session_id}/export", auth=jwt_auth)
def export_meeting_session(
    request,
    session_id: UUID,
    format: str = "markdown",
):
    session = _accessible_session(request, session_id)
    payload = _meeting_export_payload(session)
    normalized_format = format.strip().lower()
    if normalized_format == "json":
        content = json.dumps(payload, ensure_ascii=False, indent=2, default=str) + "\n"
        response = HttpResponse(content, content_type="application/json; charset=utf-8")
        extension = "json"
    elif normalized_format in {"markdown", "md"}:
        response = HttpResponse(
            _meeting_export_markdown(payload),
            content_type="text/markdown; charset=utf-8",
        )
        extension = "md"
    else:
        raise HttpError(422, "meeting export format must be markdown or json")
    response["Content-Disposition"] = (
        f'attachment; filename="meeting-{session.id}.{extension}"'
    )
    return response


@router.post(
    "/sessions/{session_id}/analysis/action-items/{item_id}/task",
    auth=jwt_auth,
)
@transaction.atomic
def create_task_from_meeting_action_item(
    request,
    session_id: UUID,
    item_id: str,
):
    from apps.tabtinspace.models import ProjectMembership, ProjectTask
    from apps.tabtinspace.services.base import ServiceError
    from apps.tabtinspace.services.project_task_service import ProjectTaskService

    session = _accessible_session(
        request,
        session_id,
        required_role="editor",
        for_update=True,
    )
    if session.project_id is None:
        raise HttpError(409, "meeting is not associated with a Project")
    analysis = MeetingAnalysis.objects.select_for_update().filter(session=session).first()
    if analysis is None or analysis.status not in {
        MeetingAnalysis.Status.COMPLETED,
        MeetingAnalysis.Status.PARTIAL,
    }:
        raise HttpError(409, "meeting analysis is not ready")
    action_items = [
        dict(item) for item in analysis.action_items if isinstance(item, dict)
    ]
    selected_index = next(
        (index for index, item in enumerate(action_items) if item.get("id") == item_id),
        None,
    )
    if selected_index is None:
        raise HttpError(404, "meeting action item not found")
    item = action_items[selected_index]
    task_service = ProjectTaskService(user=request.auth)
    existing_task_id = item.get("task_id")
    if existing_task_id:
        try:
            task = task_service.get_task(
                project_id=session.project_id,
                task_id=UUID(str(existing_task_id)),
            )
        except (ServiceError, ValueError):
            item["task_id"] = None
        else:
            return {"task": task, "action_item": item, "created": False}

    candidate_user_ids: list[UUID] = []
    for value in (
        item.get("responsible_user_id"),
        session.created_by_id,
        request.auth.id,
    ):
        try:
            candidate = value if isinstance(value, UUID) else UUID(str(value))
        except (TypeError, ValueError):
            continue
        if candidate not in candidate_user_ids:
            candidate_user_ids.append(candidate)
    active_memberships = {
        membership.user_id: membership
        for membership in ProjectMembership.objects.filter(
            project_id=session.project_id,
            user_id__in=candidate_user_ids,
            is_active=True,
            status=ProjectMembership.Status.ACTIVE,
        ).select_related("user")
    }
    responsible_user_id = next(
        (candidate for candidate in candidate_user_ids if candidate in active_memberships),
        None,
    )
    if responsible_user_id is None:
        responsible_user_id = (
            ProjectMembership.objects.filter(
                project_id=session.project_id,
                is_active=True,
                status=ProjectMembership.Status.ACTIVE,
            )
            .order_by("joined_at", "id")
            .values_list("user_id", flat=True)
            .first()
        )
    if responsible_user_id is None:
        raise HttpError(409, "meeting Project has no active member for the task")

    evidence = ", ".join(str(value) for value in item.get("evidence_segment_ids") or [])
    description_parts = [str(item.get("description") or "").strip()]
    if evidence:
        description_parts.append(f"Meeting evidence segments: {evidence}")
    due_date = str(item.get("due_date") or "").strip()
    if due_date:
        description_parts.append(f"Meeting due date: {due_date}")
    try:
        task = task_service.create_task(
            project_id=session.project_id,
            title=str(item.get("title") or item.get("text") or "Meeting action item")[:200],
            description="\n\n".join(part for part in description_parts if part),
            priority=str(item.get("priority") or "medium"),
            responsible_user_id=responsible_user_id,
        )
    except ServiceError as exc:
        raise HttpError(exc.status, exc.message) from exc

    task_id = str(task["id"])
    item["task_id"] = task_id
    action_items[selected_index] = item
    analysis.action_items = action_items
    analysis.save(update_fields=["action_items", "updated_at"])
    task_model = ProjectTask.objects.select_related("project").get(id=task_id)
    reference, _ = MeetingReference.objects.get_or_create(
        session=session,
        reference_type=MeetingReference.ReferenceType.TASK,
        resource_id=task_model.id,
        defaults={
            "title_snapshot": task_model.title,
            "metadata": {
                "organization_id": str(session.organization_id),
                "project_id": str(task_model.project_id),
                "work_status": task_model.work_status,
            },
            "created_by": request.auth,
        },
    )
    return {
        "task": task,
        "action_item": item,
        "reference": serialize_meeting_reference(reference),
        "created": True,
    }


@router.get("/sessions/{session_id}/tracks/{source}/audio", auth=jwt_auth)
def get_meeting_track_audio(
    request,
    session_id: UUID,
    source: str,
    expiration: int = 3600,
):
    session = _accessible_session(request, session_id)
    if source not in MeetingTrack.Source.values:
        raise HttpError(404, "meeting track not found")
    track = MeetingTrack.objects.select_related("file_record").filter(
        session=session,
        source=source,
    ).first()
    if (
        track is None
        or track.file_record is None
        or track.storage_status != MeetingTrack.StorageStatus.SYNCED
        or track.file_record.status != "completed"
    ):
        raise HttpError(404, "meeting audio not found")
    if not FileUsage.objects.filter(
        file_record=track.file_record,
        module=MEETING_FILE_USAGE_MODULE,
        context_type=MEETING_TRACK_CONTEXT_TYPE,
        context_id=meeting_track_context_id(session.id, source),
        is_active=True,
    ).exists():
        raise HttpError(404, "meeting audio not found")
    accessible = resolve_authorized_file(
        track.file_record,
        expiration=max(60, min(expiration, 21_600)),
    )
    return {
        "track": _serialize_track(track),
        "url": accessible.url,
        "access_mode": accessible.access_mode,
        "expires_at": accessible.expires_at,
        "expires_in": accessible.expires_in,
    }


@router.get("/sessions/{session_id}/permissions", auth=jwt_auth)
def get_meeting_permissions(request, session_id: UUID):
    session = _accessible_session(request, session_id, required_role="admin")
    permissions = session.permissions.filter(is_active=True).order_by("created_at")
    return {
        "owner_id": str(session.created_by_id),
        "permissions": [_serialize_permission(permission) for permission in permissions],
    }


@router.post("/sessions/{session_id}/permissions", auth=jwt_auth)
@transaction.atomic
def grant_meeting_permission(
    request,
    session_id: UUID,
    data: MeetingPermissionIn,
):
    session = _accessible_session(
        request,
        session_id,
        required_role="admin",
        for_update=True,
    )
    subject_type = data.subject_type.strip()
    subject_id = data.subject_id.strip()
    if subject_type not in {"user", "role"} or not subject_id:
        raise HttpError(422, "meeting permissions support user or role subjects")
    valid_permissions = {"viewer", "editor", "admin"}
    if data.permission not in valid_permissions:
        raise HttpError(422, "invalid meeting permission")
    if subject_type == "user":
        if subject_id == str(session.created_by_id):
            raise HttpError(422, "meeting creator is already the owner")
        is_member = (
            str(session.organization.owner_id) == subject_id
            or OrganizationMember.objects.filter(
                organization_id=session.organization_id,
                user_id=subject_id,
            ).exists()
        )
        if not is_member:
            raise HttpError(422, "permission subject is not an organization member")
    elif subject_id not in {choice[0] for choice in OrganizationMember.ROLE_CHOICES}:
        raise HttpError(422, "invalid organization role subject")

    permission, _ = MeetingPermission.objects.update_or_create(
        session=session,
        subject_type=subject_type,
        subject_id=subject_id,
        defaults={
            "permission": data.permission,
            "is_active": True,
            "granted_by": str(request.auth.id),
        },
    )
    return _serialize_permission(permission)


@router.delete(
    "/sessions/{session_id}/permissions/{permission_id}",
    auth=jwt_auth,
)
@transaction.atomic
def revoke_meeting_permission(
    request,
    session_id: UUID,
    permission_id: UUID,
):
    session = _accessible_session(
        request,
        session_id,
        required_role="admin",
        for_update=True,
    )
    permission = MeetingPermission.objects.select_for_update().filter(
        id=permission_id,
        session=session,
        is_active=True,
    ).first()
    if permission is None:
        raise HttpError(404, "meeting permission not found")
    permission.is_active = False
    permission.save(update_fields=["is_active", "updated_at"])
    return {"revoked": True, "permission_id": str(permission.id)}


@router.delete("/sessions/{session_id}/audio", auth=jwt_auth)
@transaction.atomic
def delete_meeting_audio(request, session_id: UUID):
    session = _accessible_session(
        request,
        session_id,
        required_role="admin",
        for_update=True,
    )
    deactivated = deactivate_meeting_audio_usages(
        session,
        actor_user_id=str(request.auth.id),
        biz_type="meeting_audio_delete",
    )
    updated = MeetingTrack.objects.filter(session=session).exclude(
        storage_status=MeetingTrack.StorageStatus.DELETED,
    ).update(
        file_record=None,
        storage_status=MeetingTrack.StorageStatus.DELETED,
        local_available=False,
        file_size=0,
        content_hash="",
        updated_at=timezone.now(),
    )
    return {
        "session_id": str(session.id),
        "deleted_audio_tracks": updated,
        "deactivated_file_usages": deactivated,
    }


@router.delete("/sessions/{session_id}", auth=jwt_auth)
@transaction.atomic
def delete_meeting_session(request, session_id: UUID):
    session = _accessible_session(
        request,
        session_id,
        required_role="admin",
        for_update=True,
    )
    deactivated = deactivate_meeting_audio_usages(
        session,
        actor_user_id=str(request.auth.id),
        biz_type="meeting_session_delete",
    )
    deleted_session_id = str(session.id)
    session.delete()
    return {
        "deleted": True,
        "session_id": deleted_session_id,
        "deactivated_file_usages": deactivated,
    }


@router.patch("/sessions/{session_id}/lifecycle", auth=jwt_auth)
@transaction.atomic
def update_meeting_lifecycle(request, session_id: UUID, data: MeetingLifecycleIn):
    if data.status not in MeetingSession.LifecycleStatus.values:
        raise HttpError(422, "invalid lifecycle status")
    if data.duration_ms < 0:
        raise HttpError(422, "duration_ms must not be negative")

    session = _owned_session(request, session_id, for_update=True)
    if session.version != data.expected_version:
        raise HttpError(409, "meeting session version conflict")
    if not is_lifecycle_transition_allowed(session.lifecycle_status, data.status):
        raise HttpError(409, "invalid meeting lifecycle transition")
    if data.status == MeetingSession.LifecycleStatus.RECORDING and session.consent_confirmed_at is None:
        raise HttpError(409, "recording consent is required")

    now = timezone.now()
    if data.status == MeetingSession.LifecycleStatus.RECORDING and session.started_at is None:
        session.started_at = now
    if data.status in {
        MeetingSession.LifecycleStatus.STOPPED,
        MeetingSession.LifecycleStatus.CANCELLED,
    }:
        session.ended_at = now
        session.copilot_enabled = False
    session.lifecycle_status = data.status
    session.duration_ms = max(session.duration_ms, data.duration_ms)
    session.version += 1
    session.save()
    return _serialize_session(session)


@router.patch("/sessions/{session_id}/copilot", auth=jwt_auth)
@transaction.atomic
def update_meeting_copilot(request, session_id: UUID, data: MeetingCopilotStateIn):
    session = _owned_session(request, session_id, for_update=True)
    if session.version != data.expected_version:
        raise HttpError(409, "meeting session version conflict")
    if session.lifecycle_status not in {
        MeetingSession.LifecycleStatus.PREPARING,
        MeetingSession.LifecycleStatus.RECORDING,
    }:
        raise HttpError(409, "Copilot cannot be changed in the current meeting state")
    session.copilot_enabled = data.enabled
    session.version += 1
    session.save(update_fields=["copilot_enabled", "version", "updated_at"])
    return _serialize_session(session)


@router.post("/sessions/{session_id}/copilot/answer", auth=jwt_auth)
def answer_meeting_copilot(request, session_id: UUID, data: MeetingCopilotAnswerIn):
    """Answer the latest remote question without touching recording state."""
    session = _owned_session(request, session_id)
    request_id = data.request_id
    if request_id is not None:
        existing = MeetingCopilotAnswer.objects.filter(
            request_id=request_id,
            session=session,
        ).first()
        if existing is not None:
            if existing.result_snapshot:
                return existing.result_snapshot
            return {
                "status": "pending",
                "message": "会议 Copilot 正在生成同一问题的答案",
                "request_id": str(request_id),
            }
    if not session.copilot_enabled:
        return {
            "status": "disabled",
            "message": "会议 Copilot 当前已关闭",
        }
    if session.lifecycle_status != MeetingSession.LifecycleStatus.RECORDING:
        return {
            "status": "unavailable",
            "message": "会议不在记录中，暂时无法生成建议答案",
        }

    reservation = None
    if request_id is not None:
        try:
            reservation = MeetingCopilotAnswer.objects.create(
                session=session,
                request_id=request_id,
                question_segment_id=data.question_segment_id[:128],
                status=MeetingCopilotAnswer.Status.PENDING,
            )
        except IntegrityError:
            existing = MeetingCopilotAnswer.objects.filter(
                request_id=request_id,
                session=session,
            ).first()
            if existing is not None and existing.result_snapshot:
                return existing.result_snapshot
            return {
                "status": "pending",
                "message": "会议 Copilot 正在生成同一问题的答案",
                "request_id": str(request_id),
            }

    from .copilot import MeetingCopilotError, generate_meeting_copilot_answer

    try:
        result = generate_meeting_copilot_answer(
            session=session,
            user=request.auth,
            selected_model_id=str(data.model_id) if data.model_id else None,
            question_segment_id=data.question_segment_id,
            recent_segments=[segment.dict() for segment in data.recent_segments],
        )
        if reservation is not None and result.get("status") in {
            MeetingCopilotAnswer.Status.ANSWERED,
            MeetingCopilotAnswer.Status.NO_ACTION,
        }:
            reservation.question_text = str(result.get("question") or "")
            reservation.status = result["status"]
            reservation.result_snapshot = result
            reservation.model = str(result.get("model") or "")[:128]
            reservation.provider = str(result.get("provider") or "")[:64]
            reservation.latency_ms = max(int(result.get("latency_ms") or 0), 0)
            reservation.save(update_fields=[
                "question_text",
                "status",
                "result_snapshot",
                "model",
                "provider",
                "latency_ms",
            ])
        elif reservation is not None:
            reservation.delete()
        return result
    except MeetingCopilotError as exc:
        if reservation is not None:
            reservation.delete()
        return {
            "status": "failed",
            "error_code": exc.code,
            "message": str(exc),
        }
    except Exception as exc:
        if reservation is not None:
            reservation.delete()
        logger.exception(
            "Meeting Copilot quick answer failed session=%s error=%s",
            session_id,
            type(exc).__name__,
        )
        return {
            "status": "failed",
            "error_code": "model_request_failed",
            "message": "会议 Copilot 暂时不可用，录音与转写会继续运行",
        }


@router.get("/sessions/{session_id}/copilot-answers", auth=jwt_auth)
def get_meeting_copilot_answers(request, session_id: UUID):
    session = _accessible_session(request, session_id)
    answers = MeetingCopilotAnswer.objects.filter(
        session=session,
        status__in=[
            MeetingCopilotAnswer.Status.ANSWERED,
            MeetingCopilotAnswer.Status.NO_ACTION,
        ],
    )
    return {"answers": [_serialize_copilot_answer(answer) for answer in answers]}


@router.put("/sessions/{session_id}/tracks/{source}", auth=jwt_auth)
@transaction.atomic
def upsert_meeting_track(request, session_id: UUID, source: str, data: MeetingTrackIn):
    session = _owned_session(request, session_id, for_update=True)
    if source not in MeetingTrack.Source.values or data.source != source:
        raise HttpError(422, "invalid or mismatched track source")
    if data.capture_status not in MeetingTrack.CaptureStatus.values:
        raise HttpError(422, "invalid capture_status")
    if data.storage_status not in MeetingTrack.StorageStatus.values:
        raise HttpError(422, "invalid storage_status")
    if min(data.sample_rate, data.channel_count, data.duration_ms, data.file_size) < 0:
        raise HttpError(422, "track numeric values must not be negative")
    if data.storage_status == MeetingTrack.StorageStatus.SYNCED and data.file_record_id is None:
        raise HttpError(422, "synced meeting track requires file_record_id")
    if data.file_record_id is not None and data.storage_status != MeetingTrack.StorageStatus.SYNCED:
        raise HttpError(422, "meeting track with file_record_id must be synced")
    file_record = _validate_meeting_track_file_binding(
        session=session,
        source=source,
        file_record_id=data.file_record_id,
        user_id=request.auth.id,
    )

    track, _ = MeetingTrack.objects.update_or_create(
        session=session,
        source=source,
        defaults={
            "capture_status": data.capture_status,
            "storage_status": data.storage_status,
            "local_available": data.local_available,
            "device_id": data.device_id[:255],
            "device_label": data.device_label[:255],
            "sample_rate": data.sample_rate,
            "channel_count": data.channel_count,
            "codec": data.codec[:32],
            "container": data.container[:32],
            "duration_ms": data.duration_ms,
            "file_size": data.file_size,
            "content_hash": data.content_hash[:64],
            "file_record": file_record,
            "last_checkpoint_at": timezone.now(),
            "error_code": data.error_code[:64],
            "error_message": data.error_message,
        },
    )
    return _serialize_track(track)


@router.post("/sessions/{session_id}/transcript-runs", auth=jwt_auth)
def create_transcript_run(request, session_id: UUID, data: CreateTranscriptRunIn):
    session = _owned_session(request, session_id)
    if data.mode not in MeetingTranscriptRun.Mode.values:
        raise HttpError(422, "invalid transcript mode")
    track = None
    if data.track_id is not None:
        track = MeetingTrack.objects.filter(id=data.track_id, session=session).first()
        if track is None:
            raise HttpError(422, "track does not belong to meeting session")
    run, created = MeetingTranscriptRun.objects.get_or_create(
        id=data.id,
        defaults={
            "session": session,
            "track": track,
            "mode": data.mode,
            "status": MeetingTranscriptRun.Status.RUNNING,
            "provider": data.provider[:64],
            "model": data.model[:128],
            "language": data.language[:32],
            "metadata": data.metadata,
            "started_at": timezone.now(),
        },
    )
    if not created and (run.session_id != session.id or run.track_id != data.track_id):
        raise HttpError(409, "transcript run id is already in use")
    return {"id": str(run.id), "status": run.status, "created": created}


@router.put(
    "/sessions/{session_id}/transcript-runs/{run_id}/segments",
    auth=jwt_auth,
)
@transaction.atomic
def upsert_transcript_segments(
    request,
    session_id: UUID,
    run_id: UUID,
    data: TranscriptSegmentBatchIn,
):
    session = _owned_session(request, session_id)
    run = MeetingTranscriptRun.objects.select_for_update().filter(
        id=run_id,
        session=session,
    ).first()
    if run is None:
        raise HttpError(404, "transcript run not found")
    if len(data.segments) > MAX_TRANSCRIPT_SEGMENTS_PER_BATCH:
        raise HttpError(422, "too many transcript segments")

    upserted = 0
    for item in data.segments:
        if not item.external_id or len(item.external_id) > 128:
            raise HttpError(422, "invalid transcript segment external_id")
        if item.source not in MeetingTrack.Source.values:
            raise HttpError(422, "invalid transcript segment source")
        if item.start_ms < 0 or item.end_ms < item.start_ms:
            raise HttpError(422, "invalid transcript segment time range")
        track = None
        if item.track_id is not None:
            track = MeetingTrack.objects.filter(id=item.track_id, session=session).first()
            if track is None or track.source != item.source:
                raise HttpError(422, "transcript track does not match source")

        existing = MeetingTranscriptSegment.objects.filter(
            run=run,
            external_id=item.external_id,
        ).first()
        if existing is not None and existing.is_final:
            if not item.is_final or existing.raw_text != item.raw_text:
                raise HttpError(409, "final transcript segment cannot be overwritten")
            continue

        MeetingTranscriptSegment.objects.update_or_create(
            run=run,
            external_id=item.external_id,
            defaults={
                "session": session,
                "track": track,
                "source": item.source,
                "speaker_key": item.speaker_key[:128],
                "start_ms": item.start_ms,
                "end_ms": item.end_ms,
                "raw_text": item.raw_text,
                "is_final": item.is_final,
                "confidence": item.confidence,
                "metadata": item.metadata,
            },
        )
        upserted += 1
    if upserted:
        MeetingSession.objects.filter(id=session.id).update(
            transcript_revision=F("transcript_revision") + 1,
        )
        session.refresh_from_db(fields=["transcript_revision"])
    return {
        "upserted": upserted,
        "transcript_revision": session.transcript_revision,
    }


@router.patch(
    "/sessions/{session_id}/transcript-runs/{run_id}",
    auth=jwt_auth,
)
def update_transcript_run(
    request,
    session_id: UUID,
    run_id: UUID,
    data: TranscriptRunStateIn,
):
    session = _owned_session(request, session_id)
    if data.status not in MeetingTranscriptRun.Status.values:
        raise HttpError(422, "invalid transcript run status")
    run = MeetingTranscriptRun.objects.filter(id=run_id, session=session).first()
    if run is None:
        raise HttpError(404, "transcript run not found")
    run.status = data.status
    run.error_code = data.error_code[:64]
    run.error_message = data.error_message
    if data.status in {
        MeetingTranscriptRun.Status.COMPLETED,
        MeetingTranscriptRun.Status.PARTIAL,
        MeetingTranscriptRun.Status.FAILED,
    }:
        run.completed_at = timezone.now()
    run.save()
    return {"id": str(run.id), "status": run.status}
