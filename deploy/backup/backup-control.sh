#!/usr/bin/env bash
set -Eeuo pipefail

settings="$HOME/.config/codexia-backup/executor.env"
if [[ ! -f "$settings" || -L "$settings" || ! -O "$settings" || "$(stat -c %a -- "$settings")" != 600 ]]; then
  echo 'Backup executor requires an owner-only environment file' >&2
  exit 1
fi
mapfile -t entrypoints < <(sed -n 's/^CODEXIA_BACKUP_EXECUTOR_ENTRYPOINT=//p' "$settings")
if [[ "${#entrypoints[@]}" != 1 || ! "${entrypoints[0]}" =~ ^/[^[:cntrl:]]+/backup-console-control\.js$ ||
      ! -f "${entrypoints[0]}" ]]; then
  echo 'Backup executor entry point is unavailable' >&2
  exit 1
fi
entrypoint="${entrypoints[0]}"
if [[ $# == 0 ]]; then
  entrypoint="${entrypoint%/*}/backup-console-executor.js"
  [[ -f "$entrypoint" ]] || { echo 'Backup console executor is unavailable' >&2; exit 1; }
fi
# Load the same protected settings for manual, scheduled and deployment backups.
# Do not forward Ansible or SSH environment values.
runtime_dir="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
runtime_env=(env -i HOME="$HOME" PATH=/usr/local/bin:/usr/bin:/bin LANG=C.UTF-8
  XDG_RUNTIME_DIR="$runtime_dir" DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-unix:path=$runtime_dir/bus}")
node="$(command -v node)"

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
    staging="$("${runtime_env[@]}" "$node" --env-file="$settings" -e '
      const { CODEXIA_BACKUP_DESTINATION: destination, CODEXIA_BACKUP_AGE_RECIPIENT: recipient } = process.env;
      if (!destination || !recipient || !/^\/[^\x00-\x1f\x7f]+$/.test(destination) || !/^age1[0-9a-z]+$/.test(recipient)) process.exit(1);
      process.stdout.write(destination + "\n" + recipient);
    ')" || { echo 'Protected backup staging settings are invalid' >&2; exit 1; }
    mapfile -t values <<< "$staging"
    exec "${runtime_env[@]}" CODEXIA_BACKUP_DESTINATION="${values[0]}" CODEXIA_BACKUP_AGE_RECIPIENT="${values[1]}" \
      "$HOME/.local/bin/codexia-backup-runner" "$@"
    ;;
esac
exec "${runtime_env[@]}" "$node" --env-file="$settings" "$entrypoint" "$@"
