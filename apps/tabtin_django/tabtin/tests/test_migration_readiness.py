from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from django.test import SimpleTestCase, override_settings

from tabtin.migration_readiness import (
    assert_database_schema_ready,
    list_pending_migrations,
)


class MigrationReadinessTests(SimpleTestCase):
    @override_settings(MUSE_MIGRATION_DATABASE_ALIASES=["default"])
    @patch("tabtin.migration_readiness.MigrationExecutor")
    def test_returns_pending_forward_migrations(self, executor_cls):
        executor = MagicMock()
        executor.loader.graph.leaf_nodes.return_value = [("meetings", "0001_initial")]
        executor.migration_plan.return_value = [
            (SimpleNamespace(app_label="meetings", name="0001_initial"), False),
        ]
        executor_cls.return_value = executor

        self.assertEqual(
            list_pending_migrations(),
            {"default": ["meetings.0001_initial"]},
        )

    @override_settings(MUSE_MIGRATION_DATABASE_ALIASES=["default"])
    @patch("tabtin.migration_readiness.MigrationExecutor")
    def test_ignores_reverse_plan_entries(self, executor_cls):
        executor = MagicMock()
        executor.loader.graph.leaf_nodes.return_value = []
        executor.migration_plan.return_value = [
            (SimpleNamespace(app_label="legacy", name="0002_old"), True),
        ]
        executor_cls.return_value = executor

        self.assertEqual(list_pending_migrations(), {})

    @override_settings(MUSE_MIGRATION_DATABASE_ALIASES=["default"])
    @patch("tabtin.migration_readiness.list_pending_migrations")
    def test_fail_fast_message_points_to_safe_migrate(self, list_pending):
        list_pending.return_value = {"default": ["meetings.0001_initial"]}

        with self.assertRaisesRegex(RuntimeError, "safe_migrate"):
            assert_database_schema_ready()

    @override_settings(MUSE_MIGRATION_DATABASE_ALIASES=["default"])
    @patch("tabtin.migration_readiness.list_pending_migrations", return_value={})
    def test_ready_schema_does_not_raise(self, _list_pending):
        assert_database_schema_ready()
