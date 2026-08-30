#!/usr/bin/env bash
set -euo pipefail

application_root="/Project/applications/tabtin"
releases_root="$application_root/releases"
compose_file="$application_root/config/compose.shared.yml"
runtime_env_file="$application_root/source-snapshot/.env.community-runtime"
public_health_url="https://tabtin.dovelora.com/health/ready"
worker_endpoint="https://tabtin.dovelora.com/_internal/cloud-worker"
local_image="tabtin/community-django:local"
django_repository="ghcr.io/kaestnerheisser207-web/tabtin-community-django"
runtime_repository="ghcr.io/kaestnerheisser207-web/tabtin-cloud-runtime"
worker_repository="ghcr.io/kaestnerheisser207-web/tabtin-cloud-worker"
worker_user="tabtin-cloud-worker"
worker_home="/var/lib/tabtin-cloud-worker"
worker_token_file="/etc/tabtin/cloud-worker.token"
worker_env_file="/etc/tabtin/cloud-worker.env"
worker_release_root="/opt/tabtin-cloud-worker/releases"
lock_file="$application_root/.deploy.lock"

log() {
  printf '[tabtin-deploy] %s\n' "$*"
}

die() {
  printf '[tabtin-deploy] ERROR: %s\n' "$*" >&2
  exit 1
}

requested_sha="${1:-}"
requested_django="${2:-}"
requested_runtime="${3:-}"
requested_worker="${4:-}"
registry_user="${5:-}"
if [[ -n "${SSH_ORIGINAL_COMMAND:-}" ]]; then
  read -r command requested_sha requested_django requested_runtime requested_worker registry_user extra <<<"$SSH_ORIGINAL_COMMAND"
  [[ "$command" == "deploy" && -z "${extra:-}" ]] ||
    die "restricted key accepts only: deploy <commit-sha> <django-digest-ref> <runtime-digest-ref> <worker-digest-ref> <registry-user>"
fi

[[ "$requested_sha" =~ ^[0-9a-f]{40}$ ]] ||
  die "release commit must be a full lowercase SHA"
[[ "$requested_django" =~ ^ghcr\.io/kaestnerheisser207-web/tabtin-community-django@sha256:[0-9a-f]{64}$ ]] ||
  die "Django image must use the approved GHCR repository and digest"
[[ "$requested_runtime" =~ ^ghcr\.io/kaestnerheisser207-web/tabtin-cloud-runtime@sha256:[0-9a-f]{64}$ ]] ||
  die "Cloud Runtime image must use the approved GHCR repository and digest"
[[ "$requested_worker" =~ ^ghcr\.io/kaestnerheisser207-web/tabtin-cloud-worker@sha256:[0-9a-f]{64}$ ]] ||
  die "Cloud Worker image must use the approved GHCR repository and digest"
[[ "$registry_user" =~ ^[A-Za-z0-9-]{1,39}$ ]] ||
  die "invalid registry user"

mkdir -p "$application_root"
exec 9>"$lock_file"
flock -n 9 || die "another TabTin deployment is already running"
[[ -f "$compose_file" ]] || die "missing compose file: $compose_file"
[[ -f "$runtime_env_file" ]] || die "missing runtime env file: $runtime_env_file"
[[ -f "$worker_token_file" ]] || die "Cloud host bootstrap has not installed the Worker token"
id "$worker_user" >/dev/null 2>&1 || die "Cloud host bootstrap has not installed the Worker account"
worker_uid="$(id -u "$worker_user")"
podman_socket="/run/user/$worker_uid/podman/podman.sock"
[[ -S "$podman_socket" ]] || die "rootless Podman socket is unavailable"

run_worker() {
  sudo -n -u "$worker_user" env \
    HOME="$worker_home" \
    XDG_RUNTIME_DIR="/run/user/$worker_uid" \
    DOCKER_HOST="unix://$podman_socket" \
    /usr/bin/docker "$@"
}

registry_token=""
IFS= read -r registry_token || true
[[ -n "$registry_token" ]] || die "missing one-time registry token"
printf '%s\n' "$registry_token" |
  docker login ghcr.io --username "$registry_user" --password-stdin >/dev/null
printf '%s\n' "$registry_token" |
  sudo -n -u "$worker_user" env \
    HOME="$worker_home" \
    XDG_RUNTIME_DIR="/run/user/$worker_uid" \
    DOCKER_HOST="unix://$podman_socket" \
    /usr/bin/docker login ghcr.io --username "$registry_user" --password-stdin >/dev/null
unset registry_token
trap 'docker logout ghcr.io >/dev/null 2>&1 || true; run_worker logout ghcr.io >/dev/null 2>&1 || true' EXIT

old_image_id="$(docker inspect tabtin-community-django-1 --format '{{.Image}}')"
[[ "$old_image_id" =~ ^sha256:[0-9a-f]{64}$ ]] ||
  die "cannot resolve the running Django image"

log "pulling immutable Django image"
docker pull "$requested_django"
new_image_id="$(docker image inspect "$requested_django" --format '{{.Id}}')"
[[ "$new_image_id" =~ ^sha256:[0-9a-f]{64}$ ]] ||
  die "cannot resolve the pulled image"

log "pulling immutable Cloud Runtime and Worker images into rootless Podman"
run_worker pull "$requested_runtime"
run_worker pull "$requested_worker"

worker_staging="$(sudo -n -u "$worker_user" mktemp -d "$worker_home/deploy.XXXXXX")"
worker_container="$(run_worker create "$requested_worker")"
cleanup_worker_staging() {
  if [[ -n "${worker_container:-}" ]]; then
    run_worker rm "$worker_container" >/dev/null 2>&1 || true
  fi
  if [[ -n "${worker_staging:-}" && "$worker_staging" == "$worker_home"/deploy.* ]]; then
    sudo -n -u "$worker_user" rm -r -- "$worker_staging" >/dev/null 2>&1 || true
  fi
}
trap 'cleanup_worker_staging; docker logout ghcr.io >/dev/null 2>&1 || true; run_worker logout ghcr.io >/dev/null 2>&1 || true' EXIT
run_worker cp "$worker_container:/app/dist" "$worker_staging/"
run_worker rm "$worker_container" >/dev/null
worker_container=""
[[ -f "$worker_staging/dist/index.js" ]] || die "Worker image does not contain dist/index.js"

worker_release="$worker_release_root/$requested_sha"
sudo -n install -d -o root -g root -m 0755 "$worker_release_root"
if [[ -e "$worker_release" ]]; then
  sudo -n rm -r -- "$worker_release"
fi
sudo -n install -d -o root -g root -m 0755 "$worker_release"
sudo -n cp -a "$worker_staging/dist" "$worker_release/dist"
sudo -n chown -R root:root "$worker_release"
sudo -n chmod -R a-w "$worker_release"
sudo -n ln -sfn "$worker_release" /opt/tabtin-cloud-worker/current
cleanup_worker_staging

worker_token="$(sudo -n cat "$worker_token_file")"
[[ "$worker_token" =~ ^[0-9a-f]{64}$ ]] || die "invalid persistent Worker token"
worker_env_tmp="$(mktemp)"
worker_json_tmp="$(mktemp)"
curl_config="$(mktemp)"
trap 'rm -f "$worker_env_tmp" "$worker_json_tmp" "$curl_config"; docker logout ghcr.io >/dev/null 2>&1 || true; run_worker logout ghcr.io >/dev/null 2>&1 || true' EXIT
umask 077
{
  printf 'TABTIN_CLOUD_WORKER_HOST=172.17.0.1\n'
  printf 'TABTIN_CLOUD_WORKER_PORT=8090\n'
  printf 'TABTIN_CLOUD_WORKER_TOKEN=%s\n' "$worker_token"
  printf 'TABTIN_CLOUD_WORKER_PROTOCOL_VERSION=1\n'
  printf 'TABTIN_CLOUD_WORKER_RUNTIME_VERSION=%s\n' "$requested_sha"
  printf 'TABTIN_CLOUD_RUNTIME_NETWORK=tabtin-cloud-runtime\n'
  printf 'TABTIN_CLOUD_CONTAINER_CLI=/usr/bin/docker\n'
  printf 'TABTIN_CLOUD_STORAGE_QUOTA_MODE=podman-xfs\n'
  printf 'TABTIN_CLOUD_RUNTIME_STORAGE_GB=2\n'
  printf 'TABTIN_CLOUD_RESOURCE_ISOLATION_MODE=cgroup-v2\n'
  printf 'DOCKER_HOST=unix://%s\n' "$podman_socket"
} > "$worker_env_tmp"
sudo -n install -o root -g root -m 0600 "$worker_env_tmp" "$worker_env_file"

sudo -n systemctl enable --now tabtin-cloud-worker
for _attempt in $(seq 1 30); do
  [[ "$(sudo -n systemctl is-active tabtin-cloud-worker 2>/dev/null || true)" == "active" ]] && break
  sleep 2
done
if [[ "$(sudo -n systemctl is-active tabtin-cloud-worker 2>/dev/null || true)" != "active" ]]; then
  sudo -n journalctl -u tabtin-cloud-worker -n 120 --no-pager >&2 || true
  die "Cloud Worker service did not become active"
fi

printf 'header = "Authorization: Bearer %s"\n' "$worker_token" > "$curl_config"
worker_health="$(curl --fail --silent --show-error --max-time 20 \
  --resolve tabtin.dovelora.com:443:127.0.0.1 \
  --config "$curl_config" "$worker_endpoint/v1/health")" ||
  die "Cloud Worker HTTPS health request failed"
grep -q '"protocolVersion":"1"' <<<"$worker_health" || die "Worker protocol health gate failed"
grep -q "\"runtimeVersion\":\"$requested_sha\"" <<<"$worker_health" || die "Worker runtime health gate failed"
grep -q '"storageQuotaMode":"podman-xfs"' <<<"$worker_health" || die "Worker quota health gate failed"
grep -q '"resourceIsolationMode":"cgroup-v2"' <<<"$worker_health" || die "Worker isolation health gate failed"

printf '{"sg01-cloud-1":{"name":"TabTin sg01 Cloud Worker","edition":"saas","endpoint":"%s","token":"%s","protocol_version":"1","runtime_version":"%s","storage_quota_mode":"podman-xfs","resource_isolation_mode":"cgroup-v2","capacity_cpu_millicores":2000,"capacity_memory_mb":4096,"capacity_storage_gb":20}}\n' \
  "$worker_endpoint" "$worker_token" "$requested_sha" > "$worker_json_tmp"
docker run --rm --interactive --user 0:0 \
  --volume tabtin-community-installation-secrets:/secrets \
  --entrypoint sh "$requested_django" \
  -c 'umask 077; cat > /secrets/TABTIN_CLOUD_WORKERS_JSON; chown 10001:10001 /secrets/TABTIN_CLOUD_WORKERS_JSON; chmod 0400 /secrets/TABTIN_CLOUD_WORKERS_JSON' \
  < "$worker_json_tmp"

upsert_runtime_env() {
  local key="$1"
  local value="$2"
  sudo -n python3 -c '
from pathlib import Path
import os, sys, tempfile
path = Path(sys.argv[1])
key, value = sys.argv[2], sys.argv[3]
lines = [line for line in path.read_text(encoding="utf-8").splitlines() if not line.startswith(key + "=")]
lines.append(f"{key}={value}")
stat = path.stat()
fd, temporary = tempfile.mkstemp(prefix=path.name + ".", dir=path.parent)
try:
    with os.fdopen(fd, "w", encoding="utf-8") as stream:
        stream.write("\n".join(lines) + "\n")
    os.chmod(temporary, stat.st_mode)
    os.chown(temporary, stat.st_uid, stat.st_gid)
    os.replace(temporary, path)
except BaseException:
    try:
        os.unlink(temporary)
    except FileNotFoundError:
        pass
    raise
' "$runtime_env_file" "$key" "$value"
}
upsert_runtime_env TABTIN_CLOUD_RUNTIME_IMAGE "$requested_runtime"
upsert_runtime_env TABTIN_CLOUD_WORKERS_JSON_FILE /run/tabtin-community-secrets/TABTIN_CLOUD_WORKERS_JSON

docker image tag "$new_image_id" "$local_image"
docker logout ghcr.io >/dev/null 2>&1 || true
run_worker logout ghcr.io >/dev/null 2>&1 || true
rm -f "$worker_env_tmp" "$worker_json_tmp" "$curl_config"
unset worker_token
trap - EXIT

compose() {
  docker compose -f "$compose_file" "$@"
}

wait_for_health() {
  local container="$1"
  local attempts="$2"
  local status=""
  for ((attempt = 1; attempt <= attempts; attempt += 1)); do
    status="$(docker inspect "$container" --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' 2>/dev/null || true)"
    if [[ "$status" == "healthy" ]]; then
      return 0
    fi
    if [[ "$status" == "exited" || "$status" == "dead" ]]; then
      return 1
    fi
    sleep 5
  done
  return 1
}

log "checking migration plan"
compose run --rm --no-deps --user 0:0 \
  -e PG_DB_USER=tabtin_migrator \
  -e PG_DB_PASSWORD_FILE=/run/tabtin-community-secrets/PG_MIGRATOR_PASSWORD \
  --entrypoint python django \
  manage.py safe_migrate --plan --no-input

log "entering maintenance window before migration"
compose stop celery django

log "applying release migrations"
compose run --rm --no-deps --user 0:0 \
  -e PG_DB_USER=tabtin_migrator \
  -e PG_DB_PASSWORD_FILE=/run/tabtin-community-secrets/PG_MIGRATOR_PASSWORD \
  --entrypoint python django \
  manage.py safe_migrate --no-input

log "recreating Django"
compose up -d --no-deps --no-build --force-recreate django
if ! wait_for_health tabtin-community-django-1 48; then
  docker logs --tail 200 tabtin-community-django-1 >&2 || true
  die "new Django container did not become healthy"
fi

log "recreating Celery"
compose up -d --no-deps --no-build --force-recreate celery
if ! wait_for_health tabtin-community-celery-1 24; then
  docker logs --tail 200 tabtin-community-celery-1 >&2 || true
  die "new Celery container did not become healthy"
fi

log "materializing and verifying the configured Cloud Worker"
docker exec tabtin-community-django-1 python manage.py shell -c \
  'from apps.tabtinspace.services.cloud_worker_registry import CloudWorkerRegistry; from apps.tabtinspace.tasks import heartbeat_cloud_worker_nodes; CloudWorkerRegistry().sync_configured(); result=heartbeat_cloud_worker_nodes(); assert result.get("ready") == 1, result'

if ! health_response="$(curl --fail --silent --show-error --max-time 20 "$public_health_url")"; then
  die "public readiness request failed"
fi
if ! grep -q '"status"[[:space:]]*:[[:space:]]*"ready"' <<<"$health_response"; then
  die "public readiness response did not report ready"
fi

printf '%s\n' "$requested_sha" > "$application_root/DEPLOYED_COMMIT"

log "removing previous application images"
declare -A removed_image_ids=()
while read -r repository image_id; do
  [[ "$repository" == "tabtin/community-django" ||
    "$repository" == "$django_repository" ]] || continue
  [[ "$image_id" != "$new_image_id" ]] || continue
  [[ -z "${removed_image_ids[$image_id]:-}" ]] || continue
  removed_image_ids[$image_id]=1
  docker image rm --force "$image_id"
done < <(docker image ls --no-trunc --format '{{.Repository}} {{.ID}}')

if [[ -d "$releases_root" ]]; then
  log "removing obsolete source releases"
  rm -f "$application_root/current"
  find "$releases_root" -mindepth 1 -maxdepth 1 -type d -exec rm -rf -- {} +
fi

log "deployment complete"
log "commit: $requested_sha"
log "Django image: $requested_django ($new_image_id)"
log "Cloud Runtime image: $requested_runtime"
log "Cloud Worker image: $requested_worker"
compose ps django celery
sudo -n systemctl --no-pager --full status tabtin-cloud-worker | sed -n '1,12p'
printf '%s\n' "$health_response"
