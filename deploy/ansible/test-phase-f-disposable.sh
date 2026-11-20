#!/usr/bin/env bash
# Disposable Ubuntu 26.04 lifecycle proof; this never targets an operator VM.
set -Eeuo pipefail
umask 077

phase_f_error() {
  local status=$?
  printf 'Phase F disposable integration failed at line %s (status %s): %s\n' "${BASH_LINENO[0]:-$LINENO}" "$status" "$BASH_COMMAND" >&2
  return 0
}
trap phase_f_error ERR

[[ "${GITHUB_ACTIONS:-}" == true && "${CODEXIA_DISPOSABLE_HOST:-}" == phase-f-integration ]] || {
  echo 'Set CODEXIA_DISPOSABLE_HOST=phase-f-integration only in the disposable Phase F workflow.' >&2
  exit 1
}
[[ "$(lsb_release -rs)" == 26.04 && "$(uname -m)" == x86_64 ]]
[[ "$(id -u)" != 0 ]]
sudo -n true
[[ -n "${GITHUB_SHA:-}" && "$GITHUB_SHA" =~ ^[a-f0-9]{40}$ ]]
[[ -n "${GH_TOKEN:-}" ]]

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)
cd /tmp
service_user=codexia-phase-f-ci
service_uid=''
service_home=''
service_group=''
node_bin=$(command -v node)
node_path=$(dirname "$node_bin")
fixture_created=false
manager_dropin_installed=false
environment_generator_installed=false
environment_generator_dir_created=false
source_installed=false
postgres_config_dir_created=false
postgres_init_dir_created=false
postgres_init_script_installed=false
test_root=$(mktemp -d /tmp/codexia-phase-f.XXXXXX)
source_dir=/opt/codexia-updater
postgres_config_dir=/etc/codexia
postgres_init_dir=$postgres_config_dir/postgres
postgres_init_script=$postgres_init_dir/010-create-app-role.sh
manager_dropin=''
environment_generator=''
evidence_dir=''

as_service() {
  sudo -H -u "$service_user" env \
    HOME="$service_home" \
    XDG_CONFIG_HOME="$service_home/.config" \
    XDG_DATA_HOME="$service_home/.local/share" \
    XDG_STATE_HOME="$service_home/.local/state" \
    XDG_RUNTIME_DIR="/run/user/$service_uid" \
    DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$service_uid/bus" \
    "$@"
}

rootless() { as_service /usr/bin/podman "$@"; }
user_systemctl() { as_service /usr/bin/systemctl --user "$@"; }

cleanup() {
  local status=$?
  local cleanup_status=0
  trap - EXIT ERR
  set +e
  evidence_files=(
    release-0.1.236.json release-0.1.245.json release-0.1.254.json
    channel-sequence-1.json channel-sequence-2.json test-channel-public.pem
    simulated-frontend-identity.json release-identities.json lifecycle-results.json
    postgres-init-access.txt
  )
  if [[ -n "${RUNNER_TEMP:-}" ]]; then
    evidence_copy="$RUNNER_TEMP/codexia-phase-f-evidence"
    if ! mkdir -p "$evidence_copy"; then
      printf 'Cannot create Phase F evidence artifact directory: %s\n' "$evidence_copy" >&2
      cleanup_status=1
    fi
    if [[ -n "$evidence_dir" ]] && sudo test -d "$evidence_dir" && ! sudo test -L "$evidence_dir"; then
      for evidence_file in "${evidence_files[@]}"; do
        evidence_source="$evidence_dir/$evidence_file"
        if sudo test -e "$evidence_source" || sudo test -L "$evidence_source"; then
          if ! sudo test -f "$evidence_source" || sudo test -L "$evidence_source"; then
            printf 'Refusing non-regular Phase F evidence file: %s\n' "$evidence_file" >&2
            cleanup_status=1
            continue
          fi
          if ! sudo install -m 0644 -- "$evidence_source" "$evidence_copy/$evidence_file"; then
            cleanup_status=1
            continue
          fi
          sudo chown "$(id -u):$(id -g)" "$evidence_copy/$evidence_file" || cleanup_status=1
        elif (( status == 0 )); then
          printf 'Successful Phase F run is missing source evidence: %s\n' "$evidence_file" >&2
          cleanup_status=1
        fi
      done
    elif (( status == 0 )); then
      printf 'Successful Phase F run is missing its real, non-symlink evidence directory: %s\n' "${evidence_dir:-unset}" >&2
      cleanup_status=1
    fi
    if (( status == 0 )); then
      for evidence_file in "${evidence_files[@]}"; do
        if [[ ! -s "$evidence_copy/$evidence_file" ]]; then
          printf 'Successful Phase F run is missing uploaded evidence: %s\n' "$evidence_file" >&2
          cleanup_status=1
        fi
      done
    fi
  elif (( status == 0 )); then
    printf '%s\n' 'Successful Phase F run has no RUNNER_TEMP for its evidence artifacts.' >&2
    cleanup_status=1
  fi
  if [[ "$fixture_created" == true ]] && id "$service_user" >/dev/null 2>&1; then
    user_systemctl stop codexia-slot-blue.service codexia-slot-green.service codexia-api-proxy.service codexia-db.service >/dev/null 2>&1 || true
    user_systemctl stop codexia-network.service codexia-data-network.service codexia-data-volume.service codexia-history-volume.service codexia-postgres-volume.service >/dev/null 2>&1 || true
    rootless rm --force --volumes codexia-phase-f-initialize codexia-slot-blue codexia-slot-green codexia-api-proxy codexia-db >/dev/null 2>&1 || true
    rootless network rm codexia-data codexia >/dev/null 2>&1 || true
    rootless volume rm codexia-postgres codexia-data codexia-history >/dev/null 2>&1 || true
    rootless secret rm codexia-auth-token codexia-postgres-admin-password codexia-postgres-app-password codexia-postgres-preflight-password >/dev/null 2>&1 || true
    as_service rm -f \
      "$service_home/.config/containers/systemd/codexia-slot-blue.container" \
      "$service_home/.config/containers/systemd/codexia-slot-green.container" \
      "$service_home/.config/containers/systemd/codexia-api-proxy.container" \
      "$service_home/.config/containers/systemd/codexia-db.container" \
      "$service_home/.config/containers/systemd/codexia.network" \
      "$service_home/.config/containers/systemd/codexia-data.network" \
      "$service_home/.config/containers/systemd/codexia-data.volume" \
      "$service_home/.config/containers/systemd/codexia-history.volume" \
      "$service_home/.config/containers/systemd/codexia-postgres.volume" || cleanup_status=1
    user_systemctl daemon-reload >/dev/null 2>&1 || true
    sudo loginctl disable-linger "$service_user" >/dev/null 2>&1 || cleanup_status=1
    sudo systemctl stop "user@$service_uid.service" >/dev/null 2>&1 || true
    if [[ "$environment_generator_installed" == true ]]; then sudo rm -f -- "$environment_generator" || cleanup_status=1; fi
    if [[ "$environment_generator_dir_created" == true ]]; then sudo rmdir /run/systemd/user-environment-generators 2>/dev/null || cleanup_status=1; fi
    if [[ "$manager_dropin_installed" == true ]]; then sudo rm -f -- "$manager_dropin" || cleanup_status=1; fi
    sudo rmdir "/run/systemd/system/user@${service_uid}.service.d" 2>/dev/null || true
    sudo systemctl daemon-reload >/dev/null 2>&1 || cleanup_status=1
    if [[ "$postgres_init_script_installed" == true ]]; then sudo rm -f -- "$postgres_init_script" || cleanup_status=1; fi
    if [[ "$postgres_init_dir_created" == true ]]; then sudo rmdir -- "$postgres_init_dir" 2>/dev/null || cleanup_status=1; fi
    if [[ "$postgres_config_dir_created" == true ]]; then sudo rmdir -- "$postgres_config_dir" 2>/dev/null || cleanup_status=1; fi
    sudo userdel --remove "$service_user" >/dev/null 2>&1 || cleanup_status=1
  fi
  if [[ "$source_installed" == true ]]; then sudo rm -rf -- "$source_dir" || cleanup_status=1; fi
  rm -rf -- "$test_root" || cleanup_status=1
  printf 'Phase F disposable cleanup finished with test status %s and cleanup status %s.\n' "$status" "$cleanup_status" >&2
  if (( status == 0 && cleanup_status != 0 )); then status=$cleanup_status; fi
  exit "$status"
}
trap cleanup EXIT

if getent passwd "$service_user" >/dev/null || sudo test -e "$source_dir"; then
  echo 'Disposable service identity or updater source path already exists; refusing to adopt it.' >&2
  exit 1
fi
if sudo test -e "$postgres_config_dir" || sudo test -L "$postgres_config_dir"; then
  echo 'Disposable PostgreSQL fixture path already exists; refusing to adopt it.' >&2
  exit 1
fi
sudo -n apt-get update -qq
sudo -n apt-get install -y --no-install-recommends \
  podman uidmap netavark aardvark-dns passt slirp4netns fuse-overlayfs dbus-user-session jq

sudo useradd --create-home --shell /bin/bash "$service_user"
fixture_created=true
service_uid=$(id -u "$service_user")
service_home=$(getent passwd "$service_user" | cut -d: -f6)
service_group=$(id -gn "$service_user")
[[ "$service_uid" -gt 0 && "$service_home" == "/home/$service_user" ]]
[[ -n "$service_group" ]]
if sudo -H -u "$service_user" sudo -n true 2>/dev/null; then
  echo 'The fixture service account unexpectedly has sudo privileges.' >&2
  exit 1
fi
subuid_max=$(awk -F: 'BEGIN { max = 100000 } { end = $2 + $3; if (end > max) max = end } END { print max }' /etc/subuid)
subgid_max=$(awk -F: 'BEGIN { max = 100000 } { end = $2 + $3; if (end > max) max = end } END { print max }' /etc/subgid)
subuid_start=$(( (subuid_max + 65535) / 65536 * 65536 ))
subgid_start=$(( (subgid_max + 65535) / 65536 * 65536 ))
sudo usermod --add-subuids "$subuid_start-$((subuid_start + 65535))" --add-subgids "$subgid_start-$((subgid_start + 65535))" "$service_user"

manager_dropin_dir="/run/systemd/system/user@${service_uid}.service.d"
manager_dropin="$manager_dropin_dir/10-codexia-phase-f-ci.conf"
sudo install -d -m 0755 "$manager_dropin_dir"
sudo test ! -e "$manager_dropin"
cat > "$test_root/user-manager.conf" <<EOF
[Service]
Environment=HOME=$service_home
Environment=XDG_CONFIG_HOME=$service_home/.config
Environment=XDG_RUNTIME_DIR=/run/user/$service_uid
EOF
sudo install -m 0644 "$test_root/user-manager.conf" "$manager_dropin"
manager_dropin_installed=true
sudo systemctl daemon-reload
sudo loginctl enable-linger "$service_user"
sudo systemctl restart "user@$service_uid.service"
for attempt in $(seq 1 30); do
  if as_service /usr/bin/systemctl --user show --property=Version >/dev/null 2>&1; then break; fi
  sleep 1
done
as_service /usr/bin/systemctl --user show --property=Version >/dev/null

environment_generator_dir=/run/systemd/user-environment-generators
environment_generator="$environment_generator_dir/99-codexia-phase-f-xdg-$service_uid"
if [[ ! -d "$environment_generator_dir" ]]; then sudo install -d -m 0755 "$environment_generator_dir"; environment_generator_dir_created=true; fi
[[ ! -e "$environment_generator" && ! -L "$environment_generator" ]]
cat > "$test_root/user-environment-generator" <<EOF
#!/bin/sh
if [ "\$(id -u)" = "$service_uid" ]; then
  printf '%s\\n' 'XDG_CONFIG_HOME=$service_home/.config' 'XDG_RUNTIME_DIR=/run/user/$service_uid'
fi
EOF
sudo install -m 0755 "$test_root/user-environment-generator" "$environment_generator"
environment_generator_installed=true
as_service /usr/bin/systemctl --user import-environment HOME XDG_CONFIG_HOME XDG_RUNTIME_DIR
as_service /usr/bin/systemctl --user daemon-reload
manager_environment=$(as_service /usr/bin/systemctl --user show-environment)
for expected in "HOME=$service_home" "XDG_CONFIG_HOME=$service_home/.config" "XDG_RUNTIME_DIR=/run/user/$service_uid"; do
  grep -Fqx "$expected" <<<"$manager_environment" || {
    printf 'Disposable user manager is missing expected environment %s.\n' "${expected%%=*}" >&2
    printf '%s\n' "$manager_environment" | grep -E '^(HOME|XDG_CONFIG_HOME|XDG_RUNTIME_DIR)=' >&2 || true
    exit 1
  }
done
[[ "$(rootless info --format '{{.Host.Security.Rootless}}')" == true ]]

sudo install -d -m 0755 -o root -g root "$source_dir"
source_installed=true
sudo cp -a "$repo_root/." "$source_dir/"
sudo chown -R root:root "$source_dir"

fixture_data="$service_home/.local/share/codexia-phase-f"
quadlet_dir="$service_home/.config/containers/systemd"
state_dir="$service_home/.local/state/codexia-updater"
config_dir="$service_home/.config/codexia-updater"
secret_dir="$fixture_data/secrets"
evidence_dir="$fixture_data/evidence"
as_service install -d -m 0700 "$fixture_data" "$quadlet_dir" "$state_dir" "$config_dir" "$secret_dir" "$evidence_dir"

# Pull and validate only the three exact published image digests in the channel fixture.
sudo --preserve-env=GH_TOKEN,GITHUB_SHA -H -u "$service_user" env \
  HOME="$service_home" XDG_CONFIG_HOME="$service_home/.config" XDG_DATA_HOME="$service_home/.local/share" \
  XDG_STATE_HOME="$service_home/.local/state" XDG_RUNTIME_DIR="/run/user/$service_uid" \
  DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$service_uid/bus" \
  "$node_bin" "$source_dir/scripts/phase-f-test-channel.mjs" --out "$evidence_dir"

for file in codexia.network codexia-data.network codexia-data.volume codexia-history.volume codexia-postgres.volume; do
  sudo install -o "$service_user" -g "$service_group" -m 0600 "$source_dir/deploy/quadlet/$file" "$quadlet_dir/$file"
done
sudo install -d -o root -g root -m 0755 "$postgres_config_dir"
postgres_config_dir_created=true
sudo install -d -o "$service_user" -g root -m 0750 "$postgres_init_dir"
postgres_init_dir_created=true
sudo install -o "$service_user" -g root -m 0555 "$source_dir/deploy/postgres/010-create-app-role.sh" "$postgres_init_script"
postgres_init_script_installed=true
sed \
  -e '/Secret=codexia-postgres-app-password/a Secret=codexia-postgres-preflight-password,type=mount,target=/run/secrets/preflight-password' \
  "$source_dir/deploy/quadlet/codexia-db.container" > "$test_root/codexia-db.container"
sudo install -o "$service_user" -g "$service_group" -m 0600 "$test_root/codexia-db.container" "$quadlet_dir/codexia-db.container"

# All values are generated inside the fixture account and remain in Podman secrets.
as_service "$node_bin" --input-type=module - "$secret_dir" <<'NODE'
import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
const dir = process.argv[2];
for (const name of ['auth-token', 'admin-password', 'app-password', 'preflight-password']) {
  await writeFile(path.join(dir, name), randomBytes(32).toString('hex'), { mode: 0o400 });
}
NODE
rootless secret create codexia-auth-token "$secret_dir/auth-token" >/dev/null
rootless secret create codexia-postgres-admin-password "$secret_dir/admin-password" >/dev/null
rootless secret create codexia-postgres-app-password "$secret_dir/app-password" >/dev/null
rootless secret create codexia-postgres-preflight-password "$secret_dir/preflight-password" >/dev/null

postgres_image=$(sed -n 's/^Image=//p' "$source_dir/deploy/quadlet/codexia-db.container")
[[ "$postgres_image" =~ ^docker\.io/library/postgres:17-bookworm@sha256:[a-f0-9]{64}$ ]]
{
  printf '%s\n' '=== Host rootless account and PostgreSQL init bind source ==='
  id "$service_user"
  sudo stat --printf='host-file=%n mode=%a uid=%u gid=%g owner=%U group=%G\n' "$postgres_init_script"
  sudo stat --printf='host-parent=%n mode=%a uid=%u gid=%g owner=%U group=%G\n' "$postgres_init_dir"
  printf '%s\n' '=== Podman rootless user namespace maps ==='
  rootless unshare sh -c 'printf "uid_map:\n"; cat /proc/self/uid_map; printf "gid_map:\n"; cat /proc/self/gid_map'
  printf '%s\n' '=== Exact pinned PostgreSQL image bind read as the postgres user ==='
  rootless run --rm --user postgres --entrypoint /bin/sh \
    --volume "$postgres_init_script:/docker-entrypoint-initdb.d/010-create-app-role.sh:ro,Z" \
    "$postgres_image" -ec '
      id
      printf "container uid_map:\n"
      cat /proc/self/uid_map
      printf "container gid_map:\n"
      cat /proc/self/gid_map
      stat --printf="container-file=%n mode=%a uid=%u gid=%g owner=%U group=%G\\n" /docker-entrypoint-initdb.d/010-create-app-role.sh
      test -r /docker-entrypoint-initdb.d/010-create-app-role.sh
      test -x /docker-entrypoint-initdb.d/010-create-app-role.sh
      cat /docker-entrypoint-initdb.d/010-create-app-role.sh >/dev/null
      echo "postgres-user can read the exact init bind"
    '
} 2>&1 | as_service tee "$evidence_dir/postgres-init-access.txt"

as_service /usr/bin/systemctl --user daemon-reload
user_systemctl start codexia-data-volume.service codexia-history-volume.service
user_systemctl start codexia-db.service
db_ready=false
for attempt in $(seq 1 90); do
  if rootless exec codexia-db pg_isready -U codexia_admin -d codexia >/dev/null 2>&1; then db_ready=true; break; fi
  if [[ "$(rootless inspect --format '{{.State.Running}}' codexia-db 2>/dev/null || true)" != true ]]; then break; fi
  sleep 1
done
[[ "$db_ready" == true ]] || {
  user_systemctl status codexia-db.service --no-pager >&2 || true
  user_systemctl show codexia-db.service \
    --property=LoadState,ActiveState,SubState,Result,ExecMainCode,ExecMainStatus --no-pager >&2 || true
  as_service /usr/bin/journalctl --user --unit=codexia-db.service --no-pager -n 80 >&2 || true
  rootless ps --all --no-trunc >&2 || true
  rootless logs codexia-db >&2 || true
  echo 'Fixture PostgreSQL did not become ready.' >&2
  exit 1
}

base_image=$(as_service /usr/bin/jq -r .image "$evidence_dir/release-0.1.236.json")
database_id_before=$(rootless inspect --format '{{.Id}}' codexia-db)
data_volume_before=$(rootless volume inspect --format '{{.Name}}|{{.Mountpoint}}' codexia-data)
history_volume_before=$(rootless volume inspect --format '{{.Name}}|{{.Mountpoint}}' codexia-history)

# Initialize only this new CI database with the real, digest-pinned baseline workload.
rootless run --detach --name codexia-phase-f-initialize --network codexia-data \
  --read-only --tmpfs /tmp:rw,nosuid,nodev,noexec,size=64m \
  --tmpfs /data:rw,nosuid,nodev,noexec,size=128m,mode=1777 \
  --tmpfs /history:rw,nosuid,nodev,noexec,size=64m,mode=1777 \
  --cap-drop all --security-opt no-new-privileges \
  --secret codexia-auth-token,type=mount,target=/run/secrets/codexia-auth-token \
  --secret codexia-postgres-app-password,type=mount,target=/run/secrets/app-password \
  --env CODEXIA_AUTH_TOKEN_FILE=/run/secrets/codexia-auth-token \
  --env CODEXIA_DATA_DIR=/data --env CODEXIA_USAGE_DIR=/history \
  --env CODEXIA_DATABASE_PASSWORD_FILE=/run/secrets/app-password \
  --env CODEXIA_DATABASE_USER=codexia --env CODEXIA_DATABASE_NAME=codexia \
  --env CODEXIA_DATABASE_HOST=codexia-db --env CODEXIA_DATABASE_MIGRATE_ON_START=1 \
  --env CODEXIA_HOSTED_MODE=0 --env CODEXIA_PROFILE=core --env CODEXIA_BROWSER_AUTH=token \
  --env CODEXIA_TRUST_PROXY=1 "$base_image" >/dev/null
database_migrated=false
for attempt in $(seq 1 90); do
  if rootless exec codexia-phase-f-initialize node -e 'fetch("http://127.0.0.1:3000/health/ready").then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))' >/dev/null 2>&1; then database_migrated=true; break; fi
  if [[ "$(rootless inspect --format '{{.State.Running}}' codexia-phase-f-initialize 2>/dev/null || true)" != true ]]; then break; fi
  sleep 1
done
[[ "$database_migrated" == true ]] || { rootless logs codexia-phase-f-initialize >&2 || true; echo 'The pinned baseline image did not initialize the new fixture database.' >&2; exit 1; }
rootless rm --force codexia-phase-f-initialize >/dev/null

rootless exec -i codexia-db sh -ec 'PREFLIGHT_PASSWORD="$(cat /run/secrets/preflight-password)"; export PREFLIGHT_PASSWORD; exec psql -X -v ON_ERROR_STOP=1 -U codexia_admin -d codexia' <<'SQL'
\getenv preflight_password PREFLIGHT_PASSWORD
CREATE ROLE codexia_preflight LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD :'preflight_password';
ALTER ROLE codexia_preflight SET default_transaction_read_only = on;
GRANT CONNECT ON DATABASE codexia TO codexia_preflight;
GRANT USAGE ON SCHEMA public TO codexia_preflight;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO codexia_preflight;
SQL

proxy_image=$base_image
sed "s|ghcr.io/yohn-jp/codexia-backend@sha256:REPLACE_WITH_VERIFIED_DIGEST|$proxy_image|g" \
  "$repo_root/deploy/updater/codexia-api-proxy.container.example" > "$test_root/codexia-api-proxy.container"
sudo install -o "$service_user" -g "$service_group" -m 0600 "$test_root/codexia-api-proxy.container" "$quadlet_dir/codexia-api-proxy.container"
as_service install -d -m 0700 "$state_dir"
as_service sh -c 'printf "blocked\\n" > "$1/route"' sh "$state_dir"

channel_file="$state_dir/phase-f-channel.json"
as_service install -m 0600 "$evidence_dir/channel-sequence-1.json" "$channel_file"
as_service install -m 0600 "$evidence_dir/test-channel-public.pem" "$config_dir/channel-public.pem"
as_service install -m 0600 "$evidence_dir/simulated-frontend-identity.json" "$config_dir/frontend-identity.json"
as_service sh -c 'printf "%s\\n" "fixture-only-no-network" > "$1/github-read-token"' sh "$config_dir"

frontend_url=https://codexia-phase-f.fixture.invalid/desktop/update-identity.json
cat > "$test_root/updater-config.json" <<EOF
{
  "format": "codexia-standalone-updater/v1",
  "enabled": false,
  "stateFile": "$state_dir/controller.json",
  "routeFile": "$state_dir/route",
  "quadletDirectory": "$quadlet_dir",
  "publicKeyFile": "$config_dir/channel-public.pem",
  "githubTokenFile": "$config_dir/github-read-token",
  "frontendIdentityUrl": "$frontend_url",
  "observeMilliseconds": 300000,
  "initialSlot": "blue",
  "browserAuth": { "mode": "token" }
}
EOF
sudo install -o "$service_user" -g "$service_group" -m 0600 "$test_root/updater-config.json" "$config_dir/config.json"

user_systemctl daemon-reload
user_systemctl start codexia-db.service codexia-api-proxy.service
for attempt in $(seq 1 30); do
  if rootless container exists codexia-api-proxy; then break; fi
  sleep 1
done
rootless container exists codexia-api-proxy

updater="$source_dir/deploy/updater/codexia-updater"
loader="$source_dir/scripts/phase-f-fetch-loader.mjs"
config_file="$config_dir/config.json"
frontend_identity_file="$config_dir/frontend-identity.json"
run_updater() {
  as_service env \
    PATH="$node_path:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
    NODE_OPTIONS="--import=$loader" \
    CODEXIA_PHASE_F_CHANNEL_FILE="$channel_file" \
    CODEXIA_PHASE_F_FRONTEND_URL="$frontend_url" \
    CODEXIA_PHASE_F_FRONTEND_IDENTITY_FILE="$frontend_identity_file" \
    sh "$updater" "$@"
}
if ! run_updater init "$config_file" "$evidence_dir/release-0.1.236.json" > "$test_root/init.json"; then
  printf 'Disposable initial activation failed; safe state detail follows:\n' >&2
  if [[ -s "$test_root/init.json" ]]; then
    /usr/bin/jq -r '(.lastError // empty), (.journal.phase // empty)' "$test_root/init.json" >&2 || true
  else
    printf 'Updater returned no state JSON.\n' >&2
  fi
  printf 'Disposable proxy image identities (digest and content IDs only):\n' >&2
  rootless image inspect --format 'imageID={{.Id}} repoDigests={{json .RepoDigests}}' "$base_image" >&2 || true
  rootless inspect --type container --format 'containerImage={{.Image}} containerImageName={{.ImageName}}' codexia-api-proxy >&2 || true
  rootless inspect --type container --format 'proxyMounts={{json .Mounts}}' codexia-api-proxy >&2 || true
  exit 1
fi

assert_controller_status() {
  local file=$1 expected_image=$2 expected_route=$3 expected_phase=$4 expected_paused=$5
  node --input-type=module - "$file" "$expected_image" "$expected_route" "$expected_phase" "$expected_paused" <<'NODE'
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
  const [file, image, route, phase, paused] = process.argv.slice(2);
const result = JSON.parse(readFileSync(file, 'utf8'));
assert.equal(result.state.installed.image, image);
assert.equal(result.state.journal.phase, phase);
assert.equal(result.state.paused, paused === 'true');
assert.equal(result.observed.route, route);
assert.equal(result.observed.writers.length, 1);
assert.deepEqual(result.observed.writers[0], { slot: route, image });
NODE
}
run_updater status "$config_file" > "$test_root/status-initial.json"
assert_controller_status "$test_root/status-initial.json" "$base_image" blue idle true
database_id_after_init=$(rootless inspect --format '{{.Id}}' codexia-db)
[[ "$database_id_after_init" == "$database_id_before" ]]

# Create one real authoring record on the initial writer and preserve its ID through all transitions.
project_id=$(rootless exec -i codexia-slot-blue node --input-type=module <<'NODE'
import { readFileSync } from 'node:fs';
const origin = 'http://127.0.0.1:3000';
const token = readFileSync('/run/secrets/codexia-auth-token', 'utf8').trim();
const login = await fetch(origin + '/api/login', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) });
if (!login.ok) throw new Error('Disposable author login failed');
const cookie = login.headers.get('set-cookie')?.split(';', 1)[0];
if (!cookie) throw new Error('Disposable author session cookie unavailable');
const response = await fetch(origin + '/api/projects', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ title: 'Phase F signed lifecycle preservation' }) });
if (!response.ok) throw new Error('Disposable author project creation failed: ' + response.status);
const project = await response.json();
if (typeof project.id !== 'string' || !project.id) throw new Error('Disposable author project identity unavailable');
process.stdout.write(project.id);
NODE
)
[[ -n "$project_id" ]]

run_updater acceptance-update "$config_file" > "$test_root/update.json"
run_updater status "$config_file" > "$test_root/status-updated.json"
middle_image=$(as_service /usr/bin/jq -r .image "$evidence_dir/release-0.1.245.json")
assert_controller_status "$test_root/status-updated.json" "$middle_image" green committed true
run_updater acceptance-rollback "$config_file" > "$test_root/rollback.json"
run_updater verify "$config_file" > "$test_root/verify-rollback.json"
run_updater status "$config_file" > "$test_root/status-rollback.json"
assert_controller_status "$test_root/status-rollback.json" "$base_image" blue committed true
[[ "$(rootless inspect --format '{{.Id}}' codexia-db)" == "$database_id_before" ]]
[[ "$(rootless volume inspect --format '{{.Name}}|{{.Mountpoint}}' codexia-data)" == "$data_volume_before" ]]
[[ "$(rootless volume inspect --format '{{.Name}}|{{.Mountpoint}}' codexia-history)" == "$history_volume_before" ]]

rootless exec -i codexia-slot-blue node --input-type=module - "$project_id" <<'NODE'
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const origin = 'http://127.0.0.1:3000';
const token = readFileSync('/run/secrets/codexia-auth-token', 'utf8').trim();
const login = await fetch(origin + '/api/login', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) });
assert.equal(login.ok, true);
const cookie = login.headers.get('set-cookie')?.split(';', 1)[0];
assert.ok(cookie);
const response = await fetch(origin + '/api/projects', { headers: { Origin: origin, Cookie: cookie } });
assert.equal(response.ok, true);
const projects = await response.json();
assert.ok(projects.some(project => project.id === process.argv[2] && project.title === 'Phase F signed lifecycle preservation'));
NODE

# Advance the signed test channel to a third published image so the earlier rollback does not suppress it.
as_service install -m 0600 "$evidence_dir/channel-sequence-2.json" "$channel_file"
newest_image=$(as_service /usr/bin/jq -r .image "$evidence_dir/release-0.1.254.json")
crash_bin="$fixture_data/crash-bin"
as_service install -d -m 0700 "$crash_bin"
cat > "$test_root/systemctl-crash" <<EOF
#!/bin/sh
if [ "\$1" = "--user" ] && [ "\$2" = "stop" ] && [ "\$3" = "codexia-slot-blue.service" ]; then
  /usr/bin/systemctl "\$@"
  marker="$fixture_data/interruption-injected"
  printf '%s\\n' interrupted-after-active-writer-stop > "\$marker"
  parent_command=\$(tr '\\000' ' ' < "/proc/\$PPID/cmdline")
  case "\$parent_command" in *standalone-updater.mjs*) ;; *) exit 93 ;; esac
  kill -KILL "\$PPID"
  exit 137
fi
exec /usr/bin/systemctl "\$@"
EOF
sudo install -o "$service_user" -g "$service_group" -m 0700 "$test_root/systemctl-crash" "$crash_bin/systemctl"
set +e
as_service env \
  PATH="$crash_bin:$node_path:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
  NODE_OPTIONS="--import=$loader" \
  CODEXIA_PHASE_F_CHANNEL_FILE="$channel_file" \
  CODEXIA_PHASE_F_FRONTEND_URL="$frontend_url" \
  CODEXIA_PHASE_F_FRONTEND_IDENTITY_FILE="$frontend_identity_file" \
  sh "$updater" acceptance-update "$config_file" > "$test_root/interrupted-update.out" 2> "$test_root/interrupted-update.err"
interrupt_status=$?
set -e
[[ "$interrupt_status" == 137 ]] && as_service test -s "$fixture_data/interruption-injected" || {
  cat "$test_root/interrupted-update.err" >&2
  echo 'The updater was not interrupted after stopping the prior writer.' >&2
  exit 1
}
run_updater status "$config_file" > "$test_root/status-interrupted.json"
node --input-type=module - "$test_root/status-interrupted.json" "$base_image" "$newest_image" <<'NODE'
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const [file, activeImage, candidateImage] = process.argv.slice(2);
const { state, observed } = JSON.parse(readFileSync(file, 'utf8'));
assert.equal(state.journal.phase, 'draining');
assert.equal(state.installed.image, activeImage);
assert.equal(state.journal.candidate.image, candidateImage);
assert.equal(observed.route, 'blocked');
assert.equal(observed.writers.length, 0);
NODE

set +e
run_updater boot "$config_file" > "$test_root/boot-recovery.json" 2> "$test_root/boot-recovery.err"
boot_status=$?
set -e
[[ "$boot_status" == 1 ]]
run_updater resume "$config_file" > "$test_root/resume-recovery.json"
run_updater pause "$config_file" > "$test_root/pause-recovery.json"
run_updater verify "$config_file" > "$test_root/verify-recovery.json"
run_updater status "$config_file" > "$test_root/status-recovered.json"
assert_controller_status "$test_root/status-recovered.json" "$base_image" blue idle true
recovery_error=$(node -e 'process.stdout.write(JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8")).lastError ?? "")' "$test_root/boot-recovery.json")
[[ "$recovery_error" == 'Interrupted update recovered from durable journal' ]]

# Deliberate disposable route-state drift must be rejected by the existing host verifier; it remains closed.
as_service sh -c 'printf "blocked\\n" > "$1/route"' sh "$state_dir"
set +e
run_updater verify "$config_file" > "$test_root/drift.out" 2> "$test_root/drift.err"
drift_status=$?
set -e
[[ "$drift_status" != 0 ]]
grep -Fq 'Proxy route mismatch' "$test_root/drift.err"
[[ "$(rootless inspect --format '{{.State.Running}}' codexia-slot-blue)" == true ]]
[[ "$(as_service cat "$state_dir/route")" == blocked ]]
rootless exec codexia-api-proxy node --input-type=module -e 'const response=await fetch("http://127.0.0.1:3000/api/version"); if(response.status!==503) process.exit(1)' \
  || { echo 'The proxy did not fail closed while the disposable route was blocked.' >&2; exit 1; }

as_service "$node_bin" --input-type=module - "$evidence_dir" "$GITHUB_SHA" "$project_id" <<'NODE'
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
const [directory, sourceSha, projectId] = process.argv.slice(2);
const result = {
  format: 'codexia-phase-f-disposable-results/v1', sourceSha,
  testOnlySigning: 'PASS: fresh ephemeral Ed25519 key; channel verifier mechanics only, not production publisher authority.',
  sourceCertification: 'PASS: exact release tags, successful main verify/backend-release jobs, immutable GHCR digests, OCI revision labels, embedded identities, and packaged migration fingerprints checked.',
  signedUpdate: 'PASS: 0.1.236 to 0.1.245 via the locked updater on rootless Podman/systemd.',
  signedRollback: 'PASS: 0.1.245 to 0.1.236 via the locked updater; API-created project persisted.',
  interruptedUpdateRecovery: 'PASS: killed updater after old writer stop; boot restored the recorded prior writer and pause was retained.',
  drift: 'PASS: invalid disposable route state was rejected by the updater verifier and remained blocked.',
  preserved: { projectId, postgresContainer: 'same container ID before/after transitions', volumes: ['codexia-data', 'codexia-history'] },
  simulated: ['stable-channel endpoint', 'frontend identity endpoint'],
  notChecked: [
    'Production signed channel and production publisher authority',
    'Live public identity, Cloudflare Access denial, and human author UI acceptance',
    'VM reboot during update',
    'Remote backup destination, external recovery key custody, target recovery host, and measured RPO/RTO',
    'End-to-end Ansible fresh/repeat apply, adoption, and D cutover',
  ],
};
await writeFile(path.join(directory, 'lifecycle-results.json'), JSON.stringify(result, null, 2) + '\n', { mode: 0o644 });
NODE
echo 'PASS: rootless Podman/systemd signed update, rollback, durable interruption recovery, project/data-volume preservation, and route-state drift rejection.'
echo 'NOT_CHECKED: production channel/identity/Access/author UI, VM reboot, remote recovery/RPO/RTO, and D cutover.'
