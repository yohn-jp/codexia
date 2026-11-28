#!/usr/bin/env bash
# Offline encrypted backup and isolated restore verification. Never restores live data.
set -euo pipefail
umask 077
readonly PG_IMAGE='docker.io/library/postgres:17-bookworm@sha256:40865bc877a289da75963d97d72b59633f639fc5af7a4e856bfa3714cae5b536'
die(){ printf '%s\n' "$*" >&2; exit 1; }
require_commands(){
  local cmd
  for cmd do command -v "$cmd" >/dev/null || die "Missing dependency: $cmd"; done
}
require_commands sha256sum findmnt getent ip
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
  validate-artifact)
    [[ $# == 2 ]] || die 'Usage: validate-artifact /absolute/backup'
    validate_artifact "$2"
    exit 0
    ;;
  validate-independent-artifact)
    [[ $# == 3 && "$2" == /* && -d "$2" && ! -L "$2" && "${3%/*}" == "$2" ]] ||
      die 'Use an artifact on the protected independent mount'
    mount_id="$(findmnt -M "$2" -n -o ID)" || die 'The approved independent mount is absent'
    [[ "$mount_id" =~ ^[0-9]+$ && "$(findmnt -T "$3" -n -o ID)" == "$mount_id" ]] ||
      die 'The artifact is not on the approved independent mount'
    case "$(findmnt -M "$2" -n -o FSTYPE)" in
      nfs|nfs4|cifs|fuse.sshfs|sshfs) ;;
      *) die 'The approved independent destination is not a remote filesystem';;
    esac
    digest="$(validate_artifact "$3")"
    [[ "$(findmnt -M "$2" -n -o ID)" == "$mount_id" && "$(findmnt -T "$3" -n -o ID)" == "$mount_id" ]] ||
      die 'The independent mount changed during verification'
    printf '%s\n' "$digest"
    exit 0
    ;;
  validate-destination)
    [[ $# == 2 ]] || die 'Usage: validate-destination /absolute/backup/directory'
    backup_directory "$2"
    printf '%s\n' 'Backup destination preflight passed'
    exit 0
    ;;
esac

readonly STATE_DIR="${CODEXIA_PUSH_STATE_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/codexia-deploy}"
lock_file="$STATE_DIR/host.lock"
require_commands podman age flock sync stat
case "$operation" in
  fingerprint-restored-target)
    [[ $# == 5 && "$2" == --lock-file && "$3" == "$lock_file" && "$4" == --lock-fd ]] ||
      die 'Restored target fingerprint requires the inherited canonical host lock'
    verify_lock_descriptor "$3" "$5"
    ;;
  backup-locked)
    [[ ( $# == 8 || ( $# == 10 && "${9}" == --artifact-id &&
      "${10}" =~ ^codexia-[0-9]{8}T[0-9]{6}Z-[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$ ) ) &&
      "${4:-}" == --approved && "${5:-}" == --lock-file && "${6:-}" == "$lock_file" && "${7:-}" == --lock-fd ]] ||
      die 'Push backup requires explicit approval and the canonical host lock'
    verify_lock_descriptor "$6" "$8"
    ;;
  drill)
    mkdir -p "$STATE_DIR"
    exec 9>"$lock_file"
    flock --exclusive --nonblock 9 || die 'Backup or deployment already running'
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
  local destination="$1" recipient="$2" artifact_id="$3"
  require_quiesced
  podman volume exists codexia-history || die 'History volume absent'
  local staging final db_hash history_hash verified_db_hash verified_history_hash artifact_hash
  if [[ -z "$artifact_id" ]]; then
    artifact_id="codexia-$(date -u +%Y%m%dT%H%M%SZ)-$(cat /proc/sys/kernel/random/uuid)"
  fi
  staging="$destination/.$artifact_id.partial"; final="$destination/$artifact_id"
  [[ ! -e "$final" && ! -L "$final" ]] || die 'Backup already exists'
  mkdir "$staging"
  trap 'rm -rf -- "$staging"' EXIT
  db_hash="$(db_fingerprint codexia-db codexia_admin)" || die 'Could not retrieve database fingerprint'
  history_hash="$(history_fingerprint codexia-history)" || die 'Could not retrieve history fingerprint'
  podman exec codexia-db sh -ec 'export PGPASSWORD="$(cat /run/secrets/admin-password)"; exec pg_dump -U codexia_admin -d codexia -Fc' |
    age -r "$recipient" -o "$staging/database.dump.age"
  podman volume export codexia-history | age -r "$recipient" -o "$staging/history.tar.age"
  # Recheck the stopped state and both logical fingerprints before publication.
  require_quiesced
  verified_db_hash="$(db_fingerprint codexia-db codexia_admin)" || die 'Could not retrieve database fingerprint during backup verification'
  verified_history_hash="$(history_fingerprint codexia-history)" || die 'Could not retrieve history fingerprint during backup verification'
  [[ "$verified_db_hash" == "$db_hash" ]] || die 'Database changed during backup'
  [[ "$verified_history_hash" == "$history_hash" ]] || die 'History changed during backup'
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
verify_drill_candidate(){
  local candidate="$1" database="$2" ledger="$3"
  local -a run=(podman run --rm --pull=never --read-only --cap-drop all --security-opt no-new-privileges --entrypoint node)
  [[ "$(podman inspect --format '{{.HostConfig.NetworkMode}}' "$database")" == none ]] || die 'Restored database must be isolated from all networks'
  "${run[@]}" --network none "$candidate" --input-type=module -e '
    import { readFileSync } from "node:fs";
    const expectedLedger = process.argv[1];
    const identity = JSON.parse(readFileSync("/app/update-identity.json", "utf8"));
    if (identity.format !== "codexia-backend-identity/v1" || identity.profile !== "full" ||
        (expectedLedger && identity.migrationFingerprint !== expectedLedger)) process.exit(1);
  ' "$ledger" || die 'Isolated verification requires the reviewed Full backend image loaded locally'
  [[ -n "$ledger" ]] || return 0

  podman exec -i "$database" psql -X -q -v ON_ERROR_STOP=1 -U postgres -d codexia <<'SQL'
CREATE ROLE codexia_ledger_verifier LOGIN NOINHERIT;
ALTER ROLE codexia_ledger_verifier SET default_transaction_read_only = on;
GRANT USAGE ON SCHEMA public TO codexia_ledger_verifier;
GRANT SELECT ON public.codexia_schema_migrations TO codexia_ledger_verifier;
SQL
  local actual
  actual="$("${run[@]}" --network "container:$database" \
    --env 'CODEXIA_DATABASE_URL=postgres://codexia_ledger_verifier@127.0.0.1:5432/codexia?options=-c%20default_transaction_read_only%3Don' \
    "$candidate" --input-type=module -e '
      import { verifyPostgresSchema } from "@codexia/persistence-postgres";
      console.log(await verifyPostgresSchema(process.env.CODEXIA_DATABASE_URL));
    ')" || die 'Restored PostgreSQL migration ledger did not verify against the candidate'
  [[ "$actual" == "$ledger" ]] || die 'Restored PostgreSQL migration ledger differs from the reviewed candidate'
}
verify_drill_candidate_api(){
  local candidate="$1" database="$2" history_volume="$3" api_name="$4"
  local auth_password app_password auth_secret oidc_secret=''
  local env_file ready=false actual_image database_id network_mode
  [[ "$candidate_api_ready" == true ]] || return 0
  [[ "$(podman inspect --format '{{.HostConfig.NetworkMode}}' "$database")" == none ]] ||
    die 'Restored database must be isolated from all networks before candidate API readiness'
  auth_password="$(cat /proc/sys/kernel/random/uuid | tr -d '-')$(cat /proc/sys/kernel/random/uuid | tr -d '-')"
  app_password="$(cat /proc/sys/kernel/random/uuid | tr -d '-')$(cat /proc/sys/kernel/random/uuid | tr -d '-')"
  auth_secret="$(cat /proc/sys/kernel/random/uuid | tr -d '-')$(cat /proc/sys/kernel/random/uuid | tr -d '-')"
  if [[ -v runtime_settings[CODEXIA_OIDC_ISSUER] ]]; then
    oidc_secret="$(cat /proc/sys/kernel/random/uuid | tr -d '-')$(cat /proc/sys/kernel/random/uuid | tr -d '-')"
  fi
  api_runtime_dir="$(mktemp -d "$STATE_DIR/restore-drill-api-$suffix.XXXXXX")" || die 'Could not create private candidate API settings directory'
  chmod 0700 "$api_runtime_dir"
  env_file="$api_runtime_dir/runtime.env"
  cp -- "$candidate_runtime_settings" "$env_file"
  printf '%s\n' \
    'CODEXIA_AUTH_MODE=better-auth' \
    "CODEXIA_AUTH_DATABASE_URL=postgres://codexia_auth_runtime:$auth_password@127.0.0.1:5432/codexia" \
    "CODEXIA_AUTH_SECRET=$auth_secret" \
    "CODEXIA_OAUTH_INTROSPECTION_CLIENT_SECRET=$candidate_introspection_secret" \
    'CODEXIA_DATABASE_PASSWORD_FILE=/run/secrets/app-password' \
    'CODEXIA_DATABASE_USER=codexia' \
    'CODEXIA_DATABASE_NAME=codexia' \
    'CODEXIA_DATABASE_HOST=127.0.0.1' \
    'CODEXIA_DATABASE_MIGRATE_ON_START=0' \
    'CODEXIA_TRUST_PROXY=1' \
    'CODEXIA_PROFILE=full' \
    'HOST=0.0.0.0' \
    'PORT=3000' \
    'CODEXIA_DATA_DIR=/data' \
    'CODEXIA_USAGE_DIR=/history' >> "$env_file"
  if [[ -n "$oidc_secret" ]]; then
    printf '%s\n' "CODEXIA_OIDC_CLIENT_SECRET=$oidc_secret" >> "$env_file"
  fi
  chmod 0600 "$env_file"
  printf '%s' "$app_password" > "$api_runtime_dir/app-password"
  chmod 0444 "$api_runtime_dir/app-password"
  if ! podman exec -i "$database" psql -X -q -v ON_ERROR_STOP=1 -U postgres -d codexia \
    -v auth_password="$auth_password" -v app_password="$app_password" <<'SQL' >/dev/null
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'codexia_auth') THEN
    RAISE EXCEPTION 'restored Better Auth schema is missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'codexia_auth') THEN
    RAISE EXCEPTION 'restored Better Auth catalog is empty';
  END IF;
END $$;
CREATE ROLE codexia_auth_runtime LOGIN PASSWORD :'auth_password';
ALTER ROLE codexia LOGIN PASSWORD :'app_password';
GRANT CONNECT ON DATABASE codexia TO codexia, codexia_auth_runtime;
GRANT USAGE, CREATE ON SCHEMA public TO codexia;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO codexia;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO codexia;
-- pg_restore --no-owner makes postgres the owner of the restored catalog.
-- Rebind only this scratch auth schema and its objects to the normal runtime role.
ALTER SCHEMA codexia_auth OWNER TO codexia_auth_runtime;
SELECT format('ALTER %s %I.%I OWNER TO codexia_auth_runtime',
              CASE c.relkind WHEN 'S' THEN 'SEQUENCE' WHEN 'v' THEN 'VIEW'
                WHEN 'm' THEN 'MATERIALIZED VIEW' WHEN 'f' THEN 'FOREIGN TABLE' ELSE 'TABLE' END,
              n.nspname, c.relname)
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'codexia_auth' AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
ORDER BY (c.relkind = 'S'), c.relname
\gexec
SQL
  then
    die 'Could not provision isolated candidate API database roles'
  fi
  assert_restore_resource_absent container "$api_name"
  api_created=true
  podman run -d --pull=never --name "$api_name" --label "$label=$suffix" \
    --network "container:$database" --read-only --tmpfs /tmp:rw,nosuid,nodev,noexec,size=64m \
    --tmpfs /data:rw,nosuid,nodev,noexec,size=64m,mode=1777 --cap-drop all --security-opt no-new-privileges \
    --volume "$api_runtime_dir/app-password:/run/secrets/app-password:ro" \
    --volume "$history_volume:/history:rw,nocopy" --env-file "$env_file" "$candidate" >/dev/null ||
    die 'Could not start the digest-pinned candidate API on the isolated restored database'
  actual_image="$(podman inspect --format '{{.Config.Image}}' "$api_name" 2>/dev/null || true)"
  [[ "$actual_image" == "$candidate" ]] || die 'Isolated candidate API image identity differs from the reviewed digest'
  database_id="$(podman inspect --format '{{.Id}}' "$database")"
  network_mode="$(podman inspect --format '{{.HostConfig.NetworkMode}}' "$api_name")"
  [[ "$database_id" =~ ^[a-f0-9]{64}$ &&
     ( "$network_mode" == "container:$database_id" || "$network_mode" == "container:$database" ) ]] ||
    die 'Isolated candidate API escaped the restored database network namespace'
  for attempt in $(seq 1 60); do
    if [[ "$(podman inspect --format '{{.State.Running}}' "$api_name" 2>/dev/null || true)" != true ]]; then break; fi
    if podman exec "$api_name" node -e 'fetch("http://127.0.0.1:3000/health/ready").then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))' >/dev/null 2>&1; then
      ready=true
      break
    fi
    sleep 1
  done
  [[ "$ready" == true ]] || die 'Isolated candidate API readiness failed on the restored database and history'
  podman exec "$api_name" node /app/node_modules/@codexia/api/dist/verify-auth-clients.js >/dev/null 2>&1 ||
    die 'Restored Better Auth schema or configured client catalog failed candidate verification'
}

case "${1:-}" in
  fingerprint-restored-target)
    require_quiesced
    podman volume exists codexia-history || die 'Restored history volume absent'
    database_hash="$(db_fingerprint codexia-db codexia_admin)" || die 'Could not fingerprint restored database'
    history_hash="$(history_fingerprint codexia-history)" || die 'Could not fingerprint restored history'
    require_quiesced
    printf '{"databaseFingerprint":"%s","historyFingerprint":"%s"}\n' "$database_hash" "$history_hash"
    ;;
  backup-locked)
    backup_directory "$2"
    [[ "$3" =~ ^age1[0-9a-z]+$ ]] || die 'Provide an age public recipient, not a private key'
    backup_artifact "$2" "$3" "${10:-}"
    ;;
  drill)
    [[ ( $# == 4 || $# == 8 || $# == 13 ) && "$4" == --approved && "$2" == /* && -d "$2" && ! -L "$2" && "$3" == /* && -f "$3" && ! -L "$3" && -r "$3" ]] ||
      die 'Usage: drill /absolute/backup/directory /absolute/private/age-identity --approved [--candidate-full-image IMAGE@sha256:DIGEST --candidate-ledger sha256:DIGEST [--candidate-api-ready --candidate-runtime-settings /absolute/private/runtime.env --candidate-introspection-secret-file /absolute/private/secret]]'
    candidate=; ledger=; candidate_api_ready=false; candidate_runtime_settings=
    if [[ $# -ge 8 ]]; then
      [[ "$5" == --candidate-full-image && "${CODEXIA_IMAGE_REPOSITORY:-}" =~ ^ghcr\.io/[a-z0-9][a-z0-9-]*/codexia-backend$ &&
         "${6%@*}" == "$CODEXIA_IMAGE_REPOSITORY" && "${6##*@}" =~ ^sha256:[a-f0-9]{64}$ ]] ||
        die 'Use a digest-pinned reviewed Full backend image from the independently verified recovery repository'
      candidate="$6"
      [[ "$7" == --candidate-ledger && "$8" =~ ^sha256:[a-f0-9]{64}$ ]] || die 'Use a digest-pinned candidate migration ledger'
      ledger="$8"
    fi
    if [[ $# == 13 ]]; then
      [[ "$9" == --candidate-api-ready && "${10}" == --candidate-runtime-settings &&
         "${11}" == /* && "${12}" == --candidate-introspection-secret-file && "${13}" == /* ]] ||
        die 'Candidate API readiness requires private immutable runtime settings and introspection secret files'
      candidate_api_ready=true
      candidate_runtime_settings="${11}"
      [[ -f "$candidate_runtime_settings" && ! -L "$candidate_runtime_settings" && -r "$candidate_runtime_settings" ]] ||
        die 'Candidate runtime settings must be a readable private regular file'
      settings_mode="$(stat -Lc '%a' -- "$candidate_runtime_settings")"
      settings_owner="$(stat -Lc '%u' -- "$candidate_runtime_settings")"
      [[ ( "$settings_mode" == 400 || "$settings_mode" == 600 ) && "$settings_owner" == "$(id -u)" ]] ||
        die 'Candidate runtime settings must be owned by the recovery user and mode 0400 or 0600'
      declare -A runtime_settings=()
      while IFS= read -r setting_line || [[ -n "$setting_line" ]]; do
        [[ -z "$setting_line" || "$setting_line" == \#* ]] && continue
        [[ "$setting_line" =~ ^(CODEXIA_[A-Z0-9_]+)=([!-~]*)$ ]] || die 'Candidate runtime settings contain an invalid line'
        setting_key="${BASH_REMATCH[1]}"; setting_value="${BASH_REMATCH[2]}"
        case "$setting_key" in
          CODEXIA_PUBLIC_ORIGIN|CODEXIA_OIDC_ISSUER|CODEXIA_OIDC_CLIENT_ID|CODEXIA_OAUTH_INTROSPECTION_CLIENT_ID|CODEXIA_OAUTH_OWNER_SUBJECT|CODEXIA_OAUTH_OWNER_CLIENT_IDS|CODEXIA_OAUTH_MCP_CLIENT_IDS|CODEXIA_OAUTH_MCP_PROJECT_ASSIGNMENTS|CODEXIA_API_AUDIENCE) ;;
          *) die 'Candidate runtime settings contain an unsupported or secret field';;
        esac
        [[ ! -v runtime_settings[$setting_key] ]] || die 'Candidate runtime settings contain a duplicate field'
        runtime_settings[$setting_key]="$setting_value"
      done < "$candidate_runtime_settings"
      [[ "${runtime_settings[CODEXIA_PUBLIC_ORIGIN]:-}" =~ ^https://[^/[:space:]]+$ &&
         "${runtime_settings[CODEXIA_OAUTH_INTROSPECTION_CLIENT_ID]:-}" =~ ^[a-zA-Z0-9._:/|+-]+$ &&
         "${runtime_settings[CODEXIA_OAUTH_OWNER_SUBJECT]:-}" =~ ^[a-zA-Z0-9._@:/|+-]+$ &&
         "${runtime_settings[CODEXIA_OAUTH_OWNER_CLIENT_IDS]:-}" =~ ^[a-zA-Z0-9._:/|+-]+(,[a-zA-Z0-9._:/|+-]+)*$ ]] ||
        die 'Candidate runtime settings are missing required Better Auth identifiers'
      [[ ( -v runtime_settings[CODEXIA_OIDC_ISSUER] && -v runtime_settings[CODEXIA_OIDC_CLIENT_ID] ) ||
         ( ! -v runtime_settings[CODEXIA_OIDC_ISSUER] && ! -v runtime_settings[CODEXIA_OIDC_CLIENT_ID] ) ]] ||
        die 'Candidate OIDC issuer and client ID must be configured together'
      if [[ -v runtime_settings[CODEXIA_OIDC_ISSUER] ]]; then
        [[ "${runtime_settings[CODEXIA_OIDC_ISSUER]}" =~ ^https://[^[:space:]]+$ &&
           "${runtime_settings[CODEXIA_OIDC_CLIENT_ID]}" =~ ^[a-zA-Z0-9._:/|+-]+$ ]] ||
          die 'Candidate OIDC settings are invalid'
      fi
      [[ ( -v runtime_settings[CODEXIA_OAUTH_MCP_CLIENT_IDS] && -v runtime_settings[CODEXIA_OAUTH_MCP_PROJECT_ASSIGNMENTS] ) ||
         ( ! -v runtime_settings[CODEXIA_OAUTH_MCP_CLIENT_IDS] && ! -v runtime_settings[CODEXIA_OAUTH_MCP_PROJECT_ASSIGNMENTS] ) ]] ||
        die 'Candidate MCP client IDs and assignments must be configured together'
      candidate_introspection_secret_file="${13}"
      [[ -f "$candidate_introspection_secret_file" && ! -L "$candidate_introspection_secret_file" && -r "$candidate_introspection_secret_file" ]] ||
        die 'Candidate introspection secret must be a readable private regular file'
      secret_mode="$(stat -Lc '%a' -- "$candidate_introspection_secret_file")"
      secret_owner="$(stat -Lc '%u' -- "$candidate_introspection_secret_file")"
      [[ ( "$secret_mode" == 400 || "$secret_mode" == 600 ) && "$secret_owner" == "$(id -u)" ]] ||
        die 'Candidate introspection secret must be owned by the recovery user and mode 0400 or 0600'
      candidate_introspection_secret="$(cat -- "$candidate_introspection_secret_file")"
      [[ "$candidate_introspection_secret" =~ ^[A-Za-z0-9._~+-]{32,512}$ ]] ||
        die 'Candidate introspection secret has an invalid format'
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
    api_name="$db-api"; api_created=false; api_runtime_dir=''
    label="io.codexia.restore-drill"
    db_created=false; data_created=false; history_created=false
    cleanup_restore_resources(){
      local failed=0 status actual_label resource created
      if [[ "$api_created" == true ]]; then
        status=0; podman container exists "$api_name" >/dev/null 2>&1 || status=$?
        if [[ "$status" == 0 ]]; then
          if ! actual_label="$(podman inspect --format "{{index .Config.Labels \"$label\"}}" "$api_name" 2>/dev/null)"; then
            printf '%s\n' 'Restore drill cleanup failed: could not inspect isolated candidate API ownership' >&2; failed=1
          elif [[ "$actual_label" != "$suffix" ]]; then
            printf '%s\n' 'Restore drill cleanup failed: isolated candidate API ownership changed' >&2; failed=1
          elif ! podman rm -f "$api_name" >/dev/null 2>&1; then
            printf '%s\n' 'Restore drill cleanup failed: isolated candidate API removal failed' >&2; failed=1
          fi
        elif [[ "$status" != 1 ]]; then
          printf '%s\n' 'Restore drill cleanup failed: isolated candidate API state is unobservable' >&2; failed=1
        fi
        status=0; podman container exists "$api_name" >/dev/null 2>&1 || status=$?
        if [[ "$status" == 0 ]]; then
          printf '%s\n' 'Restore drill cleanup failed: isolated candidate API remains' >&2; failed=1
        elif [[ "$status" != 1 ]]; then
          printf '%s\n' 'Restore drill cleanup failed: isolated candidate API absence is unobservable' >&2; failed=1
        fi
      fi
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
      if [[ -n "$api_runtime_dir" ]]; then rm -rf -- "$api_runtime_dir" || failed=1; fi
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
    if [[ "$candidate_api_ready" == true ]]; then assert_restore_resource_absent container "$api_name"; fi
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
    # Podman imports the archived entries into an already created mount root.
    # Give only that disposable root the canonical API ownership and mode.
    podman run --rm --pull=never --network none --read-only --user 0:0 \
      --cap-drop all --cap-add CHOWN --cap-add FOWNER --security-opt no-new-privileges \
      --entrypoint /bin/sh --volume "$history:/history:rw,nocopy" "$PG_IMAGE" \
      -ec 'chmod 0700 /history; chown 1000:1000 /history'
    restored_database_hash="$(db_fingerprint "$db" postgres)" || die 'Could not retrieve restored database fingerprint'
    restored_history_hash="$(history_fingerprint "$history")" || die 'Could not retrieve restored history fingerprint'
    [[ "$restored_database_hash" == "${fields[1]}" ]] || die 'Restored database logical fingerprint mismatch'
    [[ "$restored_history_hash" == "${fields[2]}" ]] || die 'Restored history fingerprint mismatch'
    if [[ -n "$candidate" ]]; then
      verify_drill_candidate "$candidate" "$db" "$ledger"
      verify_drill_candidate_api "$candidate" "$db" "$history" "$api_name"
    fi
    cleanup_restore_resources
    trap - EXIT
    [[ "$(validate_artifact "$dir")" == "$artifact_hash" ]] || die 'Backup artifact changed during the restore drill'
    printf 'Isolated restore verified: database and history fingerprints match\n'
    printf 'Verified checksum manifest sha256: %s\n' "$artifact_hash"
    printf 'Verified database logical sha256: %s\n' "${fields[1]}"
    printf 'Verified history logical sha256: %s\n' "${fields[2]}"
    if [[ -n "$ledger" ]]; then printf 'Isolated candidate ledger verified: %s\n' "$ledger"; fi
    if [[ "$candidate_api_ready" == true ]]; then printf 'Isolated candidate API readiness verified\n'; fi
    ;;
  *) die 'Use backup-locked or the explicitly approved drill';;
esac
