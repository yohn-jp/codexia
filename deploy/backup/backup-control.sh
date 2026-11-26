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
  # Provision admission before the background executor can apply required S3
  # policy. A later loss of executor.env must not disable deployment admission.
  (
    umask 077
    state="$HOME/.local/state/codexia-deploy"
    [[ -d "$state" && ! -L "$state" && -O "$state" && "$(stat -c %a -- "$state")" == 700 ]] ||
      { echo 'Backup executor requires private push state' >&2; exit 1; }
    lock="$state/host.lock"
    [[ ! -L "$lock" && ( ! -e "$lock" || ( -f "$lock" && -O "$lock" ) ) ]] || exit 1
    exec 9>>"$lock"
    flock --exclusive --nonblock 9 || exit 75
    marker="$state/backup-admission-enabled"
    [[ ! -L "$marker" ]] || exit 1
    if [[ ! -e "$marker" ]]; then
      (set -o noclobber; : > "$marker")
      sync -f "$state"
    fi
    [[ -f "$marker" && -O "$marker" ]]
  )
fi
# The same private environment is used for the background executor and the
# protected deployment call. Do not forward Ansible or SSH environment values.
runtime_dir="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
exec env -i HOME="$HOME" PATH=/usr/local/bin:/usr/bin:/bin LANG=C.UTF-8 \
  XDG_RUNTIME_DIR="$runtime_dir" DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-unix:path=$runtime_dir/bus}" \
  "$(command -v node)" --env-file="$settings" "$entrypoint" "$@"
