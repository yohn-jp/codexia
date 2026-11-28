#!/usr/bin/env bash
set -euo pipefail
export CODEXIA_IMAGE_REPOSITORY=ghcr.io/yohn-jp/codexia-backend
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT
export HOME="$scratch/home"
export PATH="$scratch/bin:$PATH"
mkdir -p "$scratch/bin" "$HOME/.config/"{containers/systemd,codexia-auth} \
  "$HOME/.local/"{share/containers/storage,state/codexia-deploy}
touch "$HOME/.local/state/codexia-deploy/host.lock"

writer_digest="sha256:$(printf 'a%.0s' {1..64})"
writer_image="ghcr.io/yohn-jp/codexia-backend@$writer_digest"
ledger='[["0001-initial.sql","bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"]]'
ledger_hash='sha256:93b777aa28a0a208f492bfe8c5bba7025ee8a3ea05a03953c1378b08f0fdb296'
export TEST_LEDGER="$ledger" TEST_LEDGER_HASH="$ledger_hash" TEST_WRITER_IMAGE="$writer_image"
export TEST_WRITER_ID="$(printf 'c%.0s' {1..64})" TEST_OWNER='test-only-owner@private.example'
export TEST_OWNER_HASH="sha256:$(printf '%s' "$TEST_OWNER" | sha256sum | cut -d ' ' -f 1)"

settings="CODEXIA_OAUTH_OWNER_SUBJECT=$TEST_OWNER"
settings_digest="$(printf '%s\n' "$settings" | sha256sum | cut -d ' ' -f 1)"
export TEST_SETTINGS_DIGEST="$settings_digest"
settings_file="$HOME/.config/codexia-auth/runtime-$settings_digest.env"
printf '%s\n' "$settings" > "$settings_file"
chmod 0600 "$settings_file"

unit="$HOME/.config/containers/systemd/codexia-api.container"
printf 'Image=%s\nEnvironment=CODEXIA_AUTH_MODE=better-auth\nEnvironment=CODEXIA_AUTH_SETTINGS_SHA256=%s\nEnvironmentFile=%s\n' \
  "$writer_image" "$settings_digest" "$settings_file" > "$unit"

cat > "$scratch/bin/id" <<'STUB'
#!/usr/bin/env bash
case "$1" in
  -un) printf 'codexia\n';;
  *) exit 99;;
esac
STUB
cat > "$scratch/bin/systemctl" <<'STUB'
#!/usr/bin/env bash
case "$*" in
  *SourcePath*codexia-api.service) printf '%s\n' "$HOME/.config/containers/systemd/codexia-api.container";;
  'is-active codexia-cloudflared.service') [[ "${TEST_CONNECTOR_UNIT:-active}" == active ]] && printf 'active\n' || exit 3;;
  *ActiveState*codexia-api.service|*ActiveState*codexia-db.service) printf 'active\n';;
  *) exit 99;;
esac
STUB
cat > "$scratch/bin/curl" <<'STUB'
#!/usr/bin/env bash
[[ "${TEST_CONNECTOR_READY:-200}" == 200 ]] || exit 7
printf '%s' "${TEST_CONNECTOR_READY:-200}"
STUB
cat > "$scratch/bin/sudo" <<'STUB'
#!/usr/bin/env bash
[[ "$*" == '-n /usr/local/sbin/codexia-api-gate status' ]] || exit 99
[[ "${TEST_GATE_STATE:-open}" == open ]] || exit 1
printf '%s\n' "${TEST_GATE_STATE:-open}"
STUB
cat > "$scratch/bin/podman" <<'STUB'
#!/usr/bin/env bash
case "$*" in
  'info --format '*Rootless*) printf 'true\n';;
  'ps --no-trunc --filter name=codexia-api --format '*|'ps --no-trunc --filter volume=codexia-history --format '*)
    printf '%s\n' "$TEST_WRITER_ID"
    if [[ "${TEST_EXTRA_WRITER:-false}" == true ]]; then printf '%064d\n' 2; fi;;
  'inspect --type container --format '*Mounts*codexia-api)
    printf '%s\n' '[{"Type":"volume","Name":"codexia-data","Destination":"/data","RW":true},{"Type":"volume","Name":"codexia-history","Destination":"/history","RW":true}]';;
  'inspect --type container --format '*Mounts*codexia-db)
    printf '%s\n' '[{"Type":"volume","Name":"codexia-postgres","Destination":"/var/lib/postgresql/data","RW":true}]';;
  'inspect --type container --format '*codexia-api)
    printf '%s true %s %s healthy\n' "$TEST_WRITER_ID" "$TEST_WRITER_ID" "$TEST_WRITER_IMAGE";;
  'image inspect --format '*RepoDigests*) printf '["%s"]\n' "${TEST_IMAGE_BINDING:-$TEST_WRITER_IMAGE}";;
  'exec '*'/app/update-identity.json')
    printf '{"format":"codexia-backend-identity/v1","version":"0.1.932","sourceSha":"dddddddddddddddddddddddddddddddddddddddd","profile":"full","platform":"linux/amd64","migrationFingerprint":"%s","apiEpoch":1,"persistenceFormat":1}\n' "$TEST_LEDGER_HASH";;
  'exec '*node*)
    shift 2
    CODEXIA_AUTH_MODE=better-auth CODEXIA_OAUTH_OWNER_SUBJECT="$TEST_OWNER" \
      CODEXIA_AUTH_SETTINGS_SHA256="$TEST_SETTINGS_DIGEST" CODEXIA_DATABASE_USER=codexia \
      CODEXIA_DATABASE_PASSWORD_FILE=/run/secrets/app-password CODEXIA_DATABASE_HOST=codexia-db CODEXIA_DATABASE_NAME=codexia \
      CODEXIA_AUTH_DATABASE_URL="${TEST_AUTH_DATABASE_URL:-postgres://codexia_auth_runtime:fixture@codexia-db:5432/codexia}" "$@";;
  'exec codexia-db sh -ec '*pg_control_system*)
    [[ "$*" == *default_transaction_read_only=on* ]] || exit 98
    printf '{"clusterId":"1234567890123456789","ledger":%s}\n' "$TEST_LEDGER";;
  'exec codexia-db sh -ec '*codexia_auth*)
    [[ "$*" == *default_transaction_read_only=on* ]] || exit 98
    printf '%s\n' "${TEST_OWNER_MATCH:-t}";;
  *) printf 'unexpected fixture command with private content: %s\n' "$TEST_OWNER" >&2; exit 99;;
esac
STUB
chmod +x "$scratch/bin/"*

if ! result="$(bash ./preflight-writer-observe.sh)"; then
  echo 'Expected a complete read-only observation for the canonical running writer' >&2
  exit 1
fi
node - "$result" <<'JS'
const assert = require('node:assert/strict');
const result = JSON.parse(process.argv[2]);
assert.equal(result.format, 'codexia-writer-observation/v1');
assert.match(result.observedAt, /^\d{4}-\d\d-\d\dT/);
assert.match(result.hostId, /^[a-f0-9]{64}$/);
assert.equal(result.writer.containerId, process.env.TEST_WRITER_ID);
assert.equal(result.writer.image, process.env.TEST_WRITER_IMAGE);
assert.equal(result.writer.identity.apiEpoch, 1);
assert.equal(result.writer.identity.persistenceFormat, 1);
assert.equal(result.writer.authMode, 'better-auth');
assert.equal(result.writer.ownerBindingSha256, process.env.TEST_OWNER_HASH);
assert.match(result.writer.quadletSha256, /^sha256:[a-f0-9]{64}$/);
assert.match(result.writer.settingsSha256, /^sha256:[a-f0-9]{64}$/);
assert.equal(result.database.clusterId, '1234567890123456789');
assert.equal(result.database.migrationLedgerSha256, process.env.TEST_LEDGER_HASH);
assert.deepEqual(result.managementConnector, { unitState: 'active', ready: true });
assert.deepEqual(result.publicationGate, { state: 'open' });
assert.ok(!process.argv[2].includes(process.env.TEST_OWNER));
JS

expect_denial() {
  if "$@" >"$scratch/denial.json" 2>"$scratch/denial.err"; then
    echo 'An inconsistent observation was accepted' >&2
    exit 1
  fi
  test ! -s "$scratch/denial.json"
  test -s "$scratch/denial.err"
  if grep -Fq "$TEST_OWNER" "$scratch/denial.err"; then
    echo 'The denial exposed private input' >&2
    exit 1
  fi
}

expect_denial env TEST_IMAGE_BINDING="ghcr.io/yohn-jp/codexia-backend@sha256:$(printf 'e%.0s' {1..64})" bash ./preflight-writer-observe.sh
expect_denial env TEST_LEDGER='[]' bash ./preflight-writer-observe.sh
expect_denial env TEST_OWNER_MATCH=f bash ./preflight-writer-observe.sh
expect_denial env TEST_AUTH_DATABASE_URL='postgres://codexia_auth_runtime:fixture@unreviewed.example:5432/codexia' bash ./preflight-writer-observe.sh

expect_denial env TEST_EXTRA_WRITER=true bash ./preflight-writer-observe.sh
expect_denial env TEST_CONNECTOR_UNIT=inactive bash ./preflight-writer-observe.sh
expect_denial env TEST_CONNECTOR_READY=503 bash ./preflight-writer-observe.sh
expect_denial env TEST_GATE_STATE=closed bash ./preflight-writer-observe.sh
