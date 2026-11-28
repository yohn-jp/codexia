#!/usr/bin/env bash

set -Eeuo pipefail

image_repository="${CODEXIA_IMAGE_REPOSITORY:-}"
reviewed_image() {
  [[ "$image_repository" =~ ^ghcr\.io/[a-z0-9-]+/codexia-backend$ &&
     "$1" == "$image_repository@"* && "${1#*@}" =~ ^sha256:[a-f0-9]{64}$ ]]
}
if [[ $# != 2 || "$1" != --apply ]] || ! reviewed_image "$2"; then
  echo 'Usage: codexia-grant-passkey-recovery --apply <reviewed immutable Full image>' >&2
  exit 2
fi
if [[ "$(id -un)" != codexia || "$(podman info --format '{{.Host.Security.Rootless}}')" != true ]]; then
  echo 'Recovery requires the rootless codexia service account' >&2
  exit 2
fi
if ! command -v jq >/dev/null 2>&1 || ! command -v logger >/dev/null 2>&1; then
  echo 'Recovery requires jq and logger to record a sanitized host audit event without the one-use grant' >&2
  exit 1
fi

auth_dir="$HOME/.config/codexia-auth"
state_dir="$HOME/.local/state/codexia-deploy"
unit="$HOME/.config/containers/systemd/codexia-api.container"
exec 9>"$state_dir/host.lock"
flock --exclusive --nonblock 9 || {
  echo 'Another Codexia operation holds the host lock' >&2
  exit 75
}
if [[ -e "$state_dir/deploy-transaction.json" || -L "$state_dir/deploy-transaction.json" ||
      ! -f "$unit" || -L "$unit" ]] ||
   ! grep -Fxq 'Environment=CODEXIA_AUTH_MODE=better-auth' "$unit" ||
   ! systemctl --user is-active --quiet codexia-api.service ||
   [[ "$(podman inspect --format '{{.State.Health.Status}}' codexia-api)" != healthy ]]; then
  echo 'Recovery requires a healthy Better Auth deployment with no pending transaction' >&2
  exit 1
fi
if [[ ! -f "$auth_dir/runtime.env" || -L "$auth_dir/runtime.env" || ! -O "$auth_dir/runtime.env" ||
      "$(stat -c %a "$auth_dir/runtime.env")" != 600 ]] ||
   ! grep -Eq '^CODEXIA_OAUTH_OWNER_SUBJECT=[a-zA-Z0-9._@:/|+-]+$' "$auth_dir/runtime.env" ||
   grep -q '^CODEXIA_AUTH_PASSKEY_BOOTSTRAP_OWNER_' "$auth_dir/runtime.env"; then
  echo 'Recovery requires private runtime settings for an existing configured owner' >&2
  exit 1
fi

oidc_secret=()
if grep -q '^CODEXIA_OIDC_ISSUER=' "$auth_dir/runtime.env"; then
  oidc_secret=(--secret=codexia-oidc-client-secret,type=env,target=CODEXIA_OIDC_CLIENT_SECRET)
fi
result="$(podman run --rm --pull=never --network codexia-data \
  --secret=codexia-auth-database-url,type=env,target=CODEXIA_AUTH_DATABASE_URL \
  --secret=codexia-auth-secret,type=env,target=CODEXIA_AUTH_SECRET \
  "${oidc_secret[@]}" \
  --secret=codexia-oauth-introspection-client-secret,type=env,target=CODEXIA_OAUTH_INTROSPECTION_CLIENT_SECRET \
  --env-file "$auth_dir/runtime.env" --entrypoint=node "$2" \
  /app/node_modules/@codexia/api/dist/grant-passkey-owner-recovery.js --apply)"
if ! audit_event="$(jq -ce '{event:"passkey-owner-recovery",ownerId:.ownerId,recordedAt:.recordedAt,sessionsRevoked:.sessionsRevoked,accessGrantsRevoked:.accessGrantsRevoked,refreshGrantsRevoked:.refreshGrantsRevoked,expiresInSeconds:.expiresInSeconds}' <<<"$result")"; then
  echo 'Recovery completed and is recorded in PostgreSQL, but its sanitized host event could not be formatted.' >&2
  printf '%s\n' "$result"
  unset result
  exit 1
fi
logger --tag codexia-passkey-recovery -- "$audit_event" || echo 'The recovery is durably recorded in PostgreSQL; the host journal write failed.' >&2
# The database and host audit event omit the grant; display it once for the operator to transfer.
printf '%s\n' "$result"
unset result audit_event
