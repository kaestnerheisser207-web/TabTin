"""LLM 快照 HTTP 入口：权限、幂等、缺 runId。"""

from __future__ import annotations

import uuid
from datetime import timedelta

from django.contrib.auth import get_user_model
from django.test import TransactionTestCase, override_settings
from django.utils import timezone

from apps.chat.conversation.models import ChatLLMSnapshot, ChatSession
from apps.users.auth.models import UserSession
from apps.users.auth.session_manager import SessionManager
from apps.users.auth.utils import generate_jwt_token

User = get_user_model()


def _snapshot_body(**overrides):
    body = {
        "snapshot": {
            "runId": "run-http-1",
            "iteration": 0,
            "model": "gpt-test",
            "phase": "request",
            "messages": [{"role": "user", "contentPreview": "hi", "charCount": 2}],
            "messageCount": 1,
            "tools": [],
            "toolCount": 0,
        }
    }
    body["snapshot"].update(overrides)
    return body


@override_settings(MUSE_REQUIRE_INVITE_CODE=False)
class LlmSnapshotHttpTest(TransactionTestCase):
    databases = {"default", "postgresql"}

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        from django.db.models.signals import post_save
        from apps.tabtinspace.signals import create_default_organization
        post_save.disconnect(create_default_organization, sender=User)

    @classmethod
    def tearDownClass(cls):
        from django.db.models.signals import post_save
        from apps.tabtinspace.signals import create_default_organization
        post_save.connect(create_default_organization, sender=User)
        super().tearDownClass()

    def setUp(self):
        from apps.tabtinspace.tests.fixtures import create_test_organization_with_agent
        ctx = create_test_organization_with_agent(prefix="llm_snap_http")
        self.user = ctx["user"]
        self.organization = ctx["organization"]
        self.space = ctx["space"]
        self.agent = ctx["agent"]

        raw_key = "llm_snap_http_test_session_key_00000001"
        UserSession.objects.create(
            user=self.user,
            session_key=SessionManager.hash_session_key(raw_key),
            session_type="web",
            ip_address="127.0.0.1",
            user_agent="llm-snapshot-http-test",
            device_info={},
            expires_at=timezone.now() + timedelta(hours=24),
            is_active=True,
        )
        token = generate_jwt_token(
            self.user,
            expire_hours=1,
            token_type="access",
            session_key=raw_key,
        )
        self.auth_headers = {"HTTP_AUTHORIZATION": f"Bearer {token}"}
        self.session = ChatSession.objects.create(
            id=uuid.uuid4(),
            user=self.user,
            organization_id=str(self.organization.id),
            workspace=self.space,
            agent=self.agent,
            title="llm snapshot http",
            status="active",
        )

    def tearDown(self):
        from apps.tabtinspace.tests.fixtures import cleanup_test_organization
        cleanup_test_organization(self.organization, delete_user=True)

    def _url(self, session_id=None):
        sid = session_id or str(self.session.id)
        return f"/api/chat/sessions/{sid}/llm-snapshots"

    def _post(self, url, data, headers=None):
        return self.client.post(
            url,
            data=data,
            content_type="application/json",
            **(headers or self.auth_headers),
        )

    def test_owner_upserts_snapshot(self):
        response = self._post(self._url(), _snapshot_body())
        self.assertEqual(response.status_code, 200)
        payload = response.json()["data"]
        self.assertEqual(payload["run_id"], "run-http-1")
        self.assertEqual(payload["iteration"], 0)

        row = ChatLLMSnapshot.objects.get(
            session_id=str(self.session.id),
            run_id="run-http-1",
            iteration=0,
        )
        self.assertEqual(row.model, "gpt-test")
        self.assertEqual(row.thread_id, f"chat-session-{self.session.id}")

    def test_same_call_key_overwrites(self):
        self._post(self._url(), _snapshot_body(model="first"))
        response = self._post(self._url(), _snapshot_body(model="second", phase="response"))
        self.assertEqual(response.status_code, 200)
        self.assertEqual(ChatLLMSnapshot.objects.filter(session_id=str(self.session.id)).count(), 1)
        row = ChatLLMSnapshot.objects.get(session_id=str(self.session.id), run_id="run-http-1")
        self.assertEqual(row.model, "second")
        self.assertEqual(row.snapshot_json["phase"], "response")

    def test_missing_run_id_is_validation_error(self):
        body = _snapshot_body()
        body["snapshot"].pop("runId")
        response = self._post(self._url(), body)
        self.assertEqual(response.status_code, 400)
        self.assertEqual(ChatLLMSnapshot.objects.count(), 0)

    def test_unknown_session_is_not_found(self):
        response = self._post(self._url(str(uuid.uuid4())), _snapshot_body())
        self.assertEqual(response.status_code, 404)
        self.assertEqual(ChatLLMSnapshot.objects.count(), 0)

    def test_other_user_is_not_found(self):
        other = User.objects.create_user(
            username="llm_snap_other",
            email="llm_snap_other@example.com",
            password="pass",
        )
        raw_key = "llm_snap_http_test_session_key_00000002"
        UserSession.objects.create(
            user=other,
            session_key=SessionManager.hash_session_key(raw_key),
            session_type="web",
            ip_address="127.0.0.1",
            user_agent="llm-snapshot-http-test",
            device_info={},
            expires_at=timezone.now() + timedelta(hours=24),
            is_active=True,
        )
        token = generate_jwt_token(
            other,
            expire_hours=1,
            token_type="access",
            session_key=raw_key,
        )
        try:
            response = self._post(
                self._url(),
                _snapshot_body(),
                headers={"HTTP_AUTHORIZATION": f"Bearer {token}"},
            )
            self.assertEqual(response.status_code, 404)
            self.assertEqual(ChatLLMSnapshot.objects.count(), 0)
        finally:
            UserSession.objects.filter(user=other).delete()
            other.delete()
