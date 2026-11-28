#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

state_dir="$HOME/.local/state/codexia-deploy"
export CODEXIA_PUSH_STATE_DIR="$state_dir"
backup_program="$HOME/.local/bin/codexia-backup"
control="$HOME/.local/bin/codexia-backup-control"
intent="$state_dir/backup-transaction"
lock_file="$state_dir/host.lock"
readonly intent_format=codexia-backup-transaction/v2
readonly uuid='^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
readonly image_pattern='^ghcr\.io/[a-z0-9][a-z0-9-]*/codexia-backend@sha256:[a-f0-9]{64}$'

die(){ echo "$*" >&2; exit 1; }
exists(){ [[ -e "$1" || -L "$1" ]]; }
private_file(){ [[ -f "$1" && ! -L "$1" && -O "$1" && "$(stat -c %a -- "$1")" == 600 ]]; }

read_artifact(){
  local destination_dir="$1" expected_id="$2" artifact_dir digest extra
  IFS= read -r artifact_dir && IFS= read -r digest && ! IFS= read -r extra || return 1
  artifact_dir="${artifact_dir#Encrypted backup committed: }"
  digest="${digest#Published checksum manifest sha256: }"
  [[ "$artifact_dir" == "$destination_dir/$expected_id" && "$digest" =~ ^[a-f0-9]{64}$ ]] || return 1
  [[ "$("$backup_program" validate-artifact "$artifact_dir")" == "$digest" ]] || return 1
  printf '%s\n%s\n' "$artifact_dir" "$digest"
}

load_staging(){
  destination="${CODEXIA_BACKUP_DESTINATION:?Protected staging directory is required}"
  recipient="${CODEXIA_BACKUP_AGE_RECIPIENT:?Protected age recipient is required}"
  "$backup_program" validate-destination "$destination" >/dev/null
}

produce_artifact(){
  local artifact_id="$1" output
  output="$("$backup_program" backup-locked "$destination" "$recipient" \
    --approved --lock-file "$lock_file" --lock-fd 9 --artifact-id "$artifact_id")" || return 1
  read_artifact "$destination" "$artifact_id" <<< "$output"
}

case "${1:-}" in
  deploy-check)
    [[ $# == 1 ]] || die 'Invalid backup staging check'
    load_staging
    exit
    ;;
  deploy-backup)
    [[ $# == 2 && "$2" =~ $uuid ]] || die 'Invalid deployment backup run'
    load_staging
    # The deployment transaction already owns descriptor 9. The producer verifies it.
    produce_artifact "codexia-$(date -u +%Y%m%dT%H%M%SZ)-$2"
    exit
    ;;
esac

[[ $# == 1 && ( "$1" == recover || "$1" =~ $uuid ) ]] || die 'Invalid backup run request'
[[ "$state_dir" == /* && -d "$state_dir" && ! -L "$state_dir" && -O "$state_dir" &&
   "$(stat -c %a -- "$state_dir")" == 700 ]] || die 'Invalid private backup state directory'
if exists "$lock_file"; then
  [[ -f "$lock_file" && ! -L "$lock_file" && -O "$lock_file" ]] || die 'Unsafe backup host lock'
fi
exec 9>>"$lock_file"
flock --exclusive --nonblock 9 || exit 75
# An active runner may still be preparing its intent under the host lock.
if ! exists "$intent" && [[ "$1" == recover ]]; then exit 0; fi

# Backup can resume the exact VM-local committed image. A pending intent
# cannot select an image, even if another repository published its digest.
release="$state_dir/deployed-release.json"
private_file "$release" || die 'A committed deployment record is required for backup'
image="$(jq -er '.image' "$release")"
[[ "$image" =~ $image_pattern ]] || die 'Invalid committed deployment image'
if [[ -n "${CODEXIA_IMAGE_REPOSITORY:-}" && "${image%@*}" != "$CODEXIA_IMAGE_REPOSITORY" ]]; then
  die 'The committed deployment image belongs to a different repository'
fi

same_running_image(){
  local expected actual
  expected="$(podman image inspect --format '{{.Id}}' "$1")" &&
    actual="$(podman inspect --format '{{.Image}}' codexia-api)" &&
    [[ "${expected#sha256:}" =~ ^[a-f0-9]{64}$ && "${actual#sha256:}" == "${expected#sha256:}" ]]
}

gate_control(){ sudo -n /usr/local/sbin/codexia-api-gate "$@"; }
require_management(){ systemctl is-active --quiet codexia-cloudflared.service; }
close_gate(){ gate_control close && [[ "$(gate_control status)" == closed ]]; }

resume_services(){
  local image="$1" previous_gate="$2"
  require_management || return 1
  # Closing first also recovers an interrupted gate transition.
  if [[ "$(gate_control status)" != "$previous_gate" ]] || ! systemctl --user is-active --quiet codexia-api.service; then
    close_gate || return 1
  fi
  if ! systemctl --user is-active --quiet codexia-api.service; then
    systemctl --user reset-failed codexia-api.service >/dev/null 2>&1 || :
    systemctl --user start codexia-api.service || return 1
  fi
  same_running_image "$image" && [[ "$(podman inspect --format '{{.State.Health.Status}}' codexia-api)" == healthy ]] || return 1
  if [[ "$previous_gate" == open && "$(gate_control status)" != open ]]; then
    gate_control open || return 1
  fi
  [[ "$(gate_control status)" == "$previous_gate" ]]
}

clear_intent(){
  rm -- "$intent" && sync -f "$state_dir"
}

write_intent() (
  temporary=
  temporary="$(mktemp "$state_dir/.backup-transaction.XXXXXXXX")"
  trap 'rm -f -- "$temporary"' EXIT
  printf '%s\n' "$intent_format" "$@" > "$temporary"
  sync -f "$temporary"
  mv -T -- "$temporary" "$intent"
  sync -f "$state_dir"
  trap - EXIT
)

finish_transfer(){
  local status=0
  if "$control" manual-finish "$@"; then
    clear_intent || die 'Could not remove the completed backup intent'
    return 0
  else
    status=$?
  fi
  [[ "$status" == 1 ]] || die 'Backup transfer reconciliation is pending'
  "$control" manual-interrupted "$1" || die 'Backup run reconciliation is pending'
  clear_intent || die 'Could not remove the reconciled backup intent'
  return 1
}

if exists "$intent"; then
  private_file "$intent" || die 'Unsafe pending backup intent'
  mapfile -t pending < "$intent"
  [[ "${pending[0]:-}" == "$intent_format" ]] ||
    die 'Unrecognized backup intent; preserve it and recover using its originating protected release'
  pending=("${pending[@]:1}")
  [[ "${#pending[@]}" -ge 4 && "${#pending[@]}" -le 5 && "${pending[0]}" =~ $uuid &&
     ( "${pending[2]}" == open || "${pending[2]}" == closed ) ]] || die 'Invalid pending backup intent'
  [[ "${pending[1]}" == "$image" ]] || die 'Pending backup intent does not match the committed deployment'
  [[ "${pending[3]}" == /* && "${pending[3]##*/}" =~ ^codexia-[0-9]{8}T[0-9]{6}Z-${pending[0]}$ ]] ||
    die 'Invalid pending backup artifact path'
  resume_services "${pending[1]}" "${pending[2]}" || die 'Backup service recovery is pending'
  digest=
  if exists "${pending[3]}"; then
    digest="$("$backup_program" validate-artifact "${pending[3]}")" || digest=
  fi
  if [[ "$digest" =~ ^[a-f0-9]{64}$ && "$digest" == "${pending[4]:-$digest}" ]]; then
    # Publication is atomic at the path recorded before writer quiesce.
    finish_transfer "${pending[0]}" "${pending[3]}" "$digest" || :
  else
    "$control" manual-interrupted "${pending[0]}" || die 'Backup run reconciliation is pending'
    clear_intent
  fi
fi
[[ "$1" != recover ]] || exit 0

for transaction in deploy-transaction.json cutover-transaction.json; do
  if exists "$state_dir/$transaction"; then exit 75; fi
done
run_id="$1"
load_staging
systemctl --user is-active --quiet codexia-api.service
[[ "$(podman inspect --format '{{.State.Health.Status}}' codexia-api)" == healthy ]] || die 'The backup requires a healthy API'
same_running_image "$image" || die 'The running API differs from the admitted image'
source_sha="$(podman exec codexia-api cat /app/update-identity.json |
  jq -er --slurpfile record "$release" 'select(. == $record[0].identity and .format == "codexia-backend-identity/v1" and .profile == "full") | .sourceSha')"
[[ "$source_sha" =~ ^[a-f0-9]{40}$ ]] || die 'The admitted API source identity is invalid'
require_management || die 'Management Tunnel connector is unavailable'
previous_gate="$(gate_control status)" || die 'Could not observe product publication gate for backup'
[[ "$previous_gate" == open || "$previous_gate" == closed ]] || die 'Product publication gate state is invalid'
"$control" manual-start "$run_id" "$source_sha" "${image##*@}" >/dev/null

# Persist the publication state before stopping the writer. Keep it through remote
# verification so a process death cannot leave a running receipt unaccounted for.
artifact_id="codexia-$(date -u +%Y%m%dT%H%M%SZ)-$run_id"
artifact_path="$destination/$artifact_id"
write_intent "$run_id" "$image" "$previous_gate" "$artifact_path"

if ! close_gate ||
   ! systemctl --user stop codexia-api.service; then
  resume_services "$image" "$previous_gate" || die 'Backup service recovery is pending'
  "$control" manual-fail "$run_id" quiesce_failed
  clear_intent
  die 'Could not quiesce services for backup'
fi
result="$(produce_artifact "$artifact_id")" || result=
if [[ -n "$result" ]]; then
  mapfile -t artifact <<< "$result"
  write_intent "$run_id" "$image" "$previous_gate" "${artifact[@]}"
fi
resume_services "$image" "$previous_gate" || die 'Backup service recovery is pending'
if [[ -z "$result" ]]; then
  "$control" manual-fail "$run_id" backup_failed
  clear_intent
  die 'Encrypted backup failed'
fi
finish_transfer "$run_id" "${artifact[@]}" || die 'Remote backup verification failed'
