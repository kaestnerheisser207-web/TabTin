import io
import json
import urllib.error
from typing import ClassVar
from unittest.mock import patch
from uuid import uuid4

from django.db import transaction
from django.test import SimpleTestCase, TransactionTestCase, override_settings
from django.utils import timezone

from apps.services.agent_engine.models import RuntimeBinding
from apps.services.agent_engine.runtime_binding_service import RuntimeBindingService
from apps.tabtinspace.cloud_metrics import CloudStateCollector
from apps.tabtinspace.models import (
    CloudRuntimeAllocation,
    CloudWorkerNode,
    Workspace,
)
from apps.tabtinspace.services.base import ServiceError
from apps.tabtinspace.services.cloud_allocation_reconciler import (
    CloudAllocationReconciler,
)
from apps.tabtinspace.services.cloud_worker_client import (
    CloudWorkerClient,
    CloudWorkerClientError,
)
from apps.tabtinspace.services.cloud_worker_registry import CloudWorkerRegistry
from apps.tabtinspace.services.cloud_git_credential_service import (
    CloudGitCredentialService,
)
from apps.tabtinspace.services.cloud_workspace_lifecycle import (
    CloudWorkspaceLifecycleService,
)
from apps.tabtinspace.services.cloud_workspace_service import CloudWorkspaceService
from apps.tabtinspace.services.daemon_token_service import (
    DaemonTokenService,
    DeviceFingerprintConflictError,
    _get_redis_client,
)
from apps.tabtinspace.services.runtime_plane import (
    UnsupportedExecutionDevice,
    derive_runtime_plane,
)
from apps.tabtinspace.tasks import _cloud_worker_health_failure_reason


class RuntimePlaneProjectionTests(SimpleTestCase):
    def test_cloud_device_derives_cloud_plane(self):
        self.assertEqual(derive_runtime_plane("cloud"), "cloud")

    def test_electron_and_daemon_derive_local_plane(self):
        self.assertEqual(derive_runtime_plane("electron"), "local")
        self.assertEqual(derive_runtime_plane("daemon"), "local")

    def test_data_devices_cannot_host_agent_runtime(self):
        for device_type in ("mobile", "iot", ""):
            with self.assertRaises(UnsupportedExecutionDevice):
                derive_runtime_plane(device_type)


class CloudRuntimeModelContractTests(SimpleTestCase):
    def test_worker_health_mismatch_reason_is_bounded_and_actionable(self):
        expected = {
            "expected_runtime_version": "runtime-1",
            "expected_storage_quota_mode": "podman-xfs",
            "expected_resource_isolation_mode": "cgroup-v2",
        }
        healthy = {
            "ok": True,
            "protocolVersion": "1",
            "runtimeVersion": "runtime-1",
            "storageQuotaMode": "podman-xfs",
            "resourceIsolationMode": "cgroup-v2",
        }

        self.assertEqual(
            _cloud_worker_health_failure_reason(
                health=healthy,
                expected_protocol="1",
                expected=expected,
            ),
            "",
        )
        self.assertEqual(
            _cloud_worker_health_failure_reason(
                health={**healthy, "resourceIsolationMode": "unverified"},
                expected_protocol="1",
                expected=expected,
            ),
            "resource_isolation_mismatch",
        )

    def test_cloud_metrics_fail_closed_without_breaking_the_metrics_endpoint(self):
        collector = CloudStateCollector()
        with patch.object(
            collector,
            "_collect_state",
            side_effect=RuntimeError("database unavailable"),
        ):
            families = list(collector.collect())

        self.assertEqual(len(families), 1)
        self.assertEqual(
            families[0].samples[0].name,
            "tabtin_cloud_state_collection_success",
        )
        self.assertEqual(families[0].samples[0].value, 0)

    def test_allocation_is_one_to_one_with_workspace_and_device(self):
        self.assertTrue(
            CloudRuntimeAllocation._meta.get_field("workspace").one_to_one
        )
        self.assertTrue(CloudRuntimeAllocation._meta.get_field("device").one_to_one)

    def test_v1_resource_defaults_are_explicit(self):
        allocation = CloudRuntimeAllocation(
            request_key=uuid4(),
            volume_ref="volume-1",
            runtime_image="ghcr.io/tabtin/cloud-runtime@sha256:test",
        )
        self.assertEqual(allocation.cpu_millicores, 2000)
        self.assertEqual(allocation.memory_mb, 4096)
        self.assertEqual(allocation.storage_gb, 20)
        self.assertEqual(allocation.generation, 1)

    def test_runtime_binding_identity_includes_harness(self):
        constraint = next(
            item
            for item in RuntimeBinding._meta.constraints
            if item.name == "uq_runtime_binding_identity"
        )
        self.assertEqual(
            tuple(constraint.fields),
            ("organization", "workspace", "thread_id", "harness"),
        )

    def test_worker_supports_saas_and_community_editions(self):
        self.assertEqual(
            {value for value, _label in CloudWorkerNode.Edition.choices},
            {"saas", "community"},
        )


class CloudWorkerClientBoundaryTests(SimpleTestCase):
    @override_settings(DAEMON_TOKEN_REDIS_URL="redis://redis:6379/10")
    @patch("redis.Redis.from_url")
    def test_daemon_token_claim_uses_configured_redis_url(self, from_url):
        expected = object()
        from_url.return_value = expected

        self.assertIs(_get_redis_client(), expected)
        from_url.assert_called_once_with(
            "redis://redis:6379/10",
            decode_responses=True,
        )

    @override_settings(
        TABTIN_CLOUD_WORKERS_JSON=(
            '{"worker-1":{"endpoint":"https://worker.internal",'
            '"token":"secret"}}'
        )
    )
    def test_endpoint_and_token_are_bound_in_server_secret_config(self):
        worker = CloudWorkerNode(
            node_key="worker-1",
            control_endpoint="https://worker.internal",
        )
        self.assertEqual(
            CloudWorkerClient._connection_for(worker),
            ("https://worker.internal", "secret"),
        )

    @override_settings(
        TABTIN_CLOUD_WORKERS_JSON=(
            '{"worker-1":{"endpoint":"https://trusted.internal",'
            '"token":"secret"}}'
        )
    )
    def test_database_endpoint_cannot_redirect_worker_credentials(self):
        worker = CloudWorkerNode(
            node_key="worker-1",
            control_endpoint="https://attacker.invalid",
        )
        with self.assertRaises(CloudWorkerClientError):
            CloudWorkerClient._connection_for(worker)

    @override_settings(
        TABTIN_CLOUD_WORKERS_JSON=(
            '{"worker-1":{"endpoint":"https://worker.internal",'
            '"token":"secret"}}'
        )
    )
    def test_request_uses_an_explicit_product_user_agent(self):
        worker = CloudWorkerNode(
            node_key="worker-1",
            control_endpoint="https://worker.internal",
        )
        captured = []

        class Response:
            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            @staticmethod
            def read(_limit):
                return b'{"ok":true}'

        class Opener:
            @staticmethod
            def open(request, *, timeout):
                captured.append((request, timeout))
                return Response()

        client = CloudWorkerClient(timeout_seconds=7)
        client._opener = Opener()

        self.assertEqual(client.health(worker), {"ok": True})
        request, timeout = captured[0]
        self.assertEqual(request.get_header("User-agent"), "TabTin-Cloud-Control/1.0")
        self.assertEqual(request.get_header("Authorization"), "Bearer secret")
        self.assertEqual(timeout, 7)

    @override_settings(
        TABTIN_CLOUD_WORKERS_JSON=(
            '{"worker-1":{"endpoint":"https://worker.internal",'
            '"token":"secret"}}'
        )
    )
    def test_worker_http_error_preserves_bounded_actionable_error(self):
        worker = CloudWorkerNode(
            node_key="worker-1",
            control_endpoint="https://worker.internal",
        )

        class Opener:
            @staticmethod
            def open(request, *, timeout):
                raise urllib.error.HTTPError(
                    request.full_url,
                    422,
                    "Unprocessable Entity",
                    {},
                    io.BytesIO(json.dumps({
                        "code": "git_source_unavailable",
                        "error": "Git repository is not publicly accessible",
                    }).encode("utf-8")),
                )

        client = CloudWorkerClient()
        client._opener = Opener()

        with self.assertRaisesRegex(
            CloudWorkerClientError,
            "git_source_unavailable: Git repository is not publicly accessible",
        ):
            client.health(worker)


class CloudWorkerRegistryTests(TransactionTestCase):
    databases: ClassVar[set[str]] = {"default", "postgresql"}

    def test_settings_registry_materializes_node_without_persisting_token(self):
        config = {
            "saas-worker-1": {
                "name": "SaaS Worker 1",
                "edition": "saas",
                "endpoint": "http://127.0.0.1:18090",
                "token": "registry-secret-token",
                "protocol_version": "1",
                "runtime_version": "runtime-test",
                "storage_quota_mode": "podman-xfs",
                "resource_isolation_mode": "cgroup-v2",
                "capacity_cpu_millicores": 8000,
                "capacity_memory_mb": 16384,
                "capacity_storage_gb": 80,
            },
        }
        with (
            override_settings(TABTIN_CLOUD_WORKERS_JSON=json.dumps(config)),
            patch.object(
                CloudWorkerClient,
                "health",
                return_value={
                    "ok": True,
                    "protocolVersion": "1",
                    "runtimeVersion": "runtime-test",
                    "storageQuotaMode": "podman-xfs",
                    "resourceIsolationMode": "cgroup-v2",
                },
            ),
        ):
            result = CloudWorkerRegistry().sync_configured()
            registered_state = CloudWorkerNode.objects.get(
                node_key="saas-worker-1"
            ).state
            from apps.tabtinspace.tasks import heartbeat_cloud_worker_nodes

            heartbeat_result = heartbeat_cloud_worker_nodes()

        self.assertEqual(result["created"], 1)
        self.assertEqual(result["active_keys"], ["saas-worker-1"])
        worker = CloudWorkerNode.objects.get(node_key="saas-worker-1")
        self.assertEqual(heartbeat_result["ready"], 1)
        self.assertEqual(registered_state, CloudWorkerNode.State.REGISTERING)
        self.assertEqual(worker.state, CloudWorkerNode.State.READY)
        self.assertEqual(worker.runtime_version, "runtime-test")
        self.assertEqual(worker.capacity_cpu_millicores, 8000)
        self.assertEqual(
            worker.metadata_json,
            {
                "registry_source": "settings",
                "expected_runtime_version": "runtime-test",
                "expected_storage_quota_mode": "podman-xfs",
                "expected_resource_isolation_mode": "cgroup-v2",
            },
        )
        self.assertNotIn("registry-secret-token", str(worker.__dict__))

        with (
            override_settings(TABTIN_CLOUD_WORKERS_JSON=json.dumps(config)),
            patch.object(
                CloudWorkerClient,
                "health",
                return_value={
                    "ok": True,
                    "protocolVersion": "1",
                    "runtimeVersion": "unexpected-runtime",
                    "storageQuotaMode": "podman-xfs",
                    "resourceIsolationMode": "cgroup-v2",
                },
            ),
        ):
            mismatch = heartbeat_cloud_worker_nodes()
        worker.refresh_from_db()
        self.assertEqual(mismatch["error"], 1)
        self.assertEqual(worker.state, CloudWorkerNode.State.ERROR)

        with override_settings(TABTIN_CLOUD_WORKERS_JSON="{}"):
            removed = CloudWorkerRegistry().sync_configured()
        worker.refresh_from_db()
        self.assertEqual(removed["offline"], 1)
        self.assertEqual(worker.state, CloudWorkerNode.State.OFFLINE)


class CloudRuntimePersistenceTests(TransactionTestCase):
    databases: ClassVar[set[str]] = {"default", "postgresql"}

    def test_dsh_binding_requires_a_cloud_workspace(self):
        from apps.services.common.db_router import postgres_app_db_alias
        from apps.tabtinspace.models import Device, Workspace
        from apps.tabtinspace.tests.fixtures import (
            create_test_organization,
            create_test_user,
        )

        db_alias = postgres_app_db_alias()
        user = create_test_user(prefix="dshlocal")
        organization = create_test_organization(owner=user, prefix="dshlocal")
        device = Device.objects.using(db_alias).create(
            organization=organization,
            user=user,
            name="Local Mac",
            device_type="electron",
            role="control",
            fingerprint=f"electron-{uuid4()}",
            status="online",
        )
        workspace = Workspace.objects.using(db_alias).create(
            organization=organization,
            device=device,
            name="Local Dev",
            working_dir="/tmp/local-dev",
            normalized_working_dir="/tmp/local-dev",
            working_dir_type="code",
            created_by=user,
        )

        with self.assertRaises(ServiceError) as caught:
            RuntimeBindingService().freeze_for_dispatch(
                workspace=workspace,
                thread_id="thread-local-dsh",
                harness="dsh",
            )
        self.assertEqual(caught.exception.code, "DSH_REQUIRES_CLOUD_WORKSPACE")

    def test_allocation_and_runtime_binding_persist_on_cloud_device(self):
        from apps.services.common.db_router import postgres_app_db_alias
        from apps.tabtinspace.models import Device, Workspace
        from apps.tabtinspace.tests.fixtures import (
            create_test_organization,
            create_test_user,
        )

        db_alias = postgres_app_db_alias()
        user = create_test_user(prefix="cloudrt")
        organization = create_test_organization(owner=user, prefix="cloudrt")
        device = Device.objects.using(db_alias).create(
            organization=organization,
            user=user,
            name="Cloud Workspace",
            device_type="cloud",
            role="control",
            fingerprint="cloud-allocation-test",
            status="online",
        )
        workspace = Workspace.objects.using(db_alias).create(
            organization=organization,
            device=device,
            name="Cloud Dev",
            working_dir="/workspace",
            normalized_working_dir="/workspace",
            working_dir_type="code",
            created_by=user,
        )
        worker = CloudWorkerNode.objects.using(db_alias).create(
            node_key="worker-test",
            name="Worker Test",
            edition="saas",
            state="ready",
            control_endpoint="http://worker.internal",
            protocol_version="1",
            runtime_version="test",
        )
        allocation = CloudRuntimeAllocation.objects.using(db_alias).create(
            request_key=uuid4(),
            workspace=workspace,
            worker=worker,
            device=device,
            state="ready",
            volume_ref="volume-test",
            runtime_image="ghcr.io/tabtin/cloud-runtime@sha256:test",
        )
        binding = RuntimeBinding.objects.using(db_alias).create(
            organization=organization,
            workspace=workspace,
            allocation=allocation,
            thread_id="thread-test",
            harness="dsh",
            driver_session_ref={"acp_session_id": "acp-test"},
            host_generation=allocation.generation,
        )

        self.assertEqual(binding.allocation_id, allocation.id)
        self.assertEqual(binding.host_generation, 1)
        self.assertEqual(derive_runtime_plane(device.device_type), "cloud")


@override_settings(
    TABTIN_EDITION="saas",
    TABTIN_CLOUD_RUNTIME_IMAGE=(
        "ghcr.io/tabtin/cloud-runtime@sha256:"
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    ),
    TABTIN_CLOUD_WORKER_PROTOCOL_VERSION="1",
    TABTIN_CLOUD_MAX_ACTIVE_WORKSPACES_PER_USER=1,
    TABTIN_CLOUD_RUNTIME_STORAGE_GB=2,
    TABTIN_CLOUD_WORKER_EDITION="saas",
)
class CloudWorkspaceServiceTests(TransactionTestCase):
    databases: ClassVar[set[str]] = {"default", "postgresql"}

    def setUp(self):
        from apps.services.common.db_router import postgres_app_db_alias
        from apps.tabtinspace.tests.fixtures import (
            create_test_organization,
            create_test_user,
        )

        self.db_alias = postgres_app_db_alias()
        self.user = create_test_user(prefix="cloudsvc")
        self.organization = create_test_organization(
            owner=self.user,
            prefix="cloudsvc",
            settings={"cloud_agent_enabled": True},
        )
        self.worker = CloudWorkerNode.objects.using(self.db_alias).create(
            node_key=f"worker-{uuid4()}",
            name="Worker",
            edition="saas",
            state="ready",
            control_endpoint="http://127.0.0.1:8090",
            protocol_version="1",
            runtime_version="test",
            capacity_cpu_millicores=4000,
            capacity_memory_mb=8192,
            capacity_storage_gb=40,
        )
        worker_settings = override_settings(
            TABTIN_CLOUD_WORKERS_JSON=json.dumps({
                self.worker.node_key: {
                    "endpoint": self.worker.control_endpoint,
                    "token": "test-worker-token",
                },
            })
        )
        worker_settings.enable()
        self.addCleanup(worker_settings.disable)
        self.service = CloudWorkspaceService(user=self.user)

    def test_create_is_idempotent_and_cloud_authoritative(self):
        request_key = uuid4()
        first = self.service.create_cloud_workspace(
            request_key=request_key,
            organization_id=self.organization.id,
            name="Cloud Dev",
        )
        second = self.service.create_cloud_workspace(
            request_key=request_key,
            organization_id=self.organization.id,
            name="Ignored on retry",
        )

        self.assertTrue(first.created)
        self.assertFalse(second.created)
        self.assertEqual(second.workspace.id, first.workspace.id)
        self.assertEqual(first.workspace.working_dir, "/workspace")
        self.assertEqual(first.workspace.device.device_type, "cloud")
        self.assertEqual(first.allocation.state, "pending")
        self.assertEqual(first.allocation.generation, 1)

    def test_cloud_state_collector_exposes_bounded_capacity_and_recovery_state(self):
        created = self.service.create_cloud_workspace(
            request_key=uuid4(),
            organization_id=self.organization.id,
            name="Metrics",
        )
        created.allocation.state = CloudRuntimeAllocation.State.READY
        created.allocation.save(update_fields=["state", "updated_at"])
        self.worker.last_heartbeat_at = timezone.now()
        self.worker.save(update_fields=["last_heartbeat_at", "updated_at"])
        RuntimeBindingService().freeze_for_dispatch(
            workspace=created.workspace,
            thread_id="thread-metrics",
            harness="dsh",
        )

        families = {
            family.name: family for family in CloudStateCollector().collect()
        }

        def value(family_name: str, labels: dict[str, str]) -> float:
            family = families[family_name]
            return next(
                sample.value
                for sample in family.samples
                if sample.labels == labels
            )

        self.assertEqual(
            value("tabtin_cloud_state_collection_success", {}),
            1,
        )
        self.assertEqual(
            value(
                "tabtin_cloud_worker_nodes",
                {"edition": "saas", "state": "ready"},
            ),
            1,
        )
        self.assertEqual(
            value("tabtin_cloud_allocations", {"state": "ready"}),
            1,
        )
        self.assertEqual(
            value(
                "tabtin_cloud_runtime_bindings",
                {"harness": "dsh", "state": "active"},
            ),
            1,
        )
        self.assertEqual(
            value(
                "tabtin_cloud_worker_capacity",
                {"node": self.worker.node_key, "resource": "cpu_millicores"},
            ),
            4000,
        )
        self.assertEqual(
            value(
                "tabtin_cloud_worker_allocated",
                {"node": self.worker.node_key, "resource": "cpu_millicores"},
            ),
            2000,
        )
        self.assertEqual(
            value(
                "tabtin_cloud_worker_allocated",
                {"node": self.worker.node_key, "resource": "storage_gb"},
            ),
            22,
        )

    def test_disabled_allocation_releases_compute_but_retains_both_volumes(self):
        created = self.service.create_cloud_workspace(
            request_key=uuid4(),
            organization_id=self.organization.id,
            name="Retained",
        )
        created.allocation.state = CloudRuntimeAllocation.State.DISABLED
        created.allocation.save(update_fields=["state", "updated_at"])

        usage = self.service._worker_usage(self.worker)

        self.assertEqual(usage, {"cpu": 0, "memory": 0, "storage": 22})
        self.worker.capacity_storage_gb = 43
        self.assertFalse(self.service._worker_has_capacity(self.worker))
        self.worker.capacity_storage_gb = 44
        self.assertTrue(self.service._worker_has_capacity(self.worker))

    @override_settings(
        TABTIN_EDITION="community",
        TABTIN_CLOUD_WORKER_EDITION="saas",
    )
    def test_hosted_cloud_pool_can_run_on_community_control_plane(self):
        with transaction.atomic(using=self.db_alias):
            selected = self.service._select_worker(self.organization)

        self.assertEqual(selected.id, self.worker.id)

    def test_saas_active_workspace_quota_is_enforced(self):
        self.service.create_cloud_workspace(
            request_key=uuid4(),
            organization_id=self.organization.id,
            name="First",
        )

        with self.assertRaises(ServiceError) as caught:
            self.service.create_cloud_workspace(
                request_key=uuid4(),
                organization_id=self.organization.id,
                name="Second",
            )
        self.assertEqual(caught.exception.code, "CLOUD_WORKSPACE_QUOTA_EXCEEDED")

    def test_git_source_rejects_inline_credentials(self):
        with self.assertRaises(ServiceError) as caught:
            self.service.create_cloud_workspace(
                request_key=uuid4(),
                organization_id=self.organization.id,
                name="Private Git",
                source_type="git",
                git_url="https://user:secret@example.com/repo.git",
            )
        self.assertEqual(
            caught.exception.code,
            "CLOUD_GIT_CREDENTIAL_INLINE_FORBIDDEN",
        )

    def test_private_git_accepts_only_the_current_users_personal_credential(self):
        credential = CloudGitCredentialService(user=self.user).upsert_github(
            organization_id=self.organization.id,
            token="github_pat_test_private_value",
        )
        created = self.service.create_cloud_workspace(
            request_key=uuid4(),
            organization_id=self.organization.id,
            name="Private Git",
            source_type="git",
            git_url="https://github.com/example/private.git",
            git_credential_ref=str(credential.id),
        )
        self.assertEqual(created.allocation.git_credential_ref, str(credential.id))

        with self.assertRaises(ServiceError) as wrong_host:
            self.service.create_cloud_workspace(
                request_key=uuid4(),
                organization_id=self.organization.id,
                name="Wrong host",
                source_type="git",
                git_url="https://example.com/private.git",
                git_credential_ref=str(credential.id),
            )
        self.assertEqual(
            wrong_host.exception.code,
            "CLOUD_GIT_CREDENTIAL_HOST_FORBIDDEN",
        )

        from apps.tabtinspace.tests.fixtures import create_test_user

        other_user = create_test_user(prefix="cloudother")
        with self.assertRaises(ServiceError) as caught:
            CloudGitCredentialService(user=other_user).require_owned(
                organization_id=self.organization.id,
                credential_ref=str(credential.id),
            )
        self.assertEqual(caught.exception.code, "CLOUD_GIT_CREDENTIAL_NOT_FOUND")

    def test_worker_provision_receives_secret_but_never_the_credential_ref(self):
        token = "github_pat_test_private_value"
        credential = CloudGitCredentialService(user=self.user).upsert_github(
            organization_id=self.organization.id,
            token=token,
        )
        created = self.service.create_cloud_workspace(
            request_key=uuid4(),
            organization_id=self.organization.id,
            name="Private Git",
            source_type="git",
            git_url="https://github.com/example/private.git",
            git_credential_ref=str(credential.id),
        )
        client = CloudWorkerClient()
        with (
            patch.object(client, "_request", return_value={"state": "running"}) as request,
            patch.object(
                DaemonTokenService,
                "create_cloud_install_token",
                return_value="bootstrap-token",
            ),
        ):
            client.provision(created.allocation)

        payload = request.call_args.args[3]
        self.assertEqual(
            payload["source"]["credential"],
            {"username": "x-access-token", "password": token},
        )
        self.assertNotIn("credentialRef", payload["source"])

    def test_attaching_personal_credential_requeues_existing_git_allocation(self):
        created = self.service.create_cloud_workspace(
            request_key=uuid4(),
            organization_id=self.organization.id,
            name="Retry Private Git",
            source_type="git",
            git_url="https://github.com/example/private.git",
        )
        created.allocation.state = CloudRuntimeAllocation.State.ERROR
        created.allocation.last_error = "git_source_unavailable"
        created.allocation.save(update_fields=["state", "last_error", "updated_at"])
        credential = CloudGitCredentialService(user=self.user).upsert_github(
            organization_id=self.organization.id,
            token="github_pat_test_private_value",
        )

        CloudWorkspaceLifecycleService(user=self.user).attach_git_credential(
            created.workspace.id,
            credential_ref=str(credential.id),
        )
        created.allocation.refresh_from_db()

        self.assertEqual(created.allocation.state, CloudRuntimeAllocation.State.PENDING)
        self.assertEqual(created.allocation.generation, 2)
        self.assertEqual(created.allocation.git_credential_ref, str(credential.id))
        self.assertEqual(created.allocation.last_error, "")

    def test_reconciler_waits_for_real_cloud_daemon_heartbeat_before_ready(self):
        created = self.service.create_cloud_workspace(
            request_key=uuid4(),
            organization_id=self.organization.id,
            name="Reconcile",
        )

        class SuccessClient:
            def provision(self, allocation):
                return {"state": "running", "generation": allocation.generation}

            def status(self, allocation):
                return {"state": "running", "generation": allocation.generation}

        reconciler = CloudAllocationReconciler(SuccessClient())
        outcome = reconciler.reconcile_one(
            created.allocation.id
        )
        created.allocation.refresh_from_db()
        created.workspace.device.refresh_from_db()

        self.assertEqual(outcome, "skipped")
        self.assertEqual(created.allocation.state, "provisioning")
        self.assertEqual(created.allocation.reconcile_attempts, 1)
        self.assertEqual(created.workspace.device.status, "offline")

        metadata = dict(created.workspace.device.metadata_json or {})
        metadata["daemon_activation_token_sha256"] = "activated"
        created.workspace.device.metadata_json = metadata
        created.workspace.device.status = "online"
        created.workspace.device.last_heartbeat_at = timezone.now()
        created.workspace.device.save(
            update_fields=[
                "metadata_json",
                "status",
                "last_heartbeat_at",
                "updated_at",
            ]
        )
        created.allocation.next_retry_at = timezone.now()
        created.allocation.save(update_fields=["next_retry_at", "updated_at"])

        result = reconciler.reconcile_due(limit=20)
        self.assertEqual(result["ready"], 1)
        created.allocation.refresh_from_db()
        self.assertEqual(created.allocation.state, "ready")
        self.assertEqual(created.allocation.reconcile_attempts, 0)
        self.assertEqual(created.workspace.device.status, "online")

    def test_reconciler_reprovisions_after_activation_heartbeat_deadline(self):
        created = self.service.create_cloud_workspace(
            request_key=uuid4(),
            organization_id=self.organization.id,
            name="Activation timeout",
        )

        class RunningClient:
            provision_calls = 0
            status_calls = 0

            def provision(self, allocation):
                self.provision_calls += 1
                return {"state": "running", "generation": allocation.generation}

            def status(self, allocation):
                self.status_calls += 1
                return {"state": "running", "generation": allocation.generation}

        client = RunningClient()
        reconciler = CloudAllocationReconciler(client)
        for _ in range(12):
            created.allocation.next_retry_at = timezone.now()
            created.allocation.save(update_fields=["next_retry_at", "updated_at"])
            self.assertEqual(reconciler.reconcile_one(created.allocation.id), "skipped")

        created.allocation.refresh_from_db()
        self.assertEqual(created.allocation.state, "error")
        self.assertEqual(created.allocation.reconcile_attempts, 0)
        self.assertIn("heartbeat deadline", created.allocation.last_error)

        self.assertEqual(reconciler.reconcile_one(created.allocation.id), "skipped")
        created.allocation.refresh_from_db()
        self.assertEqual(created.allocation.state, "provisioning")
        self.assertEqual(client.provision_calls, 2)
        self.assertEqual(client.status_calls, 11)

    def test_reconciler_failure_records_bounded_retry(self):
        created = self.service.create_cloud_workspace(
            request_key=uuid4(),
            organization_id=self.organization.id,
            name="Retry",
        )

        class FailingClient:
            def provision(self, allocation):
                raise RuntimeError("worker unavailable")

        outcome = CloudAllocationReconciler(FailingClient()).reconcile_one(
            created.allocation.id
        )
        created.allocation.refresh_from_db()

        self.assertEqual(outcome, "error")
        self.assertEqual(created.allocation.state, "error")
        self.assertEqual(created.allocation.reconcile_attempts, 1)
        self.assertIsNotNone(created.allocation.next_retry_at)

    @override_settings(
        DAEMON_CONTROL_ENABLED=False,
        DAEMON_TOKEN_SECRET="cloud-test-secret",
    )
    def test_community_cloud_token_activates_only_preprovisioned_device(self):
        created = self.service.create_cloud_workspace(
            request_key=uuid4(),
            organization_id=self.organization.id,
            name="Activation",
        )
        token = DaemonTokenService.create_cloud_install_token(created.allocation)
        service = DaemonTokenService()

        with (
            patch.object(service, "_claim_token", return_value=True),
            patch(
                "apps.tabtinspace.services.daemon_token_service._generate_daemon_access_token",
                return_value="access-token",
            ),
        ):
            result = service.activate_device(
                token,
                created.allocation.device.fingerprint,
                device_type="cloud",
            )
            mismatched = service.activate_device(
                token,
                created.allocation.device.fingerprint,
                device_type="daemon",
            )

        self.assertEqual(result["device_id"], str(created.allocation.device_id))
        self.assertIsNone(mismatched)
        created.allocation.device.refresh_from_db()
        self.assertEqual(
            created.allocation.device.metadata_json["cloud_generation"],
            created.allocation.generation,
        )
        self.assertIn(
            "daemon_activation_token_sha256",
            created.allocation.device.metadata_json,
        )

        created.allocation.generation = 2
        created.allocation.save(update_fields=["generation", "updated_at"])
        next_token = DaemonTokenService.create_cloud_install_token(
            created.allocation
        )
        with (
            patch.object(service, "_claim_token", return_value=True),
            patch(
                "apps.tabtinspace.services.daemon_token_service._generate_daemon_access_token",
                return_value="access-token-2",
            ),
        ):
            rotated = service.activate_device(
                next_token,
                created.allocation.device.fingerprint,
                device_type="cloud",
            )
            with self.assertRaises(DeviceFingerprintConflictError):
                service.activate_device(
                    token,
                    created.allocation.device.fingerprint,
                    device_type="cloud",
                )
        self.assertEqual(rotated["device_id"], str(created.allocation.device_id))

    def test_runtime_binding_is_idempotent_and_generation_fenced(self):
        created = self.service.create_cloud_workspace(
            request_key=uuid4(),
            organization_id=self.organization.id,
            name="Binding",
        )
        created.allocation.state = "ready"
        created.allocation.save(update_fields=["state", "updated_at"])
        service = RuntimeBindingService()

        first = service.freeze_for_dispatch(
            workspace=created.workspace,
            thread_id="thread-binding",
            harness="dsh",
        )
        second = service.freeze_for_dispatch(
            workspace=created.workspace,
            thread_id="thread-binding",
            harness="dsh",
        )

        self.assertEqual(first.id, second.id)
        self.assertEqual(second.revision, 1)
        self.assertEqual(second.driver_session_ref, {"session_id": "thread-binding"})

        created.allocation.generation = 2
        created.allocation.save(update_fields=["generation", "updated_at"])
        fenced = service.freeze_for_dispatch(
            workspace=created.workspace,
            thread_id="thread-binding",
            harness="dsh",
        )
        self.assertEqual(fenced.host_generation, 2)
        self.assertEqual(fenced.revision, 2)

    def test_runtime_binding_rejects_cloud_allocation_before_ready(self):
        created = self.service.create_cloud_workspace(
            request_key=uuid4(),
            organization_id=self.organization.id,
            name="Not Ready",
        )

        with self.assertRaises(ServiceError) as caught:
            RuntimeBindingService().freeze_for_dispatch(
                workspace=created.workspace,
                thread_id="thread-not-ready",
                harness="builtin",
            )
        self.assertEqual(caught.exception.code, "CLOUD_ALLOCATION_NOT_READY")

    def test_disable_preserves_allocation_then_restore_waits_for_heartbeat(self):
        created = self.service.create_cloud_workspace(
            request_key=uuid4(),
            organization_id=self.organization.id,
            name="Lifecycle",
        )
        created.allocation.state = "ready"
        created.allocation.save(update_fields=["state", "updated_at"])

        class WorkerClient:
            def disable(self, allocation):
                return {"state": "stopped", "generation": allocation.generation}

            def restart(self, allocation):
                return {"state": "running", "generation": allocation.generation}

        service = CloudWorkspaceLifecycleService(
            user=self.user,
            client=WorkerClient(),
        )
        service.disable(created.workspace.id)
        created.allocation.refresh_from_db()
        self.assertEqual(created.allocation.state, "disabled")
        self.assertIsNotNone(created.allocation.retention_deadline)

        service.restore(created.workspace.id)
        created.allocation.refresh_from_db()
        created.workspace.device.refresh_from_db()
        self.assertEqual(created.allocation.state, "provisioning")
        self.assertIsNone(created.allocation.retention_deadline)
        self.assertEqual(created.workspace.device.status, "offline")
        self.assertIsNone(created.workspace.device.last_heartbeat_at)

    def test_permanent_delete_requires_name_and_removes_binding(self):
        created = self.service.create_cloud_workspace(
            request_key=uuid4(),
            organization_id=self.organization.id,
            name="Delete Me",
        )
        created.allocation.state = "ready"
        created.allocation.save(update_fields=["state", "updated_at"])
        binding = RuntimeBindingService().freeze_for_dispatch(
            workspace=created.workspace,
            thread_id="thread-delete",
            harness="dsh",
        )

        class WorkerClient:
            def delete_permanently(self, allocation):
                return {"deleted": True}

        service = CloudWorkspaceLifecycleService(
            user=self.user,
            client=WorkerClient(),
        )
        with self.assertRaises(ServiceError) as caught:
            service.delete_permanently(
                created.workspace.id,
                confirmation="wrong",
            )
        self.assertEqual(
            caught.exception.code,
            "CLOUD_DELETE_CONFIRMATION_MISMATCH",
        )

        service.delete_permanently(
            created.workspace.id,
            confirmation="Delete Me",
        )
        self.assertFalse(Workspace.objects.filter(id=created.workspace.id).exists())
        self.assertFalse(RuntimeBinding.objects.filter(id=binding.id).exists())
