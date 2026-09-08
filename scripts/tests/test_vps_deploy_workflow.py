import json
import os
import subprocess
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
WORKFLOW = ROOT / ".github/workflows/deploy-tabtin-vps.yml"
DEPLOY_SCRIPT = ROOT / "scripts/deploy/tabtin-vps-release.sh"
CLOUD_DEPLOY_SCRIPT = ROOT / "scripts/deploy/tabtin-cloud-vps-release.sh"
CLOUD_WORKER_DOCKERFILE = ROOT / "apps/tabtin-cloud-worker/Dockerfile"
BOOTSTRAP_SCRIPT = ROOT / "scripts/deploy/tabtin-cloud-host-bootstrap.sh"
VOLUME_HELPER_SCRIPT = ROOT / "scripts/deploy/tabtin-cloud-volume-helper.sh"
GATEWAY_SCRIPT = ROOT / "scripts/deploy/tabtin-deploy-gateway.sh"
SUDOERS_TEMPLATE = ROOT / "scripts/deploy/tabtin-deploy.sudoers"
WEB_DOCKERFILE = ROOT / "apps/tabtin-web/Dockerfile"
COLLAB_DOCKERFILE = ROOT / "apps/collab-live/Dockerfile"
COLLAB_PACKAGE = ROOT / "apps/collab-live/package.json"
LOCKFILE = ROOT / "pnpm-lock.yaml"


def test_action_builds_and_pushes_five_immutable_amd64_images() -> None:
    workflow = WORKFLOW.read_text(encoding="utf-8")
    deploy_section, remaining = workflow.split("  publish-cloud-images:\n", 1)
    cloud_section, cloud_deploy_section = remaining.split("  deploy-cloud:\n", 1)

    assert "packages: write" in workflow
    assert "docker/build-push-action@v6" in workflow
    assert "platforms: linux/amd64" in workflow
    assert "push: true" in workflow
    assert workflow.count("docker/build-push-action@v6") == 5
    assert "tags: ${{ env.DJANGO_IMAGE_NAME }}:sha-${{ env.RELEASE_SHA }}" in workflow
    assert "tags: ${{ env.WEB_IMAGE_NAME }}:sha-${{ env.RELEASE_SHA }}" in workflow
    assert "tags: ${{ env.COLLAB_IMAGE_NAME }}:sha-${{ env.RELEASE_SHA }}" in workflow
    assert "tags: ${{ env.CLOUD_RUNTIME_IMAGE_NAME }}:sha-${{ env.RELEASE_SHA }}" in workflow
    assert "tags: ${{ env.CLOUD_WORKER_IMAGE_NAME }}:sha-${{ env.RELEASE_SHA }}" in workflow
    assert "org.opencontainers.image.revision=${{ env.RELEASE_SHA }}" in workflow
    assert "MUSE_SOURCE_SHA=${{ env.RELEASE_SHA }}" in workflow
    assert (
        "cache-to: type=gha,mode=max,scope=muse-community-django,ignore-error=true"
        in workflow
    )
    assert "DJANGO_IMAGE_DIGEST: ${{ steps.selected_images.outputs.django_digest }}" in workflow
    assert "WEB_IMAGE_DIGEST: ${{ steps.selected_images.outputs.web_digest }}" in workflow
    assert "COLLAB_IMAGE_DIGEST: ${{ steps.selected_images.outputs.collab_digest }}" in workflow
    assert "django_ref=\"$DJANGO_IMAGE_NAME@$DJANGO_IMAGE_DIGEST\"" in workflow
    assert "web_ref=\"$WEB_IMAGE_NAME@$WEB_IMAGE_DIGEST\"" in workflow
    assert "collab_ref=\"$COLLAB_IMAGE_NAME@$COLLAB_IMAGE_DIGEST\"" in workflow
    assert "${{ github.sha }}" not in workflow
    assert "$GITHUB_SHA" not in workflow
    assert "apps/tabtin-daemon/Dockerfile.cloud" not in deploy_section
    assert "apps/tabtin-cloud-worker/Dockerfile" not in deploy_section
    assert "Configure restricted SSH access" not in cloud_section
    assert "needs: validate-release" in cloud_section
    assert "needs: publish-cloud-images" in cloud_deploy_section
    assert workflow.index("docker/build-push-action@v6") < workflow.index(
        "Pull and deploy selected Django image"
    )
    assert "file: application-source/apps/tabtin-web/Dockerfile" in deploy_section
    assert "file: application-source/apps/collab-live/Dockerfile" in deploy_section


def test_action_tracks_the_merged_pull_request_and_waits_for_production() -> None:
    workflow = WORKFLOW.read_text(encoding="utf-8")

    assert "pull_request_target:" in workflow
    assert "types: [closed]" in workflow
    assert "branches: [main]" in workflow
    assert "workflow_dispatch:" in workflow
    assert "release_sha:" in workflow
    assert "github.event_name == 'pull_request_target'" in workflow
    assert "run-name: >-" in workflow
    assert "format('Deploy standard → sg01 · PR #{0} · {1}'" in workflow
    assert "format('Deploy {0} → {1} · {2}', inputs.deployment, inputs.target, inputs.release_sha)" in workflow
    assert "inputs.release_sha || github.event.pull_request.merge_commit_sha" in workflow
    assert "ref: ${{ env.RELEASE_SHA }}" in workflow
    assert "environment: production" in workflow
    assert '"deploy $RELEASE_SHA $django_ref $web_ref $collab_ref $REGISTRY_USER"' in workflow
    assert '"deploy-cloud $RELEASE_SHA $runtime_ref $worker_ref $REGISTRY_USER"' in workflow
    assert "CLOUD_RUNTIME_IMAGE_DIGEST: ${{ needs.publish-cloud-images.outputs.runtime_digest }}" in workflow
    assert "CLOUD_WORKER_IMAGE_DIGEST: ${{ needs.publish-cloud-images.outputs.worker_digest }}" in workflow


def test_vps_only_pulls_and_switches_the_prebuilt_images() -> None:
    script = DEPLOY_SCRIPT.read_text(encoding="utf-8")

    assert 'docker pull "$requested_django"' in script
    assert 'docker pull "$requested_web"' in script
    assert 'docker pull "$requested_collab"' in script
    assert "docker build" not in script
    assert "source.tar.gz" not in script
    assert "github.com/$repository/archive" not in script
    assert "rollback" not in script.lower()
    assert "compose stop collab-live centrifugo tabtin-web celery-beat celery django" in script
    maintenance = script.index(
        "compose stop collab-live centrifugo tabtin-web celery-beat celery django"
    )
    migrate = script.index("manage.py safe_migrate --no-input")
    recreate = script.index("recreating Django")
    assert maintenance < migrate < recreate
    assert script.count("--no-build") == 3
    assert "manage.py safe_migrate --plan --no-input" in script
    assert "manage.py safe_migrate --no-input" in script
    assert "docker inspect tabtin-community-django-1" not in script
    assert "recreating Web, Collab, and Centrifugo" in script
    assert "tabtin-community-celery-beat-1" in script
    assert "local readiness response did not report ready" in script


def test_web_and_collab_images_are_reproducible_from_repo_dockerfiles() -> None:
    web = WEB_DOCKERFILE.read_text(encoding="utf-8")
    collab = COLLAB_DOCKERFILE.read_text(encoding="utf-8")

    assert "FROM node:22-bookworm-slim AS build" in web
    assert "pnpm --dir apps/tabtin-web exec vite build" in web
    assert "COPY --from=build /app/apps/tabtin-web/dist" in web
    assert "FROM node:22-bookworm-slim" in collab
    assert "pnpm --filter collab-live... build" in collab
    assert (
        "npm_config_ignore_scripts=true pnpm --filter collab-live deploy --prod /opt/collab-live"
        in collab
    )
    assert (
        "COPY --from=build --chown=node:node /opt/collab-live ./apps/collab-live"
        in collab
    )
    assert 'USER node' in collab
    assert 'CMD ["node", "apps/collab-live/dist/start.js"]' in collab

    collab_package = json.loads(COLLAB_PACKAGE.read_text(encoding="utf-8"))
    assert collab_package["dependencies"]["@muse/table-core"] == "workspace:*"
    lockfile = LOCKFILE.read_text(encoding="utf-8")
    collab_importer = lockfile.split("  apps/collab-live:\n", 1)[1].split(
        "\n  apps/", 1
    )[0]
    assert "'@muse/table-core':" in collab_importer


def test_deployment_preserves_previous_images_and_release_recovery_material() -> None:
    script = DEPLOY_SCRIPT.read_text(encoding="utf-8")
    assert "docker image rm" not in script
    assert "docker builder prune" not in script
    assert "docker image prune" not in script
    assert 'rm -f "$application_root/current"' not in script
    assert 'find "$releases_root"' not in script


def test_nginx_reload_follows_local_health_and_precedes_public_health() -> None:
    script = DEPLOY_SCRIPT.read_text(encoding="utf-8")

    local_health = script.index("local readiness response did not report ready")
    nginx_test = script.index("docker exec nginx nginx -t")
    nginx_reload = script.index("docker exec nginx nginx -s reload")
    public_health = script.index("public_ready=false")

    assert local_health < nginx_test < nginx_reload < public_health


def test_cloud_host_release_is_separate_and_requires_runtime_worker_digests() -> None:
    script = CLOUD_DEPLOY_SCRIPT.read_text(encoding="utf-8")
    worker_dockerfile = CLOUD_WORKER_DOCKERFILE.read_text(encoding="utf-8")

    assert "deploy-cloud <commit-sha> <runtime-digest-ref> <worker-digest-ref>" in script
    assert 'docker pull "$requested_django"' not in script
    assert 'run_worker pull "$requested_runtime"' in script
    assert 'run_worker pull "$requested_worker"' in script
    assert '"$worker_direct_endpoint/v1/metrics"' in script
    assert "tabtin_cloud_worker_up 1" in script
    assert "DAEMON_TOKEN_SECRET_FILE" in script
    assert "MUSE_CLOUD_WORKER_EDITION" in script
    assert "MUSE_CLOUD_CAPACITY_CPU_MILLICORES" in script
    assert "MUSE_CLOUD_WORKER_BIND_ADDRESS" in script
    assert "systemctl enable --now tabtin-cloud-volume-helper.socket" in script
    assert "deployment/tabtin-cloud-volume-helper.sh" in worker_dockerfile
    assert '"$worker_container:/app/deployment/tabtin-cloud-volume-helper.sh"' in script
    assert 'bash -n "$worker_staging/tabtin-cloud-volume-helper.sh"' in script
    assert 'sudo -n mv -f -- "$helper_staging" "$helper_target"' in script
    assert "installed Cloud volume helper checksum mismatch" in script
    assert "systemctl enable tabtin-cloud-worker" in script
    assert "systemctl restart tabtin-cloud-worker" in script
    assert "systemctl enable --now tabtin-cloud-worker" not in script
    assert 'worker_health=""' in script
    assert '"$worker_direct_endpoint/v1/health" 2>/dev/null' in script
    assert 'journalctl -u tabtin-cloud-worker -n 120' in script
    assert "upsert_runtime_env DAEMON_SERVER_URL https://workspace.dovelora.com" in script
    assert "upsert_runtime_env DAEMON_WS_URL wss://workspace.dovelora.com" in script
    assert "tabtin-community-celery-beat-1" in script
    assert "candidate=raw.strip()" in script
    assert 're.fullmatch(r"[A-Za-z0-9_=-]{32,256}", candidate)' in script
    assert 'DEPLOYED_COMMIT" 2>/dev/null' in script
    assert "docker build" not in script
    assert "source.tar.gz" not in script
    assert "rollback" not in script.lower()


def test_cloud_host_bootstrap_keeps_worker_rootless_and_quota_gated() -> None:
    bootstrap = BOOTSTRAP_SCRIPT.read_text(encoding="utf-8")
    legacy_runtime_root = "/Project/" + "infra/"
    service = (
        ROOT
        / "apps/tabtin-cloud-worker/deployment/systemd/tabtin-cloud-worker.service"
    ).read_text(encoding="utf-8")
    volume_socket = (
        ROOT
        / "apps/tabtin-cloud-worker/deployment/systemd/tabtin-cloud-volume-helper.socket"
    ).read_text(encoding="utf-8")
    volume_service = (
        ROOT
        / "apps/tabtin-cloud-worker/deployment/systemd/tabtin-cloud-volume-helper@.service"
    ).read_text(encoding="utf-8")
    volume_helper = VOLUME_HELPER_SCRIPT.read_text(encoding="utf-8")

    assert "loginctl enable-linger" in bootstrap
    assert "aardvark-dns acl ca-certificates fuse-overlayfs nodejs passt podman" in bootstrap
    assert '[[ -x /usr/lib/podman/aardvark-dns ]]' in bootstrap
    assert 'command -v pasta >/dev/null' in bootstrap
    assert "systemctl --user enable --now podman.socket" in bootstrap
    assert "systemctl --user enable podman-restart.service" in bootstrap
    assert "enable --now podman.socket podman-restart.service" not in bootstrap
    assert '"$worker_home/.config"' in bootstrap
    assert '"$worker_home/.config/systemd"' in bootstrap
    assert '"$worker_home/.config/systemd/user"' in bootstrap
    assert 'mount -o loop,pquota "$runtime_image" "$runtime_root"' in bootstrap
    assert 'runtime_root="/Project/infrastructure/tabtin-cloud-runtime"' in bootstrap
    assert 'runtime_image="/Project/infrastructure/tabtin-cloud-runtime.xfs"' in bootstrap
    assert legacy_runtime_root not in bootstrap
    assert 'setfacl -m "u:${worker_user}:--x" /Project/infrastructure' in bootstrap
    assert 'getfacl -cp /Project/infrastructure' in bootstrap
    assert '"$volume_helper" create "$probe_volume" 1' in bootstrap
    assert "--opt type=none" in bootstrap
    assert '--opt "device=$probe_path"' in bootstrap
    assert "--opt o=bind" in bootstrap
    assert "MUSE_CLOUD_XFS_SIZE_GB" in bootstrap
    assert "MUSE_CLOUD_CAPACITY_STORAGE_GB" in bootstrap
    assert "MUSE_CLOUD_WORKER_BIND_ADDRESS" in bootstrap
    assert "host.docker.internal" not in bootstrap
    assert "mkfs.xfs -f -L tabtin-cloud" in bootstrap
    assert 'runtime_fstype="$(blkid -s TYPE -o value' in bootstrap
    assert 'host_config_file="/etc/tabtin/cloud-host.env"' in bootstrap
    assert "MUSE_NGINX_CONFIG" in bootstrap
    assert "/Project/infrastructure/nginx/current/nginx.conf" in bootstrap
    assert 'install -o root -g tabtin-deploy -m 0750 "$deploy_gateway_source"' in bootstrap
    assert 'install -o root -g root -m 0700 "$cloud_release_source"' in bootstrap
    assert 'install -o root -g root -m 0755 "$volume_helper_source"' in bootstrap
    assert 'visudo -cf "$sudoers_tmp"' in bootstrap
    assert "User=tabtin-cloud-worker" in service
    assert "NoNewPrivileges=true" in service
    assert "ProtectSystem=strict" in service
    assert "ProtectHome=read-only" in service
    assert "ProtectHome=true" not in service
    assert "SocketGroup=tabtin-cloud-worker" in volume_socket
    assert "SocketMode=0660" in volume_socket
    assert "Accept=yes" in volume_socket
    assert "User=root" in volume_service
    assert "NoNewPrivileges=true" in volume_service
    assert "CapabilityBoundingSet=CAP_CHOWN CAP_DAC_OVERRIDE CAP_FOWNER CAP_SYS_ADMIN" in volume_service
    assert "ReadWritePaths=/Project/infrastructure/tabtin-cloud-runtime/volumes" in volume_service
    assert legacy_runtime_root not in volume_service
    assert legacy_runtime_root not in volume_helper
    assert "flock -x" in volume_helper
    assert "xfs_quota -x -c" in volume_helper
    assert volume_helper.count('"$runtime_root" >/dev/null 2>&1') == 2
    assert volume_helper.count("tail -c 2048") == 2
    assert "find \"$volume_path\" -xdev -depth -delete" in volume_helper
    assert "sudo" not in volume_helper
    assert "/var/run/docker.sock" not in bootstrap


def test_cloud_nginx_route_insertion_is_indentation_safe_and_idempotent(tmp_path: Path) -> None:
    bootstrap = BOOTSTRAP_SCRIPT.read_text(encoding="utf-8")
    program = bootstrap.split(
        'python3 - "$nginx_config" "$worker_bind_address" <<\'PY\'\n', 1
    )[1].split("\nPY\n", 1)[0]
    nginx = tmp_path / "nginx.conf"
    nginx.write_text(
        "http {\n"
        "    server {\n"
        "        location / {\n"
        "            proxy_pass http://tabtin_web_upstream;\n"
        "        }\n"
        "    }\n"
        "}\n",
        encoding="utf-8",
    )

    for address in ["172.17.0.1", "172.18.0.1"]:
        subprocess.run(
            ["python3", "-", str(nginx), address],
            input=program,
            text=True,
            check=True,
        )

    rendered = nginx.read_text(encoding="utf-8")
    assert rendered.count("# Muse Cloud Worker control plane") == 1
    assert "proxy_pass http://172.18.0.1:8090/;" in rendered
    assert "proxy_pass http://172.17.0.1:8090/;" not in rendered
    assert rendered.index("Cloud Worker control plane") < rendered.index("location / {")


def test_cloud_runtime_entrypoint_bounds_activation_retries() -> None:
    entrypoint = (
        ROOT / "apps/tabtin-daemon/scripts/cloud-entrypoint.sh"
    ).read_text(encoding="utf-8")

    assert "until tabtin-daemon init --token-stdin" in entrypoint
    assert 'if [ "$init_attempt" -ge 8 ]' in entrypoint
    assert "Cloud daemon bootstrap retrying in 60 seconds" in entrypoint
    assert "sleep 60" in entrypoint


def test_restricted_gateway_dispatches_only_validated_standard_or_cloud_releases() -> None:
    gateway = GATEWAY_SCRIPT.read_text(encoding="utf-8")
    sudoers = SUDOERS_TEMPLATE.read_text(encoding="utf-8")

    assert 'if [[ "$command" == "deploy" ]]' in gateway
    assert 'if [[ "$command" == "deploy-cloud" ]]' in gateway
    assert 'exec sudo -n "$standard_release"' in gateway
    assert 'exec sudo -n "$cloud_release"' in gateway
    assert "muse-community-django@sha256" in gateway
    assert "muse-cloud-runtime@sha256" in gateway
    assert "muse-cloud-worker@sha256" in gateway
    assert sudoers.splitlines() == [
        "tabtin-deploy ALL=(root) NOPASSWD: /Project/applications/tabtin/bin/tabtin-vps-release.sh",
        "tabtin-deploy ALL=(root) NOPASSWD: /Project/applications/tabtin/bin/tabtin-cloud-vps-release.sh",
    ]


def gateway_fixture_environment(tmp_path, hostname="vps-a54e75a4"):
    host = tmp_path / "hostname"
    host.write_text('#!/bin/sh\nprintf "%s\\n" "$FIXTURE_HOSTNAME"\n')
    host.chmod(0o755)
    sudo = tmp_path / "sudo"
    sudo.write_text('#!/bin/sh\nprintf "%s\\n" "$@" > "$FIXTURE_SUDO_ARGS"\n')
    sudo.chmod(0o755)
    return {**os.environ, "PATH": f"{tmp_path}:{os.environ['PATH']}",
            "FIXTURE_HOSTNAME": hostname, "FIXTURE_SUDO_ARGS": str(tmp_path / "sudo-args")}


def test_restricted_gateway_rejects_unknown_or_extra_arguments_before_sudo(tmp_path) -> None:
    sha = "a" * 40
    digest = "b" * 64
    commands = [
        "shell",
        (
            f"deploy-cloud {sha} "
            f"ghcr.io/kaestnerheisser207-web/muse-cloud-runtime@sha256:{digest} "
            f"ghcr.io/kaestnerheisser207-web/muse-cloud-worker@sha256:{digest} "
            "actor extra"
        ),
        (
            f"deploy {sha} "
            f"ghcr.io/kaestnerheisser207-web/muse-community-django@sha256:{digest} "
            f"ghcr.io/kaestnerheisser207-web/muse-web@sha256:{digest} "
            f"ghcr.io/kaestnerheisser207-web/muse-collab-live@sha256:{digest} "
            "actor extra"
        ),
    ]

    for command in commands:
        result = subprocess.run(
            ["bash", str(GATEWAY_SCRIPT)],
            env={**gateway_fixture_environment(tmp_path), "SSH_ORIGINAL_COMMAND": command},
            capture_output=True,
            text=True,
            check=False,
        )
        assert result.returncode != 0
        assert "ERROR" in result.stderr
        assert "deployment target mismatch" not in result.stderr
        assert not (tmp_path / "sudo-args").exists()


def test_dispatch_components_are_explicit_and_pr_checks_have_no_production_secrets() -> None:
    workflow = WORKFLOW.read_text(encoding="utf-8")
    assert "  pull_request:" in workflow
    assert "options: [standard, cloud]" in workflow
    assert "default: cloud" in workflow
    assert "options: [sg01]" in workflow
    assert "default: sg01" in workflow
    checks = workflow.split("  deployment-contract-tests:\n", 1)[1].split("  validate-release:\n", 1)[0]
    assert "github.event_name == 'pull_request'" in checks
    assert "contents: read" in checks
    assert "packages: write" not in checks
    assert "environment:" not in checks
    assert "secrets." not in checks
    assert "scripts/tests/test_vps_deployment_guard.py" in checks
    standard = workflow.split("  deploy:\n", 1)[1].split("  publish-cloud-images:\n", 1)[0]
    cloud_images = workflow.split("  publish-cloud-images:\n", 1)[1].split("  deploy-cloud:\n", 1)[0]
    cloud = workflow.split("  deploy-cloud:\n", 1)[1]
    assert "inputs.deployment == 'standard'" in standard
    assert "inputs.deployment == 'cloud'" in cloud_images
    assert "inputs.deployment == 'cloud'" in cloud
    for section in (standard, cloud):
        assert "environment: production" in section
        assert section.index("vps-deployment-guard.py validate") < section.index("Configure restricted SSH access")
        assert "StrictHostKeyChecking=yes" in section
        assert "IdentitiesOnly=yes" in section
        assert "BatchMode=yes" in section
    assert standard.index("vps-deployment-guard.py validate") < standard.index("password: ${{ github.token }}")


def test_reuse_selects_checked_digests_and_keeps_workflow_tools_separate_from_application() -> None:
    workflow = WORKFLOW.read_text(encoding="utf-8")
    standard = workflow.split("  deploy:\n", 1)[1].split("  publish-cloud-images:\n", 1)[0]
    assert "WORKFLOW_REVISION: ${{ github.workflow_sha }}" in workflow
    assert "ref: ${{ env.WORKFLOW_REVISION }}" in standard
    assert "ref: ${{ env.RELEASE_SHA }}" in standard
    assert "path: application-source" in standard
    assert "context: ./application-source" in standard
    assert "vps-deployment-guard.py reuse-standard" in standard
    assert "vps-deployment-guard.py select-standard" in standard
    assert "if: env.REUSE_IMAGES == 'true'" in standard
    for name in ("Django", "Web", "Collab"):
        block = standard.split(f"      - name: Build and push immutable {name} image\n", 1)[1].split("      - name:", 1)[0]
        assert "if: env.REUSE_IMAGES != 'true'" in block
    assert "steps.reused_images.outputs.django_digest ||" not in standard
    assert "Workflow: %s" in standard and "Application: %s" in standard


def test_standard_release_verifies_sg01_host_images_and_public_origin() -> None:
    script = DEPLOY_SCRIPT.read_text(encoding="utf-8")
    host_guard = script.index('"$(hostname)" == "vps-a54e75a4"')
    assert host_guard < script.index('mkdir -p "$application_root"')
    assert host_guard < script.index('IFS= read -r registry_token')
    assert host_guard < script.index('docker login')
    assert "org.opencontainers.image.revision" in script
    assert "{{.Os}}" in script and "{{.Architecture}}" in script
    for name in ("django", "web", "collab"):
        assert f'validate_image_revision "$requested_{name}"' in script
        assert script.index(f'docker pull "$requested_{name}"') < script.index(f'validate_image_revision "$requested_{name}"')
    assert "x-muse-deployment-target" in script.lower()
    assert "sg01" in script


def test_public_ready_cannot_accept_a_healthy_response_from_the_wrong_origin(tmp_path) -> None:
    import textwrap

    workflow = WORKFLOW.read_text(encoding="utf-8")
    block = workflow.split("      - name: Verify public readiness\n", 1)[1].split("\n  publish-cloud-images:", 1)[0]
    script = textwrap.dedent(block.split("        run: |\n", 1)[1])
    curl = tmp_path / "curl"
    curl.write_text('''#!/bin/sh
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--dump-header" ]; then shift; headers="$1"; fi
  shift
done
printf 'HTTP/1.1 200 OK\\r\\nX-Muse-Deployment-Target: %s\\r\\n\\r\\n' "$FIXTURE_TARGET" > "$headers"
printf '{"status":"ready"}'
''')
    curl.chmod(0o755)
    for target, expected in [("sg01", 0), ("ks6", 1), ("", 1), ("sg01-unverified", 1)]:
        result = subprocess.run(["bash", "-c", script],
            env={**os.environ, "PATH": f"{tmp_path}:{os.environ['PATH']}", "RUNNER_TEMP": str(tmp_path), "FIXTURE_TARGET": target},
            capture_output=True, text=True, check=False)
        assert result.returncode == expected, result.stderr


def valid_gateway_commands():
    sha = "a" * 40
    digest = "b" * 64
    standard = [sha, *[f"ghcr.io/kaestnerheisser207-web/{name}@sha256:{digest}" for name in ("muse-community-django", "muse-web", "muse-collab-live")], "actor"]
    cloud = [sha, *[f"ghcr.io/kaestnerheisser207-web/{name}@sha256:{digest}" for name in ("muse-cloud-runtime", "muse-cloud-worker")], "actor"]
    return [("deploy", "tabtin-vps-release.sh", standard), ("deploy-cloud", "tabtin-cloud-vps-release.sh", cloud)]


def test_restricted_gateway_allows_valid_dispatch_only_on_the_physical_sg01_host(tmp_path) -> None:
    environment = gateway_fixture_environment(tmp_path)
    for command, script, args in valid_gateway_commands():
        result = subprocess.run(["bash", str(GATEWAY_SCRIPT)],
            env={**environment, "SSH_ORIGINAL_COMMAND": " ".join([command, *args])},
            capture_output=True, text=True, check=False)
        assert result.returncode == 0, result.stderr
        assert (tmp_path / "sudo-args").read_text().splitlines() == ["-n", f"/Project/applications/tabtin/bin/{script}", *args]


def test_restricted_gateway_wrong_host_never_reaches_sudo_even_with_valid_arguments(tmp_path) -> None:
    for hostname in ("ks6", "vps-a54e75a4.example", ""):
        for command, _script, args in valid_gateway_commands():
            result = subprocess.run(["bash", str(GATEWAY_SCRIPT)],
                env={**gateway_fixture_environment(tmp_path, hostname), "SSH_ORIGINAL_COMMAND": " ".join([command, *args])},
                capture_output=True, text=True, check=False)
            assert result.returncode != 0
            assert "deployment target mismatch" in result.stderr
            assert not (tmp_path / "sudo-args").exists()
    source = GATEWAY_SCRIPT.read_text()
    assert source.index('"$(hostname)" == "vps-a54e75a4"') < source.index("read -r command")


def test_readonly_pr_contract_checks_cannot_replace_pending_production_deployments() -> None:
    workflow = WORKFLOW.read_text(encoding="utf-8")
    concurrency = workflow.split("concurrency:\n", 1)[1].split("\nenv:", 1)[0]
    assert "github.event_name == 'pull_request' && format('vps-contract-pr-{0}', github.event.pull_request.number) || 'tabtin-vps-production'" in concurrency
    assert "cancel-in-progress: false" in concurrency
    # pull_request_target (merged release) and workflow_dispatch retain one
    # production lock; only unprivileged PR checks receive the per-PR group.
    assert "github.event_name == 'pull_request_target'" not in concurrency
    assert "github.ref" not in concurrency


def test_public_domain_is_only_workspace_and_dns_wait_keeps_origin_guard() -> None:
    for path in [WORKFLOW, DEPLOY_SCRIPT, CLOUD_DEPLOY_SCRIPT]:
        text = path.read_text(encoding="utf-8")
        assert "tabtin.dovelora.com" not in text
        assert "workspace.dovelora.com" in text
    script = DEPLOY_SCRIPT.read_text(encoding="utf-8")
    assert "for attempt in {1..60}" in script
    assert "public_ready=true" in script
    assert "x-muse-deployment-target:" in script
    assert script.index('[[ "$public_ready" == true ]]') < script.index('> "$application_root/DEPLOYED_COMMIT"')


def test_server_dns_wait_requires_ready_body_and_exact_sg01_origin(tmp_path) -> None:
    source = DEPLOY_SCRIPT.read_text()
    fragment = source.split('health_headers="$(mktemp)"', 1)[1].split("printf '%s\\n' \"$requested_sha\"", 1)[0]
    script = 'set -euo pipefail\nlog() { :; }; die() { printf "%s\\n" "$*" >&2; exit 1; }; public_health_url=https://workspace.dovelora.com/health/ready\nhealth_headers="$(mktemp)"' + fragment
    (tmp_path / 'sleep').write_text('#!/bin/sh\nexit 0\n')
    (tmp_path / 'sleep').chmod(0o755)
    curl = tmp_path / 'curl'
    curl.write_text('''#!/bin/sh
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--dump-header" ]; then shift; headers="$1"; fi
  shift
done
n=0
[ ! -f "$FIXTURE_COUNT" ] || n=$(cat "$FIXTURE_COUNT")
n=$((n + 1)); printf '%s' "$n" > "$FIXTURE_COUNT"
target=ks6
if [ "$FIXTURE_MODE" = switch ] && [ "$n" -ge 2 ]; then target=sg01; fi
printf 'HTTP/1.1 200 OK\r\nX-Muse-Deployment-Target: %s\r\n\r\n' "$target" > "$headers"
printf '{"status":"ready"}'
''')
    curl.chmod(0o755)
    for mode, expected, attempts in [('switch', 0, 2), ('old-origin', 1, 60)]:
        counter = tmp_path / f'{mode}-count'
        result = subprocess.run(['bash', '-c', script], env={**os.environ, 'PATH': f"{tmp_path}:{os.environ['PATH']}", 'FIXTURE_MODE': mode, 'FIXTURE_COUNT': str(counter)}, capture_output=True, text=True, timeout=20)
        assert result.returncode == expected, result.stderr
        assert int(counter.read_text()) == attempts
