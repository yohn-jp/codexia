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
mkfifo "$tmp/hold-open"
printf 'blocked\n' > "$state_dir/route"
printf '#!/bin/sh\nexit 1\n' > "$shim/podman"
printf '#!/bin/sh\nexit 1\n' > "$shim/age"
cat > "$shim/findmnt" <<'SH'
#!/bin/sh
if [ "${1:-}" = -T ] && [ "${2:-}" = "${CODEXIA_TEST_REMOTE:-}" ] && [ "${3:-}" = -n ] && [ "${4:-}" = -o ]; then
  case "${5:-}" in
    FSTYPE) printf '%s\n' "${CODEXIA_TEST_REMOTE_TYPE:-nfs4}" ;;
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
  2001:db8::1|2001:db8::2) printf '%s STREAM %s\n' "$2" "$2" ;;
  *) exit 2 ;;
esac
SH
cat > "$shim/ip" <<'SH'
#!/bin/sh
[ "${1:-}" = -o ] && [ "${2:-}" = address ] && [ "${3:-}" = show ] || exit 2
printf '%s\n' '1: lo inet 127.0.0.1/8 scope host lo' '1: lo inet6 ::1/128 scope host lo' '2: eth0 inet6 2001:db8::1/64 scope global'
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

for source in 'backup@[2001:db8::2]:/backups' '[2001:db8::2]:/backups' \
              'backup@backup.example.invalid:/backups' 'backup.example.invalid:/backups'; do
  CODEXIA_TEST_REMOTE_TYPE=fuse.sshfs CODEXIA_TEST_REMOTE_SOURCE="$source" \
    bash "$backup_script" validate-destination "$remote" | grep -q 'Backup destination preflight passed'
done
for source in 'backup@[2001:db8::1]:/backups' '[::1]:/backups' 'backup@[2001:db8::3]:/backups'; do
  if CODEXIA_TEST_REMOTE_TYPE=sshfs CODEXIA_TEST_REMOTE_SOURCE="$source" \
    bash "$backup_script" validate-destination "$remote" > "$tmp/sshfs-destination.log" 2>&1; then
    echo "Destination preflight accepted an unsafe or unresolvable SSHFS source: $source" >&2
    exit 1
  fi
  grep -Eq 'Backup destination (is mounted from|resolves to) this VM|Cannot verify the backup destination host address' "$tmp/sshfs-destination.log"
done

# Hold the canonical lock in a sibling process. A caller with only the legacy
# boolean marker must not treat that unrelated lock holder as its capability.
(
  exec 9> "$state_dir/host.lock"
  flock --exclusive --nonblock 9
  touch "$tmp/other-process-holds-lock"
  exec 8<> "$tmp/hold-open"
  IFS= read -r <&8
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

# A push deployment can use the same backup helper under its own durable host
# lock. The generic interface still requires approval and an inherited FD for
# the exact lock file; a sibling process lock is not accepted as ownership.
push_lock="$tmp/push-maintenance.lock"
touch "$push_lock"
if bash "$backup_script" backup-locked "$remote" age1fixture --approved --lock-file "$push_lock" --lock-fd 9 9>&- > "$tmp/push-no-fd.log" 2>&1; then
  echo 'Push backup accepted a missing inherited lock descriptor' >&2
  exit 1
fi
grep -q 'Maintenance lock descriptor was not inherited' "$tmp/push-no-fd.log"
if bash "$backup_script" backup-locked "$remote" age1fixture --lock-file "$push_lock" --lock-fd 9 > "$tmp/push-no-approval.log" 2>&1; then
  echo 'Push backup accepted missing explicit approval' >&2
  exit 1
fi
other_lock="$tmp/other-maintenance.lock"
touch "$other_lock"
if (
  exec 9> "$other_lock"
  flock --exclusive --nonblock 9
  bash "$backup_script" backup-locked "$remote" age1fixture --approved --lock-file "$push_lock" --lock-fd 9
) > "$tmp/push-wrong-inode.log" 2>&1; then
  echo 'Push backup accepted a descriptor for a different lock file' >&2
  exit 1
fi
grep -q 'Inherited descriptor does not identify the declared maintenance lock' "$tmp/push-wrong-inode.log"

(
  exec 9> "$push_lock"
  flock --exclusive --nonblock 9
  touch "$tmp/push-lock-is-held"
  exec 8<> "$tmp/hold-open"
  IFS= read -r <&8
) &
holder_pid=$!
for attempt in $(seq 1 50); do
  [[ -f "$tmp/push-lock-is-held" ]] && break
  sleep 0.1
done
test -f "$tmp/push-lock-is-held"
if (
  exec 9> "$push_lock"
  bash "$backup_script" backup-locked "$remote" age1fixture --approved --lock-file "$push_lock" --lock-fd 9
) > "$tmp/push-other-holder.log" 2>&1; then
  echo 'Push backup accepted a lock held by another process' >&2
  exit 1
fi
grep -q 'Inherited descriptor does not own the maintenance lock' "$tmp/push-other-holder.log"
kill "$holder_pid"
wait "$holder_pid" 2>/dev/null || true
holder_pid=

# A real lock owner reaches the guarded backup preflight. This fixture stops
# at Podman because it only proves the descriptor contract, not backup data.
(
  exec 9> "$push_lock"
  flock --exclusive --nonblock 9
  if bash "$backup_script" backup-locked "$remote" age1fixture --approved --lock-file "$push_lock" --lock-fd 9 > "$tmp/push-valid-lock.log" 2>&1; then
    echo 'Push backup unexpectedly reached a successful artifact in the lock-only fixture' >&2
    exit 1
  fi
)
grep -q 'History volume absent' "$tmp/push-valid-lock.log"

# The controller adapter's child launch passes descriptor 9 through Node to
# the shell helper. Fake Podman stops the test after this handoff is accepted.
node_state_home="$tmp/node-state"
mkdir -p "$node_state_home/codexia-updater"
printf 'blocked\n' > "$node_state_home/codexia-updater/route"
(
  export XDG_STATE_HOME="$node_state_home"
  exec 9> "$node_state_home/codexia-updater/host.lock"
  flock --exclusive --nonblock 9
  CODEXIA_UPDATER_LOCK_DIRECTORY="$node_state_home/codexia-updater" CODEXIA_UPDATER_LOCK_FD=9 \
    node --input-type=module -e '
      import assert from "node:assert/strict";
      import { PodmanStandaloneHost } from "./deploy/updater/standalone-host.mjs";
      const host = Object.create(PodmanStandaloneHost.prototype);
      await assert.rejects(host.backup(process.argv[1], "age1fixture"), /History volume absent/);
    ' "$remote"
)

printf '%s\n' 'Verified a non-controller helper cannot borrow another process lock and a controller child can inherit its own lock FD.'
