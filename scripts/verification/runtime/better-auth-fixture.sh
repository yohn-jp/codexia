#!/usr/bin/env bash
# Shared smoke fixture for packaged standalone images on a disposable network and PostgreSQL.
OCI_AUTH_WEB_CLIENT='codexia-oci-web'

# Exposes oci_owner_subject and oci_auth_runtime_args for the writer and preflight containers.
setup_oci_better_auth() {
  local engine=$1 image=$2 verification_network=$3 database_container=$4
  local secret_directory=$5 bootstrap_container=$6 oidc_container=$7
  local database_name=${8:-codexia_verify} user_namespace=${9:-}
  local user_args=()
  if [[ -n "$user_namespace" ]]; then user_args=("$user_namespace"); fi
  local api_origin='https://codexia-lifecycle-proxy:4443'
  local bootstrap_origin='https://codexia-auth-registration:8443'
  local ios_client='codexia-oci-ios' introspection_client='codexia-oci-introspection'
  local auth_database_password auth_secret introspection_secret attempt
  command -v openssl >/dev/null 2>&1 || {
    echo "OpenSSL is required for the isolated HTTPS authentication fixture." >&2
    return 2
  }
  auth_database_password="$(openssl rand -hex 24)"
  auth_secret="$(openssl rand -hex 24)"
  introspection_secret="$(openssl rand -hex 24)"
  mkdir "$secret_directory/oidc"
  cp "$(dirname "${BASH_SOURCE[0]}")/../../deployment/lifecycle/auth-oidc.mjs" "$secret_directory/oidc/fixture.mjs"
  openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj /CN=codexia-lifecycle-proxy \
    -addext 'subjectAltName=DNS:codexia-lifecycle-proxy,DNS:codexia-auth-registration' \
    -keyout "$secret_directory/oidc/tls.key" -out "$secret_directory/oidc/tls.crt" >/dev/null 2>&1
  # The outer directory stays private on the host. These mounts must be readable
  # by the non-root UIDs inside the disposable network's containers.
  chmod 0755 "$secret_directory/oidc"
  chmod 0444 "$secret_directory/oidc/"*
  cat > "$secret_directory/auth.env" <<ENV
CODEXIA_AUTH_MODE=better-auth
CODEXIA_AUTH_DATABASE_URL=postgres://codexia_auth_runtime:$auth_database_password@$database_container:5432/$database_name
CODEXIA_PUBLIC_ORIGIN=$api_origin
CODEXIA_TRUST_PROXY=1
CODEXIA_AUTH_SECRET=$auth_secret
CODEXIA_OIDC_ISSUER=$api_origin/idp
CODEXIA_OIDC_CLIENT_ID=codexia-fixture-client
CODEXIA_OIDC_CLIENT_SECRET=codexia-fixture-oidc-secret-32-characters
CODEXIA_OAUTH_INTROSPECTION_CLIENT_ID=$introspection_client
CODEXIA_OAUTH_INTROSPECTION_CLIENT_SECRET=$introspection_secret
CODEXIA_OAUTH_OWNER_CLIENT_IDS=$OCI_AUTH_WEB_CLIENT,$ios_client
ENV

  {
    printf "\\\\set auth_password '%s'\n" "$auth_database_password"
    cat <<'SQL'
CREATE ROLE codexia_auth_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD :'auth_password';
CREATE SCHEMA codexia_auth AUTHORIZATION codexia_auth_runtime;
REVOKE ALL ON SCHEMA codexia_auth FROM PUBLIC;
SQL
  } | "$engine" exec -i "$database_container" psql -X -q -v ON_ERROR_STOP=1 -U codexia -d "$database_name" >/dev/null

  "$engine" run --detach --name "$oidc_container" --network "$verification_network" --network-alias codexia-lifecycle-proxy \
    "${user_args[@]}" --no-healthcheck --read-only --cap-drop ALL --security-opt no-new-privileges \
    --volume "$secret_directory/oidc:/fixture:ro" --entrypoint node \
    "$image" /fixture/fixture.mjs serve >/dev/null
  "$engine" run --detach --name "$bootstrap_container" --network "$verification_network" --network-alias codexia-auth-registration \
    "${user_args[@]}" --no-healthcheck --read-only --cap-drop ALL --security-opt no-new-privileges \
    --volume "$secret_directory/oidc/tls.crt:/run/codexia-bootstrap/tls.crt:ro" \
    --volume "$secret_directory/oidc/tls.key:/run/codexia-bootstrap/tls.key:ro" \
    --env-file "$secret_directory/auth.env" --env NODE_EXTRA_CA_CERTS=/run/codexia-bootstrap/tls.crt \
    --env "CODEXIA_AUTH_BOOTSTRAP_ORIGIN=$bootstrap_origin" \
    --env CODEXIA_AUTH_BOOTSTRAP_OWNER_OIDC_SUBJECT=codexia-fixture-owner \
    --env "CODEXIA_AUTH_BOOTSTRAP_WEB_REDIRECT_URIS=$api_origin/desktop" \
    --entrypoint node "$image" /app/node_modules/@codexia/api/dist/bootstrap-auth.js --apply >/dev/null

  for attempt in $(seq 1 40); do
    if grep -Fq 'Better Auth bootstrap is ready.' <<<"$("$engine" logs "$bootstrap_container" 2>&1)"; then break; fi
    if [[ "$("$engine" inspect --format '{{.State.Running}}' "$bootstrap_container")" != true ]]; then break; fi
    sleep 0.5
  done
  if ! grep -Fq 'Better Auth bootstrap is ready.' <<<"$("$engine" logs "$bootstrap_container" 2>&1)"; then
    "$engine" logs "$bootstrap_container" >&2 || true
    echo 'The isolated Better Auth bootstrap did not become ready.' >&2
    return 1
  fi
  oci_owner_subject="$("$engine" exec "$oidc_container" node /fixture/fixture.mjs register | node --input-type=module -e '
    import assert from "node:assert/strict";
    import { readFileSync } from "node:fs";
    const registration = JSON.parse(readFileSync(0, "utf8"));
    assert.deepEqual([registration.webClientId, registration.iosClientId, registration.introspectionClientId], process.argv.slice(1));
    assert.match(registration.ownerSubject, /^[a-zA-Z0-9._@:/|+-]+$/u);
    console.log(registration.ownerSubject);
  ' "$OCI_AUTH_WEB_CLIENT" "$ios_client" "$introspection_client")"
  "$engine" stop "$bootstrap_container" >/dev/null

  local ca_path=/run/secrets/fixture-ca.crt
  oci_auth_runtime_args=(
    --volume "$secret_directory/oidc/tls.crt:$ca_path:ro"
    --env-file "$secret_directory/auth.env"
    --env "NODE_EXTRA_CA_CERTS=$ca_path"
    --env "CODEXIA_OAUTH_OWNER_SUBJECT=$oci_owner_subject"
  )
}
