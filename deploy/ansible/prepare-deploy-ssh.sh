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
host=${CODEXIA_DEPLOY_HOST:?Missing protected management hostname}
if ! python3 - "$host" "${CODEXIA_MANAGEMENT_HOSTNAME:?Missing reviewed management hostname}" <<'PY'
import re
import sys

host, management_hostname = sys.argv[1:]
def valid_hostname(value):
    return len(value) <= 253 and "." in value and all(
        re.fullmatch(r"[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?", label)
        for label in value.split(".")
    )
sys.exit(0 if valid_hostname(host) and host == management_hostname else 1)
PY
then
  echo 'Set CODEXIA_DEPLOY_HOST to the protected management hostname covered by the pinned SSH host key.' >&2
  exit 1
fi
python3 - "$host" "${GITHUB_REPOSITORY:?Missing GitHub repository identity}" "${GITHUB_REPOSITORY_ID:?Missing GitHub repository ID}" "${GITHUB_REPOSITORY_OWNER_ID:?Missing GitHub owner ID}" "${CODEXIA_DEPLOYMENT_CLOUDFLARE_TARGET:?Missing verified Cloudflare target}" <<'PY'
import json
import sys

host, repository, repository_id, owner_id, raw_target = sys.argv[1:]
try:
    target = json.loads(raw_target)
    valid = (
        target["repository"] == repository
        and str(target["repositoryId"]) == repository_id
        and str(target["ownerId"]) == owner_id
        and target["sshHostname"] == host
        and isinstance(target["sshHostname"], str)
        and isinstance(target["sshPolicyId"], str)
        and bool(target["sshPolicyId"])
    )
except (KeyError, TypeError, ValueError):
    valid = False
if not valid:
    raise SystemExit("The management host does not match the protected repository Cloudflare target.")
PY
ssh-keygen -F "$host" -f "$pins" >/dev/null || { echo 'No SSH pin matches the declared VM.' >&2; exit 1; }
printf '%s\n' "${CODEXIA_DEPLOY_SSH_PRIVATE_KEY:?Missing deployment SSH identity}" > "$key"
ssh-keygen -y -P '' -f "$key" >/dev/null
cloudflared="$RUNNER_TEMP/cloudflared"
[[ -x "$cloudflared" ]] || { echo 'The pinned cloudflared client is missing.' >&2; exit 1; }
repository_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
proxy="$repository_root/scripts/deployment/ssh/cloudflared-proxy.sh"
[[ -x "$proxy" && ! -L "$proxy" ]] || { echo 'The reviewed Cloudflare SSH launcher is missing.' >&2; exit 1; }
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
printf '    ProxyCommand "%s" %%h\n' "$proxy" >> "$directory/config"
printf 'host=%s\n' "$host" >> "${GITHUB_OUTPUT:?}"
if [[ "$user" != codexia ]]; then printf 'user=%s\n' "$user" >> "$GITHUB_OUTPUT"; fi
