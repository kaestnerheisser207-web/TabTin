#!/usr/bin/env bash
set -euo pipefail

repo_root="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
compose_file="${repo_root}/compose.yaml"
env_file="${repo_root}/.env"
export COMPOSE_DISABLE_ENV_FILE=1
unset TABTIN_EDITION AUTH_FIXED_VERIFICATION_CODE

fail() {
  printf 'ERROR: %s\n' "$1" >&2
  exit 1
}

command -v docker >/dev/null 2>&1 || fail \
  "Docker is not installed."
docker compose version >/dev/null 2>&1 || fail \
  "Docker Compose is not available."
docker info >/dev/null 2>&1 || fail \
  "Docker Engine is not running. Start Docker Desktop and try again."
[[ -f "${env_file}" ]] || fail \
  "Missing ${env_file}. Run ./start.sh once before stopping Muse Community."
bash "${repo_root}/scripts/community/ensure-env-file.sh" "${repo_root}"

docker compose \
  --project-directory "${repo_root}" \
  --env-file "${env_file}" \
  -f "${compose_file}" \
  down

printf 'Muse Community stopped. Your data and Docker volumes were preserved.\n'
