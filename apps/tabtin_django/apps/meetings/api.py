import logging
from typing import Optional
from uuid import UUID

from django.db import transaction
from django.utils import timezone
from ninja import Router, Schema
from ninja.errors import HttpError

from apps.tabtinspace.models import Organization, OrganizationMember, Project
from apps.tabtinspace.services.space_visibility import user_can_access_space
from apps.users.auth.api import jwt_auth

from .models import (
    MeetingSession,
    MeetingTrack,
    MeetingTranscriptRun,
    MeetingTranscriptSegment,
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
        MeetingSession.LifecycleStatus.PAUSED,
        MeetingSession.LifecycleStatus.STOPPED,
        MeetingSession.LifecycleStatus.INTERRUPTED,
    },
    MeetingSession.LifecycleStatus.PAUSED: {
        MeetingSession.LifecycleStatus.RECORDING,
        MeetingSession.LifecycleStatus.STOPPED,
        MeetingSession.LifecycleStatus.INTERRUPTED,
    },
    MeetingSession.LifecycleStatus.INTERRUPTED: {
        MeetingSession.LifecycleStatus.RECORDING,
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
    question_segment_id: str
    model_id: Optional[UUID] = None
    recent_segments: list[MeetingCopilotTranscriptSegmentIn] = []


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
    queryset = MeetingSession.objects
    if for_update:
        queryset = queryset.select_for_update()
    else:
        queryset = queryset.select_related("project")
    session = queryset.filter(id=session_id, created_by_id=request.auth.id).first()
    if session is None:
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
        "audio_sync_policy": session.audio_sync_policy,
        "copilot_initially_enabled": session.copilot_initially_enabled,
        "copilot_enabled": session.copilot_enabled,
        "consent_confirmed_at": session.consent_confirmed_at,
        "started_at": session.started_at,
        "ended_at": session.ended_at,
        "duration_ms": session.duration_ms,
        "version": session.version,
        "created_at": session.created_at,
        "updated_at": session.updated_at,
    }
    if include_tracks:
        result["tracks"] = [_serialize_track(track) for track in session.tracks.all()]
    return result


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
):
    _require_organization_access(request, organization_id)
    queryset = MeetingSession.objects.filter(
        organization_id=organization_id,
        created_by_id=request.auth.id,
    ).select_related("project")
    if project_id is not None:
        queryset = queryset.filter(project_id=project_id)
    if lifecycle_status:
        if lifecycle_status not in MeetingSession.LifecycleStatus.values:
            raise HttpError(422, "invalid lifecycle_status")
        queryset = queryset.filter(lifecycle_status=lifecycle_status)
    rows = list(queryset[:200])
    return {"sessions": [_serialize_session(row, include_tracks=False) for row in rows]}


@router.get("/sessions/{session_id}", auth=jwt_auth)
def get_meeting_session(request, session_id: UUID):
    session = _owned_session(request, session_id)
    return _serialize_session(session)


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
        MeetingSession.LifecycleStatus.PAUSED,
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
    if not session.copilot_enabled:
        return {
            "status": "disabled",
            "message": "会议 Copilot 当前已关闭",
        }
    if session.lifecycle_status not in {
        MeetingSession.LifecycleStatus.RECORDING,
        MeetingSession.LifecycleStatus.PAUSED,
    }:
        return {
            "status": "unavailable",
            "message": "会议不在记录中，暂时无法生成建议答案",
        }

    from .copilot import MeetingCopilotError, generate_meeting_copilot_answer

    try:
        return generate_meeting_copilot_answer(
            session=session,
            user=request.auth,
            selected_model_id=str(data.model_id) if data.model_id else None,
            question_segment_id=data.question_segment_id,
            recent_segments=[segment.dict() for segment in data.recent_segments],
        )
    except MeetingCopilotError as exc:
        return {
            "status": "failed",
            "error_code": exc.code,
            "message": str(exc),
        }
    except Exception as exc:
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
            "file_record_id": data.file_record_id,
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
    return {"upserted": upserted}


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
