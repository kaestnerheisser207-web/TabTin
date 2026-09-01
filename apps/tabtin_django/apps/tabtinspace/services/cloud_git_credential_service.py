"""Personal GitHub credentials used by a user's Cloud Workspaces."""

from __future__ import annotations

from uuid import UUID

from django.db import transaction

from apps.services.common.db_router import postgres_app_db_alias
from apps.tabtinspace.models import Organization, SecureCredential
from apps.tabtinspace.services.base import BaseService, ServiceError

_CREDENTIAL_NAME = "GitHub Cloud Git"
_PURPOSE = "cloud_git"
_PROVIDER = "github"


class CloudGitCredentialUnavailable(RuntimeError):
    pass


def _validate_token(value: str) -> str:
    token = (value or "").strip()
    if len(token) < 20 or len(token) > 4096 or "\n" in token or "\r" in token:
        raise ServiceError(
            "CLOUD_GIT_CREDENTIAL_INVALID",
            "GitHub 凭证格式无效",
            400,
        )
    return token


def _is_cloud_git_credential(credential: SecureCredential) -> bool:
    metadata = credential.metadata or {}
    return (
        credential.device_id is None
        and credential.credential_type == "api_key"
        and metadata.get("purpose") == _PURPOSE
        and metadata.get("provider") == _PROVIDER
    )


class CloudGitCredentialService(BaseService):
    """Reuse the user's GitHub Connector without sharing it with the organization."""

    @transaction.atomic(using=postgres_app_db_alias())
    def upsert_github(self, *, organization_id: UUID, token: str) -> SecureCredential:
        if not self.user:
            raise ServiceError("AUTH_REQUIRED", "用户未登录", 401)
        if not self.check_organization_permission(str(organization_id), "editor"):
            raise ServiceError(
                "PERMISSION_DENIED",
                "无权限为此组织创建 Cloud Workspace",
                403,
            )
        try:
            organization = Organization.objects.get(id=organization_id)
        except Organization.DoesNotExist as exc:
            raise ServiceError("ORGANIZATION_NOT_FOUND", "组织不存在", 404) from exc

        plain_token = _validate_token(token)
        credential = (
            SecureCredential.objects.select_for_update()
            .filter(
                organization=organization,
                user_id=self.user.id,
                device__isnull=True,
                name=_CREDENTIAL_NAME,
            )
            .first()
        )
        if credential is None:
            credential = SecureCredential(
                organization=organization,
                user_id=self.user.id,
                device=None,
                name=_CREDENTIAL_NAME,
                credential_type="api_key",
                encrypted_value="",
                metadata={"purpose": _PURPOSE, "provider": _PROVIDER},
            )
        credential.credential_type = "api_key"
        credential.metadata = {"purpose": _PURPOSE, "provider": _PROVIDER}
        credential.set_value(plain_token)
        credential.save()
        return credential

    def require_owned(self, *, organization_id: UUID, credential_ref: str) -> SecureCredential:
        if not self.user:
            raise ServiceError("AUTH_REQUIRED", "用户未登录", 401)
        try:
            credential_id = UUID((credential_ref or "").strip())
        except (TypeError, ValueError) as exc:
            raise ServiceError(
                "CLOUD_GIT_CREDENTIAL_INVALID",
                "GitHub 凭证引用无效",
                400,
            ) from exc
        credential = (
            SecureCredential.objects.filter(
                id=credential_id,
                organization_id=organization_id,
                user_id=self.user.id,
            )
            .first()
        )
        if credential is None or not _is_cloud_git_credential(credential):
            raise ServiceError(
                "CLOUD_GIT_CREDENTIAL_NOT_FOUND",
                "未找到当前用户的 GitHub Cloud 凭证",
                404,
            )
        return credential


def resolve_allocation_git_credential(allocation) -> dict[str, str] | None:
    credential_ref = (allocation.git_credential_ref or "").strip()
    if not credential_ref:
        return None
    try:
        credential_id = UUID(credential_ref)
    except ValueError as exc:
        raise CloudGitCredentialUnavailable("invalid Cloud Git credential reference") from exc
    credential = (
        SecureCredential.objects.filter(
            id=credential_id,
            organization_id=allocation.workspace.organization_id,
            user_id=allocation.workspace.created_by_id,
        )
        .first()
    )
    if credential is None or not _is_cloud_git_credential(credential):
        raise CloudGitCredentialUnavailable("Cloud Git credential is unavailable")
    try:
        token = _validate_token(credential.get_value())
    except ServiceError as exc:
        raise CloudGitCredentialUnavailable("Cloud Git credential is unavailable") from exc
    return {"username": "x-access-token", "password": token}
