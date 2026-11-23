#!/usr/bin/env bash
# Offline encrypted backup and isolated restore verification. Never restores live data.
set -euo pipefail
umask 077
readonly PG_IMAGE='docker.io/library/postgres:17-bookworm@sha256:40865bc877a289da75963d97d72b59633f639fc5af7a4e856bfa3714cae5b536'
readonly STATE_DIR="${CODEXIA_PUSH_STATE_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/codexia-deploy}"
die(){ printf '%s\n' "$*" >&2; exit 1; }
for cmd in podman age sha256sum flock findmnt sync stat getent ip; do command -v "$cmd" >/dev/null || die "Missing dependency: $cmd"; done
lock_file="$STATE_DIR/host.lock"
operation="${1:-}"
verify_lock_descriptor(){
  local lock_file="$1" lock_fd="$2" fd_identity lock_identity
  [[ "$lock_file" == /* && -f "$lock_file" && ! -L "$lock_file" ]] || die 'Deployment lock must be an existing absolute regular file'
  [[ "$lock_fd" =~ ^[0-9]+$ && "$lock_fd" -ge 3 && -e "/proc/self/fd/$lock_fd" ]] || die 'Deployment lock descriptor was not inherited'
  fd_identity="$(stat -Lc '%d:%i' -- "/proc/self/fd/$lock_fd" 2>/dev/null || true)"
  lock_identity="$(stat -Lc '%d:%i' -- "$lock_file" 2>/dev/null || true)"
  [[ -n "$fd_identity" && "$fd_identity" == "$lock_identity" ]] || die 'Inherited descriptor does not identify the declared deployment lock'
  flock --exclusive --nonblock "$lock_fd" || die 'Inherited descriptor does not own the maintenance lock'
}
backup_directory(){
  local access="${2:-write}"
  [[ "$1" == /* && -d "$1" && ! -L "$1" ]] || die 'Use an existing absolute backup directory without symlinks'
  case "$access" in
    write) [[ -w "$1" ]] || die 'Backup destination is not writable';;
    read) [[ -r "$1" && -x "$1" ]] || die 'Backup artifact directory is not readable';;
    *) die 'Unknown backup directory access mode';;
  esac
  local fstype mount_source remote_host local_addresses remote_addresses address
  fstype="$(findmnt -T "$1" -n -o FSTYPE)"
  case "$fstype" in nfs|nfs4|cifs|fuse.sshfs|sshfs) ;; *) return 0;; esac
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
  backup_directory "$dir" read
  for file in database.dump.age history.tar.age manifest.age SHA256SUMS; do
    [[ -f "$dir/$file" && ! -L "$dir/$file" ]] || die 'Backup artifact contains a missing or unsafe file'
  done
  (cd "$dir" && sha256sum database.dump.age history.tar.age manifest.age | cmp - SHA256SUMS) || die 'Backup ciphertext checksum mismatch'
  sha256sum "$dir/SHA256SUMS" | cut -d' ' -f1
}
case "$operation" in
  backup-locked)
    [[ $# == 8 && "${4:-}" == --approved && "${5:-}" == --lock-file && "${7:-}" == --lock-fd ]] ||
      die 'Push backup requires explicit approval and an inherited host lock'
    verify_lock_descriptor "$6" "$8"
    ;;
  fingerprint-locked)
    [[ $# == 6 && "$2" == --approved && "$3" == --lock-file && "$4" == "$lock_file" && "$5" == --lock-fd ]] ||
      die 'Fingerprinting requires explicit approval and the inherited canonical host lock'
    verify_lock_descriptor "$4" "$6"
    ;;
  drill)
    mkdir -p "$STATE_DIR"
    exec 9>"$lock_file"
    flock --exclusive --nonblock 9 || die 'Backup or deployment already running'
    ;;
  validate-artifact)
    [[ $# == 2 ]] || die 'Usage: validate-artifact /absolute/backup'
    validate_artifact "$2"
    exit 0
    ;;
  validate-destination)
    [[ $# == 2 ]] || die 'Usage: validate-destination /absolute/backup/directory'
    backup_directory "$2"
    printf '%s\n' 'Backup destination preflight passed'
    exit 0
    ;;
  *) die 'Unsupported backup operation';;
esac

# Canonical v2 fingerprint: application tables and Better Auth schema.
db_fingerprint(){
  local container="$1" user="$2" schema_filter="n.nspname IN ('public','codexia_auth')"
  podman exec -i "$container" sh -ec '
    if [ -r /run/secrets/admin-password ]; then export PGPASSWORD="$(cat /run/secrets/admin-password)"; fi
    exec psql -X -qAt -v ON_ERROR_STOP=1 -U "$1" -d codexia
  ' sh "$user" <<SQL | sha256sum | cut -d' ' -f1
SET TIME ZONE 'UTC';
SET DateStyle TO ISO, YMD;
SELECT format('SELECT %L; SELECT to_jsonb(t)::text FROM %I.%I t ORDER BY to_jsonb(t)::text COLLATE "C";', n.nspname || '.' || c.relname, n.nspname, c.relname)
FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE $schema_filter AND c.relkind IN ('r','p')
ORDER BY n.nspname, c.relname
\gexec
SQL
}
history_fingerprint(){
  local volume="$1"
  # The API image runs as node (UID/GID 1000) and creates /history/jobs with
  # mode 0700 and its state file with mode 0600. Fingerprinting must run as
  # that same least-privilege identity. pipefail ensures find, sort, or
  # sha256sum failures cannot be hidden by a successful downstream command.
  set -o pipefail
  podman run --rm --network none --read-only --cap-drop all --security-opt no-new-privileges --user 1000:1000 --entrypoint /bin/bash \
    -v "$volume:/history:ro" "$PG_IMAGE" -euo pipefail -c 'cd /history; find . -type f -print0 | LC_ALL=C sort -z | xargs -0 -r sha256sum' | sha256sum | cut -d' ' -f1
}
require_quiesced(){
  local status unit
  for unit in codexia-api.service codexia-tunnel.service; do
    status=0
    systemctl --user is-active --quiet "$unit" || status=$?
    case "$status" in
      0) die "Push deployment requires inactive systemd unit: $unit";;
      3|4) ;;
      *) die "Cannot verify systemd unit state: $unit";;
    esac
  done
  status=0
  podman container exists codexia-api || status=$?
  case "$status" in
    0) [[ "$(podman inspect --format '{{.State.Running}}' codexia-api)" == false ]] || die 'API writer is still running';;
    1) ;;
    *) die 'Cannot inspect API writer';;
  esac
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
  printf 'codexia-backup/v2\n%s\n%s\n' "$db_hash" "$history_hash" | age -r "$recipient" -o "$staging/manifest.age"
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
rehearse_restore_maintenance(){
  local candidate="$1" database="$2" history_volume="$3" status=0
  local -a run=(podman run --rm --pull=never --read-only --cap-drop all --security-opt no-new-privileges --entrypoint node)
  [[ "$(podman inspect --format '{{.HostConfig.NetworkMode}}' "$database")" == none ]] || die 'Restored database must be isolated from all networks'
  "${run[@]}" --network none "$candidate" --input-type=module -e '
    import { readFileSync } from "node:fs";
    const identity = JSON.parse(readFileSync("/app/update-identity.json", "utf8"));
    if (identity.format !== "codexia-backend-identity/v1" || identity.profile !== "full") process.exit(1);
  ' || die 'Maintenance rehearsal requires the reviewed Full backend image loaded locally'

  podman exec -i "$database" psql -X -q -v ON_ERROR_STOP=1 -U postgres -d codexia <<'SQL'
CREATE ROLE codexia_preflight LOGIN NOINHERIT;
ALTER ROLE codexia_preflight SET default_transaction_read_only = on;
ALTER ROLE codexia LOGIN;
GRANT USAGE ON SCHEMA public TO codexia_preflight, codexia;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO codexia_preflight;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO codexia;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO codexia;
SQL

  local maintenance=/app/node_modules/@codexia/api/dist/maintain-snapshot-projections.js
  local reader=postgres://codexia_preflight@127.0.0.1:5432/codexia
  local writer=postgres://codexia@127.0.0.1:5432/codexia
  # The database has only loopback. The candidate joins that disposable network
  # namespace without mounts, port publication, or a caller-supplied endpoint.
  local -a database_run=("${run[@]}" --network "container:$database")
  "${database_run[@]}" --env "CODEXIA_DATABASE_URL=$reader" "$candidate" "$maintenance" --check >/dev/null || status=$?
  [[ "$status" == 0 || "$status" == 2 ]] || die 'Isolated maintenance pre-check failed'
  "${database_run[@]}" --env "CODEXIA_DATABASE_URL=$writer" "$candidate" "$maintenance" --apply >/dev/null || die 'Isolated maintenance apply failed'
  "${database_run[@]}" --env "CODEXIA_DATABASE_URL=$reader" "$candidate" "$maintenance" --check >/dev/null || die 'Isolated maintenance still required after apply'

  local history_maintenance=/app/node_modules/@codexia/api/dist/maintain-job-history.js
  local -a history_run=("${run[@]}" --network none --user 1000:1000 --env CODEXIA_USAGE_DIR=/history)
  status=0
  "${history_run[@]}" --volume "$history_volume:/history:ro,nocopy" "$candidate" "$history_maintenance" --check >/dev/null || status=$?
  [[ "$status" == 0 || "$status" == 2 ]] || die 'Isolated job-history pre-check failed'
  "${history_run[@]}" --volume "$history_volume:/history:rw,nocopy" "$candidate" "$history_maintenance" --apply >/dev/null || die 'Isolated job-history apply failed'
  "${history_run[@]}" --volume "$history_volume:/history:ro,nocopy" "$candidate" "$history_maintenance" --check >/dev/null || die 'Isolated job-history maintenance still required after apply'
}
case "${1:-}" in
  backup-locked)
    [[ $# == 8 ]] || die 'Usage: backup-locked /absolute/backup/directory age1-recipient --approved --lock-file /absolute/lock --lock-fd fd'
    backup_directory "$2"
    [[ "$3" =~ ^age1[0-9a-z]+$ ]] || die 'Provide an age public recipient, not a private key'
    backup_artifact "$2" "$3"
    ;;
  fingerprint-locked)
    require_quiesced
    podman volume exists codexia-history || die 'History volume absent'
    database_hash="$(db_fingerprint codexia-db codexia_admin)"
    history_hash="$(history_fingerprint codexia-history)"
    require_quiesced
    printf '{"databaseFingerprint":"%s","historyFingerprint":"%s"}\n' "$database_hash" "$history_hash"
    ;;
  drill)
    [[ ( $# == 4 || $# == 6 ) && "$4" == --approved && "$2" == /* && -d "$2" && ! -L "$2" && "$3" == /* && -f "$3" && ! -L "$3" && -r "$3" ]] || die 'Usage: drill /absolute/backup/directory /absolute/private/age-identity --approved [--candidate-full-image IMAGE@sha256:DIGEST]'
    candidate=
    if [[ $# == 6 ]]; then
      [[ "$5" == --candidate-full-image && "$6" =~ ^ghcr\.io/yohn-jp/codexia-backend@sha256:[a-f0-9]{64}$ ]] || die 'Use a digest-pinned reviewed Full backend image'
      candidate="$6"
    fi
    backup_directory "$2" read
    identity_mode="$(stat -Lc '%a' -- "$3")"
    identity_owner="$(stat -Lc '%u' -- "$3")"
    [[ "$identity_mode" == 400 || "$identity_mode" == 600 ]] || die 'Recovery identity must be mode 0400 or 0600'
    [[ "$identity_owner" == "$(id -u)" ]] || die 'Recovery identity must be owned by the current recovery user'
    dir="$(realpath -- "$2")"
    # Validate fixed ciphertext names, never execute filenames from the checksum file.
    artifact_hash="$(validate_artifact "$dir")"
    manifest="$(age -d -i "$3" "$dir/manifest.age")"
    mapfile -t fields <<< "$manifest"
    [[ "${#fields[@]}" == 3 && "${fields[0]}" == codexia-backup/v2 && "${fields[1]}" =~ ^[0-9a-f]{64}$ && "${fields[2]}" =~ ^[0-9a-f]{64}$ ]] || die 'Invalid decrypted backup manifest'
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
    podman exec "$db" psql -X -v ON_ERROR_STOP=1 -U postgres -d codexia -c 'CREATE ROLE codexia; CREATE ROLE codexia_admin;' >/dev/null
    age -d -i "$3" "$dir/database.dump.age" |
      podman exec -i "$db" pg_restore --exit-on-error --no-owner --no-privileges -U postgres -d codexia
    age -d -i "$3" "$dir/history.tar.age" | podman volume import "$history" -
    [[ "$(db_fingerprint "$db" postgres)" == "${fields[1]}" ]] || die 'Restored database logical fingerprint mismatch'
    [[ "$(history_fingerprint "$history")" == "${fields[2]}" ]] || die 'Restored history fingerprint mismatch'
    if [[ -n "$candidate" ]]; then rehearse_restore_maintenance "$candidate" "$db" "$history"; fi
    cleanup_restore_resources
    trap - EXIT
    [[ "$(validate_artifact "$dir")" == "$artifact_hash" ]] || die 'Backup artifact changed during the restore drill'
    printf 'Isolated restore verified: database and history fingerprints match\n'
    printf 'Verified checksum manifest sha256: %s\n' "$artifact_hash"
    printf 'Verified database logical sha256: %s\n' "${fields[1]}"
    printf 'Verified history logical sha256: %s\n' "${fields[2]}"
    if [[ -n "$candidate" ]]; then printf 'Isolated maintenance rehearsal verified: %s\n' "$candidate"; fi
    ;;
  *) die 'Use backup-locked or the explicitly approved drill';;
esac
