#!/usr/bin/env bash
# Offline encrypted backup and isolated restore verification. Never restores live data.
set -euo pipefail
umask 077
readonly PG_IMAGE='docker.io/library/postgres:17-bookworm@sha256:40865bc877a289da75963d97d72b59633f639fc5af7a4e856bfa3714cae5b536'
readonly STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/codexia-updater"
die(){ printf '%s\n' "$*" >&2; exit 1; }
for cmd in podman age sha256sum flock findmnt sync stat getent ip; do command -v "$cmd" >/dev/null || die "Missing dependency: $cmd"; done
lock_file="$STATE_DIR/host.lock"
operation="${1:-}"
remote_directory(){
  [[ "$1" == /* && -d "$1" && ! -L "$1" ]] || die 'Use an existing absolute off-VM mount directory'
  local fstype mount_source remote_host local_addresses remote_addresses address
  fstype="$(findmnt -T "$1" -n -o FSTYPE)"
  case "$fstype" in nfs|nfs4|cifs|fuse.sshfs|sshfs) ;; *) die 'Destination is not an approved remote filesystem';; esac
  mount_source="$(findmnt -T "$1" -n -o SOURCE)"
  case "$fstype" in
    nfs|nfs4)
      if [[ "$mount_source" == \[*\]:* ]]; then remote_host="${mount_source#\[}"; remote_host="${remote_host%%]*}";
      else remote_host="${mount_source%%:*}"; fi
      ;;
    cifs)
      remote_host="${mount_source#//}"
      if [[ "$remote_host" == \[*\]* ]]; then remote_host="${remote_host#\[}"; remote_host="${remote_host%%]*}";
      else remote_host="${remote_host%%/*}"; fi
      ;;
    fuse.sshfs|sshfs)
      if [[ "$mount_source" =~ ^([^@/:]+@)?\[([^][]+)\]: ]]; then
        remote_host="${BASH_REMATCH[2]}"
      else
        remote_host="${mount_source%%:*}"
        remote_host="${remote_host##*@}"
      fi
      ;;
  esac
  [[ -n "$remote_host" ]] || die 'Cannot verify that the backup destination is off-VM'
  case "${remote_host,,}" in localhost|localhost.*|127.*|::1|0.0.0.0) die 'Backup destination is mounted from this VM';; esac
  local_addresses="$(ip -o address show | awk '{sub(/\/.*/, "", $4); print $4}' | sort -u)"
  remote_addresses="$(getent ahosts "$remote_host" | awk '{print $1}' | sort -u || true)"
  [[ -n "$remote_addresses" ]] || die 'Cannot verify the backup destination host address'
  while IFS= read -r address; do
    [[ -n "$address" ]] || continue
    # getent may return an IPv4-mapped IPv6 address. Compare its IPv4 form.
    case "${address,,}" in ::ffff:*.*) address="${address##*:}";; esac
    case "${address,,}" in 127.*|::1|0.0.0.0|::) die 'Backup destination resolves to this VM';; esac
    if grep -Fxq "$address" <<< "$local_addresses"; then die 'Backup destination resolves to this VM'; fi
  done <<< "$remote_addresses"
}
# Identify the exact ciphertext set without interpreting filenames from the manifest.
validate_artifact(){
  local dir="$1" file
  remote_directory "$dir"
  for file in database.dump.age history.tar.age manifest.age SHA256SUMS; do
    [[ -f "$dir/$file" && ! -L "$dir/$file" ]] || die 'Backup artifact contains a missing or unsafe file'
  done
  (cd "$dir" && sha256sum database.dump.age history.tar.age manifest.age | cmp - SHA256SUMS) || die 'Backup ciphertext checksum mismatch'
  sha256sum "$dir/SHA256SUMS" | cut -d' ' -f1
}
case "$operation" in
  backup-locked)
    mkdir -p "$STATE_DIR"
    [[ "${CODEXIA_UPDATER_LOCK_HELD:-}" == 1 && "${CODEXIA_UPDATER_LOCK_DIRECTORY:-}" == "$STATE_DIR" ]] || die 'Internal backup requires the canonical controller lock'
    lock_fd="${CODEXIA_UPDATER_LOCK_FD:-}"
    [[ "$lock_fd" =~ ^[0-9]+$ && -e "/proc/self/fd/$lock_fd" ]] || die 'Controller lock descriptor was not inherited from the updater'
    fd_identity="$(stat -Lc '%d:%i' -- "/proc/self/fd/$lock_fd" 2>/dev/null || true)"
    lock_identity="$(stat -Lc '%d:%i' -- "$lock_file" 2>/dev/null || true)"
    [[ -n "$fd_identity" && "$fd_identity" == "$lock_identity" ]] || die 'Inherited descriptor does not identify the canonical controller lock'
    flock --exclusive --nonblock "$lock_fd" || die 'Inherited descriptor does not hold the updater lock'
    ;;
  drill)
    mkdir -p "$STATE_DIR"
    exec 9>"$lock_file"
    flock --exclusive --nonblock 9 || die 'Updater or backup already running'
    ;;
  validate-artifact)
    [[ $# == 2 ]] || die 'Usage: validate-artifact /absolute/remote/backup'
    validate_artifact "$2"
    exit 0
    ;;
  validate-destination)
    [[ $# == 2 ]] || die 'Usage: validate-destination /absolute/remote/mount'
    remote_directory "$2"
    printf '%s\n' 'Backup destination preflight passed'
    exit 0
    ;;
  *) die 'Use the controller backup command or the explicitly approved drill';;
esac

# Hash complete canonical public-table contents, including the migration ledger,
# revision history, Knowledge, Evidence and approval state. Explicit table/row
# order and UTC ensure a restored database has the same logical representation.
db_fingerprint(){
  local container="$1" user="$2"
  podman exec -i "$container" sh -ec '
    if [ -r /run/secrets/admin-password ]; then export PGPASSWORD="$(cat /run/secrets/admin-password)"; fi
    exec psql -X -qAt -v ON_ERROR_STOP=1 -U "$1" -d codexia
  ' sh "$user" <<'SQL' | sha256sum | cut -d' ' -f1
SET TIME ZONE 'UTC';
SET DateStyle TO ISO, YMD;
SELECT format('SELECT %L; SELECT to_jsonb(t)::text FROM %I.%I t ORDER BY to_jsonb(t)::text COLLATE "C";', n.nspname || '.' || c.relname, n.nspname, c.relname)
FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE n.nspname='public' AND c.relkind IN ('r','p')
ORDER BY n.nspname, c.relname
\gexec
SQL
}
history_fingerprint(){
  local volume="$1"
  podman run --rm --network none --read-only --cap-drop all --security-opt no-new-privileges --entrypoint /bin/sh     -v "$volume:/history:ro" "$PG_IMAGE" -ec 'cd /history; find . -type f -print0 | LC_ALL=C sort -z | xargs -0 -r sha256sum' | sha256sum | cut -d' ' -f1
}
require_quiesced(){
  [[ "$(cat "$STATE_DIR/route")" == blocked ]] || die 'Block the proxy before backup'
  for container in codexia-api codexia-slot-blue codexia-slot-green codexia-preflight-blue codexia-preflight-green; do
    local status=0
    podman container exists "$container" || status=$?
    case "$status" in
      0) [[ "$(podman inspect --format '{{.State.Running}}' "$container")" == false ]] || die "Writer/preflight still running: $container";;
      1) ;;
      *) die "Cannot inspect $container";;
    esac
  done
}
backup_artifact(){
  local destination="$1" recipient="$2"
  require_quiesced
  podman volume exists codexia-history || die 'History volume absent'
  local stamp staging final db_hash history_hash artifact_hash
  stamp="$(date -u +%Y%m%dT%H%M%SZ)-$(cat /proc/sys/kernel/random/uuid)"
  staging="$destination/.codexia-$stamp.partial"; final="$destination/codexia-$stamp"
  mkdir "$staging"
  trap 'rm -rf -- "$staging"' EXIT
  db_hash="$(db_fingerprint codexia-db codexia_admin)"
  history_hash="$(history_fingerprint codexia-history)"
  podman exec codexia-db sh -ec 'export PGPASSWORD="$(cat /run/secrets/admin-password)"; exec pg_dump -U codexia_admin -d codexia -Fc' |
    age -r "$recipient" -o "$staging/database.dump.age"
  podman volume export codexia-history | age -r "$recipient" -o "$staging/history.tar.age"
  # Recheck the stopped state and both logical fingerprints before publication.
  require_quiesced
  [[ "$(db_fingerprint codexia-db codexia_admin)" == "$db_hash" ]] || die 'Database changed during backup'
  [[ "$(history_fingerprint codexia-history)" == "$history_hash" ]] || die 'History changed during backup'
  printf 'codexia-backup/v1\n%s\n%s\n' "$db_hash" "$history_hash" | age -r "$recipient" -o "$staging/manifest.age"
  (cd "$staging"; sha256sum database.dump.age history.tar.age manifest.age > SHA256SUMS)
  artifact_hash="$(sha256sum "$staging/SHA256SUMS" | cut -d' ' -f1)"
  sync -f "$staging"
  [[ ! -e "$final" ]] || die 'Backup already exists'
  mv -T -- "$staging" "$final"
  sync -f "$destination"
  trap - EXIT
  printf 'Encrypted backup committed: %s\nPublished checksum manifest sha256: %s\n' "$final" "$artifact_hash"
}
assert_restore_resource_absent(){
  local kind="$1" resource="$2" status=0
  podman "$kind" exists "$resource" || status=$?
  [[ "$status" == 1 ]] || die 'Isolated restore resource name is already in use or cannot be inspected'
}
case "${1:-}" in
  backup-locked)
    [[ $# == 3 ]] || die 'Usage: backup-locked /remote/mount age1-recipient'
    remote_directory "$2"
    [[ "$3" =~ ^age1[0-9a-z]+$ ]] || die 'Provide an age public recipient, not a private key'
    backup_artifact "$2" "$3"
    ;;
  drill)
    [[ $# == 4 && "$4" == --approved && "$2" == /* && -d "$2" && ! -L "$2" && "$3" == /* && -f "$3" && ! -L "$3" && -r "$3" ]] || die 'Usage: drill /absolute/remote/backup/directory /absolute/private/age-identity --approved'
    remote_directory "$2"
    identity_mode="$(stat -Lc '%a' -- "$3")"
    identity_owner="$(stat -Lc '%u' -- "$3")"
    [[ "$identity_mode" == 400 || "$identity_mode" == 600 ]] || die 'Recovery identity must be mode 0400 or 0600'
    [[ "$identity_owner" == "$(id -u)" ]] || die 'Recovery identity must be owned by the current recovery user'
    dir="$(realpath -- "$2")"
    # Validate fixed ciphertext names, never execute filenames from the checksum file.
    artifact_hash="$(validate_artifact "$dir")"
    manifest="$(age -d -i "$3" "$dir/manifest.age")"
    mapfile -t fields <<< "$manifest"
    [[ "${#fields[@]}" == 3 && "${fields[0]}" == codexia-backup/v1 && "${fields[1]}" =~ ^[0-9a-f]{64}$ && "${fields[2]}" =~ ^[0-9a-f]{64}$ ]] || die 'Invalid decrypted backup manifest'
    suffix="$(cat /proc/sys/kernel/random/uuid)"
    db="codexia-restore-drill-$suffix"; data="$db-data"; history="$db-history"
    label="io.codexia.restore-drill"
    db_created=false; data_created=false; history_created=false
    cleanup_restore_resources(){
      local failed=0 status actual_label resource created
      if [[ "$db_created" == true ]]; then
        status=0; podman container exists "$db" >/dev/null 2>&1 || status=$?
        if [[ "$status" == 0 ]]; then
          if ! actual_label="$(podman inspect --format "{{index .Config.Labels \"$label\"}}" "$db" 2>/dev/null)"; then
            printf '%s\n' 'Restore drill cleanup failed: could not inspect isolated database container ownership' >&2; failed=1
          elif [[ "$actual_label" != "$suffix" ]]; then
            printf '%s\n' 'Restore drill cleanup failed: isolated database container ownership changed' >&2; failed=1
          elif ! podman rm -f "$db" >/dev/null 2>&1; then
            printf '%s\n' 'Restore drill cleanup failed: isolated database container removal failed' >&2; failed=1
          fi
        elif [[ "$status" != 1 ]]; then
          printf '%s\n' 'Restore drill cleanup failed: isolated database container state is unobservable' >&2; failed=1
        fi
        status=0; podman container exists "$db" >/dev/null 2>&1 || status=$?
        if [[ "$status" == 0 ]]; then
          printf '%s\n' 'Restore drill cleanup failed: isolated database container remains' >&2; failed=1
        elif [[ "$status" != 1 ]]; then
          printf '%s\n' 'Restore drill cleanup failed: isolated database container absence is unobservable' >&2; failed=1
        fi
      fi
      for resource in "$data" "$history"; do
        case "$resource" in "$data") created="$data_created";; "$history") created="$history_created";; esac
        [[ "$created" == true ]] || continue
        status=0; podman volume exists "$resource" >/dev/null 2>&1 || status=$?
        if [[ "$status" == 0 ]]; then
          if ! actual_label="$(podman volume inspect --format "{{index .Labels \"$label\"}}" "$resource" 2>/dev/null)"; then
            printf '%s\n' 'Restore drill cleanup failed: could not inspect isolated volume ownership' >&2; failed=1
          elif [[ "$actual_label" != "$suffix" ]]; then
            printf '%s\n' 'Restore drill cleanup failed: isolated volume ownership changed' >&2; failed=1
          elif ! podman volume rm "$resource" >/dev/null 2>&1; then
            printf '%s\n' 'Restore drill cleanup failed: isolated volume removal failed' >&2; failed=1
          fi
        elif [[ "$status" != 1 ]]; then
          printf '%s\n' 'Restore drill cleanup failed: isolated volume state is unobservable' >&2; failed=1
        fi
        status=0; podman volume exists "$resource" >/dev/null 2>&1 || status=$?
        if [[ "$status" == 0 ]]; then
          printf '%s\n' 'Restore drill cleanup failed: isolated volume remains' >&2; failed=1
        elif [[ "$status" != 1 ]]; then
          printf '%s\n' 'Restore drill cleanup failed: isolated volume absence is unobservable' >&2; failed=1
        fi
      done
      return "$failed"
    }
    finish_restore_drill(){
      local status=$?
      trap - EXIT
      set +e
      cleanup_restore_resources || status=1
      exit "$status"
    }
    trap finish_restore_drill EXIT
    assert_restore_resource_absent container "$db"
    assert_restore_resource_absent volume "$data"
    assert_restore_resource_absent volume "$history"
    data_created=true
    podman volume create --label "$label=$suffix" "$data" >/dev/null
    [[ "$(podman volume inspect --format "{{index .Labels \"$label\"}}" "$data")" == "$suffix" ]] || die 'Could not verify isolated restore data volume'
    history_created=true
    podman volume create --label "$label=$suffix" "$history" >/dev/null
    [[ "$(podman volume inspect --format "{{index .Labels \"$label\"}}" "$history")" == "$suffix" ]] || die 'Could not verify isolated restore history volume'
    db_created=true
    podman run -d --name "$db" --label "$label=$suffix" --network none --security-opt no-new-privileges \
      -e POSTGRES_DB=codexia -e POSTGRES_HOST_AUTH_METHOD=trust -v "$data:/var/lib/postgresql/data" "$PG_IMAGE" >/dev/null
    [[ "$(podman inspect --format "{{index .Config.Labels \"$label\"}}" "$db")" == "$suffix" ]] || die 'Could not verify isolated restore container'
    # The official image starts a temporary Unix-socket-only server during
    # initdb. Socket pg_isready can succeed just before that server shuts
    # down. A real query over the container's loopback waits for the final
    # server without exposing a host port or joining any network.
    for attempt in $(seq 1 60); do
      if podman exec "$db" psql -X -qAt -v ON_ERROR_STOP=1 -h 127.0.0.1 -U postgres -d codexia -c 'SELECT 1' >/dev/null 2>&1; then break; fi
      sleep 1
    done
    podman exec "$db" psql -X -qAt -v ON_ERROR_STOP=1 -h 127.0.0.1 -U postgres -d codexia -c 'SELECT 1' >/dev/null || die 'Isolated DB not ready on final loopback listener'
    podman exec "$db" psql -X -v ON_ERROR_STOP=1 -U postgres -d codexia -c 'CREATE ROLE codexia; CREATE ROLE codexia_admin; CREATE ROLE codexia_preflight;' >/dev/null
    age -d -i "$3" "$dir/database.dump.age" |
      podman exec -i "$db" pg_restore --exit-on-error --no-owner --no-privileges -U postgres -d codexia
    age -d -i "$3" "$dir/history.tar.age" | podman volume import "$history" -
    [[ "$(db_fingerprint "$db" postgres)" == "${fields[1]}" ]] || die 'Restored database logical fingerprint mismatch'
    [[ "$(history_fingerprint "$history")" == "${fields[2]}" ]] || die 'Restored history fingerprint mismatch'
    cleanup_restore_resources
    trap - EXIT
    [[ "$(validate_artifact "$dir")" == "$artifact_hash" ]] || die 'Backup artifact changed during the restore drill'
    printf 'Isolated restore verified: database and history fingerprints match\n'
    printf 'Verified checksum manifest sha256: %s\n' "$artifact_hash"
    ;;
  *) die 'Use backup-locked or the explicitly approved drill';;
esac
