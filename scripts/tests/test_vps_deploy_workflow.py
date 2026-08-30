import json
import os
import subprocess
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
WORKFLOW = ROOT / ".github/workflows/deploy-tabtin-vps.yml"
DEPLOY_SCRIPT = ROOT / "scripts/deploy/tabtin-vps-release.sh"
CLOUD_DEPLOY_SCRIPT = ROOT / "scripts/deploy/tabtin-cloud-vps-release.sh"
BOOTSTRAP_SCRIPT = ROOT / "scripts/deploy/tabtin-cloud-host-bootstrap.sh"
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
    assert "TABTIN_SOURCE_SHA=${{ env.RELEASE_SHA }}" in workflow
    assert (
        "cache-to: type=gha,mode=max,scope=tabtin-community-django,ignore-error=true"
        in workflow
    )
    assert "DJANGO_IMAGE_DIGEST: ${{ steps.build_django.outputs.digest }}" in workflow
    assert "WEB_IMAGE_DIGEST: ${{ steps.build_web.outputs.digest }}" in workflow
    assert "COLLAB_IMAGE_DIGEST: ${{ steps.build_collab.outputs.digest }}" in workflow
    assert "django_ref=\"$DJANGO_IMAGE_NAME@$DJANGO_IMAGE_DIGEST\"" in workflow
    assert "web_ref=\"$WEB_IMAGE_NAME@$WEB_IMAGE_DIGEST\"" in workflow
    assert "collab_ref=\"$COLLAB_IMAGE_NAME@$COLLAB_IMAGE_DIGEST\"" in workflow
    assert "${{ github.sha }}" not in workflow
    assert "$GITHUB_SHA" not in workflow
    assert "apps/tabtin-daemon/Dockerfile.cloud" not in deploy_section
    assert "apps/tabtin-cloud-worker/Dockerfile" not in deploy_section
    assert "Configure restricted SSH access" not in cloud_section
    assert "needs:" not in cloud_section
    assert "needs: publish-cloud-images" in cloud_deploy_section
    assert workflow.index("docker/build-push-action@v6") < workflow.index(
        "Pull and deploy selected Django image"
    )
    assert "file: apps/tabtin-web/Dockerfile" in deploy_section
    assert "file: apps/collab-live/Dockerfile" in deploy_section


def test_action_tracks_the_merged_pull_request_and_waits_for_production() -> None:
    workflow = WORKFLOW.read_text(encoding="utf-8")

    assert "pull_request_target:" in workflow
    assert "types: [closed]" in workflow
    assert "branches: [main]" in workflow
    assert "workflow_dispatch:" in workflow
    assert "release_sha:" in workflow
    assert "github.event_name == 'pull_request_target'" in workflow
    assert "run-name: >-" in workflow
    assert "format('Deploy PR #{0} · {1}'" in workflow
    assert "format('Deploy Cloud Host · {0}', inputs.release_sha)" in workflow
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
    assert "compose stop collab-live centrifugo tabtin-web celery django" in script
    maintenance = script.index(
        "compose stop collab-live centrifugo tabtin-web celery django"
    )
    migrate = script.index("manage.py safe_migrate --no-input")
    recreate = script.index("recreating Django")
    assert maintenance < migrate < recreate
    assert script.count("--no-build") == 3
    assert "manage.py safe_migrate --plan --no-input" in script
    assert "manage.py safe_migrate --no-input" in script
    assert "docker inspect tabtin-community-django-1" not in script
    assert "recreating Web, Collab, and Centrifugo" in script
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
    assert collab_package["dependencies"]["@tabtin/table-core"] == "workspace:*"
    lockfile = LOCKFILE.read_text(encoding="utf-8")
    collab_importer = lockfile.split("  apps/collab-live:\n", 1)[1].split(
        "\n  apps/", 1
    )[0]
    assert "'@tabtin/table-core':" in collab_importer


def test_cleanup_is_scoped_to_old_tabtin_images_and_runs_after_health() -> None:
    script = DEPLOY_SCRIPT.read_text(encoding="utf-8")
    health_verified = script.index(
        "public readiness response did not report ready"
    )
    cleanup = script.index("removing previous application images")

    assert health_verified < cleanup
    assert '"$image_id" != "$django_image_id"' in script
    assert '"$image_id" != "$web_image_id"' in script
    assert '"$image_id" != "$collab_image_id"' in script
    assert 'repository" == "tabtin/community-django"' in script
    assert 'repository" == "tabtin/web"' in script
    assert 'repository" == "tabtin/collab-live"' in script
    assert 'repository" == "$django_repository"' in script
    assert 'repository" == "$web_repository"' in script
    assert 'repository" == "$collab_repository"' in script
    assert 'docker image rm --force "$image_id"' in script
    assert "docker builder prune" not in script
    assert "docker image prune" not in script


def test_nginx_reload_follows_local_health_and_precedes_public_health() -> None:
    script = DEPLOY_SCRIPT.read_text(encoding="utf-8")

    local_health = script.index("local readiness response did not report ready")
    nginx_test = script.index("docker exec nginx nginx -t")
    nginx_reload = script.index("docker exec nginx nginx -s reload")
    public_health = script.index("public readiness request failed")

    assert local_health < nginx_test < nginx_reload < public_health


def test_cloud_host_release_is_separate_and_requires_runtime_worker_digests() -> None:
    script = CLOUD_DEPLOY_SCRIPT.read_text(encoding="utf-8")

    assert "deploy-cloud <commit-sha> <runtime-digest-ref> <worker-digest-ref>" in script
    assert 'docker pull "$requested_django"' not in script
    assert 'run_worker pull "$requested_runtime"' in script
    assert 'run_worker pull "$requested_worker"' in script
    assert '"$worker_direct_endpoint/v1/metrics"' in script
    assert "tabtin_cloud_worker_up 1" in script
    assert "DAEMON_TOKEN_SECRET_FILE" in script
    assert "TABTIN_CLOUD_WORKER_EDITION" in script
    assert "TABTIN_CLOUD_CAPACITY_CPU_MILLICORES" in script
    assert 'DEPLOYED_COMMIT" 2>/dev/null' in script
    assert "docker build" not in script
    assert "source.tar.gz" not in script
    assert "rollback" not in script.lower()


def test_cloud_host_bootstrap_keeps_worker_rootless_and_quota_gated() -> None:
    bootstrap = BOOTSTRAP_SCRIPT.read_text(encoding="utf-8")
    service = (
        ROOT
        / "apps/tabtin-cloud-worker/deployment/systemd/tabtin-cloud-worker.service"
    ).read_text(encoding="utf-8")

    assert "loginctl enable-linger" in bootstrap
    assert "systemctl --user enable --now podman.socket" in bootstrap
    assert 'mount -o loop,pquota "$runtime_image" "$runtime_root"' in bootstrap
    assert 'volume create --opt o=size=1M "$probe_volume"' in bootstrap
    assert "TABTIN_CLOUD_XFS_SIZE_GB" in bootstrap
    assert "TABTIN_CLOUD_CAPACITY_STORAGE_GB" in bootstrap
    assert 'host_config_file="/etc/tabtin/cloud-host.env"' in bootstrap
    assert "TABTIN_NGINX_CONFIG" in bootstrap
    assert "/Project/infrastructure/nginx/current/nginx.conf" in bootstrap
    assert 'install -o root -g tabtin-deploy -m 0750 "$deploy_gateway_source"' in bootstrap
    assert 'install -o root -g root -m 0700 "$cloud_release_source"' in bootstrap
    assert 'visudo -cf "$sudoers_tmp"' in bootstrap
    assert "User=tabtin-cloud-worker" in service
    assert "NoNewPrivileges=true" in service
    assert "ProtectSystem=strict" in service
    assert "/var/run/docker.sock" not in bootstrap


def test_restricted_gateway_dispatches_only_validated_standard_or_cloud_releases() -> None:
    gateway = GATEWAY_SCRIPT.read_text(encoding="utf-8")
    sudoers = SUDOERS_TEMPLATE.read_text(encoding="utf-8")

    assert 'if [[ "$command" == "deploy" ]]' in gateway
    assert 'if [[ "$command" == "deploy-cloud" ]]' in gateway
    assert 'exec sudo -n "$standard_release"' in gateway
    assert 'exec sudo -n "$cloud_release"' in gateway
    assert "tabtin-community-django@sha256" in gateway
    assert "tabtin-cloud-runtime@sha256" in gateway
    assert "tabtin-cloud-worker@sha256" in gateway
    assert sudoers.splitlines() == [
        "tabtin-deploy ALL=(root) NOPASSWD: /Project/applications/tabtin/bin/tabtin-vps-release.sh",
        "tabtin-deploy ALL=(root) NOPASSWD: /Project/applications/tabtin/bin/tabtin-cloud-vps-release.sh",
    ]


def test_restricted_gateway_rejects_unknown_or_extra_arguments_before_sudo() -> None:
    sha = "a" * 40
    digest = "b" * 64
    commands = [
        "shell",
        (
            f"deploy-cloud {sha} "
            f"ghcr.io/kaestnerheisser207-web/tabtin-cloud-runtime@sha256:{digest} "
            f"ghcr.io/kaestnerheisser207-web/tabtin-cloud-worker@sha256:{digest} "
            "actor extra"
        ),
        (
            f"deploy {sha} "
            f"ghcr.io/kaestnerheisser207-web/tabtin-community-django@sha256:{digest} "
            f"ghcr.io/kaestnerheisser207-web/tabtin-web@sha256:{digest} "
            f"ghcr.io/kaestnerheisser207-web/tabtin-collab-live@sha256:{digest} "
            "actor extra"
        ),
    ]

    for command in commands:
        result = subprocess.run(
            ["bash", str(GATEWAY_SCRIPT)],
            env={**os.environ, "SSH_ORIGINAL_COMMAND": command},
            capture_output=True,
            text=True,
            check=False,
        )
        assert result.returncode != 0
        assert "ERROR" in result.stderr
