#!/usr/bin/env bash
# Run in the disposable codexia account created by test-epoch-cutover-fixture.sh.
set -Eeuo pipefail
umask 077
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.."

[[ "$(id -un)" == codexia && "$HOME" == /home/codexia && "$(pwd -P)" == "$HOME/fixture" ]]
[[ "$(podman info --format '{{.Host.Security.Rootless}}')" == true ]]

readonly fixture_tag=${1:?}
readonly prior_source=${2:?}
readonly candidate_source=${3:?}
readonly registry_image=docker.io/library/registry@sha256:a3d8aaa63ed8681a604f1dea0aa03f100d5895b6a58ace528858a7b332415373
pg_image=$(sed -n 's/^Image=//p' deploy/quadlet/codexia-db.container)
readonly pg_image
readonly work="$HOME/fixture/private"
readonly evidence="$HOME/fixture/evidence"
export CODEXIA_PUSH_STATE_DIR="$HOME/.local/state/codexia-deploy"
export CODEXIA_PUSH_QUADLET_DIR="$HOME/.config/containers/systemd"
export CODEXIA_BACKUP_PROGRAM="$HOME/fixture/deploy/backup/backup.sh"
export CODEXIA_BACKUP_DESTINATION="$work/backup"

readonly state=$CODEXIA_PUSH_STATE_DIR
readonly quadlet=$CODEXIA_PUSH_QUADLET_DIR
readonly auth="$HOME/.config/codexia-auth"
readonly host_program="$HOME/fixture/deploy/ansible/cutover-host.sh"
readonly request="$work/request.json"
declare -a passed=()

mkdir -p "$work" "$evidence" "$quadlet" "$state" "$auth" "$CODEXIA_BACKUP_DESTINATION"
record() {
  passed+=("$1")
  printf '%s\n' "${passed[@]}" | jq -Rsc 'split("\n") | map(select(length > 0))' > "$evidence/assertions.json"
}
trap 'printf "Epoch cutover fixture failed at line %s\n" "$LINENO" >&2' ERR

touch "$state/host.lock"
age-keygen -o "$work/recovery-key" 2>/dev/null
export CODEXIA_BACKUP_RECIPIENT
CODEXIA_BACKUP_RECIPIENT=$(age-keygen -y "$work/recovery-key")

podman run -d --name fixture-registry --publish 127.0.0.1:5000:5000 "$registry_image" >/dev/null
curl --fail --silent --show-error --retry 20 --retry-delay 1 --retry-connrefused --max-time 3 http://127.0.0.1:5000/v2/ >/dev/null
cat > "$HOME/.config/containers/registries.conf" <<'REGISTRIES'
[[registry]]
prefix = "ghcr.io/yohn-jp/codexia-backend"
location = "localhost:5000/yohn-jp/codexia-backend"
insecure = true
[[registry]]
prefix = "localhost:5000"
location = "localhost:5000"
insecure = true
REGISTRIES

prepare_image() {
  local role=$1 source=$2 epoch=$3 tag="localhost:5000/yohn-jp/codexia-backend:$1" image
  podman tag "$fixture_tag:$role" "$tag"
  podman push --digestfile "$work/$role.digest" "$tag" >&2
  image="ghcr.io/yohn-jp/codexia-backend@$(cat "$work/$role.digest")"
  podman pull "$image" >&2
  podman image inspect "$image" > "$work/$role.inspect.json"
  podman run --rm --pull=never --network none --image-volume=ignore --entrypoint /bin/cat "$image" \
    /app/update-identity.json > "$work/$role.identity.json"
  node --input-type=module - "$image" "$source" "$epoch" "$work/$role.inspect.json" "$work/$role.identity.json" <<'JS'
import { readFileSync } from 'node:fs';
import { assertBackendImageIdentity } from './scripts/release/backend/image-inspection.mjs';
const [image, sourceSha, epoch, inspect, embedded] = process.argv.slice(2);
const parse = path => JSON.parse(readFileSync(path, 'utf8'));
const identity = assertBackendImageIdentity(parse(embedded), parse(inspect)[0], {
  image, sourceSha, profile: 'full', compatibility: { apiEpoch: Number(epoch), persistenceFormat: Number(epoch) },
});
console.log(JSON.stringify({ image, identity }));
JS
}
prepare_image prior "$prior_source" 1 > "$work/prior-image.json"
prepare_image candidate "$candidate_source" 2 > "$work/candidate-image.json"
jq -s '{prior:.[0],candidate:.[1]}' "$work/prior-image.json" "$work/candidate-image.json" > "$evidence/images.json"
prior_image=$(jq -er .image "$work/prior-image.json")
candidate_image=$(jq -er .image "$work/candidate-image.json")
[[ "$prior_image" != "$candidate_image" ]]
record immutable_exact_source_images

for role in admin app; do
  openssl rand -hex 32 | tr -d '\n' > "$work/$role-password"
  podman secret create "codexia-postgres-$role-password" "$work/$role-password" >/dev/null
done
cp deploy/quadlet/{*.network,*.volume} "$quadlet"
chmod 0755 "$HOME/fixture/deploy/postgres/010-create-app-role.sh"
sed "s@/etc/codexia/postgres/@$HOME/fixture/deploy/postgres/@" deploy/quadlet/codexia-db.container > "$quadlet/codexia-db.container"
cat > "$quadlet/codexia-tunnel.container" <<QUADLET
[Container]
Image=$pg_image
ContainerName=codexia-tunnel
Network=codexia.network
Entrypoint=/bin/sleep
Exec=infinity
QUADLET
systemctl --user daemon-reload
systemctl --user start codexia-db.service

psql_admin() {
  podman exec -i codexia-db sh -ec '
    export PGPASSWORD="$(cat /run/secrets/admin-password)"
    exec psql -X -qAt -v ON_ERROR_STOP=1 -U codexia_admin -d codexia "$@"
  ' sh "$@"
}
for ((attempt=0; attempt<60; attempt++)); do
  if psql_admin -h 127.0.0.1 -c 'SELECT 1' >/dev/null 2>&1; then break; fi
  sleep 1
done
[[ "$(psql_admin -h 127.0.0.1 -c 'SHOW server_version_num')" =~ ^17[0-9]{4}$ ]]
timeout 120s podman wait --interval 250ms --condition healthy codexia-db >/dev/null
[[ "$(podman inspect --format '{{.State.Health.Status}}' codexia-db)" == healthy ]]
record rootless_podman_postgresql_17

# The shared smoke fixture creates the schema and enrolls the owner through its
# local HTTPS IdP. Let it use our administrative role for provisioning only.
fixture_podman() {
  if [[ $# -ge 4 && "$1 $2 $3 $4" == 'exec -i codexia-db psql' ]]; then
    shift 4
    local -a args=("$@")
    local index
    for index in "${!args[@]}"; do
      if [[ "${args[index]}" == -U ]]; then args[index+1]=codexia_admin; fi
    done
    psql_admin "${args[@]}"
  else
    podman "$@"
  fi
}
source scripts/verification/runtime/better-auth-fixture.sh
mkdir "$work/auth-fixture"
setup_oci_better_auth fixture_podman "$prior_image" codexia-data codexia-db "$work/auth-fixture" \
  codexia-auth-registration fixture-oidc codexia

# Render the real API Quadlet with the same retained auth configuration and
# secret names for both images. Initialize the pristine fixture only once.
create_auth_secret() {
  local secret=$1 key=$2
  sed -n "s/^$key=//p" "$work/auth-fixture/auth.env" | tr -d '\n' | podman secret create "$secret" - >/dev/null
}
create_auth_secret codexia-auth-database-url CODEXIA_AUTH_DATABASE_URL
create_auth_secret codexia-auth-secret CODEXIA_AUTH_SECRET
create_auth_secret codexia-oidc-client-secret CODEXIA_OIDC_CLIENT_SECRET
create_auth_secret codexia-oauth-introspection-client-secret CODEXIA_OAUTH_INTROSPECTION_CLIENT_SECRET
podman secret create fixture-ca "$work/auth-fixture/oidc/tls.crt" >/dev/null
grep -E '^CODEXIA_(PUBLIC_ORIGIN|OIDC_ISSUER|OIDC_CLIENT_ID|OAUTH_INTROSPECTION_CLIENT_ID|OAUTH_OWNER_CLIENT_IDS)=' \
  "$work/auth-fixture/auth.env" > "$work/runtime.env"
printf 'CODEXIA_OAUTH_OWNER_SUBJECT=%s\n' "$oci_owner_subject" >> "$work/runtime.env"
settings_sha=$(sha256sum "$work/runtime.env" | cut -d ' ' -f 1)
install -m 0600 "$work/runtime.env" "$auth/runtime-$settings_sha.env"

render_api() {
  local image=$1 initialize=$2
  sed -e "s@CODEXIA_BACKEND_IMAGE@$image@" -e 's/CODEXIA_BACKEND_PROFILE/full/' \
    -e "s/AUTH_SETTINGS_DIGEST_PLACEHOLDER/$settings_sha/g" \
    -e "/^\[Container\]/a Secret=fixture-ca,type=mount,target=/run/secrets/fixture-ca.crt,mode=0444\nEnvironment=NODE_EXTRA_CA_CERTS=/run/secrets/fixture-ca.crt" \
    -e "s/CODEXIA_DATABASE_MIGRATE_ON_START=0/CODEXIA_DATABASE_MIGRATE_ON_START=$initialize/" \
    deploy/quadlet/codexia-api.container
}

render_api "$prior_image" 1 > "$quadlet/codexia-api.container"
systemctl --user daemon-reload
systemctl --user start codexia-api.service
systemctl --user stop codexia-api.service
render_api "$prior_image" 0 > "$quadlet/codexia-api.container"
render_api "$candidate_image" 0 > "$state/candidate-epoch2.container"
systemctl --user daemon-reload
systemctl --user start codexia-api.service codexia-tunnel.service
jq -n --slurpfile release "$work/prior-image.json" --arg auth "$settings_sha" '
  $release[0] + {format:"codexia-push-deployment/v1",authMode:"better-auth",authSettingsSha256:$auth}' > "$state/deployed-release.json"

owner_fixture() { podman exec fixture-oidc node /fixture/fixture.mjs "$@"; }
owner_fixture backend-smoke "$OCI_AUTH_WEB_CLIENT" "$oci_owner_subject" > "$work/projects.json"
project_id=$(jq -er .legacyProject "$work/projects.json")
psql_admin -v project="$project_id" <<'SQL'
INSERT INTO module_record(project_id,module_id,key,value)
VALUES (:'project','core.artifacts','meta/scriptorium/modules/publishing/share-grants.jsonl',
  jsonb_build_object('content', jsonb_build_object(
    'id','fixture-grant','tokenHash',repeat('a',64),'scope','ch-first','label','Original scope',
    'createdAt','2025-01-01T00:00:00.000Z','expiresAt','2099-01-01T00:00:00.000Z','grantVersion',3,'revocationVersion',1)::text));
SQL

# Add bytes to the real private history volume, independent of PostgreSQL.
write_history_fixture() {
  podman run --rm --pull=never --network none --user 1000:1000 --entrypoint /bin/sh \
    --volume codexia-history:/history "$pg_image" -ec '
      mkdir -p /history/fixture-attachments
      printf "%s\n" "disposable attachment bytes" > /history/fixture-attachments/fragment.txt
    '
}
write_history_fixture
history_hash() {
  podman exec codexia-api sha256sum /history/fixture-attachments/fragment.txt | cut -d ' ' -f 1
}
before_history_hash=$(history_hash)
readonly before_history_hash
record established_owner_oauth_projects_and_history

hash_file() { sha256sum "$1" | cut -d ' ' -f 1; }
host() { bash "$host_program" "$1" "$request"; }
expect_denial() {
  local expected=$1
  shift
  if "$@" > "$work/denied.json" 2> "$work/denied.log"; then
    echo "Unexpectedly admitted: $*" >&2
    return 1
  fi
  grep -Fq "$expected" "$work/denied.log" || { cat "$work/denied.log" >&2; return 1; }
}
observe() { bash "$host_program" observe; }

start_plan() {
  local scenario=$1 unit="$state/candidate-epoch2.container" plan_sha
  observe > "$work/observed.json"
  plan_sha=$(printf '%s\n' "$scenario" "$(hash_file "$work/observed.json")" | sha256sum | cut -d ' ' -f 1)
  jq --arg planSha256 "$plan_sha" --arg candidateUnit "$unit" --arg notAfter "$(date -u -d '1 hour' '+%FT%T.000Z')" \
    --arg candidateUnitSha256 "$(hash_file "$unit")" --slurpfile candidate "$work/candidate-image.json" '
    {sourceHostId,databaseSystemIdentifier,priorContainerId,priorImage,priorIdentity,priorUnitSha256,
      $planSha256,$candidateUnit,$candidateUnitSha256,$notAfter,candidateImage:$candidate[0].image,candidateIdentity:$candidate[0].identity}
  ' "$work/observed.json" > "$request"
}

both_stopped() {
  observe | jq -e '.apiRunning == false and .tunnelRunning == false' >/dev/null
}

checkpoint_and_rehearse() {
  local scenario=$1 artifact manifest
  host checkpoint > "$work/checkpoint.json"
  host checkpoint > "$work/duplicate-checkpoint.json"
  cmp "$work/checkpoint.json" "$work/duplicate-checkpoint.json"
  both_stopped
  systemctl --user start codexia-api.service codexia-tunnel.service
  both_stopped
  jq --slurpfile checkpoint "$work/checkpoint.json" '
    . + ($checkpoint[0] | {checksumManifestSha256,databaseFingerprint,historyFingerprint})
  ' "$request" > "$work/request.tmp"
  mv "$work/request.tmp" "$request"
  expect_denial 'independently approved recovery receipt' host apply

  artifact=$(jq -er .backupDirectory "$work/checkpoint.json")
  independent_backup="$work/recovery-storage/$scenario"
  mkdir -p "$(dirname -- "$independent_backup")" "$work/recovery-state"
  cp -a "$artifact" "$independent_backup"
  manifest=$(bash "$CODEXIA_BACKUP_PROGRAM" validate-artifact "$independent_backup")
  [[ "$manifest" == "$(jq -er .checksumManifestSha256 "$request")" ]]
  CODEXIA_PUSH_STATE_DIR="$work/recovery-state" bash "$CODEXIA_BACKUP_PROGRAM" drill \
    "$independent_backup" "$work/recovery-key" --approved --candidate-full-image "$candidate_image" > "$work/drill.log"
  grep -Fxq 'Isolated restore verified: database and history fingerprints match' "$work/drill.log"
  grep -Fxq "Isolated maintenance rehearsal verified: $candidate_image" "$work/drill.log"
  jq -n --arg image "$candidate_image" --arg sha "$manifest" --arg run "$scenario" \
    '{fixture:"isolated restore on disposable runner",image:$image,manifestSha256:$sha,scenario:$run}' > "$work/drill-receipt.json"
  jq --arg sha "$(hash_file "$work/drill-receipt.json")" '.recoveryReceiptSha256 = $sha' "$request" > "$work/request.tmp"
  mv "$work/request.tmp" "$request"
}

verify_runtime() {
  local role=$1 epoch=$2 tunnel=$3 token
  observe > "$work/$role-host.json"
  jq --argjson epoch "$epoch" --argjson tunnel "$tunnel" --arg cluster "$before_cluster" '
    .apiRunning == true and .tunnelRunning == $tunnel and .databaseSystemIdentifier == $cluster
    and .priorIdentity.apiEpoch == $epoch and .priorIdentity.persistenceFormat == $epoch
    and .apiVersion.apiEpoch == $epoch
  ' "$work/$role-host.json" | grep -Fxq true
  [[ "$(history_hash)" == "$before_history_hash" ]]
  token=$(owner_fixture authorize "$OCI_AUTH_WEB_CLIENT" "$oci_owner_subject" | jq -er .accessToken)
  printf '%s' "$token" | podman exec -i fixture-oidc node /fixture/fixture.mjs probe - >/dev/null
  printf '%s' "$token" | podman exec -i fixture-oidc node --input-type=module -e '
    import {readFileSync} from "node:fs";
    import {get} from "node:https";
    const token = readFileSync(0, "utf8");
    const ca = readFileSync("/fixture/tls.crt");
    const origin = "https://codexia-lifecycle-proxy:4443";
    function check(path, status, authorized) {
      const headers = authorized ? { authorization: `Bearer ${token}` } : {};
      return new Promise((resolve, reject) => {
        const request = get(origin + path, {ca, headers}, response => {
          response.resume();
          if (response.statusCode !== status) reject(Error(`${path} returned ${response.statusCode}`));
          else resolve();
        });
        request.setTimeout(5000, () => request.destroy(Error("fixture request timeout")));
        request.on("error", reject);
      });
    }
    await check(`/api/projects/${process.argv[1]}/snapshot?projection=editor`, 200, true);
    await check("/api/session", 401, false);
  ' "$project_id"
  jq '{sourceHostId,databaseSystemIdentifier,apiRunning,tunnelRunning,apiVersion,
    runningContainerId:.priorContainerId,runningImage:.priorImage,runningIdentity:.priorIdentity}' \
    "$work/$role-host.json" > "$evidence/$role.json"
}

observe > "$work/before.json"
before_cluster=$(jq -er .databaseSystemIdentifier "$work/before.json")
verify_runtime prior 1 true

start_plan interruption
exec 8<> "$state/host.lock"
flock --exclusive --nonblock 8
expect_denial 'holds the deployment host lock' host checkpoint
flock --unlock 8
exec 8>&-
checkpoint_and_rehearse interruption
record checkpoint_lock_duplicate_guards_and_isolated_restore

# Delegate every invocation to Podman and kill the real host controller only
# after the packaged conversion has successfully committed its database writes.
mkdir "$work/fault-bin"
cat > "$work/fault-bin/podman" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
/usr/bin/podman "$@"
if [[ "$*" == *'/maintain-snapshot-projections.js --apply' ]]; then
  : > "$FIXTURE_INTERRUPTED_AFTER_CONVERSION"
  kill -KILL "$PPID"
fi
SH
chmod 0700 "$work/fault-bin/podman"
interrupted=0
PATH="$work/fault-bin:$PATH" FIXTURE_INTERRUPTED_AFTER_CONVERSION="$work/interrupted" host apply || interrupted=$?
[[ "$interrupted" == 137 && -f "$work/interrupted" ]]
# The short-lived Podman shim can still hold its inherited lock after the
# controller exits. Wait for that descriptor before probing recovery.
flock --wait 5 "$state/host.lock" true
both_stopped
expect_denial 'Interrupted cutover requires explicit recovery' host apply
host recover-quiesce | jq -e '.requiresRestore == true' >/dev/null
expect_denial 'Protected restore receipt is required' host recover
jq --arg receipt "$(hash_file "$work/drill-receipt.json")" '.restoreReceiptSha256 = $receipt' "$request" > "$work/request.tmp"
mv "$work/request.tmp" "$request"
expect_denial 'fingerprints disagree' host recover
both_stopped
record interrupted_after_real_conversion_failed_closed

# Simulate external operator recovery of this deliberately disposable DB from
# the inspected checkpoint, preserving its cluster and roles. The host helper
# itself only verifies the live fingerprints and restarts the pinned prior.
age -d -i "$work/recovery-key" "$independent_backup/database.dump.age" |
  podman exec -i codexia-db pg_restore --clean --if-exists --exit-on-error --single-transaction -U codexia_admin -d codexia
age -d -i "$work/recovery-key" "$independent_backup/history.tar.age" | podman volume import codexia-history -
jq -n --arg checkpoint "$(jq -er .checksumManifestSha256 "$request")" \
  '{fixture:"disposable database and history restored",manifestSha256:$checkpoint}' > "$work/restore-receipt.json"
jq --arg receipt "$(hash_file "$work/restore-receipt.json")" '.restoreReceiptSha256 = $receipt | .outcome = "prior"' \
  "$request" > "$work/request.tmp"
mv "$work/request.tmp" "$request"
host recover | jq -e '.status == "prior-ready"' >/dev/null
verify_runtime restored 1 false
host open-tunnel | jq -e '.status == "prior-tunnel"' >/dev/null
host finish > "$work/finished.json"
host finish > "$work/duplicate-finish.json"
cmp "$work/finished.json" "$work/duplicate-finish.json"
[[ "$(jq -er .image "$state/deployed-release.json")" == "$prior_image" ]]
record prior_digest_ledger_oauth_history_and_retry_restored

# A complete, newly approved run must still succeed after interrupted recovery.
start_plan successful
checkpoint_and_rehearse successful
host apply | jq -e '.status == "candidate-ready"' >/dev/null
host apply | jq -e '.status == "candidate-ready"' >/dev/null
verify_runtime candidate 2 false
[[ "$(psql_admin -c "SELECT count(*) FROM module_record WHERE module_id = 'publishing' AND key = 'share-grants'")" == 1 ]]
jq '.outcome = "candidate"' "$request" > "$work/request.tmp"
mv "$work/request.tmp" "$request"
host open-tunnel | jq -e '.status == "candidate-tunnel"' >/dev/null
host finish | jq -e '.status == "finished" and .outcome == "candidate"' >/dev/null
[[ "$(jq -er .image "$state/deployed-release.json")" == "$candidate_image" ]]
[[ ! -e "$state/cutover-transaction.json" ]]
verify_runtime candidate 2 true
record candidate_digest_ledger_oauth_history_and_retry_verified
