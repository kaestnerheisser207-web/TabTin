"""Cloud Workspace admission and persistent allocation."""

from __future__ import annotations

import logging
import re
import uuid
from dataclasses import dataclass
from typing import Literal
from urllib.parse import urlsplit
from uuid import UUID

from django.conf import settings
from django.db import transaction
from django.db.models import Count, Sum

from apps.services.common.db_router import postgres_app_db_alias
from apps.tabtinspace.models import (
    CloudRuntimeAllocation,
    CloudWorkerNode,
    Device,
    Organization,
    Workspace,
)
from apps.tabtinspace.services.base import BaseService, ServiceError
from apps.tabtinspace.services.cloud_worker_client import (
    CloudWorkerClient,
    CloudWorkerClientError,
)
from apps.tabtinspace.services.cloud_git_credential_service import (
    CloudGitCredentialService,
)
SourceType = Literal["empty", "git"]
_IMMUTABLE_IMAGE = re.compile(r"^.+@sha256:[a-f0-9]{64}$", re.IGNORECASE)
_ACTIVE_ALLOCATION_STATES = {
    CloudRuntimeAllocation.State.PENDING,
    CloudRuntimeAllocation.State.PROVISIONING,
    CloudRuntimeAllocation.State.READY,
}
_RETAINED_STORAGE_STATES = {
    CloudRuntimeAllocation.State.PENDING,
    CloudRuntimeAllocation.State.PROVISIONING,
    CloudRuntimeAllocation.State.READY,
    CloudRuntimeAllocation.State.DISABLED,
    CloudRuntimeAllocation.State.ERROR,
    CloudRuntimeAllocation.State.DELETING,
}
_DEFAULT_CPU_MILLICORES = 2000
_DEFAULT_MEMORY_MB = 4096
_DEFAULT_WORKSPACE_STORAGE_GB = 20

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class CloudWorkspaceResult:
    workspace: Workspace
    allocation: CloudRuntimeAllocation
    created: bool


class CloudWorkspaceService(BaseService):
    """Create the DB-authoritative Cloud Workspace before Worker reconcile."""

    @transaction.atomic(using=postgres_app_db_alias())
    def create_cloud_workspace(
        self,
        *,
        request_key: UUID,
        organization_id: UUID,
        name: str,
        description: str = "",
        custom_rules: str = "",
        working_dir_type: str = "code",
        source_type: SourceType = "empty",
        git_url: str = "",
        git_ref: str = "",
        git_credential_ref: str = "",
    ) -> CloudWorkspaceResult:
        if not self.user:
            raise ServiceError("AUTH_REQUIRED", "用户未登录", 401)
        if not self.check_organization_permission(str(organization_id), "editor"):
            raise ServiceError(
                "PERMISSION_DENIED",
                "无权限在此组织创建 Cloud Workspace",
                403,
            )
        try:
            organization = Organization.objects.get(id=organization_id)
        except Organization.DoesNotExist as exc:
            raise ServiceError("ORGANIZATION_NOT_FOUND", "组织不存在", 404) from exc
        if not bool((organization.settings or {}).get("cloud_agent_enabled")):
            raise ServiceError(
                "CLOUD_AGENT_DISABLED",
                "当前组织尚未启用 Cloud Agent",
                403,
            )

        existing = self._find_idempotent(request_key, organization)
        if existing:
            logger.info(
                "[CloudRuntime] create organization=%s workspace=%s allocation=%s result=idempotent",
                organization.id,
                existing.workspace.id,
                existing.allocation.id,
            )
            return existing

        runtime_image = str(
            getattr(settings, "TABTIN_CLOUD_RUNTIME_IMAGE", "") or ""
        ).strip()
        if not _IMMUTABLE_IMAGE.match(runtime_image):
            raise ServiceError(
                "CLOUD_RUNTIME_IMAGE_UNAVAILABLE",
                "Cloud Runtime 镜像尚未配置为不可变 digest",
                503,
            )

        source = self._validate_source(
            source_type=source_type,
            git_url=git_url,
            git_ref=git_ref,
            git_credential_ref=git_credential_ref,
        )
        if source["git_credential_ref"]:
            CloudGitCredentialService(user=self.user).require_owned(
                organization_id=organization.id,
                credential_ref=source["git_credential_ref"],
            )
        # Fail with the user-owned entitlement before disclosing shared Worker
        # capacity. The check is repeated under the Worker row lock below.
        self._enforce_user_quota()
        worker = self._select_worker(organization)
        # Recheck under the Worker row lock: concurrent retries and per-user
        # quota decisions now serialize on the scheduling authority.
        existing = self._find_idempotent(request_key, organization)
        if existing:
            return existing
        self._enforce_user_quota()
        self._assert_worker_capacity(worker)

        allocation_id = uuid.uuid4()
        device = Device.objects.create(
            organization=organization,
            user=self.user,
            name=name.strip() or "Cloud Workspace",
            device_type="cloud",
            role="control",
            fingerprint=f"cloud-{allocation_id}",
            capabilities=[
                "terminal_execute",
                "terminal_read",
                "terminal_write",
                "file",
                "code_search",
                "git",
                "mcp",
            ],
            status="offline",
            app_version=worker.runtime_version,
            metadata_json={
                "cloud_allocation_id": str(allocation_id),
                "cloud_generation": 1,
                "workspace_root": "/workspace",
                "worker_node_id": str(worker.id),
            },
        )
        workspace = Workspace.objects.create(
            organization=organization,
            device=device,
            name=name.strip() or "Cloud Workspace",
            description=description.strip(),
            working_dir="/workspace",
            normalized_working_dir="/workspace",
            working_dir_type=working_dir_type or "code",
            kind=Workspace.Kind.STANDARD,
            trust_status=Workspace.TrustStatus.TRUSTED,
            trust_source=Workspace.TrustSource.SYSTEM_PROVISIONED,
            custom_rules=custom_rules,
            created_by=self.user,
        )
        from apps.tabtinspace.services.membership_utils import ensure_user_membership

        ensure_user_membership(workspace, self.user.id, "owner")
        allocation = CloudRuntimeAllocation.objects.create(
            id=allocation_id,
            request_key=request_key,
            workspace=workspace,
            worker=worker,
            device=device,
            state=CloudRuntimeAllocation.State.PENDING,
            volume_ref=f"cloud-workspace-{allocation_id}",
            runtime_image=runtime_image,
            source_type=source["source_type"],
            git_url=source["git_url"],
            git_ref=source["git_ref"],
            git_credential_ref=source["git_credential_ref"],
        )
        logger.info(
            "[CloudRuntime] create organization=%s workspace=%s allocation=%s worker=%s source=%s result=created",
            organization.id,
            workspace.id,
            allocation.id,
            worker.node_key,
            source["source_type"],
        )
        return CloudWorkspaceResult(
            workspace=workspace,
            allocation=allocation,
            created=True,
        )

    def _find_idempotent(
        self,
        request_key: UUID,
        organization: Organization,
    ) -> CloudWorkspaceResult | None:
        allocation = (
            CloudRuntimeAllocation.objects.select_related("workspace")
            .filter(request_key=request_key)
            .first()
        )
        if allocation is None:
            return None
        workspace = allocation.workspace
        if (
            workspace.organization_id != organization.id
            or workspace.created_by_id != self.user.id
        ):
            raise ServiceError(
                "CLOUD_REQUEST_KEY_CONFLICT",
                "Cloud Workspace 创建幂等键已被占用",
                409,
            )
        return CloudWorkspaceResult(
            workspace=workspace,
            allocation=allocation,
            created=False,
        )

    def _select_worker(self, organization: Organization) -> CloudWorkerNode:
        edition = getattr(
            settings,
            "TABTIN_CLOUD_WORKER_EDITION",
            getattr(settings, "TABTIN_EDITION", "saas"),
        )
        workers = CloudWorkerNode.objects.select_for_update().filter(
            edition=edition,
            state=CloudWorkerNode.State.READY,
            protocol_version=getattr(
                settings,
                "TABTIN_CLOUD_WORKER_PROTOCOL_VERSION",
                "1",
            ),
        )
        workers = (
            workers.filter(organization__isnull=True)
            if edition == "saas"
            else workers.filter(organization=organization)
        )
        for worker in workers.order_by("created_at"):
            try:
                CloudWorkerClient._connection_for(worker)
            except CloudWorkerClientError:
                continue
            if self._worker_has_capacity(worker):
                return worker
        raise ServiceError(
            "CLOUD_WORKER_CAPACITY_UNAVAILABLE",
            "当前没有可用的 Cloud Worker 容量",
            503,
        )

    def _enforce_user_quota(self) -> None:
        if getattr(
            settings,
            "TABTIN_CLOUD_WORKER_EDITION",
            getattr(settings, "TABTIN_EDITION", "saas"),
        ) != "saas":
            return
        limit = int(
            getattr(settings, "TABTIN_CLOUD_MAX_ACTIVE_WORKSPACES_PER_USER", 1)
        )
        active_count = CloudRuntimeAllocation.objects.filter(
            workspace__created_by=self.user,
            state__in=_ACTIVE_ALLOCATION_STATES,
        ).count()
        if active_count >= limit:
            raise ServiceError(
                "CLOUD_WORKSPACE_QUOTA_EXCEEDED",
                f"当前套餐最多启用 {limit} 个 Cloud Workspace",
                409,
            )

    @staticmethod
    def _worker_usage(worker: CloudWorkerNode) -> dict[str, int]:
        active_usage = CloudRuntimeAllocation.objects.filter(
            worker=worker,
            state__in=_ACTIVE_ALLOCATION_STATES,
        ).aggregate(
            cpu=Sum("cpu_millicores"),
            memory=Sum("memory_mb"),
        )
        retained_storage = CloudRuntimeAllocation.objects.filter(
            worker=worker,
            state__in=_RETAINED_STORAGE_STATES,
        ).aggregate(
            workspace_storage=Sum("storage_gb"),
            allocation_count=Count("id"),
        )
        runtime_storage_gb = int(
            getattr(settings, "TABTIN_CLOUD_RUNTIME_STORAGE_GB", 2)
        )
        return {
            "cpu": int(active_usage["cpu"] or 0),
            "memory": int(active_usage["memory"] or 0),
            "storage": int(retained_storage["workspace_storage"] or 0)
            + int(retained_storage["allocation_count"] or 0)
            * runtime_storage_gb,
        }

    @classmethod
    def _worker_has_capacity(cls, worker: CloudWorkerNode) -> bool:
        usage = cls._worker_usage(worker)
        runtime_storage_gb = int(
            getattr(settings, "TABTIN_CLOUD_RUNTIME_STORAGE_GB", 2)
        )
        return (
            usage["cpu"] + _DEFAULT_CPU_MILLICORES
            <= worker.capacity_cpu_millicores
            and usage["memory"] + _DEFAULT_MEMORY_MB
            <= worker.capacity_memory_mb
            and usage["storage"]
            + _DEFAULT_WORKSPACE_STORAGE_GB
            + runtime_storage_gb
            <= worker.capacity_storage_gb
        )

    @classmethod
    def _assert_worker_capacity(cls, worker: CloudWorkerNode) -> None:
        if not cls._worker_has_capacity(worker):
            raise ServiceError(
                "CLOUD_WORKER_CAPACITY_UNAVAILABLE",
                "Cloud Worker 容量已被其他请求占用",
                503,
            )

    @staticmethod
    def _validate_source(
        *,
        source_type: str,
        git_url: str,
        git_ref: str,
        git_credential_ref: str,
    ) -> dict[str, str]:
        if source_type == "empty":
            if any((git_url, git_ref, git_credential_ref)):
                raise ServiceError(
                    "CLOUD_SOURCE_INVALID",
                    "空目录来源不能携带 Git 参数",
                    400,
                )
            return {
                "source_type": "empty",
                "git_url": "",
                "git_ref": "",
                "git_credential_ref": "",
            }
        if source_type != "git" or not git_url.strip():
            raise ServiceError(
                "CLOUD_SOURCE_INVALID",
                "Git 来源必须提供仓库地址",
                400,
            )
        normalized_url = git_url.strip()
        parsed = urlsplit(normalized_url)
        if parsed.scheme != "https" or not parsed.hostname:
            raise ServiceError(
                "CLOUD_GIT_URL_INVALID",
                "Git 来源仅支持 HTTPS 地址",
                400,
            )
        if parsed.password or (parsed.scheme == "https" and parsed.username):
            raise ServiceError(
                "CLOUD_GIT_CREDENTIAL_INLINE_FORBIDDEN",
                "Git 地址不能内嵌凭据",
                400,
            )
        if git_credential_ref.strip() and parsed.hostname.lower() != "github.com":
            raise ServiceError(
                "CLOUD_GIT_CREDENTIAL_HOST_FORBIDDEN",
                "个人 GitHub 凭证只能用于 github.com 仓库",
                400,
            )
        return {
            "source_type": "git",
            "git_url": normalized_url,
            "git_ref": git_ref.strip(),
            "git_credential_ref": git_credential_ref.strip(),
        }
