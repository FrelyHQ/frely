#!/bin/sh
# Container-required POSIX boundary: validate secrets, materialize one runtime
# config in tmpfs, and replace this process with the upstream binary.
set -eu
umask 077

readonly template=/etc/cliproxy/config.yaml
readonly runtime_dir=/run/cliproxy
readonly runtime_config="$runtime_dir/config.yaml"
readonly placeholder=__FRIDAY_RELAY_CLIPROXY_API_KEY__

fail() {
  printf 'CLIProxyAPI startup refused: %s\n' "$1" >&2
  exit 1
}

validate_secret() {
  secret_name=$1
  secret_value=$2
  [ "${#secret_value}" -ge 32 ] || fail "$secret_name must contain at least 32 characters"
  case "$secret_value" in
    *[!A-Za-z0-9._~+/=-]*) fail "$secret_name contains unsupported characters" ;;
  esac
}

[ -r "$template" ] || fail 'read-only config template is missing'
validate_secret CLIPROXY_API_KEY "${CLIPROXY_API_KEY:-}"
validate_secret CLIPROXY_MANAGEMENT_API_KEY "${MANAGEMENT_PASSWORD:-}"
[ "$CLIPROXY_API_KEY" != "$MANAGEMENT_PASSWORD" ] || fail 'inference and management keys must be different'

placeholder_count=$(grep -F -c -- "$placeholder" "$template" || true)
[ "$placeholder_count" -eq 1 ] || fail 'config template must contain exactly one inference-key placeholder'

mkdir -p -- "$runtime_dir"
sed "s|$placeholder|$CLIPROXY_API_KEY|" "$template" >"$runtime_config"
chmod 0600 "$runtime_config"

if [ "${1:-}" = "--check" ]; then
  printf '%s\n' 'CLIProxyAPI runtime config check passed'
  exit 0
fi

exec /CLIProxyAPI/CLIProxyAPI -config "$runtime_config"
