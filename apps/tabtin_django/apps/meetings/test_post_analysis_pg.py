import json
import uuid
from datetime import date, timedelta
from types import SimpleNamespace
from unittest.mock import patch
from uuid import UUID

from django.contrib.auth import get_user_model
from django.test import TestCase
from django.utils import timezone

from apps.tabtinspace.models import (
    Organization,
    OrganizationMember,
    Project,
    ProjectMembership,
    ProjectTask,
)
from apps.tabtinspace.services.project_task_service import ProjectTaskService

from .api import (
    CreateMeetingSessionIn,
    MeetingReferenceIn,
    TranscriptSegmentBatchIn,
    TranscriptSegmentIn,
    add_meeting_reference,
    create_meeting_session,
    create_task_from_meeting_action_item,
    export_meeting_session,
    get_meeting_analysis,
    list_meeting_sessions,
    request_meeting_analysis,
    upsert_transcript_segments,
)
from .models import (
    MeetingAnalysis,
    MeetingPermission,
    MeetingReference,
    MeetingSession,
    MeetingTranscriptRun,
    MeetingTranscriptSegment,
)
from .services import parse_meeting_analysis_result, resolve_meeting_reference
from .tasks import MEETING_ANALYSIS_LEASE_SECONDS, run_meeting_analysis_task


class MeetingAnalysisNormalizationTests(TestCase):
    databases = {"default", "postgresql"}

    def test_items_get_stable_ids_and_only_real_evidence_survives(self):
        raw = json.dumps({
            "summary": "Architecture was approved.",
            "topics": [{
                "title": "Architecture",
                "summary": "Reviewed boundaries",
                "evidence_segment_ids": ["segment-1", "invented"],
            }],
            "decisions": [{"text": "Use the existing service", "evidence_segment_ids": ["segment-1"]}],
            "action_items": [{
                "title": "Add tests",
                "description": "Cover the service boundary",
                "priority": "HIGH",
                "evidence_segment_ids": ["segment-2"],
            }],
            "open_questions": [],
            "risks": [],
        })
        first, complete = parse_meeting_analysis_result(
            raw,
            allowed_evidence_ids={"segment-1", "segment-2"},
        )
        second, _ = parse_meeting_analysis_result(
            raw,
            allowed_evidence_ids={"segment-1", "segment-2"},
        )

        self.assertTrue(complete)
        self.assertEqual(first["topics"][0]["id"], second["topics"][0]["id"])
        self.assertEqual(first["topics"][0]["evidence_segment_ids"], ["segment-1"])
        self.assertEqual(first["action_items"][0]["priority"], "high")


class MeetingPostAnalysisPostgresTests(TestCase):
    databases = {"default", "postgresql"}

    def setUp(self):
        user_model = get_user_model()
        self.owner = user_model.objects.create_user(email="meeting-analysis-owner@example.com")
        self.viewer = user_model.objects.create_user(email="meeting-analysis-viewer@example.com")
        self.organization = Organization.objects.create(
            name="Meeting Analysis Organization",
            owner=self.owner,
            type=Organization.OrganizationType.TEAM,
        )
        OrganizationMember.objects.create(
            organization=self.organization,
            user=self.viewer,
            role="viewer",
        )
        self.project = Project.objects.create(
            organization=self.organization,
            name="Meeting Analysis Project",
        )
        for user, role in ((self.owner, "owner"), (self.viewer, "editor")):
            ProjectMembership.objects.create(
                project=self.project,
                user=user,
                role=role,
                is_active=True,
                status=ProjectMembership.Status.ACTIVE,
            )
        self.session_id = uuid.uuid4()
        create_meeting_session(
            self.request(self.owner),
            CreateMeetingSessionIn(
                id=self.session_id,
                organization_id=self.organization.id,
                project_id=self.project.id,
                title="Architecture review",
                brief="Confirm the delivery boundary",
                consent_confirmed=True,
            ),
        )
        self.session = MeetingSession.objects.get(id=self.session_id)
        self.session.lifecycle_status = MeetingSession.LifecycleStatus.STOPPED
        self.session.transcript_revision = 1
        self.session.save(update_fields=["lifecycle_status", "transcript_revision"])
        self.run = MeetingTranscriptRun.objects.create(
            session=self.session,
            mode=MeetingTranscriptRun.Mode.REALTIME,
            status=MeetingTranscriptRun.Status.COMPLETED,
        )
        MeetingTranscriptSegment.objects.create(
            session=self.session,
            run=self.run,
            external_id="segment-1",
            source="remote",
            start_ms=0,
            end_ms=1000,
            raw_text="Should we reuse the existing task service?",
            is_final=True,
        )
        MeetingTranscriptSegment.objects.create(
            session=self.session,
            run=self.run,
            external_id="segment-2",
            source="local",
            start_ms=1100,
            end_ms=2000,
            raw_text="Yes, and add focused tests.",
            is_final=True,
        )

    @staticmethod
    def request(user):
        return SimpleNamespace(auth=user, headers={}, META={})

    def grant(self, permission="viewer"):
        return MeetingPermission.objects.create(
            session=self.session,
            subject_type="user",
            subject_id=str(self.viewer.id),
            permission=permission,
            granted_by=str(self.owner.id),
        )

    def test_transcript_write_advances_server_revision_once_per_changed_batch(self):
        result = upsert_transcript_segments(
            self.request(self.owner),
            self.session_id,
            self.run.id,
            TranscriptSegmentBatchIn(segments=[TranscriptSegmentIn(
                external_id="segment-3",
                source="remote",
                start_ms=2100,
                end_ms=2500,
                raw_text="What is next?",
                is_final=True,
            )]),
        )
        self.session.refresh_from_db()
        self.assertEqual(result["transcript_revision"], 2)
        self.assertEqual(self.session.transcript_revision, 2)

    @patch("apps.meetings.tasks.run_meeting_analysis_task.delay")
    @patch("apps.meetings.api.transaction.on_commit")
    def test_editor_triggers_background_analysis_and_viewer_reads_status(
        self,
        on_commit,
        delay,
    ):
        self.grant("editor")
        on_commit.side_effect = lambda callback: callback()

        payload = request_meeting_analysis(self.request(self.viewer), self.session_id)
        readable = get_meeting_analysis(self.request(self.viewer), self.session_id)

        self.assertEqual(payload["status"], "pending")
        self.assertEqual(readable["source_transcript_revision"], 1)
        delay.assert_called_once_with(payload["id"], 1)

    @patch("apps.meetings.tasks.run_meeting_analysis_task.delay")
    @patch("apps.meetings.api.transaction.on_commit")
    def test_active_running_analysis_keeps_its_lease_without_requeue(
        self,
        on_commit,
        delay,
    ):
        self.grant("editor")
        analysis = MeetingAnalysis.objects.create(
            session=self.session,
            status=MeetingAnalysis.Status.RUNNING,
            source_transcript_revision=1,
            requested_by=self.viewer,
            started_at=timezone.now(),
        )

        payload = request_meeting_analysis(self.request(self.viewer), self.session_id)

        self.assertEqual(payload["status"], "running")
        analysis.refresh_from_db()
        self.assertEqual(analysis.status, MeetingAnalysis.Status.RUNNING)
        on_commit.assert_not_called()
        delay.assert_not_called()

    @patch("apps.meetings.tasks.run_meeting_analysis_task.delay")
    @patch("apps.meetings.api.transaction.on_commit")
    def test_stale_running_analysis_is_atomically_requeued(
        self,
        on_commit,
        delay,
    ):
        self.grant("editor")
        stale_started_at = timezone.now() - timedelta(
            seconds=MEETING_ANALYSIS_LEASE_SECONDS + 1,
        )
        analysis = MeetingAnalysis.objects.create(
            session=self.session,
            status=MeetingAnalysis.Status.RUNNING,
            source_transcript_revision=0,
            requested_by=self.owner,
            started_at=stale_started_at,
        )
        on_commit.side_effect = lambda callback: callback()

        payload = request_meeting_analysis(self.request(self.viewer), self.session_id)

        analysis.refresh_from_db()
        self.assertEqual(payload["status"], "pending")
        self.assertEqual(analysis.status, MeetingAnalysis.Status.PENDING)
        self.assertIsNone(analysis.started_at)
        self.assertEqual(analysis.source_transcript_revision, 1)
        self.assertEqual(analysis.requested_by_id, self.viewer.id)
        delay.assert_called_once_with(str(analysis.id), 1)

    @patch("apps.meetings.tasks.generate_meeting_analysis")
    def test_background_analysis_completes_without_mutating_recording_facts(self, generate):
        analysis = MeetingAnalysis.objects.create(
            session=self.session,
            status=MeetingAnalysis.Status.PENDING,
            source_transcript_revision=1,
            requested_by=self.owner,
        )
        generate.return_value = (
            {
                "summary": "The team approved reuse.",
                "topics": [],
                "decisions": [{
                    "id": "decision-1",
                    "text": "Reuse ProjectTaskService",
                    "evidence_segment_ids": ["segment-1", "segment-2"],
                }],
                "action_items": [],
                "open_questions": [],
                "risks": [],
            },
            {"provider": "provider-a", "model": "model-a"},
            True,
        )

        run_meeting_analysis_task.run(str(analysis.id), 1)

        analysis.refresh_from_db()
        self.session.refresh_from_db()
        self.assertEqual(analysis.status, MeetingAnalysis.Status.COMPLETED)
        self.assertEqual(analysis.provider, "provider-a")
        self.assertEqual(self.session.lifecycle_status, MeetingSession.LifecycleStatus.STOPPED)
        self.assertTrue(MeetingTranscriptSegment.objects.filter(session=self.session).exists())

    @patch("apps.meetings.tasks.generate_meeting_analysis", side_effect=RuntimeError("provider down"))
    def test_background_analysis_failure_only_marks_analysis_failed(self, _generate):
        analysis = MeetingAnalysis.objects.create(
            session=self.session,
            status=MeetingAnalysis.Status.PENDING,
            source_transcript_revision=1,
            requested_by=self.owner,
        )

        run_meeting_analysis_task.run(str(analysis.id), 1)

        analysis.refresh_from_db()
        self.session.refresh_from_db()
        self.assertEqual(analysis.status, MeetingAnalysis.Status.FAILED)
        self.assertEqual(analysis.error_code, "analysis_failed")
        self.assertEqual(self.session.lifecycle_status, MeetingSession.LifecycleStatus.STOPPED)
        self.assertEqual(MeetingTranscriptSegment.objects.filter(session=self.session).count(), 2)

    @patch("apps.meetings.tasks.generate_meeting_analysis")
    def test_expired_worker_cannot_overwrite_a_newer_running_lease(self, generate):
        analysis = MeetingAnalysis.objects.create(
            session=self.session,
            status=MeetingAnalysis.Status.PENDING,
            source_transcript_revision=1,
            requested_by=self.owner,
        )
        newer_started_at = timezone.now() + timedelta(seconds=1)

        def finish_old_attempt(**_kwargs):
            MeetingAnalysis.objects.filter(id=analysis.id).update(
                status=MeetingAnalysis.Status.RUNNING,
                started_at=newer_started_at,
            )
            return (
                {
                    "summary": "stale result",
                    "topics": [],
                    "decisions": [],
                    "action_items": [],
                    "open_questions": [],
                    "risks": [],
                },
                {"provider": "old-provider", "model": "old-model"},
                True,
            )

        generate.side_effect = finish_old_attempt

        run_meeting_analysis_task.run(str(analysis.id), 1)

        analysis.refresh_from_db()
        self.assertEqual(analysis.status, MeetingAnalysis.Status.RUNNING)
        self.assertEqual(analysis.started_at, newer_started_at)
        self.assertEqual(analysis.summary, "")
        self.assertEqual(analysis.provider, "")

    @patch("apps.meetings.api.resolve_meeting_reference")
    def test_document_reference_uses_reference_resolver(self, resolve_reference):
        resource_id = uuid.uuid4()
        resolve_reference.return_value = {
            "title": "Architecture decision",
            "metadata": {"organization_id": str(self.organization.id)},
        }

        reference = add_meeting_reference(
            self.request(self.owner),
            self.session_id,
            MeetingReferenceIn(reference_type="document", resource_id=resource_id),
        )

        self.assertEqual(reference["resource_id"], str(resource_id))
        resolve_reference.assert_called_once_with(
            session=self.session,
            user=self.owner,
            reference_type="document",
            resource_id=resource_id,
        )

    def test_task_reference_checks_project_membership(self):
        task = ProjectTaskService(user=self.owner).create_task(
            project_id=self.project.id,
            title="Existing task",
            responsible_user_id=self.owner.id,
        )
        resolved = resolve_meeting_reference(
            session=self.session,
            user=self.owner,
            reference_type="task",
            resource_id=UUID(task["id"]),
        )
        self.assertEqual(resolved["title"], "Existing task")

    def test_list_filters_title_transcript_project_date_and_status(self):
        by_title = list_meeting_sessions(
            self.request(self.owner),
            self.organization.id,
            project_id=self.project.id,
            query="Architecture",
            status="stopped",
            date_from=date.today(),
            date_to=date.today(),
        )
        by_transcript = list_meeting_sessions(
            self.request(self.owner),
            self.organization.id,
            query="focused tests",
        )
        self.assertEqual([row["id"] for row in by_title["sessions"]], [str(self.session_id)])
        self.assertEqual([row["id"] for row in by_transcript["sessions"]], [str(self.session_id)])

    def test_export_markdown_and_json_include_raw_facts_and_analysis(self):
        MeetingAnalysis.objects.create(
            session=self.session,
            status=MeetingAnalysis.Status.COMPLETED,
            summary="Architecture approved.",
            source_transcript_revision=1,
        )
        markdown = export_meeting_session(
            self.request(self.owner),
            self.session_id,
            format="markdown",
        )
        exported_json = export_meeting_session(
            self.request(self.owner),
            self.session_id,
            format="json",
        )

        self.assertIn(b"Architecture approved", markdown.content)
        payload = json.loads(exported_json.content)
        self.assertEqual(payload["analysis"]["summary"], "Architecture approved.")
        self.assertEqual(len(payload["transcript"]), 2)

    def test_action_item_creates_project_task_once_and_backfills_reference(self):
        analysis = MeetingAnalysis.objects.create(
            session=self.session,
            status=MeetingAnalysis.Status.COMPLETED,
            summary="Follow up.",
            source_transcript_revision=1,
            action_items=[{
                "id": "action-stable",
                "title": "Add focused tests",
                "description": "Cover the meeting boundary",
                "responsible_user_id": "",
                "due_date": "",
                "priority": "high",
                "evidence_segment_ids": ["segment-2"],
                "task_id": None,
            }],
        )

        first = create_task_from_meeting_action_item(
            self.request(self.owner),
            self.session_id,
            "action-stable",
        )
        second = create_task_from_meeting_action_item(
            self.request(self.owner),
            self.session_id,
            "action-stable",
        )

        analysis.refresh_from_db()
        self.assertTrue(first["created"])
        self.assertFalse(second["created"])
        self.assertEqual(first["task"]["id"], second["task"]["id"])
        self.assertEqual(analysis.action_items[0]["task_id"], first["task"]["id"])
        self.assertTrue(ProjectTask.objects.filter(id=first["task"]["id"]).exists())
        self.assertTrue(MeetingReference.objects.filter(
            session=self.session,
            reference_type=MeetingReference.ReferenceType.TASK,
            resource_id=first["task"]["id"],
        ).exists())
