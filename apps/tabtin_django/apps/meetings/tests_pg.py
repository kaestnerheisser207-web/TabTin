import uuid
from types import SimpleNamespace

from django.contrib.auth import get_user_model
from django.test import TestCase
from ninja.errors import HttpError

from apps.tabtinspace.models import Organization, Project, ProjectMembership

from .api import (
    CreateMeetingSessionIn,
    MeetingCopilotStateIn,
    MeetingLifecycleIn,
    create_meeting_session,
    update_meeting_copilot,
    update_meeting_lifecycle,
)
from .models import MeetingSession, MeetingTrack


class MeetingApiPostgresTests(TestCase):
    databases = {"default", "postgresql"}

    def setUp(self):
        user_model = get_user_model()
        self.owner = user_model.objects.create_user(
            email="meeting-owner@example.com",
        )
        self.outsider = user_model.objects.create_user(
            email="meeting-outsider@example.com",
        )
        self.organization = Organization.objects.create(
            name="Meeting Test Organization",
            owner=self.owner,
            type=Organization.OrganizationType.TEAM,
        )
        self.project = Project.objects.create(
            organization=self.organization,
            name="Meeting Test Project",
        )
        ProjectMembership.objects.create(
            project=self.project,
            user=self.owner,
            role="owner",
            is_active=True,
            status=ProjectMembership.Status.ACTIVE,
        )

    @staticmethod
    def request(user):
        return SimpleNamespace(auth=user, headers={})

    def test_create_is_idempotent_and_provisions_two_tracks(self):
        session_id = uuid.uuid4()
        payload = CreateMeetingSessionIn(
            id=session_id,
            organization_id=self.organization.id,
            project_id=self.project.id,
            title="Architecture review",
            consent_confirmed=True,
        )

        first = create_meeting_session(self.request(self.owner), payload)
        second = create_meeting_session(self.request(self.owner), payload)

        self.assertEqual(first["id"], str(session_id))
        self.assertEqual(second["id"], str(session_id))
        self.assertEqual(MeetingSession.objects.filter(id=session_id).count(), 1)
        self.assertEqual(
            set(
                MeetingTrack.objects.filter(session_id=session_id).values_list(
                    "source",
                    flat=True,
                )
            ),
            {"local", "remote"},
        )

    def test_lifecycle_and_copilot_use_optimistic_versioning(self):
        session_id = uuid.uuid4()
        create_meeting_session(
            self.request(self.owner),
            CreateMeetingSessionIn(
                id=session_id,
                organization_id=self.organization.id,
                title="Lifecycle review",
                consent_confirmed=True,
            ),
        )

        preparing = update_meeting_lifecycle(
            self.request(self.owner),
            session_id,
            MeetingLifecycleIn(status="preparing", expected_version=0),
        )
        recording = update_meeting_lifecycle(
            self.request(self.owner),
            session_id,
            MeetingLifecycleIn(status="recording", expected_version=1),
        )
        enabled = update_meeting_copilot(
            self.request(self.owner),
            session_id,
            MeetingCopilotStateIn(enabled=True, expected_version=2),
        )

        self.assertEqual(preparing["version"], 1)
        self.assertEqual(recording["version"], 2)
        self.assertTrue(enabled["copilot_enabled"])
        with self.assertRaises(HttpError) as raised:
            update_meeting_lifecycle(
                self.request(self.owner),
                session_id,
                MeetingLifecycleIn(status="paused", expected_version=3),
            )
        self.assertEqual(raised.exception.status_code, 422)

    def test_project_membership_is_enforced(self):
        with self.assertRaises(HttpError) as raised:
            create_meeting_session(
                self.request(self.outsider),
                CreateMeetingSessionIn(
                    id=uuid.uuid4(),
                    organization_id=self.organization.id,
                    project_id=self.project.id,
                    title="Unauthorized meeting",
                ),
            )
        self.assertEqual(raised.exception.status_code, 403)
