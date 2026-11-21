#!/usr/bin/env bash
# Disposable Push host/bootstrap slice for the push deployment account.
set -Eeuo pipefail
umask 077

fail() { printf '%s\n' "$*" >&2; exit 1; }
[[ "${GITHUB_ACTIONS:-}" == true && "${CODEXIA_DISPOSABLE_HOST:-}" == push-host ]] || \
  fail 'Run only inside the dedicated disposable Push push-host workflow.'
[[ "$(lsb_release -rs)" == 26.04 && "$(uname -m)" == x86_64 ]] || fail 'Unsupported Push host.'
[[ "$(id -u)" != 0 ]] || fail 'The workflow must use its non-root bootstrap identity.'
[[ -n "${RUNNER_TEMP:-}" && -d "$RUNNER_TEMP" && "${GITHUB_SHA:-}" =~ ^[a-f0-9]{40}$ && "${GITHUB_RUN_ID:-}" =~ ^[0-9]+$ ]] || \
  fail 'GitHub run evidence environment is incomplete.'
ansible_playbook=${ANSIBLE_PLAYBOOK:-}
[[ -x "$ansible_playbook" ]] || fail 'The isolated Ansible control environment is unavailable.'

# This fixed account and UID are the fixture contract consumed by the future
# canonical push-convergence callable. They are created only on this ephemeral
# Actions host and are rejected if any part of the identity already exists.
service_user=codexia
service_uid=22001
service_group=codexia
service_gid=22001
service_home=/home/codexia
phase=preflight
if getent passwd "$service_user" >/dev/null 2>&1 || getent passwd "$service_uid" >/dev/null 2>&1 || \
   getent group "$service_group" >/dev/null 2>&1 || getent group "$service_gid" >/dev/null 2>&1 || \
   [[ -e "$service_home" || -L "$service_home" ]]; then
  fail 'Push-host fixture identity already exists; refusing adoption.'
fi

evidence_dir="$RUNNER_TEMP/codexia-push-host"
mkdir -m 0700 "$evidence_dir"
log_file="$evidence_dir/host-convergence.log"
identity_owned=false
rootless() (
  cd /
  sudo -H -u "$service_user" env HOME="$service_home" XDG_CONFIG_HOME="$service_home/.config" \
    XDG_DATA_HOME="$service_home/.local/share" XDG_STATE_HOME="$service_home/.local/state" \
    XDG_RUNTIME_DIR="/run/user/$service_uid" DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$service_uid/bus" \
    /usr/bin/podman "$@"
)
cleanup() {
  local status=$? cleanup_status=0 observed
  trap - EXIT
  set +e
  if [[ "$identity_owned" == true ]]; then
    if getent passwd "$service_user" >/dev/null 2>&1; then
      observed=$(getent passwd "$service_user")
      if [[ "$(id -u "$service_user" 2>/dev/null)" == "$service_uid" && \
            "$(id -g "$service_user" 2>/dev/null)" == "$service_gid" && \
            "$(printf '%s' "$observed" | cut -d: -f6)" == "$service_home" && \
            ! -L "$service_home" ]]; then
        sudo loginctl disable-linger "$service_user" >/dev/null 2>&1 || cleanup_status=1
        sudo systemctl stop "user@$service_uid.service" >/dev/null 2>&1 || true
        sudo userdel --remove "$service_user" >/dev/null 2>&1 || cleanup_status=1
        getent group "$service_group" >/dev/null 2>&1 && sudo groupdel "$service_group" >/dev/null 2>&1 || true
      else
        printf 'Refusing to remove a changed push-host fixture identity: %s\n' "$service_user" >&2
        cleanup_status=1
      fi
    else
      cleanup_status=1
    fi
  fi
  if getent passwd "$service_user" >/dev/null 2>&1 || getent passwd "$service_uid" >/dev/null 2>&1 || \
     getent group "$service_group" >/dev/null 2>&1 || getent group "$service_gid" >/dev/null 2>&1 || \
     [[ -e "$service_home" || -L "$service_home" ]]; then cleanup_status=1; fi
  if (( status == 0 && cleanup_status != 0 )); then status=$cleanup_status; fi
  if [[ -f "$log_file" ]]; then
    tail -n 200 "$log_file" | sed -E 's/(password|token|secret)([=: ]+)[^[:space:]]+/\1\2[REDACTED]/Ig' > "$evidence_dir/host-convergence-bounded.log"
  fi
  if node --input-type=module - "$evidence_dir/host-fixture-outcome.json" "$status" "$cleanup_status" "$phase" <<'NODE'
import { writeFile } from 'node:fs/promises';
const [file, exitStatus, cleanupStatus, lastPhase] = process.argv.slice(2);
const result = {
  format: 'codexia-push-host-result/v1',
  sourceSha: process.env.GITHUB_SHA,
  workflowRunId: process.env.GITHUB_RUN_ID,
  runAttempt: process.env.GITHUB_RUN_ATTEMPT,
  runnerName: process.env.RUNNER_NAME,
  outcome: Number(exitStatus) === 0 ? 'PASS' : 'FAIL',
  exitStatus: Number(exitStatus),
  lastPhase,
  cleanupStatus: Number(cleanupStatus) === 0 ? 'PASS' : 'FAIL',
  fixture: {
    proofMode: 'GitHub Actions disposable Ubuntu 26.04 host runner with explicit runner environment isolation',
    serviceUser: 'codexia',
    serviceUid: 22001,
    serviceGroup: 'codexia',
    serviceGid: 22001,
    serviceHome: '/home/codexia',
    accountCleanup: Number(cleanupStatus) === 0 ? 'PASS: fixture-owned account and home are absent after cleanup' : 'FAIL: fixture cleanup did not verify full account removal',
  },
  observations: {
    convergence: Number(exitStatus) === 0 ? 'PASS: actual host/bootstrap fixture assertions completed' : 'NOT_ESTABLISHED: fixture exited before all post-convergence assertions completed',
    userManager: Number(exitStatus) === 0 ? 'PASS: fixture verified the lingering user manager and rootless Podman/Quadlet network' : 'NOT_ESTABLISHED: fixture exited before all post-convergence assertions completed',
    reboot: 'NOT_CHECKED: this runner was not rebooted; a nested disposable VM reboot proof remains future fixture work',
  },
  lifecycleBoundary: 'This proves host/account bootstrap only. It does not invoke obsolete control paths or establish secrets, application readiness, database continuity, rollback, target-host reboot, or production acceptance.',
};
if (!/^[a-f0-9]{40}$/u.test(result.sourceSha ?? '') || !/^\d+$/u.test(result.workflowRunId ?? '') || !result.runnerName) {
  throw new Error('Refusing unbound Push push-host evidence.');
}
await writeFile(file, JSON.stringify(result, null, 2) + '\n', { mode: 0o644, flag: 'wx' });
NODE
  then :; else cleanup_status=1; status=1; fi
  printf 'Push push-host cleanup finished with test status %s and cleanup status %s.\n' "$status" "$cleanup_status" >&2
  exit "$status"
}
trap cleanup EXIT

identity_owned=true
phase=ansible-host-convergence
CODEXIA_HOST_PROOF_MODE=actions-fixture \
CODEXIA_HOST_FIXTURE_USER="$service_user" \
CODEXIA_HOST_FIXTURE_UID="$service_uid" \
CODEXIA_HOST_FIXTURE_GROUP="$service_group" \
CODEXIA_HOST_FIXTURE_GID="$service_gid" \
CODEXIA_HOST_FIXTURE_HOME="$service_home" \
ANSIBLE_PLAYBOOK="$ansible_playbook" \
  bash "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)/test-host-integration.sh" | tee "$log_file"
grep -q 'Verified Ubuntu host first/repeat convergence and rootless Quadlet network with explicit Actions environment isolation.' "$log_file"
phase=post-convergence-observations
[[ "$(id -u "$service_user")" == "$service_uid" && "$(id -g "$service_user")" == "$service_gid" ]]
[[ "$(loginctl show-user "$service_user" --property=Linger --value)" == yes ]]
[[ "$(sudo systemctl is-active "user@$service_uid.service")" == active ]]
[[ "$(rootless info --format '{{.Host.Security.Rootless}}')" == true ]]
printf '%s\n' 'PASS: real Ansible host/bootstrap convergence for the isolated codexia push-deployment identity.'
