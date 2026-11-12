#!/usr/bin/env bash
set -euo pipefail

engine="${1:-docker}"
image="${2:-codexia-backend-ci}"
expected_source="${3:-$(git rev-parse HEAD)}"
expected_profile="${4:-core}"
container_name="codexia-backend-smoke-${RANDOM}-${RANDOM}"
database_container="codexia-backend-smoke-db-${RANDOM}-${RANDOM}"
verification_network="codexia-backend-smoke-net-${RANDOM}-${RANDOM}"
token="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))')"
database_password="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(24).toString("hex"))')"
database_image="docker.io/library/postgres:17-bookworm@sha256:665dc7b37ac52a17e298511414c21d23ffa4e6a6ef6225b3e5d59c7afb35e994"

cleanup() {
  "$engine" rm --volumes --force "$container_name" "$database_container" >/dev/null 2>&1 || true
  "$engine" network rm "$verification_network" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

"$engine" network create "$verification_network" >/dev/null
"$engine" run --detach --name "$database_container" --network "$verification_network" \
	--env POSTGRES_USER=codexia --env POSTGRES_DB=codexia_verify --env "POSTGRES_PASSWORD=$database_password" \
	"$database_image" >/dev/null

database_ready=0
for attempt in $(seq 1 60); do
  if "$engine" exec "$database_container" pg_isready -U codexia -d codexia_verify >/dev/null 2>&1; then
    database_ready=1
    break
  fi
  if [[ "$("$engine" inspect --format '{{.State.Running}}' "$database_container")" != true ]]; then break; fi
  sleep 1
done
if [[ "$database_ready" != 1 ]]; then
  "$engine" logs "$database_container" >&2 || true
  echo "The backend smoke PostgreSQL database did not become ready." >&2
  exit 1
fi

"$engine" run --detach --name "$container_name" --network "$verification_network" \
  --publish 127.0.0.1::3000 \
  --env "CODEXIA_AUTH_TOKEN=$token" \
  --env CODEXIA_DATA_DIR=/data \
  --env CODEXIA_USAGE_DIR=/history \
  --env "CODEXIA_DATABASE_URL=postgres://codexia:${database_password}@${database_container}:5432/codexia_verify" \
  --env CODEXIA_DATABASE_MIGRATE_ON_START=1 \
  "$image" >/dev/null

port="$("$engine" port "$container_name" 3000/tcp | sed -n 's/.*://p')"
if [[ -z "$port" ]]; then
  echo "The backend test container did not publish its temporary local probe port." >&2
  exit 1
fi

ready=0
for attempt in $(seq 1 60); do
  if curl --fail --silent "http://127.0.0.1:$port/health/ready" >/dev/null; then
    ready=1
    break
  fi
  if [[ "$("$engine" inspect --format '{{.State.Running}}' "$container_name")" != true ]]; then break; fi
  sleep 1
done
if [[ "$ready" != 1 ]]; then
  "$engine" logs "$container_name" >&2 || true
  echo "The backend did not become ready." >&2
  exit 1
fi

for endpoint in /health/startup /health/live /api/health /api/ready; do
  curl --fail --silent "http://127.0.0.1:$port$endpoint" >/dev/null
done

identity="$("$engine" exec "$container_name" cat /app/update-identity.json)"
api_version="$(curl --fail --silent "http://127.0.0.1:$port/api/version")"
platform="$("$engine" image inspect --format '{{.Os}}/{{.Architecture}}' "$image")"
revision_label="$("$engine" image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$image")"
fingerprint="$("$engine" exec "$container_name" node --input-type=module -e 'import { packagedMigrationFingerprint } from "@codexia/api"; console.log(await packagedMigrationFingerprint());')"
node scripts/backend-update-identity.mjs verify "$identity" "$api_version" "$platform" "$revision_label" "$fingerprint" "$expected_source" "$expected_profile"

session_status="$(curl --silent --output /dev/null --write-out '%{http_code}' "http://127.0.0.1:$port/api/session")"
root_response="$(curl --silent --write-out '\n%{http_code}' "http://127.0.0.1:$port/")"
desktop_response="$(curl --silent --write-out '\n%{http_code}' "http://127.0.0.1:$port/desktop/")"
root_status="${root_response##*$'\n'}"
desktop_status="${desktop_response##*$'\n'}"
[[ "$session_status" == 401 ]] || { echo "Unauthenticated API session returned HTTP $session_status." >&2; exit 1; }
[[ "$root_status" == 503 && "$root_response" == *'"code":"APP_NOT_BUILT"'* &&
   "$desktop_status" == 503 && "$desktop_response" == *'"code":"APP_NOT_BUILT"'* ]] || {
  echo "Backend image did not keep the UI outside its image (root=$root_status, desktop=$desktop_status)." >&2
  exit 1
}

uid="$("$engine" exec "$container_name" node -p 'process.getuid()')"
[[ "$uid" == 1000 ]] || { echo "Expected backend UID 1000; got $uid." >&2; exit 1; }
"$engine" exec "$container_name" node -e "const fs = require('node:fs'); if (fs.existsSync('/app/app/dist/index.html')) process.exit(1); fs.writeFileSync('/data/.deployment-smoke', 'ok'); fs.unlinkSync('/data/.deployment-smoke')"

"$engine" kill --signal TERM "$container_name" >/dev/null
exit_code="$("$engine" wait "$container_name")"
[[ "$exit_code" == 0 ]] || { echo "Backend did not exit cleanly after SIGTERM (exit $exit_code)." >&2; exit 1; }
"$engine" logs "$container_name" 2>&1 | grep -Fq 'Codexia shutdown complete'
echo "Backend OCI checks passed: health/readiness, auth boundary, no UI assets, nonroot UID, writable persistence, and graceful shutdown."
