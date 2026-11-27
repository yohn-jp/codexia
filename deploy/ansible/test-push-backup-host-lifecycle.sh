#!/usr/bin/env bash
# Sourced by the disposable app lifecycle. No external Tunnel or S3 credentials.
verify_private_backup_socket() (
  set -e
  local path="$fixture_home/.local/state/codexia-private-socket-fixture"
  local socket_parent="$fixture_home/.local/share/codexia-backup-postgres"
  local node_binary
  node_binary="$(command -v node)"
  rootless test ! -e "$path"
  rootless test ! -L "$path"
  trap 'rootless rm -rf -- "$path"' EXIT
  rootless install -d -m 0700 "$path"
  rootless install -d -m 0700 "$path/runtime"

  socket_fixture_admin(){
    rootless_podman exec -i codexia-db sh -ec 'export PGPASSWORD="$(cat /run/secrets/admin-password)"
      exec psql -X -qAtw -v ON_ERROR_STOP=1 -U codexia_admin -d codexia "$@"' sh "$@"
  }
  await_socket_fixture(){
    local attempt
    for ((attempt=1; attempt<=30; attempt++)); do
      if socket_fixture_admin -h 127.0.0.1 -c 'SELECT 1' >/dev/null 2>&1; then return; fi
      sleep 1
    done
    return 1
  }
  test "$(socket_fixture_admin -c "SELECT count(*) > 0 FROM pg_hba_file_rules WHERE type = 'local' AND auth_method = 'trust'")" = t
  local api_image
  api_image="$(rootless_podman inspect --format '{{.Image}}' codexia-api)"
  local locked_exit=0
  rootless bash -c 'exec 9>> "$HOME/.local/state/codexia-deploy/host.lock"
    flock --exclusive 9 || exit; bash -s; exit $?' \
    < "$repo_root/deploy/ansible/backup-postgres-socket.sh" || locked_exit=$?
  test "$locked_exit" = 75
  rootless test ! -e "$socket_parent"
  rootless bash -s < "$repo_root/deploy/ansible/backup-postgres-socket.sh"
  test "$(rootless_podman inspect --format '{{.Image}}' codexia-api)" = "$api_image"
  test "$(rootless systemctl --user is-active codexia-api.service)" = active
  rootless_podman exec codexia-api test ! -e /run/codexia-backup-postgresql
  test -z "$(rootless bash -s < "$repo_root/deploy/ansible/backup-postgres-socket.sh")"
  if sudo -u nobody test -x "$socket_parent"; then
    echo 'An unrelated host UID can reach the private PostgreSQL socket' >&2
    exit 1
  fi
  socket_fixture_admin < "$repo_root/deploy/backup/operational-schema.sql"
  socket_fixture_admin <<'SOCKET_ROLES'
CREATE ROLE backup_api_fixture LOGIN PASSWORD 'disposable-private-socket-api';
CREATE ROLE backup_executor_fixture LOGIN PASSWORD 'disposable-private-socket-executor';
GRANT codexia_backup_api TO backup_api_fixture;
GRANT codexia_backup_executor TO backup_executor_fixture;
SOCKET_ROLES
  socket_fixture_admin -v backup_api_login=backup_api_fixture -v backup_executor_login=backup_executor_fixture \
    < "$repo_root/deploy/backup/verify-console-roles.sql"

  rootless_podman exec codexia-api tar -cf - -C /app . |
    rootless tar -xf - --no-same-owner -C "$path/runtime"
  rootless tee "$path/runtime/verify-fixture-socket.mjs" >/dev/null <<'SOCKET_NODE'
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { Pool } = createRequire(import.meta.resolve('@codexia/api'))('pg');
async function query(password, sql) {
  const pool = new Pool({
    connectionString: `postgresql://backup_executor_fixture:${password ?? ''}@localhost/codexia?host=${encodeURIComponent(process.argv[2])}`,
    connectionTimeoutMillis: 4000,
  });
  try { return await pool.query(sql); } finally { await pool.end(); }
}
await assert.rejects(query(undefined, 'SELECT 1'), /password must be a string/u);
await assert.rejects(query('wrong-password', 'SELECT 1'), { code: '28P01' });
const verified = await query('disposable-private-socket-executor',
  'SELECT current_user AS login, inet_client_addr() IS NULL AS socket, count(*)::integer AS runs FROM codexia_backup.runs');
assert.deepEqual(verified.rows, [{ login: 'backup_executor_fixture', socket: true, runs: 0 }]);
await assert.rejects(query('disposable-private-socket-executor',
  'CREATE TABLE codexia_backup.ungranted (id integer)'), { code: '42501' });
SOCKET_NODE
  verify_socket_client(){
    rootless test -S "$socket_parent/socket/.s.PGSQL.5432"
    rootless "$node_binary" "$path/runtime/verify-fixture-socket.mjs" "$socket_parent/socket"
  }
  verify_socket_client
  rootless systemctl --user stop codexia-api.service
  rootless systemctl --user restart codexia-db.service
  await_socket_fixture
  verify_socket_client
  rootless systemctl --user start codexia-api.service
  printf '%s\n' 'Private backup socket verified on rootless Podman with dedicated PostgreSQL logins, SCRAM and restart'
)

prepare_backup_console_fixture(){
  local settings="$fixture_home/.config/codexia-backup"
  local destination="$fixture_home/.local/state/codexia-backup-mount"
  rootless install -d -m 0700 "$settings"
  cat > "$tmp/backup-console-control.js" <<'CLI'
const { execFileSync } = require('node:child_process');
const { appendFileSync, readFileSync } = require('node:fs');
const path = require('node:path');
const [mode, id, ...args] = process.argv.slice(2);
const state = path.join(process.env.HOME, '.local/state/codexia-deploy');
const trace = path.join(state, 'backup-fixture-log');
const fixture = JSON.parse(readFileSync(path.join(state, 'backup-fixture-deploy.json'), 'utf8'));
if (!/^[a-f0-9-]{36}$/.test(id)) process.exit(2);
switch (mode) {
  case 'deploy-start':
    if (args.join(' ') !== fixture.deployIdentities) process.exit(2);
    if (fixture.fault === 'console-unconfigured') {
      console.log('NONE');
      process.exit(0);
    }
    console.log(id);
    break;
  case 'deploy-finish': {
    const [artifact, expected] = args;
    const destination = process.env.CODEXIA_BACKUP_DESTINATION;
    if (path.dirname(artifact) !== destination || !path.basename(artifact).endsWith('-' + id) ||
        !/^[a-f0-9]{64}$/.test(expected)) process.exit(2);
    const actual = execFileSync(path.join(process.env.HOME, '.local/bin/codexia-backup'),
      ['validate-independent-artifact', destination, artifact], { encoding: 'utf8' }).trim();
    if (actual !== expected) process.exit(2);
    break;
  }
  case 'deploy-interrupted':
  case 'deploy-fail':
  case 'manual-interrupted':
    break;
  case 'manual-start':
    if (args.join(' ') !== fixture.manualIdentity) process.exit(2);
    break;
  default:
    process.exit(2);
}
appendFileSync(trace, mode + ' ' + id + ' ' + args.join(' ') + '\n', { mode: 0o600 });
if (mode === 'deploy-finish' && fixture.fault === 'off-vm-verification') process.exit(1);
CLI
  sudo install -o codexia -g codexia -m 0600 "$tmp/backup-console-control.js" "$settings/backup-console-control.js"
  cat > "$tmp/backup-executor.env" <<ENVFILE
CODEXIA_BACKUP_EXECUTOR_ENTRYPOINT=$settings/backup-console-control.js
CODEXIA_BACKUP_DESTINATION=$destination
CODEXIA_BACKUP_AGE_RECIPIENT=$backup_recipient
ENVFILE
  sudo install -o codexia -g codexia -m 0600 "$tmp/backup-executor.env" "$settings/executor.env"
}

backup_fixture_attempt(){
  local candidate_key="$1" fault="${2:-}" current_release
  local state="$fixture_home/.local/state/codexia-deploy"
  current_release="$(rootless cat "$state/deployed-release.json")"
  node - "$evidence" "$candidate_key" "$current_release" "$fault" >"$tmp/backup-fixture-deploy.json" <<'FIXTURE'
const fs = require('node:fs');
const [evidence, key, release, fault] = process.argv.slice(2);
const { identity, image } = JSON.parse(release);
const candidate = JSON.parse(fs.readFileSync(evidence, 'utf8')).candidates[key];
const manualIdentity = identity.sourceSha + ' ' + image.split('@')[1];
console.log(JSON.stringify({
  manualIdentity,
  deployIdentities: manualIdentity + ' ' + candidate.identity.sourceSha + ' ' + candidate.image.split('@')[1],
  fault,
}));
FIXTURE
  sudo install -o codexia -g codexia -m 0600 "$tmp/backup-fixture-deploy.json" "$state/backup-fixture-deploy.json"
}

verify_backup_host_lifecycle(){
  local prior_key="$1" candidate_key="$2"
  local state="$fixture_home/.local/state/codexia-deploy"
  local units="$fixture_home/.config/systemd/user"
  local runner="$fixture_home/.local/bin/codexia-backup-runner"
  local destination="$fixture_home/.local/state/codexia-backup-mount"
  local fault="$state/backup-fault-bin" before trace_before run_id code
  before="$(rootless sha256sum "$state/deployed-release.json")"
  run_id="$(cat /proc/sys/kernel/random/uuid)"
  rootless install -d -m 0700 "$units" "$fault"
  backup_fixture_attempt "$candidate_key"
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
  trace_before="$(rootless sha256sum "$state/backup-fixture-log")"
  code=0
  rootless flock -xn "$state/host.lock" "$runner" "$run_id" || code=$?
  [[ "$code" == 75 ]]
  [[ "$(rootless sha256sum "$state/backup-fixture-log")" == "$trace_before" ]]

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

  if run_deploy "$candidate_key" false '' deploy-required-off-vm-failure off-vm-verification; then
    echo 'Candidate activation succeeded despite a required off-VM verification failure' >&2
    return 1
  fi
  grep -Fq 'Deployment transaction failed during off-VM backup admission' "$tmp/deploy-required-off-vm-failure.log"
  rootless tail -2 "$state/backup-fixture-log" | grep -q '^deploy-finish '
  rootless test ! -e "$state/deploy-transaction.json"
  rootless_systemctl is-active --quiet codexia-tunnel.service
  [[ "$(rootless sha256sum "$state/deployed-release.json")" == "$before" ]]
  observe_runtime required-off-vm-backup-failure "$prior_key"
  append_observation backup_host_lifecycle '{"hostLockContention":true,"sigkillRecoveredApiAndFixtureTunnel":true,"failedOffVmVerificationBlockedCandidate":true,"sourceAndCandidateIdentityBound":true}'

  rootless_systemctl stop codexia-tunnel.service
  rootless rm -- "$units/codexia-tunnel.service"
  rootless_systemctl daemon-reload
}

verify_s3_restore_lifecycle(){
  local candidate_key="$1" source_artifact="$2"
  local inputs="$tmp/s3-lifecycle-input" outputs="$tmp/s3-lifecycle-output"
  local drill="$fixture_home/.local/state/codexia-restore-fixture"
  local source_sha image ledger runtime_settings archive file digest
  local -a received
  read -r source_sha image ledger < <(node - "$evidence" "$candidate_key" <<'CANDIDATE'
const fs = require('node:fs');
const [path, key] = process.argv.slice(2);
const candidate = JSON.parse(fs.readFileSync(path, 'utf8')).candidates[key];
console.log(candidate.identity.sourceSha, candidate.image, candidate.identity.migrationFingerprint);
CANDIDATE
  )
  runtime_settings="$(rootless sed -n 's/^EnvironmentFile=//p' "$fixture_home/.config/containers/systemd/codexia-api.container")"
  mkdir -m 0700 "$inputs" "$outputs"
  archive="$inputs/$(basename -- "$source_artifact")"
  mkdir -m 0700 "$archive"
  for file in database.dump.age history.tar.age manifest.age SHA256SUMS; do
    rootless cat "$source_artifact/$file" > "$archive/$file"
  done
  digest="$(sha256sum "$archive/SHA256SUMS" | cut -d ' ' -f1)"
  if ! bash "$repo_root/deploy/backup/s3-fixture.sh" --transfer-only "$archive" "$source_sha" "$outputs" >"$tmp/s3-lifecycle-transfer.log" 2>&1; then
    redact_log "$tmp/s3-lifecycle-transfer.log" "$RUNNER_TEMP/codexia-push-app-lifecycle/s3-lifecycle-transfer-bounded.log"
    echo 'S3 lifecycle transfer failed' >&2
    tail -30 "$RUNNER_TEMP/codexia-push-app-lifecycle/s3-lifecycle-transfer-bounded.log" >&2
    return 1
  fi
  echo 'S3 lifecycle transfer verified'
  mapfile -t received < <(find "$outputs" -mindepth 1 -maxdepth 1 -type d -name 'codexia-*' -print)
  [[ "${#received[@]}" == 1 ]]
  cmp -- "$archive/SHA256SUMS" "${received[0]}/SHA256SUMS"
  rootless install -d -m 0700 "$drill" "$drill/backup"
  for file in database.dump.age history.tar.age manifest.age SHA256SUMS; do
    sudo install -o codexia -g codexia -m 0600 "${received[0]}/$file" "$drill/backup/$file"
  done
  sudo install -o codexia -g codexia -m 0600 "$tmp/age-identity" "$drill/identity"
  sudo install -o codexia -g codexia -m 0600 "$tmp/auth-introspection-secret" "$drill/introspection-secret"
  if ! rootless env CODEXIA_PUSH_STATE_DIR="$drill" "$fixture_home/.local/bin/codexia-backup" drill \
    "$drill/backup" "$drill/identity" --approved --candidate-full-image "$image" --candidate-ledger "$ledger" \
    --candidate-api-ready --candidate-runtime-settings "$runtime_settings" \
    --candidate-introspection-secret-file "$drill/introspection-secret" >"$tmp/s3-lifecycle-drill.log" 2>&1; then
    redact_log "$tmp/s3-lifecycle-drill.log" "$RUNNER_TEMP/codexia-push-app-lifecycle/s3-lifecycle-drill-bounded.log"
    echo 'S3 lifecycle candidate restore failed' >&2
    tail -30 "$RUNNER_TEMP/codexia-push-app-lifecycle/s3-lifecycle-drill-bounded.log" >&2
    return 1
  fi
  grep -Fxq "Verified checksum manifest sha256: $digest" "$tmp/s3-lifecycle-drill.log"
  grep -Fxq "Isolated candidate ledger verified: $ledger" "$tmp/s3-lifecycle-drill.log"
  grep -Fxq 'Isolated candidate API readiness verified' "$tmp/s3-lifecycle-drill.log"
  echo 'S3 lifecycle candidate restore and API readiness verified'
  rootless rm -r -- "$drill"
  append_observation s3_restore_lifecycle "$(node -e '
    const [sourceSha, image, ledger, manifestSha256] = process.argv.slice(1);
    console.log(JSON.stringify({sourceSha, image, ledger, manifestSha256, provider: "Silo",
      databaseAndHistoryRecovered: true, apiReady: true, physicalIndependence: "NOT_PROVEN_BY_CI_FIXTURE"}));
  ' "$source_sha" "$image" "$ledger" "$digest")"
}
