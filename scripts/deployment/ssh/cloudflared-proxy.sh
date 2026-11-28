#!/usr/bin/env bash
set -euo pipefail

[[ $# == 1 && "$1" =~ ^[A-Za-z0-9.-]+$ && "$1" != -* ]] || {
  echo 'Cloudflare SSH requires one validated management hostname.' >&2
  exit 1
}
: "${TUNNEL_SERVICE_TOKEN_ID:?Missing the protected Cloudflare SSH service-token ID}"
: "${TUNNEL_SERVICE_TOKEN_SECRET:?Missing the protected Cloudflare SSH service-token secret}"

readonly cloudflared="${RUNNER_TEMP:?Missing GitHub Actions runner temporary directory}/cloudflared"
[[ -f $cloudflared && -x $cloudflared && ! -L $cloudflared ]] || {
  echo 'The checksum-pinned cloudflared client is unavailable.' >&2
  exit 1
}
# Keep personal browser tokens and optional listener/bastion modes outside
# the protected SSH transport process.
unset TUNNEL_SERVICE_URL TUNNEL_SERVICE_DESTINATION
profile=$(mktemp -d "$RUNNER_TEMP/codexia-cloudflared.XXXXXXXX")
pid=
cleanup() {
  if [[ -n "$pid" ]]; then
    kill "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
  fi
  rm -rf -- "$profile"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP
HOME="$profile" XDG_CONFIG_HOME="$profile" XDG_CACHE_HOME="$profile" PATH="$profile" \
  BROWSER=/usr/bin/false DISPLAY= WAYLAND_DISPLAY= \
  "$cloudflared" access ssh --hostname "$1" <&0 &
pid=$!
status=0
wait "$pid" || status=$?
pid=
exit "$status"
