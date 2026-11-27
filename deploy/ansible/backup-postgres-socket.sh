#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

state="$HOME/.local/state/codexia-deploy"
directory="$HOME/.local/share/codexia-backup-postgres"
socket="$directory/socket"
hba="$directory/pg_hba.conf"
dropin="$HOME/.config/containers/systemd/codexia-db.container.d/10-backup-socket.conf"
socket_in_db=/run/codexia-backup-postgresql
hba_in_db=/run/codexia-backup-pg_hba.conf
db_service=codexia-db.service
api_service=codexia-api.service

fail(){ printf '%s\n' "$1" >&2; exit 1; }
private_directory(){ [[ -d "$1" && ! -L "$1" && -O "$1" && "$(stat -c %a -- "$1")" == 700 ]]; }
private_file(){ [[ -f "$1" && ! -L "$1" && -O "$1" && "$(stat -c %a -- "$1")" == 600 ]]; }
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

[[ "$(podman info --format '{{.Host.Security.Rootless}}')" == true ]] || fail 'Private backup socket requires rootless Podman'
if [[ ! -e "$state" && ! -L "$state" ]]; then install -d -m 0700 -- "$state"; fi
private_directory "$state" || fail 'Private backup socket requires owned deployment state'
lock="$state/host.lock"
[[ ! -L "$lock" && ( ! -e "$lock" || ( -f "$lock" && -O "$lock" ) ) ]] || fail 'Invalid deployment host lock'
exec 9>>"$lock"
flock --exclusive --nonblock 9 || exit 75
[[ ! -e "$state/backup-transaction" && ! -L "$state/backup-transaction" &&
   ! -e "$state/deploy-transaction.json" && ! -L "$state/deploy-transaction.json" ]] || fail 'Recover interrupted host work before provisioning the socket'
database_ports="$(podman port codexia-db)"
[[ -z "$database_ports" ]] || fail 'Database port is published'
identity_sql='SELECT system_identifier || chr(58) || oid FROM pg_control_system(), pg_database WHERE datname=current_database()'
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
if [[ -e "$dropin" || -L "$dropin" ]]; then
  private_file "$dropin" && [[ "$(cat -- "$dropin")" == "$dropin_contents" ]] || fail 'Existing PostgreSQL socket drop-in differs from the approved source'
  verify_database || fail 'Existing PostgreSQL socket did not satisfy the approved boundary'
  exit 0
fi

worker_state="$(systemctl --user show codexia-backup-executor.service -p ActiveState --value)"
worker_enablement="$(systemctl --user show codexia-backup-executor.service -p UnitFileState --value)"
[[ "$worker_state" == inactive || "$worker_state" == failed ]] || fail 'Stop the backup executor before provisioning the socket'
[[ -z "$worker_enablement" || "$worker_enablement" == disabled || "$worker_enablement" == masked ]] ||
  fail 'Disable the backup executor before provisioning the socket'

case "$(systemctl --user show "$api_service" -p ActiveState --value)" in
  active) api_active=true ;;
  inactive|failed) api_active=false ;;
  *) fail 'API service is transitioning; retry after it settles' ;;
esac
installed=false
rollback(){
  local status=$?
  if [[ "$status" != 0 ]]; then
    if [[ "$installed" == true ]]; then
      if ! { rm -f -- "$dropin" && systemctl --user daemon-reload && systemctl --user restart "$db_service"; }; then
        printf '%s\n' 'PostgreSQL socket transition recovery requires operator attention' >&2
        return
      fi
    fi
    if [[ "$api_active" == true ]] && ! systemctl --user start "$api_service"; then
      printf '%s\n' 'The API service requires operator attention after restoring the PostgreSQL configuration' >&2
    fi
  fi
}
trap rollback EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
if [[ "$api_active" == true ]]; then systemctl --user stop "$api_service"; fi
if [[ ! -e "${dropin%/*}" && ! -L "${dropin%/*}" ]]; then install -d -m 0700 -- "${dropin%/*}"; fi
private_directory "${dropin%/*}" || fail 'PostgreSQL drop-in directory must be private'
temporary_dropin="$(mktemp "${dropin%/*}/.backup-socket.XXXXXX")"
printf '%s\n' "$dropin_contents" > "$temporary_dropin"
mv -T -- "$temporary_dropin" "$dropin"
installed=true
systemctl --user daemon-reload
systemctl --user restart "$db_service"
timeout 30s podman wait --condition=healthy codexia-db >/dev/null
verify_database || fail 'Replacement PostgreSQL service did not pass the private socket checks'
if [[ "$api_active" == true ]]; then systemctl --user start "$api_service"; fi
trap - EXIT INT TERM
printf '%s\n' PRIVATE_BACKUP_SOCKET_CONFIGURED
