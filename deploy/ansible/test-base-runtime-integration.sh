#!/usr/bin/env bash
# Run only after test-base-secrets-integration.sh on a disposable Ubuntu runner.
set -Eeuo pipefail
runtime_test_error() {
  local status=$?
  printf 'Base runtime integration failed at line %s (status %s): %s\n' "${BASH_LINENO[0]:-$LINENO}" "$status" "$BASH_COMMAND" >&2
  return 0
}
trap runtime_test_error ERR
printf '%s\n' 'Starting Base runtime integration test.'
test "${GITHUB_ACTIONS:-}" = true
test "${CODEXIA_DISPOSABLE_HOST:-}" = base-integration
test "$(lsb_release -rs)" = 26.04
service_user=${CODEXIA_SERVICE_USER:?missing rootless fixture identity}
service_uid=$(id -u "$service_user")
service_home=$(getent passwd "$service_user" | cut -d: -f6)
test "$(id -un)" != "$service_user"
sudo -n true
printf '%s\n' 'Base runtime preflight checks passed.'
as_service() {
  sudo -u "$service_user" env HOME="$service_home" XDG_CONFIG_HOME="$service_home/.config" XDG_DATA_HOME="$service_home/.local/share" XDG_STATE_HOME="$service_home/.local/state" XDG_RUNTIME_DIR="/run/user/$service_uid" DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$service_uid/bus" bash -c 'cd "$HOME" && exec "$@"' bash "$@"
}
podman() { as_service /usr/bin/podman "$@"; }
systemctl() {
  if [[ "${1:-}" == --user ]]; then as_service /usr/bin/systemctl "$@"; else command systemctl "$@"; fi
}
rootless_info=''
if rootless_info=$(podman info --format '{{.Host.Security.Rootless}}' 2>&1); then
  :
else
  status=$?
  printf 'Rootless Podman info failed with status %s: %s\n' "$status" "$rootless_info" >&2
  exit "$status"
fi
test "$rootless_info" = true
printf '%s\n' 'Base rootless Podman info verified.'
test "$(id -u)" != 0

export XDG_RUNTIME_DIR="/run/user/$service_uid"
export DBUS_SESSION_BUS_ADDRESS="unix:path=$XDG_RUNTIME_DIR/bus"
systemctl --user show --property=Version >/dev/null
printf '%s\n' 'Base rootless systemd manager verified.'

quadlet_dir="$service_home/.config/containers/systemd"
for container in codexia-db codexia-tunnel codexia-api; do
  rc=0; podman container exists "$container" || rc=$?
  test "$rc" = 1
done
for network in codexia codexia-data; do
  rc=0; podman network exists "$network" || rc=$?
  test "$rc" = 1
done
for volume in codexia-data codexia-history; do
  rc=0; podman volume exists "$volume" || rc=$?
  test "$rc" = 1
done
podman volume exists codexia-postgres
for secret in codexia-postgres-admin-password codexia-postgres-app-password; do
  podman secret exists "$secret"
done
rc=0; podman secret exists codexia-tunnel-token || rc=$?
test "$rc" = 1
test ! -e /etc/codexia
for file in codexia.network codexia-data.network codexia-postgres.volume codexia-data.volume codexia-history.volume codexia-db.container; do
  as_service test ! -e "$quadlet_dir/$file"
done
printf '%s\n' 'Base initial runtime resource checks passed.'

tmp=$(mktemp -d /tmp/codexia-base-runtime.XXXXXX)
repo_root=$(pwd)
source "$repo_root/deploy/ansible/test-publication-gate-fixture.sh"
generator_probe_dir=/run/systemd/user-generators
generator_probe_path="$generator_probe_dir/podman-user-generator"
generator_probe_log="/run/codexia-base-generator-environment-$service_uid-$$.log"
generator_probe_installed=false
generator_probe_dir_created=false
user_environment_generator_dir=/run/systemd/user-environment-generators
user_environment_generator_path="$user_environment_generator_dir/99-codexia-base-xdg-$service_uid-$$"
user_environment_generator_installed=false
user_environment_generator_dir_created=false
db_verifier_bin=
cleanup() {
  local status=$?
  local cleanup_status=0
  trap - EXIT
  set +e
  cleanup_fixture_management || cleanup_status=1
  systemctl --user stop codexia-db.service >/dev/null 2>&1 || true
  podman rm -f codexia-db >/dev/null 2>&1 || true
  as_service rm -f \
    "$quadlet_dir/codexia.network" \
    "$quadlet_dir/codexia-data.network" \
    "$quadlet_dir/codexia-postgres.volume" \
    "$quadlet_dir/codexia-data.volume" \
    "$quadlet_dir/codexia-history.volume" \
    "$quadlet_dir/codexia-db.container" || cleanup_status=1
  if [[ "$generator_probe_installed" == true ]]; then
    sudo rm -f -- "$generator_probe_path" || cleanup_status=1
    generator_probe_installed=false
  fi
  if [[ "$user_environment_generator_installed" == true ]]; then
    sudo rm -f -- "$user_environment_generator_path" || cleanup_status=1
    user_environment_generator_installed=false
  fi
  sudo rm -f -- "$generator_probe_log" || true
  if [[ "$generator_probe_dir_created" == true ]]; then
    sudo rmdir -- "$generator_probe_dir" 2>/dev/null || cleanup_status=1
    generator_probe_dir_created=false
  fi
  if [[ "$user_environment_generator_dir_created" == true ]]; then
    sudo rmdir -- "$user_environment_generator_dir" 2>/dev/null || cleanup_status=1
    user_environment_generator_dir_created=false
  fi
  if [[ -n "$db_verifier_bin" ]]; then
    as_service rm -f -- "$db_verifier_bin/podman" || cleanup_status=1
    as_service rmdir -- "$db_verifier_bin" || cleanup_status=1
  fi
  systemctl --user daemon-reload >/dev/null 2>&1 || true
  systemctl --user reset-failed codexia-db.service >/dev/null 2>&1 || true
  podman network rm codexia-data codexia >/dev/null 2>&1 || true
  podman volume rm codexia-postgres codexia-data codexia-history >/dev/null 2>&1 || true
  podman secret rm \
    codexia-postgres-admin-password \
    codexia-postgres-app-password >/dev/null 2>&1 || true
  sudo rm -f /etc/codexia/postgres/010-create-app-role.sh || cleanup_status=1
  sudo rmdir /etc/codexia/postgres /etc/codexia 2>/dev/null || true
  if [[ "$tmp" == /tmp/codexia-base-runtime.* && -d "$tmp" && ! -L "$tmp" ]]; then sudo rm -rf -- "$tmp" || cleanup_status=1; fi
  if (( status == 0 && cleanup_status != 0 )); then status=$cleanup_status; fi
  printf 'Base runtime integration cleanup finished with test status %s and cleanup status %s.\n' "$status" "$cleanup_status" >&2
  exit "$status"
}
trap cleanup EXIT
umask 077

# systemd reruns user environment generators during daemon-reload. Scope this
# late-running fixture override to the disposable service UID so the real
# packaged Quadlet generator receives that user's XDG paths even when the CI
# runner's environment has been imported into another user manager.
if [[ ! -d "$user_environment_generator_dir" ]]; then
  sudo install -d -m 0755 "$user_environment_generator_dir"
  user_environment_generator_dir_created=true
fi
if [[ -e "$user_environment_generator_path" || -L "$user_environment_generator_path" ]]; then
  printf 'Refusing to replace an existing user environment generator: %s\n' "$user_environment_generator_path" >&2
  exit 1
fi
sudo install -m 0755 /dev/null "$user_environment_generator_path"
user_environment_generator_installed=true
sudo tee "$user_environment_generator_path" >/dev/null <<EOF
#!/bin/sh
if [ "\$(id -u)" = "$service_uid" ]; then
  printf '%s\\n' 'XDG_CONFIG_HOME=$service_home/.config' 'XDG_RUNTIME_DIR=/run/user/$service_uid'
fi
EOF
as_service systemctl --user daemon-reload
systemctl --user show-environment | grep -Fxq "XDG_CONFIG_HOME=$service_home/.config"
systemctl --user show-environment | grep -Fxq "XDG_RUNTIME_DIR=/run/user/$service_uid"
printf '%s\n' 'Base fixture manager XDG environment verified after systemd environment generation.'

cat > "$tmp/base-inventory.yml" <<YAML
all:
  children:
    codexia:
      hosts:
        localhost:
          ansible_connection: local
          ansible_python_interpreter: /usr/bin/python3
      vars:
        codexia_stage: base
        codexia_base_approved: true
        codexia_database_initialization_approved: true
        codexia_service_user: $service_user
        codexia_service_uid: $service_uid
        codexia_service_home: "$service_home"
YAML
apply_base() {
  ANSIBLE_LOCAL_TEMP="$tmp/ansible-local" "${ANSIBLE_PLAYBOOK:-ansible-playbook}" -i "$tmp/base-inventory.yml" deploy/ansible/site.yml "$@"
}
diagnose_missing_database_unit() {
  local generator=/usr/lib/systemd/user-generators/podman-user-generator
  local generator_output="$service_home/.local/state/codexia-base-generator-diagnostic-$$"
  local reload_started reload_status
  printf '%s\n' 'Database unit generation diagnostics:' >&2
  printf '%s\n' '--- systemd user manager environment ---' >&2
  systemctl --user show-environment | grep -E '^(HOME|XDG_CONFIG_HOME|XDG_DATA_HOME|XDG_RUNTIME_DIR|DBUS_SESSION_BUS_ADDRESS)=' >&2 || true
  local manager_pid
  manager_pid=$(sudo systemctl show --property=MainPID --value "user@${service_uid}.service" 2>/dev/null || true)
  if [[ "$manager_pid" =~ ^[1-9][0-9]*$ ]]; then
    printf '%s\n' "--- systemd user manager process environment (PID $manager_pid) ---" >&2
    sudo cat "/proc/$manager_pid/environ" | tr '\0' '\n' | grep -E '^(HOME|XDG_CONFIG_HOME|XDG_DATA_HOME|XDG_RUNTIME_DIR|DBUS_SESSION_BUS_ADDRESS)=' >&2 || true
  else
    printf 'Could not read the user manager MainPID (value: %s)\n' "$manager_pid" >&2
  fi
  printf '%s\n' '--- systemd user manager paths and database unit ---' >&2
  systemctl --user show --property=UnitPath >&2 || true
  systemctl --user show --property=LoadState --property=FragmentPath --property=SourcePath codexia-db.service >&2 || true
  systemctl --user list-unit-files --no-pager >&2 || true
  systemctl --user cat codexia-db.service >&2 || true
  printf '%s\n' '--- installed Quadlet sources and generated unit directories ---' >&2
  for path in \
    "$quadlet_dir" \
    "$service_home/.config/systemd/user" \
    "/run/user/$service_uid/systemd/generator.early" \
    "/run/user/$service_uid/systemd/generator" \
    "/run/user/$service_uid/systemd/generator.late"; do
    if [[ -e "$path" ]]; then
      as_service find "$path" -maxdepth 3 -printf '%M %u:%g %p\n' >&2 || true
    else
      printf 'Missing path: %s\n' "$path" >&2
    fi
  done
  printf '%s\n' '--- user journal for Quadlet generation ---' >&2
  as_service journalctl --user -b -n 100 --no-pager -o short-iso --grep='(?i)(podman|quadlet|codexia|generator|failed|error|warn)' >&2 || true
  printf '%s\n' '--- system journal for the disposable user manager ---' >&2
  sudo journalctl -b -n 100 --no-pager -o short-iso --grep='(?i)(podman|quadlet|codexia|generator|failed|error|warn)' "_UID=$service_uid" >&2 || true
  printf '%s\n' '--- install a temporary highest-priority user-generator environment probe ---' >&2
  if [[ -e "$generator_probe_path" || -L "$generator_probe_path" ]]; then
    printf 'Refusing to replace an existing generator override: %s\n' "$generator_probe_path" >&2
  else
    if [[ ! -d "$generator_probe_dir" ]]; then
      sudo install -d -m 0755 "$generator_probe_dir" || true
      generator_probe_dir_created=true
    fi
    if sudo install -m 0666 /dev/null "$generator_probe_log"; then
      generator_probe_installed=true
      sudo tee "$generator_probe_path" >/dev/null <<EOF
#!/bin/sh
{
  printf 'EFFECTIVE_UID=%s\n' "\$(id -u)"
  printf 'PPID=%s\n' "\$PPID"
  printf 'GENERATOR_CGROUP='; cat /proc/self/cgroup 2>/dev/null | tr '\n' ';'; printf '\n'
  if [ -r "/proc/\$PPID/status" ]; then
    printf 'PARENT_STATUS='; grep -E '^(Name|Pid|PPid|Uid|Gid):' "/proc/\$PPID/status" | tr '\n' ';'; printf '\n'
    printf 'PARENT_CGROUP='; cat "/proc/\$PPID/cgroup" 2>/dev/null | tr '\n' ';'; printf '\n'
    printf 'PARENT_CMDLINE='; tr '\0' ' ' <"/proc/\$PPID/cmdline" 2>/dev/null; printf '\n'
    printf 'PARENT_ENV='; tr '\0' '\n' <"/proc/\$PPID/environ" 2>/dev/null | grep -E '^(HOME|XDG_CONFIG_HOME|XDG_DATA_HOME|XDG_STATE_HOME|XDG_RUNTIME_DIR|DBUS_SESSION_BUS_ADDRESS)=' | tr '\n' ';'; printf '\n'
  else
    printf 'PARENT_PROC_UNAVAILABLE=1\n'
  fi
  printf 'HOME=%s\n' "\${HOME-<unset>}"
  printf 'XDG_CONFIG_HOME=%s\n' "\${XDG_CONFIG_HOME-<unset>}"
  printf 'XDG_DATA_HOME=%s\n' "\${XDG_DATA_HOME-<unset>}"
  printf 'XDG_STATE_HOME=%s\n' "\${XDG_STATE_HOME-<unset>}"
  printf 'XDG_RUNTIME_DIR=%s\n' "\${XDG_RUNTIME_DIR-<unset>}"
  case "\${DBUS_SESSION_BUS_ADDRESS-}" in
    unix:path=/run/user/[0-9]*/bus) printf 'DBUS_SESSION_BUS_ADDRESS=%s\n' "\${DBUS_SESSION_BUS_ADDRESS}" ;;
    *) printf 'DBUS_SESSION_BUS_ADDRESS=<unset-or-nonstandard>\n' ;;
  esac
} >> "$generator_probe_log"
exec "$generator" "\$@"
EOF
      sudo chmod 0755 "$generator_probe_path"
      printf 'Installed disposable probe at %s; cleanup trap will remove it.\n' "$generator_probe_path" >&2
    else
      printf 'Could not create generator probe log: %s\n' "$generator_probe_log" >&2
    fi
  fi
  reload_started=$(date --iso-8601=seconds)
  printf '%s\n' "--- explicit user-manager daemon-reload at $reload_started ---" >&2
  if as_service systemctl --user daemon-reload >"$tmp/diagnostic-daemon-reload.log" 2>&1; then
    cat "$tmp/diagnostic-daemon-reload.log" >&2
  else
    reload_status=$?
    printf 'Explicit user-manager daemon-reload exited with status %s\n' "$reload_status" >&2
    cat "$tmp/diagnostic-daemon-reload.log" >&2
  fi
  printf '%s\n' '--- database unit and generated directories after explicit reload ---' >&2
  systemctl --user show --property=LoadState --property=FragmentPath --property=SourcePath codexia-db.service >&2 || true
  for path in \
    "/run/user/$service_uid/systemd/generator.early" \
    "/run/user/$service_uid/systemd/generator" \
    "/run/user/$service_uid/systemd/generator.late"; do
    if [[ -e "$path" ]]; then
      as_service find "$path" -maxdepth 3 -printf '%M %u:%g %p\n' >&2 || true
    else
      printf 'Missing path after reload: %s\n' "$path" >&2
    fi
  done
  printf '%s\n' '--- timestamped journal entries after explicit reload ---' >&2
  as_service journalctl --user -b --since="$reload_started" --no-pager -o short-iso --grep='(?i)(podman|quadlet|codexia|generator|failed|error|warn)' >&2 || true
  if [[ "$generator_probe_installed" == true ]]; then
    printf '%s\n' '--- environment observed by the systemd-launched packaged-generator wrapper ---' >&2
    if [[ -s "$generator_probe_log" ]]; then
      cat "$generator_probe_log" >&2
      local runner_uid probe_manager_uid manager_pid wrapper_ppid
      runner_uid=$(id -u)
      printf '%s\n' '--- runner and fixture user-manager process correlation ---' >&2
      for probe_manager_uid in "$runner_uid" "$service_uid"; do
        printf '%s\n' "user@${probe_manager_uid}.service:" >&2
        sudo systemctl show --property=Id --property=MainPID --property=ControlGroup "user@${probe_manager_uid}.service" >&2 || true
        manager_pid=$(sudo systemctl show --property=MainPID --value "user@${probe_manager_uid}.service" 2>/dev/null || true)
        if [[ "$manager_pid" =~ ^[1-9][0-9]*$ ]]; then
          printf '%s\n' "manager process environment (PID $manager_pid):" >&2
          sudo cat "/proc/$manager_pid/environ" | tr '\0' '\n' | grep -E '^(HOME|XDG_CONFIG_HOME|XDG_DATA_HOME|XDG_STATE_HOME|XDG_RUNTIME_DIR)=' >&2 || true
          printf '%s\n' "manager process cgroup (PID $manager_pid):" >&2
          sudo cat "/proc/$manager_pid/cgroup" >&2 || true
        fi
      done
      while IFS= read -r wrapper_ppid; do
        if [[ "$wrapper_ppid" =~ ^[1-9][0-9]*$ ]]; then
          printf '%s\n' "generator parent process (PID $wrapper_ppid):" >&2
          sudo ps -o pid=,ppid=,euid=,comm= -p "$wrapper_ppid" >&2 || true
          sudo cat "/proc/$wrapper_ppid/cgroup" >&2 || true
        fi
      done < <(awk -F= '$1 == "PPID" { print $2 }' "$generator_probe_log" | sort -u)
    else
      printf 'The systemd reload did not execute the override at %s.\n' "$generator_probe_path" >&2
    fi
  fi
  if [[ -x "$generator" ]]; then
    as_service mkdir -p "$generator_output/early" "$generator_output/normal" "$generator_output/late"
    printf '%s\n' '--- isolated debug invocation of podman-user-generator ---' >&2
    if as_service env SYSTEMD_LOG_LEVEL=debug "$generator" \
      "$generator_output/early" "$generator_output/normal" "$generator_output/late" \
      >"$tmp/quadlet-generator.log" 2>&1; then
      cat "$tmp/quadlet-generator.log" >&2
    else
      local generator_status=$?
      printf 'podman-user-generator exited with status %s\n' "$generator_status" >&2
      cat "$tmp/quadlet-generator.log" >&2
    fi
    as_service find "$generator_output" -maxdepth 3 -printf '%M %u:%g %p\n' >&2 || true
    as_service rm -rf -- "$generator_output" || true
  else
    printf 'User generator is absent or not executable: %s\n' "$generator" >&2
  fi
}
# Existing Quadlet drift must be detected before other files, directories, or runtime resources are created.
as_service mkdir -p "$quadlet_dir"
cat deploy/quadlet/codexia-data.network | as_service tee "$quadlet_dir/codexia-data.network" >/dev/null
as_service sh -c 'printf "# fixture drift\\n" >> "$1"' _ "$quadlet_dir/codexia-data.network"
quadlet_drift_status=0
apply_base > "$tmp/quadlet-drift.log" 2>&1 || quadlet_drift_status=$?
if (( quadlet_drift_status == 0 )); then
  echo 'Base convergence accepted an existing noncanonical Quadlet' >&2
  exit 1
fi
if ! grep -Fq 'Existing Codexia Quadlet differs from the reviewed source' "$tmp/quadlet-drift.log"; then
  printf 'Quadlet drift was rejected with unexpected output (Ansible status %s); captured output follows:\n' "$quadlet_drift_status" >&2
  cat "$tmp/quadlet-drift.log" >&2
  exit 1
fi
test "$(as_service find "$quadlet_dir" -mindepth 1 -maxdepth 1 -type f | wc -l)" -eq 1
test ! -e /etc/codexia
for network in codexia codexia-data; do
  rc=0; podman network exists "$network" || rc=$?
  test "$rc" = 1
done
for volume in codexia-data codexia-history; do
  rc=0; podman volume exists "$volume" || rc=$?
  test "$rc" = 1
done
rc=0; podman container exists codexia-db || rc=$?
test "$rc" = 1
as_service rm "$quadlet_dir/codexia-data.network"

# A fresh or empty PostgreSQL volume requires its own explicit approval.
sed -i 's/codexia_database_initialization_approved: true/codexia_database_initialization_approved: false/' "$tmp/base-inventory.yml"
if apply_base > "$tmp/database-init-denied.log" 2>&1; then
  echo 'Fresh PostgreSQL initialization did not require explicit approval' >&2
  exit 1
fi
grep -q 'Explicit approval is required before initializing an empty PostgreSQL volume' "$tmp/database-init-denied.log"
test ! -e /etc/codexia
for network in codexia codexia-data; do
  rc=0; podman network exists "$network" || rc=$?
  test "$rc" = 1
done
sed -i 's/codexia_database_initialization_approved: false/codexia_database_initialization_approved: true/' "$tmp/base-inventory.yml"

if apply_base > "$tmp/management-missing.log" 2>&1; then
  echo 'Base convergence accepted a host without its canonical management connector' >&2
  exit 1
fi
grep -Fq 'management Tunnel unit is missing or differs' "$tmp/management-missing.log"
start_fixture_management "$repo_root" "$tmp"

if ! apply_base > "$tmp/first.log" 2>&1; then
  cat "$tmp/first.log" >&2
  diagnose_missing_database_unit
  exit 1
fi
grep -Eq 'changed=[1-9]' "$tmp/first.log"
apply_base > "$tmp/second.log" || { cat "$tmp/second.log"; exit 1; }
grep -q 'changed=0' "$tmp/second.log"
verify_fixture_publication_gate "$service_user"
# A process interrupted after masking only the listener can recover on rerun.
sudo systemctl unmask codexia-api-gate.service
if as_service sudo -n /usr/local/sbin/codexia-api-gate status >/dev/null 2>&1; then
  echo 'A partially masked gate reported a canonical state' >&2
  exit 1
fi
apply_base > "$tmp/partial-gate-recovery.log" || { cat "$tmp/partial-gate-recovery.log"; exit 1; }
test "$(as_service sudo -n /usr/local/sbin/codexia-api-gate status)" = closed
assert_fixture_management_continues
as_service test ! -e "$quadlet_dir/codexia-tunnel.container"
rc=0; podman container exists codexia-tunnel || rc=$?
test "$rc" = 1

# Keep the real container inspection and fault only the selected identity
# lookup to simulate a credential record replaced since container creation.
db_verifier_bin=$(as_service mktemp -d "$service_home/.codexia-db-verifier.XXXXXX")
as_service tee "$db_verifier_bin/podman" >/dev/null <<'MOCK_PODMAN'
#!/usr/bin/env bash
set -euo pipefail
if [[ "${1:-}" == secret && "${2:-}" == inspect &&
      "${3:-}" == codexia-postgres-admin-password &&
      "${4:-}" == codexia-postgres-app-password &&
      -z "${5:-}" && -n "${CODEXIA_TEST_REPLACED_DB_SECRET:-}" ]]; then
  /usr/bin/podman "$@" | jq --arg name "$CODEXIA_TEST_REPLACED_DB_SECRET" '
    if any(.[]; .Spec.Name == $name) then
      map(if .Spec.Name == $name then .ID = "0000000000000000000000000" else . end)
    else error("missing requested secret in batch inspection") end'
  exit 0
fi
exec /usr/bin/podman "$@"
MOCK_PODMAN
as_service chmod 0700 "$db_verifier_bin/podman"
for stale_secret in codexia-postgres-admin-password codexia-postgres-app-password; do
cat > "$tmp/verify-db-stale-secrets.yml" <<YAML
---
- hosts: localhost
  connection: local
  gather_facts: false
  become: true
  become_user: $service_user
  environment:
    PATH: "$db_verifier_bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
    HOME: "$service_home"
    XDG_CONFIG_HOME: "$service_home/.config"
    XDG_DATA_HOME: "$service_home/.local/share"
    XDG_RUNTIME_DIR: "/run/user/$service_uid"
    DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/$service_uid/bus"
    CODEXIA_TEST_REPLACED_DB_SECRET: "$stale_secret"
  tasks:
    - ansible.builtin.include_tasks: "$repo_root/deploy/ansible/verify-base-db-container.yml"
YAML
if "${ANSIBLE_PLAYBOOK:-ansible-playbook}" -i localhost, "$tmp/verify-db-stale-secrets.yml" > "$tmp/db-stale-secrets.log" 2>&1; then
  echo "Database container verification accepted a stale $stale_secret secret ID" >&2
  exit 1
fi
grep -q 'Database container has unexpected PGDATA, storage, network, port, or current secret identity configuration' "$tmp/db-stale-secrets.log"
done
as_service rm -- "$db_verifier_bin/podman"
as_service rmdir -- "$db_verifier_bin"
db_verifier_bin=

# Mirror the production one-shot network admission against real rootless Podman.
expected_networks=$(printf '%s\n' 'codexia|bridge|false' 'codexia-data|bridge|true' | LC_ALL=C sort)
observed_networks=$(podman network inspect --format '{{.Name}}|{{.Driver}}|{{.Internal}}' codexia codexia-data | LC_ALL=C sort)
test "$observed_networks" = "$expected_networks"
for volume in codexia-postgres codexia-data codexia-history; do
  test "$(podman volume inspect --format '{{.Name}}' "$volume")" = "$volume"
done
quadlet_image() {
  local image
  image=$(sed -n 's/^Image=//p' "$repo_root/deploy/quadlet/$1")
  [[ "$image" =~ ^[^[:space:]@]+@sha256:[a-f0-9]{64}$ ]]
  printf '%s\n' "$image"
}
expected_db_image=$(quadlet_image codexia-db.container)
db_reference_without_digest=${expected_db_image%@*}
db_reference_without_tag=${db_reference_without_digest%:*}
actual_db_image=$(podman inspect --format '{{.Config.Image}}' codexia-db)
case "$actual_db_image" in
  "$expected_db_image"|"$db_reference_without_tag@${expected_db_image##*@}") ;;
  *) printf 'Unexpected PostgreSQL image reference: %s\n' "$actual_db_image" >&2; exit 1 ;;
esac
test "$(podman inspect --format '{{json .NetworkSettings.Networks}}' codexia-db | jq -r 'keys | join(",")')" = codexia-data
test "$(podman inspect --format '{{json .HostConfig.PortBindings}}' codexia-db | jq -c 'if . == null then {} else . end')" = '{}'
test "$(podman inspect --format '{{range .Mounts}}{{if eq .Type "volume"}}{{.Name}}|{{.Destination}}{{"\n"}}{{end}}{{end}}' codexia-db)" = 'codexia-postgres|/var/lib/postgresql/data'
podman inspect --format '{{json .Mounts}}' codexia-db | jq -e '[.[] | select(.Destination == "/var/lib/postgresql/data" or (.Destination | startswith("/var/lib/postgresql/data/")) or (.Destination | startswith("/var/lib/postgresql/")))] | length == 1 and .[0].Type == "volume" and .[0].Name == "codexia-postgres" and .[0].Destination == "/var/lib/postgresql/data" and .[0].RW == true' >/dev/null
podman inspect --format '{{json .Config.Env}}' codexia-db | jq -e 'index("PGDATA=/var/lib/postgresql/data/pgdata") != null and index("POSTGRES_DB=codexia") != null and index("POSTGRES_USER=codexia_admin") != null and index("POSTGRES_PASSWORD_FILE=/run/secrets/admin-password") != null' >/dev/null
podman exec codexia-db pg_isready -U codexia -d codexia >/dev/null

# Independent management remains available after the database adoption checks.
assert_fixture_management_continues
test "$(podman inspect --format '{{json .HostConfig.PortBindings}}' codexia-db | jq -c 'if . == null then {} else . end')" = '{}'

# A database containing only a user-defined type and no migration ledger is
# not pristine. Role recovery must reject it and preserve the type and volume.
podman exec codexia-db psql -X -v ON_ERROR_STOP=1 -U codexia_admin -d codexia -c \
  'ALTER SCHEMA public OWNER TO codexia_admin; CREATE TYPE public.phase_b_enum_probe AS ENUM ('"'"'kept'"'"');' >/dev/null
podman exec codexia-db psql -X -v ON_ERROR_STOP=1 -U codexia_admin -d postgres -c 'ALTER DATABASE codexia OWNER TO codexia_admin; DROP ROLE codexia' >/dev/null
if apply_base > "$tmp/type-only-no-ledger.log" 2>&1; then
  echo 'Base convergence treated a user-defined type without a migration ledger as pristine' >&2
  exit 1
fi
grep -q 'Missing application role is recoverable only for an explicitly approved empty PostgreSQL database' "$tmp/type-only-no-ledger.log"
test "$(podman exec codexia-db psql -X -qAt -U codexia_admin -d postgres -c "SELECT count(*) FROM pg_roles WHERE rolname='codexia'")" = 0
test "$(podman exec codexia-db psql -X -qAt -U codexia_admin -d codexia -c "SELECT count(*) FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='public' AND t.typname='phase_b_enum_probe'")" = 1
podman exec codexia-db psql -X -v ON_ERROR_STOP=1 -U codexia_admin -d codexia -c 'DROP TYPE public.phase_b_enum_probe' >/dev/null

# Simulate initdb interruption after the role transaction rolled back: after
# removing the test object, the truly empty database is recoverable without
# replacing its volume or rotating either protected secret.
apply_base > "$tmp/init-recovery.log" || { cat "$tmp/init-recovery.log"; exit 1; }
test "$(podman exec codexia-db psql -X -qAt -U codexia_admin -d postgres -c "SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname='codexia'")" = codexia

# The interrupted-role fixture temporarily transfers public-schema ownership
# to the administrator so the application role can be dropped. Restore the
# normal application-owned schema before exercising the real app migrations.
podman exec codexia-db psql -X -v ON_ERROR_STOP=1 -U codexia_admin -d codexia -c 'ALTER SCHEMA public OWNER TO codexia' >/dev/null

# Apply the repository's exact migration set so later convergence proves a
# real schema adoption instead of accepting an untracked application database.
migration_sql="$tmp/migrations.sql"
{
  cat <<'SQL'
\set ON_ERROR_STOP on
BEGIN;
SELECT pg_advisory_xact_lock(hashtext('codexia.persistence.migrations'));
CREATE TABLE codexia_schema_migrations (
  version text PRIMARY KEY,
  checksum char(64) NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$'),
  applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
SQL
  while IFS= read -r migration; do
    version=$(basename "$migration")
    checksum=$(sha256sum "$migration" | cut -d' ' -f1)
    cat "$migration"
    printf "\nINSERT INTO codexia_schema_migrations(version, checksum) VALUES ('%s', '%s');\n" "$version" "$checksum"
  done < <(find "$repo_root/packages/persistence-postgres/migrations" -maxdepth 1 -type f -name '*.sql' | sort)
  printf '\nCOMMIT;\n'
} > "$migration_sql"
podman exec -i codexia-db sh -ec 'export PGPASSWORD="$(cat /run/secrets/app-password)"; exec psql -X -v ON_ERROR_STOP=1 -h 127.0.0.1 -U codexia -d codexia' < "$migration_sql" >/dev/null
apply_base > "$tmp/schema-adoption.log" || { cat "$tmp/schema-adoption.log"; exit 1; }
grep -q 'changed=0' "$tmp/schema-adoption.log"

podman exec codexia-db sh -ec 'export PGPASSWORD="$(cat /run/secrets/app-password)"; psql -X -v ON_ERROR_STOP=1 -h 127.0.0.1 -U codexia -d codexia -c "CREATE TABLE public.phase_b_adoption_probe(id integer PRIMARY KEY, value text NOT NULL); INSERT INTO public.phase_b_adoption_probe VALUES (1, '\''preserved-data'\'');"' >/dev/null

CODEXIA_SERVICE_USER="$service_user" ANSIBLE_PLAYBOOK="${ANSIBLE_PLAYBOOK:-ansible-playbook}" GITHUB_ACTIONS=true CODEXIA_DISPOSABLE_HOST=base-integration bash "$repo_root/deploy/ansible/test-auth-runtime-integration.sh"

# A role privilege mismatch must fail verification without silently repairing it.
podman exec codexia-db psql -X -v ON_ERROR_STOP=1 -U codexia_admin -d codexia -c 'ALTER ROLE codexia WITH SUPERUSER' >/dev/null
if apply_base > "$tmp/role-mismatch.log" 2>&1; then
  echo 'Base verification accepted a superuser application role' >&2
  exit 1
fi
test "$(podman exec codexia-db psql -X -qAt -U codexia_admin -d codexia -c "SELECT rolsuper FROM pg_roles WHERE rolname='codexia'")" = t
podman exec codexia-db psql -X -v ON_ERROR_STOP=1 -U codexia_admin -d codexia -c 'ALTER ROLE codexia WITH NOSUPERUSER' >/dev/null
apply_base > "$tmp/role-restored.log" || { cat "$tmp/role-restored.log"; exit 1; }

# A schema checksum mismatch is detected and left untouched for operator repair.
first_migration=$(find "$repo_root/packages/persistence-postgres/migrations" -maxdepth 1 -type f -name '*.sql' | sort | head -1)
first_version=$(basename "$first_migration")
first_checksum=$(sha256sum "$first_migration" | cut -d' ' -f1)
podman exec codexia-db psql -X -v ON_ERROR_STOP=1 -U codexia_admin -d codexia -c "UPDATE codexia_schema_migrations SET checksum=repeat('0',64) WHERE version='$first_version'" >/dev/null
if apply_base > "$tmp/schema-mismatch.log" 2>&1; then
  echo 'Base verification accepted schema migration drift' >&2
  exit 1
fi
grep -q 'PostgreSQL schema migration ledger differs from the packaged release' "$tmp/schema-mismatch.log"
test "$(podman exec codexia-db psql -X -qAt -U codexia_admin -d codexia -c "SELECT checksum FROM codexia_schema_migrations WHERE version='$first_version'")" = "$(printf '%064d' 0)"
podman exec codexia-db psql -X -v ON_ERROR_STOP=1 -U codexia_admin -d codexia -c "UPDATE codexia_schema_migrations SET checksum='$first_checksum' WHERE version='$first_version'" >/dev/null
apply_base > "$tmp/schema-restored.log" || { cat "$tmp/schema-restored.log"; exit 1; }

# Killing the connection after CREATE ROLE but before the following statement
# rolls back the role. The canonical initializer keeps these effects in one txn.
interrupted_role=codexia_phase_b_interrupted
if podman exec codexia-db psql -X -v ON_ERROR_STOP=1 -U codexia_admin -d codexia -c "BEGIN; CREATE ROLE $interrupted_role LOGIN; SELECT pg_terminate_backend(pg_backend_pid()); ALTER DATABASE codexia OWNER TO $interrupted_role; COMMIT" > "$tmp/init-interrupted.log" 2>&1; then
  echo 'Database interruption fixture unexpectedly completed' >&2
  exit 1
fi
test "$(podman exec codexia-db psql -X -qAt -U codexia_admin -d codexia -c "SELECT count(*) FROM pg_roles WHERE rolname='$interrupted_role'")" = 0
test "$(podman exec codexia-db psql -X -qAt -U codexia_admin -d codexia -c "SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname='codexia'")" = codexia

# Stop and remove only this disposable container while retaining the exact named volume.
volume_created=$(podman volume inspect --format '{{.CreatedAt}}|{{.Mountpoint}}' codexia-postgres)
systemctl --user stop codexia-db.service
if podman container exists codexia-db; then
  test "$(podman inspect --format '{{.State.Running}}' codexia-db)" = false
  podman rm codexia-db >/dev/null
fi
systemctl --user reset-failed codexia-db.service >/dev/null 2>&1 || true
apply_base > "$tmp/adopt.log" || { cat "$tmp/adopt.log"; exit 1; }
test "$(podman volume inspect --format '{{.CreatedAt}}|{{.Mountpoint}}' codexia-postgres)" = "$volume_created"
test "$(podman exec codexia-db sh -ec 'export PGPASSWORD="$(cat /run/secrets/app-password)"; psql -X -qAt -h 127.0.0.1 -U codexia -d codexia -c "SELECT value FROM public.phase_b_adoption_probe WHERE id=1"')" = preserved-data

# A major-version mismatch must fail before a new database process can touch that volume.
mountpoint=${volume_created#*|}
systemctl --user stop codexia-db.service
if podman container exists codexia-db; then
  test "$(podman inspect --format '{{.State.Running}}' codexia-db)" = false
  podman rm codexia-db >/dev/null
fi
systemctl --user reset-failed codexia-db.service >/dev/null 2>&1 || true
podman unshare sh -ec 'printf "16\n" > "$1/pgdata/PG_VERSION"' sh "$mountpoint"
if apply_base > "$tmp/major-mismatch.log" 2>&1; then
  echo 'Base convergence accepted a PostgreSQL major-version mismatch' >&2
  exit 1
fi
rc=0; podman container exists codexia-db || rc=$?
test "$rc" = 1
rc=0; systemctl --user is-active codexia-db.service >/dev/null 2>&1 || rc=$?
test "$rc" != 0
test "$(podman unshare cat "$mountpoint/pgdata/PG_VERSION")" = 16

printf '%s\n' 'Verified rootless Quadlet convergence, fresh PostgreSQL init, no-change repeat, data adoption, mismatch denial, pinned roles, private networks, and closed publication with continuous management.'
