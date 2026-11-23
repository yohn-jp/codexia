#!/usr/bin/env bash

set -Eeuo pipefail

if [[ $# != 2 || "$1" != --apply || ! "$2" =~ ^ghcr\.io/yohn-jp/codexia-backend@sha256:[a-f0-9]{64}$ ]]; then
  echo 'Usage: codexia-grant-passkey-owner --apply <reviewed immutable Full image>' >&2
  exit 2
fi
if [[ "$(id -un)" != codexia || "$(podman info --format '{{.Host.Security.Rootless}}')" != true ]]; then
  echo 'Grant issuance requires the rootless codexia service account' >&2
  exit 2
fi

auth_dir="$HOME/.config/codexia-auth"
state_dir="$HOME/.local/state/codexia-deploy"
unit="$HOME/.config/containers/systemd/codexia-api.container"
exec 9>"$state_dir/host.lock"
flock --exclusive --nonblock 9 || {
  echo 'Another Codexia operation holds the host lock' >&2
  exit 75
}
if [[ -e "$state_dir/deploy-transaction.json" || -L "$state_dir/deploy-transaction.json" ]]; then
  echo 'Grant issuance requires no pending deployment transaction' >&2
  exit 1
fi
if podman container exists codexia-api; then
  # An existing pre-cutover API must still match its exact retired unit contract.
  if [[ ! -f "$unit" || -L "$unit" || ! -O "$unit" ]] ||
     ! grep -Fxq 'Environment=CODEXIA_AUTH_TOKEN_FILE=/run/secrets/codexia-auth-token' "$unit" ||
     grep -Eq 'CODEXIA_AUTH_MODE=better-auth|codexia-auth-database-url' "$unit" ||
     ! systemctl --user is-active --quiet codexia-api.service ||
     [[ "$(podman inspect --format '{{.State.Health.Status}}' codexia-api)" != healthy ]]; then
    echo 'Grant issuance requires a healthy prior API or a fresh host' >&2
    exit 1
  fi
elif [[ $? != 1 || -e "$unit" || -L "$unit" ]] || systemctl --user is-active --quiet codexia-api.service; then
  echo 'Grant issuance refuses an unverified or stale API installation' >&2
  exit 1
fi
for file in runtime.env; do
  if [[ ! -f "$auth_dir/$file" || -L "$auth_dir/$file" || ! -O "$auth_dir/$file" ]] ||
     [[ "$(stat -c %a "$auth_dir/$file")" != 600 ]]; then
    echo 'Passkey bootstrap settings must be a private regular file owned by codexia' >&2
    exit 1
  fi
done
for setting in CODEXIA_AUTH_PASSKEY_BOOTSTRAP_OWNER_ID CODEXIA_AUTH_PASSKEY_BOOTSTRAP_OWNER_EMAIL CODEXIA_AUTH_PASSKEY_BOOTSTRAP_OWNER_NAME; do
  if ! grep -q "^${setting}=" "$auth_dir/runtime.env"; then
    echo 'Passkey owner bootstrap settings are missing from runtime.env' >&2
    exit 1
  fi
done

oidc_secret=()
if grep -q '^CODEXIA_OIDC_ISSUER=' "$auth_dir/runtime.env"; then
  oidc_secret=(--secret=codexia-oidc-client-secret,type=env,target=CODEXIA_OIDC_CLIENT_SECRET)
fi
# The one-time grant is emitted once on this operator terminal. It is never added to a URL or persisted by this launcher.
podman run --rm --pull=missing --network codexia-data \
  --secret=codexia-auth-database-url,type=env,target=CODEXIA_AUTH_DATABASE_URL \
  --secret=codexia-auth-secret,type=env,target=CODEXIA_AUTH_SECRET \
  "${oidc_secret[@]}" \
  --secret=codexia-oauth-introspection-client-secret,type=env,target=CODEXIA_OAUTH_INTROSPECTION_CLIENT_SECRET \
  --env-file "$auth_dir/runtime.env" --entrypoint=node "$2" \
  /app/node_modules/@codexia/api/dist/grant-passkey-owner.js --apply
