from __future__ import annotations

from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]


def _text(name: str) -> str:
    return (ROOT / name).read_text(encoding="utf-8")


def test_windows_start_checks_docker_waits_for_ready_and_prints_next_steps() -> None:
    source = _text("start.bat")
    lowered = source.lower()

    for contract in (
        "docker --version",
        "docker compose version",
        "docker info",
        "scripts\\community\\ensure-env-file.bat",
        "set \"auth_fixed_verification_code=\"",
        "--env-file \"%~dp0.env\"",
        "docker compose --env-file \"%~dp0.env\" up -d --build",
        "http://127.0.0.1:6060/health/ready",
        "muse community is ready",
        "settings",
        "model configuration",
        "byok",
        "http://127.0.0.1:6060",
    ):
        assert contract in lowered

    for forbidden in (
        "postgres_password",
        "secret_key",
        "jwt_secret",
        "credential_encryption",
        "safe_migrate",
        "tabtin_bootstrap",
    ):
        assert forbidden not in lowered

    env_helper = _text("scripts/community/ensure-env-file.bat").lower()
    assert "auth_fixed_verification_code" in env_helper
    assert ".env.community-runtime" in env_helper
    assert "tabtin_edition=!edition!" in env_helper
    assert "[guid]::newguid()" in env_helper
    assert ".tmp.!runtime_guid!" in env_helper
    assert 'set "runtime_temp=!runtime_env!.tmp"' not in env_helper
    assert '>>"%env_file%" echo(\n>>"%env_file%" echo %~1=' in env_helper


def test_windows_stop_preserves_data_and_only_stops_community_compose() -> None:
    source = _text("stop.bat").lower()
    assert "scripts\\community\\ensure-env-file.bat" in source
    assert "--env-file \"%~dp0.env\"" in source
    assert "docker compose --env-file \"%~dp0.env\" down" in source
    for forbidden in ("down -v", "system prune", "volume prune", "docker stop"):
        assert forbidden not in source


def test_windows_status_is_read_only_and_reports_public_health() -> None:
    source = _text("status.bat").lower()
    for contract in (
        "docker info",
        "http://127.0.0.1:6060/health/ready",
        "http://127.0.0.1:8100/health",
        "docker: running",
        "docker: not running",
        "muse server: ready",
        "muse server: not ready",
        "centrifugo: ready",
        "centrifugo: not ready",
    ):
        assert contract in source
    for forbidden in ("docker compose up", "docker compose down", "/api/services/llm"):
        assert forbidden not in source


def test_public_docs_have_the_same_windows_quick_start() -> None:
    readme = _text("README.md").lower()
    assert "docs/development/community-quickstart.md" in readme

    guide = _text("COMMUNITY_OPEN_SOURCE_GUIDE.md").lower()
    for contract in (
        "https://www.docker.com/products/docker-desktop/",
        "download muse source",
        "start.bat",
        "muse desktop client",
        "register / login",
        "settings",
        "model configuration",
        "byok",
        "start chat",
    ):
        assert contract in guide, f"Community guide: missing {contract}"

    quickstart = _text("docs/development/community-quickstart.md").lower()
    for contract in ("docker desktop", "start.bat", "muse desktop client", "byok"):
        assert contract in quickstart, f"Quickstart: missing {contract}"
