#!/usr/bin/env bash
set -euo pipefail

application_root="/Project/applications/tabtin"
standard_release="$application_root/bin/tabtin-vps-release.sh"
cloud_release="$application_root/bin/tabtin-cloud-vps-release.sh"

die() {
  printf '[tabtin-deploy-gateway] ERROR: %s\n' "$*" >&2
  exit 1
}

read -r command arg1 arg2 arg3 arg4 arg5 extra <<<"${SSH_ORIGINAL_COMMAND:-}"

if [[ "$command" == "deploy" ]]; then
  [[ -z "${extra:-}" ]] ||
    die "restricted key accepts only five deploy arguments"
  [[ "$arg1" =~ ^[0-9a-f]{40}$ ]] || die "release commit must be a full lowercase SHA"
  [[ "$arg2" =~ ^ghcr\.io/kaestnerheisser207-web/tabtin-community-django@sha256:[0-9a-f]{64}$ ]] ||
    die "invalid Django image"
  [[ "$arg3" =~ ^ghcr\.io/kaestnerheisser207-web/tabtin-web@sha256:[0-9a-f]{64}$ ]] ||
    die "invalid Web image"
  [[ "$arg4" =~ ^ghcr\.io/kaestnerheisser207-web/tabtin-collab-live@sha256:[0-9a-f]{64}$ ]] ||
    die "invalid Collab image"
  [[ "$arg5" =~ ^[A-Za-z0-9-]{1,39}$ ]] || die "invalid registry user"
  unset SSH_ORIGINAL_COMMAND
  exec sudo -n "$standard_release" "$arg1" "$arg2" "$arg3" "$arg4" "$arg5"
fi

if [[ "$command" == "deploy-cloud" ]]; then
  [[ -z "${arg5:-}" && -z "${extra:-}" ]] ||
    die "restricted key accepts only four deploy-cloud arguments"
  [[ "$arg1" =~ ^[0-9a-f]{40}$ ]] || die "release commit must be a full lowercase SHA"
  [[ "$arg2" =~ ^ghcr\.io/kaestnerheisser207-web/tabtin-cloud-runtime@sha256:[0-9a-f]{64}$ ]] ||
    die "invalid Cloud Runtime image"
  [[ "$arg3" =~ ^ghcr\.io/kaestnerheisser207-web/tabtin-cloud-worker@sha256:[0-9a-f]{64}$ ]] ||
    die "invalid Cloud Worker image"
  [[ "$arg4" =~ ^[A-Za-z0-9-]{1,39}$ ]] || die "invalid registry user"
  unset SSH_ORIGINAL_COMMAND
  exec sudo -n "$cloud_release" "$arg1" "$arg2" "$arg3" "$arg4"
fi

die "restricted key accepts only deploy or deploy-cloud"
