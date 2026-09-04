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

gateway_token="${MUSE_DSH_GATEWAY_TOKEN:-$(node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('hex'))")}"
export MUSE_DSH_GATEWAY_TOKEN="$gateway_token"
export MUSE_DSH_API_URL="${MUSE_DSH_API_URL:-http://127.0.0.1:3080}"
export MUSE_DSH_GATEWAY_PORT="${MUSE_DSH_GATEWAY_PORT:-3090}"
export DEEPSEEK_API_KEY="$gateway_token"
export DEEPSEEK_BASE_URL="http://127.0.0.1:${MUSE_DSH_GATEWAY_PORT}/v1"
export DSH_HOME="${DSH_HOME:-/var/lib/tabtin/dsh}"
export DSH_TELEMETRY_MODE="DISABLED"
export DSH_PERMISSION_MODE="${DSH_PERMISSION_MODE:-workspace-write}"

exec tabtin-daemon start --config-dir "$config_dir"
