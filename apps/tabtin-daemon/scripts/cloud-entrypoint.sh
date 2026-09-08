#!/bin/sh
set -eu

config_dir="${MUSE_DAEMON_CONFIG_DIR:-/var/lib/tabtin/daemon}"
token_file="${MUSE_DAEMON_BOOTSTRAP_TOKEN_FILE:-/var/lib/tabtin/bootstrap/install-token}"

if [ ! -f "$config_dir/config.json" ]; then
  if [ ! -s "$token_file" ]; then
    echo "Cloud daemon bootstrap token is missing" >&2
    exit 1
  fi
  init_attempt=1
  until tabtin-daemon init --token-stdin --config-dir "$config_dir" < "$token_file"; do
    if [ "$init_attempt" -ge 8 ]; then
      echo "Cloud daemon bootstrap failed after $init_attempt attempts" >&2
      exit 1
    fi
    echo "Cloud daemon bootstrap retrying in 60 seconds" >&2
    sleep 60
    init_attempt=$((init_attempt + 1))
  done
fi

rm -f "$token_file"

# DSH gateways, credentials and permissions are owned by each managed session.
export DSH_HOME="${DSH_HOME:-/var/lib/tabtin/dsh}"
export DSH_TELEMETRY_MODE="DISABLED"

exec tabtin-daemon start --config-dir "$config_dir"
