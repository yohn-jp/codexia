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

[[ ! -e "$state_dir/cutover-transaction.json" && ! -L "$state_dir/cutover-transaction.json" ]] || {
  echo 'Coordinated API epoch maintenance is pending; ordinary deployment is blocked' >&2
  exit 1
}

[[ -e "$intent" || -L "$intent" ]] || exit 0
[[ -f "$lock_file" && ! -L "$lock_file" ]] || {
  echo 'Deployment transaction is missing its regular host lock; recovery state retained' >&2
  exit 1
}
exec 9>>"$lock_file"
flock --exclusive --nonblock 9 || {
  echo 'Another Codexia deployment or backup holds the host lock' >&2
  exit 75
}

[[ ! -e "$state_dir/cutover-transaction.json" && ! -L "$state_dir/cutover-transaction.json" ]] || {
  echo 'Coordinated API epoch maintenance is pending; ordinary deployment is blocked' >&2
  exit 1
}

[[ -e "$intent" || -L "$intent" ]] || exit 0
[[ -f "$intent" && ! -L "$intent" ]] || {
  echo 'Deployment transaction intent is not a regular file' >&2
  exit 1
}

if ! recovery="$(node - "$intent" "$state_dir/rollback-release.json" "$state_dir/rollback-api.container" "$release_state" "$active_unit" <<'NODE'
const fs = require('node:fs');
const { createHash } = require('node:crypto');
const value = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (value.format !== 'codexia-deploy-transaction/v1' || !['pending', 'committed'].includes(value.phase) ||
    typeof value.hadUnit !== 'boolean' || typeof value.tunnelWasActive !== 'boolean' ||
    typeof value.apiLinkCreated !== 'boolean' || typeof value.tunnelLinkCreated !== 'boolean' ||
    typeof value.releasePresent !== 'boolean' ||
    (value.backupRunId !== undefined && (typeof value.backupRunId !== 'string' ||
      !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value.backupRunId)))) process.exit(2);
function reviewedReleaseImage(unitPath, releasePath) {
  const unitInfo = fs.lstatSync(unitPath, { throwIfNoEntry: false });
  if (!unitInfo?.isFile()) process.exit(2);
  const unit = fs.readFileSync(unitPath, 'utf8');
  const images = [...unit.matchAll(/^Image=([^\r\n]*)$/gm)].map(match => match[1]);
  const modes = [...unit.matchAll(/^Environment=CODEXIA_AUTH_MODE=([^\r\n]*)$/gm)].map(match => match[1]);
  const digests = [...unit.matchAll(/^Environment=CODEXIA_AUTH_SETTINGS_SHA256=([^\r\n]*)$/gm)].map(match => match[1]);
  const files = [...unit.matchAll(/^EnvironmentFile=([^\r\n]*)$/gm)].map(match => match[1]);
  const [image] = images;
  const [digest] = digests;
  const [file] = files;
  if (images.length !== 1 || !/^ghcr\.io\/yohn-jp\/codexia-backend@sha256:[a-f0-9]{64}$/.test(image) ||
      modes.length !== 1 || modes[0] !== 'better-auth' ||
      digests.length !== 1 || !/^[a-f0-9]{64}$/.test(digest) || files.length !== 1 ||
      !file.startsWith('/') || !file.endsWith('/.config/codexia-auth/runtime-' + digest + '.env')) process.exit(2);
  const settings = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!settings?.isFile() || settings.uid !== process.getuid() || (settings.mode & 0o777) !== 0o600 ||
      createHash('sha256').update(fs.readFileSync(file)).digest('hex') !== digest) process.exit(2);
  const releaseInfo = fs.lstatSync(releasePath, { throwIfNoEntry: false });
  if (!releaseInfo?.isFile()) process.exit(2);
  const release = JSON.parse(fs.readFileSync(releasePath, 'utf8'));
  if (release.authMode !== 'better-auth' || release.authSettingsSha256 !== digest || release.image !== image) process.exit(2);
  if (value.phase === 'committed' &&
      (release.format !== 'codexia-push-deployment/v1' ||
        value.candidateImage !== image || value.authSettingsSha256 !== digest ||
        [unitInfo, releaseInfo].some(info => info.uid !== process.getuid() || (info.mode & 0o777) !== 0o600))) process.exit(2);
  return image;
}
let releaseImage = '';
if (value.phase === 'committed') {
  releaseImage = reviewedReleaseImage(process.argv[6], process.argv[5]);
} else if (value.hadUnit) {
  if (!value.releasePresent) process.exit(2);
  releaseImage = reviewedReleaseImage(process.argv[4], process.argv[3]);
}
process.stdout.write([value.format, value.phase, value.hadUnit, value.tunnelWasActive,
  value.apiLinkCreated, value.tunnelLinkCreated, value.releasePresent,
  releaseImage || '-', value.backupRunId ?? '-'].join('\n'));
NODE
)"
then
  echo 'Invalid deployment transaction or prior release snapshot. Verify the committed release. Recover older deployments using their recording release; recovery state retained.' >&2
  exit 1
fi
mapfile -t recovery_fields <<< "$recovery"
[[ "${recovery_fields[0]:-}" == codexia-deploy-transaction/v1 && ${#recovery_fields[@]} == 9 ]] || {
  echo 'Invalid deployment transaction intent' >&2
  exit 1
}

if [[ "${recovery_fields[1]}" == committed ]]; then
  committed_image="${recovery_fields[7]}"
  if ! source_path="$(systemctl --user show --property=SourcePath --value codexia-api.service)" ||
     [[ "$source_path" != "$active_unit" ]] ||
     ! systemctl --user is-active --quiet codexia-api.service ||
     ! running="$(podman inspect --format '{{.State.Running}} {{.State.Health.Status}} {{.ImageName}}' codexia-api)" ||
     [[ "$running" != "true healthy $committed_image" ]]; then
    echo 'Committed deployment does not match the healthy active release; recovery state retained' >&2
    exit 1
  fi
  rm -f -- "$intent" "$intent.tmp" "$release_state.tmp" "$state_dir/rollback-api.container" "$state_dir/rollback-release.json"
  sync -f "$state_dir"
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
stop_loaded_unit(){
  local unit="$1" load_state active_status
  load_state="$(systemctl --user show --property=LoadState --value "$unit")" || {
    echo "Could not inspect systemd load state for $unit" >&2
    return 1
  }
  case "$load_state" in
    loaded)
      systemctl --user stop "$unit" >/dev/null 2>&1 || {
        echo "Could not stop $unit" >&2
        return 1
      }
      if systemctl --user is-active --quiet "$unit"; then
        echo "$unit remains active after stop" >&2
        return 1
      else
        active_status=$?
      fi
      [[ "$active_status" == 3 ]] || {
        echo "Could not verify that $unit is inactive" >&2
        return 1
      }
      ;;
    not-found)
      return 2
      ;;
    *)
      echo "Unexpected systemd load state for $unit: $load_state" >&2
      return 1
      ;;
  esac
}
api_load_status=0
stop_loaded_unit codexia-tunnel.service || api_load_status=$?
[[ "$api_load_status" == 0 || "$api_load_status" == 2 ]] || {
  echo 'Could not stop and verify the application Tunnel; recovery intent retained' >&2
  exit 1
}
api_load_status=0
stop_loaded_unit codexia-api.service || api_load_status=$?
if [[ "$api_load_status" == 2 ]]; then
  [[ "$had_unit" == false ]] || {
    echo 'Prior API service is missing from systemd; recovery intent retained' >&2
    exit 1
  }
  container_status=0
  podman container exists codexia-api >/dev/null 2>&1 || container_status=$?
  case "$container_status" in
    1) ;;
    0)
      running="$(podman inspect --format '{{.State.Running}}' codexia-api 2>/dev/null)" || {
        echo 'Could not inspect the API container while its systemd unit is absent; recovery intent retained' >&2
        exit 1
      }
      [[ "$running" == false ]] || {
        echo 'API container may still be running without a loaded systemd unit; recovery intent retained' >&2
        exit 1
      }
      ;;
    *)
      echo 'Could not inspect API container state while its systemd unit is absent; recovery intent retained' >&2
      exit 1
      ;;
  esac
elif [[ "$api_load_status" != 0 ]]; then
  echo 'Could not stop and verify the active API; recovery intent retained' >&2
  exit 1
fi

if [[ "$had_unit" == true ]]; then
  [[ -f "$state_dir/rollback-api.container" && ! -L "$state_dir/rollback-api.container" ]] || {
    echo 'Interrupted deployment has no safe prior API unit snapshot' >&2
    exit 1
  }
  install -m 0600 -- "$state_dir/rollback-api.container" "$active_unit"
  systemctl --user daemon-reload
  # A failed candidate may have exhausted systemd\x27s start limit. Reset only
  # after restoring the prior unit, so recovery can start the known-good API.
  systemctl --user reset-failed codexia-api.service
  systemctl --user start codexia-api.service
  podman inspect --format '{{.State.Health.Status}}' codexia-api 2>/dev/null | grep -Fxq healthy || {
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
if [[ "${recovery_fields[8]}" != '-' ]]; then
  "$HOME/.local/bin/codexia-backup-control" deploy-interrupted "${recovery_fields[8]}" || {
    echo 'Backup run reconciliation is pending; deployment recovery state retained' >&2
    exit 1
  }
fi

rm -f -- "$intent" "$intent.tmp" "$release_state.tmp" "$state_dir/rollback-api.container" "$state_dir/rollback-release.json"
echo 'RECOVERED_PREVIOUS_RELEASE'
