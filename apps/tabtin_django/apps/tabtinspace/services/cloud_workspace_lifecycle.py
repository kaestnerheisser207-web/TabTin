"""Explicit Cloud Workspace stop/restart/restore/permanent-delete lifecycle."""

from __future__ import annotations

import logging
from datetime import timedelta

from django.conf import settings
from django.db import models, transaction
from django.utils import timezone

from apps.services.agent_engine.models import RuntimeBinding
from apps.services.common.db_router import postgres_app_db_alias
from apps.tabtinspace.models import CloudRuntimeAllocation, Workspace
from apps.tabtinspace.services.base import ServiceError
from apps.tabtinspace.services.cloud_worker_client import CloudWorkerClient
from apps.tabtinspace.services.cloud_git_credential_service import (
    CloudGitCredentialService,
)
from apps.tabtinspace.services.workspace_service import WorkspaceService

logger = logging.getLogger(__name__)


class CloudWorkspaceLifecycleService:
    def __init__(self, *, user, client: CloudWorkerClient | None = None):
        self.user = user
        self.client = client or CloudWorkerClient()

    def attach_git_credential(self, workspace_id, *, credential_ref: str) -> Workspace:
        workspace, allocation = self._owned_cloud(workspace_id)
        if allocation.source_type != "git":
            raise ServiceError(
                "CLOUD_GIT_CREDENTIAL_NOT_ALLOWED",
                "只有 Git 来源的 Cloud Workspace 可以绑定 GitHub 凭证",
                409,
            )
        credential = CloudGitCredentialService(user=self.user).require_owned(
            organization_id=workspace.organization_id,
            credential_ref=credential_ref,
        )
        with transaction.atomic(using=postgres_app_db_alias()):
            allocation = CloudRuntimeAllocation.objects.select_for_update().get(
                id=allocation.id
            )
            allocation.git_credential_ref = str(credential.id)
            allocation.generation += 1
            allocation.state = CloudRuntimeAllocation.State.PENDING
            allocation.reconcile_attempts = 0
            allocation.next_retry_at = timezone.now()
            allocation.last_error = ""
            allocation.retention_deadline = None
            allocation.save(
                update_fields=[
                    "git_credential_ref",
                    "generation",
                    "state",
                    "reconcile_attempts",
                    "next_retry_at",
                    "last_error",
                    "retention_deadline",
                    "updated_at",
                ]
            )
            allocation.device.status = "offline"
            allocation.device.last_heartbeat_at = None
            allocation.device.save(
                update_fields=["status", "last_heartbeat_at", "updated_at"]
            )
            RuntimeBinding.objects.filter(allocation=allocation).update(
                state=RuntimeBinding.State.SUSPENDED,
                host_generation=allocation.generation,
                revision=models.F("revision") + 1,
            )
        logger.info(
            "[CloudRuntime] lifecycle action=attach_git_credential workspace=%s allocation=%s generation=%s result=pending",
            workspace.id,
            allocation.id,
            allocation.generation,
        )
        return workspace

    def disable(self, workspace_id) -> Workspace:
        workspace, allocation = self._owned_cloud(workspace_id)
        response = self.client.disable(allocation)
        if response.get("state") not in {"stopped", "missing"}:
            raise ServiceError("CLOUD_DISABLE_FAILED", "Cloud Runtime 未停止", 502)
        retention_days = int(
            getattr(settings, "TABTIN_CLOUD_DISABLED_RETENTION_DAYS", 30)
        )
        with transaction.atomic(using=postgres_app_db_alias()):
            allocation = CloudRuntimeAllocation.objects.select_for_update().get(
                id=allocation.id
            )
            allocation.state = CloudRuntimeAllocation.State.DISABLED
            allocation.retention_deadline = timezone.now() + timedelta(
                days=retention_days
            )
            allocation.save(
                update_fields=["state", "retention_deadline", "updated_at"]
            )
            allocation.device.status = "offline"
            allocation.device.save(update_fields=["status", "updated_at"])
            RuntimeBinding.objects.filter(allocation=allocation).update(
                state=RuntimeBinding.State.SUSPENDED,
                revision=models.F("revision") + 1,
            )
        logger.info(
            "[CloudRuntime] lifecycle action=disable workspace=%s allocation=%s generation=%s result=disabled",
            workspace.id,
            allocation.id,
            allocation.generation,
        )
        return workspace

    def restart(self, workspace_id) -> Workspace:
        workspace, allocation = self._owned_cloud(workspace_id)
        if allocation.state not in {
            CloudRuntimeAllocation.State.READY,
            CloudRuntimeAllocation.State.DISABLED,
            CloudRuntimeAllocation.State.ERROR,
        }:
            raise ServiceError(
                "CLOUD_RESTART_NOT_ALLOWED",
                "Cloud Runtime 当前状态不允许重启",
                409,
            )
        response = self.client.restart(allocation)
        if response.get("state") != "running":
            raise ServiceError("CLOUD_RESTART_FAILED", "Cloud Runtime 未恢复运行", 502)
        with transaction.atomic(using=postgres_app_db_alias()):
            allocation = CloudRuntimeAllocation.objects.select_for_update().get(
                id=allocation.id
            )
            allocation.state = CloudRuntimeAllocation.State.PROVISIONING
            allocation.retention_deadline = None
            allocation.last_error = ""
            allocation.next_retry_at = timezone.now()
            allocation.save(
                update_fields=[
                    "state",
                    "retention_deadline",
                    "last_error",
                    "next_retry_at",
                    "updated_at",
                ]
            )
            allocation.device.status = "offline"
            allocation.device.last_heartbeat_at = None
            allocation.device.save(
                update_fields=["status", "last_heartbeat_at", "updated_at"]
            )
            RuntimeBinding.objects.filter(allocation=allocation).update(
                state=RuntimeBinding.State.SUSPENDED,
                revision=models.F("revision") + 1,
            )
        logger.info(
            "[CloudRuntime] lifecycle action=restart workspace=%s allocation=%s generation=%s result=awaiting_heartbeat",
            workspace.id,
            allocation.id,
            allocation.generation,
        )
        return workspace

    def restore(self, workspace_id) -> Workspace:
        _workspace, allocation = self._owned_cloud(workspace_id)
        if allocation.state != CloudRuntimeAllocation.State.DISABLED:
            raise ServiceError(
                "CLOUD_RESTORE_NOT_ALLOWED",
                "只有已停用的 Cloud Workspace 可以恢复",
                409,
            )
        if (
            allocation.retention_deadline
            and allocation.retention_deadline <= timezone.now()
        ):
            raise ServiceError(
                "CLOUD_RETENTION_EXPIRED",
                "Cloud Workspace 保留期已过",
                410,
            )
        return self.restart(workspace_id)

    def delete_permanently(self, workspace_id, *, confirmation: str) -> None:
        workspace, allocation = self._owned_cloud(workspace_id)
        if confirmation != (workspace.name or workspace.working_dir):
            raise ServiceError(
                "CLOUD_DELETE_CONFIRMATION_MISMATCH",
                "永久删除确认名称不匹配",
                400,
            )
        response = self.client.delete_permanently(allocation)
        if response.get("deleted") is not True:
            raise ServiceError("CLOUD_DELETE_FAILED", "Worker 未确认永久删除", 502)
        deleted_workspace_id = workspace.id
        deleted_allocation_id = allocation.id
        deleted_generation = allocation.generation
        device_id = allocation.device_id
        with transaction.atomic(using=postgres_app_db_alias()):
            RuntimeBinding.objects.filter(allocation=allocation).delete()
            allocation.delete()
            workspace.delete()
            from apps.tabtinspace.models import Device

            Device.objects.filter(id=device_id).delete()
        logger.info(
            "[CloudRuntime] lifecycle action=delete workspace=%s allocation=%s generation=%s result=deleted",
            deleted_workspace_id,
            deleted_allocation_id,
            deleted_generation,
        )

    def _owned_cloud(self, workspace_id) -> tuple[Workspace, CloudRuntimeAllocation]:
        workspace = WorkspaceService(user=self.user).get_workspace(workspace_id)
        try:
            allocation = CloudRuntimeAllocation.objects.select_related(
                "worker",
                "device",
            ).get(workspace=workspace)
        except CloudRuntimeAllocation.DoesNotExist as exc:
            raise ServiceError(
                "CLOUD_ALLOCATION_NOT_FOUND",
                "该 Workspace 不是 Cloud Workspace",
                404,
            ) from exc
        return workspace, allocation
