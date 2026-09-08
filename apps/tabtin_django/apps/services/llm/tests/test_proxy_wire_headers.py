"""Desktop X-TabTin wire headers must survive product branding changes.

Use HTTP header names (as sent by ProxyProvider), rather than hand-built
Django META keys: changing both a receiver and its META fixture hid the
TabTin-to-Muse regression. SimpleTestCase forbids database access.
"""

import json
from types import SimpleNamespace
from unittest.mock import patch

from django.test import RequestFactory, SimpleTestCase

from apps.services.llm.proxy_api import _extract_billing_header_values, llm_proxy


class ProxyWireHeaderTests(SimpleTestCase):
    def request(self, headers):
        request = RequestFactory().post(
            "/api/llm/proxy", data={"model": "test", "messages": []},
            content_type="application/json", headers=headers,
        )
        request.auth = SimpleNamespace(id="user-1")
        return request

    def error(self, response):
        body = b"".join(response.streaming_content).decode()
        return json.loads(body.split("\n\n", 1)[0][6:])["error"]

    @patch("apps.tabtinspace.models.OrganizationMember.objects.using")
    def test_desktop_organization_header_reaches_membership_guard(self, using):
        using.return_value.filter.return_value.exists.return_value = False
        response = llm_proxy(self.request({"X-TabTin-Organization-Id": "org-1"}))
        using.return_value.filter.assert_called_once_with(
            user_id="user-1", organization_id="org-1",
        )
        self.assertEqual(self.error(response)["type"], "organization_forbidden")

    @patch("apps.tabtinspace.models.OrganizationMember.objects.using")
    def test_missing_organization_still_rejected_without_database_lookup(self, using):
        response = llm_proxy(self.request({"X-TabTin-Session-Id": "session-1"}))
        error = self.error(response)
        self.assertEqual(error["type"], "missing_organization_id")
        self.assertEqual(error["status"], 400)
        using.assert_not_called()

    @patch("apps.services.llm.proxy_api._is_trusted_agent_billing_key", return_value=False)
    @patch("apps.tabtinspace.models.OrganizationMember.objects.using")
    def test_desktop_retry_headers_keep_billing_and_session_identity(self, using, trust):
        using.return_value.filter.return_value.exists.return_value = True
        logical = "agent-turn:scope:_main_chat:0"
        attempt = logical + ":attempt:1"
        request = self.request({
            "X-TabTin-Organization-Id": "org-1",
            "X-TabTin-Session-Id": "session-1",
            "X-TabTin-Request-Source": "_main_chat",
            "X-TabTin-Billing-Idempotency-Key": attempt,
            "X-TabTin-Billing-Logical-Key": logical,
            "X-TabTin-Billing-Attempt-Key": attempt,
            "X-TabTin-Billing-Attempt-Index": "1",
        })
        billing = _extract_billing_header_values(request.META)
        self.assertEqual(billing.idempotency_key, attempt)
        self.assertEqual(billing.logical_billing_key, logical)
        self.assertEqual(billing.attempt_index, 1)
        response = llm_proxy(request)
        trust.assert_called_once_with(
            logical, user_id="user-1", organization_id="org-1",
            session_id="session-1", request_source="_main_chat",
        )
        self.assertEqual(self.error(response)["type"], "invalid_billing_idempotency_scope")
