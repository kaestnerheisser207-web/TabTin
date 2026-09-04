#!/usr/bin/env bash
set -euo pipefail

application_root="/Project/applications/tabtin"
compose_file="$application_root/config/compose.shared.yml"
runtime_env_file="$application_root/source-snapshot/.env.community-runtime"
host_config_file="/etc/tabtin/cloud-host.env"
worker_endpoint="https://tabtin.dovelora.com/_internal/cloud-worker"
local_django_image="tabtin/community-django:local"
runtime_repository="ghcr.io/kaestnerheisser207-web/tabtin-cloud-runtime"
worker_repository="ghcr.io/kaestnerheisser207-web/tabtin-cloud-worker"
worker_user="tabtin-cloud-worker"
worker_home="/var/lib/tabtin-cloud-worker"
worker_token_file="/etc/tabtin/cloud-worker.token"
worker_env_file="/etc/tabtin/cloud-worker.env"
worker_release_root="/opt/tabtin-cloud-worker/releases"
lock_file="$application_root/.deploy.lock"

log() {
  printf '[tabtin-cloud-deploy] %s\n' "$*"
}

die() {
  printf '[tabtin-cloud-deploy] ERROR: %s\n' "$*" >&2
  exit 1
}

requested_sha="${1:-}"
requested_runtime="${2:-}"
requested_worker="${3:-}"
registry_user="${4:-}"
if [[ -n "${SSH_ORIGINAL_COMMAND:-}" ]]; then
  read -r command requested_sha requested_runtime requested_worker registry_user extra <<<"$SSH_ORIGINAL_COMMAND"
  [[ "$command" == "deploy-cloud" && -z "${extra:-}" ]] ||
    die "restricted key accepts only: deploy-cloud <commit-sha> <runtime-digest-ref> <worker-digest-ref> <registry-user>"
fi

[[ "$requested_sha" =~ ^[0-9a-f]{40}$ ]] ||
  die "release commit must be a full lowercase SHA"
[[ "$requested_runtime" =~ ^ghcr\.io/kaestnerheisser207-web/tabtin-cloud-runtime@sha256:[0-9a-f]{64}$ ]] ||
  die "Cloud Runtime image must use the approved GHCR repository and digest"
[[ "$requested_worker" =~ ^ghcr\.io/kaestnerheisser207-web/tabtin-cloud-worker@sha256:[0-9a-f]{64}$ ]] ||
  die "Cloud Worker image must use the approved GHCR repository and digest"
[[ "$registry_user" =~ ^[A-Za-z0-9-]{1,39}$ ]] || die "invalid registry user"

exec 9>"$lock_file"
flock -n 9 || die "another Muse deployment is already running"
[[ -f "$compose_file" ]] || die "missing compose file: $compose_file"
[[ -f "$runtime_env_file" ]] || die "missing runtime env file: $runtime_env_file"
[[ -f "$worker_token_file" ]] || die "Cloud host bootstrap has not installed the Worker token"
[[ -f "$host_config_file" ]] || die "Cloud host bootstrap has not installed capacity config"
[[ "$(stat -c %u "$host_config_file")" -eq 0 ]] || die "Cloud host config must be root-owned"
host_config_mode="$(stat -c %a "$host_config_file")"
(( (8#$host_config_mode & 022) == 0 )) || die "Cloud host config must not be group/world writable"
# shellcheck source=/dev/null
source "$host_config_file"

: "${TABTIN_CLOUD_WORKER_NODE_KEY:?missing Worker node key}"
: "${TABTIN_CLOUD_WORKER_EDITION:?missing Worker edition}"
: "${TABTIN_CLOUD_CAPACITY_CPU_MILLICORES:?missing CPU capacity}"
: "${TABTIN_CLOUD_CAPACITY_MEMORY_MB:?missing memory capacity}"
: "${TABTIN_CLOUD_CAPACITY_STORAGE_GB:?missing storage capacity}"
: "${TABTIN_CLOUD_RUNTIME_STORAGE_GB:?missing runtime storage size}"
: "${TABTIN_CLOUD_WORKER_BIND_ADDRESS:?missing Worker bind address}"
[[ "$TABTIN_CLOUD_WORKER_NODE_KEY" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$ ]] ||
  die "invalid Worker node key"
[[ "$TABTIN_CLOUD_WORKER_EDITION" == "saas" || "$TABTIN_CLOUD_WORKER_EDITION" == "community" ]] ||
  die "invalid Worker edition"
[[ "$TABTIN_CLOUD_WORKER_BIND_ADDRESS" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] ||
  die "invalid Worker bind address"
ip -4 -o address show | awk '{ sub(/\/.*/, "", $4); print $4 }' |
  grep -Fqx "$TABTIN_CLOUD_WORKER_BIND_ADDRESS" || die "Worker bind address is not present on the host"
worker_direct_endpoint="http://$TABTIN_CLOUD_WORKER_BIND_ADDRESS:8090"
for value in \
  "$TABTIN_CLOUD_CAPACITY_CPU_MILLICORES" \
  "$TABTIN_CLOUD_CAPACITY_MEMORY_MB" \
  "$TABTIN_CLOUD_CAPACITY_STORAGE_GB" \
  "$TABTIN_CLOUD_RUNTIME_STORAGE_GB"; do
  [[ "$value" =~ ^[1-9][0-9]*$ ]] || die "capacity values must be positive integers"
done

[[ "$(cat "$application_root/DEPLOYED_COMMIT" 2>/dev/null || true)" == "$requested_sha" ]] ||
  die "Django deployment must already match the requested Cloud release"
django_revision="$(docker image inspect "$local_django_image" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' 2>/dev/null || true)"
[[ "$django_revision" == "$requested_sha" ]] ||
  die "local Django image revision does not match the requested Cloud release"
id "$worker_user" >/dev/null 2>&1 || die "Cloud Worker account is missing"
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
  sudo -n -u "$worker_user" env \
    HOME="$worker_home" \
    XDG_RUNTIME_DIR="/run/user/$worker_uid" \
    DOCKER_HOST="unix://$podman_socket" \
    /usr/bin/docker login ghcr.io --username "$registry_user" --password-stdin >/dev/null
unset registry_token
trap 'run_worker logout ghcr.io >/dev/null 2>&1 || true' EXIT

log "pulling immutable Cloud Runtime and Worker images"
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
trap 'cleanup_worker_staging; run_worker logout ghcr.io >/dev/null 2>&1 || true' EXIT
run_worker cp "$worker_container:/app/dist" "$worker_staging/"
run_worker cp \
  "$worker_container:/app/deployment/tabtin-cloud-volume-helper.sh" \
  "$worker_staging/tabtin-cloud-volume-helper.sh"
run_worker rm "$worker_container" >/dev/null
worker_container=""
[[ -f "$worker_staging/dist/index.js" ]] || die "Worker image does not contain dist/index.js"
[[ -f "$worker_staging/tabtin-cloud-volume-helper.sh" ]] ||
  die "Worker image does not contain the Cloud volume helper"
bash -n "$worker_staging/tabtin-cloud-volume-helper.sh" ||
  die "Worker image contains an invalid Cloud volume helper"

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
helper_target="$application_root/bin/tabtin-cloud-volume-helper.sh"
helper_staging="$application_root/bin/.tabtin-cloud-volume-helper.$requested_sha"
helper_sha="$(sha256sum "$worker_staging/tabtin-cloud-volume-helper.sh" | awk '{ print $1 }')"
sudo -n install -o root -g root -m 0755 \
  "$worker_staging/tabtin-cloud-volume-helper.sh" "$helper_staging"
sudo -n mv -f -- "$helper_staging" "$helper_target"
[[ "$(sha256sum "$helper_target" | awk '{ print $1 }')" == "$helper_sha" ]] ||
  die "installed Cloud volume helper checksum mismatch"
cleanup_worker_staging

worker_token="$(sudo -n cat "$worker_token_file")"
[[ "$worker_token" =~ ^[0-9a-f]{64}$ ]] || die "invalid persistent Worker token"
worker_env_tmp="$(mktemp)"
worker_json_tmp="$(mktemp)"
curl_config="$(mktemp)"
trap 'rm -f "$worker_env_tmp" "$worker_json_tmp" "$curl_config"; run_worker logout ghcr.io >/dev/null 2>&1 || true' EXIT
umask 077
{
  printf 'TABTIN_CLOUD_WORKER_HOST=%s\n' "$TABTIN_CLOUD_WORKER_BIND_ADDRESS"
  printf 'TABTIN_CLOUD_WORKER_PORT=8090\n'
  printf 'TABTIN_CLOUD_WORKER_TOKEN=%s\n' "$worker_token"
  printf 'TABTIN_CLOUD_WORKER_PROTOCOL_VERSION=1\n'
  printf 'TABTIN_CLOUD_WORKER_RUNTIME_VERSION=%s\n' "$requested_sha"
  printf 'TABTIN_CLOUD_RUNTIME_NETWORK=tabtin-cloud-runtime\n'
  printf 'TABTIN_CLOUD_CONTAINER_CLI=/usr/bin/docker\n'
  printf 'TABTIN_CLOUD_STORAGE_QUOTA_MODE=podman-xfs\n'
  printf 'TABTIN_CLOUD_RUNTIME_STORAGE_GB=%s\n' "$TABTIN_CLOUD_RUNTIME_STORAGE_GB"
  printf 'TABTIN_CLOUD_RESOURCE_ISOLATION_MODE=cgroup-v2\n'
  printf 'DOCKER_HOST=unix://%s\n' "$podman_socket"
} > "$worker_env_tmp"
sudo -n install -o root -g root -m 0600 "$worker_env_tmp" "$worker_env_file"

sudo -n systemctl enable --now tabtin-cloud-volume-helper.socket
[[ "$(sudo -n systemctl is-active tabtin-cloud-volume-helper.socket)" == "active" ]] ||
  die "Cloud volume helper socket is not active"
sudo -n systemctl enable tabtin-cloud-worker
sudo -n systemctl restart tabtin-cloud-worker
for _attempt in $(seq 1 30); do
  [[ "$(sudo -n systemctl is-active tabtin-cloud-worker 2>/dev/null || true)" == "active" ]] && break
  sleep 2
done
if [[ "$(sudo -n systemctl is-active tabtin-cloud-worker 2>/dev/null || true)" != "active" ]]; then
  sudo -n journalctl -u tabtin-cloud-worker -n 120 --no-pager >&2 || true
  die "Cloud Worker service did not become active"
fi

printf 'header = "Authorization: Bearer %s"\n' "$worker_token" > "$curl_config"
worker_health=""
for _attempt in $(seq 1 30); do
  if worker_health="$(curl --fail --silent --max-time 5 \
    --config "$curl_config" "$worker_direct_endpoint/v1/health" 2>/dev/null)"; then
    break
  fi
  sleep 1
done
if [[ -z "$worker_health" ]]; then
  sudo -n journalctl -u tabtin-cloud-worker -n 120 --no-pager >&2 || true
  die "Cloud Worker direct health request failed"
fi
grep -q '"protocolVersion":"1"' <<<"$worker_health" || die "Worker protocol health gate failed"
grep -q "\"runtimeVersion\":\"$requested_sha\"" <<<"$worker_health" || die "Worker runtime health gate failed"
grep -q '"storageQuotaMode":"podman-xfs"' <<<"$worker_health" || die "Worker quota health gate failed"
grep -q '"resourceIsolationMode":"cgroup-v2"' <<<"$worker_health" || die "Worker isolation health gate failed"
worker_metrics="$(curl --fail --silent --show-error --max-time 20 \
  --config "$curl_config" "$worker_direct_endpoint/v1/metrics")" ||
  die "Cloud Worker direct metrics request failed"
grep -q '^tabtin_cloud_worker_up 1$' <<<"$worker_metrics" ||
  die "Cloud Worker metrics readiness gate failed"

printf '{"%s":{"name":"%s","edition":"%s","endpoint":"%s","token":"%s","protocol_version":"1","runtime_version":"%s","storage_quota_mode":"podman-xfs","resource_isolation_mode":"cgroup-v2","capacity_cpu_millicores":%s,"capacity_memory_mb":%s,"capacity_storage_gb":%s}}\n' \
  "$TABTIN_CLOUD_WORKER_NODE_KEY" \
  "$TABTIN_CLOUD_WORKER_NODE_KEY" \
  "$TABTIN_CLOUD_WORKER_EDITION" \
  "$worker_endpoint" \
  "$worker_token" \
  "$requested_sha" \
  "$TABTIN_CLOUD_CAPACITY_CPU_MILLICORES" \
  "$TABTIN_CLOUD_CAPACITY_MEMORY_MB" \
  "$TABTIN_CLOUD_CAPACITY_STORAGE_GB" > "$worker_json_tmp"

docker run --rm --interactive --user 0:0 \
  --volume tabtin-community-installation-secrets:/secrets \
  --entrypoint sh "$local_django_image" \
  -c 'umask 077; cat > /secrets/TABTIN_CLOUD_WORKERS_JSON; python -c '\''from pathlib import Path; import re, secrets; path=Path("/secrets/DAEMON_TOKEN_SECRET"); raw=path.read_text(encoding="utf-8") if path.exists() else ""; candidate=raw.strip(); value=candidate if re.fullmatch(r"[A-Za-z0-9_=-]{32,256}", candidate) else secrets.token_urlsafe(48); path.write_text(value, encoding="utf-8")'\''; chown 10001:10001 /secrets/TABTIN_CLOUD_WORKERS_JSON /secrets/DAEMON_TOKEN_SECRET; chmod 0400 /secrets/TABTIN_CLOUD_WORKERS_JSON /secrets/DAEMON_TOKEN_SECRET' \
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
upsert_runtime_env DAEMON_TOKEN_SECRET_FILE /run/tabtin-community-secrets/DAEMON_TOKEN_SECRET
upsert_runtime_env TABTIN_CLOUD_RUNTIME_STORAGE_GB "$TABTIN_CLOUD_RUNTIME_STORAGE_GB"
upsert_runtime_env TABTIN_CLOUD_WORKER_EDITION "$TABTIN_CLOUD_WORKER_EDITION"
upsert_runtime_env DAEMON_SERVER_URL https://tabtin.dovelora.com
upsert_runtime_env DAEMON_WS_URL wss://tabtin.dovelora.com

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

compose config --quiet
log "recreating Django and Celery with Cloud settings"
compose up -d --no-deps --no-build --force-recreate django
if ! wait_for_health tabtin-community-django-1 48; then
  docker logs --tail 200 tabtin-community-django-1 >&2 || true
  die "Django did not become healthy with Cloud settings"
fi
compose up -d --no-deps --no-build --force-recreate celery celery-beat
if ! wait_for_health tabtin-community-celery-1 24; then
  docker logs --tail 200 tabtin-community-celery-1 >&2 || true
  die "Celery did not become healthy with Cloud settings"
fi
if ! wait_for_health tabtin-community-celery-beat-1 24; then
  docker logs --tail 200 tabtin-community-celery-beat-1 >&2 || true
  die "Celery beat did not become healthy with Cloud settings"
fi

log "materializing and verifying the configured Cloud Worker"
docker exec tabtin-community-django-1 python manage.py shell -c \
  'from apps.tabtinspace.services.cloud_worker_registry import CloudWorkerRegistry; from apps.tabtinspace.tasks import heartbeat_cloud_worker_nodes; CloudWorkerRegistry().sync_configured(); result=heartbeat_cloud_worker_nodes(); assert result.get("ready") == 1, result'

if ! health_response="$(curl --fail --silent --show-error --max-time 20 https://tabtin.dovelora.com/health/ready)"; then
  die "public readiness request failed"
fi
grep -q '"status"[[:space:]]*:[[:space:]]*"ready"' <<<"$health_response" ||
  die "public readiness response did not report ready"

printf '%s\n' "$requested_sha" > "$application_root/CLOUD_DEPLOYED_COMMIT"
log "Cloud deployment complete"
log "commit: $requested_sha"
log "Runtime image: $requested_runtime"
log "Worker image: $requested_worker"
sudo -n systemctl --no-pager --full status tabtin-cloud-worker | sed -n '1,12p'
printf '%s\n' "$health_response"
