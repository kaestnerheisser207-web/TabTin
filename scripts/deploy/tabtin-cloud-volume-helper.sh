#!/usr/bin/env bash
set -euo pipefail

runtime_root="/Project/infrastructure/tabtin-cloud-runtime"
volume_root="$runtime_root/volumes"
state_root="/var/lib/tabtin-cloud-volume-helper"
registry_file="$state_root/registry"
lock_file="$state_root/lock"
worker_user="tabtin-cloud-worker"
minimum_project_id=10000
maximum_size_gb=1024

die() {
  printf '[tabtin-cloud-volume-helper] ERROR: %s\n' "$*" >&2
  exit 1
}

write_registry_without_volume() {
  local registry_tmp
  registry_tmp="$(mktemp "$state_root/registry.XXXXXX")"
  awk -F '\t' -v volume="$volume" '$3 != volume' "$registry_file" > "$registry_tmp"
  chmod 0600 "$registry_tmp"
  mv -f "$registry_tmp" "$registry_file"
}

write_registry_with_entry() {
  local registry_tmp
  registry_tmp="$(mktemp "$state_root/registry.XXXXXX")"
  cat "$registry_file" > "$registry_tmp"
  printf '%s\t%s\t%s\n' "$project_id" "$size_gb" "$volume" >> "$registry_tmp"
  chmod 0600 "$registry_tmp"
  mv -f "$registry_tmp" "$registry_file"
}

handle_action() {
  [[ "$#" -ge 2 ]] || die "usage: <create|inspect|delete> <volume> [size-gb]"
  local action="$1"
  local volume="$2"
  shift 2

  local uuid='[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}'
  [[ "$volume" =~ ^cloud-workspace-${uuid}(-runtime)?$ ]] || die "invalid volume name"
  local volume_path="$volume_root/$volume"
  [[ "$volume_path" == "$volume_root/"* ]] || die "volume escaped the managed root"

  [[ -d "$runtime_root" ]] || die "runtime root is missing"
  findmnt -T "$runtime_root" -n -o FSTYPE | grep -qx xfs || die "runtime root is not XFS"
  findmnt -T "$runtime_root" -n -o OPTIONS | grep -Eq '(^|,)(pquota|prjquota)(,|$)' ||
    die "runtime root is missing project quotas"
  id "$worker_user" >/dev/null 2>&1 || die "worker user is missing"

  install -d -o root -g root -m 0711 "$volume_root"
  install -d -o root -g root -m 0700 "$state_root"
  touch "$registry_file" "$lock_file"
  chmod 0600 "$registry_file" "$lock_file"
  exec 9>"$lock_file"
  flock -x 9

  local registry_entry
  registry_entry="$(awk -F '\t' -v volume="$volume" '$3 == volume { print; exit }' "$registry_file")"

  case "$action" in
  create)
    [[ "$#" -eq 1 ]] || die "create requires exactly one size-gb"
    size_gb="$1"
    [[ "$size_gb" =~ ^[1-9][0-9]*$ ]] || die "size-gb must be a positive integer"
    (( size_gb <= maximum_size_gb )) || die "size-gb exceeds the host maximum"

    if [[ -n "$registry_entry" ]]; then
      IFS=$'\t' read -r project_id registered_size registered_volume <<<"$registry_entry"
      [[ "$registered_volume" == "$volume" ]] || die "invalid registry entry"
      [[ "$registered_size" == "$size_gb" ]] || die "existing volume size differs"
    else
      highest_project_id="$(awk -F '\t' -v minimum="$minimum_project_id" '
        BEGIN { highest = minimum - 1 }
        $1 ~ /^[0-9]+$/ && $1 > highest { highest = $1 }
        END { print highest }
      ' "$registry_file")"
      project_id="$((highest_project_id + 1))"
      (( project_id <= 2147483647 )) || die "project id space exhausted"
      write_registry_with_entry
    fi

    install -d -o "$worker_user" -g "$worker_user" -m 0700 "$volume_path"
    xfs_quota -x -c "project -s -p $volume_path $project_id" "$runtime_root" >/dev/null
    xfs_quota -x -c "limit -p bhard=${size_gb}g $project_id" "$runtime_root" >/dev/null
    printf '%s\n' "$volume_path"
    ;;
  inspect)
    [[ "$#" -eq 0 ]] || die "inspect accepts no extra arguments"
    [[ -n "$registry_entry" && -d "$volume_path" ]] || die "volume not found"
    printf '%s\n' "$volume_path"
    ;;
  delete)
    [[ "$#" -eq 0 ]] || die "delete accepts no extra arguments"
    [[ -n "$registry_entry" ]] || exit 0
    IFS=$'\t' read -r project_id _registered_size registered_volume <<<"$registry_entry"
    [[ "$registered_volume" == "$volume" ]] || die "invalid registry entry"
    if [[ -e "$volume_path" ]]; then
      find "$volume_path" -xdev -depth -delete
    fi
    xfs_quota -x -c "limit -p bsoft=0 bhard=0 $project_id" "$runtime_root" >/dev/null
    write_registry_without_volume
    ;;
  *)
    die "unsupported action"
    ;;
  esac
}

serve_socket() {
  local request
  IFS= read -r request || die "empty request"
  [[ ${#request} -le 512 ]] || die "request is too large"
  local -a request_args=()
  IFS=$'\t' read -r -a request_args <<<"$request"
  local response
  if response="$(handle_action "${request_args[@]}" 2>&1)"; then
    response="$(tr '\t\n' '  ' <<<"$response")"
    printf 'OK\t%s\n' "$response"
  else
    response="$(tr '\t\n' '  ' <<<"$response" | tail -c 2048)"
    printf 'ERR\t%s\n' "$response"
  fi
}

[[ "${EUID}" -eq 0 ]] || die "run as root"
if [[ "${1:-}" == "serve" ]]; then
  [[ "$#" -eq 1 ]] || die "serve accepts no extra arguments"
  serve_socket
else
  handle_action "$@"
fi
