from __future__ import annotations

import hashlib
import json
from pathlib import Path

import yaml


ROOT = Path(__file__).resolve().parents[2]


def _compose() -> dict:
    return yaml.safe_load((ROOT / "compose.yaml").read_text(encoding="utf-8"))


def test_six_service_installation_is_serial_and_runtime_only() -> None:
    compose = _compose()
    services = compose["services"]
    assert set(services) == {
        "postgres",
        "redis",
        "django",
        "celery",
        "celery-beat",
        "centrifugo",
    }

    django = services["django"]
    celery = services["celery"]
    celery_beat = services["celery-beat"]
    assert django["command"] == ["community-web"]
    assert django["user"] == "0:0"
    assert celery["command"] == ["worker"]
    assert celery["user"] == "10001:10001"
    assert celery_beat["command"] == ["beat"]
    assert celery_beat["user"] == "10001:10001"
    assert services["centrifugo"]["user"] == "10001:10001"

    runtime_environment = celery["environment"]
    assert runtime_environment["PG_DB_USER"] == "tabtin_runtime"
    assert runtime_environment["PG_DB_PASSWORD_FILE"].endswith("PG_RUNTIME_PASSWORD")
    assert "PG_INIT_PASSWORD_FILE" not in runtime_environment
    assert "PG_MIGRATOR_PASSWORD_FILE" not in runtime_environment
    assert django["env_file"] == ["./.env.community-runtime"]
    assert celery["env_file"] == ["./.env.community-runtime"]
    assert celery_beat["env_file"] == ["./.env.community-runtime"]
    for key in ("OPENAI_API_KEY", "AWS_SECRET_ACCESS_KEY"):
        assert key not in django["environment"]
        assert key not in celery["environment"]
        assert key not in celery_beat["environment"]
    assert not any("/.env:" in volume for volume in django["volumes"])
    assert not any("/.env:" in volume for volume in celery["volumes"])
    assert not any("/.env:" in volume for volume in celery_beat["volumes"])

    entrypoint = (
        ROOT / "apps/tabtin_django/docker-entrypoint.sh"
    ).read_text(encoding="utf-8")
    initializer = entrypoint.index("initialize_community_database() {")
    ordered_steps = (
        "python -m tabtin.community_secrets init",
        "python -m tabtin.community_database sync",
        "python -m tabtin.community_database restore-baseline",
        "safe_migrate --noinput",
        "python -m tabtin.community_database finalize",
        "tabtin_bootstrap --edition community",
    )
    positions = [entrypoint.index(step, initializer) for step in ordered_steps]
    assert positions == sorted(positions)
    assert "migrate --check" not in entrypoint
    for case_name in ("community-dev-web)", "community-web)"):
        case_start = entrypoint.index(case_name)
        case_end = entrypoint.index(";;", case_start)
        assert "initialize_community_database" in entrypoint[case_start:case_end]


def test_community_assets_are_self_contained_and_compose_has_no_fixed_secret() -> None:
    raw = (ROOT / "compose.yaml").read_text(encoding="utf-8")
    dockerfile = (
        ROOT / "apps/tabtin_django/Dockerfile"
    ).read_text(encoding="utf-8")

    assert "COPY community-assets/postgres /app/community-assets/postgres" in dockerfile
    assert "FROM ${POSTGRES_CLIENT_IMAGE} AS postgres-client" in dockerfile
    assert (
        "COPY --from=postgres-client /usr/lib/postgresql/16/bin/pg_restore "
        "/usr/local/bin/pg_restore"
    ) in dockerfile
    assert "postgresql-client" not in dockerfile
    assert "ARG INSTALL_PLAYWRIGHT=true" in dockerfile
    assert 'if [ "$INSTALL_PLAYWRIGHT" = "true" ]' in dockerfile
    assert "deployment/" not in raw.lower()
    assert "POSTGRES_PASSWORD:" not in raw
    assert "SECRET_KEY:" not in raw
    assert "JWT_SECRET_KEY:" not in raw
    assert "CREDENTIAL_ENCRYPTION_KEY:" not in raw

    sql_root = ROOT / "community-assets/postgres"
    assert sorted(path.name for path in sql_root.glob("*.sql")) == [
        "10-foundation.sql",
        "20-capabilities.sql",
    ]


def test_community_database_baseline_is_audited_and_excludes_extensions() -> None:
    root = ROOT / "community-assets" / "postgres" / "baseline"
    manifest = json.loads(
        (root / "community-baseline.json").read_text(encoding="utf-8")
    )
    assert manifest["format_version"] == 1
    assert manifest["postgres_major"] == 16
    assert manifest["stage"] == "post_migrate_pre_bootstrap"
    assert manifest["migration_count"] > 1000
    assert manifest["table_count"] > 300

    dump = root / manifest["dump_file"]
    toc = root / manifest["toc_file"]
    gitignore = (ROOT / ".gitignore").read_text(encoding="utf-8")
    assert "!community-assets/postgres/baseline/community-baseline.dump" in gitignore
    assert hashlib.sha256(dump.read_bytes()).hexdigest() == manifest["dump_sha256"]
    assert hashlib.sha256(toc.read_bytes()).hexdigest() == manifest["toc_sha256"]
    toc_source = toc.read_text(encoding="utf-8")
    assert " EXTENSION " not in toc_source
    assert "COMMENT - EXTENSION" not in toc_source

    builder = ROOT / "scripts" / "community" / "build-database-baseline.sh"
    assert builder.is_file()
    assert builder.stat().st_mode & 0o100
    builder_source = builder.read_text(encoding="utf-8")
    assert "command -v shasum" in builder_source
    assert "sha256sum" in builder_source

    runtime_image_builder = (
        ROOT / "scripts" / "community" / "ensure-runtime-image.sh"
    ).read_text(encoding="utf-8")
    assert "community-baseline.json" in runtime_image_builder


def test_community_does_not_require_a_model_at_startup() -> None:
    environment = _compose()["services"]["django"]["environment"]
    assert "LLM_BASE_URL" not in environment
    assert "LLM_API_KEY" not in environment
    assert "LLM_MODEL" not in environment
    assert environment["RUN_BOOTSTRAP"] == "false"


def test_windows_dev_prepare_repairs_and_verifies_before_seeding() -> None:
    script = (ROOT / "scripts/backend/db-prepare.bat").read_text(encoding="utf-8")
    ordered_steps = (
        "community_database sync",
        "safe_migrate --noinput",
        "community_database finalize",
        "community_database verify",
        "seed_scene_bindings --if-empty",
    )
    positions = [script.index(step) for step in ordered_steps]

    assert positions == sorted(positions)
    assert "set \"TABTIN_COMMUNITY_DEV_MODE=1\"" in script
    assert "set \"PG_DB_USER=tabtin_migrator\"" in script


def test_loopback_installation_keeps_local_storage_client_reachable() -> None:
    """The localhost-only developer profile must pass upstream local OSS checks."""

    environment = _compose()["services"]["django"]["environment"]
    assert environment["TABTIN_PUBLIC_BASE_URL"] == "http://127.0.0.1:6060"
    assert environment["SERVICES_OSS_PROVIDER"] == "local"
    # Upstream deliberately rejects loopback object URLs in production mode.
    # This official profile is bound to 127.0.0.1 and is therefore a local
    # developer installation, not an Internet-facing production deployment.
    assert environment["DEBUG"] == "True"


def test_golden_path_probe_uses_only_existing_public_product_contracts() -> None:
    probe = ROOT / "apps/tabtin_django/tabtin/community_golden_path.py"
    assert probe.is_file()
    source = probe.read_text(encoding="utf-8")
    for contract in (
        "/api/auth/register",
        "/api/auth/login",
        "/api/context/devices/register",
        "/api/context/devices/heartbeat",
        "/api/context/workspaces/ensure-home",
        "/api/services/llm/organizations/",
        "/api/chat/sessions",
        "chat.send_message",
        "agent.prompt.forward",
        "/api/services/llm/chat",
        "agent.stream.persist_message",
    ):
        assert contract in source
    assert "apps.tabchat" not in source
