#!/usr/bin/env bash

set -Eeuo pipefail

state_dir="${CODEXIA_PUSH_STATE_DIR:?Push deployment state directory is required}"
unit_dir="${CODEXIA_PUSH_QUADLET_DIR:?Push deployment Quadlet directory is required}"
[[ "$state_dir" == /* && "$unit_dir" == /* && "$state_dir" != *$'\n'* && "$unit_dir" != *$'\n'* ]] || {
  echo 'Push recovery paths must be absolute single-line paths' >&2
  exit 2
}

active_unit="$unit_dir/codexia-api.container"
api_wants_link="$unit_dir/default.target.wants/codexia-api.service"
tunnel_wants_link="$unit_dir/default.target.wants/codexia-tunnel.service"
intent="$state_dir/deploy-transaction.json"
release_state="$state_dir/deployed-release.json"
lock_file="$state_dir/host.lock"

mkdir -p -- "$state_dir"
exec 9>"$lock_file"
flock --exclusive --nonblock 9 || {
  echo 'Another Codexia deployment or backup holds the host lock' >&2
  exit 75
}

[[ -e "$intent" || -L "$intent" ]] || exit 0
[[ -f "$intent" && ! -L "$intent" ]] || {
  echo 'Deployment transaction intent is not a regular file' >&2
  exit 1
}

if ! recovery="$(node - "$intent" "$state_dir/rollback-release.json" "$state_dir/rollback-api.container" <<'NODE'
const fs = require('node:fs');
const value = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (value.format !== 'codexia-deploy-transaction/v1' || !['pending', 'committed'].includes(value.phase) ||
    typeof value.hadUnit !== 'boolean' || typeof value.tunnelWasActive !== 'boolean' ||
    typeof value.apiLinkCreated !== 'boolean' || typeof value.tunnelLinkCreated !== 'boolean' ||
    typeof value.releasePresent !== 'boolean') process.exit(2);
let previousImage = '';
if (value.phase === 'pending' && value.hadUnit) {
  const unitInfo = fs.lstatSync(process.argv[4]);
  if (!unitInfo.isFile() || unitInfo.isSymbolicLink()) process.exit(2);
  const unit = fs.readFileSync(process.argv[4], 'utf8');
  const unitMatch = unit.match(/^Image=(\S+)$/m);
  const unitImage = unitMatch?.[1] ?? '';
  if (!/^ghcr\.io\/yohn-jp\/codexia-backend@sha256:[a-f0-9]{64}$/.test(unitImage)) process.exit(2);
  if (value.releasePresent) {
    const info = fs.lstatSync(process.argv[3]);
    if (!info.isFile() || info.isSymbolicLink()) process.exit(2);
    const release = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
    previousImage = release.image;
  } else {
    previousImage = unitImage;
  }
  if (previousImage !== unitImage || !/^ghcr\.io\/yohn-jp\/codexia-backend@sha256:[a-f0-9]{64}$/.test(previousImage)) process.exit(2);
}
process.stdout.write([value.format, value.phase, value.hadUnit, value.tunnelWasActive,
  value.apiLinkCreated, value.tunnelLinkCreated, value.releasePresent, previousImage || '-'].join('\n'));
NODE
)"
then
  echo 'Invalid deployment transaction or prior release snapshot' >&2
  exit 1
fi
mapfile -t recovery_fields <<< "$recovery"
[[ "${recovery_fields[0]:-}" == codexia-deploy-transaction/v1 && ${#recovery_fields[@]} == 8 ]] || {
  echo 'Invalid deployment transaction intent' >&2
  exit 1
}

if [[ "${recovery_fields[1]}" == committed ]]; then
  rm -f -- "$intent" "$intent.tmp" "$state_dir/rollback-api.container" "$state_dir/rollback-release.json"
  echo 'CLEANED_COMMITTED_TRANSACTION'
  exit 0
fi

had_unit="${recovery_fields[2]}"
tunnel_was_active="${recovery_fields[3]}"
api_link_created="${recovery_fields[4]}"
tunnel_link_created="${recovery_fields[5]}"
release_present="${recovery_fields[6]}"
previous_image="${recovery_fields[7]}"
[[ "$previous_image" == '-' ]] && previous_image=''
if systemctl --user cat codexia-tunnel.service >/dev/null 2>&1 &&
   ! systemctl --user stop codexia-tunnel.service >/dev/null 2>&1; then
  echo 'Could not stop the active Tunnel during interrupted deployment recovery; recovery intent retained' >&2
  exit 1
fi
if [[ "$had_unit" == true || -e "$active_unit" || -L "$active_unit" ]] &&
   ! systemctl --user stop codexia-api.service >/dev/null 2>&1; then
  echo 'Could not stop the active API during interrupted deployment recovery; recovery intent retained' >&2
  exit 1
fi

if [[ "$had_unit" == true ]]; then
  [[ -f "$state_dir/rollback-api.container" && ! -L "$state_dir/rollback-api.container" ]] || {
    echo 'Interrupted deployment has no safe prior API unit snapshot' >&2
    exit 1
  }
  install -m 0644 -- "$state_dir/rollback-api.container" "$active_unit"
  systemctl --user daemon-reload
  systemctl --user start codexia-api.service
  healthy=false
  for attempt in $(seq 1 30); do
    if podman inspect --format '{{.State.Health.Status}}' codexia-api 2>/dev/null | grep -Fxq healthy; then
      healthy=true
      break
    fi
    sleep 2
  done
  [[ "$healthy" == true ]] || {
    echo 'Prior API did not recover from interrupted deployment' >&2
    exit 1
  }
  running_image="$(podman inspect --format '{{.ImageName}}' codexia-api 2>/dev/null)" || {
    echo 'Could not verify the recovered API image; recovery intent retained' >&2
    exit 1
  }
  [[ "$running_image" == "$previous_image" ]] || {
    echo 'Recovered API image does not match the recorded prior release; recovery intent retained' >&2
    exit 1
  }
else
  rm -f -- "$active_unit"
  if [[ "$api_link_created" == true && ( -e "$api_wants_link" || -L "$api_wants_link" ) ]]; then
    [[ -L "$api_wants_link" && "$(readlink -- "$api_wants_link")" == ../codexia-api.service ]] || {
      echo 'Unexpected API activation link during interrupted deployment recovery' >&2
      exit 1
    }
    rm -f -- "$api_wants_link"
  fi
  if [[ "$tunnel_link_created" == true && ( -e "$tunnel_wants_link" || -L "$tunnel_wants_link" ) ]]; then
    [[ -L "$tunnel_wants_link" && "$(readlink -- "$tunnel_wants_link")" == ../codexia-tunnel.service ]] || {
      echo 'Unexpected Tunnel activation link during interrupted deployment recovery' >&2
      exit 1
    }
    rm -f -- "$tunnel_wants_link"
  fi
  systemctl --user daemon-reload
fi

if [[ "$release_present" == true ]]; then
  [[ -f "$state_dir/rollback-release.json" && ! -L "$state_dir/rollback-release.json" ]] || {
    echo 'Interrupted deployment has no safe prior release snapshot' >&2
    exit 1
  }
  install -m 0600 -- "$state_dir/rollback-release.json" "$release_state"
else
  rm -f -- "$release_state"
fi

if [[ "$tunnel_was_active" == true && "$had_unit" == true ]]; then
  systemctl --user start codexia-tunnel.service
fi

rm -f -- "$intent" "$intent.tmp" "$state_dir/rollback-api.container" "$state_dir/rollback-release.json"
echo 'RECOVERED_PREVIOUS_RELEASE'
