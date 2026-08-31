"""Authenticated client for server-configured Cloud Worker Supervisors."""

from __future__ import annotations

import json
import urllib.error
import urllib.request
from urllib.parse import urlsplit

from django.conf import settings

from apps.tabtinspace.models import CloudRuntimeAllocation, CloudWorkerNode

_USER_AGENT = "TabTin-Cloud-Control/1.0"


class CloudWorkerClientError(RuntimeError):
    pass


class _RejectRedirects(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise CloudWorkerClientError("Cloud Worker redirects are forbidden")


class CloudWorkerClient:
    def __init__(self, *, timeout_seconds: float = 30.0):
        self.timeout_seconds = timeout_seconds
        self._opener = urllib.request.build_opener(_RejectRedirects)

    def health(self, worker: CloudWorkerNode) -> dict:
        return self._request(worker, "GET", "/v1/health", None)

    def provision(self, allocation: CloudRuntimeAllocation) -> dict:
        from apps.tabtinspace.services.daemon_token_service import DaemonTokenService
        from apps.tabtinspace.services.cloud_git_credential_service import (
            resolve_allocation_git_credential,
        )

        git_credential = resolve_allocation_git_credential(allocation)

        return self._request(
            allocation.worker,
            "PUT",
            f"/v1/allocations/{allocation.id}",
            {
                "generation": allocation.generation,
                "image": allocation.runtime_image,
                "volumeRef": allocation.volume_ref,
                "cpuMillicores": allocation.cpu_millicores,
                "memoryMb": allocation.memory_mb,
                "storageGb": allocation.storage_gb,
                "bootstrapToken": DaemonTokenService.create_cloud_install_token(
                    allocation
                ),
                "source": {
                    "type": allocation.source_type,
                    "gitUrl": allocation.git_url or None,
                    "gitRef": allocation.git_ref or None,
                    "credential": git_credential,
                },
            },
        )

    def status(self, allocation: CloudRuntimeAllocation) -> dict:
        return self._allocation_action(allocation, "status")

    def disable(self, allocation: CloudRuntimeAllocation) -> dict:
        return self._allocation_action(allocation, "disable")

    def restart(self, allocation: CloudRuntimeAllocation) -> dict:
        return self._allocation_action(allocation, "restart")

    def delete_permanently(self, allocation: CloudRuntimeAllocation) -> dict:
        return self._request(
            allocation.worker,
            "DELETE",
            f"/v1/allocations/{allocation.id}",
            {"generation": allocation.generation, "permanent": True},
        )

    def _allocation_action(
        self,
        allocation: CloudRuntimeAllocation,
        action: str,
    ) -> dict:
        return self._request(
            allocation.worker,
            "POST",
            f"/v1/allocations/{allocation.id}/{action}",
            {"generation": allocation.generation},
        )

    def _request(
        self,
        worker: CloudWorkerNode,
        method: str,
        path: str,
        body: dict | None,
    ) -> dict:
        endpoint, token = self._connection_for(worker)
        payload = None if body is None else json.dumps(body).encode("utf-8")
        request = urllib.request.Request(
            f"{endpoint}{path}",
            data=payload,
            method=method,
            headers={
                "Authorization": f"Bearer {token}",
                "Content-Type": "application/json",
                "Accept": "application/json",
                "User-Agent": _USER_AGENT,
            },
        )
        try:
            with self._opener.open(request, timeout=self.timeout_seconds) as response:
                raw = response.read(64 * 1024 + 1)
        except CloudWorkerClientError:
            raise
        except urllib.error.HTTPError as exc:
            raw = exc.read(64 * 1024 + 1)
            if len(raw) > 64 * 1024:
                raise CloudWorkerClientError(
                    "Cloud Worker error response exceeded 64 KiB"
                ) from exc
            try:
                error_body = json.loads(raw or b"{}")
            except json.JSONDecodeError:
                error_body = {}
            if not isinstance(error_body, dict):
                error_body = {}
            code = str(error_body.get("code") or "worker_request_failed")
            message = str(error_body.get("error") or f"HTTP {exc.code}")
            raise CloudWorkerClientError(f"{code}: {message}") from exc
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            raise CloudWorkerClientError(
                f"Cloud Worker request failed for node {worker.node_key}"
            ) from exc
        if len(raw) > 64 * 1024:
            raise CloudWorkerClientError("Cloud Worker response exceeded 64 KiB")
        try:
            parsed = json.loads(raw or b"{}")
        except json.JSONDecodeError as exc:
            raise CloudWorkerClientError("Cloud Worker returned invalid JSON") from exc
        if not isinstance(parsed, dict):
            raise CloudWorkerClientError("Cloud Worker response must be an object")
        return parsed

    @staticmethod
    def _connection_for(worker: CloudWorkerNode) -> tuple[str, str]:
        raw = getattr(settings, "TABTIN_CLOUD_WORKERS_JSON", "{}")
        try:
            workers = json.loads(raw)
        except json.JSONDecodeError as exc:
            raise CloudWorkerClientError("Cloud Worker secret map is invalid") from exc
        configured = workers.get(worker.node_key) if isinstance(workers, dict) else None
        if not isinstance(configured, dict):
            raise CloudWorkerClientError(
                f"Cloud Worker is not configured for node {worker.node_key}"
            )
        endpoint = CloudWorkerClient.validate_configured_endpoint(
            configured.get("endpoint")
        )
        token = configured.get("token")
        if endpoint != str(worker.control_endpoint or "").strip().rstrip("/"):
            raise CloudWorkerClientError("Cloud Worker database endpoint does not match secret config")
        if not isinstance(token, str) or not token:
            raise CloudWorkerClientError("Cloud Worker token is missing")
        return endpoint, token

    @staticmethod
    def validate_configured_endpoint(value) -> str:
        endpoint = str(value or "").strip().rstrip("/")
        parsed = urlsplit(endpoint)
        is_loopback_dev = (
            parsed.scheme == "http"
            and parsed.hostname in {"127.0.0.1", "localhost", "::1"}
        )
        if (
            (parsed.scheme != "https" and not is_loopback_dev)
            or not parsed.hostname
            or parsed.username
            or parsed.password
            or parsed.query
            or parsed.fragment
        ):
            raise CloudWorkerClientError("Cloud Worker configured endpoint is invalid")
        return endpoint
