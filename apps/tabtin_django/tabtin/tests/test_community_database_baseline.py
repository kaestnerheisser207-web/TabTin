from __future__ import annotations

import hashlib
import json
from pathlib import Path
import subprocess

import pytest

from tabtin.community_database import (
    DatabaseInitializationState,
    classify_database,
    load_baseline_manifest,
    restore_baseline_from_environment,
)


class _ClassificationCursor:
    def __init__(self, *, has_history: bool, relation_count: int) -> None:
        self._result = (has_history, relation_count)

    def __enter__(self):
        return self

    def __exit__(self, *_args) -> None:
        return None

    def execute(self, _statement) -> None:
        return None

    def fetchone(self):
        return self._result


class _ClassificationConnection:
    def __init__(self, *, has_history: bool, relation_count: int) -> None:
        self._cursor = _ClassificationCursor(
            has_history=has_history,
            relation_count=relation_count,
        )

    def cursor(self) -> _ClassificationCursor:
        return self._cursor


def _write_manifest(root: Path, *, postgres_major: int = 16) -> None:
    dump = root / "community-baseline.dump"
    toc = root / "community-baseline.list"
    dump.write_bytes(b"baseline-dump")
    toc.write_text("baseline-toc\n", encoding="utf-8")
    manifest = {
        "format_version": 1,
        "postgres_major": postgres_major,
        "stage": "post_migrate_pre_bootstrap",
        "migration_count": 1026,
        "table_count": 341,
        "dump_file": dump.name,
        "toc_file": toc.name,
        "dump_sha256": hashlib.sha256(dump.read_bytes()).hexdigest(),
        "toc_sha256": hashlib.sha256(toc.read_bytes()).hexdigest(),
    }
    (root / "community-baseline.json").write_text(
        json.dumps(manifest),
        encoding="utf-8",
    )


def test_classify_database_accepts_only_empty_or_migration_managed_schema() -> None:
    empty = _ClassificationConnection(has_history=False, relation_count=0)
    existing = _ClassificationConnection(has_history=True, relation_count=341)

    assert classify_database(empty) is DatabaseInitializationState.EMPTY
    assert classify_database(existing) is DatabaseInitializationState.EXISTING


def test_classify_database_rejects_nonempty_schema_without_migration_history() -> None:
    connection = _ClassificationConnection(has_history=False, relation_count=1)

    with pytest.raises(RuntimeError, match="non-empty.*django_migrations"):
        classify_database(connection)


def test_load_baseline_manifest_verifies_version_paths_and_checksums(
    tmp_path: Path,
) -> None:
    _write_manifest(tmp_path)

    manifest = load_baseline_manifest(tmp_path, postgres_major=16)

    assert manifest.migration_count == 1026
    assert manifest.table_count == 341
    assert manifest.dump_path == tmp_path / "community-baseline.dump"
    assert manifest.toc_path == tmp_path / "community-baseline.list"


def test_load_baseline_manifest_rejects_postgresql_major_mismatch(
    tmp_path: Path,
) -> None:
    _write_manifest(tmp_path, postgres_major=16)

    with pytest.raises(ValueError, match="PostgreSQL major"):
        load_baseline_manifest(tmp_path, postgres_major=17)


def test_load_baseline_manifest_rejects_checksum_mismatch(tmp_path: Path) -> None:
    _write_manifest(tmp_path)
    (tmp_path / "community-baseline.dump").write_bytes(b"corrupt")

    with pytest.raises(ValueError, match="checksum"):
        load_baseline_manifest(tmp_path, postgres_major=16)


def test_load_baseline_manifest_rejects_paths_outside_artifact_root(
    tmp_path: Path,
) -> None:
    _write_manifest(tmp_path)
    manifest_path = tmp_path / "community-baseline.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["dump_file"] = "../outside.dump"
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")

    with pytest.raises(ValueError, match="artifact path"):
        load_baseline_manifest(tmp_path, postgres_major=16)


class _ServerConnection:
    server_version = 160011

    def __enter__(self):
        return self

    def __exit__(self, *_args) -> None:
        return None


def test_restore_baseline_skips_existing_migration_managed_database(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        "tabtin.community_database._connect_as_init",
        lambda: _ServerConnection(),
    )
    monkeypatch.setattr(
        "tabtin.community_database.classify_database",
        lambda _connection: DatabaseInitializationState.EXISTING,
    )
    monkeypatch.setattr(
        "tabtin.community_database._baseline_restore_state",
        lambda _connection: None,
    )
    monkeypatch.setattr(
        subprocess,
        "run",
        lambda *_args, **_kwargs: pytest.fail("existing database must not restore"),
    )

    assert restore_baseline_from_environment() == "existing"


def test_restore_baseline_rejects_existing_database_with_pending_restore(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        "tabtin.community_database._connect_as_init",
        lambda: _ServerConnection(),
    )
    monkeypatch.setattr(
        "tabtin.community_database.classify_database",
        lambda _connection: DatabaseInitializationState.EXISTING,
    )
    monkeypatch.setattr(
        "tabtin.community_database._baseline_restore_state",
        lambda _connection: "pending",
    )
    monkeypatch.setattr(
        subprocess,
        "run",
        lambda *_args, **_kwargs: pytest.fail("pending restore must fail closed"),
    )

    with pytest.raises(RuntimeError, match="pending.*manual recovery"):
        restore_baseline_from_environment()


def test_restore_baseline_uses_transactional_filtered_restore(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _write_manifest(tmp_path)
    calls: list[tuple[list[str], dict]] = []

    monkeypatch.setenv("MUSE_COMMUNITY_DATABASE_BASELINE_ROOT", str(tmp_path))
    monkeypatch.setenv("PG_DB_NAME", "tabtin")
    monkeypatch.setenv("PG_DB_HOST", "postgres")
    monkeypatch.setenv("PG_DB_PORT", "5432")
    monkeypatch.setattr(
        "tabtin.community_database._connect_as_init",
        lambda: _ServerConnection(),
    )
    monkeypatch.setattr(
        "tabtin.community_database.classify_database",
        lambda _connection: DatabaseInitializationState.EMPTY,
    )
    monkeypatch.setattr(
        "tabtin.community_database._baseline_restore_state",
        lambda _connection: None,
    )
    monkeypatch.setattr(
        "tabtin.community_database._passwords_from_files",
        lambda: {
            "tabtin_init": "init-secret",
            "tabtin_migrator": "migrator-secret",
            "tabtin_runtime": "runtime-secret",
        },
    )
    monkeypatch.setattr(
        "tabtin.community_database._migration_history_count",
        lambda _connection: 1026,
    )
    monkeypatch.setattr(
        "tabtin.community_database._public_table_count",
        lambda _connection: 341,
    )
    monkeypatch.setattr(
        "tabtin.community_database.shutil.which",
        lambda command: "/usr/bin/pg_restore" if command == "pg_restore" else None,
    )

    def _record(command: list[str], **kwargs) -> None:
        calls.append((command, kwargs))

    monkeypatch.setattr(subprocess, "run", _record)
    restore_states: list[str] = []
    monkeypatch.setattr(
        "tabtin.community_database._set_baseline_restore_state",
        lambda _connection, state: restore_states.append(state),
    )

    assert restore_baseline_from_environment() == "restored"
    assert len(calls) == 1
    command, kwargs = calls[0]
    assert command == [
        "/usr/bin/pg_restore",
        "--host",
        "postgres",
        "--port",
        "5432",
        "--username",
        "tabtin_migrator",
        "--dbname",
        "tabtin",
        "--single-transaction",
        "--exit-on-error",
        "--no-owner",
        "--no-privileges",
        "--use-list",
        str(tmp_path / "community-baseline.list"),
        str(tmp_path / "community-baseline.dump"),
    ]
    assert kwargs["check"] is True
    assert kwargs["env"]["PGPASSWORD"] == "migrator-secret"
    assert "migrator-secret" not in command
    assert restore_states == ["pending", "validated"]


def test_restore_baseline_rejects_restored_table_count_mismatch(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _write_manifest(tmp_path)
    monkeypatch.setenv("MUSE_COMMUNITY_DATABASE_BASELINE_ROOT", str(tmp_path))
    monkeypatch.setattr(
        "tabtin.community_database._connect_as_init",
        lambda: _ServerConnection(),
    )
    monkeypatch.setattr(
        "tabtin.community_database.classify_database",
        lambda _connection: DatabaseInitializationState.EMPTY,
    )
    monkeypatch.setattr(
        "tabtin.community_database._baseline_restore_state",
        lambda _connection: None,
    )
    monkeypatch.setattr(
        "tabtin.community_database._passwords_from_files",
        lambda: {
            "tabtin_init": "init-secret",
            "tabtin_migrator": "migrator-secret",
            "tabtin_runtime": "runtime-secret",
        },
    )
    monkeypatch.setattr(
        "tabtin.community_database._migration_history_count",
        lambda _connection: 1026,
    )
    monkeypatch.setattr(
        "tabtin.community_database._public_table_count",
        lambda _connection: 340,
    )
    monkeypatch.setattr(
        "tabtin.community_database.shutil.which",
        lambda _command: "/usr/bin/pg_restore",
    )
    monkeypatch.setattr(subprocess, "run", lambda *_args, **_kwargs: None)
    restore_states: list[str] = []
    monkeypatch.setattr(
        "tabtin.community_database._set_baseline_restore_state",
        lambda _connection, state: restore_states.append(state),
    )

    with pytest.raises(RuntimeError, match="table count mismatch"):
        restore_baseline_from_environment()
    assert restore_states == ["pending"]


def test_restore_baseline_failure_is_not_retried_or_fallbacked(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _write_manifest(tmp_path)
    calls = 0

    monkeypatch.setenv("MUSE_COMMUNITY_DATABASE_BASELINE_ROOT", str(tmp_path))
    monkeypatch.setattr(
        "tabtin.community_database._connect_as_init",
        lambda: _ServerConnection(),
    )
    monkeypatch.setattr(
        "tabtin.community_database.classify_database",
        lambda _connection: DatabaseInitializationState.EMPTY,
    )
    monkeypatch.setattr(
        "tabtin.community_database._baseline_restore_state",
        lambda _connection: None,
    )
    monkeypatch.setattr(
        "tabtin.community_database._passwords_from_files",
        lambda: {
            "tabtin_init": "init-secret",
            "tabtin_migrator": "migrator-secret",
            "tabtin_runtime": "runtime-secret",
        },
    )
    monkeypatch.setattr(
        "tabtin.community_database.shutil.which",
        lambda _command: "/usr/bin/pg_restore",
    )
    restore_states: list[str] = []
    monkeypatch.setattr(
        "tabtin.community_database._set_baseline_restore_state",
        lambda _connection, state: restore_states.append(state),
    )

    def _fail(*_args, **_kwargs) -> None:
        nonlocal calls
        calls += 1
        raise subprocess.CalledProcessError(1, "pg_restore")

    monkeypatch.setattr(subprocess, "run", _fail)

    with pytest.raises(subprocess.CalledProcessError):
        restore_baseline_from_environment()
    assert calls == 1
    assert restore_states == ["pending"]
