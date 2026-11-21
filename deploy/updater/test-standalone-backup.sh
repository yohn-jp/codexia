#!/usr/bin/env bash
# Real disposable Podman/PostgreSQL/age exercise. The mount/network shims only
# model an approved remote mount; this test is not off-VM backup evidence.
set -Eeuo pipefail
# The fixture redirects expected-failure output and removes its private scratch
# tree on exit. Report only source location/status (not command arguments,
# environment or secret-bearing logs) when an unexpected command fails.
trap 'printf "Unexpected backup fixture failure at %s:%s (status %s)\n" "${BASH_SOURCE[0]}" "$LINENO" "$?" >&2' ERR
test "${CODEXIA_DISPOSABLE_BACKUP_TEST:-}" = true
test "$(id -un)" = codexia-phase-e-test
test "$(id -u)" != 0
test "$(podman info --format '{{.Host.Security.Rootless}}')" = true

for command in podman age age-keygen flock findmnt sha256sum sync stat getent ip; do
  command -v "$command" >/dev/null
done

repo_root=$(pwd)
backup_script="$repo_root/deploy/updater/standalone-backup.sh"
live_db_image=$(sed -n 's/^Image=//p' "$repo_root/deploy/quadlet/codexia-db.container")
backup_db_image=$(sed -n "s/^readonly PG_IMAGE='\(.*\)'$/\1/p" "$backup_script")
backend_node_image=$(sed -n 's/^ARG NODE_IMAGE=//p' "$repo_root/Dockerfile.backend")
backend_history_module="$repo_root/packages/api/dist/job-history-store.js"
test -n "$live_db_image"
test "$backup_db_image" = "$live_db_image"
test -n "$backend_node_image"
test -f "$backend_history_module"

for container in codexia-db codexia-api codexia-slot-blue codexia-slot-green codexia-preflight-blue codexia-preflight-green; do
  status=0
  podman container exists "$container" || status=$?
  test "$status" = 1
done
for volume in codexia-history codexia-backup-test-db; do
  status=0
  podman volume exists "$volume" || status=$?
  test "$status" = 1
done

tmp=$(mktemp -d "${TMPDIR:-/tmp}/codexia-backup-test.XXXXXX")
history_created=false
database_created=false
container_created=false
api_fixture_created=false
cleanup() {
  if [[ "$api_fixture_created" == true ]]; then podman rm -f codexia-api >/dev/null 2>&1 || true; fi
  if [[ "$container_created" == true ]]; then podman rm -f codexia-db >/dev/null 2>&1 || true; fi
  if [[ "$history_created" == true ]]; then podman volume rm codexia-history >/dev/null 2>&1 || true; fi
  if [[ "$database_created" == true ]]; then podman volume rm codexia-backup-test-db >/dev/null 2>&1 || true; fi
  python3 -c 'import shutil,sys; shutil.rmtree(sys.argv[1],ignore_errors=True)' "$tmp"
}
trap cleanup EXIT
umask 077

state_home="$tmp/state"
state_dir="$state_home/codexia-updater"
remote="$tmp/remote"
shim="$tmp/bin"
mkdir -p "$state_dir" "$remote" "$shim"
printf 'blocked\n' > "$state_dir/route"
mkdir "$tmp/quadlet"
printf 'fixture public key input\n' > "$tmp/channel-public.pem"
printf 'fixture read token\n' > "$tmp/github-token"
cat > "$tmp/config.json" <<JSON
{"format":"codexia-standalone-updater/v1","stateFile":"$state_dir/controller.json","routeFile":"$state_dir/route","publicKeyFile":"$tmp/channel-public.pem","quadletDirectory":"$tmp/quadlet","githubTokenFile":"$tmp/github-token","frontendIdentityUrl":"https://backup-test.invalid/desktop/update-identity.json","browserAuth":{"mode":"token"}}
JSON

real_findmnt=$(command -v findmnt)
cat > "$shim/findmnt" <<'SH'
#!/usr/bin/env bash
if [[ "${1:-}" == -T && "${2:-}" == "${CODEXIA_TEST_REMOTE:-}"* && "${3:-}" == -n && "${4:-}" == -o ]]; then
  case "${5:-}" in
    FSTYPE) printf '%s\n' nfs4 ;;
    SOURCE) printf '%s\n' "${CODEXIA_TEST_REMOTE_SOURCE:-backup.example.invalid:/export}" ;;
    *) exit 2 ;;
  esac
else
  exec "${CODEXIA_REAL_FINDMNT:?}" "$@"
fi
SH
cat > "$shim/getent" <<'SH'
#!/usr/bin/env bash
[[ "${1:-}" == ahosts ]] || exit 2
case "${2:-}" in
  localhost) printf '%s\n' '127.0.0.1 STREAM localhost' ;;
  backup.example.invalid) printf '%s\n' "${CODEXIA_TEST_REMOTE_ADDRESS:-192.0.2.10} STREAM backup.example.invalid" ;;
  *) exit 2 ;;
esac
SH
cat > "$shim/ip" <<'SH'
#!/usr/bin/env bash
[[ "${1:-}" == -o && "${2:-}" == address && "${3:-}" == show ]] || exit 2
printf '%s\n' '1: lo inet 127.0.0.1/8 scope host lo' '1: lo inet6 ::1/128 scope host lo'
SH
chmod 0700 "$shim/findmnt" "$shim/getent" "$shim/ip"
export PATH="$shim:$PATH"
export XDG_STATE_HOME="$state_home"
export CODEXIA_TEST_REMOTE="$remote"
export CODEXIA_REAL_FINDMNT="$real_findmnt"
# A hostname can resolve to any address in 127/8, not just the literal
# address assigned to lo. Unspecified and IPv4-mapped local addresses must
# also fail before any writer is drained or artifact is created.
for address in 127.0.0.2 ::ffff:127.0.0.2 0.0.0.0 :: ::1; do
  if CODEXIA_TEST_REMOTE_ADDRESS="$address" bash "$backup_script" validate-destination "$remote" > "$tmp/local-address.log" 2>&1; then
    echo "Backup accepted a locally resolved address: $address" >&2
    exit 1
  fi
  grep -q 'Backup destination resolves to this VM' "$tmp/local-address.log"
done
for address in 192.0.2.10 2001:db8::10 ::ffff:192.0.2.10; do
  CODEXIA_TEST_REMOTE_ADDRESS="$address" bash "$backup_script" validate-destination "$remote" >/dev/null
done
run_locked_backup() {
  (
    exec 9> "$state_dir/host.lock"
    flock --exclusive --nonblock 9
    CODEXIA_UPDATER_LOCK_HELD=1 CODEXIA_UPDATER_LOCK_DIRECTORY="$state_dir" CODEXIA_UPDATER_LOCK_FD=9 \
      bash "$backup_script" backup-locked "$1" "$2"
  )
}

age-keygen -o "$tmp/age-identity" 2> /dev/null
chmod 0600 "$tmp/age-identity"
recipient=$(age-keygen -y "$tmp/age-identity")
[[ "$recipient" =~ ^age1[0-9a-z]+$ ]]

podman volume create codexia-backup-test-db >/dev/null
database_created=true
podman volume create codexia-history >/dev/null
history_created=true
# Match the backend image's COPY-UP ownership for the empty named volume:
# Dockerfile.backend defines /history as node:node (UID/GID 1000).
podman run --rm --network none --read-only --cap-drop all --cap-add chown --security-opt no-new-privileges \
  --user 0:0 --entrypoint /bin/bash --volume codexia-history:/history \
  "$backend_node_image" -e -c 'chmod 0700 /history && chown 1000:1000 /history'
printf 'fixture-only-admin-password' > "$tmp/admin-password"
chmod 0644 "$tmp/admin-password"
container_created=true
podman run --detach --name codexia-db --network none \
  --volume codexia-backup-test-db:/var/lib/postgresql/data \
  --volume "$tmp/admin-password:/run/secrets/admin-password:ro" \
  --env POSTGRES_DB=codexia --env POSTGRES_USER=codexia_admin \
  --env POSTGRES_HOST_AUTH_METHOD=trust "$live_db_image" >/dev/null
# Wait for the final PostgreSQL server, not the temporary initdb socket.
for attempt in $(seq 1 60); do
  if podman exec codexia-db psql -X -qAt -v ON_ERROR_STOP=1 -h 127.0.0.1 -U codexia_admin -d codexia -c 'SELECT 1' >/dev/null 2>&1; then break; fi
  sleep 1
done
podman exec codexia-db psql -X -qAt -v ON_ERROR_STOP=1 -h 127.0.0.1 -U codexia_admin -d codexia -c 'SELECT 1' >/dev/null
podman exec codexia-db psql -X -v ON_ERROR_STOP=1 -U codexia_admin -d codexia \
  -c "CREATE TABLE public.backup_probe(id integer PRIMARY KEY, value text NOT NULL); INSERT INTO public.backup_probe VALUES (1, 'encrypted-fixture-row');" >/dev/null
podman exec codexia-db psql -X -v ON_ERROR_STOP=1 -U codexia_admin -d codexia \
  -c "CREATE SCHEMA codexia_auth; CREATE TABLE codexia_auth.backup_probe(id integer PRIMARY KEY, value text NOT NULL); INSERT INTO codexia_auth.backup_probe VALUES (1, 'auth-recovery-fixture-row');" >/dev/null
write_backend_history() {
  local job_id="$1"
  podman run --rm --network none --read-only --cap-drop all --security-opt no-new-privileges \
    --user 1000:1000 --entrypoint node \
    --volume codexia-history:/history \
    --volume "$backend_history_module:/fixture/job-history-store.js:ro" \
    "$backend_node_image" --input-type=module -e \
    'import { pathToFileURL } from "node:url"; const { JobHistoryStore } = await import(pathToFileURL("/fixture/job-history-store.js")); await new JobHistoryStore("/history").beginDomainJob({ id: process.argv[1], type: "fixture", projectId: "backup-fixture" });' \
    "$job_id" >/dev/null
}
write_backend_history backend-history-one
backend_history_fingerprint=$(podman run --rm --network none --read-only --cap-drop all --security-opt no-new-privileges \
  --user 1000:1000 --entrypoint /bin/bash -v codexia-history:/history:ro "$backup_db_image" -euo pipefail -c \
  'cd /history; find . -type f -print0 | LC_ALL=C sort -z | xargs -0 -r sha256sum' | sha256sum | cut -d' ' -f1)
write_backend_history backend-history-two
changed_history_fingerprint=$(podman run --rm --network none --read-only --cap-drop all --security-opt no-new-privileges \
  --user 1000:1000 --entrypoint /bin/bash -v codexia-history:/history:ro "$backup_db_image" -euo pipefail -c \
  'cd /history; find . -type f -print0 | LC_ALL=C sort -z | xargs -0 -r sha256sum' | sha256sum | cut -d' ' -f1)
test "$backend_history_fingerprint" != "$changed_history_fingerprint"

# Fencing and lock failures happen before any artifact is published.
if CODEXIA_UPDATER_LOCK_DIRECTORY="$state_dir" node "$repo_root/deploy/updater/standalone-updater.mjs" backup "$tmp/config.json" "$remote" "$recipient" > "$tmp/unapproved.log" 2>&1; then
  echo 'Backup controller accepted a missing explicit approval' >&2
  exit 1
fi
grep -q 'Backup requires the explicit --approved maintenance attestation' "$tmp/unapproved.log"

printf 'blue\n' > "$state_dir/route"
if run_locked_backup "$remote" "$recipient" > "$tmp/wrong-route.log" 2>&1; then
  echo 'Backup accepted a route that was not blocked' >&2
  exit 1
fi
grep -q 'Block the proxy before backup' "$tmp/wrong-route.log"
printf 'blocked\n' > "$state_dir/route"
mkdir "$tmp/not-remote"
if PATH="${PATH#"$shim:"}" run_locked_backup "$tmp/not-remote" "$recipient" > "$tmp/not-remote.log" 2>&1; then
  echo 'Backup accepted a local filesystem destination' >&2
  exit 1
fi
grep -q 'Destination is not an approved remote filesystem' "$tmp/not-remote.log"

api_fixture_created=true
podman run --detach --name codexia-api --network none --entrypoint /bin/sh \
  "$live_db_image" -ec 'sleep 300' >/dev/null
if run_locked_backup "$remote" "$recipient" > "$tmp/live-writer.log" 2>&1; then
  echo 'Backup accepted a running API writer' >&2
  exit 1
fi
grep -q 'Writer/preflight still running: codexia-api' "$tmp/live-writer.log"
podman rm -f codexia-api >/dev/null
api_fixture_created=false

# Backend files are private to UID 1000. A differently owned private child
# must make backup fail closed instead of publishing a fingerprint with an
# omitted subtree.
podman run --rm --network none --read-only --cap-drop all --security-opt no-new-privileges \
  --user 1000:1000 --entrypoint node --volume codexia-history:/history \
  "$backend_node_image" --input-type=module -e \
  'import { chmod } from "node:fs/promises"; await chmod("/history", 0o711); await chmod("/history/jobs", 0o713);'
podman run --rm --network none --read-only --cap-drop all --security-opt no-new-privileges \
  --user 1001:1001 --entrypoint node --volume codexia-history:/history \
  "$backend_node_image" --input-type=module -e \
  'import { mkdir } from "node:fs/promises"; await mkdir("/history/jobs/private-child", { mode: 0o700 });'
podman run --rm --network none --read-only --cap-drop all --security-opt no-new-privileges \
  --user 1000:1000 --entrypoint node --volume codexia-history:/history \
  "$backend_node_image" --input-type=module -e \
  'import { chmod } from "node:fs/promises"; await chmod("/history", 0o700); await chmod("/history/jobs", 0o700);'
if run_locked_backup "$remote" "$recipient" > "$tmp/unreadable-history.log" 2>&1; then
  echo 'Backup accepted history with an unenumerable private child' >&2
  exit 1
fi
grep -Eqi 'permission denied|operation not permitted' "$tmp/unreadable-history.log"
podman run --rm --network none --read-only --cap-drop all --security-opt no-new-privileges \
  --user 1000:1000 --entrypoint node --volume codexia-history:/history \
  "$backend_node_image" --input-type=module -e \
  'import { chmod } from "node:fs/promises"; await chmod("/history", 0o711); await chmod("/history/jobs", 0o713);'
podman run --rm --network none --read-only --cap-drop all --security-opt no-new-privileges \
  --user 1001:1001 --entrypoint node --volume codexia-history:/history \
  "$backend_node_image" --input-type=module -e \
  'import { rm } from "node:fs/promises"; await rm("/history/jobs/private-child", { recursive: true });'
podman run --rm --network none --read-only --cap-drop all --security-opt no-new-privileges \
  --user 1000:1000 --entrypoint node --volume codexia-history:/history \
  "$backend_node_image" --input-type=module -e \
  'import { chmod } from "node:fs/promises"; await chmod("/history", 0o700); await chmod("/history/jobs", 0o700);'
podman run --rm --network none --read-only --cap-drop all --security-opt no-new-privileges \
  --user 1000:1000 --entrypoint node --volume codexia-history:/history \
  "$backend_node_image" --input-type=module -e \
  'import { chmod } from "node:fs/promises"; await chmod("/history", 0o711); await chmod("/history/jobs", 0o713);'
podman run --rm --network none --read-only --cap-drop all --security-opt no-new-privileges \
  --user 1001:1001 --entrypoint node --volume codexia-history:/history \
  "$backend_node_image" --input-type=module -e \
  'import { chmod, mkdir, writeFile } from "node:fs/promises"; await mkdir("/history/jobs/private-files", { mode: 0o700 }); await writeFile("/history/jobs/private-files/unreadable.txt", "private", { mode: 0o600 }); await chmod("/history/jobs/private-files", 0o715);'
podman run --rm --network none --read-only --cap-drop all --security-opt no-new-privileges \
  --user 1000:1000 --entrypoint node --volume codexia-history:/history \
  "$backend_node_image" --input-type=module -e \
  'import { chmod } from "node:fs/promises"; await chmod("/history/jobs", 0o700);'
if run_locked_backup "$remote" "$recipient" > "$tmp/unreadable-file.log" 2>&1; then
  echo 'Backup accepted a private history file it could not read' >&2
  exit 1
fi
grep -Eqi 'permission denied|operation not permitted' "$tmp/unreadable-file.log"
podman run --rm --network none --read-only --cap-drop all --security-opt no-new-privileges \
  --user 1000:1000 --entrypoint node --volume codexia-history:/history \
  "$backend_node_image" --input-type=module -e \
  'import { chmod } from "node:fs/promises"; await chmod("/history/jobs", 0o713);'
podman run --rm --network none --read-only --cap-drop all --security-opt no-new-privileges \
  --user 1001:1001 --entrypoint node --volume codexia-history:/history \
  "$backend_node_image" --input-type=module -e \
  'import { rm } from "node:fs/promises"; await rm("/history/jobs/private-files", { recursive: true });'
podman run --rm --network none --read-only --cap-drop all --security-opt no-new-privileges \
  --user 1000:1000 --entrypoint node --volume codexia-history:/history \
  "$backend_node_image" --input-type=module -e \
  'import { chmod } from "node:fs/promises"; await chmod("/history", 0o700); await chmod("/history/jobs", 0o700);'

(
  exec 9> "$state_dir/host.lock"
  flock --exclusive --nonblock 9
  if sh "$repo_root/deploy/updater/codexia-updater" backup "$tmp/config.json" "$remote" "$recipient" --approved > "$tmp/lock-contention.log" 2>&1; then
    echo 'Updater wrapper ignored the controller lock' >&2
    exit 1
  fi
)

if CODEXIA_UPDATER_LOCK_HELD=1 CODEXIA_UPDATER_LOCK_DIRECTORY="$state_dir" \
  bash "$backup_script" backup-locked "$remote" "$recipient" > "$tmp/unlocked-internal.log" 2>&1; then
  echo 'Internal backup mode accepted an absent controller lock' >&2
  exit 1
fi
grep -q 'Controller lock descriptor was not inherited from the updater' "$tmp/unlocked-internal.log"

run_locked_backup "$remote" "$recipient" > "$tmp/backup.log"
artifact=$(sed -n 's/^Encrypted backup committed: //p' "$tmp/backup.log")
test -n "$artifact"
test -f "$artifact/database.dump.age"
test -f "$artifact/history.tar.age"
test -f "$artifact/manifest.age"
(cd "$artifact" && sha256sum --check SHA256SUMS)
if grep -aFq 'encrypted-fixture-row' "$artifact"/*.age || grep -aFq 'auth-recovery-fixture-row' "$artifact"/*.age; then
  echo 'Database fixture plaintext appeared in encrypted backup artifacts' >&2
  exit 1
fi

assert_no_drill_resources() {
  local containers volumes
  containers=$(podman ps --all --format '{{.Names}}')
  volumes=$(podman volume ls --format '{{.Name}}')
  if grep -q '^codexia-restore-drill-' <<< "$containers"; then
    echo 'Restore drill left a scratch container behind' >&2
    grep '^codexia-restore-drill-' <<< "$containers" >&2
    exit 1
  fi
  if grep -q '^codexia-restore-drill-' <<< "$volumes"; then
    echo 'Restore drill left a scratch volume behind' >&2
    grep '^codexia-restore-drill-' <<< "$volumes" >&2
    exit 1
  fi
}

chmod 0644 "$tmp/age-identity"
if bash "$backup_script" drill "$artifact" "$tmp/age-identity" --approved > "$tmp/unsafe-identity.log" 2>&1; then
  echo 'Restore drill accepted an unprotected recovery identity' >&2
  exit 1
fi
grep -q 'Recovery identity must be mode 0400 or 0600' "$tmp/unsafe-identity.log"
chmod 0600 "$tmp/age-identity"

# The controller can invoke backup-locked while its wrapper owns the same lock.
(
  exec 9> "$state_dir/host.lock"
  flock --exclusive --nonblock 9
  CODEXIA_UPDATER_LOCK_HELD=1 CODEXIA_UPDATER_LOCK_DIRECTORY="$state_dir" CODEXIA_UPDATER_LOCK_FD=9 \
    bash "$backup_script" backup-locked "$remote" "$recipient" > "$tmp/backup-locked.log"
)
grep -q '^Encrypted backup committed:' "$tmp/backup-locked.log"

cp -a "$artifact" "$tmp/tampered"
printf 'tamper' >> "$tmp/tampered/database.dump.age"
if bash "$backup_script" drill "$tmp/tampered" "$tmp/age-identity" --approved > "$tmp/tampered.log" 2>&1; then
  echo 'Restore drill accepted a tampered encrypted artifact' >&2
  exit 1
fi
assert_no_drill_resources

# A valid age ciphertext containing an invalid dump reaches restore and still
# cleans every uniquely labeled scratch resource on failure.
cp -a "$artifact" "$tmp/invalid-dump"
python3 -c 'import os,sys; os.unlink(sys.argv[1])' "$tmp/invalid-dump/database.dump.age"
printf 'not a PostgreSQL dump\n' | age -r "$recipient" -o "$tmp/invalid-dump/database.dump.age"
(cd "$tmp/invalid-dump" && sha256sum database.dump.age history.tar.age manifest.age > SHA256SUMS)
if bash "$backup_script" drill "$tmp/invalid-dump" "$tmp/age-identity" --approved > "$tmp/invalid-dump.log" 2>&1; then
  echo 'Restore drill accepted a valid ciphertext containing an invalid database dump' >&2
  exit 1
fi
assert_no_drill_resources

bash "$backup_script" drill "$artifact" "$tmp/age-identity" --approved > "$tmp/drill.log"
grep -q 'Isolated restore verified: database and history fingerprints match' "$tmp/drill.log"
manifest_hash="$(sha256sum "$artifact/SHA256SUMS" | cut -d' ' -f1)"
grep -Fxq "Verified checksum manifest sha256: $manifest_hash" "$tmp/drill.log"
test "$(bash "$backup_script" validate-artifact "$artifact")" = "$manifest_hash"

# A v1 receipt deliberately remains a public-only fingerprint, even when the
# archive contains codexia_auth tables, matching the pre-v2 receipt contract.
legacy_db_hash=$(podman exec -i codexia-db sh -ec '
  export PGPASSWORD="$(cat /run/secrets/admin-password)"
  exec psql -X -qAt -v ON_ERROR_STOP=1 -U "$1" -d codexia
' sh codexia_admin <<'SQL' | sha256sum | cut -d' ' -f1
SET TIME ZONE 'UTC';
SET DateStyle TO ISO, YMD;
SELECT format('SELECT %L; SELECT to_jsonb(t)::text FROM %I.%I t ORDER BY to_jsonb(t)::text COLLATE "C";', n.nspname || '.' || c.relname, n.nspname, c.relname)
FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE n.nspname='public' AND c.relkind IN ('r','p')
ORDER BY n.nspname, c.relname
\gexec
SQL
)
legacy_history_hash=$(age -d -i "$tmp/age-identity" "$artifact/manifest.age" | sed -n '3p')
[[ "$legacy_db_hash" =~ ^[0-9a-f]{64}$ && "$legacy_history_hash" =~ ^[0-9a-f]{64}$ ]]
legacy_v1_artifact="$remote/legacy-v1"
mkdir "$legacy_v1_artifact"
cp "$artifact/database.dump.age" "$legacy_v1_artifact/database.dump.age"
cp "$artifact/history.tar.age" "$legacy_v1_artifact/history.tar.age"
printf 'codexia-backup/v1\n%s\n%s\n' "$legacy_db_hash" "$legacy_history_hash" |
  age -r "$recipient" -o "$legacy_v1_artifact/manifest.age"
(cd "$legacy_v1_artifact" && sha256sum database.dump.age history.tar.age manifest.age > SHA256SUMS)
bash "$backup_script" drill "$legacy_v1_artifact" "$tmp/age-identity" --approved > "$tmp/legacy-v1.log"
grep -q 'Isolated restore verified: database and history fingerprints match' "$tmp/legacy-v1.log"
assert_no_drill_resources

# A validly re-encrypted dump without codexia_auth must not pass verification
# when the source backup also contained Better Auth schema state.
auth_schema_omitted_artifact="$remote/auth-schema-omitted"
mkdir "$auth_schema_omitted_artifact"
podman exec codexia-db sh -ec 'export PGPASSWORD="$(cat /run/secrets/admin-password)"; exec pg_dump -U codexia_admin -d codexia -Fc --exclude-schema=codexia_auth' |
  age -r "$recipient" -o "$auth_schema_omitted_artifact/database.dump.age"
cp "$artifact/history.tar.age" "$auth_schema_omitted_artifact/history.tar.age"
cp "$artifact/manifest.age" "$auth_schema_omitted_artifact/manifest.age"
(cd "$auth_schema_omitted_artifact" && sha256sum database.dump.age history.tar.age manifest.age > SHA256SUMS)
if bash "$backup_script" drill "$auth_schema_omitted_artifact" "$tmp/age-identity" --approved > "$tmp/auth-schema-omitted.log" 2>&1; then
  echo 'Restore drill accepted a backup with omitted codexia_auth state' >&2
  exit 1
fi
if ! grep -q 'Restored database logical fingerprint mismatch' "$tmp/auth-schema-omitted.log"; then
  cat "$tmp/auth-schema-omitted.log" >&2
  exit 1
fi
assert_no_drill_resources

if bash "$backup_script" validate-artifact "$tmp/tampered" > "$tmp/tampered-identity.log" 2>&1; then
  echo 'Artifact evidence accepted tampered ciphertext' >&2; exit 1
fi
assert_no_drill_resources

# A scratch-container removal failure must fail the drill and withhold success;
# the EXIT cleanup gets a second chance and must remove the uniquely owned object.
real_podman=$(command -v podman)
cat > "$shim/podman" <<'SH'
#!/usr/bin/env bash
if [[ "${CODEXIA_FAIL_DRILL_REMOVE:-}" == true && "${1:-}" == rm && "${2:-}" == -f && "${3:-}" == codexia-restore-drill-* && ! -e "${CODEXIA_FAIL_DRILL_REMOVE_MARKER:?}" ]]; then
  : > "$CODEXIA_FAIL_DRILL_REMOVE_MARKER"
  exit 1
fi
exec "${CODEXIA_REAL_PODMAN:?}" "$@"
SH
chmod 0700 "$shim/podman"
if CODEXIA_REAL_PODMAN="$real_podman" CODEXIA_FAIL_DRILL_REMOVE=true CODEXIA_FAIL_DRILL_REMOVE_MARKER="$tmp/fail-drill-remove-once" \
  bash "$backup_script" drill "$artifact" "$tmp/age-identity" --approved > "$tmp/cleanup-failure.log" 2>&1; then
  echo 'Restore drill reported success after scratch cleanup failed' >&2
  exit 1
fi
test -f "$tmp/fail-drill-remove-once"
grep -q 'Restore drill cleanup failed: isolated database container removal failed' "$tmp/cleanup-failure.log"
if grep -Eq 'Isolated restore verified:|Verified checksum manifest sha256:' "$tmp/cleanup-failure.log"; then
  echo 'Restore drill printed success before cleanup completed' >&2
  exit 1
fi
assert_no_drill_resources

assert_logs_do_not_contain(){
  local needle="$1" marker="$2" logfile
  for logfile in "$tmp"/*.log; do
    if grep -Fq -- "$needle" "$logfile"; then
      printf 'Backup tool log %s contains a %s marker\n' "${logfile##*/}" "$marker" >&2
      exit 1
    fi
  done
}
assert_logs_do_not_contain "$recipient" 'age recipient'
assert_logs_do_not_contain 'encrypted-fixture-row' 'database fixture row'
assert_logs_do_not_contain 'encrypted fixture history' 'history fixture content'
printf '%s\n' 'Verified encrypted PostgreSQL/history backup, artifact integrity, lock and writer checks, isolated restore, and scratch cleanup.'
