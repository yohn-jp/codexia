#!/usr/bin/env bash
# Sourced by the disposable app lifecycle. No external Tunnel or S3 credentials.
verify_backup_host_lifecycle(){
  local prior_key="$1" candidate_key="$2"
  local state="$fixture_home/.local/state/codexia-deploy"
  local settings="$fixture_home/.config/codexia-backup"
  local units="$fixture_home/.config/systemd/user"
  local runner="$fixture_home/.local/bin/codexia-backup-runner"
  local destination="$fixture_home/.local/state/codexia-backup-mount"
  local fault="$state/backup-fault-bin" before run_id code
  before="$(rootless sha256sum "$state/deployed-release.json")"
  run_id="$(cat /proc/sys/kernel/random/uuid)"
  rootless install -d -m 0700 "$settings" "$units" "$fault"
  cat > "$tmp/backup-console-control.js" <<'CLI'
const { appendFileSync } = require('node:fs');
const [mode, id, ...args] = process.argv.slice(2);
const trace = '/home/codexia/.local/state/codexia-deploy/backup-fixture-log';
if (!/^[a-f0-9-]{36}$/.test(id)) process.exit(2);
switch (mode) {
  case 'deploy-start':
    if (args.join(' ') !== process.env.FIXTURE_DEPLOY_IDENTITIES) process.exit(2);
    console.log(id);
    break;
  case 'deploy-finish':
    if (!args[0]?.includes('/codexia-backup-mount/codexia-') || !/^[a-f0-9]{64}$/.test(args[1])) process.exit(2);
    break;
  case 'deploy-interrupted':
  case 'manual-interrupted':
    break;
  case 'manual-start':
    if (args.join(' ') !== process.env.FIXTURE_MANUAL_IDENTITY) process.exit(2);
    break;
  default:
    process.exit(2);
}
appendFileSync(trace, mode + ' ' + id + ' ' + args.join(' ') + '\n', { mode: 0o600 });
if (mode === 'deploy-finish') process.exit(1);
CLI
  sudo install -o codexia -g codexia -m 0600 "$tmp/backup-console-control.js" "$settings/backup-console-control.js"
  node - "$evidence" "$prior_key" "$candidate_key" "$settings" >"$tmp/backup-executor.env" <<'ENVFILE'
const fs = require('node:fs');
const [path, priorKey, candidateKey, settings] = process.argv.slice(2);
const { candidates } = JSON.parse(fs.readFileSync(path, 'utf8'));
const identity = key => candidates[key].identity.sourceSha + ' ' + candidates[key].image.split('@')[1];
console.log('CODEXIA_BACKUP_EXECUTOR_ENTRYPOINT=' + settings + '/backup-console-control.js');
console.log('FIXTURE_MANUAL_IDENTITY="' + identity(priorKey) + '"');
console.log('FIXTURE_DEPLOY_IDENTITIES="' + identity(priorKey) + ' ' + identity(candidateKey) + '"');
ENVFILE
  sudo install -o codexia -g codexia -m 0600 "$tmp/backup-executor.env" "$settings/executor.env"
  cat > "$tmp/backup-tunnel.service" <<'UNIT'
[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/bin/true
UNIT
  sudo install -o codexia -g codexia -m 0600 "$tmp/backup-tunnel.service" "$units/codexia-tunnel.service"
  rootless_systemctl daemon-reload
  rootless_systemctl start codexia-tunnel.service

  # A separate lock descriptor owned by the deployment fixture blocks a run
  # before either systemd service or the executor is touched.
  code=0
  rootless flock -xn "$state/host.lock" "$runner" "$run_id" || code=$?
  [[ "$code" == 75 ]]
  rootless test ! -e "$state/backup-fixture-log"

  cat > "$tmp/backup-fault-systemctl" <<'SYSTEMCTL'
#!/bin/bash
/usr/bin/systemctl "$@"
status=$?
if [[ "$status" == 0 && "$*" == '--user stop codexia-api.service' ]] &&
   test -s /home/codexia/.local/state/codexia-deploy/backup-transaction; then
  kill -KILL "$PPID"
fi
exit "$status"
SYSTEMCTL
  sudo install -o codexia -g codexia -m 0755 "$tmp/backup-fault-systemctl" "$fault/systemctl"
  code=0
  rootless env PATH="$fault:$PATH" CODEXIA_BACKUP_DESTINATION="$destination" CODEXIA_BACKUP_AGE_RECIPIENT="$backup_recipient" \
    "$runner" "$run_id" || code=$?
  [[ "$code" == 137 ]]
  rootless test -s "$state/backup-transaction"
  if rootless_systemctl is-active --quiet codexia-api.service ||
     rootless_systemctl is-active --quiet codexia-tunnel.service; then
    echo 'Backup interruption was injected before both services stopped' >&2
    return 1
  fi
  rootless "$runner" recover
  rootless_systemctl is-active --quiet codexia-tunnel.service
  rootless grep -Fxq "manual-interrupted $run_id " "$state/backup-fixture-log"
  rootless test ! -e "$state/backup-transaction"
  observe_runtime backup-interruption-recovery "$prior_key"

  if run_deploy "$candidate_key" false '' deploy-required-off-vm-failure; then
    echo 'Candidate activation succeeded despite a required off-VM verification failure' >&2
    return 1
  fi
  grep -Fq 'Deployment transaction failed during off-VM backup admission' "$tmp/deploy-required-off-vm-failure.log"
  rootless grep -q '^deploy-finish ' "$state/backup-fixture-log"
  rootless test ! -e "$state/deploy-transaction.json"
  rootless_systemctl is-active --quiet codexia-tunnel.service
  [[ "$(rootless sha256sum "$state/deployed-release.json")" == "$before" ]]
  observe_runtime required-off-vm-backup-failure "$prior_key"
  append_observation backup_host_lifecycle '{"hostLockContention":true,"sigkillRecoveredApiAndFixtureTunnel":true,"failedOffVmVerificationBlockedCandidate":true,"sourceAndCandidateIdentityBound":true}'

  rootless_systemctl stop codexia-tunnel.service
  rootless rm -- "$units/codexia-tunnel.service" "$settings/executor.env" "$state/backup-admission-enabled"
  rootless_systemctl daemon-reload
}
