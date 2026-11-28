#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

state="$HOME/.local/state/codexia-deploy"
intent="$state/deploy-transaction.json"
release="$state/deployed-release.json"
directory="$HOME/.local/share/codexia-backup-postgres"
socket="$directory/socket"
hba="$directory/pg_hba.conf"
units="$HOME/.config/containers/systemd"
dropin="$units/codexia-db.container.d/10-backup-socket.conf"
socket_in_db=/run/codexia-backup-postgresql
hba_in_db=/run/codexia-backup-pg_hba.conf
db_service=codexia-db.service
api_service=codexia-api.service
tunnel_service=codexia-tunnel.service
format=codexia-backup-socket/v1
identity_sql='SELECT system_identifier || chr(58) || oid FROM pg_control_system(), pg_database WHERE datname=current_database()'

fail(){ printf '%s\n' "$1" >&2; exit 1; }
exists(){ [[ -e "$1" || -L "$1" ]]; }
private_directory(){ [[ -d "$1" && ! -L "$1" && -O "$1" && "$(stat -c %a -- "$1")" == 700 ]]; }
private_file(){ [[ -f "$1" && ! -L "$1" && -O "$1" && "$(stat -c '%a:%h' -- "$1")" == 600:1 ]]; }
sha256(){ local digest; digest="$(sha256sum)" && printf '%s\n' "${digest%% *}"; }
admin_query(){
  podman exec codexia-db sh -ec 'export PGPASSWORD="$(cat /run/secrets/admin-password)"
    exec psql -X -qAtw -v ON_ERROR_STOP=1 -U codexia_admin -d codexia -c "$1"' sh "$1"
}
verify_database(){
  local ports
  ports="$(podman port codexia-db)" || return 1
  [[ -S "$socket/.s.PGSQL.5432" && -z "$ports" ]] || return 1
  [[ "$(admin_query 'SHOW unix_socket_directories')" == "/var/run/postgresql,$socket_in_db" ]] || return 1
  [[ "$(admin_query 'SHOW hba_file')" == "$hba_in_db" ]] || return 1
  [[ "$(admin_query "SELECT count(*) > 0 AND bool_and(auth_method = 'scram-sha-256' AND error IS NULL) FROM pg_hba_file_rules")" == t ]] || return 1
  [[ "$(admin_query "$identity_sql")" == "$database_identity" ]] || return 1
}

[[ $# == 0 || ( $# == 1 && "$1" == --recover-only ) ]] || fail 'Invalid protected socket operation'
recovery_only="${1:-}"
if [[ "$recovery_only" == --recover-only ]] && ! exists "$intent"; then exit 0; fi
[[ "$(podman info --format '{{.Host.Security.Rootless}}')" == true ]] || fail 'Private backup socket requires rootless Podman'
if [[ ! -e "$state" && ! -L "$state" ]]; then install -d -m 0700 -- "$state"; fi
private_directory "$state" || fail 'Private backup socket requires owned deployment state'
lock="$state/host.lock"
[[ ! -L "$lock" && ( ! -e "$lock" || ( -f "$lock" && -O "$lock" ) ) ]] || fail 'Invalid deployment host lock'
exec 9>>"$lock"
flock --exclusive --nonblock 9 || exit 75
for pending in backup-transaction cutover-transaction.json deploy-transaction.json.tmp deployed-release.json.tmp rollback-api.container rollback-release.json; do
  ! exists "$state/$pending" || fail 'Recover interrupted host work before provisioning the socket'
done
resuming=false
if exists "$intent"; then
  private_file "$intent" && [[ "$(stat -c %s -- "$intent")" -le 4096 ]] &&
    jq -e --arg format "$format" '.format == $format and (.phase == "pending" or .phase == "rollback") and
      (.database | type == "string" and test("^[0-9]+:[0-9]+$")) and
      (.authority | type == "string" and test("^[a-f0-9]{64}$")) and
      (.recipe | type == "string" and test("^[a-f0-9]{64}$")) and
      (.previousSocket | type == "string" and test("^[^[:cntrl:]]+$")) and
      (.previousHba | type == "string" and test("^/[^[:cntrl:]]+$")) and
      (.tunnelActive | type == "boolean")' "$intent" >/dev/null ||
    fail 'Unrecognized deployment transaction; socket recovery refused'
  resuming=true
elif [[ "$recovery_only" == --recover-only ]]; then
  exit 0
fi
database_ports="$(podman port codexia-db)"
[[ -z "$database_ports" ]] || fail 'Database port is published'
database_identity="$(admin_query "$identity_sql")"
[[ "$database_identity" =~ ^[0-9]+:[0-9]+$ ]] || fail 'Unable to identify the initialized PostgreSQL cluster'

if [[ ! -e "$directory" && ! -L "$directory" ]]; then install -d -m 0700 -- "$directory"; fi
private_directory "$directory" || fail 'Invalid private backup socket parent'
if [[ ! -e "$socket" && ! -L "$socket" ]]; then
  install -d -m 0755 -- "$socket"
  podman unshare chown 999:999 -- "$socket"
fi
[[ -d "$socket" && ! -L "$socket" && "$(podman unshare stat -c '%u:%g:%a' -- "$socket")" == 999:999:755 ]] ||
  fail 'Invalid private backup socket directory or PostgreSQL UID mapping'

expected_hba=$'local all all scram-sha-256\nhost all all all scram-sha-256'
# The container runs as its mapped PostgreSQL UID. The private host parent keeps
# this non-secret configuration readable only through the intended bind mount.
if [[ ! -e "$hba" && ! -L "$hba" ]]; then
  temporary_hba="$(mktemp "$directory/.pg_hba.XXXXXX")"
  printf '%s\n' "$expected_hba" > "$temporary_hba"
  chmod 0644 -- "$temporary_hba"
  mv -T -- "$temporary_hba" "$hba"
fi
[[ -f "$hba" && ! -L "$hba" && -O "$hba" && "$(stat -c %a -- "$hba")" == 644 &&
   "$(cat -- "$hba")" == "$expected_hba" ]] || fail 'Existing backup socket authentication rules differ from the approved rules'

dropin_contents="[Container]
Volume=%h/.local/share/codexia-backup-postgres/socket:$socket_in_db:rw,z
Volume=%h/.local/share/codexia-backup-postgres/pg_hba.conf:$hba_in_db:ro,z
Exec=postgres -c unix_socket_directories=/var/run/postgresql,$socket_in_db -c hba_file=$hba_in_db"
verify_dropin(){ private_file "$dropin" && [[ "$(cat -- "$dropin")" == "$dropin_contents" ]]; }
if exists "$dropin"; then
  verify_dropin || fail 'Existing PostgreSQL socket drop-in differs from the approved source'
  if [[ "$resuming" == false ]]; then
    verify_database || fail 'Existing PostgreSQL socket did not satisfy the approved boundary'
    exit 0
  fi
fi

worker_state="$(systemctl --user show codexia-backup-executor.service -p ActiveState --value)"
worker_enablement="$(systemctl --user show codexia-backup-executor.service -p UnitFileState --value)"
[[ "$worker_state" == inactive || "$worker_state" == failed ]] || fail 'Stop the backup executor before provisioning the socket'
[[ -z "$worker_enablement" || "$worker_enablement" == disabled || "$worker_enablement" == masked ]] ||
  fail 'Disable the backup executor before provisioning the socket'

for file in "$release" "$units/codexia-api.container" "$units/codexia-db.container" "$units/codexia-postgres.volume"; do
  private_file "$file" || fail 'Protected socket operation requires regular committed deployment and database files'
done
image_repository="${CODEXIA_IMAGE_REPOSITORY:-}"
[[ "$image_repository" =~ ^ghcr\.io/[a-z0-9-]+/codexia-backend$ ]] || fail 'A reviewed image repository is required'
image="$(jq -er 'select(.format == "codexia-push-deployment/v1" and .identity.format == "codexia-backend-identity/v1" and .identity.profile == "full") |
  .image' "$release")"
[[ "$image" == "$image_repository@"* && "${image#*@}" =~ ^sha256:[a-f0-9]{64}$ ]] ||
  fail 'Committed image differs from the reviewed image repository'
image_id="$(podman image inspect --format '{{.Id}}' "$image")"
[[ "${image_id#sha256:}" =~ ^[a-f0-9]{64}$ ]] || fail 'Committed Full image is unavailable'
volume="$(podman volume inspect --format '{{.Name}}|{{.Mountpoint}}' codexia-postgres)"
mount="$(podman inspect --format '{{range .Mounts}}{{if eq .Destination "/var/lib/postgresql/data"}}{{.Name}}|{{.Source}}{{end}}{{end}}' codexia-db)"
[[ "$volume" == codexia-postgres\|/* && "$mount" == "$volume" ]] || fail 'Database container does not use the committed host volume'
authority="$({ sha256sum -- /etc/machine-id "$release" "$units/codexia-api.container" "$units/codexia-db.container" "$units/codexia-postgres.volume" &&
  printf '%s\n' "$volume"; } | sha256)"
recipe="$(printf '%s\n%s\n' "$dropin_contents" "$expected_hba" | sha256)"

verify_api(){
  local running live_image
  running="$(podman inspect --format '{{.State.Running}} {{.State.Health.Status}} {{.Image}}' codexia-api)" || return 1
  live_image="${running##* }"
  [[ "$running" == "true healthy $live_image" && "${live_image#sha256:}" == "${image_id#sha256:}" &&
     "$(systemctl --user show "$api_service" --property=SourcePath --value)" == "$units/codexia-api.container" ]]
}
stop_writer(){
  local status=0
  systemctl --user is-active --quiet "$tunnel_service" || status=$?
  case "$status" in 0) systemctl --user stop "$tunnel_service" || return 1 ;; 3|4) ;; *) return 1 ;; esac
  systemctl --user stop "$api_service" &&
    [[ "$(systemctl --user show "$api_service" -p ActiveState --value)" == inactive ]]
}
resume_writer(){
  systemctl --user start "$api_service" && verify_api || return 1
  if [[ "$tunnel_active" == true ]]; then systemctl --user start "$tunnel_service" || return 1; fi
}
restart_database(){
  systemctl --user daemon-reload && systemctl --user restart "$db_service" &&
    timeout 30s podman wait --condition=healthy codexia-db >/dev/null
}
write_intent() (
  set -e
  temporary="$(mktemp "$state/.backup-socket.XXXXXXXX")"
  trap 'rm -f -- "$temporary"' EXIT
  jq -n --arg format "$format" --arg phase "$1" --arg authority "$authority" --arg recipe "$recipe" --arg database "$database_identity" \
    --arg previousSocket "$previous_socket" --arg previousHba "$previous_hba" --argjson tunnelActive "$tunnel_active" \
    '{$format, $phase, $authority, $recipe, $database, $previousSocket, $previousHba, $tunnelActive}' > "$temporary" &&
    sync -f "$temporary" && mv -T -- "$temporary" "$intent" && sync -f "$state"
)
clear_intent(){ rm -- "$intent" && sync -f "$state"; }
verify_previous_database(){
  [[ "$(admin_query "$identity_sql")" == "$database_identity" &&
     "$(admin_query 'SHOW unix_socket_directories')" == "$previous_socket" && "$(admin_query 'SHOW hba_file')" == "$previous_hba" ]]
}
restore_previous(){
  stop_writer || return 1
  if exists "$dropin"; then
    verify_dropin && rm -- "$dropin" && sync -f "${dropin%/*}" && systemctl --user daemon-reload || return 1
  fi
  if ! verify_previous_database; then restart_database && verify_previous_database || return 1; fi
  resume_writer && clear_intent
}

if [[ "$resuming" == true ]]; then
  jq -e --arg authority "$authority" --arg recipe "$recipe" --arg database "$database_identity" \
    '.authority == $authority and .recipe == $recipe and .database == $database' "$intent" >/dev/null ||
    fail 'Socket transaction no longer matches the recorded host, release or PostgreSQL cluster'
  previous_socket="$(jq -er .previousSocket "$intent")"
  previous_hba="$(jq -er .previousHba "$intent")"
  tunnel_active="$(jq -r .tunnelActive "$intent")"
  if [[ "$(jq -er .phase "$intent")" == rollback ]]; then
    restore_previous || fail 'Prior socket and writer recovery requires operator attention'
    printf '%s\n' PRIVATE_BACKUP_SOCKET_RECOVERED
    exit 0
  fi
else
  systemctl --user is-active --quiet "$api_service" && verify_api || fail 'Socket provisioning requires the healthy committed API'
  tunnel_status=0
  systemctl --user is-active --quiet "$tunnel_service" || tunnel_status=$?
  case "$tunnel_status" in 0) tunnel_active=true ;; 3|4) tunnel_active=false ;; *) fail 'Cannot observe the Tunnel before socket provisioning' ;; esac
  previous_socket="$(admin_query 'SHOW unix_socket_directories')"
  previous_hba="$(admin_query 'SHOW hba_file')"
  [[ "$previous_socket" =~ ^[^[:cntrl:]]+$ && "$previous_hba" =~ ^/[^[:cntrl:]]+$ ]] || fail 'Cannot observe prior PostgreSQL socket settings'
  write_intent pending
fi
rollback(){
  local status=$?
  if [[ "$status" != 0 ]]; then
    write_intent rollback && restore_previous || echo 'Socket transition recovery requires operator attention; transaction retained' >&2
  fi
}
trap rollback EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
if ! verify_database; then
  stop_writer
  if ! exists "$dropin"; then
    if ! exists "${dropin%/*}"; then install -d -m 0700 -- "${dropin%/*}"; fi
    private_directory "${dropin%/*}" || fail 'PostgreSQL drop-in directory must be private'
    temporary_dropin="$(mktemp "${dropin%/*}/.backup-socket.XXXXXX")"
    printf '%s\n' "$dropin_contents" > "$temporary_dropin"
    sync -f "$temporary_dropin"
    mv -T -- "$temporary_dropin" "$dropin"
    sync -f "${dropin%/*}"
  fi
  restart_database
fi
verify_dropin && verify_database || fail 'Replacement PostgreSQL service did not pass the private socket checks'
resume_writer
clear_intent
trap - EXIT INT TERM
printf '%s\n' PRIVATE_BACKUP_SOCKET_CONFIGURED
