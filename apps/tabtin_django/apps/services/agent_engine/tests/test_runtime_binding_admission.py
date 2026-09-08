"""Runtime admission contracts; ORM mocked and database access forbidden."""

from types import SimpleNamespace
from unittest.mock import patch

from django.test import SimpleTestCase

from apps.services.agent_engine.runtime_binding_service import RuntimeBindingService
from apps.tabtinspace.services.base import ServiceError


class RuntimeBindingAdmissionTests(SimpleTestCase):
    def setUp(self):
        binding_patch = patch(
            "apps.services.agent_engine.runtime_binding_service.RuntimeBinding.objects"
        )
        allocation_patch = patch(
            "apps.services.agent_engine.runtime_binding_service.CloudRuntimeAllocation.objects"
        )
        self.bindings = binding_patch.start()
        self.allocations = allocation_patch.start()
        self.addCleanup(binding_patch.stop)
        self.addCleanup(allocation_patch.stop)
        self.bindings.select_for_update.return_value.filter.return_value.first.return_value = None
        self.allocation_query = self.allocations.select_for_update.return_value.filter.return_value

    def freeze(self, device_type, harness="dsh"):
        workspace = SimpleNamespace(
            device=SimpleNamespace(device_type=device_type),
            device_id="device-1", organization_id="org-1",
        )
        # Exercise admission and persistence arguments without opening the
        # transaction decorator's database connection. PG persistence has its
        # own integration test in test_cloud_runtime_models.py.
        return RuntimeBindingService.freeze_for_dispatch.__wrapped__(
            RuntimeBindingService(), workspace=workspace,
            thread_id="thread-1", harness=harness,
        )

    def test_local_electron_creates_dsh_binding_without_cloud_allocation(self):
        result = self.freeze("electron")
        self.assertIs(result, self.bindings.create.return_value)
        values = self.bindings.create.call_args.kwargs
        self.assertEqual(values["harness"], "dsh")
        self.assertEqual(values["driver_session_ref"], {"session_id": "thread-1"})
        self.assertEqual(values["host_generation"], 1)
        self.assertIsNone(values["allocation"])
        self.allocations.select_for_update.assert_not_called()

    def test_local_daemon_dsh_is_explicitly_rejected(self):
        with self.assertRaises(ServiceError) as caught:
            self.freeze("daemon")
        self.assertEqual(caught.exception.code, "DSH_HOST_UNSUPPORTED")
        self.bindings.create.assert_not_called()

    def test_local_daemon_builtin_remains_supported(self):
        self.freeze("daemon", harness="builtin")
        self.assertEqual(self.bindings.create.call_args.kwargs["harness"], "builtin")

    def test_cloud_still_requires_allocation_device_and_readiness(self):
        cases = [
            (None, "CLOUD_ALLOCATION_NOT_FOUND"),
            (SimpleNamespace(device_id="other", state="ready"), "CLOUD_ALLOCATION_DEVICE_MISMATCH"),
            (SimpleNamespace(device_id="device-1", state="provisioning"), "CLOUD_ALLOCATION_NOT_READY"),
        ]
        for allocation, code in cases:
            with self.subTest(code=code):
                self.allocation_query.first.return_value = allocation
                with self.assertRaises(ServiceError) as caught:
                    self.freeze("cloud")
                self.assertEqual(caught.exception.code, code)
        self.bindings.create.assert_not_called()

    def test_ready_cloud_retains_allocation_generation(self):
        allocation = SimpleNamespace(device_id="device-1", state="ready", generation=8)
        self.allocation_query.first.return_value = allocation
        self.freeze("cloud")
        values = self.bindings.create.call_args.kwargs
        self.assertIs(values["allocation"], allocation)
        self.assertEqual(values["host_generation"], 8)
