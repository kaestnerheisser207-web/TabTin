from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import Mock, patch
from uuid import UUID

from django.test import SimpleTestCase

from .api import (
    MeetingCopilotAnswerIn,
    MeetingCopilotTranscriptSegmentIn,
    answer_meeting_copilot,
    get_meeting_copilot_answers,
)
from .models import MeetingCopilotAnswer, MeetingSession


class MeetingCopilotClarificationPersistenceTests(SimpleTestCase):
    def _session(self):
        return SimpleNamespace(
            id=UUID("00000000-0000-4000-8000-000000000001"),
            copilot_enabled=True,
            lifecycle_status=MeetingSession.LifecycleStatus.RECORDING,
        )

    def test_persists_clarification_as_a_terminal_answer(self):
        request = SimpleNamespace(auth=SimpleNamespace(id="user-1"))
        session = self._session()
        reservation = Mock()
        clarification = {
            "status": "needs_clarification",
            "question": "Why is it slow?",
            "question_segment_id": "question-1",
            "clarifying_question": "Do you mean transcription or answer latency?",
            "reason_code": "ambiguous_reference",
            "uncertainty": "The word slow does not identify a pipeline stage.",
            "model": "deepseek-v4-flash",
            "provider": "deepseek",
            "latency_ms": 180,
        }
        with (
            patch("apps.meetings.api._owned_session", return_value=session),
            patch("apps.meetings.api.MeetingCopilotAnswer.objects") as answers,
            patch(
                "apps.meetings.copilot.generate_meeting_copilot_answer",
                return_value=clarification,
            ),
        ):
            answers.filter.return_value.first.return_value = None
            answers.create.return_value = reservation
            result = answer_meeting_copilot(
                request,
                session.id,
                MeetingCopilotAnswerIn(
                    request_id="00000000-0000-4000-8000-000000000099",
                    question_segment_id="question-1",
                    recent_segments=[
                        MeetingCopilotTranscriptSegmentIn(
                            external_id="question-1",
                            source="local",
                            text="Why is it slow?",
                            candidate_id="candidate-1",
                            segment_ids=["opening-1", "question-1"],
                            revision=2,
                        )
                    ],
                ),
            )

        self.assertEqual(result["status"], "needs_clarification")
        self.assertEqual(result["candidate_id"], "candidate-1")
        self.assertEqual(result["candidate_revision"], 2)
        self.assertEqual(
            result["candidate_segment_ids"],
            ["opening-1", "question-1"],
        )
        self.assertEqual(
            reservation.status,
            MeetingCopilotAnswer.Status.NEEDS_CLARIFICATION,
        )
        self.assertEqual(reservation.result_snapshot, result)
        reservation.save.assert_called_once()

    def test_history_includes_persisted_clarifications(self):
        request = SimpleNamespace(auth=SimpleNamespace(id="user-1"))
        session = self._session()
        clarification = SimpleNamespace(
            id=UUID("00000000-0000-4000-8000-000000000010"),
            request_id=UUID("00000000-0000-4000-8000-000000000099"),
            question_segment_id="question-1",
            question_text="Why is it slow?",
            status=MeetingCopilotAnswer.Status.NEEDS_CLARIFICATION,
            result_snapshot={
                "status": "needs_clarification",
                "question_segment_id": "question-1",
                "clarifying_question": "Which latency do you mean?",
            },
            model="deepseek-v4-flash",
            provider="deepseek",
            latency_ms=180,
            created_at=datetime(2026, 8, 30, tzinfo=timezone.utc),
        )
        with (
            patch("apps.meetings.api._accessible_session", return_value=session),
            patch("apps.meetings.api.MeetingCopilotAnswer.objects") as answers,
        ):
            answers.filter.return_value = [clarification]
            result = get_meeting_copilot_answers(request, session.id)

        self.assertEqual(result["answers"][0]["status"], "needs_clarification")
        statuses = answers.filter.call_args.kwargs["status__in"]
        self.assertIn(MeetingCopilotAnswer.Status.NEEDS_CLARIFICATION, statuses)
