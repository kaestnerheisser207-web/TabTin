"""Materialize server-configured Cloud Workers without persisting their tokens."""

from __future__ import annotations

import json
import re
from uuid import UUID

from django.conf import settings
from django.db import transaction

from apps.services.common.db_router import postgres_app_db_alias
from apps.tabtinspace.models import CloudWorkerNode, Organization
from apps.tabtinspace.services.cloud_worker_client import (
    CloudWorkerClient,
    CloudWorkerClientError,
)

_NODE_KEY = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$")


class CloudWorkerRegistryError(RuntimeError):
    pass


class CloudWorkerRegistry:
    @transaction.atomic(using=postgres_app_db_alias())
    def sync_configured(self) -> dict[str, int | list[str]]:
        raw = getattr(settings, "MUSE_CLOUD_WORKERS_JSON", "{}")
        try:
            configured_workers = json.loads(raw)
        except json.JSONDecodeError as exc:
            raise CloudWorkerRegistryError("Cloud Worker registry JSON is invalid") from exc
        if not isinstance(configured_workers, dict):
            raise CloudWorkerRegistryError("Cloud Worker registry must be an object")

        result = {"created": 0, "updated": 0, "offline": 0}
        active_keys: list[str] = []
        for node_key, raw_config in configured_workers.items():
            if not isinstance(node_key, str) or not _NODE_KEY.fullmatch(node_key):
                raise CloudWorkerRegistryError("Cloud Worker node_key is invalid")
            if not isinstance(raw_config, dict):
                raise CloudWorkerRegistryError(
                    f"Cloud Worker config must be an object: {node_key}"
                )
            (
                endpoint,
                edition,
                organization_id,
                protocol_version,
                runtime_version,
                storage_quota_mode,
                resource_isolation_mode,
                capacities,
            ) = self._validate_config(
                node_key,
                raw_config,
            )
            worker, created = CloudWorkerNode.objects.get_or_create(
                node_key=node_key,
                defaults={
                    "name": str(raw_config.get("name") or node_key),
                    "edition": edition,
                    "organization_id": organization_id,
                    "state": CloudWorkerNode.State.REGISTERING,
                    "control_endpoint": endpoint,
                    "protocol_version": protocol_version,
                    "runtime_version": runtime_version,
                    **capacities,
                    "metadata_json": {
                        "registry_source": "settings",
                        "expected_runtime_version": runtime_version,
                        "expected_storage_quota_mode": storage_quota_mode,
                        "expected_resource_isolation_mode": resource_isolation_mode,
                    },
                },
            )
            if not created:
                metadata = dict(worker.metadata_json or {})
                metadata["registry_source"] = "settings"
                metadata["expected_runtime_version"] = runtime_version
                metadata["expected_storage_quota_mode"] = storage_quota_mode
                metadata["expected_resource_isolation_mode"] = resource_isolation_mode
                fields = {
                    "name": str(raw_config.get("name") or node_key),
                    "edition": edition,
                    "organization_id": organization_id,
                    "control_endpoint": endpoint,
                    "protocol_version": protocol_version,
                    "metadata_json": metadata,
                    **capacities,
                }
                changed = []
                for field, value in fields.items():
                    if getattr(worker, field) != value:
                        setattr(worker, field, value)
                        changed.append(field)
                if changed:
                    worker.save(update_fields=[*changed, "updated_at"])
                result["updated"] += 1
            else:
                result["created"] += 1
            active_keys.append(node_key)

        stale = CloudWorkerNode.objects.filter(
            metadata_json__registry_source="settings"
        ).exclude(node_key__in=active_keys)
        result["offline"] = stale.exclude(
            state=CloudWorkerNode.State.OFFLINE
        ).update(state=CloudWorkerNode.State.OFFLINE)
        result["active_keys"] = active_keys
        return result

    @staticmethod
    def _validate_config(
        node_key: str,
        config: dict,
    ) -> tuple[str, str, UUID | None, str, str, str, str, dict]:
        try:
            endpoint = CloudWorkerClient.validate_configured_endpoint(
                config.get("endpoint")
            )
        except CloudWorkerClientError as exc:
            raise CloudWorkerRegistryError(
                f"Cloud Worker endpoint is invalid: {node_key}"
            ) from exc
        if not isinstance(config.get("token"), str) or not config["token"]:
            raise CloudWorkerRegistryError(f"Cloud Worker token is missing: {node_key}")
        edition = str(config.get("edition") or getattr(settings, "MUSE_EDITION", "saas"))
        if edition not in {CloudWorkerNode.Edition.SAAS, CloudWorkerNode.Edition.COMMUNITY}:
            raise CloudWorkerRegistryError(f"Cloud Worker edition is invalid: {node_key}")
        protocol_version = str(config.get("protocol_version") or "")
        expected_protocol = str(
            getattr(settings, "MUSE_CLOUD_WORKER_PROTOCOL_VERSION", "1")
        )
        if protocol_version != expected_protocol:
            raise CloudWorkerRegistryError(
                f"Cloud Worker protocol_version must equal {expected_protocol}: {node_key}"
            )
        runtime_version = str(config.get("runtime_version") or "").strip()
        if not runtime_version:
            raise CloudWorkerRegistryError(
                f"Cloud Worker runtime_version is required: {node_key}"
            )
        storage_quota_mode = str(config.get("storage_quota_mode") or "").strip()
        if storage_quota_mode != "podman-xfs":
            raise CloudWorkerRegistryError(
                f"Cloud Worker storage_quota_mode must be podman-xfs: {node_key}"
            )
        resource_isolation_mode = str(
            config.get("resource_isolation_mode") or ""
        ).strip()
        if resource_isolation_mode != "cgroup-v2":
            raise CloudWorkerRegistryError(
                f"Cloud Worker resource_isolation_mode must be cgroup-v2: {node_key}"
            )
        organization_id = None
        raw_organization_id = config.get("organization_id")
        if edition == CloudWorkerNode.Edition.COMMUNITY:
            try:
                organization_id = UUID(str(raw_organization_id))
            except (TypeError, ValueError) as exc:
                raise CloudWorkerRegistryError(
                    f"Community Worker organization_id is invalid: {node_key}"
                ) from exc
            if not Organization.objects.filter(id=organization_id).exists():
                raise CloudWorkerRegistryError(
                    f"Community Worker organization does not exist: {node_key}"
                )
        elif raw_organization_id:
            raise CloudWorkerRegistryError(
                f"SaaS Worker cannot bind an organization: {node_key}"
            )

        capacity_fields = {
            "capacity_cpu_millicores": "capacity_cpu_millicores",
            "capacity_memory_mb": "capacity_memory_mb",
            "capacity_storage_gb": "capacity_storage_gb",
        }
        capacities = {}
        for config_key, model_field in capacity_fields.items():
            value = config.get(config_key)
            if not isinstance(value, int) or isinstance(value, bool) or value < 1:
                raise CloudWorkerRegistryError(
                    f"Cloud Worker {config_key} must be a positive integer: {node_key}"
                )
            capacities[model_field] = value
        return (
            endpoint,
            edition,
            organization_id,
            protocol_version,
            runtime_version,
            storage_quota_mode,
            resource_isolation_mode,
            capacities,
        )
