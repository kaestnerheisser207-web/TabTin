#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
artifact_root="${repo_root}/community-assets/postgres/baseline"
probe_suffix="$$"
network_name="tabtin-community-baseline-${probe_suffix}"
postgres_name="tabtin-community-baseline-postgres-${probe_suffix}"
source_database="tabtin_baseline_source_${probe_suffix}"
restore_database="tabtin_baseline_restore_${probe_suffix}"
django_image="muse/community-django:dev"
temporary_root=""

cleanup() {
  docker rm -f "${postgres_name}" >/dev/null 2>&1 || true
  docker network rm "${network_name}" >/dev/null 2>&1 || true
  case "${temporary_root}" in
    "${artifact_root}"/.build.*)
      rm -f \
        "${temporary_root}/community-baseline.dump" \
        "${temporary_root}/community-baseline.list" \
        "${temporary_root}/community-baseline.json"
      rmdir "${temporary_root}" >/dev/null 2>&1 || true
      ;;
  esac
}
trap cleanup EXIT

for command in docker sed awk; do
  command -v "${command}" >/dev/null 2>&1 || {
    echo "missing required command: ${command}" >&2
    exit 1
  }
done

sha256_file() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  elif command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    echo "missing required SHA-256 command: shasum or sha256sum" >&2
    return 1
  fi
}

mkdir -p "${artifact_root}"
temporary_root="$(mktemp -d "${artifact_root}/.build.XXXXXX")"
dump_path="${temporary_root}/community-baseline.dump"
toc_path="${temporary_root}/community-baseline.list"
manifest_path="${temporary_root}/community-baseline.json"

echo "[baseline] building the Community Django dependency image"
bash "${repo_root}/scripts/community/ensure-env-file.sh" "${repo_root}"
unset MUSE_EDITION AUTH_FIXED_VERIFICATION_CODE
COMPOSE_DISABLE_ENV_FILE=1 \
  MUSE_DEV_DEPENDENCY_FINGERPRINT=baseline-builder \
  docker compose \
    --project-directory "${repo_root}" \
    --env-file "${repo_root}/.env" \
    -f "${repo_root}/compose.yaml" \
    -f "${repo_root}/compose.community-dev.yaml" \
    build django

docker network create "${network_name}" >/dev/null
docker run -d \
  --name "${postgres_name}" \
  --network "${network_name}" \
  --network-alias postgres \
  -e POSTGRES_HOST_AUTH_METHOD=trust \
  -e POSTGRES_USER=postgres \
  -e POSTGRES_DB="${source_database}" \
  pgvector/pgvector:pg16 >/dev/null

for _attempt in $(seq 1 60); do
  if docker exec "${postgres_name}" pg_isready -U postgres -d "${source_database}" >/dev/null 2>&1; then
    break
  fi
  if [ "${_attempt}" -eq 60 ]; then
    echo "baseline PostgreSQL did not become ready" >&2
    exit 1
  fi
  sleep 1
done

run_django() {
  local database_name="$1"
  local database_user="$2"
  shift 2
  docker run --rm \
    --network "${network_name}" \
    --entrypoint python \
    -v "${repo_root}/apps/tabtin_django:/app/apps/tabtin_django" \
    -v "${repo_root}/packages:/app/packages:ro" \
    -w /app/apps/tabtin_django \
    -e DJANGO_SETTINGS_MODULE=tabtin.settings \
    -e MUSE_EDITION=community \
    -e MUSE_DATABASE_MODE=single_pg \
    -e DEBUG=True \
    -e SECRET_KEY=community-baseline-build-secret-key \
    -e JWT_SECRET_KEY=community-baseline-build-jwt-secret \
    -e CREDENTIAL_ENCRYPTION_KEY=MDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDA= \
    -e PG_DB_HOST=postgres \
    -e PG_DB_PORT=5432 \
    -e PG_DB_NAME="${database_name}" \
    -e PG_DB_USER="${database_user}" \
    -e SERVICES_OSS_PROVIDER=local \
    -e LOCAL_OSS_ROOT=/tmp/tabtin-community-baseline-objects \
    -e REDIS_URL=redis://127.0.0.1:6379/0 \
    "${django_image}" manage.py "$@"
}

echo "[baseline] applying the complete migration graph once"
run_django "${source_database}" postgres safe_migrate --noinput

migration_count="$(docker exec "${postgres_name}" psql -U postgres -d "${source_database}" -Atc 'SELECT COUNT(*) FROM django_migrations')"
table_count="$(docker exec "${postgres_name}" psql -U postgres -d "${source_database}" -Atc "SELECT COUNT(*) FROM pg_tables WHERE schemaname='public'")"
if [ "${migration_count}" -lt 1 ] || [ "${table_count}" -lt 1 ]; then
  echo "baseline source database is incomplete" >&2
  exit 1
fi

docker exec "${postgres_name}" pg_dump \
  -U postgres \
  -d "${source_database}" \
  -Fc \
  --no-owner \
  --no-privileges > "${dump_path}"
docker exec -i "${postgres_name}" pg_restore -l < "${dump_path}" \
  | sed '/ EXTENSION /d; /COMMENT - EXTENSION /d' > "${toc_path}"
if grep -Eq ' EXTENSION |COMMENT - EXTENSION' "${toc_path}"; then
  echo "filtered baseline TOC still contains extension objects" >&2
  exit 1
fi

docker exec "${postgres_name}" psql -U postgres -d "${source_database}" -v ON_ERROR_STOP=1 -c \
  "CREATE ROLE tabtin_migrator LOGIN;" >/dev/null
docker exec "${postgres_name}" createdb -U postgres -O postgres "${restore_database}"
docker exec "${postgres_name}" psql -U postgres -d "${restore_database}" -v ON_ERROR_STOP=1 -c \
  "CREATE EXTENSION vector; CREATE EXTENSION pg_trgm; GRANT CONNECT, CREATE, TEMPORARY ON DATABASE ${restore_database} TO tabtin_migrator; GRANT USAGE, CREATE ON SCHEMA public TO tabtin_migrator;" >/dev/null
docker cp "${dump_path}" "${postgres_name}:/tmp/community-baseline.dump" >/dev/null
docker cp "${toc_path}" "${postgres_name}:/tmp/community-baseline.list" >/dev/null
docker exec "${postgres_name}" pg_restore \
  -U tabtin_migrator \
  -d "${restore_database}" \
  --single-transaction \
  --exit-on-error \
  --no-owner \
  --no-privileges \
  --use-list /tmp/community-baseline.list \
  /tmp/community-baseline.dump

echo "[baseline] verifying restore plus post-baseline migrations"
run_django "${restore_database}" tabtin_migrator safe_migrate --noinput
restored_migrations="$(docker exec "${postgres_name}" psql -U postgres -d "${restore_database}" -Atc 'SELECT COUNT(*) FROM django_migrations')"
restored_tables="$(docker exec "${postgres_name}" psql -U postgres -d "${restore_database}" -Atc "SELECT COUNT(*) FROM pg_tables WHERE schemaname='public'")"
if [ "${restored_migrations}" != "${migration_count}" ] || [ "${restored_tables}" != "${table_count}" ]; then
  echo "baseline restore verification mismatch" >&2
  exit 1
fi

dump_sha256="$(sha256_file "${dump_path}")"
toc_sha256="$(sha256_file "${toc_path}")"
printf '%s\n' \
  '{' \
  '  "format_version": 1,' \
  '  "postgres_major": 16,' \
  '  "stage": "post_migrate_pre_bootstrap",' \
  "  \"migration_count\": ${migration_count}," \
  "  \"table_count\": ${table_count}," \
  '  "dump_file": "community-baseline.dump",' \
  '  "toc_file": "community-baseline.list",' \
  "  \"dump_sha256\": \"${dump_sha256}\"," \
  "  \"toc_sha256\": \"${toc_sha256}\"" \
  '}' > "${manifest_path}"

mv "${dump_path}" "${artifact_root}/community-baseline.dump"
mv "${toc_path}" "${artifact_root}/community-baseline.list"
mv "${manifest_path}" "${artifact_root}/community-baseline.json"
rmdir "${temporary_root}"
temporary_root=""

echo "[baseline] published migrations=${migration_count} tables=${table_count}"
