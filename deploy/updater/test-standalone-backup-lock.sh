#!/usr/bin/env bash
# Proves that the backup helper needs the controller's inherited lock FD, not
# merely a lock held by an unrelated process.
set -euo pipefail
test "${CODEXIA_DISPOSABLE_BACKUP_TEST:-}" = true
test "$(id -u)" != 0

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
backup_script="$repo_root/deploy/updater/standalone-backup.sh"
tmp=$(mktemp -d "${TMPDIR:-/tmp}/codexia-backup-lock-test.XXXXXX")
holder_pid=
cleanup(){
  if [[ -n "$holder_pid" ]]; then kill "$holder_pid" 2>/dev/null || true; wait "$holder_pid" 2>/dev/null || true; fi
  python3 -c 'import shutil,sys; shutil.rmtree(sys.argv[1],ignore_errors=True)' "$tmp"
}
trap cleanup EXIT

state_home="$tmp/state"
state_dir="$state_home/codexia-updater"
remote="$tmp/remote"
shim="$tmp/bin"
mkdir -p "$state_dir" "$remote" "$shim"
printf 'blocked\n' > "$state_dir/route"
printf '#!/bin/sh\nexit 1\n' > "$shim/podman"
printf '#!/bin/sh\nexit 1\n' > "$shim/age"
cat > "$shim/findmnt" <<'SH'
#!/bin/sh
if [ "${1:-}" = -T ] && [ "${2:-}" = "${CODEXIA_TEST_REMOTE:-}" ] && [ "${3:-}" = -n ] && [ "${4:-}" = -o ]; then
  case "${5:-}" in
    FSTYPE) printf '%s\n' nfs4 ;;
    SOURCE) printf '%s\n' "${CODEXIA_TEST_REMOTE_SOURCE:-backup.example.invalid:/export}" ;;
    *) exit 2 ;;
  esac
else
  printf '%s\n' ext4
fi
SH
cat > "$shim/getent" <<'SH'
#!/bin/sh
[ "${1:-}" = ahosts ] || exit 2
case "${2:-}" in
  localhost) printf '%s\n' '127.0.0.1 STREAM localhost' ;;
  backup.example.invalid) printf '%s\n' "${CODEXIA_TEST_REMOTE_ADDRESS:-192.0.2.10} STREAM backup.example.invalid" ;;
  *) exit 2 ;;
esac
SH
cat > "$shim/ip" <<'SH'
#!/bin/sh
[ "${1:-}" = -o ] && [ "${2:-}" = address ] && [ "${3:-}" = show ] || exit 2
printf '%s\n' '1: lo inet 127.0.0.1/8 scope host lo' '1: lo inet6 ::1/128 scope host lo'
SH
chmod 0700 "$shim/podman" "$shim/age" "$shim/findmnt" "$shim/getent" "$shim/ip"
export PATH="$shim:$PATH"
export XDG_STATE_HOME="$state_home"
export CODEXIA_TEST_REMOTE="$remote"
exec 9>&-

mkdir "$tmp/local"
if bash "$backup_script" validate-destination "$tmp/local" > "$tmp/local-destination.log" 2>&1; then
  echo 'Destination preflight accepted a local filesystem' >&2
  exit 1
fi
grep -q 'Destination is not an approved remote filesystem' "$tmp/local-destination.log"
bash "$backup_script" validate-destination "$remote" > "$tmp/remote-destination.log"
grep -q 'Backup destination preflight passed' "$tmp/remote-destination.log"
if CODEXIA_TEST_REMOTE_SOURCE='localhost:/export' bash "$backup_script" validate-destination "$remote" > "$tmp/loopback-destination.log" 2>&1; then
  echo 'Destination preflight accepted an NFS export from the same VM' >&2
  exit 1
fi
grep -q 'Backup destination is mounted from this VM' "$tmp/loopback-destination.log"
if CODEXIA_TEST_REMOTE_ADDRESS=127.0.0.1 bash "$backup_script" validate-destination "$remote" > "$tmp/local-address-destination.log" 2>&1; then
  echo 'Destination preflight accepted a remote name resolving to this VM' >&2
  exit 1
fi
grep -q 'Backup destination resolves to this VM' "$tmp/local-address-destination.log"

# Hold the canonical lock in a sibling process. A caller with only the legacy
# boolean marker must not treat that unrelated lock holder as its capability.
(
  exec 9> "$state_dir/host.lock"
  flock --exclusive --nonblock 9
  touch "$tmp/other-process-holds-lock"
  sleep 120
) &
holder_pid=$!
for attempt in $(seq 1 50); do
  [[ -f "$tmp/other-process-holds-lock" ]] && break
  sleep 0.1
done
test -f "$tmp/other-process-holds-lock"

if CODEXIA_UPDATER_LOCK_HELD=1 CODEXIA_UPDATER_LOCK_DIRECTORY="$state_dir" CODEXIA_UPDATER_LOCK_FD=9 \
  bash "$backup_script" backup-locked "$remote" age1fixture 9>&- > "$tmp/direct.log" 2>&1; then
  echo 'Direct helper invocation accepted another process lock as its own' >&2
  exit 1
fi
if ! grep -q 'Controller lock descriptor was not inherited from the updater' "$tmp/direct.log"; then
  cat "$tmp/direct.log" >&2
  exit 1
fi
kill "$holder_pid"
wait "$holder_pid" 2>/dev/null || true
holder_pid=

# The controller adapter's child launch passes descriptor 9 through Node to
# the shell helper. Fake Podman stops the test after this handoff is accepted.
(
  exec 9> "$state_dir/host.lock"
  flock --exclusive --nonblock 9
  CODEXIA_UPDATER_LOCK_DIRECTORY="$state_dir" CODEXIA_UPDATER_LOCK_FD=9 \
    node --input-type=module -e '
      import assert from "node:assert/strict";
      import { PodmanStandaloneHost } from "./deploy/updater/standalone-host.mjs";
      const host = Object.create(PodmanStandaloneHost.prototype);
      await assert.rejects(host.backup(process.argv[1], "age1fixture"), /History volume absent/);
    ' "$remote"
)

printf '%s\n' 'Verified a non-controller helper cannot borrow another process lock and a controller child can inherit its own lock FD.'
