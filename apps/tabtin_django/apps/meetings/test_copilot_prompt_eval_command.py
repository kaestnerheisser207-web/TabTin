from __future__ import annotations

from io import StringIO
from types import SimpleNamespace
from unittest.mock import Mock, patch
from uuid import uuid4

from django.contrib.auth import get_user_model
from django.core.management import call_command
from django.core.management.base import CommandError
from django.test import SimpleTestCase

from apps.tabtinspace.models import Organization

from .management.commands.meeting_copilot_prompt_eval import Command
from .models import (
    MeetingCopilotAnswer,
    MeetingSession,
    MeetingTranscriptRun,
    MeetingTranscriptSegment,
)

COMMAND_MODULE = (
    "apps.meetings.management.commands.meeting_copilot_prompt_eval."
    "generate_meeting_copilot_answer"
)


class MeetingCopilotPromptEvalCommandTests(SimpleTestCase):
    def setUp(self):
        self.user = get_user_model()(
            id=uuid4(),
            email="meeting-copilot-prompt-eval@example.com",
        )
        self.organization = Organization(
            id=uuid4(),
            name="Meeting Copilot Prompt Eval",
            owner=self.user,
            type=Organization.OrganizationType.TEAM,
        )
        self.session = MeetingSession(
            id=uuid4(),
            organization=self.organization,
            created_by=self.user,
            title="Meeting Copilot prompt evaluation",
            brief="",
            project_id=None,
        )
        self.model_id = uuid4()

    def _subject_patch(self):
        return patch.object(
            Command,
            "_resolve_subject",
            return_value=(self.session, self.user),
        )

    def _arguments(self, case_id: str) -> list[str]:
        return [
            f"--organization-id={self.organization.id}",
            f"--user-id={self.user.id}",
            f"--model-id={self.model_id}",
            f"--case-id={case_id}",
            "--rounds=1",
        ]

    @staticmethod
    def _no_action_result(**kwargs):
        candidate_id = kwargs["question_segment_id"]
        return {
            "status": "no_action",
            "message": "当前发言不需要专业回答",
            "candidate_segment_id": candidate_id,
            "reason_code": "greeting",
        }

    def test_runs_mocked_generation_without_writing_meeting_data(self):
        output = StringIO()

        with (
            self._subject_patch(),
            patch(COMMAND_MODULE, side_effect=self._no_action_result) as generate,
            patch.object(MeetingSession, "save") as session_save,
            patch.object(MeetingTranscriptRun, "save") as run_save,
            patch.object(MeetingTranscriptSegment, "save") as segment_save,
            patch.object(MeetingCopilotAnswer, "save") as answer_save,
            patch.object(MeetingSession.objects, "create") as session_create,
            patch.object(MeetingTranscriptRun.objects, "create") as run_create,
            patch.object(MeetingTranscriptSegment.objects, "create") as segment_create,
            patch.object(MeetingCopilotAnswer.objects, "create") as answer_create,
        ):
            call_command(
                "meeting_copilot_prompt_eval",
                *self._arguments("greeting_hello"),
                stdout=output,
            )

        self.assertEqual(generate.call_count, 1)
        self.assertTrue(generate.call_args.kwargs["session"]._state.adding)
        self.assertEqual(generate.call_args.kwargs["session"].brief, "")
        self.assertIsNone(generate.call_args.kwargs["session"].project_id)
        self.assertEqual(
            generate.call_args.kwargs["selected_model_id"],
            str(self.model_id),
        )
        for meeting_write in (
            session_save,
            run_save,
            segment_save,
            answer_save,
            session_create,
            run_create,
            segment_create,
            answer_create,
        ):
            meeting_write.assert_not_called()
        self.assertIn("result=PASS", output.getvalue())
        self.assertIn("failed=0", output.getvalue())

    def test_failure_raises_command_error_and_does_not_print_answer_text(self):
        secret_answer = "建议你这样回答：哈希函数定位桶并处理冲突，平均是 O(1)。SECRET"

        def meta_answer(**kwargs):
            candidate_id = kwargs["question_segment_id"]
            return {
                "status": "answered",
                "question": "散列表如何查找？",
                "question_segment_id": candidate_id,
                "answer": secret_answer,
                "key_points": [],
                "sources": [],
                "reliability": "high",
                "warning": "",
                "reason_code": "explicit_question",
                "knowledge_basis": "general_knowledge",
                "uncertainty": "",
                "model": "test-model",
                "provider": "test-provider",
                "latency_ms": 10,
            }

        output = StringIO()
        with (
            self._subject_patch(),
            patch(COMMAND_MODULE, side_effect=meta_answer),
            self.assertRaises(CommandError),
        ):
            call_command(
                "meeting_copilot_prompt_eval",
                *self._arguments("explicit_hash_map_question"),
                stdout=output,
            )

        rendered = output.getvalue()
        self.assertIn("result=FAIL", rendered)
        self.assertIn("checks=meta_answer", rendered)
        self.assertNotIn(secret_answer, rendered)
        self.assertNotIn("散列表为什么能快速查找", rendered)

    def test_strict_result_schema_failure_exits_nonzero_without_leaking_payload(self):
        invalid_payload = {
            "status": "no_action",
            "message": "PRIVATE-PAYLOAD",
        }
        output = StringIO()

        with (
            self._subject_patch(),
            patch(COMMAND_MODULE, return_value=invalid_payload),
            self.assertRaises(CommandError),
        ):
            call_command(
                "meeting_copilot_prompt_eval",
                *self._arguments("greeting_hello"),
                stdout=output,
            )

        rendered = output.getvalue()
        self.assertIn("reason=invalid_result_schema", rendered)
        self.assertIn("checks=strict_schema", rendered)
        self.assertNotIn("PRIVATE-PAYLOAD", rendered)

    def test_case_filter_and_rounds_control_exact_call_count(self):
        output = StringIO()
        arguments = self._arguments("greeting_hello")
        arguments[-1] = "--rounds=2"

        with (
            self._subject_patch(),
            patch(COMMAND_MODULE, side_effect=self._no_action_result) as generate,
        ):
            call_command(
                "meeting_copilot_prompt_eval",
                *arguments,
                stdout=output,
            )

        self.assertEqual(generate.call_count, 2)
        self.assertIn("cases=1 rounds=2 evaluations=2", output.getvalue())
        self.assertIn("会产生模型费用", Command.help)

    def test_clarification_requires_uncertainty_but_does_not_print_its_text(self):
        private_question = "这个方案具体指哪一个？"
        private_uncertainty = "前文同时列出三个方案，无法唯一确定指代。"

        def clarification(**kwargs):
            return {
                "status": "needs_clarification",
                "question": "被指代方案的维护成本如何？",
                "question_segment_id": kwargs["question_segment_id"],
                "clarifying_question": private_question,
                "uncertainty": private_uncertainty,
                "reason_code": "ambiguous_reference",
                "model": "test-model",
                "provider": "test-provider",
                "latency_ms": 10,
            }

        output = StringIO()
        with self._subject_patch(), patch(COMMAND_MODULE, side_effect=clarification):
            call_command(
                "meeting_copilot_prompt_eval",
                *self._arguments("missing_private_constraint"),
                stdout=output,
            )

        rendered = output.getvalue()
        self.assertIn("action=clarify reason=ambiguous_reference", rendered)
        self.assertIn("result=PASS", rendered)
        self.assertNotIn(private_question, rendered)
        self.assertNotIn(private_uncertainty, rendered)

    def test_subject_resolution_builds_an_unsaved_context_free_proxy(self):
        organization_queryset = Mock()
        organization_queryset.first.return_value = self.organization
        user_queryset = Mock()
        user_queryset.first.return_value = self.user
        user_model = SimpleNamespace(objects=Mock())
        user_model.objects.filter.return_value = user_queryset

        with (
            patch(
                "apps.meetings.management.commands.meeting_copilot_prompt_eval."
                "Organization.objects.filter",
                return_value=organization_queryset,
            ),
            patch(
                "apps.meetings.management.commands.meeting_copilot_prompt_eval."
                "get_user_model",
                return_value=user_model,
            ),
            patch.object(MeetingSession, "save") as session_save,
        ):
            session, user = Command()._resolve_subject(
                {
                    "session_id": None,
                    "organization_id": str(self.organization.id),
                    "user_id": str(self.user.id),
                }
            )

        self.assertIs(user, self.user)
        self.assertTrue(session._state.adding)
        self.assertEqual(session.brief, "")
        self.assertIsNone(session.project_id)
        session_save.assert_not_called()
