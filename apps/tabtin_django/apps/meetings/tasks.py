from __future__ import annotations

import logging

from celery import shared_task
from django.contrib.auth import get_user_model
from django.db import transaction
from django.utils import timezone

from .models import MeetingAnalysis, MeetingSession
from .services import generate_meeting_analysis

logger = logging.getLogger(__name__)

MEETING_ANALYSIS_SOFT_TIME_LIMIT_SECONDS = 165
MEETING_ANALYSIS_TIME_LIMIT_SECONDS = 180
# Hard-killed workers cannot run cleanup. Give the hard limit a two-minute
# scheduling/termination buffer before a new POST may reclaim the analysis.
MEETING_ANALYSIS_LEASE_SECONDS = 300


@shared_task(
    name="meetings.run_post_analysis",
    ignore_result=True,
    time_limit=MEETING_ANALYSIS_TIME_LIMIT_SECONDS,
    soft_time_limit=MEETING_ANALYSIS_SOFT_TIME_LIMIT_SECONDS,
)
def run_meeting_analysis_task(
    analysis_id: str,
    expected_transcript_revision: int,
) -> None:
    with transaction.atomic():
        analysis = (
            MeetingAnalysis.objects.select_for_update()
            .select_related("session")
            .filter(id=analysis_id)
            .first()
        )
        if (
            analysis is None
            or analysis.status != MeetingAnalysis.Status.PENDING
            or analysis.source_transcript_revision != expected_transcript_revision
        ):
            return
        analysis.status = MeetingAnalysis.Status.RUNNING
        lease_started_at = timezone.now()
        analysis.started_at = lease_started_at
        analysis.completed_at = None
        analysis.error_code = ""
        analysis.error_message = ""
        analysis.save(update_fields=[
            "status",
            "started_at",
            "completed_at",
            "error_code",
            "error_message",
            "updated_at",
        ])

    actor = analysis.requested_by
    if actor is None:
        actor = get_user_model().objects.filter(id=analysis.session.created_by_id).first()
    if actor is None:
        MeetingAnalysis.objects.filter(
            id=analysis_id,
            status=MeetingAnalysis.Status.RUNNING,
            started_at=lease_started_at,
        ).update(
            status=MeetingAnalysis.Status.FAILED,
            error_code="analysis_actor_missing",
            error_message="meeting analysis requester is unavailable",
            completed_at=timezone.now(),
            updated_at=timezone.now(),
        )
        return

    try:
        parsed, telemetry, complete_shape = generate_meeting_analysis(
            analysis=analysis,
            user=actor,
        )
        current_revision = (
            MeetingSession.objects.filter(id=analysis.session_id)
            .values_list("transcript_revision", flat=True)
            .first()
        )
        transcript_changed = current_revision != expected_transcript_revision
        status = (
            MeetingAnalysis.Status.COMPLETED
            if complete_shape and not transcript_changed
            else MeetingAnalysis.Status.PARTIAL
        )
        error_code = "transcript_changed" if transcript_changed else ""
        error_message = (
            "transcript changed while analysis was running; rerun to include the latest revision"
            if transcript_changed
            else ""
        )
        MeetingAnalysis.objects.filter(
            id=analysis_id,
            status=MeetingAnalysis.Status.RUNNING,
            source_transcript_revision=expected_transcript_revision,
            started_at=lease_started_at,
        ).update(
            status=status,
            summary=parsed["summary"],
            topics=parsed["topics"],
            decisions=parsed["decisions"],
            action_items=parsed["action_items"],
            open_questions=parsed["open_questions"],
            risks=parsed["risks"],
            provider=telemetry["provider"],
            model=telemetry["model"],
            error_code=error_code,
            error_message=error_message,
            completed_at=timezone.now(),
            updated_at=timezone.now(),
        )
    except Exception as exc:
        logger.exception(
            "Meeting post-analysis failed: analysis=%s session=%s",
            analysis_id,
            analysis.session_id,
        )
        MeetingAnalysis.objects.filter(
            id=analysis_id,
            status=MeetingAnalysis.Status.RUNNING,
            started_at=lease_started_at,
        ).update(
            status=MeetingAnalysis.Status.FAILED,
            error_code="analysis_failed",
            error_message=str(exc)[:2000],
            completed_at=timezone.now(),
            updated_at=timezone.now(),
        )


__all__ = [
    "MEETING_ANALYSIS_LEASE_SECONDS",
    "MEETING_ANALYSIS_SOFT_TIME_LIMIT_SECONDS",
    "MEETING_ANALYSIS_TIME_LIMIT_SECONDS",
    "run_meeting_analysis_task",
]
