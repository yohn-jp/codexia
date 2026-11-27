#!/usr/bin/env bash
set -Eeuo pipefail

settings="$HOME/.config/codexia-backup/executor.env"
if [[ ! -f "$settings" || -L "$settings" || ! -O "$settings" || "$(stat -c %a -- "$settings")" != 600 ]]; then
  echo 'Backup executor requires an owner-only environment file' >&2
  exit 1
fi
release="$HOME/.local/share/codexia-backup/current"
node="$release/bin/node"
command=backup-console-control.js
if [[ $# == 0 ]]; then command=backup-console-executor.js; fi
entrypoint="$(realpath -e -- "$release/app/node_modules/@codexia/api/dist/$command")" &&
  [[ -x "$node" && -f "$entrypoint" ]] || { echo 'Certified backup runtime is unavailable' >&2; exit 1; }
database="${settings%/*}/database.env"
env_files=()
if [[ -e "$database" || -L "$database" ]]; then
  [[ -f "$database" && ! -L "$database" && -O "$database" && "$(stat -c %a -- "$database")" == 600 ]] ||
    { echo 'Backup database settings must be owner-only' >&2; exit 1; }
  env_files+=("--env-file=$database")
fi
env_files+=("--env-file=$settings")
# Load the same protected settings for manual, scheduled and deployment backups.
# Do not forward Ansible or SSH environment values.
runtime_dir="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
runtime_env=(env -i HOME="$HOME" PATH=/usr/local/bin:/usr/bin:/bin LANG=C.UTF-8
  XDG_RUNTIME_DIR="$runtime_dir" DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-unix:path=$runtime_dir/bus}")


case "${1:-}" in
  reconcile-restored-journal|reconcile-restored-absence)
    umask 077
    state="$HOME/.local/state/codexia-deploy"
    [[ -d "$state" && ! -L "$state" && -O "$state" && "$(stat -c %a -- "$state")" == 700 ]] ||
      { echo 'Backup reconciliation requires private push state' >&2; exit 1; }
    lock="$state/host.lock"
    [[ ! -L "$lock" && ( ! -e "$lock" || ( -f "$lock" && -O "$lock" ) ) ]] || exit 1
    exec 9>>"$lock"
    flock --exclusive --nonblock 9 || exit 75
    worker_state="$(systemctl --user show codexia-backup-executor.service --property=ActiveState --value)"
    worker_enablement="$(systemctl --user show codexia-backup-executor.service --property=UnitFileState --value)"
    [[ ( "$worker_state" == inactive || "$worker_state" == failed ) && "$worker_enablement" == disabled ]] ||
      { echo 'Stop and disable the backup executor before reconciling a restored journal' >&2; exit 1; }
    ;;
  deploy-check|deploy-backup)
    staging="$("${runtime_env[@]}" "$node" "${env_files[@]}" -e '
      const { CODEXIA_BACKUP_DESTINATION: destination, CODEXIA_BACKUP_AGE_RECIPIENT: recipient } = process.env;
      if (!destination || !recipient || !/^\/[^\x00-\x1f\x7f]+$/.test(destination) || !/^age1[0-9a-z]+$/.test(recipient)) process.exit(1);
      process.stdout.write(destination + "\n" + recipient);
    ')" || { echo 'Protected backup staging settings are invalid' >&2; exit 1; }
    mapfile -t values <<< "$staging"
    exec "${runtime_env[@]}" CODEXIA_BACKUP_DESTINATION="${values[0]}" CODEXIA_BACKUP_AGE_RECIPIENT="${values[1]}" \
      "$HOME/.local/bin/codexia-backup-runner" "$@"
    ;;
esac
exec "${runtime_env[@]}" "$node" "${env_files[@]}" "$entrypoint" "$@"
