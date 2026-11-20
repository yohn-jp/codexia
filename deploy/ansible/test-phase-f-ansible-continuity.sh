#!/usr/bin/env bash
# Run the real host and base Ansible stages on one disposable Ubuntu fixture
# before the separate signed updater lifecycle in the same manual Phase F job.
set -Eeuo pipefail
umask 077

fail() { printf '%s\n' "$*" >&2; exit 1; }
[[ "${GITHUB_ACTIONS:-}" == true && "${CODEXIA_DISPOSABLE_HOST:-}" == phase-f-integration ]] || \
  fail 'Run only inside the disposable Phase F workflow.'
[[ "$(lsb_release -rs)" == 26.04 && "$(uname -m)" == x86_64 ]] || fail 'Unsupported Phase F runner.'
[[ "$(id -u)" != 0 ]] || fail 'The workflow must use its non-root bootstrap identity.'
sudo -n true
[[ -n "${RUNNER_TEMP:-}" && -d "$RUNNER_TEMP" && -n "${GITHUB_SHA:-}" && "$GITHUB_SHA" =~ ^[a-f0-9]{40}$ ]] || \
  fail 'GitHub run evidence environment is incomplete.'
ansible_playbook=${ANSIBLE_PLAYBOOK:-}
[[ -x "$ansible_playbook" ]] || fail 'The isolated Ansible control environment is unavailable.'

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)
service_user=codexia-ci-host
service_uid=22001
service_home="/home/$service_user"
identity_owned=false
tmp=$(mktemp -d /tmp/codexia-phase-f-continuity.XXXXXX)
trap 'rm -rf -- "$tmp"' EXIT
evidence_dir="$RUNNER_TEMP/codexia-phase-f-evidence"
mkdir -p "$evidence_dir"

cleanup() {
  local status=$?
  local cleanup_status=0
  trap - EXIT
  set +e
  if [[ "$identity_owned" == true ]] && getent passwd "$service_user" >/dev/null 2>&1; then
    observed_uid=$(id -u "$service_user" 2>/dev/null || true)
    observed_home=$(getent passwd "$service_user" | cut -d: -f6)
    observed_gid=$(id -g "$service_user" 2>/dev/null || true)
    if [[ "$observed_uid" == "$service_uid" && "$observed_gid" == "$service_uid" && "$observed_home" == "$service_home" ]]; then
      sudo loginctl disable-linger "$service_user" >/dev/null 2>&1 || cleanup_status=1
      sudo systemctl stop "user@$service_uid.service" >/dev/null 2>&1 || true
      sudo userdel --remove "$service_user" >/dev/null 2>&1 || cleanup_status=1
      if getent group "$service_user" >/dev/null 2>&1; then sudo groupdel "$service_user" || cleanup_status=1; fi
    else
      printf 'Refusing to remove a changed host/base fixture identity: %s\n' "$service_user" >&2
      cleanup_status=1
    fi
  fi
  rm -rf -- "$tmp" || cleanup_status=1
  if (( status == 0 && cleanup_status != 0 )); then status=$cleanup_status; fi
  printf 'Phase F Ansible continuity cleanup finished with test status %s and cleanup status %s.\n' "$status" "$cleanup_status" >&2
  exit "$status"
}
trap cleanup EXIT

if getent passwd "$service_user" >/dev/null 2>&1 || getent passwd "$service_uid" >/dev/null 2>&1 || \
   getent group "$service_user" >/dev/null 2>&1 || getent group "$service_uid" >/dev/null 2>&1 || [[ -e "$service_home" ]]; then
  fail 'Host/base fixture identity already exists; refusing adoption.'
fi
identity_owned=true

printf '%s\n' '=== Ansible host stage: fresh then repeat on the base-stage identity ==='
CODEXIA_HOST_PROOF_MODE=actions-fixture ANSIBLE_PLAYBOOK="$ansible_playbook" \
  bash "$repo_root/deploy/ansible/test-host-integration.sh" | tee "$tmp/host.log"
grep -Eq 'Verified Ubuntu host first/repeat convergence|Verified clean Ubuntu host first/repeat convergence' "$tmp/host.log"
[[ "$(id -u "$service_user")" == "$service_uid" ]]
[[ "$(loginctl show-user "$service_user" --property=Linger --value)" == yes ]]

printf '%s\n' '=== Ansible base secrets and runtime stages: reuse the same service identity ==='
service_environment=(
  "GITHUB_ACTIONS=true"
  'CODEXIA_DISPOSABLE_HOST=phase-b-integration'
  "ANSIBLE_PLAYBOOK=$ansible_playbook"
  "CODEXIA_SERVICE_USER=$service_user"
)
env "${service_environment[@]}" bash "$repo_root/deploy/ansible/test-base-secrets-integration.sh" | tee "$tmp/base-secrets.log"
env "${service_environment[@]}" bash "$repo_root/deploy/ansible/test-base-runtime-integration.sh" | tee "$tmp/base-runtime.log"
grep -Fq 'Verified real rootless Podman secret creation, exact adoption, idempotence and existing-data missing-secret denial.' "$tmp/base-secrets.log"
grep -Fq 'Verified rootless Quadlet convergence, fresh PostgreSQL init, no-change repeat, data adoption, mismatch denial' "$tmp/base-runtime.log"

node --input-type=module - "$evidence_dir/ansible-convergence-results.json" <<'NODE'
import { writeFile } from 'node:fs/promises';
const [file] = process.argv.slice(2);
const result = {
  format: 'codexia-phase-f-ansible-continuity/v1',
  sourceSha: process.env.GITHUB_SHA,
  workflowRunId: process.env.GITHUB_RUN_ID,
  runAttempt: process.env.GITHUB_RUN_ATTEMPT,
  runnerName: process.env.RUNNER_NAME,
  fixture: {
    proofMode: 'GitHub Actions disposable Ubuntu 26.04 runner with explicit environment isolation',
    serviceUser: 'codexia-ci-host',
    serviceUid: 22001,
    identityContinuity: 'The host, secrets, and base runtime Ansible stages used this same fixture identity in sequence.',
  },
  stages: {
    host: 'PASS: real Ansible host stage created the rootless identity, then a second apply reported changed=0; generated rootless Quadlet network ran and was cleaned.',
    secrets: 'PASS: real Ansible secrets stage created the synthetic secrets, repeated with changed=0, adopted the disposable PostgreSQL volume, and rejected a missing secret for existing data.',
    baseRuntime: 'PASS: real Ansible base stage converged and repeated with changed=0; disposable database/data adoption, schema/role/secret and Tunnel drift denials succeeded on the same service identity.',
  },
  lifecycleBoundary: 'The signed updater lifecycle follows in the same workflow run on its own isolated fixture identity; it does not claim one continuous Ansible application cutover.',
  notChecked: [
    'Complete Ansible prepare, schema initialization, first activation, enable, and D cutover on one application fixture',
    'Adoption of a complete existing application deployment end-to-end',
    'Target VM reboot, external Access and author UI acceptance, remote restore host, and measured RPO/RTO',
  ],
};
if (!/^[a-f0-9]{40}$/u.test(result.sourceSha ?? '') || !/^\d+$/u.test(result.workflowRunId ?? '') || !result.runnerName) {
  throw new Error('Refusing unbound Phase F Ansible continuity evidence.');
}
await writeFile(file, JSON.stringify(result, null, 2) + '\n', { mode: 0o644, flag: 'wx' });
NODE

printf '%s\n' 'PASS: continuous real Ansible host→secrets→base convergence and adoption/drift checks on one service identity.'
printf '%s\n' '=== Existing Phase F signed updater lifecycle (separate disposable identity and state) ==='
bash "$repo_root/deploy/ansible/test-phase-f-disposable.sh"
