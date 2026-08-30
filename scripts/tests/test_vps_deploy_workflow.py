from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
WORKFLOW = ROOT / ".github/workflows/deploy-tabtin-vps.yml"
DEPLOY_SCRIPT = ROOT / "scripts/deploy/tabtin-vps-release.sh"
BOOTSTRAP_SCRIPT = ROOT / "scripts/deploy/tabtin-cloud-host-bootstrap.sh"


def test_action_builds_and_pushes_three_immutable_amd64_images() -> None:
    workflow = WORKFLOW.read_text(encoding="utf-8")

    assert "packages: write" in workflow
    assert "docker/build-push-action@v6" in workflow
    assert "platforms: linux/amd64" in workflow
    assert "push: true" in workflow
    assert workflow.count("docker/build-push-action@v6") == 3
    assert "tags: ${{ env.DJANGO_IMAGE_NAME }}:sha-${{ env.RELEASE_SHA }}" in workflow
    assert "tags: ${{ env.CLOUD_RUNTIME_IMAGE_NAME }}:sha-${{ env.RELEASE_SHA }}" in workflow
    assert "tags: ${{ env.CLOUD_WORKER_IMAGE_NAME }}:sha-${{ env.RELEASE_SHA }}" in workflow
    assert "org.opencontainers.image.revision=${{ env.RELEASE_SHA }}" in workflow
    assert "TABTIN_SOURCE_SHA=${{ env.RELEASE_SHA }}" in workflow
    assert (
        "cache-to: type=gha,mode=max,scope=tabtin-community-django,ignore-error=true"
        in workflow
    )
    assert "DJANGO_IMAGE_DIGEST: ${{ steps.build_django.outputs.digest }}" in workflow
    assert "CLOUD_RUNTIME_IMAGE_DIGEST: ${{ steps.build_cloud_runtime.outputs.digest }}" in workflow
    assert "CLOUD_WORKER_IMAGE_DIGEST: ${{ steps.build_cloud_worker.outputs.digest }}" in workflow
    assert "django_ref=\"$DJANGO_IMAGE_NAME@$DJANGO_IMAGE_DIGEST\"" in workflow
    assert "runtime_ref=\"$CLOUD_RUNTIME_IMAGE_NAME@$CLOUD_RUNTIME_IMAGE_DIGEST\"" in workflow
    assert "worker_ref=\"$CLOUD_WORKER_IMAGE_NAME@$CLOUD_WORKER_IMAGE_DIGEST\"" in workflow
    assert "${{ github.sha }}" not in workflow
    assert "$GITHUB_SHA" not in workflow
    assert workflow.index("docker/build-push-action@v6") < workflow.index(
        "Pull and deploy selected image"
    )


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
    assert (
        '"deploy $RELEASE_SHA $django_ref $runtime_ref $worker_ref $REGISTRY_USER"'
        in workflow
    )


def test_vps_only_pulls_and_switches_the_prebuilt_image() -> None:
    script = DEPLOY_SCRIPT.read_text(encoding="utf-8")

    assert 'docker pull "$requested_django"' in script
    assert 'run_worker pull "$requested_runtime"' in script
    assert 'run_worker pull "$requested_worker"' in script
    assert "docker build" not in script
    assert "source.tar.gz" not in script
    assert "github.com/$repository/archive" not in script
    assert "rollback" not in script.lower()
    assert "compose stop celery django" in script
    maintenance = script.index("compose stop celery django")
    migrate = script.index("manage.py safe_migrate --no-input")
    recreate = script.index("recreating Django")
    assert maintenance < migrate < recreate
    assert script.count("--no-build") == 2
    assert "manage.py safe_migrate --plan --no-input" in script
    assert "manage.py safe_migrate --no-input" in script


def test_cleanup_is_scoped_to_old_tabtin_images_and_runs_after_health() -> None:
    script = DEPLOY_SCRIPT.read_text(encoding="utf-8")
    health_verified = script.index(
        "public readiness response did not report ready"
    )
    cleanup = script.index("removing previous application images")

    assert health_verified < cleanup
    assert '[[ "$image_id" != "$new_image_id" ]] || continue' in script
    assert 'repository" == "tabtin/community-django"' in script
    assert 'repository" == "$django_repository"' in script
    assert 'docker image rm --force "$image_id"' in script
    assert "docker builder prune" not in script
    assert "docker image prune" not in script


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
