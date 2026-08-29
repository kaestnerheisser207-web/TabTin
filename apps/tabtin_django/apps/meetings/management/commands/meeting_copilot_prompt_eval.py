"""Run the Meeting Copilot prompt regression corpus against a real model."""

from __future__ import annotations

import json
import logging
import re
import time
import uuid
from pathlib import Path
from typing import Any

from django.contrib.auth import get_user_model
from django.core.management.base import BaseCommand, CommandError

from apps.tabtinspace.models import Organization, OrganizationMember

from ...copilot import (
    ANSWER_REASON_CODES,
    CLARIFY_REASON_CODES,
    META_ANSWER_PREFIX,
    NO_ACTION_REASON_CODES,
    WAIT_REASON_CODES,
    MeetingCopilotError,
    generate_meeting_copilot_answer,
)
from ...models import MeetingSession
from ...services import MeetingAccessService

CASES_PATH = (
    Path(__file__).resolve().parents[2]
    / "fixtures"
    / "copilot_prompt_regression_cases.json"
)
SAFE_CASE_ID = re.compile(r"^[A-Za-z0-9_.-]{1,128}$")
MARKDOWN_PREFIX = re.compile(r"^[\s>*#_`-]+")
RESULT_STATUS_TO_ACTION = {
    "answered": "answer",
    "no_action": "no_action",
    "wait_for_more": "wait_for_more",
    "needs_clarification": "clarify",
}
ACTION_REASON_CODES = {
    "answer": ANSWER_REASON_CODES,
    "no_action": NO_ACTION_REASON_CODES,
    "wait_for_more": WAIT_REASON_CODES,
    "clarify": CLARIFY_REASON_CODES,
}


class ResultSchemaError(ValueError):
    """The mapped production result no longer matches the evaluation contract."""


def _require_exact_keys(
    value: dict[str, Any],
    *,
    required: set[str],
) -> None:
    if set(value) != required:
        raise ResultSchemaError("result keys do not match the strict schema")


def _require_string(value: Any, *, allow_empty: bool = False) -> str:
    if not isinstance(value, str) or (not allow_empty and not value.strip()):
        raise ResultSchemaError("result string field is invalid")
    return value


def _require_latency(value: Any) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise ResultSchemaError("result latency is invalid")
    return value


def _validate_sources(value: Any) -> None:
    if not isinstance(value, list):
        raise ResultSchemaError("result sources are invalid")
    source_keys = {
        "id",
        "kind",
        "title",
        "excerpt",
        "resource_type",
        "resource_id",
    }
    for source in value:
        if not isinstance(source, dict) or set(source) != source_keys:
            raise ResultSchemaError("result source does not match the strict schema")
        for field_value in source.values():
            _require_string(field_value, allow_empty=True)


def _validate_result(
    result: Any,
    *,
    candidate_segment_id: str,
) -> tuple[str, str]:
    if not isinstance(result, dict):
        raise ResultSchemaError("result must be an object")
    status = result.get("status")
    action = RESULT_STATUS_TO_ACTION.get(status)
    if action is None:
        raise ResultSchemaError("result status is unsupported")

    if action in {"no_action", "wait_for_more"}:
        _require_exact_keys(
            result,
            required={
                "status",
                "message",
                "candidate_segment_id",
                "reason_code",
            },
        )
        _require_string(result["message"])
        segment_id = _require_string(result["candidate_segment_id"])
    elif action == "clarify":
        _require_exact_keys(
            result,
            required={
                "status",
                "question",
                "question_segment_id",
                "clarifying_question",
                "uncertainty",
                "reason_code",
                "model",
                "provider",
                "latency_ms",
            },
        )
        _require_string(result["question"])
        segment_id = _require_string(result["question_segment_id"])
        _require_string(result["clarifying_question"])
        _require_string(result["uncertainty"])
        _require_string(result["model"])
        _require_string(result["provider"])
        _require_latency(result["latency_ms"])
    else:
        _require_exact_keys(
            result,
            required={
                "status",
                "question",
                "question_segment_id",
                "answer",
                "key_points",
                "sources",
                "reliability",
                "warning",
                "reason_code",
                "knowledge_basis",
                "uncertainty",
                "model",
                "provider",
                "latency_ms",
            },
        )
        _require_string(result["question"])
        segment_id = _require_string(result["question_segment_id"])
        _require_string(result["answer"])
        if not isinstance(result["key_points"], list) or any(
            not isinstance(point, str) for point in result["key_points"]
        ):
            raise ResultSchemaError("result key_points are invalid")
        _validate_sources(result["sources"])
        if result["reliability"] not in {"high", "medium", "low"}:
            raise ResultSchemaError("result reliability is invalid")
        _require_string(result["warning"], allow_empty=True)
        if result["knowledge_basis"] not in {
            "general_knowledge",
            "provided_context",
            "mixed",
        }:
            raise ResultSchemaError("result knowledge_basis is invalid")
        uncertainty = _require_string(result["uncertainty"], allow_empty=True)
        if result["warning"] != uncertainty:
            raise ResultSchemaError("result uncertainty fields disagree")
        _require_string(result["model"])
        _require_string(result["provider"])
        _require_latency(result["latency_ms"])

    if segment_id != candidate_segment_id:
        raise ResultSchemaError("result points to a different candidate segment")
    reason_code = _require_string(result.get("reason_code"))
    if reason_code not in ACTION_REASON_CODES[action]:
        raise ResultSchemaError("result reason_code is invalid for its action")
    return action, reason_code


def _load_cases() -> list[dict[str, Any]]:
    try:
        payload = json.loads(CASES_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise CommandError("Meeting Copilot 回归语料无法读取") from exc
    if not isinstance(payload, list) or not payload:
        raise CommandError("Meeting Copilot 回归语料必须是非空数组")

    seen_ids: set[str] = set()
    cases: list[dict[str, Any]] = []
    for item in payload:
        if not isinstance(item, dict):
            raise CommandError("Meeting Copilot 回归语料结构无效")
        case_id = item.get("id")
        action = item.get("expected_action")
        reason = item.get("expected_reason")
        context = item.get("context")
        candidate = item.get("candidate")
        if (
            not isinstance(case_id, str)
            or not SAFE_CASE_ID.fullmatch(case_id)
            or case_id in seen_ids
            or action not in ACTION_REASON_CODES
            or reason not in ACTION_REASON_CODES[action]
            or not isinstance(context, list)
            or any(not isinstance(text, str) or not text.strip() for text in context)
            or not isinstance(candidate, str)
            or not candidate.strip()
        ):
            raise CommandError("Meeting Copilot 回归语料结构无效")
        for field_name in (
            "answer_must_include",
            "answer_must_include_any",
            "resolved_question_must_include",
            "resolved_question_must_include_any",
        ):
            values = item.get(field_name, [])
            if not isinstance(values, list) or any(
                not isinstance(value, str) or not value for value in values
            ):
                raise CommandError("Meeting Copilot 回归语料断言结构无效")
        groups = item.get("answer_must_include_groups", [])
        if not isinstance(groups, list) or any(
            not isinstance(group, list)
            or not group
            or any(not isinstance(value, str) or not value for value in group)
            for group in groups
        ):
            raise CommandError("Meeting Copilot 回归语料断言结构无效")
        seen_ids.add(case_id)
        cases.append(item)
    return cases


def _segments_for_case(case: dict[str, Any]) -> tuple[list[dict[str, Any]], str]:
    segments: list[dict[str, Any]] = []
    for index, text in enumerate(case["context"]):
        external_id = f"eval-context-{index + 1}"
        segments.append(
            {
                "external_id": external_id,
                "candidate_id": external_id,
                "segment_ids": [external_id],
                "revision": 1,
                "source": "remote",
                "start_ms": index * 2_000,
                "end_ms": index * 2_000 + 1_000,
                "text": text,
                "is_final": True,
                "stability": "stable",
                "close_reason": "semantic_pause",
            }
        )
    # Keep fixture labels out of the prompt so case names cannot hint at the
    # expected classification.
    candidate_id = "eval-candidate"
    is_wait_case = case["expected_action"] == "wait_for_more"
    start_ms = len(segments) * 2_000
    segments.append(
        {
            "external_id": candidate_id,
            "candidate_id": candidate_id,
            "segment_ids": [candidate_id],
            "revision": 1,
            "source": "local",
            "start_ms": start_ms,
            "end_ms": start_ms + 1_000,
            "text": case["candidate"],
            "is_final": True,
            "stability": "open" if is_wait_case else "stable",
            "close_reason": "hard_deadline" if is_wait_case else "semantic_pause",
        }
    )
    return segments, candidate_id


def _contains_all(text: str, expected: list[str]) -> bool:
    normalized = " ".join(text.split()).casefold()
    return all(" ".join(value.split()).casefold() in normalized for value in expected)


def _contains_any(text: str, expected: list[str]) -> bool:
    if not expected:
        return True
    normalized = " ".join(text.split()).casefold()
    return any(" ".join(value.split()).casefold() in normalized for value in expected)


def _contains_each_group(text: str, groups: list[list[str]]) -> bool:
    return all(_contains_any(text, group) for group in groups)


def _expectation_failures(
    case: dict[str, Any],
    result: dict[str, Any],
    *,
    action: str,
) -> list[str]:
    failures: list[str] = []
    if action != case["expected_action"]:
        failures.append("action_mismatch")
    if action == "answer":
        answer = result["answer"]
        question = result["question"]
        direct_answer = MARKDOWN_PREFIX.sub("", answer.strip())
        if META_ANSWER_PREFIX.search(direct_answer):
            failures.append("meta_answer")
        if not _contains_all(answer, case.get("answer_must_include", [])):
            failures.append("answer_content")
        if not _contains_any(answer, case.get("answer_must_include_any", [])):
            failures.append("answer_content")
        if not _contains_each_group(
            answer,
            case.get("answer_must_include_groups", []),
        ):
            failures.append("answer_content")
        if not _contains_all(
            question,
            case.get("resolved_question_must_include", []),
        ):
            failures.append("resolved_question")
        if not _contains_any(
            question,
            case.get("resolved_question_must_include_any", []),
        ):
            failures.append("resolved_question")
    elif any(
        case.get(field_name)
        for field_name in (
            "answer_must_include",
            "answer_must_include_any",
            "answer_must_include_groups",
            "resolved_question_must_include",
            "resolved_question_must_include_any",
        )
    ):
        failures.append("missing_answer")
    return failures


def _safe_error_reason(exc: Exception) -> str:
    if isinstance(exc, MeetingCopilotError):
        token = exc.code
    else:
        token = exc.__class__.__name__
    token = re.sub(r"[^A-Za-z0-9_.-]", "_", str(token))[:64]
    return f"error_{token or 'unknown'}"


class Command(BaseCommand):
    help = (
        "真实调用生产 Meeting Copilot 路径评测固定回归语料；会产生模型费用，"
        "只允许写入标准 LLM usage/billing 记录，不写会议数据"
    )

    def add_arguments(self, parser):
        parser.add_argument(
            "--session-id",
            help="用一个当前用户可访问的会议确定组织和调用用户",
        )
        parser.add_argument(
            "--organization-id",
            help="不使用 --session-id 时必须指定",
        )
        parser.add_argument(
            "--user-id",
            help="组织成员；使用 --session-id 时默认会议创建者",
        )
        parser.add_argument(
            "--model-id",
            required=True,
            help="要真实调用的可用模型 ID（调用会产生模型费用）",
        )
        parser.add_argument(
            "--rounds",
            type=int,
            choices=(1, 2, 3),
            default=1,
            help="每个 case 的真实调用轮数，默认 1，最多 3（轮数会放大费用）",
        )
        parser.add_argument(
            "--case-id",
            action="append",
            default=[],
            help="只评测指定 case；可重复传入",
        )

    def _resolve_subject(self, options: dict[str, Any]):
        session_id = options.get("session_id")
        organization_id = options.get("organization_id")
        user_id = options.get("user_id")
        user_model = get_user_model()

        if session_id:
            if organization_id:
                raise CommandError("--session-id 不能与 --organization-id 同时使用")
            source_session = (
                MeetingSession.objects.select_related("organization", "created_by")
                .filter(id=session_id)
                .first()
            )
            if source_session is None:
                raise CommandError("指定会议不存在")
            user = source_session.created_by
            if user_id:
                user = user_model.objects.filter(id=user_id).first()
                if user is None:
                    raise CommandError("指定用户不存在")
            if not MeetingAccessService.has_access(source_session, user, "viewer"):
                raise CommandError("指定用户无权访问该会议")
            organization = source_session.organization
        else:
            if not organization_id or not user_id:
                raise CommandError(
                    "必须指定 --session-id，或同时指定 --organization-id 与 --user-id"
                )
            organization = Organization.objects.filter(id=organization_id).first()
            user = user_model.objects.filter(id=user_id).first()
            if organization is None or user is None:
                raise CommandError("指定组织或用户不存在")
            is_member = str(organization.owner_id) == str(user.id) or (
                OrganizationMember.objects.filter(
                    organization_id=organization.id,
                    user_id=user.id,
                ).exists()
            )
            if not is_member:
                raise CommandError("指定用户不是该组织成员")

        evaluation_session = MeetingSession(
            id=uuid.uuid4(),
            organization=organization,
            created_by=user,
            title="Meeting Copilot prompt evaluation",
            brief="",
            project_id=None,
            lifecycle_status=MeetingSession.LifecycleStatus.STOPPED,
        )
        return evaluation_session, user

    def handle(self, *args, **options):
        # The OpenAI-compatible SDK logs full request bodies at DEBUG. Keep the
        # evaluator metadata-only even when local Django settings enable DEBUG.
        for logger_name in ("openai", "httpcore", "httpx"):
            logging.getLogger(logger_name).setLevel(logging.WARNING)
        cases = _load_cases()
        requested_case_ids = set(options["case_id"])
        if requested_case_ids:
            known_case_ids = {case["id"] for case in cases}
            if not requested_case_ids <= known_case_ids:
                raise CommandError("--case-id 包含未知 case")
            cases = [case for case in cases if case["id"] in requested_case_ids]

        session, user = self._resolve_subject(options)
        rounds = options["rounds"]
        total = len(cases) * rounds
        passed = 0
        failed = 0

        for round_number in range(1, rounds + 1):
            for case in cases:
                segments, candidate_segment_id = _segments_for_case(case)
                started_at = time.perf_counter()
                action = "error"
                reason_code = "error_unknown"
                failures: list[str] = []
                try:
                    result = generate_meeting_copilot_answer(
                        session=session,
                        user=user,
                        recent_segments=segments,
                        question_segment_id=candidate_segment_id,
                        selected_model_id=options["model_id"],
                    )
                    action, reason_code = _validate_result(
                        result,
                        candidate_segment_id=candidate_segment_id,
                    )
                    failures = _expectation_failures(
                        case,
                        result,
                        action=action,
                    )
                except ResultSchemaError:
                    reason_code = "invalid_result_schema"
                    failures = ["strict_schema"]
                except Exception as exc:  # noqa: BLE001 - finish the full corpus
                    reason_code = _safe_error_reason(exc)
                    failures = ["generation_error"]
                latency_ms = max(round((time.perf_counter() - started_at) * 1_000), 0)
                status = "PASS" if not failures else "FAIL"
                if failures:
                    failed += 1
                else:
                    passed += 1
                line = (
                    f"case={case['id']} round={round_number} action={action} "
                    f"reason={reason_code} latency_ms={latency_ms} result={status}"
                )
                if failures:
                    line += f" checks={'+'.join(failures)}"
                self.stdout.write(line)

        self.stdout.write(
            f"summary cases={len(cases)} rounds={rounds} evaluations={total} "
            f"passed={passed} failed={failed}"
        )
        if failed:
            raise CommandError(f"Meeting Copilot prompt 评测失败：{failed}/{total}")
