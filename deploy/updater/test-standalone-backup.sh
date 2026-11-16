#!/usr/bin/env bash
# Real disposable Podman/PostgreSQL/age exercise. The findmnt shim only models an
# approved remote mount; this test is not off-VM backup or recovery evidence.
set -euo pipefail
test "${CODEXIA_DISPOSABLE_BACKUP_TEST:-}" = true
test "$(id -un)" = codexia-phase-e-test
test "$(id -u)" != 0
test "$(podman info --format '{{.Host.Security.Rootless}}')" = true

for command in podman age age-keygen flock findmnt sha256sum sync stat; do
  command -v "$command" >/dev/null
done

repo_root=$(pwd)
backup_script="$repo_root/deploy/updater/standalone-backup.sh"
live_db_image=$(sed -n 's/^Image=//p' "$repo_root/deploy/quadlet/codexia-db.container")
backup_db_image=$(sed -n "s/^readonly PG_IMAGE='\(.*\)'$/\1/p" "$backup_script")
test -n "$live_db_image"
test "$backup_db_image" = "$live_db_image"

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
if [[ "${1:-}" == -T && "${2:-}" == "${CODEXIA_TEST_REMOTE:-}"* && "${3:-}" == -n && "${4:-}" == -o && "${5:-}" == FSTYPE ]]; then
  printf '%s\n' nfs4
else
  exec "${CODEXIA_REAL_FINDMNT:?}" "$@"
fi
SH
chmod 0700 "$shim/findmnt"
export PATH="$shim:$PATH"
export XDG_STATE_HOME="$state_home"
export CODEXIA_TEST_REMOTE="$remote"
export CODEXIA_REAL_FINDMNT="$real_findmnt"
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
printf 'fixture-only-admin-password' > "$tmp/admin-password"
chmod 0644 "$tmp/admin-password"
container_created=true
podman run --detach --name codexia-db --network none \
  --volume codexia-backup-test-db:/var/lib/postgresql/data \
  --volume "$tmp/admin-password:/run/secrets/admin-password:ro" \
  --env POSTGRES_DB=codexia --env POSTGRES_USER=codexia_admin \
  --env POSTGRES_HOST_AUTH_METHOD=trust "$live_db_image" >/dev/null
for attempt in $(seq 1 60); do
  if podman exec codexia-db pg_isready -U codexia_admin -d codexia >/dev/null 2>&1; then break; fi
  sleep 1
done
podman exec codexia-db pg_isready -U codexia_admin -d codexia >/dev/null
podman exec codexia-db psql -X -v ON_ERROR_STOP=1 -U codexia_admin -d codexia \
  -c "CREATE TABLE public.backup_probe(id integer PRIMARY KEY, value text NOT NULL); INSERT INTO public.backup_probe VALUES (1, 'encrypted-fixture-row');" >/dev/null
podman run --rm --network none --entrypoint /bin/sh \
  --volume codexia-history:/history "$live_db_image" -ec \
  'mkdir -p /history/fixture && printf "encrypted fixture history\\n" > /history/fixture/history.txt'

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
if grep -aFq 'encrypted-fixture-row' "$artifact"/*.age; then
  echo 'Database fixture plaintext appeared in encrypted backup artifacts' >&2
  exit 1
fi

assert_no_drill_resources() {
  if podman ps --all --format '{{.Names}}' | grep -q '^codexia-restore-drill-'; then
    echo 'Restore drill left a scratch container behind' >&2
    exit 1
  fi
  if podman volume ls --format '{{.Name}}' | grep -q '^codexia-restore-drill-'; then
    echo 'Restore drill left a scratch volume behind' >&2
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
assert_no_drill_resources

for secret in "$recipient" 'encrypted-fixture-row' 'encrypted fixture history'; do
  if grep -Fq "$secret" "$tmp"/*.log; then
    echo 'Backup credential or fixture data appeared in tool output' >&2
    exit 1
  fi
done
printf '%s\n' 'Verified encrypted PostgreSQL/history backup, artifact integrity, lock and writer checks, isolated restore, and scratch cleanup.'
