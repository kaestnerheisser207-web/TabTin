from types import SimpleNamespace
from unittest.mock import Mock, patch

from django.test import SimpleTestCase

from .api import MeetingCopilotAnswerIn, answer_meeting_copilot
from .copilot import (
    MeetingCopilotError,
    _selected_turn,
    generate_meeting_copilot_answer,
)
from .models import MeetingSession


class MeetingCopilotQuickAnswerTests(SimpleTestCase):
    def _session(self):
        return SimpleNamespace(
            id="meeting-1",
            brief="Only promise dates that have been confirmed.",
            organization_id="org-1",
            organization=SimpleNamespace(settings={}),
            project_id=None,
        )

    def _user(self):
        return SimpleNamespace(id="user-1")

    def test_runtime_scene_reserves_a_complete_json_budget(self):
        from apps.services.llm.scenes.registry import SCENES

        scene = SCENES["meeting_copilot_quick_answer"]
        self.assertEqual(scene.default_params["max_tokens"], 512)
        self.assertEqual(
            scene.default_params["response_format"],
            {"type": "json_object"},
        )

    def test_returns_no_question_when_selected_turn_is_missing(self):
        result = generate_meeting_copilot_answer(
            session=self._session(),
            user=self._user(),
            question_segment_id="missing",
            recent_segments=[{
                "external_id": "local-1",
                "source": "local",
                "start_ms": 100,
                "text": "I will check.",
                "is_final": True,
            }],
            llm_call=Mock(),
        )

        self.assertEqual(result["status"], "no_question")

    def test_selects_the_requested_turn_instead_of_a_newer_turn(self):
        question = _selected_turn([{
            "external_id": "local-question",
            "source": "local",
            "start_ms": 100,
            "text": "会议 Copilot 可以根据逐字稿回答问题吗？",
        }, {
            "external_id": "newer-question",
            "source": "local",
            "start_ms": 200,
            "text": "这是一个新问题吗？",
        }], "local-question")

        self.assertIsNotNone(question)
        self.assertEqual(question["external_id"], "local-question")

    @patch("apps.meetings.copilot._select_chat_model")
    def test_generates_grounded_answer_and_filters_unknown_sources(self, select_model):
        select_model.return_value = SimpleNamespace(id="model-1")
        llm_call = Mock(return_value=SimpleNamespace(
            content=(
                '{"should_answer":true,'
                '"answer":"We should confirm the date after checking the plan.",'
                '"key_points":["Do not promise an unverified date"],'
                '"source_ids":["meeting:brief","invented:source"],'
                '"reliability":"medium","warning":"The exact date is not available."}'
            ),
            telemetry=SimpleNamespace(
                model_used="deepseek-v4-flash",
                provider_used="deepseek",
                latency_ms=420,
            ),
        ))

        result = generate_meeting_copilot_answer(
            session=self._session(),
            user=self._user(),
            question_segment_id="remote-1",
            recent_segments=[
                {
                    "external_id": "remote-1",
                    "source": "remote",
                    "start_ms": 1_000,
                    "text": "Explain the delivery plan.",
                    "is_final": True,
                },
                {
                    "external_id": "local-1",
                    "source": "local",
                    "start_ms": 2_000,
                    "text": "Let me check.",
                    "is_final": True,
                },
            ],
            llm_call=llm_call,
        )

        self.assertEqual(result["status"], "answered")
        self.assertEqual(result["question"], "Explain the delivery plan.")
        self.assertEqual([source["id"] for source in result["sources"]], ["meeting:brief"])
        self.assertEqual(result["model"], "deepseek-v4-flash")
        call = llm_call.call_args.kwargs
        self.assertEqual(call["scene_key"], "meeting_copilot_quick_answer")
        self.assertEqual(call["selected_model_id"], "model-1")
        call["result_validator"](llm_call.return_value.content)
        self.assertEqual(
            call["variables"]["candidate_utterance"],
            "Explain the delivery plan.",
        )
        self.assertIn("[transcript:remote-1] 对方", call["variables"]["transcript_context"])

    @patch("apps.meetings.copilot._select_chat_model")
    def test_local_user_speech_is_rejected_before_model_selection(self, select_model):
        select_model.return_value = SimpleNamespace(id="model-1")
        llm_call = Mock(return_value=SimpleNamespace(
            content=(
                '{"should_answer":false,"answer":"","key_points":[],'
                '"source_ids":[],"reliability":"low","warning":""}'
            ),
            telemetry=SimpleNamespace(
                model_used="deepseek-v4-flash",
                provider_used="deepseek",
                latency_ms=120,
            ),
        ))

        result = generate_meeting_copilot_answer(
            session=self._session(),
            user=self._user(),
            question_segment_id="statement-1",
            recent_segments=[{
                "external_id": "statement-1",
                "source": "local",
                "start_ms": 1_000,
                "text": "I am opening the document now.",
                "is_final": True,
            }],
            llm_call=llm_call,
        )

        self.assertEqual(result["status"], "no_action")
        self.assertEqual(result["candidate_segment_id"], "statement-1")
        select_model.assert_not_called()
        llm_call.assert_not_called()

    @patch("apps.meetings.copilot._select_chat_model")
    def test_rejects_invalid_model_output(self, select_model):
        select_model.return_value = SimpleNamespace(id="model-1")
        llm_call = Mock(return_value=SimpleNamespace(
            content="not-json",
            telemetry=SimpleNamespace(
                model_used="model",
                provider_used="provider",
                latency_ms=1,
            ),
        ))

        with self.assertRaises(MeetingCopilotError) as raised:
            generate_meeting_copilot_answer(
                session=self._session(),
                user=self._user(),
                question_segment_id="remote-1",
                recent_segments=[{
                    "external_id": "remote-1",
                    "source": "remote",
                    "start_ms": 1_000,
                    "text": "What is the delivery date?",
                    "is_final": True,
                }],
                llm_call=llm_call,
            )
        self.assertEqual(raised.exception.code, "invalid_model_response")
        self.assertEqual(llm_call.call_count, 2)

    @patch("apps.meetings.copilot._select_chat_model")
    def test_retries_one_invalid_json_response(self, select_model):
        select_model.return_value = SimpleNamespace(id="model-1")
        llm_call = Mock(side_effect=[
            SimpleNamespace(
                content="",
                telemetry=SimpleNamespace(
                    model_used="deepseek-v4-flash",
                    provider_used="deepseek",
                    latency_ms=100,
                ),
            ),
            SimpleNamespace(
                content=(
                    '{"should_answer":true,"answer":"Use an array of buckets.",'
                    '"key_points":["Hash keys into buckets"],"source_ids":[],'
                    '"reliability":"medium","warning":""}'
                ),
                telemetry=SimpleNamespace(
                    model_used="deepseek-v4-flash",
                    provider_used="deepseek",
                    latency_ms=120,
                ),
            ),
        ])

        result = generate_meeting_copilot_answer(
            session=self._session(),
            user=self._user(),
            question_segment_id="remote-1",
            recent_segments=[{
                "external_id": "remote-1",
                "source": "remote",
                "start_ms": 1_000,
                "text": "How does a hash map work?",
                "is_final": True,
            }],
            llm_call=llm_call,
        )

        self.assertEqual(result["status"], "answered")
        self.assertEqual(result["answer"], "Use an array of buckets.")
        self.assertEqual(llm_call.call_count, 2)


class MeetingCopilotApiTests(SimpleTestCase):
    def test_disabled_copilot_returns_without_invoking_model(self):
        request = SimpleNamespace(auth=SimpleNamespace(id="user-1"))
        session = SimpleNamespace(
            copilot_enabled=False,
            lifecycle_status=MeetingSession.LifecycleStatus.RECORDING,
        )
        with (
            patch("apps.meetings.api._owned_session", return_value=session),
            patch("apps.meetings.copilot.generate_meeting_copilot_answer") as generate,
        ):
            result = answer_meeting_copilot(
                request,
                "00000000-0000-4000-8000-000000000001",
                MeetingCopilotAnswerIn(
                    question_segment_id="question-1",
                    recent_segments=[],
                ),
            )

        self.assertEqual(result["status"], "disabled")
        generate.assert_not_called()

    def test_model_failure_isolated_as_structured_copilot_state(self):
        request = SimpleNamespace(auth=SimpleNamespace(id="user-1"))
        session = SimpleNamespace(
            copilot_enabled=True,
            lifecycle_status=MeetingSession.LifecycleStatus.RECORDING,
        )
        with (
            patch("apps.meetings.api._owned_session", return_value=session),
            patch(
                "apps.meetings.copilot.generate_meeting_copilot_answer",
                side_effect=MeetingCopilotError(
                    "model_not_configured",
                    "当前组织没有可供会议 Copilot 使用的对话模型",
                ),
            ),
        ):
            result = answer_meeting_copilot(
                request,
                "00000000-0000-4000-8000-000000000001",
                MeetingCopilotAnswerIn(
                    question_segment_id="question-1",
                    recent_segments=[],
                ),
            )

        self.assertEqual(result["status"], "failed")
        self.assertEqual(result["error_code"], "model_not_configured")
