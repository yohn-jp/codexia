#!/usr/bin/env bash
set -euo pipefail

engine="${1:-docker}"
image="${2:-codexia-backend-ci}"
expected_source="${3:-$(git rev-parse HEAD)}"
expected_profile="${4:-core}"
container_name="codexia-backend-smoke-${RANDOM}-${RANDOM}"
database_container="codexia-backend-smoke-db-${RANDOM}-${RANDOM}"
preflight_container="codexia-backend-smoke-preflight-${RANDOM}-${RANDOM}"
verification_network="codexia-backend-smoke-net-${RANDOM}-${RANDOM}"
token="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))')"
database_password="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(24).toString("hex"))')"
database_image="docker.io/library/postgres:17-bookworm@sha256:40865bc877a289da75963d97d72b59633f639fc5af7a4e856bfa3714cae5b536"
secret_directory="$(mktemp -d "${TMPDIR:-/tmp}/codexia-backend-secrets.XXXXXX")"
umask 077

cleanup() {
  "$engine" rm --volumes --force "$container_name" "$preflight_container" "$database_container" >/dev/null 2>&1 || true
  "$engine" network rm "$verification_network" >/dev/null 2>&1 || true
  rm -rf -- "$secret_directory"
}
trap cleanup EXIT INT TERM

printf '%s' "$database_password" > "$secret_directory/postgres-password"
printf '%s' "$token" > "$secret_directory/auth-token"
printf '{"token":"%s"}' "$token" > "$secret_directory/login.json"
chmod 0444 "$secret_directory/postgres-password" "$secret_directory/auth-token"

"$engine" network create "$verification_network" >/dev/null
"$engine" run --detach --name "$database_container" --network "$verification_network" \
	--env POSTGRES_USER=codexia --env POSTGRES_DB=codexia_verify --env POSTGRES_PASSWORD_FILE=/run/secrets/postgres-password \
	--volume "$secret_directory/postgres-password:/run/secrets/postgres-password:ro" \
	"$database_image" >/dev/null

database_ready=0
for attempt in $(seq 1 60); do
  if "$engine" exec "$database_container" pg_isready -h 127.0.0.1 -U codexia -d codexia_verify >/dev/null 2>&1; then
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
  --read-only --tmpfs /tmp:rw,nosuid,nodev,noexec,size=64m \
  --cap-drop ALL --security-opt no-new-privileges \
  --volume "$secret_directory/auth-token:/run/secrets/codexia-auth-token:ro" \
  --volume "$secret_directory/postgres-password:/run/secrets/app-password:ro" \
  --env CODEXIA_AUTH_TOKEN_FILE=/run/secrets/codexia-auth-token \
  --env CODEXIA_DATA_DIR=/data \
  --env CODEXIA_USAGE_DIR=/history \
  --env CODEXIA_DATABASE_PASSWORD_FILE=/run/secrets/app-password \
  --env CODEXIA_DATABASE_USER=codexia --env CODEXIA_DATABASE_NAME=codexia_verify \
  --env "CODEXIA_DATABASE_HOST=$database_container" \
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

# Execute the packaged entry points under their same symlink paths as push deployment.
for command in bootstrap-auth grant-passkey-owner grant-passkey-owner-recovery migrate-auth verify-auth-clients; do
  status=0
  message=$("$engine" exec "$container_name" node "/app/node_modules/@codexia/api/dist/$command.js" 2>&1) || status=$?
  [[ "$status" == 1 && "$message" == "Better Auth "* ]] || {
    echo "Packaged Better Auth command did not run its input guard: $command" >&2
    exit 1
  }
done

session_status="$(curl --silent --output /dev/null --write-out '%{http_code}' "http://127.0.0.1:$port/api/session")"
root_response="$(curl --silent --write-out '\n%{http_code}' "http://127.0.0.1:$port/")"
desktop_response="$(curl --silent --write-out '\n%{http_code}' "http://127.0.0.1:$port/desktop/")"
root_status="${root_response##*$'\n'}"
desktop_status="${desktop_response##*$'\n'}"
[[ "$session_status" == 401 ]] || { echo "Unauthenticated API session returned HTTP $session_status." >&2; exit 1; }
origin="http://127.0.0.1:$port"
curl --fail --silent --show-error --output /dev/null --cookie-jar "$secret_directory/cookies" \
  --header "Origin: $origin" --header "Content-Type: application/json" \
  --data-binary "@$secret_directory/login.json" "$origin/api/login"
curl --fail --silent --show-error --cookie "$secret_directory/cookies" "$origin/api/session" | \
  node -e 'const a=JSON.parse(require("node:fs").readFileSync(0,"utf8")); if(a.authenticated!==true||a.authorScope!=="owner")process.exit(1)'
# Materialize two real snapshots with the author API before simulating an older
# projection epoch on the disposable database. Both must be safe to inspect
# using the exact dedicated read-only updater role, including a mismatched one.
legacy_project="$(curl --fail --silent --show-error --cookie "$secret_directory/cookies" \
  --header "Origin: $origin" --header "Content-Type: application/json" \
  --data '{"title":"Legacy snapshot compatibility"}' "$origin/api/projects" | \
  node -e 'process.stdout.write(JSON.parse(require("node:fs").readFileSync(0,"utf8")).id)')"
incompatible_project="$(curl --fail --silent --show-error --cookie "$secret_directory/cookies" \
  --header "Origin: $origin" --header "Content-Type: application/json" \
  --data '{"title":"Legacy snapshot with different projection"}' "$origin/api/projects" | \
  node -e 'process.stdout.write(JSON.parse(require("node:fs").readFileSync(0,"utf8")).id)')"
for project in "$legacy_project" "$incompatible_project"; do
  curl --fail --silent --show-error --cookie "$secret_directory/cookies" "$origin/api/projects/$project/snapshot" >/dev/null
done
csrf_status="$(curl --silent --output /dev/null --write-out '%{http_code}' --cookie "$secret_directory/cookies" \
  --header "Origin: https://foreign.invalid" --request POST "$origin/api/logout")"
[[ "$csrf_status" == 403 ]] || { echo "Cross-origin logout returned HTTP $csrf_status." >&2; exit 1; }
curl --fail --silent --show-error --cookie "$secret_directory/cookies" --header "Origin: $origin" \
  --request POST "$origin/api/logout" >/dev/null
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

# The smoke writer is stopped. Provision an independent reader password and
# reproduce both legacy states on this disposable database only.
preflight_password="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(24).toString("hex"))')"
printf '%s' "$preflight_password" > "$secret_directory/preflight-password"
chmod 0444 "$secret_directory/preflight-password"
"$engine" exec -i "$database_container" psql -X -q -v ON_ERROR_STOP=1 -U codexia -d codexia_verify \
  -v legacy="$legacy_project" -v incompatible="$incompatible_project" -v preflight_password="$preflight_password" <<'SQL'
CREATE ROLE codexia_preflight LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD :'preflight_password';
ALTER ROLE codexia_preflight SET default_transaction_read_only = on;
GRANT CONNECT ON DATABASE codexia_verify TO codexia_preflight;
GRANT USAGE ON SCHEMA public TO codexia_preflight;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO codexia_preflight;
DELETE FROM module_record WHERE project_id IN (:'legacy', :'incompatible') AND module_id='core.authority.snapshots' AND key LIKE 'proof:projection:%';
UPDATE module_record SET value=jsonb_set(value,'{files}',(value->'files') - 'meta/scriptorium/knowledge-context/v1.json')
 WHERE project_id=:'incompatible' AND module_id='core.authority.snapshots' AND key LIKE 'snapshot:%';
SQL
unset preflight_password
db_state() {
  "$engine" exec "$database_container" psql -X -A -t -v ON_ERROR_STOP=1 -U codexia -d codexia_verify \
    -c "SELECT id,version FROM project ORDER BY id; SELECT project_id,module_id,key,version,md5(value::text) FROM module_record ORDER BY project_id,module_id,key;"
}
before_preflight="$(db_state)"
[[ "$(printf '%s\n' "$before_preflight" | grep -c '|core.authority.snapshots|snapshot:')" == 2 ]]
[[ "$before_preflight" != *'|proof:projection:'* ]]
"$engine" run --detach --name "$preflight_container" --network "$verification_network" \
  --publish 127.0.0.1::3000 --read-only \
  --tmpfs /tmp:rw,nosuid,nodev,noexec,size=64m \
  --tmpfs /data:rw,nosuid,nodev,noexec,size=128m,mode=1777 \
  --tmpfs /history:rw,nosuid,nodev,noexec,size=64m,mode=1777 \
  --cap-drop ALL --security-opt no-new-privileges \
  --volume "$secret_directory/auth-token:/run/secrets/codexia-auth-token:ro" \
  --volume "$secret_directory/preflight-password:/run/secrets/app-password:ro" \
  --env CODEXIA_AUTH_TOKEN_FILE=/run/secrets/codexia-auth-token \
  --env CODEXIA_DATA_DIR=/data --env CODEXIA_USAGE_DIR=/history \
  --env CODEXIA_DATABASE_PASSWORD_FILE=/run/secrets/app-password \
  --env CODEXIA_DATABASE_USER=codexia_preflight --env CODEXIA_DATABASE_NAME=codexia_verify \
  --env "CODEXIA_DATABASE_HOST=$database_container" --env CODEXIA_DATABASE_MIGRATE_ON_START=0 \
  --env 'PGOPTIONS=-c default_transaction_read_only=on' \
  "$image" >/dev/null
preflight_port="$("$engine" port "$preflight_container" 3000/tcp | sed -n 's/.*://p')"
[[ -n "$preflight_port" ]]
preflight_ready=0
for attempt in $(seq 1 60); do
  if curl --fail --silent "http://127.0.0.1:$preflight_port/health/ready" >/dev/null; then
    preflight_ready=1
    break
  fi
  if [[ "$("$engine" inspect --format '{{.State.Running}}' "$preflight_container")" != true ]]; then break; fi
  sleep 1
done
if [[ "$preflight_ready" != 1 ]]; then
  "$engine" logs "$preflight_container" >&2 || true
  echo "Read-only legacy Snapshot preflight did not become ready." >&2
  exit 1
fi
[[ "$(db_state)" == "$before_preflight" ]] || { echo "Read-only preflight changed PostgreSQL state." >&2; exit 1; }
"$engine" kill --signal TERM "$preflight_container" >/dev/null
[[ "$("$engine" wait "$preflight_container")" == 0 ]]
echo "Backend read-only Snapshot preflight passed: equivalent and incompatible legacy projections, unchanged PostgreSQL state."
