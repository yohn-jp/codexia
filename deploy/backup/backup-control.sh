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
# The same private environment is used for the background executor and the
# protected deployment call. Do not forward Ansible or SSH environment values.
exec env -i HOME="$HOME" PATH=/usr/local/bin:/usr/bin:/bin LANG=C.UTF-8 \
  "$(command -v node)" --env-file="$settings" "${entrypoints[0]}" "$@"
