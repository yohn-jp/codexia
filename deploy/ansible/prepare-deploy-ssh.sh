#!/usr/bin/env bash
# Prepare the pinned service account connection used by the production runner.
set -euo pipefail
umask 077
user=codexia
if [[ $# == 1 && "$1" == --preflight-admin ]]; then
  [[ "${GITHUB_ACTIONS:-}" == true &&
     "${GITHUB_REPOSITORY:-}" =~ ^[A-Za-z0-9-]+/codexia$ &&
     "${GITHUB_REPOSITORY_ID:-}" =~ ^[1-9][0-9]*$ &&
     "${GITHUB_REPOSITORY_OWNER_ID:-}" =~ ^[1-9][0-9]*$ && "${GITHUB_REF:-}" == refs/heads/main && "${GITHUB_EVENT_NAME:-}" == workflow_dispatch && "${GITHUB_WORKFLOW:-}" == 'Production Access Preflight' ]] || exit 1
  user=${CODEXIA_PREFLIGHT_SSH_USER:?Missing independently approved administrator user}
  [[ "$user" =~ ^[a-z_][a-z0-9_-]{0,31}$ && "$user" != root && "$user" != codexia ]] || exit 1
elif [[ $# != 0 ]]; then
  exit 1
fi
directory="${RUNNER_TEMP:?}/codexia-ssh"
mkdir -m 0700 "$directory"
key="$directory/id_ed25519"
pins="$directory/known_hosts"
printf '%s\n' "${CODEXIA_DEPLOY_SSH_KNOWN_HOSTS:?Missing pinned SSH host key}" > "$pins"
host=${CODEXIA_DEPLOY_HOST:-}
if [[ -z $host ]]; then
  # A single plain host in the protected pin file also declares the target.
  host=$(awk 'NF && $1 !~ /^#/ { print $1 }' "$pins" | sort -u)
fi
if ! python3 - "$host" <<'PY'
import ipaddress
import re
import sys

host = sys.argv[1]
try:
    ipaddress.ip_address(host)
    valid = "%" not in host
except ValueError:
    valid = len(host) <= 253 and all(
        re.fullmatch(r"[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?", label)
        for label in host.split(".")
    )
sys.exit(0 if valid else 1)
PY
then
  echo 'Set CODEXIA_DEPLOY_HOST to a single tailnet address or hostname covered by the protected SSH pin.' >&2
  exit 1
fi
ssh-keygen -F "$host" -f "$pins" >/dev/null || { echo 'No SSH pin matches the declared VM.' >&2; exit 1; }
printf '%s\n' "${CODEXIA_DEPLOY_SSH_PRIVATE_KEY:?Missing deployment SSH identity}" > "$key"
ssh-keygen -y -P '' -f "$key" >/dev/null
cat > "$directory/config" <<CONFIG
Host codexia-target
    HostName $host
    User $user
    IdentityFile "$key"
    IdentitiesOnly yes
    BatchMode yes
    ConnectTimeout 10
    StrictHostKeyChecking yes
    UserKnownHostsFile "$pins"
    GlobalKnownHostsFile /dev/null
CONFIG
printf 'host=%s\n' "$host" >> "${GITHUB_OUTPUT:?}"
if [[ "$user" != codexia ]]; then printf 'user=%s\n' "$user" >> "$GITHUB_OUTPUT"; fi
