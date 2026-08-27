#!/usr/bin/env bash
set -euo pipefail

repository="kaestnerheisser207-web/TabTin"
application_root="/Project/applications/tabtin"
releases_root="$application_root/releases"
compose_file="$application_root/config/compose.shared.yml"
backup_root="/Project/infrastructure/postgres/backups"
public_health_url="https://tabtin.dovelora.com/health/ready"
image_repository="tabtin/community-django"
lock_file="$application_root/.deploy.lock"

log() {
  printf '[tabtin-deploy] %s\n' "$*"
}

die() {
  printf '[tabtin-deploy] ERROR: %s\n' "$*" >&2
  exit 1
}

requested_sha="${1:-}"
if [[ -n "${SSH_ORIGINAL_COMMAND:-}" ]]; then
  read -r command requested_sha extra <<<"$SSH_ORIGINAL_COMMAND"
  [[ "$command" == "deploy" && -z "${extra:-}" ]] ||
    die "restricted key accepts only: deploy <40-character commit sha>"
fi

[[ "$requested_sha" =~ ^[0-9a-f]{40}$ ]] ||
  die "release commit must be a full lowercase SHA"

short_sha="${requested_sha:0:12}"
release_dir="$releases_root/$requested_sha"
source_archive="$release_dir/source.tar.gz"
release_image="$image_repository:release-$short_sha"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
backup_file="$backup_root/tabtin-pre-release-$short_sha-$timestamp.dump"
rollback_image="$image_repository:rollback-$timestamp"

mkdir -p "$application_root" "$releases_root" "$backup_root"
exec 9>"$lock_file"
flock -n 9 || die "another TabTin deployment is already running"

[[ -f "$compose_file" ]] || die "missing compose file: $compose_file"

if [[ ! -f "$release_dir/apps/tabtin_django/Dockerfile" ]]; then
  log "downloading source for $requested_sha"
  mkdir -p "$release_dir"
  temporary_archive="$source_archive.part"
  curl \
    --fail \
    --location \
    --silent \
    --show-error \
    --retry 3 \
    --output "$temporary_archive" \
    "https://github.com/$repository/archive/$requested_sha.tar.gz"
  tar -xzf "$temporary_archive" --strip-components=1 -C "$release_dir"
  mv "$temporary_archive" "$source_archive"
fi

[[ -f "$release_dir/apps/tabtin_django/apps/meetings/migrations/0002_remove_meeting_pause.py" ]] ||
  die "release does not contain the expected meeting migration"
dependency_fingerprint="$(sha256sum "$release_dir/apps/tabtin_django/requirements.txt" | awk '{print $1}')"
[[ "$dependency_fingerprint" =~ ^[0-9a-f]{64}$ ]] ||
  die "cannot calculate the Django dependency fingerprint"

running_image_id="$(docker inspect tabtin-community-django-1 --format '{{.Image}}')"
[[ -n "$running_image_id" ]] || die "cannot resolve the running Django image"
docker image tag "$running_image_id" "$rollback_image"
log "rollback image: $rollback_image ($running_image_id)"

log "creating PostgreSQL backup: $backup_file"
docker exec -u postgres postgres pg_dump -Fc -d tabtin > "$backup_file"
[[ -s "$backup_file" ]] || die "PostgreSQL backup is empty"
docker exec -i -u postgres postgres pg_restore -l < "$backup_file" >/dev/null
sha256sum "$backup_file"

if ! docker image inspect "$release_image" >/dev/null 2>&1; then
  log "building $release_image"
  docker build \
    --build-arg BASE_IMAGE=python:3.11-slim \
    --build-arg INSTALL_PLAYWRIGHT=true \
    --build-arg "TABTIN_DEV_DEPENDENCY_FINGERPRINT=$dependency_fingerprint" \
    --file "$release_dir/apps/tabtin_django/Dockerfile" \
    --tag "$release_image" \
    "$release_dir"
else
  log "reusing existing image: $release_image"
fi

docker image tag "$release_image" "$image_repository:local"
deployment_complete="false"

restore_local_image_tag() {
  if [[ "$deployment_complete" != "true" ]]; then
    docker image tag "$rollback_image" "$image_repository:local" || true
  fi
}

trap restore_local_image_tag EXIT

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

rollback_runtime() {
  log "rolling runtime containers back to $rollback_image"
  docker image tag "$rollback_image" "$image_repository:local"
  compose up -d --no-deps --force-recreate django
  wait_for_health tabtin-community-django-1 48 || true
  compose up -d --no-deps --force-recreate celery
}

log "checking migration plan"
compose run --rm --no-deps --user 0:0 \
  -e PG_DB_USER=tabtin_migrator \
  -e PG_DB_PASSWORD_FILE=/run/tabtin-community-secrets/PG_MIGRATOR_PASSWORD \
  --entrypoint python django \
  manage.py safe_migrate meetings --plan --no-input

log "applying reviewed meeting migrations"
compose run --rm --no-deps --user 0:0 \
  -e PG_DB_USER=tabtin_migrator \
  -e PG_DB_PASSWORD_FILE=/run/tabtin-community-secrets/PG_MIGRATOR_PASSWORD \
  --entrypoint python django \
  manage.py safe_migrate meetings --no-input

log "recreating Django"
compose up -d --no-deps --force-recreate django
if ! wait_for_health tabtin-community-django-1 48; then
  docker logs --tail 200 tabtin-community-django-1 >&2 || true
  rollback_runtime
  die "new Django container did not become healthy"
fi

log "recreating Celery"
compose up -d --no-deps --force-recreate celery
if ! wait_for_health tabtin-community-celery-1 24; then
  docker logs --tail 200 tabtin-community-celery-1 >&2 || true
  rollback_runtime
  die "new Celery container did not become healthy"
fi

if ! health_response="$(curl --fail --silent --show-error --max-time 20 "$public_health_url")"; then
  rollback_runtime
  die "public readiness request failed"
fi
if ! grep -q '"status"[[:space:]]*:[[:space:]]*"ready"' <<<"$health_response"; then
  rollback_runtime
  die "public readiness response did not report ready"
fi

ln -sfn "$release_dir" "$application_root/current"
printf '%s\n' "$requested_sha" > "$release_dir/DEPLOYED_COMMIT"
deployment_complete="true"
trap - EXIT

log "deployment complete"
log "commit: $requested_sha"
log "image: $(docker image inspect "$release_image" --format '{{.Id}}')"
compose ps django celery
printf '%s\n' "$health_response"
