#!/usr/bin/env bash
# Offline encrypted backup and isolated restore verification. Never restores live data.
set -euo pipefail
umask 077
readonly PG_IMAGE='docker.io/library/postgres:17-bookworm@sha256:665dc7b37ac52a17e298511414c21d23ffa4e6a6ef6225b3e5d59c7afb35e994'
readonly STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/codexia-updater"
die(){ printf '%s\n' "$*" >&2; exit 1; }
for cmd in podman age sha256sum flock findmnt sync; do command -v "$cmd" >/dev/null || die "Missing dependency: $cmd"; done
mkdir -p "$STATE_DIR"
exec 9>"$STATE_DIR/host.lock"
flock --exclusive --nonblock 9 || die 'Updater or backup already running'

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
remote_directory(){
  [[ "$1" == /* && -d "$1" ]] || die 'Use an existing absolute off-VM mount directory'
  local fstype
  fstype="$(findmnt -T "$1" -n -o FSTYPE)"
  case "$fstype" in nfs|nfs4|cifs|fuse.sshfs|sshfs) ;; *) die 'Destination is not an approved remote filesystem';; esac
}
case "${1:-}" in
  backup)
    [[ $# == 3 ]] || die 'Usage: backup /remote/mount age1-recipient'
    remote_directory "$2"
    [[ "$3" =~ ^age1[0-9a-z]+$ ]] || die 'Provide an age public recipient, not a private key'
    require_quiesced
    podman volume exists codexia-history || die 'History volume absent'
    stamp="$(date -u +%Y%m%dT%H%M%SZ)-$(cat /proc/sys/kernel/random/uuid)"
    staging="$2/.codexia-$stamp.partial"; final="$2/codexia-$stamp"
    mkdir "$staging"
    trap 'rm -rf -- "$staging"' EXIT
    db_hash="$(db_fingerprint codexia-db codexia_admin)"
    history_hash="$(history_fingerprint codexia-history)"
    podman exec codexia-db sh -ec 'export PGPASSWORD="$(cat /run/secrets/admin-password)"; exec pg_dump -U codexia_admin -d codexia -Fc' |
      age -r "$3" -o "$staging/database.dump.age"
    podman volume export codexia-history | age -r "$3" -o "$staging/history.tar.age"
    # Recheck the stopped state and both logical fingerprints before publication.
    require_quiesced
    [[ "$(db_fingerprint codexia-db codexia_admin)" == "$db_hash" ]] || die 'Database changed during backup'
    [[ "$(history_fingerprint codexia-history)" == "$history_hash" ]] || die 'History changed during backup'
    printf 'codexia-backup/v1\n%s\n%s\n' "$db_hash" "$history_hash" | age -r "$3" -o "$staging/manifest.age"
    (cd "$staging"; sha256sum database.dump.age history.tar.age manifest.age > SHA256SUMS)
    sync -f "$staging"
    [[ ! -e "$final" ]] || die 'Backup already exists'
    mv -T -- "$staging" "$final"
    sync -f "$2"
    trap - EXIT
    printf 'Encrypted backup committed: %s\n' "$final"
    ;;
  drill)
    [[ $# == 3 && -d "$2" && -r "$3" ]] || die 'Usage: drill /backup/directory /private/age-identity'
    dir="$(realpath -- "$2")"
    # Validate fixed ciphertext names, never execute filenames from the checksum file.
    (cd "$dir"; sha256sum database.dump.age history.tar.age manifest.age | cmp - SHA256SUMS)
    manifest="$(age -d -i "$3" "$dir/manifest.age")"
    mapfile -t fields <<< "$manifest"
    [[ "${#fields[@]}" == 3 && "${fields[0]}" == codexia-backup/v1 && "${fields[1]}" =~ ^[0-9a-f]{64}$ && "${fields[2]}" =~ ^[0-9a-f]{64}$ ]] || die 'Invalid decrypted backup manifest'
    suffix="$(cat /proc/sys/kernel/random/uuid)"
    db="codexia-restore-drill-$suffix"; data="$db-data"; history="$db-history"
    cleanup(){ podman rm -f "$db" >/dev/null 2>&1 || true; podman volume rm "$data" "$history" >/dev/null 2>&1 || true; }
    trap cleanup EXIT
    podman volume create "$data" >/dev/null
    podman volume create "$history" >/dev/null
    podman run -d --name "$db" --network none --security-opt no-new-privileges       -e POSTGRES_DB=codexia -e POSTGRES_HOST_AUTH_METHOD=trust -v "$data:/var/lib/postgresql/data" "$PG_IMAGE" >/dev/null
    for attempt in $(seq 1 60); do
      if podman exec "$db" pg_isready -U postgres -d codexia >/dev/null 2>&1; then break; fi
      sleep 1
    done
    podman exec "$db" pg_isready -U postgres -d codexia >/dev/null || die 'Isolated DB not ready'
    podman exec "$db" psql -X -v ON_ERROR_STOP=1 -U postgres -d codexia -c 'CREATE ROLE codexia; CREATE ROLE codexia_admin; CREATE ROLE codexia_preflight;' >/dev/null
    age -d -i "$3" "$dir/database.dump.age" |
      podman exec -i "$db" pg_restore --exit-on-error --no-owner --no-privileges -U postgres -d codexia
    age -d -i "$3" "$dir/history.tar.age" | podman volume import "$history" -
    [[ "$(db_fingerprint "$db" postgres)" == "${fields[1]}" ]] || die 'Restored database logical fingerprint mismatch'
    [[ "$(history_fingerprint "$history")" == "${fields[2]}" ]] || die 'Restored history fingerprint mismatch'
    printf 'Isolated restore verified: database and history fingerprints match\n'
    ;;
  *) die 'Use backup or drill';;
esac
