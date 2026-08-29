import json
from pathlib import Path
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

REGRESSION_CASES_PATH = (
    Path(__file__).parent / "fixtures" / "copilot_prompt_regression_cases.json"
)


def model_output(
    *,
    action="answer",
    reason_code="explicit_question",
    resolved_question="How does a hash map work?",
    direct_answer="A hash map hashes keys into buckets and resolves collisions.",
    key_points=None,
    knowledge_basis="general_knowledge",
    source_ids=None,
    reliability="high",
    uncertainty="",
    clarifying_question="",
):
    return json.dumps(
        {
            "action": action,
            "reason_code": reason_code,
            "resolved_question": resolved_question,
            "direct_answer": direct_answer,
            "key_points": key_points or [],
            "knowledge_basis": knowledge_basis,
            "source_ids": source_ids or [],
            "reliability": reliability,
            "uncertainty": uncertainty,
            "clarifying_question": clarifying_question,
        },
        ensure_ascii=False,
    )


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
        self.assertEqual(scene.default_params["max_tokens"], 320)
        self.assertEqual(scene.default_params["temperature"], 0.1)
        self.assertEqual(
            scene.default_params["response_format"],
            {"type": "json_object"},
        )

    def test_synthetic_regression_corpus_uses_supported_actions_and_reasons(self):
        cases = json.loads(REGRESSION_CASES_PATH.read_text(encoding="utf-8"))
        self.assertGreaterEqual(len(cases), 18)
        supported = {
            "answer": {
                "explicit_question",
                "implicit_request",
                "follow_up_question",
                "explanation_request",
                "comparison_request",
                "troubleshooting_request",
                "decision_request",
            },
            "no_action": {
                "greeting",
                "acknowledgement",
                "filler",
                "operational_check",
                "statement_without_request",
                "already_answered",
                "duplicate",
            },
            "wait_for_more": {
                "incomplete_fragment",
                "continuation_expected",
                "active_partial",
            },
            "clarify": {
                "ambiguous_reference",
                "missing_required_context",
            },
        }
        self.assertEqual(len({case["id"] for case in cases}), len(cases))
        for case in cases:
            self.assertIn(case["expected_action"], supported)
            self.assertIn(
                case["expected_reason"],
                supported[case["expected_action"]],
            )

    def test_returns_no_question_when_selected_turn_is_missing(self):
        result = generate_meeting_copilot_answer(
            session=self._session(),
            user=self._user(),
            question_segment_id="missing",
            recent_segments=[
                {
                    "external_id": "local-1",
                    "source": "local",
                    "start_ms": 100,
                    "text": "I will check.",
                    "is_final": True,
                }
            ],
            llm_call=Mock(),
        )

        self.assertEqual(result["status"], "no_question")

    def test_selects_the_requested_turn_instead_of_a_newer_turn(self):
        question = _selected_turn(
            [
                {
                    "external_id": "local-question",
                    "source": "local",
                    "start_ms": 100,
                    "text": "会议 Copilot 可以根据逐字稿回答问题吗？",
                },
                {
                    "external_id": "newer-question",
                    "source": "local",
                    "start_ms": 200,
                    "text": "这是一个新问题吗？",
                },
            ],
            "local-question",
        )

        self.assertIsNotNone(question)
        self.assertEqual(question["external_id"], "local-question")

    @patch("apps.meetings.copilot._select_chat_model")
    def test_generates_grounded_answer_with_context_sources(self, select_model):
        select_model.return_value = SimpleNamespace(id="model-1")
        llm_call = Mock(
            return_value=SimpleNamespace(
                content=model_output(
                    reason_code="decision_request",
                    resolved_question="Can we promise the delivery date?",
                    direct_answer="The date cannot be promised until the approved plan confirms it.",
                    key_points=["Do not promise an unverified date"],
                    knowledge_basis="provided_context",
                    source_ids=["meeting:brief"],
                    reliability="medium",
                    uncertainty="The approved delivery date is not present.",
                ),
                telemetry=SimpleNamespace(
                    model_used="deepseek-v4-flash",
                    provider_used="deepseek",
                    latency_ms=420,
                ),
            )
        )

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
        self.assertEqual(result["question"], "Can we promise the delivery date?")
        self.assertEqual(
            [source["id"] for source in result["sources"]], ["meeting:brief"]
        )
        self.assertEqual(result["model"], "deepseek-v4-flash")
        call = llm_call.call_args.kwargs
        self.assertEqual(call["scene_key"], "meeting_copilot_quick_answer")
        self.assertEqual(call["selected_model_id"], "model-1")
        call["result_validator"](llm_call.return_value.content)
        self.assertIn("Explain the delivery plan.", call["variables"]["candidate_json"])
        self.assertIn(
            "transcript:remote-1",
            call["variables"]["evidence_catalog_json"],
        )
        self.assertEqual(call["variables"]["transcript_context_before_candidate"], "")

    @patch("apps.meetings.copilot._select_chat_model")
    def test_local_statement_is_sent_to_model_for_semantic_no_action(
        self,
        select_model,
    ):
        select_model.return_value = SimpleNamespace(id="model-1")
        llm_call = Mock(
            return_value=SimpleNamespace(
                content=json.dumps(
                    {
                        "action": "no_action",
                        "reason_code": "statement_without_request",
                    }
                ),
                telemetry=SimpleNamespace(
                    model_used="deepseek-v4-flash",
                    provider_used="deepseek",
                    latency_ms=120,
                ),
            )
        )

        result = generate_meeting_copilot_answer(
            session=self._session(),
            user=self._user(),
            question_segment_id="statement-1",
            recent_segments=[
                {
                    "external_id": "statement-1",
                    "source": "local",
                    "start_ms": 1_000,
                    "text": "I am opening the document now.",
                    "is_final": True,
                }
            ],
            llm_call=llm_call,
        )

        self.assertEqual(result["status"], "no_action")
        self.assertEqual(result["candidate_segment_id"], "statement-1")
        select_model.assert_called_once()
        llm_call.assert_called_once()
        variables = llm_call.call_args.kwargs["variables"]
        self.assertIn('"source": "local"', variables["candidate_json"])
        self.assertEqual(variables["transcript_context_before_candidate"], "")

    @patch("apps.meetings.copilot._select_chat_model")
    def test_local_question_is_sent_to_model_and_answered(self, select_model):
        select_model.return_value = SimpleNamespace(id="model-1")
        llm_call = Mock(
            return_value=SimpleNamespace(
                content=model_output(
                    resolved_question="How does a cache index use a hash table?",
                    direct_answer=(
                        "A hash map hashes keys into buckets and resolves collisions; "
                        "the exact cache-index implementation requires its source code."
                    ),
                    key_points=["hashing", "buckets", "collision handling"],
                    reliability="medium",
                    uncertainty="The cache-index source code was not provided.",
                ),
                telemetry=SimpleNamespace(
                    model_used="deepseek-v4-flash",
                    provider_used="deepseek",
                    latency_ms=180,
                ),
            )
        )

        result = generate_meeting_copilot_answer(
            session=self._session(),
            user=self._user(),
            question_segment_id="local-question",
            recent_segments=[
                {
                    "external_id": "local-question",
                    "source": "local",
                    "start_ms": 1_000,
                    "text": "缓存索引中的散列表如何实现？",
                    "is_final": True,
                }
            ],
            llm_call=llm_call,
        )

        self.assertEqual(result["status"], "answered")
        self.assertEqual(result["question_segment_id"], "local-question")
        self.assertEqual(result["latency_ms"], 180)
        self.assertEqual(result["knowledge_basis"], "general_knowledge")
        self.assertFalse(result["answer"].startswith("建议先"))
        self.assertIn(
            '"source": "local"',
            llm_call.call_args.kwargs["variables"]["candidate_json"],
        )

    @patch("apps.meetings.copilot._select_chat_model")
    def test_rejects_invalid_model_output(self, select_model):
        select_model.return_value = SimpleNamespace(id="model-1")
        llm_call = Mock(
            return_value=SimpleNamespace(
                content="not-json",
                telemetry=SimpleNamespace(
                    model_used="model",
                    provider_used="provider",
                    latency_ms=1,
                ),
            )
        )

        with self.assertRaises(MeetingCopilotError) as raised:
            generate_meeting_copilot_answer(
                session=self._session(),
                user=self._user(),
                question_segment_id="remote-1",
                recent_segments=[
                    {
                        "external_id": "remote-1",
                        "source": "remote",
                        "start_ms": 1_000,
                        "text": "What is the delivery date?",
                        "is_final": True,
                    }
                ],
                llm_call=llm_call,
            )
        self.assertEqual(raised.exception.code, "invalid_model_response")
        self.assertEqual(llm_call.call_count, 2)

    @patch("apps.meetings.copilot._select_chat_model")
    def test_retries_one_invalid_json_response(self, select_model):
        select_model.return_value = SimpleNamespace(id="model-1")
        llm_call = Mock(
            side_effect=[
                SimpleNamespace(
                    content="",
                    telemetry=SimpleNamespace(
                        model_used="deepseek-v4-flash",
                        provider_used="deepseek",
                        latency_ms=100,
                    ),
                ),
                SimpleNamespace(
                    content=model_output(
                        direct_answer="Use an array of buckets and hash keys into them.",
                        key_points=["Hash keys into buckets"],
                    ),
                    telemetry=SimpleNamespace(
                        model_used="deepseek-v4-flash",
                        provider_used="deepseek",
                        latency_ms=120,
                    ),
                ),
            ]
        )

        result = generate_meeting_copilot_answer(
            session=self._session(),
            user=self._user(),
            question_segment_id="remote-1",
            recent_segments=[
                {
                    "external_id": "remote-1",
                    "source": "remote",
                    "start_ms": 1_000,
                    "text": "How does a hash map work?",
                    "is_final": True,
                }
            ],
            llm_call=llm_call,
        )

        self.assertEqual(result["status"], "answered")
        self.assertEqual(
            result["answer"],
            "Use an array of buckets and hash keys into them.",
        )
        self.assertEqual(llm_call.call_count, 2)

    @patch("apps.meetings.copilot._select_chat_model")
    def test_retries_meta_advice_and_requires_a_direct_answer(self, select_model):
        select_model.return_value = SimpleNamespace(id="model-1")
        llm_call = Mock(
            side_effect=[
                SimpleNamespace(
                    content=model_output(
                        direct_answer="建议先说明哈希表原理，再结合具体实现。",
                    ),
                    telemetry=SimpleNamespace(
                        model_used="deepseek-v4-flash",
                        provider_used="deepseek",
                        latency_ms=100,
                    ),
                ),
                SimpleNamespace(
                    content=model_output(
                        resolved_question="散列表为什么能快速查询？",
                        direct_answer=(
                            "Hash Map 使用桶数组保存条目，通过哈希函数定位桶；"
                            "冲突可使用链表、树化或开放寻址处理，平均查询复杂度为 O(1)。"
                        ),
                    ),
                    telemetry=SimpleNamespace(
                        model_used="deepseek-v4-flash",
                        provider_used="deepseek",
                        latency_ms=120,
                    ),
                ),
            ]
        )

        result = generate_meeting_copilot_answer(
            session=self._session(),
            user=self._user(),
            question_segment_id="hash-map-question",
            recent_segments=[
                {
                    "external_id": "hash-map-question",
                    "source": "local",
                    "start_ms": 1_000,
                    "text": "散列表为什么能快速查询？",
                    "is_final": True,
                }
            ],
            llm_call=llm_call,
        )

        self.assertEqual(result["status"], "answered")
        self.assertTrue(result["answer"].startswith("Hash Map 使用桶数组"))
        self.assertEqual(llm_call.call_count, 2)

    @patch("apps.meetings.copilot._select_chat_model")
    def test_returns_wait_for_more_for_an_incomplete_turn(self, select_model):
        select_model.return_value = SimpleNamespace(id="model-1")
        llm_call = Mock(
            return_value=SimpleNamespace(
                content=json.dumps(
                    {
                        "action": "wait_for_more",
                        "reason_code": "incomplete_fragment",
                    }
                ),
                telemetry=SimpleNamespace(
                    model_used="deepseek-v4-flash",
                    provider_used="deepseek",
                    latency_ms=80,
                ),
            )
        )

        result = generate_meeting_copilot_answer(
            session=self._session(),
            user=self._user(),
            question_segment_id="incomplete",
            recent_segments=[
                {
                    "external_id": "incomplete",
                    "source": "local",
                    "start_ms": 1_000,
                    "text": "请帮我判断究竟是……",
                    "is_final": True,
                }
            ],
            llm_call=llm_call,
        )

        self.assertEqual(result["status"], "wait_for_more")
        self.assertEqual(result["reason_code"], "incomplete_fragment")

    @patch("apps.meetings.copilot._select_chat_model")
    def test_returns_a_clarifying_question_for_ambiguous_context(self, select_model):
        select_model.return_value = SimpleNamespace(id="model-1")
        llm_call = Mock(
            return_value=SimpleNamespace(
                content=json.dumps(
                    {
                        "action": "clarify",
                        "reason_code": "ambiguous_reference",
                        "resolved_question": "需要比较哪个方案的成本？",
                        "uncertainty": "前文同时出现了两个候选方案。",
                        "clarifying_question": "你指的是 Redis 方案还是本地缓存方案？",
                    },
                    ensure_ascii=False,
                ),
                telemetry=SimpleNamespace(
                    model_used="deepseek-v4-flash",
                    provider_used="deepseek",
                    latency_ms=90,
                ),
            )
        )

        result = generate_meeting_copilot_answer(
            session=self._session(),
            user=self._user(),
            question_segment_id="ambiguous",
            recent_segments=[
                {
                    "external_id": "ambiguous",
                    "source": "local",
                    "start_ms": 1_000,
                    "text": "这几个选项中具体指哪一个的成本？",
                    "is_final": True,
                }
            ],
            llm_call=llm_call,
        )

        self.assertEqual(result["status"], "needs_clarification")
        self.assertIn("Redis", result["clarifying_question"])

    @patch("apps.meetings.copilot._select_chat_model")
    def test_rejects_unapproved_source_ids_instead_of_silently_filtering(
        self,
        select_model,
    ):
        select_model.return_value = SimpleNamespace(id="model-1")
        llm_call = Mock(
            return_value=SimpleNamespace(
                content=model_output(
                    knowledge_basis="provided_context",
                    source_ids=["invented:source"],
                ),
                telemetry=SimpleNamespace(
                    model_used="deepseek-v4-flash",
                    provider_used="deepseek",
                    latency_ms=50,
                ),
            )
        )

        with self.assertRaises(MeetingCopilotError):
            generate_meeting_copilot_answer(
                session=self._session(),
                user=self._user(),
                question_segment_id="question",
                recent_segments=[
                    {
                        "external_id": "question",
                        "source": "local",
                        "start_ms": 1_000,
                        "text": "What is the approved date?",
                        "is_final": True,
                    }
                ],
                llm_call=llm_call,
            )
        self.assertEqual(llm_call.call_count, 2)

    @patch("apps.meetings.copilot._select_chat_model")
    def test_context_sources_stop_at_the_selected_candidate(self, select_model):
        select_model.return_value = SimpleNamespace(id="model-1")
        llm_call = Mock(
            return_value=SimpleNamespace(
                content=model_output(
                    knowledge_basis="provided_context",
                    source_ids=["transcript:context-1"],
                ),
                telemetry=SimpleNamespace(
                    model_used="deepseek-v4-flash",
                    provider_used="deepseek",
                    latency_ms=50,
                ),
            )
        )

        result = generate_meeting_copilot_answer(
            session=self._session(),
            user=self._user(),
            question_segment_id="candidate",
            recent_segments=[
                {
                    "external_id": "context-1",
                    "source": "remote",
                    "start_ms": 100,
                    "text": "The approved plan requires a review.",
                    "is_final": True,
                },
                {
                    "external_id": "candidate",
                    "source": "local",
                    "start_ms": 200,
                    "text": "Can we skip the review?",
                    "is_final": True,
                },
                {
                    "external_id": "future",
                    "source": "local",
                    "start_ms": 300,
                    "text": "The review was cancelled later.",
                    "is_final": True,
                },
            ],
            llm_call=llm_call,
        )

        self.assertEqual(result["status"], "answered")
        variables = llm_call.call_args.kwargs["variables"]
        self.assertIn("context-1", variables["transcript_context_before_candidate"])
        self.assertNotIn("future", variables["evidence_catalog_json"])


class MeetingCopilotApiTests(SimpleTestCase):
    def test_request_id_returns_persisted_answer_without_repeating_model_call(self):
        request = SimpleNamespace(auth=SimpleNamespace(id="user-1"))
        session = SimpleNamespace(
            copilot_enabled=True,
            lifecycle_status=MeetingSession.LifecycleStatus.RECORDING,
        )
        persisted = SimpleNamespace(
            result_snapshot={
                "status": "answered",
                "question": "Can we ship?",
                "answer": "Confirm the plan first.",
            }
        )
        with (
            patch("apps.meetings.api._owned_session", return_value=session),
            patch("apps.meetings.api.MeetingCopilotAnswer.objects") as answers,
            patch("apps.meetings.copilot.generate_meeting_copilot_answer") as generate,
        ):
            answers.filter.return_value.first.return_value = persisted
            result = answer_meeting_copilot(
                request,
                "00000000-0000-4000-8000-000000000001",
                MeetingCopilotAnswerIn(
                    request_id="00000000-0000-4000-8000-000000000099",
                    question_segment_id="question-1",
                    recent_segments=[],
                ),
            )

        self.assertEqual(result["answer"], "Confirm the plan first.")
        generate.assert_not_called()

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
