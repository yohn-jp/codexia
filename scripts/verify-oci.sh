#!/usr/bin/env bash
set -euo pipefail

if [[ -n "${OCI_ENGINE:-}" ]]; then
  engine="$OCI_ENGINE"
elif command -v podman >/dev/null 2>&1; then
  engine=podman
elif command -v docker >/dev/null 2>&1; then
  engine=docker
else
  echo "Install Docker or Podman, or set OCI_ENGINE to an installed engine." >&2
  exit 2
fi

command -v "$engine" >/dev/null 2>&1 || {
  echo "OCI engine is not available: $engine" >&2
  exit 2
}
command -v curl >/dev/null 2>&1 || {
  echo "curl is required for the HTTP startup check." >&2
  exit 2
}
command -v od >/dev/null 2>&1 || {
  echo "od is required to generate disposable database and authentication secrets." >&2
  exit 2
}
command -v openssl >/dev/null 2>&1 || {
  echo "OpenSSL is required for the isolated HTTPS authentication fixture." >&2
  exit 2
}

# OCI verification runs on fresh runners without a workspace install.
# Bootstrap only the locked root parser dependency when it is not already present.
if ! node --input-type=module -e "await import('parse5')" >/dev/null 2>&1; then
  command -v corepack >/dev/null 2>&1 || {
    echo 'Corepack is needed to install the pinned verification parser; run pnpm install --frozen-lockfile.' >&2
    exit 2
  }
  corepack pnpm@12.21.0 install --filter . --frozen-lockfile --ignore-scripts
fi

image="${CODEXIA_OCI_IMAGE:-codexia:verification}"
port="${CODEXIA_OCI_PORT:-3040}"
profile="${CODEXIA_PROFILE:-core}"
container="codexia-verify-$$"
database_container="codexia-verify-db-$$"
bootstrap_container="codexia-verify-auth-bootstrap-$$"
oidc_container="codexia-verify-auth-oidc-$$"
verification_network="codexia-verify-net-$$"
api_origin='https://codexia-lifecycle-proxy:4443'
bootstrap_origin='https://codexia-auth-registration:8443'
web_client='codexia-oci-web'
ios_client='codexia-oci-ios'
introspection_client='codexia-oci-introspection'

random_secret() { od -An -N24 -tx1 /dev/urandom | tr -d ' \n'; }
database_password="$(random_secret)"
auth_database_password="$(random_secret)"

case "$profile" in
  core|full) ;;
  *) echo "CODEXIA_PROFILE must be core or full." >&2; exit 2 ;;
esac

secret_directory=""
cleanup() {
  "$engine" rm --volumes --force "$container" "$bootstrap_container" "$oidc_container" "$database_container" >/dev/null 2>&1 || true
  "$engine" network rm "$verification_network" >/dev/null 2>&1 || true
  if [[ -n "$secret_directory" ]]; then rm -rf "$secret_directory"; fi
}
trap cleanup EXIT INT TERM
# Preserve the failing command location without logging secret-bearing arguments.
trap 'status=$?; printf "OCI verification failed at line %s (exit %s)\\n" "$LINENO" "$status" >&2; "$engine" ps --all --filter "name=$database_container" --filter "name=$container" --filter "name=$oidc_container" --filter "name=$bootstrap_container" >&2 || true' ERR

secret_directory="$(mktemp -d "${TMPDIR:-/tmp}/codexia-oci-secrets.XXXXXX")"
umask 077
printf '%s' "$database_password" > "$secret_directory/postgres-password"
mkdir "$secret_directory/oidc"
cp "$(dirname "$0")/push-auth-lifecycle-oidc.mjs" "$secret_directory/oidc/fixture.mjs"
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj /CN=codexia-lifecycle-proxy \
  -addext 'subjectAltName=DNS:codexia-lifecycle-proxy,DNS:codexia-auth-registration' \
  -keyout "$secret_directory/oidc/tls.key" -out "$secret_directory/oidc/tls.crt" >/dev/null 2>&1
# The outer directory stays private on the host. These mounts must be readable
# by the non-root UIDs inside the disposable network's containers.
chmod 0755 "$secret_directory/oidc"
chmod 0444 "$secret_directory/postgres-password" "$secret_directory/oidc/"*
cat > "$secret_directory/auth.env" <<ENV
CODEXIA_AUTH_MODE=better-auth
CODEXIA_AUTH_DATABASE_URL=postgres://codexia_auth_runtime:$auth_database_password@$database_container:5432/codexia_verify
CODEXIA_PUBLIC_ORIGIN=$api_origin
CODEXIA_TRUST_PROXY=1
CODEXIA_AUTH_SECRET=$(random_secret)
CODEXIA_OIDC_ISSUER=$api_origin/idp
CODEXIA_OIDC_CLIENT_ID=codexia-fixture-client
CODEXIA_OIDC_CLIENT_SECRET=codexia-fixture-oidc-secret-32-characters
CODEXIA_OAUTH_INTROSPECTION_CLIENT_ID=$introspection_client
CODEXIA_OAUTH_INTROSPECTION_CLIENT_SECRET=$(random_secret)
CODEXIA_OAUTH_OWNER_CLIENT_IDS=$web_client,$ios_client
ENV

if [[ "${engine##*/}" == podman ]]; then
  "$engine" build --format oci --pull --build-arg "PROFILE=$profile" --tag "$image" .
else
  "$engine" build --pull --build-arg "PROFILE=$profile" --tag "$image" .
fi
"$engine" network create "$verification_network" >/dev/null
"$engine" run --detach --name "$database_container" --network "$verification_network" \
  --env POSTGRES_USER=codexia --env POSTGRES_DB=codexia_verify --env POSTGRES_PASSWORD_FILE=/run/secrets/postgres-password \
  --volume "$secret_directory/postgres-password:/run/secrets/postgres-password:ro" \
  docker.io/library/postgres:17-bookworm@sha256:40865bc877a289da75963d97d72b59633f639fc5af7a4e856bfa3714cae5b536
for attempt in $(seq 1 40); do
  # Postgres initialization briefly starts a Unix-socket-only temporary server.
  # Require TCP readiness so this probe cannot pass before the final server starts.
  if "$engine" exec "$database_container" pg_isready -h 127.0.0.1 -U codexia -d codexia_verify >/dev/null 2>&1; then break; fi
  sleep 0.5
done
"$engine" exec "$database_container" pg_isready -h 127.0.0.1 -U codexia -d codexia_verify >/dev/null
{
  printf "\\\\set auth_password '%s'\n" "$auth_database_password"
  cat <<'SQL'
CREATE ROLE codexia_auth_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD :'auth_password';
CREATE SCHEMA codexia_auth AUTHORIZATION codexia_auth_runtime;
REVOKE ALL ON SCHEMA codexia_auth FROM PUBLIC;
SQL
} | "$engine" exec -i "$database_container" psql -X -q -v ON_ERROR_STOP=1 -U codexia -d codexia_verify >/dev/null

"$engine" run --detach --name "$oidc_container" --network "$verification_network" --network-alias codexia-lifecycle-proxy \
  --no-healthcheck --read-only --cap-drop ALL --security-opt no-new-privileges \
  --volume "$secret_directory/oidc:/fixture:ro" --entrypoint node \
  "$image" /fixture/fixture.mjs serve >/dev/null
"$engine" run --detach --name "$bootstrap_container" --network "$verification_network" --network-alias codexia-auth-registration \
  --no-healthcheck --read-only --cap-drop ALL --security-opt no-new-privileges \
  --volume "$secret_directory/oidc/tls.crt:/run/codexia-bootstrap/tls.crt:ro" \
  --volume "$secret_directory/oidc/tls.key:/run/codexia-bootstrap/tls.key:ro" \
  --env-file "$secret_directory/auth.env" --env NODE_EXTRA_CA_CERTS=/run/codexia-bootstrap/tls.crt \
  --env "CODEXIA_AUTH_BOOTSTRAP_ORIGIN=$bootstrap_origin" \
  --env CODEXIA_AUTH_BOOTSTRAP_OWNER_OIDC_SUBJECT=codexia-fixture-owner \
  --env "CODEXIA_AUTH_BOOTSTRAP_WEB_REDIRECT_URIS=$api_origin/desktop,$api_origin/mobile" \
  --entrypoint node "$image" /app/node_modules/@codexia/api/dist/bootstrap-auth.js --apply >/dev/null

for attempt in $(seq 1 40); do
  if grep -Fq 'Better Auth bootstrap is ready.' <<<"$("$engine" logs "$bootstrap_container" 2>&1)"; then break; fi
  if [[ "$("$engine" inspect --format '{{.State.Running}}' "$bootstrap_container")" != true ]]; then break; fi
  sleep 0.5
done
if ! grep -Fq 'Better Auth bootstrap is ready.' <<<"$("$engine" logs "$bootstrap_container" 2>&1)"; then
  "$engine" logs "$bootstrap_container" >&2 || true
  echo 'The isolated Better Auth bootstrap did not become ready.' >&2
  exit 1
fi
owner_subject="$("$engine" exec "$oidc_container" node /fixture/fixture.mjs register | node --input-type=module -e '
  import assert from "node:assert/strict";
  import { readFileSync } from "node:fs";
  const registration = JSON.parse(readFileSync(0, "utf8"));
  assert.deepEqual([registration.webClientId, registration.iosClientId, registration.introspectionClientId], process.argv.slice(1));
  assert.match(registration.ownerSubject, /^[a-zA-Z0-9._@:/|+-]+$/u);
  console.log(registration.ownerSubject);
' "$web_client" "$ios_client" "$introspection_client")"
"$engine" stop "$bootstrap_container" >/dev/null

"$engine" run --detach \
  --name "$container" \
  --network "$verification_network" --network-alias codexia-api \
  --stop-timeout 30 \
  --publish "127.0.0.1:${port}:3000" \
  --volume "$secret_directory/postgres-password:/run/secrets/app-password:ro" \
  --volume "$secret_directory/oidc/tls.crt:/run/secrets/fixture-ca.crt:ro" \
  --env-file "$secret_directory/auth.env" --env NODE_EXTRA_CA_CERTS=/run/secrets/fixture-ca.crt \
  --env "CODEXIA_OAUTH_OWNER_SUBJECT=$owner_subject" \
  --env CODEXIA_DATA_DIR=/data \
  --env CODEXIA_DATABASE_PASSWORD_FILE=/run/secrets/app-password \
  --env CODEXIA_DATABASE_USER=codexia \
  --env CODEXIA_DATABASE_NAME=codexia_verify \
  --env "CODEXIA_DATABASE_HOST=$database_container" \
  --env CODEXIA_DATABASE_MIGRATE_ON_START=1 \
  "$image" >/dev/null

ready=0
for attempt in $(seq 1 40); do
  if curl --fail --silent "http://127.0.0.1:${port}/health/ready" >/dev/null; then
    ready=1
    break
  fi
  sleep 0.5
done
if [[ "$ready" != 1 ]]; then
  "$engine" logs "$container" >&2 || true
  echo "The OCI image did not become ready against PostgreSQL at /health/ready." >&2
  exit 1
fi

node scripts/verify-oci-http.mjs "http://127.0.0.1:${port}" "$profile"
session_status="$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' "http://127.0.0.1:${port}/api/session")"
[[ "$session_status" == 401 ]] || { echo "Unauthenticated API session returned HTTP $session_status." >&2; exit 1; }
"$engine" exec "$oidc_container" node /fixture/fixture.mjs authorize "$web_client" "$owner_subject" >/dev/null
uid="$("$engine" exec "$container" node -p 'process.getuid()')"
[[ "$uid" == 1000 ]] || {
  echo "Expected the application to run as UID 1000; got $uid." >&2
  exit 1
}
"$engine" exec "$container" node -e "require('node:fs').writeFileSync('/data/.oci-smoke', 'ok'); require('node:fs').unlinkSync('/data/.oci-smoke')"

echo "OCI startup checks passed: production ${profile} profile, Better Auth owner session, HTTP probes, nonroot UID, and writable /data."
if [[ "${engine##*/}" == podman ]]; then
  "$engine" image inspect --format 'Image ID: {{.Id}}; manifest digest: {{.Digest}} ({{.Os}}/{{.Architecture}})' "$image"
else
  "$engine" image inspect --format 'Image ID: {{.Id}} ({{.Os}}/{{.Architecture}}); repo digests: {{json .RepoDigests}}' "$image"
fi

"$engine" stats --no-stream --format 'Startup cgroup measurement: memory {{.MemUsage}}; PIDs {{.PIDs}}' "$container"
"$engine" exec "$container" node -e '
const fs = require("node:fs");
let processCount = 0;
let rssKiB = 0;
for (const pid of fs.readdirSync("/proc").filter((entry) => /^\d+$/u.test(entry))) {
  if (Number(pid) === process.pid) continue;
  try {
    const status = fs.readFileSync(`/proc/${pid}/status`, "utf8");
    processCount += 1;
    rssKiB += Number(status.match(/^VmRSS:\s+(\d+)\s+kB$/mu)?.[1] ?? 0);
  } catch {}
}
console.log(`Startup process measurement: ${processCount} processes; ${rssKiB} KiB aggregate RSS (measurement helper excluded)`);
'
"$engine" kill --signal TERM "$container" >/dev/null
exit_code="$("$engine" wait "$container")"
[[ "$exit_code" == 0 ]] || {
  echo "The OCI process did not exit successfully after SIGTERM (exit $exit_code)." >&2
  "$engine" logs "$container" >&2 || true
  exit 1
}
logs="$("$engine" logs "$container" 2>&1)"
if ! grep -Fq "Codexia shutdown complete" <<<"$logs"; then
  echo "The OCI process exited without completing the API drain callback." >&2
  printf '%s\n' "$logs" >&2
  exit 1
fi
echo "OCI shutdown check passed: SIGTERM invoked the API close/drain path without publishing."
