#!/usr/bin/env bash
set -euo pipefail

engine="${1:-docker}"
image="${2:-codexia-backend-ci}"
expected_source="${3:-$(git rev-parse HEAD)}"
expected_profile="${4:-core}"
container_name="codexia-backend-smoke-${RANDOM}-${RANDOM}"
database_container="codexia-backend-smoke-db-${RANDOM}-${RANDOM}"
preflight_container="codexia-backend-smoke-preflight-${RANDOM}-${RANDOM}"
bootstrap_container="codexia-backend-smoke-auth-bootstrap-${RANDOM}-${RANDOM}"
oidc_container="codexia-backend-smoke-auth-oidc-${RANDOM}-${RANDOM}"
verification_network="codexia-backend-smoke-net-${RANDOM}-${RANDOM}"
database_password="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(24).toString("hex"))')"
database_image="docker.io/library/postgres:17-bookworm@sha256:40865bc877a289da75963d97d72b59633f639fc5af7a4e856bfa3714cae5b536"
secret_directory="$(mktemp -d "${TMPDIR:-/tmp}/codexia-backend-secrets.XXXXXX")"
umask 077

cleanup() {
  "$engine" rm --volumes --force "$container_name" "$preflight_container" "$bootstrap_container" "$oidc_container" "$database_container" >/dev/null 2>&1 || true
  "$engine" network rm "$verification_network" >/dev/null 2>&1 || true
  rm -rf -- "$secret_directory"
}
trap cleanup EXIT INT TERM

printf '%s' "$database_password" > "$secret_directory/postgres-password"
chmod 0444 "$secret_directory/postgres-password"

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

source "$(dirname "$0")/oci-better-auth-fixture.sh"
setup_oci_better_auth "$engine" "$image" "$verification_network" "$database_container" "$secret_directory" "$bootstrap_container" "$oidc_container"

"$engine" run --detach --name "$container_name" --network "$verification_network" --network-alias codexia-api \
  --publish 127.0.0.1::3000 \
  --read-only --tmpfs /tmp:rw,nosuid,nodev,noexec,size=64m \
  --cap-drop ALL --security-opt no-new-privileges \
  --volume "$secret_directory/postgres-password:/run/secrets/app-password:ro" \
  "${oci_auth_runtime_args[@]}" \
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
for command in bootstrap-auth grant-passkey-owner grant-passkey-owner-recovery migrate-auth; do
  status=0
  message=$("$engine" exec "$container_name" node "/app/node_modules/@codexia/api/dist/$command.js" 2>&1) || status=$?
  [[ "$status" == 1 && "$message" == "Better Auth "* ]] || {
    echo "Packaged Better Auth command did not run its input guard: $command" >&2
    exit 1
  }
done
"$engine" exec "$container_name" node /app/node_modules/@codexia/api/dist/verify-auth-clients.js

session_status="$(curl --silent --output /dev/null --write-out '%{http_code}' "http://127.0.0.1:$port/api/session")"
root_response="$(curl --silent --write-out '\n%{http_code}' "http://127.0.0.1:$port/")"
desktop_response="$(curl --silent --write-out '\n%{http_code}' "http://127.0.0.1:$port/desktop/")"
root_status="${root_response##*$'\n'}"
desktop_status="${desktop_response##*$'\n'}"
[[ "$session_status" == 401 ]] || { echo "Unauthenticated API session returned HTTP $session_status." >&2; exit 1; }
# Materialize two real snapshots with the author API before simulating an older
# projection epoch on the disposable database. Both must be safe to inspect
# using the exact dedicated read-only updater role, including a mismatched one.
projects="$("$engine" exec "$oidc_container" node /fixture/fixture.mjs backend-smoke "$OCI_AUTH_WEB_CLIENT" "$oci_owner_subject" | node --input-type=module -e '
  import assert from "node:assert/strict";
  import { readFileSync } from "node:fs";
  const {legacyProject,incompatibleProject} = JSON.parse(readFileSync(0, "utf8"));
  for (const project of [legacyProject, incompatibleProject]) assert.match(project, /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/u);
  assert.notEqual(legacyProject, incompatibleProject);
  console.log(legacyProject, incompatibleProject);
')"
read -r legacy_project incompatible_project <<<"$projects"
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

# The smoke writer is stopped. Provision the reader and reproduce the two old
# snapshot states plus a live legacy grant on a project without any snapshot.
preflight_password="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(24).toString("hex"))')"
publishing_project="$(node -e 'process.stdout.write(require("node:crypto").randomUUID())')"
legacy_grant_digest_input='codexia disposable OCI fixture: historical Publishing grant digest'
expected_legacy_grant_digest="$(node -e 'process.stdout.write(require("node:crypto").createHash("sha256").update(process.argv[1]).digest("hex"))' "$legacy_grant_digest_input")"
printf '%s' "$preflight_password" > "$secret_directory/preflight-password"
chmod 0444 "$secret_directory/preflight-password"
"$engine" exec -i "$database_container" psql -X -q -v ON_ERROR_STOP=1 -U codexia -d codexia_verify \
  -v legacy="$legacy_project" -v incompatible="$incompatible_project" -v publishing="$publishing_project" \
  -v preflight_password="$preflight_password" -v legacy_grant_digest_input="$legacy_grant_digest_input" <<'SQL'
CREATE ROLE codexia_preflight LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD :'preflight_password';
ALTER ROLE codexia_preflight SET default_transaction_read_only = on;
ALTER ROLE codexia_auth_runtime IN DATABASE codexia_verify SET default_transaction_read_only = on;
GRANT CONNECT ON DATABASE codexia_verify TO codexia_preflight;
GRANT USAGE ON SCHEMA public TO codexia_preflight;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO codexia_preflight;
DELETE FROM module_record WHERE project_id IN (:'legacy', :'incompatible') AND module_id='core.authority.snapshots' AND key LIKE 'proof:projection:%';
UPDATE module_record SET value=value - 'knowledge'
 WHERE project_id=:'incompatible' AND module_id='core.authority.snapshots' AND key LIKE 'snapshot:%' AND value ? 'knowledge';
INSERT INTO project(id, title) VALUES (:'publishing', 'Publishing without a saved snapshot');
INSERT INTO module_record(project_id, module_id, key, value) VALUES (:'publishing', 'core.artifacts',
 'meta/scriptorium/modules/publishing/share-grants.jsonl',
 jsonb_build_object('content', jsonb_build_object(
   'id', 'fixture-grant', 'tokenHash', encode(sha256(convert_to(:'legacy_grant_digest_input', 'UTF8')), 'hex'),
   'scope', 'ch-first', 'label', 'Historical share', 'createdAt', '2025-01-01T00:00:00.000Z',
   'expiresAt', '2099-01-01T00:00:00.000Z', 'grantVersion', 3, 'revocationVersion', 1
 )::text));
SQL
db_state() {
  "$engine" exec "$database_container" psql -X -A -t -v ON_ERROR_STOP=1 -U codexia -d codexia_verify \
    -c "SELECT id,version FROM project ORDER BY id; SELECT project_id,module_id,key,version,md5(value::text) FROM module_record ORDER BY project_id,module_id,key;"
}
before_preflight="$(db_state)"
[[ "$(printf '%s\n' "$before_preflight" | grep -c '|core.authority.snapshots|snapshot:')" == 2 ]]
[[ "$before_preflight" != *'|proof:projection:'* ]]
start_snapshot_preflight() {
  "$engine" run --detach --name "$preflight_container" --network "$verification_network" \
    --publish 127.0.0.1::3000 --read-only \
    --tmpfs /tmp:rw,nosuid,nodev,noexec,size=64m \
    --tmpfs /data:rw,nosuid,nodev,noexec,size=128m,mode=1777 \
    --tmpfs /history:rw,nosuid,nodev,noexec,size=64m,mode=1777 \
    --cap-drop ALL --security-opt no-new-privileges \
    --volume "$secret_directory/preflight-password:/run/secrets/app-password:ro" \
    "${oci_auth_runtime_args[@]}" \
    --env CODEXIA_DATA_DIR=/data --env CODEXIA_USAGE_DIR=/history \
    --env CODEXIA_DATABASE_PASSWORD_FILE=/run/secrets/app-password \
    --env CODEXIA_DATABASE_USER=codexia_preflight --env CODEXIA_DATABASE_NAME=codexia_verify \
    --env "CODEXIA_DATABASE_HOST=$database_container" --env CODEXIA_DATABASE_MIGRATE_ON_START=0 \
    --env 'PGOPTIONS=-c default_transaction_read_only=on' \
    "$image" >/dev/null
}
snapshot_maintenance() {
  local role="$1" password="$2"
  shift 2
  CODEXIA_DATABASE_URL="postgres://$role:$password@$database_container:5432/codexia_verify" \
    "$engine" run --rm --network "$verification_network" --read-only \
    --cap-drop ALL --security-opt no-new-privileges --env CODEXIA_DATABASE_URL \
    --entrypoint=node "$image" /app/node_modules/@codexia/api/dist/maintain-snapshot-projections.js "$@"
}
wait_for_snapshot_readiness() {
  local container="$1" port attempt
  port="$("$engine" port "$container" 3000/tcp | sed -n 's/.*://p')"
  [[ -n "$port" ]]
  for attempt in $(seq 1 60); do
    if curl --fail --silent "http://127.0.0.1:$port/health/ready" >/dev/null; then return; fi
    if [[ "$("$engine" inspect --format '{{.State.Running}}' "$container")" != true ]]; then break; fi
    sleep 1
  done
  "$engine" logs "$container" >&2 || true
  echo "Backend did not become ready after snapshot projection maintenance." >&2
  return 1
}

start_snapshot_preflight
for attempt in $(seq 1 60); do
  [[ "$("$engine" inspect --format '{{.State.Running}}' "$preflight_container")" != true ]] && break
  sleep 1
done
[[ "$("$engine" inspect --format '{{.State.Running}} {{.State.ExitCode}}' "$preflight_container")" == 'false 1' ]]
refusal="$("$engine" logs "$preflight_container" 2>&1)"
[[ "$refusal" == *SNAPSHOT_PROJECTION_MAINTENANCE_REQUIRED* && "$refusal" == *"$legacy_project"* &&
   "$refusal" == *"$incompatible_project"* && "$refusal" == *"$publishing_project"* ]]
"$engine" rm --volumes "$preflight_container" >/dev/null
check_status=0
check_result="$(snapshot_maintenance codexia_preflight "$preflight_password" --check)" || check_status=$?
[[ "$check_status" == 2 && "$check_result" == *'"status":"maintenance_required"'* && "$check_result" == *"$legacy_project"* &&
   "$check_result" == *"$incompatible_project"* && "$check_result" == *"\"pendingPublishingProjectIds\":[\"$publishing_project\"]"* ]]
if snapshot_maintenance codexia_preflight "$preflight_password" --apply >"$secret_directory/preflight-apply.log" 2>&1; then
  echo 'Read-only PostgreSQL role unexpectedly applied the projection transition.' >&2
  exit 1
fi
grep -Fxq 'Snapshot projection maintenance requires the writable PostgreSQL role' "$secret_directory/preflight-apply.log"
[[ "$(db_state)" == "$before_preflight" ]] || { echo "Read-only preflight changed PostgreSQL state." >&2; exit 1; }

snapshot_maintenance codexia "$database_password" --apply --project "$publishing_project" | grep -Fxq '{"status":"ready","projectsProcessed":0,"publishingRowsMigrated":1}'
"$engine" exec -i "$database_container" psql -X -A -t -q -v ON_ERROR_STOP=1 -U codexia -d codexia_verify \
  -v publishing="$publishing_project" <<'SQL' | grep -Fxq "fixture-grant|chapter|ch-first|$expected_legacy_grant_digest|3|1|2099-01-01T00:00:00.000Z"
SELECT grant_data->>'id', grant_data#>>'{scope,kind}', grant_data#>>'{scope,id}', grant_data->>'tokenHash',
       grant_data->>'grantVersion', grant_data->>'revocationVersion', grant_data->>'expiresAt'
FROM module_record CROSS JOIN LATERAL jsonb_array_elements(value->'grants') grant_data
WHERE project_id=:'publishing' AND module_id='publishing' AND key='share-grants';
SQL
snapshot_maintenance codexia "$database_password" --apply --project "$legacy_project" | grep -Fxq '{"status":"ready","projectsProcessed":1,"publishingRowsMigrated":0}'
check_status=0
check_result="$(snapshot_maintenance codexia_preflight "$preflight_password" --check)" || check_status=$?
[[ "$check_status" == 2 && "$check_result" == *"$incompatible_project"* && "$check_result" != *"$legacy_project"* ]]
snapshot_maintenance codexia "$database_password" --apply | grep -Fxq '{"status":"ready","projectsProcessed":1,"publishingRowsMigrated":0}'
after_maintenance="$(db_state)"
state_version() { awk -F'|' -v id="$1" '$1 == id && NF == 2 { print $2 }'; }
legacy_version="$(state_version "$legacy_project" <<<"$before_preflight")"
incompatible_version="$(state_version "$incompatible_project" <<<"$before_preflight")"
[[ "$(state_version "$legacy_project" <<<"$after_maintenance")" == "$legacy_version" ]]
[[ "$(state_version "$incompatible_project" <<<"$after_maintenance")" == "$((incompatible_version + 1))" ]]
[[ "$(grep -F '|core.authority.snapshots|snapshot:' <<<"$after_maintenance")" == "$(grep -F '|core.authority.snapshots|snapshot:' <<<"$before_preflight")" ]]
snapshot_maintenance codexia "$database_password" --apply | grep -Fxq '{"status":"ready","projectsProcessed":0,"publishingRowsMigrated":0}'
snapshot_maintenance codexia_preflight "$preflight_password" --check | grep -Fxq '{"status":"ready","pendingProjectIds":[],"pendingPublishingProjectIds":[]}'
[[ "$(db_state)" == "$after_maintenance" ]]
unset preflight_password

start_snapshot_preflight
wait_for_snapshot_readiness "$preflight_container"
[[ "$(db_state)" == "$after_maintenance" ]]
"$engine" kill --signal TERM "$preflight_container" >/dev/null
[[ "$("$engine" wait "$preflight_container")" == 0 ]]
"$engine" exec "$database_container" psql -X -q -v ON_ERROR_STOP=1 -U codexia -d codexia_verify \
  -c 'ALTER ROLE codexia_auth_runtime IN DATABASE codexia_verify RESET default_transaction_read_only;'
"$engine" start "$container_name" >/dev/null
wait_for_snapshot_readiness "$container_name"
[[ "$(db_state)" == "$after_maintenance" ]]
"$engine" kill --signal TERM "$container_name" >/dev/null
[[ "$("$engine" wait "$container_name")" == 0 ]]
echo "Explicit Snapshot and Publishing maintenance verified: startup refusal, read-only check, grant conversion, pinned state retention, and reader/writer restarts."
