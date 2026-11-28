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
export BROWSER=/usr/bin/false
exec "$cloudflared" access ssh --hostname "$1"
