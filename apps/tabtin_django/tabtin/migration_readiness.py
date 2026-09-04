"""Fail closed when an ASGI process starts against an unapplied schema."""

from __future__ import annotations

from collections.abc import Iterable

from django.conf import settings
from django.db import connections
from django.db.migrations.executor import MigrationExecutor


def list_pending_migrations(
    database_aliases: Iterable[str] | None = None,
) -> dict[str, list[str]]:
    """Return forward migrations that still need to be applied per database."""
    aliases = list(
        database_aliases
        or getattr(settings, "MUSE_MIGRATION_DATABASE_ALIASES", None)
        or connections.databases.keys()
    )
    pending: dict[str, list[str]] = {}
    for alias in aliases:
        executor = MigrationExecutor(connections[alias])
        targets = executor.loader.graph.leaf_nodes()
        plan = executor.migration_plan(targets)
        forward = [
            f"{migration.app_label}.{migration.name}"
            for migration, backwards in plan
            if not backwards
        ]
        if forward:
            pending[alias] = forward
    return pending


def assert_database_schema_ready() -> None:
    """Prevent Daphne from serving traffic against a partially migrated DB."""
    pending = list_pending_migrations()
    if not pending:
        return
    summary = "; ".join(
        f"{alias}=[{', '.join(items[:10])}{', ...' if len(items) > 10 else ''}]"
        for alias, items in pending.items()
    )
    raise RuntimeError(
        "Database schema is not ready; unapplied migrations: "
        f"{summary}. Run `venv/bin/python manage.py safe_migrate --no-input` "
        "before starting Daphne."
    )
