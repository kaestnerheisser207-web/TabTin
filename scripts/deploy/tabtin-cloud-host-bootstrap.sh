#!/usr/bin/env bash
set -euo pipefail

application_root="/Project/applications/tabtin"
worker_user="tabtin-cloud-worker"
worker_home="/var/lib/tabtin-cloud-worker"
runtime_root="/Project/infrastructure/tabtin-cloud-runtime"
runtime_image="/Project/infrastructure/tabtin-cloud-runtime.xfs"
runtime_size_gb="${MUSE_CLOUD_XFS_SIZE_GB:-26}"
host_free_reserve_gb="${MUSE_CLOUD_HOST_FREE_RESERVE_GB:-64}"
host_memory_reserve_mb="${MUSE_CLOUD_HOST_MEMORY_RESERVE_MB:-8192}"
worker_node_key="${MUSE_CLOUD_WORKER_NODE_KEY:-community-cloud-1}"
worker_edition="${MUSE_CLOUD_WORKER_EDITION:-community}"
capacity_cpu_millicores="${MUSE_CLOUD_CAPACITY_CPU_MILLICORES:-2000}"
capacity_memory_mb="${MUSE_CLOUD_CAPACITY_MEMORY_MB:-4096}"
capacity_storage_gb="${MUSE_CLOUD_CAPACITY_STORAGE_GB:-20}"
runtime_storage_gb="${MUSE_CLOUD_RUNTIME_STORAGE_GB:-2}"
worker_bind_address="${MUSE_CLOUD_WORKER_BIND_ADDRESS:-172.17.0.1}"
worker_token_file="/etc/tabtin/cloud-worker.token"
host_config_file="/etc/tabtin/cloud-host.env"
nginx_config="${MUSE_NGINX_CONFIG:-/Project/infrastructure/nginx/current/nginx.conf}"
systemd_unit_source="${1:-}"
volume_socket_source="${2:-}"
volume_service_source="${3:-}"
deploy_gateway_source="${4:-}"
cloud_release_source="${5:-}"
volume_helper_source="${6:-}"
sudoers_source="${7:-}"

die() {
  printf '[tabtin-cloud-bootstrap] ERROR: %s\n' "$*" >&2
  exit 1
}

[[ "${EUID}" -eq 0 ]] || die "run as root"
for source_file in \
  "$systemd_unit_source" \
  "$volume_socket_source" \
  "$volume_service_source" \
  "$deploy_gateway_source" \
  "$cloud_release_source" \
  "$volume_helper_source" \
  "$sudoers_source"; do
  [[ -f "$source_file" ]] ||
    die "pass Worker/unit, volume helper/unit, gateway, Cloud release, and sudoers sources"
done
[[ -f "$nginx_config" ]] || die "missing Muse nginx config"
for value in \
  "$runtime_size_gb" \
  "$host_free_reserve_gb" \
  "$host_memory_reserve_mb" \
  "$capacity_cpu_millicores" \
  "$capacity_memory_mb" \
  "$capacity_storage_gb" \
  "$runtime_storage_gb"; do
  [[ "$value" =~ ^[1-9][0-9]*$ ]] || die "Cloud host capacity values must be positive integers"
done
[[ "$worker_node_key" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$ ]] ||
  die "invalid Cloud Worker node key"
[[ "$worker_edition" == "saas" || "$worker_edition" == "community" ]] ||
  die "Cloud Worker edition must be saas or community"
[[ "$worker_bind_address" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] ||
  die "invalid Cloud Worker bind address"
ip -4 -o address show | awk '{ sub(/\/.*/, "", $4); print $4 }' |
  grep -Fqx "$worker_bind_address" || die "Cloud Worker bind address is not present on the host"
(( capacity_storage_gb + 32 <= runtime_size_gb )) ||
  die "XFS size must leave at least 32 GiB outside schedulable storage"
(( capacity_cpu_millicores <= $(nproc) * 1000 )) ||
  die "configured CPU capacity exceeds host logical CPUs"
host_memory_mb="$(awk '/^MemTotal:/ { print int($2 / 1024) }' /proc/meminfo)"
(( capacity_memory_mb + host_memory_reserve_mb <= host_memory_mb )) ||
  die "configured memory capacity does not leave the required host reserve"
[[ "$(stat -fc %T /sys/fs/cgroup)" == "cgroup2fs" ]] ||
  die "Cloud Worker requires cgroup v2"
systemctl --version >/dev/null || die "Cloud Worker requires systemd"
findmnt -T /Project -n -o FSTYPE | grep -qx ext4 ||
  die "/Project must remain on the expected ext4 root before creating the XFS image"
available_gb="$(df -BG --output=avail /Project | tail -n 1 | tr -dc '0-9')"
required_free_gb="$host_free_reserve_gb"
if [[ ! -e "$runtime_image" ]]; then
  required_free_gb="$((runtime_size_gb + host_free_reserve_gb))"
fi
[[ "$available_gb" =~ ^[0-9]+$ && "$available_gb" -ge "$required_free_gb" ]] ||
  die "insufficient disk: require ${required_free_gb} GiB free before provisioning"

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends \
  aardvark-dns acl ca-certificates fuse-overlayfs nodejs passt podman slirp4netns uidmap xfsprogs
[[ -x /usr/lib/podman/aardvark-dns ]] || die "Podman aardvark DNS backend is unavailable"
command -v pasta >/dev/null || die "Podman pasta network backend is unavailable"

if ! id "$worker_user" >/dev/null 2>&1; then
  useradd --system --create-home --home-dir "$worker_home" \
    --shell /usr/sbin/nologin "$worker_user"
fi
[[ "$(getent passwd "$worker_user" | cut -d: -f6)" == "$worker_home" ]] ||
  die "unexpected worker home"

if ! grep -q "^${worker_user}:" /etc/subuid; then
  awk -F: '($2 < 365536 && ($2 + $3) > 300000) { exit 1 }' /etc/subuid ||
    die "planned subordinate UID range overlaps an existing allocation"
  usermod --add-subuids 300000-365535 "$worker_user"
fi
if ! grep -q "^${worker_user}:" /etc/subgid; then
  awk -F: '($2 < 365536 && ($2 + $3) > 300000) { exit 1 }' /etc/subgid ||
    die "planned subordinate GID range overlaps an existing allocation"
  usermod --add-subgids 300000-365535 "$worker_user"
fi

install -d -m 0700 /Project/infrastructure
install -d -m 0755 "$runtime_root"
setfacl -m "u:${worker_user}:--x" /Project/infrastructure
getfacl -cp /Project/infrastructure | grep -Fqx "user:${worker_user}:--x" ||
  die "Cloud Worker cannot traverse the infrastructure root"
if [[ ! -e "$runtime_image" ]]; then
  truncate -s "${runtime_size_gb}G" "$runtime_image"
else
  expected_runtime_bytes="$((runtime_size_gb * 1024 * 1024 * 1024))"
  [[ "$(stat -c %s "$runtime_image")" -eq "$expected_runtime_bytes" ]] ||
    die "existing XFS image size does not match MUSE_CLOUD_XFS_SIZE_GB"
fi
runtime_fstype="$(blkid -s TYPE -o value "$runtime_image" 2>/dev/null || true)"
if [[ -z "$runtime_fstype" ]]; then
  mkfs.xfs -f -L tabtin-cloud "$runtime_image"
elif [[ "$runtime_fstype" != "xfs" ]]; then
  die "existing quota store has an unexpected filesystem"
fi
blkid "$runtime_image" | grep -q 'TYPE="xfs"' || die "quota store is not XFS"
if ! mountpoint -q "$runtime_root"; then
  mount -o loop,pquota "$runtime_image" "$runtime_root"
fi
findmnt -T "$runtime_root" -n -o FSTYPE | grep -qx xfs || die "quota store is not mounted as XFS"
findmnt -T "$runtime_root" -n -o OPTIONS | grep -Eq '(^|,)(pquota|prjquota)(,|$)' ||
  die "quota store is missing pquota/prjquota"
install -d -o "$worker_user" -g "$worker_user" -m 0700 \
  "$runtime_root/containers" \
  "$worker_home/.config" \
  "$worker_home/.config/containers" \
  "$worker_home/.config/systemd" \
  "$worker_home/.config/systemd/user"
cat > "$worker_home/.config/containers/storage.conf" <<EOF
[storage]
driver = "overlay"
graphroot = "$runtime_root/containers"

[storage.options.overlay]
mount_program = "/usr/bin/fuse-overlayfs"
EOF
chown "$worker_user:$worker_user" "$worker_home/.config/containers/storage.conf"
chmod 0600 "$worker_home/.config/containers/storage.conf"

worker_uid="$(id -u "$worker_user")"
loginctl enable-linger "$worker_user"
systemctl start "user@${worker_uid}.service"

run_worker() {
  runuser -u "$worker_user" -- env \
    HOME="$worker_home" \
    XDG_RUNTIME_DIR="/run/user/$worker_uid" \
    DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$worker_uid/bus" \
    "$@"
}

run_worker systemctl --user enable --now podman.socket
run_worker systemctl --user enable podman-restart.service
podman_socket="/run/user/$worker_uid/podman/podman.sock"
for _attempt in $(seq 1 30); do
  [[ -S "$podman_socket" ]] && break
  sleep 1
done
[[ -S "$podman_socket" ]] || die "rootless Podman socket did not start"

worker_docker() {
  run_worker env DOCKER_HOST="unix://$podman_socket" /usr/bin/docker "$@"
}

worker_docker info >/dev/null
runtime_info="$(worker_docker info --format '{{json .}}')"
grep -q '"CgroupVersion":"2"' <<<"$runtime_info" || die "rootless runtime is not cgroup v2"
grep -qi '"CgroupDriver":"systemd"' <<<"$runtime_info" || die "rootless runtime is not using systemd cgroups"
worker_docker network inspect tabtin-cloud-runtime >/dev/null 2>&1 ||
  worker_docker network create tabtin-cloud-runtime >/dev/null
install -d -o root -g root -m 0711 "$runtime_root/volumes"
install -d -o root -g root -m 0700 /var/lib/tabtin-cloud-volume-helper
install -d -m 0755 "$application_root/bin"
install -o root -g root -m 0755 "$volume_helper_source" \
  "$application_root/bin/tabtin-cloud-volume-helper.sh"
install -o root -g root -m 0644 "$volume_socket_source" \
  /etc/systemd/system/tabtin-cloud-volume-helper.socket
install -o root -g root -m 0644 "$volume_service_source" \
  /etc/systemd/system/tabtin-cloud-volume-helper@.service
systemctl daemon-reload
systemctl enable --now tabtin-cloud-volume-helper.socket
[[ "$(systemctl is-active tabtin-cloud-volume-helper.socket)" == "active" ]] ||
  die "Cloud volume helper socket did not start"

probe_volume="cloud-workspace-00000000-0000-4000-8000-000000000001"
volume_helper="$application_root/bin/tabtin-cloud-volume-helper.sh"
worker_docker volume rm "$probe_volume" >/dev/null 2>&1 || true
"$volume_helper" delete "$probe_volume" >/dev/null 2>&1 || true
cleanup_quota_probe() {
  worker_docker volume rm "$probe_volume" >/dev/null 2>&1 || true
  "$volume_helper" delete "$probe_volume" >/dev/null 2>&1 || true
}
trap cleanup_quota_probe EXIT
probe_path="$("$volume_helper" create "$probe_volume" 1)"
worker_docker volume create \
  --opt type=none \
  --opt "device=$probe_path" \
  --opt o=bind \
  "$probe_volume" >/dev/null
worker_docker volume inspect "$probe_volume" >/dev/null
cleanup_quota_probe
trap - EXIT
fstab_line="$runtime_image $runtime_root xfs loop,pquota,nofail 0 0"
grep -Fqx "$fstab_line" /etc/fstab || printf '%s\n' "$fstab_line" >> /etc/fstab

install -d -m 0755 /etc/tabtin /opt/tabtin-cloud-worker/releases
host_config_tmp="$(mktemp)"
trap 'rm -f "$host_config_tmp"' EXIT
{
  printf 'MUSE_CLOUD_WORKER_NODE_KEY=%s\n' "$worker_node_key"
  printf 'MUSE_CLOUD_WORKER_EDITION=%s\n' "$worker_edition"
  printf 'MUSE_CLOUD_CAPACITY_CPU_MILLICORES=%s\n' "$capacity_cpu_millicores"
  printf 'MUSE_CLOUD_CAPACITY_MEMORY_MB=%s\n' "$capacity_memory_mb"
  printf 'MUSE_CLOUD_CAPACITY_STORAGE_GB=%s\n' "$capacity_storage_gb"
  printf 'MUSE_CLOUD_RUNTIME_STORAGE_GB=%s\n' "$runtime_storage_gb"
  printf 'MUSE_CLOUD_XFS_SIZE_GB=%s\n' "$runtime_size_gb"
  printf 'MUSE_CLOUD_WORKER_BIND_ADDRESS=%s\n' "$worker_bind_address"
} > "$host_config_tmp"
install -o root -g root -m 0644 "$host_config_tmp" "$host_config_file"
rm -f "$host_config_tmp"
trap - EXIT
if [[ ! -f "$worker_token_file" ]]; then
  token_tmp="$(mktemp)"
  trap 'rm -f "$token_tmp"' EXIT
  openssl rand -hex 32 > "$token_tmp"
  install -o root -g root -m 0600 "$token_tmp" "$worker_token_file"
  rm -f "$token_tmp"
  trap - EXIT
fi
install -o root -g root -m 0644 "$systemd_unit_source" \
  /etc/systemd/system/tabtin-cloud-worker.service
getent group tabtin-deploy >/dev/null || die "tabtin-deploy group is missing"
install -o root -g tabtin-deploy -m 0750 "$deploy_gateway_source" \
  "$application_root/bin/tabtin-deploy-gateway.sh"
install -o root -g root -m 0700 "$cloud_release_source" \
  "$application_root/bin/tabtin-cloud-vps-release.sh"
sudoers_tmp="$(mktemp)"
trap 'rm -f "$sudoers_tmp"' EXIT
install -o root -g root -m 0440 "$sudoers_source" "$sudoers_tmp"
visudo -cf "$sudoers_tmp" >/dev/null || die "Cloud deploy sudoers template is invalid"
install -o root -g root -m 0440 "$sudoers_tmp" /etc/sudoers.d/tabtin-deploy
rm -f "$sudoers_tmp"
trap - EXIT
systemctl daemon-reload

nginx_backup="$(mktemp)"
cp --preserve=mode,ownership,timestamps "$nginx_config" "$nginx_backup"
python3 - "$nginx_config" "$worker_bind_address" <<'PY'
from pathlib import Path
import re
import sys

path = Path(sys.argv[1])
worker_bind_address = sys.argv[2]
text = path.read_text(encoding="utf-8")
marker = "# Muse Cloud Worker control plane"
fallback = re.compile(
    r"(?m)^(?P<indent>[ \t]+)location / \{\r?\n"
    r"(?P<inner>[ \t]+)proxy_pass http://tabtin_web_upstream;"
)
if marker not in text:
    matches = list(fallback.finditer(text))
    if len(matches) != 1:
        raise SystemExit("cannot locate the unique Muse web fallback location")
    match = matches[0]
    indent = match.group("indent")
    inner = match.group("inner")
    lines = [
        f"{indent}# Muse Cloud Worker control plane",
        f"{indent}location ^~ /_internal/cloud-worker/ {{",
        f"{inner}proxy_pass http://{worker_bind_address}:8090/;",
        f"{inner}proxy_http_version 1.1;",
        f"{inner}proxy_set_header Host              $host;",
        f"{inner}proxy_set_header X-Real-IP         $remote_addr;",
        f"{inner}proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;",
        f"{inner}proxy_set_header X-Forwarded-Proto $scheme;",
        f"{inner}proxy_connect_timeout 10s;",
        f"{inner}proxy_send_timeout    60s;",
        f"{inner}proxy_read_timeout    60s;",
        f"{inner}client_max_body_size 64k;",
        f"{indent}}}",
        "",
    ]
    block = "\n".join(lines) + "\n"
    text = text[:match.start()] + block + text[match.start():]
if text.count(marker) != 1:
    raise SystemExit("Cloud Worker nginx marker is not unique")
fallback_matches = list(fallback.finditer(text))
if len(fallback_matches) != 1:
    raise SystemExit("cannot locate the unique Muse web fallback location")
marker_start = text.index(marker)
fallback_start = fallback_matches[0].start()
if marker_start >= fallback_start:
    raise SystemExit("Cloud Worker route is not before the web fallback")
cloud_block = text[marker_start:fallback_start]
cloud_proxy = re.compile(
    r"(?m)^(?P<inner>[ \t]+)proxy_pass http://[^;\s]+:8090/;$"
)
proxy_matches = list(cloud_proxy.finditer(cloud_block))
if len(proxy_matches) != 1:
    raise SystemExit("Cloud Worker nginx proxy target is not unique")
proxy_match = proxy_matches[0]
expected_proxy = (
    f"{proxy_match.group('inner')}proxy_pass "
    f"http://{worker_bind_address}:8090/;"
)
cloud_block = (
    cloud_block[:proxy_match.start()]
    + expected_proxy
    + cloud_block[proxy_match.end():]
)
text = text[:marker_start] + cloud_block + text[fallback_start:]
path.write_text(text, encoding="utf-8")
PY
if ! docker exec nginx nginx -t; then
  cp --preserve=mode,ownership,timestamps "$nginx_backup" "$nginx_config"
  rm -f "$nginx_backup"
  docker exec nginx nginx -t || true
  die "Cloud Worker nginx route failed validation"
fi
docker exec nginx nginx -s reload
rm -f "$nginx_backup"

printf '[tabtin-cloud-bootstrap] rootless Podman, XFS quotas, token, systemd, and TLS route are ready\n'
