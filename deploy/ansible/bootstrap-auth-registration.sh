#!/usr/bin/env bash

set -Eeuo pipefail

image_repository="${CODEXIA_IMAGE_REPOSITORY:-}"
reviewed_image() {
  [[ "$image_repository" =~ ^ghcr\.io/[a-z0-9-]+/codexia-backend$ &&
     "$1" == "$image_repository@"* && "${1#*@}" =~ ^sha256:[a-f0-9]{64}$ ]]
}
if [[ $# != 2 || "$1" != --apply ]] || ! reviewed_image "$2"; then
  echo 'Usage: codexia-register-auth --apply <reviewed immutable Full image>' >&2
  exit 2
fi
if [[ "$(id -un)" != codexia || "$(podman info --format '{{.Host.Security.Rootless}}')" != true ]]; then
  echo 'Registration requires the rootless codexia service account' >&2
  exit 2
fi

auth_dir="$HOME/.config/codexia-auth"
state_dir="$HOME/.local/state/codexia-deploy"
exec 9>"$state_dir/host.lock"
flock --exclusive --nonblock 9 || {
  echo 'Another Codexia operation holds the host lock' >&2
  exit 75
}
"$HOME/.local/bin/codexia-require-clean-api-target"
for file in runtime.env bootstrap.env tls.crt tls.key; do
  if [[ ! -f "$auth_dir/$file" || -L "$auth_dir/$file" || ! -O "$auth_dir/$file" ]] ||
     [[ ! "$(stat -c %a "$auth_dir/$file")" =~ ^[46]00$ ]]; then
    echo 'Bootstrap inputs must be private regular files owned by codexia' >&2
    exit 1
  fi
done
runtime_oidc=false
if grep -q '^CODEXIA_OIDC_ISSUER=' "$auth_dir/runtime.env"; then runtime_oidc=true; fi
passkey_fields=$(grep -c '^CODEXIA_AUTH_PASSKEY_BOOTSTRAP_OWNER_' "$auth_dir/runtime.env" || true)
bootstrap_subject=false
if grep -q '^CODEXIA_AUTH_BOOTSTRAP_OWNER_OIDC_SUBJECT=' "$auth_dir/bootstrap.env"; then bootstrap_subject=true; fi
if grep -q '^CODEXIA_OAUTH_OWNER_SUBJECT=' "$auth_dir/runtime.env" ||
   ! awk '/^(#|$)/ {next} /^CODEXIA_AUTH_BOOTSTRAP_(ORIGIN|OWNER_OIDC_SUBJECT|WEB_REDIRECT_URIS)=[!-~]+$/ {split($0,a,"="); if (seen[a[1]]++) exit 1; next} {exit 1} END {if (!seen["CODEXIA_AUTH_BOOTSTRAP_ORIGIN"] || !seen["CODEXIA_AUTH_BOOTSTRAP_WEB_REDIRECT_URIS"]) exit 1}' "$auth_dir/bootstrap.env" ||
   ! { [[ "$runtime_oidc" == true && "$bootstrap_subject" == true && "$passkey_fields" == 0 ]] ||
     [[ "$runtime_oidc" == false && "$bootstrap_subject" == false && "$passkey_fields" == 3 ]]; }; then
  echo 'Registration requires pending runtime settings and approved bootstrap inputs' >&2
  exit 1
fi

# Publish only on host loopback for the operator SSH forward. Keep it off the Tunnel.
oidc_secret=()
if [[ "$runtime_oidc" == true ]]; then
  oidc_secret=(--secret=codexia-oidc-client-secret,type=env,target=CODEXIA_OIDC_CLIENT_SECRET)
fi
podman run --rm --pull=missing --timeout=900 \
  --name codexia-auth-registration --userns=keep-id:uid=1000,gid=1000 --user 1000:1000 \
  --network codexia --network codexia-data --publish 127.0.0.1:8443:8443 \
  --read-only --cap-drop=all --security-opt=no-new-privileges \
  --volume "$auth_dir/tls.crt:/run/codexia-bootstrap/tls.crt:ro" \
  --volume "$auth_dir/tls.key:/run/codexia-bootstrap/tls.key:ro" \
  --env-file "$auth_dir/runtime.env" --env-file "$auth_dir/bootstrap.env" \
  --secret=codexia-auth-database-url,type=env,target=CODEXIA_AUTH_DATABASE_URL \
  --secret=codexia-auth-secret,type=env,target=CODEXIA_AUTH_SECRET \
  "${oidc_secret[@]}" \
  --secret=codexia-oauth-introspection-client-secret,type=env,target=CODEXIA_OAUTH_INTROSPECTION_CLIENT_SECRET \
  --entrypoint=node "$2" /app/node_modules/@codexia/api/dist/bootstrap-auth.js --apply
