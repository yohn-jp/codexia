#!/usr/bin/env bash
set -euo pipefail
umask 077

readonly version=2026.11.0
readonly digest=51f7c68b57ed7269164075d7e789efce5b59355982f06392deeb037d982a51fd
readonly runner_temp=${RUNNER_TEMP:?Missing GitHub Actions runner temporary directory}
readonly target="$runner_temp/cloudflared"
[[ -d $runner_temp && ! -L $runner_temp ]] || {
  echo 'RUNNER_TEMP must be an existing real directory.' >&2
  exit 1
}
partial=$(mktemp "$runner_temp/.cloudflared.XXXXXX")
trap 'rm -f -- "$partial"' EXIT

[[ ! -e $target && ! -L $target ]] || {
  echo 'A cloudflared client already exists in RUNNER_TEMP.' >&2
  exit 1
}
curl --proto '=https' --tlsv1.2 --fail --silent --show-error --location \
  "https://github.com/cloudflare/cloudflared/releases/download/$version/cloudflared-linux-amd64" \
  --output "$partial"
printf '%s  %s\n' "$digest" "$partial" | sha256sum --check --status
chmod 0700 "$partial"
client_version=$("$partial" version)
[[ $client_version == "cloudflared version $version"* ]] || {
  echo 'The downloaded cloudflared client reports an unexpected version.' >&2
  exit 1
}
mv -- "$partial" "$target"
trap - EXIT
