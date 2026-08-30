import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
WORKFLOW = ROOT / ".github/workflows/deploy-tabtin-vps.yml"
DEPLOY_SCRIPT = ROOT / "scripts/deploy/tabtin-vps-release.sh"
CLOUD_DEPLOY_SCRIPT = ROOT / "scripts/deploy/tabtin-cloud-vps-release.sh"
BOOTSTRAP_SCRIPT = ROOT / "scripts/deploy/tabtin-cloud-host-bootstrap.sh"
WEB_DOCKERFILE = ROOT / "apps/tabtin-web/Dockerfile"
COLLAB_DOCKERFILE = ROOT / "apps/collab-live/Dockerfile"
COLLAB_PACKAGE = ROOT / "apps/collab-live/package.json"
LOCKFILE = ROOT / "pnpm-lock.yaml"


def test_action_builds_and_pushes_five_immutable_amd64_images() -> None:
    workflow = WORKFLOW.read_text(encoding="utf-8")
    deploy_section, cloud_section = workflow.split("  publish-cloud-images:\n", 1)

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
    assert "workflow_dispatch:" not in workflow
    assert "if: github.event.pull_request.merged == true" in workflow
    assert "run-name: >-" in workflow
    assert "Deploy PR #${{ github.event.pull_request.number }} ·" in workflow
    assert "${{ github.event.pull_request.title }}" in workflow
    assert "RELEASE_SHA: ${{ github.event.pull_request.merge_commit_sha }}" in workflow
    assert "ref: ${{ env.RELEASE_SHA }}" in workflow
    assert "environment: production" in workflow
    assert '"deploy $RELEASE_SHA $django_ref $web_ref $collab_ref $REGISTRY_USER"' in workflow
    assert "$runtime_ref" not in workflow
    assert "$worker_ref" not in workflow


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
    assert "COPY --from=build --chown=node:node /opt/collab-live ./" in collab
    assert 'USER node' in collab
    assert 'CMD ["node", "dist/start.js"]' in collab

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


def test_cloud_host_release_is_separate_and_requires_all_three_digests() -> None:
    script = CLOUD_DEPLOY_SCRIPT.read_text(encoding="utf-8")

    assert "deploy <commit-sha> <django-digest-ref> <runtime-digest-ref> <worker-digest-ref>" in script
    assert 'docker pull "$requested_django"' in script
    assert 'run_worker pull "$requested_runtime"' in script
    assert 'run_worker pull "$requested_worker"' in script
    assert '"$worker_endpoint/v1/metrics"' in script
    assert "tabtin_cloud_worker_up 1" in script
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
    assert "User=tabtin-cloud-worker" in service
    assert "NoNewPrivileges=true" in service
    assert "ProtectSystem=strict" in service
    assert "/var/run/docker.sock" not in bootstrap
