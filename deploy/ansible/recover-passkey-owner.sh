#!/usr/bin/env bash

set -Eeuo pipefail

image_repository="${CODEXIA_IMAGE_REPOSITORY:-}"
reviewed_image() {
  [[ "$image_repository" =~ ^ghcr\.io/[a-z0-9-]+/codexia-backend$ &&
     "$1" == "$image_repository@"* && "${1#*@}" =~ ^sha256:[a-f0-9]{64}$ ]]
}
if [[ $# != 2 || "$1" != --apply ]] || ! reviewed_image "$2"; then
  echo 'Usage: codexia-recover-passkey --apply <reviewed immutable Full image>' >&2
  exit 2
fi
if [[ "$(id -un)" != codexia || "$(podman info --format '{{.Host.Security.Rootless}}')" != true ]]; then
  echo 'Recovery requires the rootless codexia service account' >&2
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
if [[ -e "$state_dir/deploy-transaction.json" || -L "$state_dir/deploy-transaction.json" ||
      ! -f "$unit" || -L "$unit" ]] ||
   ! grep -Fxq 'Environment=CODEXIA_AUTH_MODE=better-auth' "$unit" ||
   ! systemctl --user is-active --quiet codexia-api.service ||
   [[ "$(podman inspect --format '{{.State.Health.Status}}' codexia-api)" != healthy ]]; then
  echo 'Recovery requires a healthy Better Auth deployment with no pending transaction' >&2
  exit 1
fi
for file in runtime.env bootstrap.env tls.crt tls.key; do
  if [[ ! -f "$auth_dir/$file" || -L "$auth_dir/$file" || ! -O "$auth_dir/$file" ]] ||
     [[ "$(stat -c %a "$auth_dir/$file")" != 600 ]]; then
    echo 'Recovery inputs must be private regular files owned by codexia' >&2
    exit 1
  fi
done
if ! grep -Eq '^CODEXIA_OAUTH_OWNER_SUBJECT=[a-zA-Z0-9._@:/|+-]+$' "$auth_dir/runtime.env" ||
   grep -q '^CODEXIA_AUTH_PASSKEY_BOOTSTRAP_OWNER_' "$auth_dir/runtime.env" ||
   ! awk '/^(#|$)/ {next} /^CODEXIA_AUTH_BOOTSTRAP_(ORIGIN)=[!-~]+$/ {split($0,a,"="); if (seen[a[1]]++) exit 1; next} {exit 1} END {if (!seen["CODEXIA_AUTH_BOOTSTRAP_ORIGIN"]) exit 1}' "$auth_dir/bootstrap.env"; then
  echo 'Recovery requires an existing configured owner and the isolated bootstrap origin' >&2
  exit 1
fi

oidc_secret=()
if grep -q '^CODEXIA_OIDC_ISSUER=' "$auth_dir/runtime.env"; then
  oidc_secret=(--secret=codexia-oidc-client-secret,type=env,target=CODEXIA_OIDC_CLIENT_SECRET)
fi
# Publish only on host loopback for the operator SSH forward; never route this listener through the application Tunnel.
podman run --rm --pull=never --timeout=900 \
  --name codexia-auth-recovery --userns=keep-id:uid=1000,gid=1000 --user 1000:1000 \
  --network codexia-data --publish 127.0.0.1:8443:8443 \
  --read-only --cap-drop=all --security-opt=no-new-privileges \
  --volume "$auth_dir/tls.crt:/run/codexia-bootstrap/tls.crt:ro" \
  --volume "$auth_dir/tls.key:/run/codexia-bootstrap/tls.key:ro" \
  --env-file "$auth_dir/runtime.env" --env-file "$auth_dir/bootstrap.env" \
  --secret=codexia-auth-database-url,type=env,target=CODEXIA_AUTH_DATABASE_URL \
  --secret=codexia-auth-secret,type=env,target=CODEXIA_AUTH_SECRET \
  "${oidc_secret[@]}" \
  --secret=codexia-oauth-introspection-client-secret,type=env,target=CODEXIA_OAUTH_INTROSPECTION_CLIENT_SECRET \
  --entrypoint=node "$2" /app/node_modules/@codexia/api/dist/bootstrap-auth.js --recover --apply
