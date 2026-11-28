#!/usr/bin/env bash
# Sourced by the disposable app lifecycle. No external Tunnel or S3 credentials.
verify_private_backup_socket() (
  set -e
  local settings="$fixture_home/.config/codexia-backup"
  local runtime="$fixture_home/.local/share/codexia-backup/current"
  local socket_parent="$fixture_home/.local/share/codexia-backup-postgres"
  local image before after status=0
  image="$(rootless_podman inspect --format '{{.Image}}' codexia-api)"
  rootless flock -xn "$fixture_home/.local/state/codexia-deploy/host.lock" \
    bash -s < "$repo_root/deploy/ansible/backup-postgres-socket.sh" || status=$?
  test "$status" = 75
  rootless install -d -m 0700 "$settings"
  rootless install -m 0600 /dev/null "$settings/executor.json"
  rootless tee "$settings/executor.json" >/dev/null <<JSON
{"privateKeyFiles":["$settings/sealing-private.pem"],"operatorCredential":{"origin":"https://backup.fixture.invalid","accessKeyId":"synthetic","secretAccessKey":"synthetic"}}
JSON
  test "$(rootless stat -c '%u:%a' "$settings/executor.json")" = "$fixture_uid:600"
  printf '%s\n' "$backup_recipient" | rootless tee "$settings/age-recipient.txt" >/dev/null
  rootless tee "$settings/policy.json" >/dev/null <<JSON
{"destinations":[{"provider":"s3-compatible","region":"us-east-1","endpoint":"https://backup.fixture.invalid","bucket":"codexia-fixture","prefix":"fixture","credentialModes":["operator-role"]}],
 "maintenanceWindows":[{"id":"fixture","timeZone":"UTC","daysOfWeek":[0,1,2,3,4,5,6],"start":"$(date -u +%H:%M)","durationMinutes":360}]}
JSON
  cat > "$tmp/backup-provision.yml" <<YAML
codexia_stage: base
codexia_backup_runtime_approved: true
codexia_backup_staging_directory: "$fixture_home/.local/state/codexia-backup-mount"
codexia_backup_secondary_independent_mount: "$fixture_home/.local/state/codexia-backup-mount"
YAML
  local tunnel="$fixture_home/.config/systemd/user/codexia-tunnel.service"
  rootless tee "$tunnel" >/dev/null <<'UNIT'
[Unit]
Requires=codexia-api.service
After=codexia-api.service
[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/bin/true
UNIT
  rootless_systemctl daemon-reload
  rootless_systemctl start codexia-tunnel.service
  run_playbook "$tmp/backup-provision.yml" backup-provision
  rootless_systemctl is-active --quiet codexia-tunnel.service
  before="$(rootless sha256sum "$settings/sealing-private.pem" "$settings/database.env")"
  before+=" $(rootless_podman inspect --format '{{.Id}}' codexia-api)"
  run_playbook "$tmp/backup-provision.yml" backup-provision-reapply
  after="$(rootless sha256sum "$settings/sealing-private.pem" "$settings/database.env")"
  after+=" $(rootless_podman inspect --format '{{.Id}}' codexia-api)"
  test "$before" = "$after"
  test "$(rootless_podman inspect --format '{{.Image}}' codexia-api)" = "$image"
  rootless_systemctl is-active --quiet codexia-backup-executor.service
  rootless_systemctl is-enabled --quiet codexia-backup-executor.service
  rootless_podman exec codexia-api sh -ec 'test -z "${CODEXIA_BACKUP_EXECUTOR_DATABASE_URL:-}" &&
    test ! -e /run/codexia-backup-postgresql && test -r "$CODEXIA_BACKUP_PUBLIC_KEY_FILE"'
  ! sudo -u nobody test -x "$socket_parent" || return 1
  verify_socket_client(){
    rootless "$runtime/bin/node" --env-file="$settings/database.env" --input-type=module - "$runtime/app" <<'SOCKET_NODE'
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const {Client} = createRequire(createRequire(process.argv[2] + '/package.json').resolve('@codexia/api'))('pg');
const url = new URL(process.env.CODEXIA_BACKUP_EXECUTOR_DATABASE_URL);
async function query(connectionString, sql) {
  // A missing SCRAM password can reject connect() while the socket is still open.
  const client = new Client({connectionString, connectionTimeoutMillis: 4000});
  try {
    await client.connect();
    return (await client.query(sql)).rows;
  } finally {
    await client.end();
  }
}
assert.deepEqual(await query(url.href, 'SELECT inet_client_addr() IS NULL AS socket'), [{socket:true}]);
await assert.rejects(query(url.href, 'CREATE TABLE codexia_backup.ungranted (id integer)'), {code:'42501'});
url.password = 'invalid';
await assert.rejects(query(url.href, 'SELECT 1'), {code:'28P01'});
url.password = '';
await assert.rejects(query(url.href, 'SELECT 1'));
SOCKET_NODE
  }
  local started
  started=$(date +%s%3N)
  verify_socket_client
  record_phase_timing private_socket_verify_before_restart "$started"
  rootless_systemctl stop codexia-tunnel.service
  rootless rm -- "$tunnel"
  rootless_systemctl daemon-reload
  started=$(date +%s%3N)
  rootless_systemctl stop codexia-backup-executor.service codexia-api.service
  record_phase_timing private_socket_stop_api_executor "$started"
  started=$(date +%s%3N)
  rootless_systemctl restart codexia-db.service
  rootless timeout 60s podman wait --condition=healthy codexia-db >/dev/null
  record_phase_timing private_socket_recover_postgres "$started"
  started=$(date +%s%3N)
  verify_socket_client
  record_phase_timing private_socket_verify_after_restart "$started"
  started=$(date +%s%3N)
  rootless_systemctl start codexia-api.service codexia-backup-executor.service
  record_phase_timing private_socket_start_api_executor "$started"
  # The synthetic lifecycle intentionally has no production Tunnel token.
  disable_fixture_tunnel

)

# Fixture-only data setup; all backup decisions and receipts are produced by the packaged executor.
backup_fixture_query() {
  rootless_podman exec -i codexia-db sh -ec 'export PGPASSWORD="$(cat /run/secrets/admin-password)"
    exec psql -X -qAtw -v ON_ERROR_STOP=1 -U codexia_admin -d codexia "$@"' sh "$@"
}

activate_fixture_backup_destination() {
  backup_fixture_query <<'SQL'
BEGIN;
INSERT INTO codexia_backup.revisions (revision, destination)
SELECT revision, jsonb_build_object('provider', 's3-compatible', 'endpoint', 'https://backup.fixture.invalid',
  'region', 'us-east-1', 'bucket', 'codexia-fixture', 'prefix', 'fixture', 'credentialMode', 'operator-role',
  'addressing', 'path-style', 'schedule', 'disabled', 'offVmPolicy', protection)
FROM (VALUES (1, 'secondary'), (2, 'required')) AS fixture(revision, protection);
UPDATE codexia_backup.state SET draft_revision = 1, active_revision = 1, active_usable = true, active_health = 'ready';
COMMIT;
SQL
}

verify_backup_host_lifecycle(){
  local prior_key="$1" candidate_key="$2"
  local state="$fixture_home/.local/state/codexia-deploy"
  local units="$fixture_home/.config/systemd/user"
  local runner="$fixture_home/.local/bin/codexia-backup-runner"
  local destination="$fixture_home/.local/state/codexia-backup-mount"
  local fault="$state/backup-fault-bin" before run_id code required_run started
  before="$(rootless sha256sum "$state/deployed-release.json")"
  run_id="$(cat /proc/sys/kernel/random/uuid)"
  rootless install -d -m 0700 "$units" "$fault"
  rootless_systemctl stop codexia-backup-executor.service
  backup_fixture_query -v run_id="$run_id" <<'SQL'
INSERT INTO codexia_backup.runs (id, request_id, kind, revision, maintenance_window_id)
VALUES (:'run_id', :'run_id', 'manual', 1, 'fixture');
SQL
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
  [[ "$(backup_fixture_query -c "SELECT state FROM codexia_backup.runs WHERE id = '$run_id'")" == QUEUED ]]

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
  started=$(date +%s%3N)
  rootless "$runner" recover
  rootless_systemctl is-active --quiet codexia-tunnel.service
  [[ "$(backup_fixture_query -c "SELECT state || ':' || reason_code FROM codexia_backup.runs WHERE id = '$run_id'")" == UNKNOWN:manual_interrupted ]]
  record_phase_timing interrupted_backup_api_recovery "$started"
  started=$(date +%s%3N)
  rootless_systemctl start codexia-backup-executor.service
  rootless test ! -e "$state/backup-transaction"
  record_phase_timing interrupted_backup_start_executor "$started"
  observe_runtime backup-interruption-recovery "$prior_key"

  backup_fixture_query -c "UPDATE codexia_backup.state SET active_revision = 2, active_usable = true, active_health = 'ready'"
  if run_deploy "$candidate_key" false '' deploy-required-off-vm-failure; then
    echo 'Candidate activation succeeded despite a required off-VM verification failure' >&2
    return 1
  fi
  grep -Fq 'Deployment transaction failed during off-VM backup admission' "$tmp/deploy-required-off-vm-failure.log"
  required_run="$(backup_fixture_query -c "SELECT source_sha || ' ' || image_digest || ' ' || candidate_source_sha || ' ' || candidate_image_digest
    FROM codexia_backup.runs WHERE revision = 2 AND kind = 'deploy' AND state IN ('UNKNOWN', 'FAILED')
    AND manifest_sha256 IS NOT NULL AND (evidence->>'offVmMethod') IS NULL")"
  [[ "$required_run" == "$(jq -r --arg prior "$prior_key" --arg next "$candidate_key" '
    [.candidates[$prior].identity.sourceSha, (.candidates[$prior].image | split("@")[1]),
     .candidates[$next].identity.sourceSha, (.candidates[$next].image | split("@")[1])] | join(" ")' "$evidence")" ]]
  backup_fixture_query -c "UPDATE codexia_backup.state SET active_revision = 1"
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
