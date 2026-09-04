#!/usr/bin/env bash
set -euo pipefail

repo_root="${1:?repository root is required}"
env_file="${repo_root}/.env"
template_file="${repo_root}/.env.example"

if [[ -e "${env_file}" ]]; then
  [[ -f "${env_file}" ]] || {
    printf 'ERROR: %s exists but is not a regular file.\n' "${env_file}" >&2
    exit 1
  }
elif [[ ! -f "${template_file}" ]]; then
  printf 'ERROR: Missing environment template: %s\n' "${template_file}" >&2
  exit 1
else
  umask 077
  cp "${template_file}" "${env_file}"
  printf 'Created %s from .env.example.\n' "${env_file}"
fi

for key in MUSE_EDITION AUTH_FIXED_VERIFICATION_CODE; do
  if grep -Eq "^[[:space:]]*(export[[:space:]]+)?${key}[[:space:]]*=" "${env_file}"; then
    continue
  fi
  if [[ "${key}" == "AUTH_FIXED_VERIFICATION_CODE" ]]; then
    value_line="AUTH_FIXED_VERIFICATION_CODE="
  else
    value_line="$(grep -E "^${key}=" "${template_file}" | head -n 1)"
  fi
  [[ -n "${value_line}" ]] || {
    printf 'ERROR: Missing %s in %s.\n' "${key}" "${template_file}" >&2
    exit 1
  }
  printf '\n%s\n' "${value_line}" >> "${env_file}"
  printf 'Added missing %s setting to %s (disabled until explicitly configured).\n' "${key}" "${env_file}"
done

read_root_switch() {
  local wanted="$1"
  awk -v wanted="${wanted}" '
    {
      line = $0
      sub(/\r$/, "", line)
      equals = index(line, "=")
      if (!equals) next
      key = substr(line, 1, equals - 1)
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", key)
      sub(/^export[[:space:]]+/, "", key)
      if (key != wanted) next
      value = substr(line, equals + 1)
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", value)
      if (length(value) >= 2) {
        first = substr(value, 1, 1)
        last = substr(value, length(value), 1)
        if ((first == "\"" && last == "\"") || (first == "\047" && last == "\047")) {
          value = substr(value, 2, length(value) - 2)
        }
      }
      result = value
      found = 1
    }
    END { if (found) print result }
  ' "${env_file}"
}

edition="$(read_root_switch MUSE_EDITION | tr '[:upper:]' '[:lower:]')"
fixed_code="$(read_root_switch AUTH_FIXED_VERIFICATION_CODE)"
case "${edition}" in
  community|saas) ;;
  *)
    printf 'ERROR: MUSE_EDITION in %s must be community or saas.\n' "${env_file}" >&2
    exit 1
    ;;
esac
if [[ -n "${fixed_code}" && ! "${fixed_code}" =~ ^[0-9]{6}$ ]]; then
  printf 'ERROR: AUTH_FIXED_VERIFICATION_CODE in %s must be empty or exactly 6 digits.\n' "${env_file}" >&2
  exit 1
fi

runtime_env_file="${repo_root}/.env.community-runtime"
runtime_env_temporary="${runtime_env_file}.$$"
trap 'rm -f "${runtime_env_temporary}"' EXIT
umask 077
printf 'MUSE_EDITION=%s\nAUTH_FIXED_VERIFICATION_CODE=%s\n' \
  "${edition}" "${fixed_code}" > "${runtime_env_temporary}"
chmod 600 "${runtime_env_temporary}"
mv -f "${runtime_env_temporary}" "${runtime_env_file}"
trap - EXIT
printf 'Prepared isolated Community runtime switches from %s.\n' "${env_file}"
