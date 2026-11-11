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
  echo "od is required to generate a temporary verification token." >&2
  exit 2
}

image="${CODEXIA_OCI_IMAGE:-codexia:verification}"
port="${CODEXIA_OCI_PORT:-3040}"
profile="${CODEXIA_PROFILE:-core}"
container="codexia-verify-$$"
database_container="codexia-verify-db-$$"
verification_network="codexia-verify-net-$$"
database_password="$(od -An -N24 -tx1 /dev/urandom | tr -d ' \n')"
verification_token="$(od -An -N24 -tx1 /dev/urandom | tr -d ' \n')"

case "$profile" in
  core|full) ;;
  *) echo "CODEXIA_PROFILE must be core or full." >&2; exit 2 ;;
esac

cleanup() {
  "$engine" rm --volumes --force "$container" "$database_container" >/dev/null 2>&1 || true
  "$engine" network rm "$verification_network" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

if [[ "${engine##*/}" == podman ]]; then
  "$engine" build --format oci --pull --build-arg "PROFILE=$profile" --tag "$image" .
else
  "$engine" build --pull --build-arg "PROFILE=$profile" --tag "$image" .
fi
"$engine" network create "$verification_network" >/dev/null
"$engine" run --detach --name "$database_container" --network "$verification_network" \
  --env POSTGRES_USER=codexia --env POSTGRES_DB=codexia_verify --env "POSTGRES_PASSWORD=$database_password" \
  docker.io/library/postgres:17-bookworm@sha256:665dc7b37ac52a17e298511414c21d23ffa4e6a6ef6225b3e5d59c7afb35e994
for attempt in $(seq 1 40); do
  if "$engine" exec "$database_container" pg_isready -U codexia -d codexia_verify >/dev/null 2>&1; then break; fi
  sleep 0.5
done
"$engine" exec "$database_container" pg_isready -U codexia -d codexia_verify >/dev/null
"$engine" run --detach \
  --name "$container" \
  --network "$verification_network" \
  --stop-timeout 30 \
  --publish "127.0.0.1:${port}:3000" \
  --env "CODEXIA_AUTH_TOKEN=$verification_token" \
  --env CODEXIA_DATA_DIR=/data \
  --env "CODEXIA_DATABASE_URL=postgres://codexia:${database_password}@${database_container}:5432/codexia_verify" \
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
uid="$("$engine" exec "$container" node -p 'process.getuid()')"
[[ "$uid" == 1000 ]] || {
  echo "Expected the application to run as UID 1000; got $uid." >&2
  exit 1
}
"$engine" exec "$container" node -e "require('node:fs').writeFileSync('/data/.oci-smoke', 'ok'); require('node:fs').unlinkSync('/data/.oci-smoke')"

echo "OCI startup checks passed: production ${profile} profile, HTTP probes, nonroot UID, and writable /data."
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
