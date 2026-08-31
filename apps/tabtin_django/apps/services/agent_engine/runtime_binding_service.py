"""RuntimeBinding admission and generation fencing."""

from __future__ import annotations

from django.db import transaction

from apps.services.agent_engine.models import RuntimeBinding
from apps.services.common.db_router import postgres_app_db_alias
from apps.tabtinspace.models import CloudRuntimeAllocation, Workspace
from apps.tabtinspace.services.base import ServiceError
from apps.tabtinspace.services.runtime_plane import derive_workspace_runtime_plane


class RuntimeBindingService:
    @transaction.atomic(using=postgres_app_db_alias())
    def freeze_for_dispatch(
        self,
        *,
        workspace: Workspace,
        thread_id: str,
        harness: str,
    ) -> RuntimeBinding:
        if harness not in {RuntimeBinding.Harness.BUILTIN, RuntimeBinding.Harness.DSH}:
            raise ServiceError("AGENT_HARNESS_INVALID", "Agent Harness 不受支持", 400)
        normalized_thread = str(thread_id or "").strip()
        if not normalized_thread or len(normalized_thread) > 128:
            raise ServiceError("THREAD_ID_INVALID", "执行 thread_id 无效", 400)

        plane = derive_workspace_runtime_plane(workspace)
        if harness == RuntimeBinding.Harness.DSH and plane != "cloud":
            raise ServiceError(
                "DSH_REQUIRES_CLOUD_WORKSPACE",
                "DSH Harness 仅支持 Cloud Workspace；本地执行不会静默降级为 Builtin",
                409,
            )
        allocation = None
        generation = 1
        if plane == "cloud":
            allocation = (
                CloudRuntimeAllocation.objects.select_for_update()
                .filter(workspace=workspace)
                .first()
            )
            if allocation is None:
                raise ServiceError(
                    "CLOUD_ALLOCATION_NOT_FOUND",
                    "Cloud Workspace 尚未分配运行环境",
                    409,
                )
            if allocation.device_id != workspace.device_id:
                raise ServiceError(
                    "CLOUD_ALLOCATION_DEVICE_MISMATCH",
                    "Cloud Workspace 运行设备投影不一致",
                    409,
                )
            if allocation.state != CloudRuntimeAllocation.State.READY:
                raise ServiceError(
                    "CLOUD_ALLOCATION_NOT_READY",
                    "Cloud Workspace 运行环境尚未就绪",
                    409,
                    data={"state": allocation.state},
                )
            generation = allocation.generation

        binding = (
            RuntimeBinding.objects.select_for_update()
            .filter(
                organization_id=workspace.organization_id,
                workspace=workspace,
                thread_id=normalized_thread,
                harness=harness,
            )
            .first()
        )
        driver_ref = (
            {"session_id": normalized_thread}
            if harness == RuntimeBinding.Harness.DSH
            else {}
        )
        if binding is None:
            return RuntimeBinding.objects.create(
                organization_id=workspace.organization_id,
                workspace=workspace,
                allocation=allocation,
                thread_id=normalized_thread,
                harness=harness,
                driver_session_ref=driver_ref,
                state=RuntimeBinding.State.ACTIVE,
                host_generation=generation,
            )

        changed = (
            binding.allocation_id != (allocation.id if allocation else None)
            or binding.host_generation != generation
            or binding.driver_session_ref != driver_ref
            or binding.state != RuntimeBinding.State.ACTIVE
        )
        if changed:
            binding.allocation = allocation
            binding.host_generation = generation
            binding.driver_session_ref = driver_ref
            binding.state = RuntimeBinding.State.ACTIVE
            binding.last_error = ""
            binding.revision += 1
            binding.save(
                update_fields=[
                    "allocation",
                    "host_generation",
                    "driver_session_ref",
                    "state",
                    "last_error",
                    "revision",
                    "updated_at",
                ]
            )
        return binding
