"""Low-cardinality Cloud Agent state metrics for the existing /metrics endpoint."""

from __future__ import annotations

import logging
from collections.abc import Iterable

from django.conf import settings
from django.db.models import Count, Sum

from apps.services.common.db_router import postgres_app_db_alias

logger = logging.getLogger(__name__)


try:
    from prometheus_client import REGISTRY
    from prometheus_client.core import GaugeMetricFamily
except ImportError:  # pragma: no cover - production requirements include prometheus_client
    REGISTRY = None
    GaugeMetricFamily = None  # type: ignore[assignment,misc]


class CloudStateCollector:
    """Read current DB-authoritative Cloud state at scrape time.

    Tenant, user, Workspace, allocation and thread identifiers are intentionally
    excluded from labels. ``node`` is a server-owned bounded Worker key.
    """

    def describe(self) -> Iterable:
        if GaugeMetricFamily is None:
            return []
        return [
            GaugeMetricFamily(
                "tabtin_cloud_state_collection_success",
                "Whether the DB-authoritative Cloud state collection succeeded.",
            ),
            GaugeMetricFamily(
                "tabtin_cloud_worker_nodes",
                "Cloud Worker nodes by edition and state.",
                labels=["edition", "state"],
            ),
            GaugeMetricFamily(
                "tabtin_cloud_allocations",
                "Cloud Runtime allocations by state.",
                labels=["state"],
            ),
            GaugeMetricFamily(
                "tabtin_cloud_runtime_bindings",
                "Cloud Runtime bindings by harness and state.",
                labels=["harness", "state"],
            ),
            GaugeMetricFamily(
                "tabtin_cloud_worker_capacity",
                "Configured Cloud Worker capacity by resource.",
                labels=["node", "resource"],
            ),
            GaugeMetricFamily(
                "tabtin_cloud_worker_allocated",
                "DB-reserved Cloud Worker resources by resource.",
                labels=["node", "resource"],
            ),
            GaugeMetricFamily(
                "tabtin_cloud_worker_heartbeat_age_seconds",
                "Seconds since the last successful Cloud Worker heartbeat.",
                labels=["node"],
            ),
        ]

    def collect(self) -> Iterable:
        if GaugeMetricFamily is None:
            return []
        success = GaugeMetricFamily(
            "tabtin_cloud_state_collection_success",
            "Whether the DB-authoritative Cloud state collection succeeded.",
        )
        try:
            families = list(self._collect_state())
        except Exception as exc:  # noqa: BLE001 -- metrics must not break readiness
            logger.warning(
                "[CloudMetrics] state collection failed error_type=%s",
                type(exc).__name__,
            )
            success.add_metric([], 0)
            return [success]
        success.add_metric([], 1)
        return [success, *families]

    @staticmethod
    def _collect_state() -> Iterable:
        from django.utils import timezone

        from apps.services.agent_engine.models import RuntimeBinding
        from apps.tabtinspace.models import CloudRuntimeAllocation, CloudWorkerNode

        db_alias = postgres_app_db_alias()
        workers = list(
            CloudWorkerNode.objects.using(db_alias)
            .order_by("node_key")
            .values(
                "id",
                "node_key",
                "edition",
                "state",
                "capacity_cpu_millicores",
                "capacity_memory_mb",
                "capacity_storage_gb",
                "last_heartbeat_at",
            )
        )
        worker_counts = {
            (row["edition"], row["state"]): row["count"]
            for row in CloudWorkerNode.objects.using(db_alias)
            .values("edition", "state")
            .annotate(count=Count("id"))
        }
        worker_family = GaugeMetricFamily(
            "tabtin_cloud_worker_nodes",
            "Cloud Worker nodes by edition and state.",
            labels=["edition", "state"],
        )
        for edition, _edition_label in CloudWorkerNode.Edition.choices:
            for state, _state_label in CloudWorkerNode.State.choices:
                worker_family.add_metric(
                    [edition, state],
                    worker_counts.get((edition, state), 0),
                )

        allocation_counts = {
            row["state"]: row["count"]
            for row in CloudRuntimeAllocation.objects.using(db_alias)
            .values("state")
            .annotate(count=Count("id"))
        }
        allocation_family = GaugeMetricFamily(
            "tabtin_cloud_allocations",
            "Cloud Runtime allocations by state.",
            labels=["state"],
        )
        for state, _state_label in CloudRuntimeAllocation.State.choices:
            allocation_family.add_metric([state], allocation_counts.get(state, 0))

        binding_counts = {
            (row["harness"], row["state"]): row["count"]
            for row in RuntimeBinding.objects.using(db_alias)
            .filter(allocation__isnull=False)
            .values("harness", "state")
            .annotate(count=Count("id"))
        }
        binding_family = GaugeMetricFamily(
            "tabtin_cloud_runtime_bindings",
            "Cloud Runtime bindings by harness and state.",
            labels=["harness", "state"],
        )
        for harness, _harness_label in RuntimeBinding.Harness.choices:
            for state, _state_label in RuntimeBinding.State.choices:
                binding_family.add_metric(
                    [harness, state],
                    binding_counts.get((harness, state), 0),
                )

        active_states = {
            CloudRuntimeAllocation.State.PENDING,
            CloudRuntimeAllocation.State.PROVISIONING,
            CloudRuntimeAllocation.State.READY,
        }
        retained_storage_states = {
            *active_states,
            CloudRuntimeAllocation.State.DISABLED,
            CloudRuntimeAllocation.State.ERROR,
            CloudRuntimeAllocation.State.DELETING,
        }
        active_usage = {
            row["worker_id"]: {
                "cpu_millicores": int(row["cpu"] or 0),
                "memory_mb": int(row["memory"] or 0),
            }
            for row in CloudRuntimeAllocation.objects.using(db_alias)
            .filter(state__in=active_states)
            .values("worker_id")
            .annotate(
                cpu=Sum("cpu_millicores"),
                memory=Sum("memory_mb"),
            )
        }
        runtime_storage_gb = int(
            getattr(settings, "MUSE_CLOUD_RUNTIME_STORAGE_GB", 2)
        )
        retained_storage = {
            row["worker_id"]: int(row["workspace_storage"] or 0)
            + int(row["allocation_count"] or 0) * runtime_storage_gb
            for row in CloudRuntimeAllocation.objects.using(db_alias)
            .filter(state__in=retained_storage_states)
            .values("worker_id")
            .annotate(
                workspace_storage=Sum("storage_gb"),
                allocation_count=Count("id"),
            )
        }
        capacity_family = GaugeMetricFamily(
            "tabtin_cloud_worker_capacity",
            "Configured Cloud Worker capacity by resource.",
            labels=["node", "resource"],
        )
        allocated_family = GaugeMetricFamily(
            "tabtin_cloud_worker_allocated",
            "DB-reserved Cloud Worker resources by resource.",
            labels=["node", "resource"],
        )
        heartbeat_family = GaugeMetricFamily(
            "tabtin_cloud_worker_heartbeat_age_seconds",
            "Seconds since the last successful Cloud Worker heartbeat.",
            labels=["node"],
        )
        now = timezone.now()
        capacity_fields = {
            "cpu_millicores": "capacity_cpu_millicores",
            "memory_mb": "capacity_memory_mb",
            "storage_gb": "capacity_storage_gb",
        }
        for worker in workers:
            node_key = str(worker["node_key"])
            worker_usage = active_usage.get(worker["id"], {})
            worker_usage["storage_gb"] = retained_storage.get(worker["id"], 0)
            for resource, field in capacity_fields.items():
                capacity_family.add_metric([node_key, resource], int(worker[field] or 0))
                allocated_family.add_metric(
                    [node_key, resource],
                    int(worker_usage.get(resource, 0)),
                )
            last_heartbeat = worker["last_heartbeat_at"]
            if last_heartbeat is not None:
                heartbeat_family.add_metric(
                    [node_key],
                    max(0.0, (now - last_heartbeat).total_seconds()),
                )

        return [
            worker_family,
            allocation_family,
            binding_family,
            capacity_family,
            allocated_family,
            heartbeat_family,
        ]


cloud_state_collector = CloudStateCollector()


def register_cloud_state_collector(registry=None) -> bool:
    """Register once on a Prometheus registry; duplicate imports stay harmless."""

    target = registry or REGISTRY
    if target is None:
        return False
    try:
        target.register(cloud_state_collector)
        return True
    except ValueError:
        return False
