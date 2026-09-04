"""Community PostgreSQL role and capability installation boundary.

Only one-shot installation commands should import the environment entrypoints
in this module.  Web and Celery use ``tabtin_runtime`` and never receive init
or migrator credentials.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys

from tabtin.community_secrets import read_secret_file


@dataclass(frozen=True, slots=True)
class RoleSpec:
    login: bool
    inherit: bool = False
    superuser: bool = False
    create_db: bool = False
    create_role: bool = False
    bypass_rls: bool = False
    connection_limit: int = -1


class DatabaseInitializationState(StrEnum):
    EMPTY = "empty"
    EXISTING = "existing"


@dataclass(frozen=True, slots=True)
class BaselineManifest:
    format_version: int
    postgres_major: int
    stage: str
    migration_count: int
    table_count: int
    dump_path: Path
    toc_path: Path


ROLE_SPECS = {
    "tabtin_init": RoleSpec(login=True, superuser=True, connection_limit=2),
    "tabtin_migrator": RoleSpec(login=True, connection_limit=4),
    "tabtin_runtime": RoleSpec(login=True, connection_limit=100),
    "tabtin_native_ddl_owner": RoleSpec(login=False),
    "tabtin_record_index_owner": RoleSpec(login=False),
    "tabtin_readonly_role_admin": RoleSpec(login=False, create_role=True),
}

LOGIN_ROLE_NAMES = {
    "tabtin_init",
    "tabtin_migrator",
    "tabtin_runtime",
}

CAPABILITY_ROLE_NAMES = {
    "tabtin_native_ddl_owner",
    "tabtin_record_index_owner",
    "tabtin_readonly_role_admin",
}

COMMUNITY_DEV_MODE = "MUSE_COMMUNITY_DEV_MODE"


def _development_mode_enabled() -> bool:
    return os.environ.get(COMMUNITY_DEV_MODE) == "1"


_BASELINE_MANIFEST_NAME = "community-baseline.json"
_BASELINE_RESTORE_STATES = {"pending", "validated"}
_BASELINE_MANIFEST_KEYS = {
    "format_version",
    "postgres_major",
    "stage",
    "migration_count",
    "table_count",
    "dump_file",
    "toc_file",
    "dump_sha256",
    "toc_sha256",
}


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _baseline_artifact_path(root: Path, raw_name: object) -> Path:
    if not isinstance(raw_name, str) or not raw_name or Path(raw_name).name != raw_name:
        raise ValueError("invalid Community baseline artifact path")
    path = root / raw_name
    if not path.is_file():
        raise ValueError(f"missing Community baseline artifact: {raw_name}")
    return path


def load_baseline_manifest(root: Path, *, postgres_major: int) -> BaselineManifest:
    manifest_path = root / _BASELINE_MANIFEST_NAME
    try:
        raw = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ValueError("invalid Community baseline manifest") from exc
    if not isinstance(raw, dict) or set(raw) != _BASELINE_MANIFEST_KEYS:
        raise ValueError("invalid Community baseline manifest fields")
    if raw["format_version"] != 1:
        raise ValueError("unsupported Community baseline format version")
    if raw["postgres_major"] != postgres_major:
        raise ValueError(
            "Community baseline PostgreSQL major does not match the target server"
        )
    if raw["stage"] != "post_migrate_pre_bootstrap":
        raise ValueError("invalid Community baseline lifecycle stage")
    if not isinstance(raw["migration_count"], int) or raw["migration_count"] < 1:
        raise ValueError("invalid Community baseline migration count")
    if not isinstance(raw["table_count"], int) or raw["table_count"] < 1:
        raise ValueError("invalid Community baseline table count")

    dump_path = _baseline_artifact_path(root, raw["dump_file"])
    toc_path = _baseline_artifact_path(root, raw["toc_file"])
    for label, path, expected in (
        ("dump", dump_path, raw["dump_sha256"]),
        ("TOC", toc_path, raw["toc_sha256"]),
    ):
        if not isinstance(expected, str) or not re.fullmatch(r"[0-9a-f]{64}", expected):
            raise ValueError(f"invalid Community baseline {label} checksum")
        if _sha256(path) != expected:
            raise ValueError(f"Community baseline {label} checksum mismatch")

    return BaselineManifest(
        format_version=raw["format_version"],
        postgres_major=raw["postgres_major"],
        stage=raw["stage"],
        migration_count=raw["migration_count"],
        table_count=raw["table_count"],
        dump_path=dump_path,
        toc_path=toc_path,
    )


def classify_database(connection) -> DatabaseInitializationState:
    with connection.cursor() as cursor:
        cursor.execute(
            """
            SELECT
              to_regclass('public.django_migrations') IS NOT NULL,
              COUNT(*) FILTER (
                WHERE namespace.nspname = 'public'
                  AND relation.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
              )
            FROM pg_catalog.pg_class AS relation
            JOIN pg_catalog.pg_namespace AS namespace
              ON namespace.oid = relation.relnamespace
            """
        )
        has_history, relation_count = cursor.fetchone()
    if has_history:
        return DatabaseInitializationState.EXISTING
    if relation_count == 0:
        return DatabaseInitializationState.EMPTY
    raise RuntimeError(
        "Community database is non-empty but has no django_migrations history"
    )


def _migration_history_count(connection) -> int:
    with connection.cursor() as cursor:
        cursor.execute("SELECT COUNT(*) FROM public.django_migrations")
        row = cursor.fetchone()
    return int(row[0])


def _public_table_count(connection) -> int:
    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT COUNT(*) FROM pg_catalog.pg_tables WHERE schemaname = 'public'"
        )
        row = cursor.fetchone()
    return int(row[0])


def _baseline_restore_state(connection) -> str | None:
    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT to_regclass("
            "'tabtin_capability.community_database_baseline_state')"
        )
        if cursor.fetchone()[0] is None:
            return None
        cursor.execute(
            "SELECT state FROM "
            "tabtin_capability.community_database_baseline_state "
            "WHERE singleton = TRUE"
        )
        row = cursor.fetchone()
    if row is None or row[0] not in _BASELINE_RESTORE_STATES:
        raise RuntimeError("invalid Community baseline restore state")
    return str(row[0])


def _set_baseline_restore_state(connection, state: str) -> None:
    if state not in _BASELINE_RESTORE_STATES:
        raise ValueError("invalid Community baseline restore state")
    with connection.cursor() as cursor:
        cursor.execute(
            """
            CREATE TABLE IF NOT EXISTS
              tabtin_capability.community_database_baseline_state (
                singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
                state TEXT NOT NULL CHECK (state IN ('pending', 'validated')),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
              )
            """
        )
        cursor.execute(
            """
            INSERT INTO tabtin_capability.community_database_baseline_state
              (singleton, state, updated_at)
            VALUES (TRUE, %s, CURRENT_TIMESTAMP)
            ON CONFLICT (singleton) DO UPDATE
              SET state = EXCLUDED.state, updated_at = EXCLUDED.updated_at
            """,
            [state],
        )


def _role_options(spec: RoleSpec) -> str:
    return " ".join(
        (
            "LOGIN" if spec.login else "NOLOGIN",
            "INHERIT" if spec.inherit else "NOINHERIT",
            "SUPERUSER" if spec.superuser else "NOSUPERUSER",
            "CREATEDB" if spec.create_db else "NOCREATEDB",
            "CREATEROLE" if spec.create_role else "NOCREATEROLE",
            "BYPASSRLS" if spec.bypass_rls else "NOBYPASSRLS",
            f"CONNECTION LIMIT {spec.connection_limit}",
        )
    )


def _quoted_identifier(value: str, *, label: str) -> str:
    if not re.fullmatch(r"[a-z][a-z0-9_]{0,62}", value):
        raise ValueError(f"invalid {label}")
    return f'"{value}"'


def synchronize_roles(connection, *, database_name: str, passwords: dict[str, str]) -> None:
    """Idempotently converge roles and pre-migration grants."""
    if set(passwords) != LOGIN_ROLE_NAMES:
        raise ValueError("passwords must cover the three Community login roles")
    database = _quoted_identifier(database_name, label="database name")

    with connection.cursor() as cursor:
        for role_name, spec in ROLE_SPECS.items():
            role = _quoted_identifier(role_name, label="role name")
            cursor.execute("SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = %s", [role_name])
            verb = "ALTER ROLE" if cursor.fetchone() is not None else "CREATE ROLE"
            statement = f"{verb} {role} WITH {_role_options(spec)}"
            parameters = None
            if spec.login:
                statement += " PASSWORD %s"
                parameters = [passwords[role_name]]
            cursor.execute(statement, parameters)

        for granted_role in ROLE_SPECS:
            for member_role in ROLE_SPECS:
                if granted_role != member_role:
                    cursor.execute(f'REVOKE "{granted_role}" FROM "{member_role}"')

        cursor.execute(f'ALTER DATABASE {database} OWNER TO "tabtin_init"')
        cursor.execute(f"REVOKE ALL ON DATABASE {database} FROM PUBLIC")
        cursor.execute(
            f'GRANT CONNECT, CREATE, TEMPORARY ON DATABASE {database} TO "tabtin_migrator"'
        )
        cursor.execute(f'GRANT CONNECT ON DATABASE {database} TO "tabtin_runtime"')
        cursor.execute(f'REVOKE TEMPORARY ON DATABASE {database} FROM "tabtin_runtime"')
        cursor.execute(
            f'GRANT CREATE ON DATABASE {database} TO "tabtin_native_ddl_owner"'
        )
        cursor.execute(
            f'GRANT CONNECT ON DATABASE {database} TO "tabtin_readonly_role_admin" WITH GRANT OPTION'
        )
        cursor.execute(
            f'REVOKE TEMPORARY ON DATABASE {database} FROM "tabtin_readonly_role_admin"'
        )

        cursor.execute("CREATE EXTENSION IF NOT EXISTS vector")
        cursor.execute("CREATE EXTENSION IF NOT EXISTS pg_trgm")
        cursor.execute("REVOKE ALL ON SCHEMA public FROM PUBLIC")
        cursor.execute('GRANT USAGE, CREATE ON SCHEMA public TO "tabtin_migrator"')
        # ``safe_migrate`` performs a read-only schema integrity check after
        # applying migrations.  Finalization hands selected objects to narrow
        # capability owners, so an idempotent restart must restore this
        # explicit inspection grant before running that check again.
        cursor.execute(
            'GRANT SELECT ON ALL TABLES IN SCHEMA public TO "tabtin_migrator"'
        )
        cursor.execute('GRANT USAGE ON SCHEMA public TO "tabtin_runtime"')
        cursor.execute(
            "CREATE SCHEMA IF NOT EXISTS tabtin_capability AUTHORIZATION tabtin_init"
        )
        cursor.execute("REVOKE ALL ON SCHEMA tabtin_capability FROM PUBLIC")
        for role_name in (*sorted(CAPABILITY_ROLE_NAMES), "tabtin_runtime"):
            cursor.execute(f'GRANT USAGE ON SCHEMA tabtin_capability TO "{role_name}"')

        cursor.execute(
            'ALTER DEFAULT PRIVILEGES FOR ROLE "tabtin_migrator" IN SCHEMA public '
            "REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC"
        )
        cursor.execute(
            'ALTER DEFAULT PRIVILEGES FOR ROLE "tabtin_migrator" IN SCHEMA public '
            'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO "tabtin_runtime"'
        )
        cursor.execute(
            'ALTER DEFAULT PRIVILEGES FOR ROLE "tabtin_migrator" IN SCHEMA public '
            'GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO "tabtin_runtime"'
        )


def finalize_database(connection, *, sql_root: Path) -> tuple[str, ...]:
    sql_files = tuple(sorted(sql_root.glob("*.sql")))
    if not sql_files:
        raise ValueError("Community database finalization SQL is missing")
    with connection.cursor() as cursor:
        for sql_file in sql_files:
            cursor.execute(sql_file.read_text(encoding="utf-8"))
    return tuple(sql_file.name for sql_file in sql_files)


def _required_path(name: str) -> Path:
    value = os.environ.get(name, "")
    if not value:
        raise ValueError(f"missing required file setting: {name}")
    return Path(value)


def _passwords_from_files() -> dict[str, str]:
    return {
        "tabtin_init": read_secret_file(_required_path("PG_INIT_PASSWORD_FILE"), label="init"),
        "tabtin_migrator": read_secret_file(
            _required_path("PG_MIGRATOR_PASSWORD_FILE"), label="migrator"
        ),
        "tabtin_runtime": read_secret_file(
            _required_path("PG_RUNTIME_PASSWORD_FILE"), label="runtime"
        ),
    }


def _passwords_from_environment() -> dict[str, str]:
    """Use the compose admin password only for the explicit local-dev path."""
    if not _development_mode_enabled():
        return _passwords_from_files()
    password = os.environ.get("PG_DB_PASSWORD", "")
    if not password:
        raise ValueError("missing required development setting: PG_DB_PASSWORD")
    return {role_name: password for role_name in LOGIN_ROLE_NAMES}


def _connect_as_init():
    import psycopg2

    if _development_mode_enabled():
        user = os.environ.get("PG_DB_USER", "tabtin")
        password = os.environ.get("PG_DB_PASSWORD", "")
        if not password:
            raise ValueError("missing required development setting: PG_DB_PASSWORD")
        return psycopg2.connect(
            dbname=os.environ.get("PG_DB_NAME", "tabtin"),
            user=user,
            password=password,
            host=os.environ.get("PG_DB_HOST", "127.0.0.1"),
            port=int(os.environ.get("PG_DB_PORT", "5432")),
            connect_timeout=10,
        )

    return psycopg2.connect(
        dbname=os.environ.get("PG_DB_NAME", "tabtin"),
        user="tabtin_init",
        password=_passwords_from_files()["tabtin_init"],
        host=os.environ.get("PG_DB_HOST", "/var/run/postgresql"),
        port=int(os.environ.get("PG_DB_PORT", "5432")),
        connect_timeout=10,
    )


def synchronize_from_environment() -> None:
    passwords = _passwords_from_environment()
    with _connect_as_init() as connection:
        synchronize_roles(
            connection,
            database_name=os.environ.get("PG_DB_NAME", "tabtin"),
            passwords=passwords,
        )
    print("[community-database] roles synchronized")


def restore_baseline_from_environment() -> str:
    with _connect_as_init() as connection:
        state = classify_database(connection)
        restore_state = _baseline_restore_state(connection)
        postgres_major = int(connection.server_version) // 10000
    if restore_state == "pending" and state is DatabaseInitializationState.EXISTING:
        raise RuntimeError(
            "Community baseline restore is pending on a non-empty database; "
            "manual recovery is required"
        )
    if restore_state == "validated" and state is DatabaseInitializationState.EMPTY:
        raise RuntimeError(
            "Community baseline restore is validated but the database is empty; "
            "manual recovery is required"
        )
    if state is DatabaseInitializationState.EXISTING:
        print("[community-database] existing migration-managed database; baseline skipped")
        return "existing"

    baseline_root = Path(
        os.environ.get(
            "MUSE_COMMUNITY_DATABASE_BASELINE_ROOT",
            "/app/community-assets/postgres/baseline",
        )
    )
    manifest = load_baseline_manifest(
        baseline_root,
        postgres_major=postgres_major,
    )
    pg_restore = shutil.which("pg_restore")
    if not pg_restore:
        raise RuntimeError("pg_restore is required for Community baseline restore")

    passwords = _passwords_from_files()
    with _connect_as_init() as connection:
        _set_baseline_restore_state(connection, "pending")
    command = [
        pg_restore,
        "--host",
        os.environ.get("PG_DB_HOST", "/var/run/postgresql"),
        "--port",
        os.environ.get("PG_DB_PORT", "5432"),
        "--username",
        "tabtin_migrator",
        "--dbname",
        os.environ.get("PG_DB_NAME", "tabtin"),
        "--single-transaction",
        "--exit-on-error",
        "--no-owner",
        "--no-privileges",
        "--use-list",
        str(manifest.toc_path),
        str(manifest.dump_path),
    ]
    child_environment = os.environ.copy()
    child_environment["PGPASSWORD"] = passwords["tabtin_migrator"]
    subprocess.run(command, check=True, env=child_environment)

    with _connect_as_init() as connection:
        restored_migrations = _migration_history_count(connection)
        restored_tables = _public_table_count(connection)
        if restored_migrations != manifest.migration_count:
            raise RuntimeError(
                "Community baseline migration history count mismatch: "
                f"expected={manifest.migration_count} actual={restored_migrations}"
            )
        if restored_tables != manifest.table_count:
            raise RuntimeError(
                "Community baseline table count mismatch: "
                f"expected={manifest.table_count} actual={restored_tables}"
            )
        _set_baseline_restore_state(connection, "validated")
    print(
        "[community-database] baseline restored "
        f"migrations={restored_migrations} tables={restored_tables} "
        f"postgres={postgres_major}"
    )
    return "restored"


def finalize_from_environment() -> None:
    sql_root = Path(
        os.environ.get(
            "MUSE_COMMUNITY_DATABASE_SQL_ROOT",
            "/opt/tabtin/postgres-community",
        )
    )
    with _connect_as_init() as connection:
        executed = finalize_database(connection, sql_root=sql_root)
    print(f"[community-database] finalized scripts={len(executed)}")


def verify_capabilities(connection) -> tuple[str, ...]:
    """Fail fast when the native DDL boundary is not installed."""
    with connection.cursor() as cursor:
        cursor.execute(
            """
            SELECT
              pg_catalog.to_regnamespace('tabtin_capability') IS NOT NULL,
              pg_catalog.to_regprocedure(
                'tabtin_capability.native_ensure_schema(uuid)'
              ) IS NOT NULL,
              pg_catalog.to_regprocedure(
                'tabtin_capability.native_create_table(uuid,uuid,jsonb)'
              ) IS NOT NULL
            """
        )
        present = cursor.fetchone() or (False, False, False)

    checks = (
        ("tabtin_capability schema", bool(present[0])),
        ("native_ensure_schema(uuid)", bool(present[1])),
        ("native_create_table(uuid,uuid,jsonb)", bool(present[2])),
    )
    missing = tuple(name for name, is_present in checks if not is_present)
    if missing:
        raise RuntimeError(
            "Community database capability installation is incomplete: "
            + ", ".join(missing)
        )
    return tuple(name for name, _ in checks)


def verify_from_environment() -> None:
    with _connect_as_init() as connection:
        verified = verify_capabilities(connection)
    print(f"[community-database] capabilities verified={len(verified)}")


def main() -> None:
    action = sys.argv[1] if len(sys.argv) > 1 else ""
    if action == "sync":
        synchronize_from_environment()
        return
    if action == "restore-baseline":
        restore_baseline_from_environment()
        return
    if action == "finalize":
        finalize_from_environment()
        return
    if action == "verify":
        verify_from_environment()
        return
    raise SystemExit(
        "usage: python -m tabtin.community_database "
        "{sync|restore-baseline|finalize|verify}"
    )


if __name__ == "__main__":
    main()
