import uuid
from types import SimpleNamespace
from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.test import TestCase
from ninja.errors import HttpError

from apps.services.oss.models import FileRecord, FileUsage
from apps.services.oss.api import (
    _check_upload_permission,
    _effective_is_public_for_module,
    _is_instant_hit_compatible_with_upload_scope,
)
from apps.tabtinspace.models import Organization, OrganizationMember

from .api import (
    CreateMeetingSessionIn,
    MeetingLifecycleIn,
    MeetingPermissionIn,
    MeetingTrackIn,
    delete_meeting_audio,
    delete_meeting_session,
    get_meeting_session,
    get_meeting_track_audio,
    get_meeting_transcript,
    grant_meeting_permission,
    list_meeting_sessions,
    revoke_meeting_permission,
    update_meeting_lifecycle,
    upsert_meeting_track,
    create_meeting_session,
)
from .models import (
    MeetingPermission,
    MeetingSession,
    MeetingTrack,
    MeetingTranscriptRun,
    MeetingTranscriptSegment,
)
from .services import meeting_track_context_id


class MeetingPermissionStoragePostgresTests(TestCase):
    databases = {"default", "postgresql"}

    def setUp(self):
        user_model = get_user_model()
        self.owner = user_model.objects.create_user(email="meeting-storage-owner@example.com")
        self.viewer = user_model.objects.create_user(email="meeting-storage-viewer@example.com")
        self.other_member = user_model.objects.create_user(
            email="meeting-storage-other@example.com"
        )
        self.outsider = user_model.objects.create_user(
            email="meeting-storage-outsider@example.com"
        )
        self.organization = Organization.objects.create(
            name="Meeting Storage Organization",
            owner=self.owner,
            type=Organization.OrganizationType.TEAM,
        )
        OrganizationMember.objects.create(
            organization=self.organization,
            user=self.viewer,
            role="viewer",
        )
        OrganizationMember.objects.create(
            organization=self.organization,
            user=self.other_member,
            role="editor",
        )
        self.session_id = uuid.uuid4()
        create_meeting_session(
            self.request(self.owner),
            CreateMeetingSessionIn(
                id=self.session_id,
                organization_id=self.organization.id,
                title="Shared architecture review",
                consent_confirmed=True,
            ),
        )

    @staticmethod
    def request(user):
        return SimpleNamespace(auth=user, headers={}, META={})

    def create_file_record(self, *, is_public=False, suffix="local"):
        key = f"meeting/{self.session_id}/{suffix}-{uuid.uuid4()}.webm"
        return FileRecord.objects.create(
            file_name=f"{suffix}.webm",
            file_key=key,
            file_path=f"meeting/{self.session_id}",
            file_size=1024,
            file_type="audio",
            mime_type="audio/webm",
            file_extension="webm",
            file_hash=uuid.uuid4().hex,
            hash_algorithm="sha256",
            bucket_name="meeting-test",
            is_public=is_public,
            upload_user=str(self.owner.id),
            upload_source="direct_upload",
            organization_id=str(self.organization.id),
            status="completed",
        )

    def bind_usage(self, file_record, source="local", *, user=None, context_id=None):
        return FileUsage.add_usage(
            file_record=file_record,
            user_id=(user or self.owner).id,
            module="meeting",
            context_type="meeting_track",
            context_id=context_id or meeting_track_context_id(self.session_id, source),
        )

    def grant_viewer(self):
        return grant_meeting_permission(
            self.request(self.owner),
            self.session_id,
            MeetingPermissionIn(
                subject_type="user",
                subject_id=str(self.viewer.id),
                permission="viewer",
            ),
        )

    def test_audio_sync_policy_is_removed(self):
        field_names = {field.name for field in MeetingSession._meta.fields}
        self.assertNotIn("audio_sync_policy", field_names)

    def test_explicit_viewer_acl_controls_read_without_granting_device_writes(self):
        with self.assertRaises(HttpError) as denied:
            get_meeting_session(self.request(self.viewer), self.session_id)
        self.assertEqual(denied.exception.status_code, 404)

        permission = self.grant_viewer()
        detail = get_meeting_session(self.request(self.viewer), self.session_id)
        listing = list_meeting_sessions(
            self.request(self.viewer),
            self.organization.id,
        )

        self.assertEqual(detail["id"], str(self.session_id))
        self.assertEqual([row["id"] for row in listing["sessions"]], [str(self.session_id)])
        with self.assertRaises(HttpError) as write_denied:
            update_meeting_lifecycle(
                self.request(self.viewer),
                self.session_id,
                MeetingLifecycleIn(status="preparing", expected_version=0),
            )
        self.assertEqual(write_denied.exception.status_code, 404)

        revoke_meeting_permission(
            self.request(self.owner),
            self.session_id,
            uuid.UUID(permission["id"]),
        )
        with self.assertRaises(HttpError):
            get_meeting_session(self.request(self.viewer), self.session_id)

    def test_permission_subject_must_be_an_organization_member(self):
        with self.assertRaises(HttpError) as raised:
            grant_meeting_permission(
                self.request(self.owner),
                self.session_id,
                MeetingPermissionIn(
                    subject_type="user",
                    subject_id=str(self.outsider.id),
                    permission="viewer",
                ),
            )
        self.assertEqual(raised.exception.status_code, 422)
        self.assertFalse(MeetingPermission.objects.filter(session_id=self.session_id).exists())

    def test_viewer_upload_exception_is_narrowly_bound_to_own_meeting_track(self):
        request = self.request(self.viewer)
        own_session_id = uuid.uuid4()
        create_meeting_session(
            request,
            CreateMeetingSessionIn(
                id=own_session_id,
                organization_id=self.organization.id,
                title="Viewer-owned meeting",
            ),
        )
        self.assertIsNone(
            _check_upload_permission(
                request,
                str(self.organization.id),
                module="meeting",
                context_type="meeting_track",
                context_id=f"{own_session_id}:local",
            )
        )
        self.assertIsNotNone(
            _check_upload_permission(
                request,
                str(self.organization.id),
                module="meeting",
                context_type="meeting_track",
                context_id=f"{self.session_id}:local",
            )
        )
        self.assertIsNotNone(
            _check_upload_permission(
                request,
                str(self.organization.id),
                module="meeting",
                context_type="document",
                context_id=f"{own_session_id}:local",
            )
        )

    def test_meeting_uploads_are_private_and_skip_public_instant_hits(self):
        public_file = self.create_file_record(is_public=True, suffix="instant-public")
        self.assertFalse(_effective_is_public_for_module("meeting", True))
        self.assertFalse(
            _is_instant_hit_compatible_with_upload_scope(
                public_file,
                module="meeting",
                context_type="meeting_track",
                is_public=False,
            )
        )

    def test_track_binding_requires_private_exact_active_usage_owned_by_caller(self):
        file_record = self.create_file_record()
        self.bind_usage(file_record)
        result = upsert_meeting_track(
            self.request(self.owner),
            self.session_id,
            "local",
            MeetingTrackIn(
                source="local",
                capture_status="completed",
                storage_status="synced",
                file_record_id=file_record.id,
            ),
        )
        self.assertEqual(result["file_record_id"], str(file_record.id))

        wrong_context_file = self.create_file_record(suffix="wrong-context")
        self.bind_usage(wrong_context_file, context_id=f"{uuid.uuid4()}:local")
        with self.assertRaises(HttpError) as wrong_context:
            upsert_meeting_track(
                self.request(self.owner),
                self.session_id,
                "local",
                MeetingTrackIn(
                    source="local",
                    capture_status="completed",
                    storage_status="synced",
                    file_record_id=wrong_context_file.id,
                ),
            )
        self.assertEqual(wrong_context.exception.status_code, 422)

        public_file = self.create_file_record(is_public=True, suffix="public")
        self.bind_usage(public_file)
        with self.assertRaises(HttpError) as public_denied:
            upsert_meeting_track(
                self.request(self.owner),
                self.session_id,
                "local",
                MeetingTrackIn(
                    source="local",
                    capture_status="completed",
                    storage_status="synced",
                    file_record_id=public_file.id,
                ),
            )
        self.assertEqual(public_denied.exception.status_code, 422)

    @patch("apps.meetings.api.resolve_authorized_file")
    def test_viewer_can_page_transcript_and_resolve_authorized_audio(self, resolve_audio):
        self.grant_viewer()
        run = MeetingTranscriptRun.objects.create(
            session_id=self.session_id,
            mode=MeetingTranscriptRun.Mode.REALTIME,
            status=MeetingTranscriptRun.Status.COMPLETED,
        )
        MeetingTranscriptSegment.objects.create(
            session_id=self.session_id,
            run=run,
            external_id="segment-1",
            source="remote",
            start_ms=100,
            end_ms=500,
            raw_text="What changed?",
            is_final=True,
        )
        transcript = get_meeting_transcript(
            self.request(self.viewer),
            self.session_id,
            limit=10,
        )
        self.assertEqual(transcript["total"], 1)
        self.assertEqual(transcript["segments"][0]["display_text"], "What changed?")

        file_record = self.create_file_record()
        self.bind_usage(file_record)
        MeetingTrack.objects.filter(session_id=self.session_id, source="local").update(
            file_record=file_record,
            storage_status=MeetingTrack.StorageStatus.SYNCED,
        )
        resolve_audio.return_value = SimpleNamespace(
            url="https://signed.example.test/audio",
            access_mode="signed",
            expires_at=None,
            expires_in=3600,
        )
        audio = get_meeting_track_audio(
            self.request(self.viewer),
            self.session_id,
            "local",
        )
        self.assertEqual(audio["url"], "https://signed.example.test/audio")

    @patch(
        "apps.services.billing.services.OrganizationStorageBillingService.apply_storage_delta"
    )
    def test_audio_delete_deactivates_only_meeting_usage_and_keeps_transcript(self, _billing):
        file_record = self.create_file_record()
        usage = self.bind_usage(file_record)
        MeetingTrack.objects.filter(session_id=self.session_id, source="local").update(
            file_record=file_record,
            storage_status=MeetingTrack.StorageStatus.SYNCED,
            file_size=file_record.file_size,
        )
        run = MeetingTranscriptRun.objects.create(
            session_id=self.session_id,
            mode=MeetingTranscriptRun.Mode.REALTIME,
        )
        segment = MeetingTranscriptSegment.objects.create(
            session_id=self.session_id,
            run=run,
            external_id="kept-segment",
            source="local",
            start_ms=0,
            end_ms=100,
            raw_text="keep this transcript",
            is_final=True,
        )

        result = delete_meeting_audio(self.request(self.owner), self.session_id)

        usage.refresh_from_db()
        file_record.refresh_from_db()
        self.assertFalse(usage.is_active)
        self.assertEqual(file_record.status, "completed")
        self.assertTrue(MeetingTranscriptSegment.objects.filter(id=segment.id).exists())
        self.assertEqual(result["deleted_audio_tracks"], 2)

    @patch(
        "apps.services.billing.services.OrganizationStorageBillingService.apply_storage_delta"
    )
    def test_session_delete_preserves_a_file_record_with_another_active_reference(self, _billing):
        file_record = self.create_file_record()
        meeting_usage = self.bind_usage(file_record)
        other_usage = FileUsage.add_usage(
            file_record=file_record,
            user_id=self.owner.id,
            module="tabdoc",
            context_type="document",
            context_id=str(uuid.uuid4()),
        )
        self.assertEqual(
            FileRecord.objects.get(id=file_record.id).ref_count,
            2,
        )

        delete_meeting_session(self.request(self.owner), self.session_id)

        meeting_usage.refresh_from_db()
        other_usage.refresh_from_db()
        file_record.refresh_from_db()
        self.assertFalse(meeting_usage.is_active)
        self.assertTrue(other_usage.is_active)
        self.assertEqual(file_record.ref_count, 1)
        self.assertEqual(file_record.status, "completed")
        self.assertFalse(MeetingSession.objects.filter(id=self.session_id).exists())
