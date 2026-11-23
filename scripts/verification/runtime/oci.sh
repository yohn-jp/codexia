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
database_password="$(od -An -N24 -tx1 /dev/urandom | tr -d ' \n')"

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
chmod 0444 "$secret_directory/postgres-password"

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
source "$(dirname "$0")/better-auth-fixture.sh"
setup_oci_better_auth "$engine" "$image" "$verification_network" "$database_container" "$secret_directory" "$bootstrap_container" "$oidc_container"

"$engine" run --detach \
  --name "$container" \
  --network "$verification_network" --network-alias codexia-api \
  --stop-timeout 30 \
  --publish "127.0.0.1:${port}:3000" \
  --volume "$secret_directory/postgres-password:/run/secrets/app-password:ro" \
  "${oci_auth_runtime_args[@]}" \
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

node scripts/verification/runtime/oci-http.mjs "http://127.0.0.1:${port}" "$profile"
session_status="$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' "http://127.0.0.1:${port}/api/session")"
[[ "$session_status" == 401 ]] || { echo "Unauthenticated API session returned HTTP $session_status." >&2; exit 1; }
"$engine" exec "$oidc_container" node /fixture/fixture.mjs authorize "$OCI_AUTH_WEB_CLIENT" "$oci_owner_subject" >/dev/null
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
