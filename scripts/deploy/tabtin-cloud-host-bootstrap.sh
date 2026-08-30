#!/usr/bin/env bash
set -euo pipefail

application_root="/Project/applications/tabtin"
worker_user="tabtin-cloud-worker"
worker_home="/var/lib/tabtin-cloud-worker"
runtime_root="/Project/infra/tabtin-cloud-runtime"
runtime_image="/Project/infra/tabtin-cloud-runtime.xfs"
runtime_size_gb="${TABTIN_CLOUD_XFS_SIZE_GB:-26}"
host_free_reserve_gb="${TABTIN_CLOUD_HOST_FREE_RESERVE_GB:-64}"
host_memory_reserve_mb="${TABTIN_CLOUD_HOST_MEMORY_RESERVE_MB:-8192}"
worker_node_key="${TABTIN_CLOUD_WORKER_NODE_KEY:-community-cloud-1}"
worker_edition="${TABTIN_CLOUD_WORKER_EDITION:-community}"
capacity_cpu_millicores="${TABTIN_CLOUD_CAPACITY_CPU_MILLICORES:-2000}"
capacity_memory_mb="${TABTIN_CLOUD_CAPACITY_MEMORY_MB:-4096}"
capacity_storage_gb="${TABTIN_CLOUD_CAPACITY_STORAGE_GB:-20}"
runtime_storage_gb="${TABTIN_CLOUD_RUNTIME_STORAGE_GB:-2}"
worker_token_file="/etc/tabtin/cloud-worker.token"
host_config_file="/etc/tabtin/cloud-host.env"
nginx_config="/Project/infrastructure/nginx/current/conf.d/50-tabtin.dovelora.com.conf"
systemd_unit_source="${1:-}"
deploy_gateway_source="${2:-}"
cloud_release_source="${3:-}"
sudoers_source="${4:-}"

die() {
  printf '[tabtin-cloud-bootstrap] ERROR: %s\n' "$*" >&2
  exit 1
}

[[ "${EUID}" -eq 0 ]] || die "run as root"
for source_file in \
  "$systemd_unit_source" \
  "$deploy_gateway_source" \
  "$cloud_release_source" \
  "$sudoers_source"; do
  [[ -f "$source_file" ]] ||
    die "pass systemd, gateway, Cloud release, and sudoers sources"
done
[[ -f "$nginx_config" ]] || die "missing TabTin nginx config"
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
required_free_gb="$((runtime_size_gb + host_free_reserve_gb))"
[[ "$available_gb" =~ ^[0-9]+$ && "$available_gb" -ge "$required_free_gb" ]] ||
  die "insufficient disk: require ${required_free_gb} GiB free before provisioning"

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends \
  ca-certificates fuse-overlayfs nodejs podman slirp4netns uidmap xfsprogs

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

install -d -m 0755 /Project/infra "$runtime_root"
if [[ ! -e "$runtime_image" ]]; then
  truncate -s "${runtime_size_gb}G" "$runtime_image"
  mkfs.xfs -f -L tabtin-cloud-runtime "$runtime_image"
else
  expected_runtime_bytes="$((runtime_size_gb * 1024 * 1024 * 1024))"
  [[ "$(stat -c %s "$runtime_image")" -eq "$expected_runtime_bytes" ]] ||
    die "existing XFS image size does not match TABTIN_CLOUD_XFS_SIZE_GB"
fi
blkid "$runtime_image" | grep -q 'TYPE="xfs"' || die "quota store is not XFS"
if ! mountpoint -q "$runtime_root"; then
  mount -o loop,pquota "$runtime_image" "$runtime_root"
fi
findmnt -T "$runtime_root" -n -o FSTYPE | grep -qx xfs || die "quota store is not mounted as XFS"
findmnt -T "$runtime_root" -n -o OPTIONS | grep -Eq '(^|,)(pquota|prjquota)(,|$)' ||
  die "quota store is missing pquota/prjquota"
install -d -o "$worker_user" -g "$worker_user" -m 0700 \
  "$runtime_root/containers" "$worker_home/.config/containers"
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

run_worker systemctl --user enable --now podman.socket podman-restart.service
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
probe_volume="tabtin-bootstrap-quota-probe"
worker_docker volume rm "$probe_volume" >/dev/null 2>&1 || true
worker_docker volume create --opt o=size=1M "$probe_volume" >/dev/null
worker_docker volume inspect "$probe_volume" >/dev/null
worker_docker volume rm "$probe_volume" >/dev/null
fstab_line="$runtime_image $runtime_root xfs loop,pquota,nofail 0 0"
grep -Fqx "$fstab_line" /etc/fstab || printf '%s\n' "$fstab_line" >> /etc/fstab

install -d -m 0755 /etc/tabtin /opt/tabtin-cloud-worker/releases
host_config_tmp="$(mktemp)"
trap 'rm -f "$host_config_tmp"' EXIT
{
  printf 'TABTIN_CLOUD_WORKER_NODE_KEY=%s\n' "$worker_node_key"
  printf 'TABTIN_CLOUD_WORKER_EDITION=%s\n' "$worker_edition"
  printf 'TABTIN_CLOUD_CAPACITY_CPU_MILLICORES=%s\n' "$capacity_cpu_millicores"
  printf 'TABTIN_CLOUD_CAPACITY_MEMORY_MB=%s\n' "$capacity_memory_mb"
  printf 'TABTIN_CLOUD_CAPACITY_STORAGE_GB=%s\n' "$capacity_storage_gb"
  printf 'TABTIN_CLOUD_RUNTIME_STORAGE_GB=%s\n' "$runtime_storage_gb"
  printf 'TABTIN_CLOUD_XFS_SIZE_GB=%s\n' "$runtime_size_gb"
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
python3 - "$nginx_config" <<'PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
text = path.read_text(encoding="utf-8")
marker = "# TabTin Cloud Worker control plane"
if marker not in text:
    needle = "    location / {\n        proxy_pass http://tabtin_web_upstream;"
    if text.count(needle) != 1:
        raise SystemExit("cannot locate the unique TabTin web fallback location")
    block = """    # TabTin Cloud Worker control plane
    location ^~ /_internal/cloud-worker/ {
        proxy_pass http://host.docker.internal:8090/;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_connect_timeout 10s;
        proxy_send_timeout    60s;
        proxy_read_timeout    60s;
        client_max_body_size 64k;
    }

"""
    path.write_text(text.replace(needle, block + needle), encoding="utf-8")
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
