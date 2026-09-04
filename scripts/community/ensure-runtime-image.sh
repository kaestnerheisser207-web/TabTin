#!/usr/bin/env bash
set -euo pipefail

repo_root="${1:?repository root is required}"
compose_file="${repo_root}/compose.yaml"
env_file="${repo_root}/.env"
image="muse/community-django:local"
label="com.tabtin.community.dev-dependency-fingerprint"

hash_file_list() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$@" | shasum -a 256 | awk '{print $1}'
  else
    sha256sum "$@" | sha256sum | awk '{print $1}'
  fi
}

fingerprint="$(hash_file_list \
  "${repo_root}/apps/tabtin_django/Dockerfile" \
  "${repo_root}/apps/tabtin_django/requirements.txt" \
  "${repo_root}/apps/tabtin_django/docker-entrypoint.sh" \
  "${repo_root}/community-assets/postgres/baseline/community-baseline.json")"
current="$(docker image inspect \
  --format "{{ index .Config.Labels \"${label}\" }}" \
  "${image}" 2>/dev/null || true)"

if [ "${current}" = "${fingerprint}" ]; then
  printf '%s\n' 'Reusing Community Docker image (dependency fingerprint unchanged).'
  exit 0
fi

printf '%s\n' 'Building Community Docker image (dependency fingerprint changed).'
unset MUSE_EDITION AUTH_FIXED_VERIFICATION_CODE
retry_count=0
max_retries=3
until MUSE_DOCKER_DEPENDENCY_FINGERPRINT="${fingerprint}" docker compose \
    --project-directory "${repo_root}" \
    --env-file "${env_file}" \
    -f "${compose_file}" \
    build django; do
  if [ "${retry_count}" -ge "${max_retries}" ]; then
    printf 'ERROR: Community Docker image build failed after %s attempts.\n' \
      "$((max_retries + 1))" >&2
    exit 1
  fi
  retry_count=$((retry_count + 1))
  printf 'Community Docker image build failed; retrying (%s/%s) in 2 seconds...\n' \
    "${retry_count}" "${max_retries}" >&2
  sleep 2
done
