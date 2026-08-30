#!/usr/bin/env bash
set -euo pipefail

application_root="/Project/applications/tabtin"
releases_root="$application_root/releases"
compose_file="$application_root/config/compose.shared.yml"
public_health_url="https://tabtin.dovelora.com/health/ready"
local_django_image="tabtin/community-django:local"
local_web_image="tabtin/web:local"
local_collab_image="tabtin/collab-live:local"
django_repository="ghcr.io/kaestnerheisser207-web/tabtin-community-django"
web_repository="ghcr.io/kaestnerheisser207-web/tabtin-web"
collab_repository="ghcr.io/kaestnerheisser207-web/tabtin-collab-live"
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
requested_web="${3:-}"
requested_collab="${4:-}"
registry_user="${5:-}"
if [[ -n "${SSH_ORIGINAL_COMMAND:-}" ]]; then
  read -r command requested_sha requested_django requested_web requested_collab registry_user extra <<<"$SSH_ORIGINAL_COMMAND"
  [[ "$command" == "deploy" && -z "${extra:-}" ]] ||
    die "restricted key accepts only: deploy <commit-sha> <django-digest-ref> <web-digest-ref> <collab-digest-ref> <registry-user>"
fi

[[ "$requested_sha" =~ ^[0-9a-f]{40}$ ]] ||
  die "release commit must be a full lowercase SHA"
[[ "$requested_django" =~ ^ghcr\.io/kaestnerheisser207-web/tabtin-community-django@sha256:[0-9a-f]{64}$ ]] ||
  die "Django image must be the approved GHCR repository pinned by digest"
[[ "$requested_web" =~ ^ghcr\.io/kaestnerheisser207-web/tabtin-web@sha256:[0-9a-f]{64}$ ]] ||
  die "Web image must be the approved GHCR repository pinned by digest"
[[ "$requested_collab" =~ ^ghcr\.io/kaestnerheisser207-web/tabtin-collab-live@sha256:[0-9a-f]{64}$ ]] ||
  die "Collab image must be the approved GHCR repository pinned by digest"
[[ "$registry_user" =~ ^[A-Za-z0-9-]{1,39}$ ]] ||
  die "invalid registry user"

mkdir -p "$application_root"
exec 9>"$lock_file"
flock -n 9 || die "another TabTin deployment is already running"
[[ -f "$compose_file" ]] || die "missing compose file: $compose_file"

registry_token=""
IFS= read -r registry_token || true
[[ -n "$registry_token" ]] || die "missing one-time registry token"
printf '%s\n' "$registry_token" |
  docker login ghcr.io --username "$registry_user" --password-stdin >/dev/null
unset registry_token
trap 'docker logout ghcr.io >/dev/null 2>&1 || true' EXIT

log "pulling immutable Django image: $requested_django"
docker pull "$requested_django"
django_image_id="$(docker image inspect "$requested_django" --format '{{.Id}}')"
[[ "$django_image_id" =~ ^sha256:[0-9a-f]{64}$ ]] ||
  die "cannot resolve the pulled Django image"
docker image tag "$django_image_id" "$local_django_image"

log "pulling immutable Web image: $requested_web"
docker pull "$requested_web"
web_image_id="$(docker image inspect "$requested_web" --format '{{.Id}}')"
[[ "$web_image_id" =~ ^sha256:[0-9a-f]{64}$ ]] ||
  die "cannot resolve the pulled Web image"
docker image tag "$web_image_id" "$local_web_image"

log "pulling immutable Collab image: $requested_collab"
docker pull "$requested_collab"
collab_image_id="$(docker image inspect "$requested_collab" --format '{{.Id}}')"
[[ "$collab_image_id" =~ ^sha256:[0-9a-f]{64}$ ]] ||
  die "cannot resolve the pulled Collab image"
docker image tag "$collab_image_id" "$local_collab_image"
docker logout ghcr.io >/dev/null 2>&1 || true
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
compose stop collab-live centrifugo tabtin-web celery django

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

log "recreating Web, Collab, and Centrifugo"
compose up -d --no-deps --no-build --force-recreate tabtin-web collab-live centrifugo
if ! wait_for_health tabtin-community-tabtin-web-1 24; then
  docker logs --tail 200 tabtin-community-tabtin-web-1 >&2 || true
  die "new Web container did not become healthy"
fi
if ! wait_for_health tabtin-community-collab-live-1 24; then
  docker logs --tail 200 tabtin-community-collab-live-1 >&2 || true
  die "new Collab container did not become healthy"
fi
if ! wait_for_health tabtin-community-centrifugo-1 24; then
  docker logs --tail 200 tabtin-community-centrifugo-1 >&2 || true
  die "new Centrifugo container did not become healthy"
fi

if ! local_health_response="$(curl --fail --silent --show-error --max-time 20 \
  -H 'Host: tabtin.dovelora.com' \
  -H 'X-Forwarded-Proto: https' \
  http://127.0.0.1:6060/health/ready)"; then
  die "local readiness request failed"
fi
if ! grep -q '"status"[[:space:]]*:[[:space:]]*"ready"' <<<"$local_health_response"; then
  die "local readiness response did not report ready"
fi

if docker inspect nginx >/dev/null 2>&1; then
  log "validating and reloading Nginx upstreams"
  docker exec nginx nginx -t
  docker exec nginx nginx -s reload
fi

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
    "$repository" == "tabtin/web" ||
    "$repository" == "tabtin/collab-live" ||
    "$repository" == "$django_repository" ||
    "$repository" == "$web_repository" ||
    "$repository" == "$collab_repository" ]] || continue
  [[ "$image_id" != "$django_image_id" &&
    "$image_id" != "$web_image_id" &&
    "$image_id" != "$collab_image_id" ]] || continue
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
log "Django image: $requested_django ($django_image_id)"
log "Web image: $requested_web ($web_image_id)"
log "Collab image: $requested_collab ($collab_image_id)"
compose ps django celery tabtin-web collab-live centrifugo
printf '%s\n' "$local_health_response"
printf '%s\n' "$health_response"
