"""Reconcile DB-authoritative Cloud allocations onto Worker Supervisors."""

from __future__ import annotations

import logging
from datetime import timedelta

from django.db import transaction
from django.db.models import F, Q
from django.utils import timezone

from apps.services.agent_engine.models import RuntimeBinding
from apps.services.common.db_router import postgres_app_db_alias
from apps.tabtinspace.models import CloudRuntimeAllocation
from apps.tabtinspace.services.cloud_worker_client import CloudWorkerClient

logger = logging.getLogger(__name__)


class CloudAllocationReconciler:
    def __init__(self, client: CloudWorkerClient | None = None):
        self.client = client or CloudWorkerClient()

    def reconcile_due(self, *, limit: int = 20) -> dict[str, int]:
        now = timezone.now()
        ids = list(
            CloudRuntimeAllocation.objects.filter(
                Q(state=CloudRuntimeAllocation.State.PENDING)
                | Q(
                    state=CloudRuntimeAllocation.State.ERROR,
                    next_retry_at__lte=now,
                )
                | Q(
                    state=CloudRuntimeAllocation.State.PROVISIONING,
                    next_retry_at__lte=now,
                )
            )
            .order_by("created_at")
            .values_list("id", flat=True)[:limit]
        )
        result = {"ready": 0, "error": 0, "skipped": 0}
        for allocation_id in ids:
            result[self.reconcile_one(allocation_id)] += 1
        return result

    def reconcile_one(self, allocation_id) -> str:
        claim = self._claim(allocation_id)
        if claim is None:
            return "skipped"
        generation, needs_provision = claim
        allocation = CloudRuntimeAllocation.objects.select_related(
            "worker",
            "workspace",
            "device",
        ).get(id=allocation_id)
        try:
            response = (
                self.client.provision(allocation)
                if needs_provision
                else self.client.status(allocation)
            )
            if (
                response.get("state") != "running"
                or int(response.get("generation", 0)) != generation
            ):
                raise RuntimeError("Cloud Worker returned mismatched allocation state")
        except Exception as exc:  # noqa: BLE001 -- external Worker failures share one retry path
            self._record_failure(allocation_id, generation, exc)
            logger.warning(
                "[CloudRuntime] reconcile allocation=%s worker=%s generation=%s operation=%s result=error error_type=%s",
                allocation.id,
                allocation.worker.node_key,
                generation,
                "provision" if needs_provision else "status",
                type(exc).__name__,
            )
            return "error"
        ready = self._record_ready(allocation_id, generation)
        logger.info(
            "[CloudRuntime] reconcile allocation=%s worker=%s generation=%s operation=%s result=%s",
            allocation.id,
            allocation.worker.node_key,
            generation,
            "provision" if needs_provision else "status",
            "ready" if ready else "awaiting_heartbeat",
        )
        return "ready" if ready else "skipped"

    @transaction.atomic(using=postgres_app_db_alias())
    def _claim(self, allocation_id) -> tuple[int, bool] | None:
        allocation = CloudRuntimeAllocation.objects.select_for_update().get(
            id=allocation_id
        )
        if allocation.state == CloudRuntimeAllocation.State.PROVISIONING:
            if allocation.next_retry_at and allocation.next_retry_at > timezone.now():
                return None
            return allocation.generation, False
        if allocation.state not in {
            CloudRuntimeAllocation.State.PENDING,
            CloudRuntimeAllocation.State.ERROR,
        }:
            return None
        if allocation.next_retry_at and allocation.next_retry_at > timezone.now():
            return None
        allocation.state = CloudRuntimeAllocation.State.PROVISIONING
        allocation.last_error = ""
        allocation.save(update_fields=["state", "last_error", "updated_at"])
        return allocation.generation, True

    @transaction.atomic(using=postgres_app_db_alias())
    def _record_ready(self, allocation_id, generation: int) -> bool:
        allocation = (
            CloudRuntimeAllocation.objects.select_for_update()
            .select_related("device")
            .get(id=allocation_id)
        )
        if (
            allocation.generation != generation
            or allocation.state != CloudRuntimeAllocation.State.PROVISIONING
        ):
            return False
        now = timezone.now()
        metadata = allocation.device.metadata_json or {}
        activated = bool(metadata.get("daemon_activation_token_sha256"))
        try:
            metadata_generation = int(metadata.get("cloud_generation") or 0)
        except (TypeError, ValueError):
            metadata_generation = 0
        correct_generation = metadata_generation == generation
        correct_allocation = str(metadata.get("cloud_allocation_id") or "") == str(
            allocation.id
        )
        heartbeat_ready = (
            allocation.device.status == "online"
            and allocation.device.last_heartbeat_at is not None
        )
        if not (
            activated
            and correct_generation
            and correct_allocation
            and heartbeat_ready
        ):
            allocation.next_retry_at = now + timedelta(seconds=5)
            allocation.save(update_fields=["next_retry_at", "updated_at"])
            return False
        allocation.state = CloudRuntimeAllocation.State.READY
        allocation.provisioned_at = now
        allocation.next_retry_at = None
        allocation.last_error = ""
        allocation.save(
            update_fields=[
                "state",
                "provisioned_at",
                "next_retry_at",
                "last_error",
                "updated_at",
            ]
        )
        RuntimeBinding.objects.filter(allocation=allocation).update(
            state=RuntimeBinding.State.ACTIVE,
            revision=F("revision") + 1,
        )
        return True

    @transaction.atomic(using=postgres_app_db_alias())
    def _record_failure(self, allocation_id, generation: int, error: Exception) -> None:
        allocation = CloudRuntimeAllocation.objects.select_for_update().get(
            id=allocation_id
        )
        if allocation.generation != generation:
            return
        allocation.reconcile_attempts += 1
        delay_seconds = min(300, 5 * (2 ** min(allocation.reconcile_attempts - 1, 6)))
        allocation.state = CloudRuntimeAllocation.State.ERROR
        allocation.next_retry_at = timezone.now() + timedelta(seconds=delay_seconds)
        allocation.last_error = str(error)[:1000]
        allocation.save(
            update_fields=[
                "state",
                "reconcile_attempts",
                "next_retry_at",
                "last_error",
                "updated_at",
            ]
        )
        allocation.device.status = "offline"
        allocation.device.save(update_fields=["status", "updated_at"])
