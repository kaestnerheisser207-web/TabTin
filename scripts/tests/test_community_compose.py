from __future__ import annotations

import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
import tempfile


ROOT = Path(__file__).resolve().parents[2]
COMPOSE_FILE = ROOT / "compose.yaml"
DEV_COMPOSE_FILE = ROOT / "compose.community-dev.yaml"
COMMUNITY_COMMAND = ROOT / "community"


def _resolved_compose(
    edition: str = "community",
    fixed_verification_code: str = "888888",
    *,
    parent_edition: str | None = None,
    parent_fixed_verification_code: str | None = None,
) -> dict:
    environment = {
        "PATH": os.environ.get("PATH", ""),
        "HOME": os.environ.get("HOME", ""),
        "COMPOSE_DISABLE_ENV_FILE": "1",
    }
    if parent_edition is not None:
        environment["MUSE_EDITION"] = parent_edition
    if parent_fixed_verification_code is not None:
        environment["AUTH_FIXED_VERIFICATION_CODE"] = (
            parent_fixed_verification_code
        )

    with tempfile.TemporaryDirectory() as project_directory:
        project_root = Path(project_directory)
        compose_file = project_root / "compose.yaml"
        env_file = project_root / ".env"
        runtime_env_file = project_root / ".env.community-runtime"
        shutil.copy2(COMPOSE_FILE, compose_file)
        env_file.write_text(
            f"MUSE_EDITION={edition}\n"
            f"AUTH_FIXED_VERIFICATION_CODE={fixed_verification_code}\n",
            encoding="utf-8",
        )
        runtime_env_file.write_text(
            f"MUSE_EDITION={edition}\n"
            f"AUTH_FIXED_VERIFICATION_CODE={fixed_verification_code}\n",
            encoding="utf-8",
        )
        result = subprocess.run(
            [
                "docker",
                "compose",
                "--project-directory",
                str(project_root),
                "--env-file",
                str(env_file),
                "-f",
                str(compose_file),
                "config",
                "--format",
                "json",
            ],
            cwd=project_root,
            env=environment,
            capture_output=True,
            text=True,
            timeout=20,
        )
    assert result.returncode == 0, result.stdout + result.stderr
    return json.loads(result.stdout)


def _resolved_dev_compose(edition: str = "community") -> dict:
    environment = {
        "PATH": os.environ.get("PATH", ""),
        "HOME": os.environ.get("HOME", ""),
        "COMPOSE_DISABLE_ENV_FILE": "1",
        "MUSE_DEV_DEPENDENCY_FINGERPRINT": "contract-test",
    }
    with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8") as env_file:
        env_file.write(f"MUSE_EDITION={edition}\n")
        env_file.flush()
        result = subprocess.run(
            [
                "docker",
                "compose",
                "--env-file",
                env_file.name,
                "-f",
                str(COMPOSE_FILE),
                "-f",
                str(DEV_COMPOSE_FILE),
                "config",
                "--format",
                "json",
            ],
            cwd=ROOT,
            env=environment,
            capture_output=True,
            text=True,
            timeout=20,
        )
    assert result.returncode == 0, result.stdout + result.stderr
    return json.loads(result.stdout)


def test_official_community_installation_has_one_five_service_interface() -> None:
    assert COMPOSE_FILE.is_file()
    assert COMMUNITY_COMMAND.is_file()
    assert COMMUNITY_COMMAND.stat().st_mode & stat.S_IXUSR

    compose = _resolved_compose()
    services = compose["services"]
    assert compose["name"] == "tabtin-community"
    assert set(services) == {
        "postgres",
        "redis",
        "django",
        "celery",
        "centrifugo",
    }

    assert services["postgres"]["image"] == "pgvector/pgvector:pg16"
    assert services["redis"]["image"] == "redis:8-alpine"
    assert services["centrifugo"]["image"] == "centrifugo/centrifugo:v6"
    assert services["django"]["build"]["args"]["INSTALL_PLAYWRIGHT"] == "true"

    assert "ports" not in services["postgres"]
    assert "ports" not in services["redis"]
    assert services["django"]["ports"] == [
        {
            "mode": "ingress",
            "host_ip": "127.0.0.1",
            "target": 6060,
            "published": "6060",
            "protocol": "tcp",
        }
    ]
    assert services["centrifugo"]["ports"] == [
        {
            "mode": "ingress",
            "host_ip": "127.0.0.1",
            "target": 8100,
            "published": "8100",
            "protocol": "tcp",
        }
    ]

    raw_manifest = COMPOSE_FILE.read_text(encoding="utf-8").lower()
    resolved = json.dumps(compose, sort_keys=True).lower()
    for forbidden in (
        "deployment/",
        "ack-test",
        "aliyun",
        "preprod",
        "api-test.example.com",
        "docker-compose.test",
        "api.example.com",
        "ws.example.com",
        "gptapi.xmov.ai",
        "tabtin-acr-registry",
    ):
        assert forbidden not in raw_manifest
        assert forbidden not in resolved


def test_compose_reads_the_edition_from_the_explicit_env_file() -> None:
    community = _resolved_compose("community")
    saas = _resolved_compose("saas")

    for compose, expected_edition in ((community, "community"), (saas, "saas")):
        django = compose["services"]["django"]
        celery = compose["services"]["celery"]
        assert django["environment"]["MUSE_EDITION"] == expected_edition
        assert celery["environment"]["MUSE_EDITION"] == expected_edition
        assert not any(
            mount["target"] == "/run/tabtin-community-config/root.env"
            for mount in django["volumes"] + celery["volumes"]
        )


def test_compose_reads_the_fixed_verification_code_switch_from_env() -> None:
    for compose, expected_code in (
        (_resolved_compose("community"), "888888"),
        (_resolved_compose("community", fixed_verification_code=""), ""),
    ):
        for service in ("django", "celery"):
            environment = compose["services"][service]["environment"]
            assert environment["AUTH_FIXED_VERIFICATION_CODE"] == expected_code


def test_root_env_switches_cannot_be_overridden_by_parent_shell() -> None:
    compose = _resolved_compose(
        "community",
        fixed_verification_code="",
        parent_edition="saas",
        parent_fixed_verification_code="123456",
    )

    for service in ("django", "celery"):
        environment = compose["services"][service]["environment"]
        assert environment["MUSE_EDITION"] == "community"
        assert environment["AUTH_FIXED_VERIFICATION_CODE"] == ""
        assert "OPENAI_API_KEY" not in environment
        assert "AWS_SECRET_ACCESS_KEY" not in environment


def test_compose_does_not_restore_a_hardcoded_edition_default() -> None:
    with tempfile.TemporaryDirectory() as project_directory:
        project_root = Path(project_directory)
        compose_file = project_root / "compose.yaml"
        env_file = project_root / ".env"
        runtime_env_file = project_root / ".env.community-runtime"
        shutil.copy2(COMPOSE_FILE, compose_file)
        env_file.write_text("AUTH_FIXED_VERIFICATION_CODE=\n", encoding="utf-8")
        runtime_env_file.write_text(
            "AUTH_FIXED_VERIFICATION_CODE=\n", encoding="utf-8"
        )
        result = subprocess.run(
            [
                "docker",
                "compose",
                "--project-directory",
                str(project_root),
                "--env-file",
                str(env_file),
                "-f",
                str(compose_file),
                "config",
                "--format",
                "json",
            ],
            cwd=project_root,
            env={
                "PATH": os.environ.get("PATH", ""),
                "HOME": os.environ.get("HOME", ""),
                "COMPOSE_DISABLE_ENV_FILE": "1",
            },
            capture_output=True,
            text=True,
            timeout=20,
        )

    assert result.returncode == 0, result.stdout + result.stderr
    compose = json.loads(result.stdout)
    for service in ("django", "celery"):
        assert "MUSE_EDITION" not in compose["services"][service]["environment"]


def test_community_dev_uses_one_five_service_backend_with_source_mounts() -> None:
    compose = _resolved_dev_compose()
    services = compose["services"]

    assert set(services) == {"postgres", "redis", "django", "celery", "centrifugo"}
    assert services["django"]["image"] == "muse/community-django:dev"
    assert services["celery"]["image"] == "muse/community-django:dev"
    assert services["django"]["command"] == ["community-dev-web"]
    assert services["celery"]["user"] == "10001:10001"

    django_targets = {mount["target"] for mount in services["django"]["volumes"]}
    assert "/app/apps/tabtin_django" in django_targets
    assert "/app/packages" in django_targets
    assert "/ms-playwright" in django_targets
