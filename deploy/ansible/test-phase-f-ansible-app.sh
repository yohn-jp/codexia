#!/usr/bin/env bash
# Run a clean Ansible application lifecycle on the disposable Phase F host identity.
set -Eeuo pipefail
umask 077

fail() { printf '%s\n' "$*" >&2; exit 1; }
[[ "$GITHUB_ACTIONS" == true && "$CODEXIA_DISPOSABLE_HOST" == phase-f-integration ]] || fail 'Run only inside the disposable Phase F workflow.'
[[ "$(lsb_release -rs)" == 26.04 && "$(uname -m)" == x86_64 ]] || fail 'Unsupported Phase F runner.'
[[ "$(id -u)" != 0 ]] || fail 'The workflow must use its non-root bootstrap identity.'
[[ -n "$RUNNER_TEMP" && -d "$RUNNER_TEMP" && "$GITHUB_SHA" =~ ^[a-f0-9]{40}$ ]] || fail 'GitHub run evidence environment is incomplete.'
[[ -n "$GH_TOKEN" ]] || fail 'Read-only Actions token is required for source-certified release verification.'
ansible_playbook=$ANSIBLE_PLAYBOOK
[[ -x "$ansible_playbook" ]] || fail 'The isolated Ansible control environment is unavailable.'

repo_root=$(cd "$(dirname "$0")/../.." && pwd -P)
# The runner checkout is not traversable by the service user. Resolve every
# source path first, then use an accessible cwd for direct sudo-as-service calls.
cd /tmp
service_user=codexia-ci-host
service_uid=22001
service_group=codexia-ci-host
service_home=/home/codexia-ci-host
phase_dir=$service_home/.local/state/codexia-phase-f-app
source_root=/tmp/codexia-phase-f-app-source-$service_uid-$$
tmp=$(mktemp -d /tmp/codexia-phase-f-app.XXXXXX)
evidence_dir=$RUNNER_TEMP/codexia-phase-f-evidence
runtime_owned=false
source_owned=false
phase_dir_owned=false
phase_f_xdg_generator_dir=/run/systemd/user-environment-generators
phase_f_xdg_generator_path="$phase_f_xdg_generator_dir/99-codexia-phase-f-xdg-$service_uid-$$"
phase_f_xdg_generator_installed=false
phase_f_xdg_generator_dir_created=false
mkdir -p "$evidence_dir"

as_service() {
  sudo -H -u "$service_user" env HOME="$service_home" \
    XDG_CONFIG_HOME="$service_home/.config" XDG_DATA_HOME="$service_home/.local/share" \
    XDG_STATE_HOME="$service_home/.local/state" XDG_RUNTIME_DIR="/run/user/$service_uid" \
    DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$service_uid/bus" \
    bash -c 'cd "$HOME" && exec "$@"' bash "$@"
}
rootless() { as_service /usr/bin/podman "$@"; }
user_systemctl() { as_service /usr/bin/systemctl --user "$@"; }

cleanup() {
  local status=$? cleanup_status=0 observed_uid observed_home
  trap - EXIT
  set +e
  if [[ "$runtime_owned" == true ]] && getent passwd "$service_user" >/dev/null 2>&1; then
    observed_uid=$(id -u "$service_user" 2>/dev/null || true)
    observed_home=$(getent passwd "$service_user" | cut -d: -f6)
    if [[ "$observed_uid" != "$service_uid" || "$observed_home" != "$service_home" ]]; then
      printf 'Refusing application fixture cleanup after service identity drift: %s\n' "$service_user" >&2
      cleanup_status=1
    else
      user_systemctl stop codexia-updater.timer codexia-updater-boot.service codexia-updater.service \
        codexia-preflight-blue.service codexia-preflight-green.service codexia-slot-blue.service \
        codexia-slot-green.service codexia-api-proxy.service codexia-tunnel.service codexia-db.service \
        codexia-postgres-volume.service codexia-data-volume.service codexia-history-volume.service >/dev/null 2>&1 || true
      user_systemctl disable codexia-updater-boot.service >/dev/null 2>&1 || true
      rootless rm -f codexia-preflight-blue codexia-preflight-green codexia-slot-blue codexia-slot-green \
        codexia-api-proxy codexia-tunnel codexia-db >/dev/null 2>&1 || true
      as_service rm -f \
        "$service_home/.config/containers/systemd/codexia.network" \
        "$service_home/.config/containers/systemd/codexia-data.network" \
        "$service_home/.config/containers/systemd/codexia-postgres.volume" \
        "$service_home/.config/containers/systemd/codexia-data.volume" \
        "$service_home/.config/containers/systemd/codexia-history.volume" \
        "$service_home/.config/containers/systemd/codexia-db.container" \
        "$service_home/.config/containers/systemd/codexia-tunnel.container" \
        "$service_home/.config/containers/systemd/codexia-api-proxy.container" \
        "$service_home/.config/containers/systemd/codexia-slot-blue.container" \
        "$service_home/.config/containers/systemd/codexia-slot-green.container" \
        "$service_home/.config/containers/systemd/codexia-preflight-blue.container" \
        "$service_home/.config/containers/systemd/codexia-preflight-green.container" \
        "$service_home/.config/systemd/user/codexia-updater-boot.service" \
        "$service_home/.config/systemd/user/codexia-updater.service" \
        "$service_home/.config/systemd/user/codexia-updater.timer" || cleanup_status=1
      user_systemctl daemon-reload >/dev/null 2>&1 || cleanup_status=1
      user_systemctl reset-failed >/dev/null 2>&1 || true
      rootless network rm codexia-data codexia >/dev/null 2>&1 || true
      rootless volume rm codexia-postgres codexia-data codexia-history >/dev/null 2>&1 || true
      rootless secret rm codexia-auth-token codexia-tunnel-token codexia-postgres-admin-password \
        codexia-postgres-app-password codexia-postgres-preflight-password >/dev/null 2>&1 || true
      for resource in codexia-db codexia-tunnel codexia-api-proxy codexia-slot-blue codexia-slot-green codexia-preflight-blue codexia-preflight-green; do
        rc=0; rootless container exists "$resource" >/dev/null 2>&1 || rc=$?
        [[ "$rc" == 1 ]] || cleanup_status=1
      done
      for resource in codexia codexia-data; do
        rc=0; rootless network exists "$resource" >/dev/null 2>&1 || rc=$?
        [[ "$rc" == 1 ]] || cleanup_status=1
      done
      for resource in codexia-postgres codexia-data codexia-history; do
        rc=0; rootless volume exists "$resource" >/dev/null 2>&1 || rc=$?
        [[ "$rc" == 1 ]] || cleanup_status=1
      done
      for resource in codexia-auth-token codexia-tunnel-token codexia-postgres-admin-password codexia-postgres-app-password codexia-postgres-preflight-password; do
        rc=0; rootless secret exists "$resource" >/dev/null 2>&1 || rc=$?
        [[ "$rc" == 1 ]] || cleanup_status=1
      done
      if [[ "$phase_f_xdg_generator_installed" == true ]]; then
        sudo rm -f -- "$phase_f_xdg_generator_path" || cleanup_status=1
        phase_f_xdg_generator_installed=false
        user_systemctl daemon-reload >/dev/null 2>&1 || cleanup_status=1
      fi
      if [[ "$phase_f_xdg_generator_dir_created" == true ]]; then
        sudo rmdir -- "$phase_f_xdg_generator_dir" 2>/dev/null || cleanup_status=1
        phase_f_xdg_generator_dir_created=false
      fi
      as_service rm -rf -- "$service_home/.config/codexia-updater" "$service_home/.local/state/codexia-updater" || cleanup_status=1
      if sudo test -d /opt/codexia-updater && ! sudo test -L /opt/codexia-updater; then
        if [[ "$(sudo stat -c '%u:%a' /opt/codexia-updater 2>/dev/null)" == "$service_uid:750" ]]; then
          sudo rm -rf -- /opt/codexia-updater || cleanup_status=1
        else
          printf 'Refusing to remove unexpected updater source directory.\n' >&2
          cleanup_status=1
        fi
      elif sudo test -e /opt/codexia-updater || sudo test -L /opt/codexia-updater; then
        printf 'Refusing to remove an unexpected updater source path.\n' >&2
        cleanup_status=1
      fi
      if sudo test -f /etc/codexia/postgres/010-create-app-role.sh && ! sudo test -L /etc/codexia/postgres/010-create-app-role.sh; then
        if sudo cmp -s "$repo_root/deploy/postgres/010-create-app-role.sh" /etc/codexia/postgres/010-create-app-role.sh; then
          sudo rm -- /etc/codexia/postgres/010-create-app-role.sh || cleanup_status=1
        else
          printf 'Refusing to remove a changed PostgreSQL init script.\n' >&2
          cleanup_status=1
        fi
      fi
      sudo rmdir /etc/codexia/postgres /etc/codexia 2>/dev/null || true
      if sudo test -e /etc/codexia || sudo test -L /etc/codexia; then cleanup_status=1; fi
      if [[ "$phase_dir_owned" == true ]] && sudo test -d "$phase_dir" && sudo test ! -L "$phase_dir"; then
        if [[ "$(sudo stat -c '%u' "$phase_dir" 2>/dev/null)" == "$service_uid" ]]; then
          sudo rm -rf -- "$phase_dir" || cleanup_status=1
        else
          printf 'Refusing to remove changed application fixture state.\n' >&2
          cleanup_status=1
        fi
      fi
    fi
  fi
  if [[ "$source_owned" == true && "$source_root" == /tmp/codexia-phase-f-app-source-* && -d "$source_root" && ! -L "$source_root" ]]; then
    sudo rm -rf -- "$source_root" || cleanup_status=1
  fi
  if [[ "$tmp" == /tmp/codexia-phase-f-app.* && -d "$tmp" && ! -L "$tmp" ]]; then rm -rf -- "$tmp" || cleanup_status=1; fi
  if (( status == 0 && cleanup_status != 0 )); then status=$cleanup_status; fi
  printf 'Phase F Ansible application cleanup finished with test status %s and cleanup status %s.\n' "$status" "$cleanup_status" >&2
  exit "$status"
}
trap cleanup EXIT

[[ "$(id -u "$service_user" 2>/dev/null || true)" == "$service_uid" ]] || fail 'Expected Ansible-created disposable service identity is absent.'
[[ "$(getent passwd "$service_user" | cut -d: -f6)" == "$service_home" ]] || fail 'Disposable service home differs from fixture contract.'
service_ansible_version=$(as_service "$ansible_playbook" --version)
[[ "$service_ansible_version" == 'ansible-playbook [core 2.21.6]'* ]] || fail "Fixture service user resolved an unexpected Ansible version: $service_ansible_version"
as_service /usr/bin/test ! -L "$service_home/.local" || fail 'Service local data parent is a symlink; refusing fixture setup.'
as_service /usr/bin/test ! -e "$phase_dir" || fail 'Application fixture state already exists; refusing adoption.'
as_service /usr/bin/test ! -L "$phase_dir" || fail 'Application fixture state is a symlink; refusing adoption.'
[[ ! -e /opt/codexia-updater && ! -L /opt/codexia-updater ]] || fail 'Updater source already exists; refusing adoption.'
[[ ! -e /etc/codexia && ! -L /etc/codexia ]] || fail 'Protected PostgreSQL config already exists; refusing adoption.'
for resource in codexia-db codexia-tunnel codexia-api-proxy codexia-slot-blue codexia-slot-green codexia-preflight-blue codexia-preflight-green; do
  rc=0; rootless container exists "$resource" >/dev/null 2>&1 || rc=$?
  [[ "$rc" == 1 ]] || fail "Application fixture container already exists: $resource"
done
for resource in codexia codexia-data; do
  rc=0; rootless network exists "$resource" >/dev/null 2>&1 || rc=$?
  [[ "$rc" == 1 ]] || fail "Application fixture network already exists: $resource"
done
for resource in codexia-postgres codexia-data codexia-history; do
  rc=0; rootless volume exists "$resource" >/dev/null 2>&1 || rc=$?
  [[ "$rc" == 1 ]] || fail "Application fixture volume already exists: $resource"
done
for resource in codexia-auth-token codexia-tunnel-token codexia-postgres-admin-password codexia-postgres-app-password codexia-postgres-preflight-password; do
  rc=0; rootless secret exists "$resource" >/dev/null 2>&1 || rc=$?
  [[ "$rc" == 1 ]] || fail "Application fixture secret already exists: $resource"
done
quadlet_dir=$service_home/.config/containers/systemd
for file in codexia.network codexia-data.network codexia-postgres.volume codexia-data.volume codexia-history.volume codexia-db.container codexia-tunnel.container codexia-api-proxy.container codexia-slot-blue.container codexia-slot-green.container codexia-preflight-blue.container codexia-preflight-green.container; do
  as_service /usr/bin/test ! -e "$quadlet_dir/$file" || fail "Application fixture Quadlet already exists: $file"
  as_service /usr/bin/test ! -L "$quadlet_dir/$file" || fail "Application fixture Quadlet is a symlink: $file"
done
as_service /usr/bin/test ! -e "$service_home/.config/codexia-updater" || fail 'Updater configuration already exists; refusing adoption.'
as_service /usr/bin/test ! -L "$service_home/.config/codexia-updater" || fail 'Updater configuration is a symlink; refusing adoption.'
as_service /usr/bin/test ! -e "$service_home/.local/state/codexia-updater" || fail 'Updater state already exists; refusing adoption.'
as_service /usr/bin/test ! -L "$service_home/.local/state/codexia-updater" || fail 'Updater state is a symlink; refusing adoption.'
for unit in codexia-updater-boot.service codexia-updater.service codexia-updater.timer; do
  as_service /usr/bin/test ! -e "$service_home/.config/systemd/user/$unit" || fail "Updater unit already exists: $unit"
  as_service /usr/bin/test ! -L "$service_home/.config/systemd/user/$unit" || fail "Updater unit is a symlink: $unit"
done
runtime_owned=true

mkdir -p "$tmp/inputs"
printf '%s\n' 'fixture-auth-token-0123456789abcdef' > "$tmp/inputs/auth-token"
printf '%s\n' 'fixture-tunnel-token-for-disposable-phase-f' > "$tmp/inputs/tunnel-token"
printf '%064d' 1 > "$tmp/inputs/admin-password"
printf '%064d\n' 2 > "$tmp/inputs/app-password"
printf '%064d' 3 > "$tmp/inputs/preflight-password"
printf '%s\n' 'fixture-github-read-token' > "$tmp/inputs/github-read-token"
printf '%s\n' 'fixture-access-client-id' > "$tmp/inputs/access-client-id"
printf '%s\n' 'fixture-access-client-secret' > "$tmp/inputs/access-client-secret"
chmod 0600 "$tmp/inputs/"*

if ! as_service /usr/bin/test -d "$service_home/.local"; then as_service /usr/bin/install -d -m 0700 "$service_home/.local"; fi
if ! as_service /usr/bin/test -d "$service_home/.local/state"; then as_service /usr/bin/install -d -m 0700 "$service_home/.local/state"; fi
as_service /usr/bin/test -d "$service_home/.local/state"
as_service /usr/bin/test ! -L "$service_home/.local/state"
sudo install -d -o "$service_user" -g "$service_group" -m 0700 "$phase_dir" "$phase_dir/channel"
phase_dir_owned=true
[[ ! -e "$source_root" && ! -L "$source_root" ]] || fail 'Temporary Ansible source path already exists.'
sudo install -d -o root -g root -m 0755 "$source_root"
source_owned=true
tar -C "$repo_root" -cf - deploy scripts packages/persistence-postgres/migrations | sudo tar -C "$source_root" -xf -
sudo chmod -R a+rX "$source_root"

printf '%s\n' '=== Generate ephemeral signed channel from certified Core release records as the fixture user ==='
sudo -H -u "$service_user" env HOME="$service_home" XDG_CONFIG_HOME="$service_home/.config" \
  XDG_DATA_HOME="$service_home/.local/share" XDG_STATE_HOME="$service_home/.local/state" \
  XDG_RUNTIME_DIR="/run/user/$service_uid" DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$service_uid/bus" \
  GH_TOKEN="$GH_TOKEN" GITHUB_SHA="$GITHUB_SHA" \
  /usr/bin/node "$source_root/scripts/phase-f-test-channel.mjs" --out "$phase_dir/channel"

for file in test-channel-public.pem channel-sequence-1.json simulated-frontend-identity.json release-0.1.236.json; do
  sudo install -o "$service_user" -g "$service_group" -m 0600 "$phase_dir/channel/$file" "$phase_dir/$file"
done
sudo install -o "$service_user" -g "$service_group" -m 0600 "$tmp/inputs/github-read-token" "$phase_dir/github-read-token"
sudo install -o "$service_user" -g "$service_group" -m 0600 "$tmp/inputs/access-client-id" "$phase_dir/access-client-id"
sudo install -o "$service_user" -g "$service_group" -m 0600 "$tmp/inputs/access-client-secret" "$phase_dir/access-client-secret"

proxy_image=$(as_service /usr/bin/jq -r '.image' "$phase_dir/release-0.1.236.json")
[[ "$proxy_image" =~ ^ghcr\.io/yohn-jp/codexia-backend@sha256:[a-f0-9]{64}$ ]] || fail 'Certified fixture proxy image is not digest pinned.'
cat > "$tmp/inventory.yml" <<YAML
all:
  children:
    codexia:
      hosts:
        localhost:
          ansible_connection: local
          ansible_python_interpreter: /usr/bin/python3
      vars:
        codexia_stage: secrets
        codexia_service_user: $service_user
        codexia_service_group: $service_group
        codexia_service_uid: $service_uid
        codexia_service_gid: $service_uid
        codexia_service_home: "$service_home"
        codexia_secrets_approved: true
        codexia_base_approved: true
        codexia_database_initialization_approved: true
        codexia_frontend_origin: https://codexia-phase-f.fixture.invalid
        codexia_browser_auth:
          mode: token
        codexia_runtime:
          format: codexia-runtime/v1
          profile: core
          modelCachePath: null
          tmpfs:
            tempSize: 64m
            moduleCacheSize: 1g
          resources:
            memoryMaxBytes: null
            cpuQuotaPercent: null
        codexia_proxy_image: "$proxy_image"
        codexia_auth_token_file: "$tmp/inputs/auth-token"
        codexia_tunnel_token_file: "$tmp/inputs/tunnel-token"
        codexia_postgres_admin_password_file: "$tmp/inputs/admin-password"
        codexia_postgres_app_password_file: "$tmp/inputs/app-password"
        codexia_public_key_file: "$phase_dir/test-channel-public.pem"
        codexia_github_token_file: "$phase_dir/github-read-token"
        codexia_access_id_file: "$phase_dir/access-client-id"
        codexia_access_secret_file: "$phase_dir/access-client-secret"
        codexia_maintenance_approved: true
        codexia_installed_release_file: "$phase_dir/release-0.1.236.json"
        codexia_observe_milliseconds: 60000
YAML
sudo install -o "$service_user" -g "$service_group" -m 0600 "$tmp/inventory.yml" "$phase_dir/inventory.yml"
sudo install -o "$service_user" -g "$service_group" -m 0600 "$tmp/inputs/preflight-password" "$phase_dir/preflight-password"
/usr/bin/node --input-type=module - "$tmp/stage-vars.json" "$tmp/inputs/preflight-password" "$phase_dir" "$service_uid" "$source_root" <<'NODE'
import { readFile, writeFile } from 'node:fs/promises';
const [output, passwordFile, directory, uid, source] = process.argv.slice(2);
const password = (await readFile(passwordFile, 'utf8')).trim();
if (!/^[a-f0-9]{64}$/u.test(password)) throw new Error('Disposable preflight credential has invalid format');
const vars = {
  codexia_preflight_password: password,
  updater_env: {
    XDG_RUNTIME_DIR: '/run/user/' + uid,
    XDG_STATE_HOME: '/home/codexia-ci-host/.local/state',
    NODE_OPTIONS: '--import=' + source + '/scripts/phase-f-fetch-loader.mjs',
    CODEXIA_PHASE_F_CHANNEL_FILE: directory + '/channel-sequence-1.json',
    CODEXIA_PHASE_F_FRONTEND_URL: 'https://codexia-phase-f.fixture.invalid/desktop/update-identity.json',
    CODEXIA_PHASE_F_FRONTEND_IDENTITY_FILE: directory + '/simulated-frontend-identity.json',
  },
};
await writeFile(output, JSON.stringify(vars) + '\n', { mode: 0o600, flag: 'wx' });
NODE
sudo install -o "$service_user" -g "$service_group" -m 0600 "$tmp/stage-vars.json" "$phase_dir/stage-vars.json"

apply_runner() {
  local stage=$1 log=$2 status=0
  ANSIBLE_LOCAL_TEMP="$tmp/ansible-local" "$ansible_playbook" -i "$tmp/inventory.yml" \
    "$source_root/deploy/ansible/site.yml" -e "codexia_stage=$stage" > "$log" 2>&1 || status=$?
  if (( status != 0 )); then cat "$log" >&2; return "$status"; fi
}
apply_service() {
  local stage=$1 log=$2 status=0
  as_service env ANSIBLE_LOCAL_TEMP="$phase_dir/ansible-local" "$ansible_playbook" \
    -i "$phase_dir/inventory.yml" "$source_root/deploy/ansible/site.yml" \
    -e "codexia_stage=$stage" -e "@$phase_dir/stage-vars.json" > "$log" 2>&1 || status=$?
  if (( status != 0 )); then cat "$log" >&2; return "$status"; fi
}
install_fixture_manager_xdg() {
  # systemd reruns user environment generators during daemon-reload. Keep the
  # correction scoped to this disposable service UID and remove it at cleanup.
  if [[ ! -d "$phase_f_xdg_generator_dir" ]]; then
    sudo install -d -m 0755 "$phase_f_xdg_generator_dir"
    phase_f_xdg_generator_dir_created=true
  fi
  [[ ! -e "$phase_f_xdg_generator_path" && ! -L "$phase_f_xdg_generator_path" ]] ||
    fail "Refusing to replace an existing user environment generator: $phase_f_xdg_generator_path"
  sudo install -m 0755 /dev/null "$phase_f_xdg_generator_path"
  phase_f_xdg_generator_installed=true
  sudo tee "$phase_f_xdg_generator_path" >/dev/null <<EOF
#!/bin/sh
if [ "\$(id -u)" = "$service_uid" ]; then
  printf '%s\\n' 'XDG_CONFIG_HOME=$service_home/.config' 'XDG_RUNTIME_DIR=/run/user/$service_uid'
fi
EOF
  user_systemctl daemon-reload
  local manager_environment
  manager_environment=$(user_systemctl show-environment)
  grep -Fxq "XDG_CONFIG_HOME=$service_home/.config" <<<"$manager_environment" || fail 'Fixture user manager has the wrong XDG_CONFIG_HOME after generator reload.'
  grep -Fxq "XDG_RUNTIME_DIR=/run/user/$service_uid" <<<"$manager_environment" || fail 'Fixture user manager has the wrong XDG_RUNTIME_DIR after generator reload.'
  printf '%s\\n' 'Phase F fixture manager XDG environment verified after systemd environment generation.'
}
require_no_change() {
  local log=$1
  grep -Eq 'changed=0' "$log" || { printf 'Expected no-change Ansible repeat: %s\n' "$log" >&2; cat "$log" >&2; return 1; }
}
require_task_ok() {
  local log=$1 task=$2
  grep -A1 -F "$task" "$log" | grep -Eq '^ok: \[localhost\]' || {
    printf 'Expected unchanged Ansible task result for %s\n' "$task" >&2
    cat "$log" >&2
    return 1
  }
}
database_snapshot() {
  local container volume cluster
  container=$(rootless inspect --format '{{.Id}}' codexia-db)
  volume=$(rootless volume inspect --format '{{.Name}}|{{.Mountpoint}}|{{.CreatedAt}}' codexia-postgres)
  cluster=$(rootless exec codexia-db sh -ec 'export PGPASSWORD="$(cat /run/secrets/admin-password)"; exec psql -X -qAt -U codexia_admin -d postgres -c "SELECT system_identifier FROM pg_control_system()"')
  [[ "$container" =~ ^[a-f0-9]{64}$ && "$volume" == codexia-postgres\|/*\|* && "$cluster" =~ ^[0-9]+$ ]] || fail 'PostgreSQL runtime identity is incomplete.'
  printf '%s\n%s\n%s\n' "$container" "$volume" "$cluster"
}
assert_database_snapshot() {
  [[ "$(database_snapshot)" == "$database_identity" ]] || fail 'A repeated Ansible stage replaced the PostgreSQL container, persistent volume, or cluster.'
}
migration_ledger() {
  rootless exec codexia-db sh -ec 'export PGPASSWORD="$(cat /run/secrets/admin-password)"; exec psql -X -qAt -U codexia_admin -d codexia -c "SELECT version || chr(58) || checksum FROM public.codexia_schema_migrations ORDER BY version"'
}
project_probe() {
  local id=''
  if (( $# > 0 )); then id=$1; fi
  if [[ -z "$id" ]]; then
    rootless exec -i codexia-slot-blue node --input-type=module <<'NODE'
import { readFileSync } from 'node:fs';
const origin = 'http://127.0.0.1:3000';
const token = readFileSync('/run/secrets/codexia-auth-token', 'utf8').trim();
const login = await fetch(origin + '/api/login', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) });
if (!login.ok) throw new Error('Disposable app login failed');
const cookie = login.headers.get('set-cookie')?.split(';', 1)[0];
if (!cookie) throw new Error('Disposable app session cookie unavailable');
const response = await fetch(origin + '/api/v1/persistence/projects', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ title: 'Phase F Ansible application continuity' }) });
if (response.status !== 201) throw new Error('Disposable project creation failed: ' + response.status);
const created = await response.json();
const project = created.project;
if (typeof project.id !== 'string' || !project.id) throw new Error('Disposable project identity unavailable');
process.stdout.write(project.id);
NODE
  else
    rootless exec -i codexia-slot-blue node --input-type=module - "$id" <<'NODE'
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const origin = 'http://127.0.0.1:3000';
const token = readFileSync('/run/secrets/codexia-auth-token', 'utf8').trim();
const login = await fetch(origin + '/api/login', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) });
assert.equal(login.ok, true);
const cookie = login.headers.get('set-cookie')?.split(';', 1)[0];
assert.ok(cookie);
const response = await fetch(origin + '/api/v1/persistence/projects', { headers: { Origin: origin, Cookie: cookie } });
assert.equal(response.ok, true);
const projects = await response.json();
assert.ok(Array.isArray(projects));
assert.ok(projects.some(project => project.id === process.argv[2] && project.title === 'Phase F Ansible application continuity'));
NODE
  fi
}

printf '%s\n' '=== Ansible secrets and base stages: clean resource set on the same host identity ==='
apply_runner secrets "$tmp/secrets-first.log"
grep -Eq 'changed=[1-9]' "$tmp/secrets-first.log"
apply_runner secrets "$tmp/secrets-repeat.log"
require_no_change "$tmp/secrets-repeat.log"
install_fixture_manager_xdg
apply_runner base "$tmp/base-first.log"
grep -Eq 'changed=[1-9]' "$tmp/base-first.log"
rootless exec codexia-db pg_isready -U codexia -d codexia >/dev/null
database_identity=$(database_snapshot)
apply_runner base "$tmp/base-repeat.log"
require_no_change "$tmp/base-repeat.log"
assert_database_snapshot
printf 'PostgreSQL identity after base: %s\n' "$(printf '%s' "$database_identity" | sed -n '1p')"

printf '%s\n' '=== Ansible prepare and repeat on the same PostgreSQL database ==='
apply_service prepare "$tmp/prepare-first.log"
assert_database_snapshot
apply_service prepare "$tmp/prepare-repeat.log"
require_no_change "$tmp/prepare-repeat.log"
assert_database_snapshot
printf '%s\n' 'PASS: prepare repeat reported changed=0 and retained PostgreSQL identity.'

printf '%s\n' '=== Real fresh schema initialization and repeat ==='
apply_service initialize-schema "$tmp/schema-first.log"
assert_database_snapshot
ledger_after_schema=$(migration_ledger)
[[ -n "$ledger_after_schema" ]] || fail 'Fresh schema initialization did not create the migration ledger.'
apply_service initialize-schema "$tmp/schema-repeat.log"
require_task_ok "$tmp/schema-repeat.log" 'Run fresh-only migration in the verified image without starting the API'
[[ "$(migration_ledger)" == "$ledger_after_schema" ]] || fail 'Repeated schema initialization changed the migration ledger.'
assert_database_snapshot
printf '%s\n' 'PASS: repeated initialize-schema applied no migration and retained the database and cluster identities.'

printf '%s\n' '=== Real fresh activation and repeat on the same schema and volumes ==='
apply_service initialize-fresh "$tmp/fresh-first.log"
assert_database_snapshot
[[ "$(rootless inspect --format '{{.State.Running}}' codexia-slot-blue)" == true ]] || fail 'Initial private Core writer is not running.'
[[ "$(rootless inspect --format '{{.State.Running}}' codexia-api-proxy)" == true ]] || fail 'Initial private proxy is not running.'
[[ "$(as_service cat "$service_home/.local/state/codexia-updater/route")" == blue ]] || fail 'Fresh private activation did not route to the initial slot.'
project_id=$(project_probe)
[[ -n "$project_id" ]] || fail 'API-created project identity is empty.'
writer_id=$(rootless inspect --format '{{.Id}}' codexia-slot-blue)
proxy_id=$(rootless inspect --format '{{.Id}}' codexia-api-proxy)
data_identity=$(rootless volume inspect --format '{{.Name}}|{{.Mountpoint}}|{{.CreatedAt}}' codexia-data)
history_identity=$(rootless volume inspect --format '{{.Name}}|{{.Mountpoint}}|{{.CreatedAt}}' codexia-history)
apply_service initialize-fresh "$tmp/fresh-repeat.log"
require_task_ok "$tmp/fresh-repeat.log" 'Activate or recover exactly the fresh schema release'
assert_database_snapshot
[[ "$(rootless inspect --format '{{.Id}}' codexia-slot-blue)" == "$writer_id" ]] || fail 'Repeated fresh activation replaced its writer.'
[[ "$(rootless inspect --format '{{.Id}}' codexia-api-proxy)" == "$proxy_id" ]] || fail 'Repeated fresh activation replaced its private proxy.'
[[ "$(rootless volume inspect --format '{{.Name}}|{{.Mountpoint}}|{{.CreatedAt}}' codexia-data)" == "$data_identity" ]] || fail 'Repeated fresh activation replaced app data storage.'
[[ "$(rootless volume inspect --format '{{.Name}}|{{.Mountpoint}}|{{.CreatedAt}}' codexia-history)" == "$history_identity" ]] || fail 'Repeated fresh activation replaced history storage.'
project_probe "$project_id"
[[ "$(as_service cat "$service_home/.local/state/codexia-updater/route")" == blue ]] || fail 'Repeated fresh activation changed the private route.'
printf '%s\n' 'PASS: real Ansible base→prepare→schema→fresh activation repeat convergence kept one PostgreSQL identity and project data.'

/usr/bin/node --input-type=module - "$evidence_dir/app-convergence-results.json" "$GITHUB_SHA" "$GITHUB_RUN_ID" "$GITHUB_RUN_ATTEMPT" "$RUNNER_NAME" "$service_uid" "$database_identity" "$ledger_after_schema" "$writer_id" "$proxy_id" "$data_identity" "$history_identity" "$project_id" "$proxy_image" <<'NODE'
import { writeFile } from 'node:fs/promises';
const [file, sourceSha, workflowRunId, runAttempt, runnerName, serviceUid, databaseIdentity, migrationLedger, writerId, proxyId, dataIdentity, historyIdentity, projectId, image] = process.argv.slice(2);
if (!/^[a-f0-9]{40}$/.test(sourceSha) || !/^\d+$/.test(workflowRunId) || !/^\d+$/.test(runAttempt) || !runnerName) {
  throw new Error('Refusing unbound Phase F Ansible application evidence');
}
const [databaseContainerId, postgresVolumeIdentity, clusterSystemIdentifier] = databaseIdentity.split('\n');
if (!/^[a-f0-9]{64}$/.test(databaseContainerId) || !/^codexia-postgres\|\//.test(postgresVolumeIdentity) || !/^\d+$/.test(clusterSystemIdentifier)) {
  throw new Error('PostgreSQL identity evidence is incomplete');
}
const result = {
  format: 'codexia-phase-f-ansible-app-convergence/v1',
  sourceSha, workflowRunId, runAttempt, runnerName,
  fixture: { serviceUser: 'codexia-ci-host', serviceUid: Number(serviceUid), lifecycle: 'A clean application resource set was created after prior host/base assertions cleaned their runtime; this is fresh initialization, not adoption of a running app.' },
  stages: {
    secrets: 'PASS: real Ansible first apply and no-change repeat with synthetic credentials.',
    base: 'PASS: real Ansible first apply and no-change repeat; same rootless PostgreSQL container, cluster system identifier and named volume persisted into all application stages.',
    prepare: 'PASS: real Ansible prepare and no-change repeat on the same database.',
    initializeSchema: 'PASS: exact signed Core release initialized a fresh schema; the repeated migration task reported unchanged, migration ledger was identical, and database identity was stable.',
    initializeFresh: 'PASS: exact signed release privately activated with polling/public handoff disabled; repeat activation task reported unchanged and writer, proxy, data/history volumes, route and API-created project ID/content persisted.',
  },
  identities: { databaseContainerId, postgresVolumeIdentity, clusterSystemIdentifier, migrationLedger, writerId, proxyId, dataIdentity, historyIdentity, projectId, image },
  notChecked: [
    'Adoption of an already-serving complete application deployment',
    'Ansible enable, automatic polling, D cutover, Terraform or Cloudflare handoff',
    'Target-VM reboot, external Access/public author acceptance, remote restore host and measured RPO/RTO',
  ],
};
await writeFile(file, JSON.stringify(result, null, 2) + '\n', { mode: 0o644, flag: 'wx' });
NODE
