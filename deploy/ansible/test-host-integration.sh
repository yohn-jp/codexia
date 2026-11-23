#!/usr/bin/env bash
# Run only on a disposable Ubuntu 26.04 systemd VM (never production).
set -euo pipefail
umask 077
tmp=$(mktemp -d)
trap 'rm -rf -- "$tmp"' EXIT
test "$(lsb_release -rs)" = 26.04
test "$(uname -m)" = x86_64
# Default is the strict, clean target-VM proof. Actions may explicitly select
# its contaminated-runner fixture; that is not clean-target acceptance.
proof_mode=${CODEXIA_HOST_PROOF_MODE:-clean}
case "$proof_mode" in
  clean) ;;
  actions-fixture) test "${GITHUB_ACTIONS:-}" = true ;;
  *) echo "Unknown host proof mode" >&2; exit 1 ;;
esac
user=${CODEXIA_HOST_FIXTURE_USER:-codexia-ci-host}
uid=${CODEXIA_HOST_FIXTURE_UID:-22001}
group=${CODEXIA_HOST_FIXTURE_GROUP:-$user}
gid=${CODEXIA_HOST_FIXTURE_GID:-$uid}
home=${CODEXIA_HOST_FIXTURE_HOME:-/home/$user}
[[ "$user" =~ ^[a-z_][a-z0-9_-]{0,31}$ && "$group" =~ ^[a-z_][a-z0-9_-]{0,31}$ ]] || {
  echo 'Invalid fixture service identity name' >&2; exit 1;
}
[[ "$uid" =~ ^[1-9][0-9]{2,8}$ && "$gid" =~ ^[1-9][0-9]{2,8}$ && "$home" == "/home/$user" ]] || {
  echo 'Invalid fixture service identity numeric ID or home' >&2; exit 1;
}
manager_dropin_dir="/run/systemd/system/user@$uid.service.d"
manager_dropin="$manager_dropin_dir/10-codexia-ci-xdg.conf"
generator_dir=/run/systemd/user-generators
generator_wrapper="$generator_dir/podman-user-generator"
fixture_quadlet="$home/.config/containers/systemd/codexia-fixture.network"
fixture_unit_dropin="$home/.config/systemd/user/codexia-fixture-network.service.d/10-codexia-ci-runtime.conf"
host_identity_expected=false
manager_dropin_installed=false
manager_dropin_dir_created=false
generator_dir_created=false
generator_wrapper_installed=false
fixture_quadlet_installed=false
fixture_unit_dropin_installed=false
declare -A mitogen_traversal_paths=()
grant_mitogen_traversal() {
  [[ "$proof_mode" == actions-fixture && "${ANSIBLE_STRATEGY:-}" == mitogen_linear ]] || return 0
  local dir
  for dir in "$(pwd -P)/deploy/ansible" "$tmp"; do
    while [[ "$dir" != /home && "$dir" != / ]]; do
      if [[ -d "$dir" && -O "$dir" && ! -L "$dir" && ! -v mitogen_traversal_paths["$dir"] ]]; then
        sudo setfacl -m "u:$uid:--x" "$dir"
        mitogen_traversal_paths["$dir"]=1
      fi
      dir=${dir%/*}
      [[ -n "$dir" ]] || dir=/
    done
  done
}
if getent passwd "$user" || getent passwd "$uid" || getent group "$user" || getent group "$uid"; then
  echo 'Fixture identity already exists; refusing adoption' >&2; exit 1
fi
test ! -e "$home"
cat > "$tmp/inventory.yml" <<YAML
all:
  children:
    codexia:
      hosts:
        localhost:
          ansible_connection: local
          ansible_python_interpreter: /usr/bin/python3
      vars:
        codexia_stage: host
        codexia_host_approved: true
        codexia_create_service_account: true
        codexia_service_user: $user
        codexia_service_group: $group
        codexia_service_uid: $uid
        codexia_service_gid: $gid
        codexia_service_home: $home
YAML
apply() {
  if [[ -n "${CODEXIA_HOST_CONVERGENCE:-}" ]]; then
    # Stable fixture seam: a future canonical push entrypoint may accept the
    # same private inventory and lifecycle name without changing host setup.
    [[ -x "$CODEXIA_HOST_CONVERGENCE" ]] || { echo 'Configured host convergence callable is not executable' >&2; return 1; }
    "$CODEXIA_HOST_CONVERGENCE" "$tmp/inventory.yml" host
  else
    env -u XDG_CONFIG_HOME "${ANSIBLE_PLAYBOOK:-ansible-playbook}" -i "$tmp/inventory.yml" deploy/ansible/site.yml
  fi
}
rootless() (
  # The runner checkout is intentionally inaccessible to the fixture account.
  cd /
  sudo -H -u "$user" env HOME="$home" XDG_CONFIG_HOME="$home/.config" XDG_DATA_HOME="$home/.local/share" XDG_STATE_HOME="$home/.local/state" XDG_RUNTIME_DIR="/run/user/$uid" \
    DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$uid/bus" "$@"
)
cleanup() {
  local test_status=$?
  local status=$test_status
  local cleanup_status=0
  trap - EXIT
  set +e
  if [[ "$host_identity_expected" == true ]] && getent passwd "$user" >/dev/null 2>&1 && \
      [[ "$(id -u "$user" 2>/dev/null)" == "$uid" && "$(id -g "$user" 2>/dev/null)" == "$gid" && "$(getent passwd "$user" | cut -d: -f6)" == "$home" ]]; then
    rootless systemctl --user stop codexia-fixture-network.service >/dev/null 2>&1 || true
    if [[ "$fixture_quadlet_installed" == true ]]; then
      rootless /usr/bin/podman network rm codexia-fixture >"$tmp/network-rm.log" 2>&1 || true
      if rootless /usr/bin/podman network exists codexia-fixture >/dev/null 2>&1; then
        printf 'Fixture Podman network remains after cleanup: codexia-fixture\n' >&2
        cat "$tmp/network-rm.log" >&2
        cleanup_status=1
      fi
    fi
    if [[ "$fixture_quadlet_installed" == true ]]; then rootless rm -f -- "$fixture_quadlet" || cleanup_status=1; fi
    if [[ "$fixture_unit_dropin_installed" == true ]]; then
      rootless rm -f -- "$fixture_unit_dropin" || cleanup_status=1
      rootless rmdir -- "$(dirname "$fixture_unit_dropin")" 2>/dev/null || true
    fi
    rootless rm -f -- "/run/user/$uid/codexia-podman-user-generator.log" \
      "/run/user/$uid/codexia-podman-user-generator-effective.log" || cleanup_status=1
    rootless systemctl --user daemon-reload >/dev/null 2>&1 || cleanup_status=1
  elif [[ "$host_identity_expected" == true ]] && getent passwd "$user" >/dev/null 2>&1; then
    printf 'Refusing to clean a changed host fixture identity: %s\n' "$user" >&2
    cleanup_status=1
  fi
  if [[ "$generator_wrapper_installed" == true ]]; then
    if sudo test -f "$generator_wrapper" && sudo cmp -s "$tmp/podman-user-generator" "$generator_wrapper"; then
      sudo rm -- "$generator_wrapper" || cleanup_status=1
    else
      printf 'Refusing to remove a changed Podman generator wrapper: %s\n' "$generator_wrapper" >&2
      cleanup_status=1
    fi
  fi
  if [[ "$generator_dir_created" == true ]]; then sudo rmdir "$generator_dir" 2>/dev/null || cleanup_status=1; fi
  if [[ "$manager_dropin_installed" == true ]]; then
    if sudo test -f "$manager_dropin" && sudo cmp -s "$tmp/user-manager.conf" "$manager_dropin"; then
      sudo rm -- "$manager_dropin" || cleanup_status=1
      sudo systemctl daemon-reload >/dev/null 2>&1 || cleanup_status=1
    else
      printf 'Refusing to remove a changed user-manager fixture drop-in: %s\n' "$manager_dropin" >&2
      cleanup_status=1
    fi
  fi
  if [[ "$manager_dropin_dir_created" == true ]]; then sudo rmdir "$manager_dropin_dir" 2>/dev/null || cleanup_status=1; fi
  local acl_path
  for acl_path in "${!mitogen_traversal_paths[@]}"; do
    sudo setfacl -x "u:$uid" "$acl_path" || cleanup_status=1
  done
  rm -rf -- "$tmp" || cleanup_status=1
  if (( status == 0 && cleanup_status != 0 )); then status=$cleanup_status; fi
  printf 'Ansible host fixture cleanup finished with test status %s, cleanup status %s, final status %s.\n' "$test_status" "$cleanup_status" "$status" >&2
  exit "$status"
}
trap cleanup EXIT
# On the Actions runner only, isolate the fixture manager from known runner
# environment contamination. The clean proof does not set these variables.
if [[ "$proof_mode" == actions-fixture ]]; then
  if [[ ! -d "$manager_dropin_dir" ]]; then sudo install -d -m 0755 "$manager_dropin_dir"; manager_dropin_dir_created=true; fi
  test ! -e "$manager_dropin" && test ! -L "$manager_dropin"
  cat > "$tmp/user-manager.conf" <<EOF
[Service]
Environment=HOME=$home
Environment=XDG_CONFIG_HOME=$home/.config
Environment=XDG_RUNTIME_DIR=/run/user/$uid
EOF
  manager_dropin_installed=true
  sudo install -m 0644 "$tmp/user-manager.conf" "$manager_dropin"
  sudo systemctl daemon-reload
fi
host_identity_expected=true
grant_mitogen_traversal
started_ms=$(date +%s%3N)
apply | tee "$tmp/first.log"
printf 'HOST_ANSIBLE_TIMING phase=first duration_ms=%s\n' "$(( $(date +%s%3N) - started_ms ))"
grep -Eq 'changed=[1-9][0-9]*' "$tmp/first.log"
started_ms=$(date +%s%3N)
apply | tee "$tmp/second.log"
printf 'HOST_ANSIBLE_TIMING phase=idempotent duration_ms=%s\n' "$(( $(date +%s%3N) - started_ms ))"
grep -q 'changed=0' "$tmp/second.log"
test "$(id -u "$user")" = "$uid"
test "$(id -g "$user")" = "$gid"
test "$(loginctl show-user "$user" --property=Linger --value)" = yes
# Check the actual inherited paths; an unset/empty XDG_CONFIG_HOME means
# the standard HOME/.config default, not a missing configuration.
assert_runtime_environment() {
  local observed="$1" config
  printf '%s\n' "$observed" | grep -Fqx "HOME=$home" || return 1
  printf '%s\n' "$observed" | grep -Fqx "XDG_RUNTIME_DIR=/run/user/$uid" || return 1
  config=$(printf '%s\n' "$observed" | sed -n 's/^XDG_CONFIG_HOME=//p')
  [[ -z "$config" || "$config" == "$home/.config" ]]
}
# Prove the same assertion rejects independently corrupted HOME, runtime and
# config paths; the checks below use this function on observed environments.
for bad in "HOME=/wrong" "XDG_RUNTIME_DIR=/wrong" "XDG_CONFIG_HOME=/wrong"; do
  case "$bad" in
    HOME=*) probe=$(printf '%s\n' "$bad" "XDG_RUNTIME_DIR=/run/user/$uid" "XDG_CONFIG_HOME=$home/.config");;
    XDG_RUNTIME_DIR=*) probe=$(printf '%s\n' "HOME=$home" "$bad" "XDG_CONFIG_HOME=$home/.config");;
    *) probe=$(printf '%s\n' "HOME=$home" "XDG_RUNTIME_DIR=/run/user/$uid" "$bad");;
  esac
  if assert_runtime_environment "$probe"; then echo "Invalid runtime environment accepted" >&2; exit 1; fi
done
manager_pid=$(sudo systemctl show --property=MainPID --value "user@$uid.service")
test "$manager_pid" -gt 0
manager_environment=$(sudo sh -c 'tr "\\0" "\\n" < "/proc/$1/environ"' _ "$manager_pid" | grep -E '^(HOME|XDG_CONFIG_HOME|XDG_RUNTIME_DIR)=' || true)
if ! assert_runtime_environment "$manager_environment"; then
  printf '%s\n' "$manager_environment" >&2
  echo 'The fixture user manager has incorrect process paths.' >&2; exit 1
fi
manager_session_environment=$(rootless systemctl --user show-environment | awk -F= '$1 ~ /^(HOME|XDG_CONFIG_HOME|XDG_RUNTIME_DIR)$/ {print}')
generator_dir=/run/systemd/user-generators
generator_wrapper="$generator_dir/podman-user-generator"
generator_log="/run/user/$uid/codexia-podman-user-generator.log"
generator_effective_log="/run/user/$uid/codexia-podman-user-generator-effective.log"
test ! -e "$generator_wrapper"
rootless test ! -e "$generator_log"
cat > "$tmp/podman-user-generator" <<EOF
#!/bin/sh
# The wrapper is observational in clean mode. Do not affect other users.
if [ "\$(id -u)" != "$uid" ]; then
  exec /usr/lib/systemd/user-generators/podman-user-generator "\$@"
fi
# Record the actual inherited environment BEFORE any Actions-only repair.
env | grep -E '^(HOME|XDG_CONFIG_HOME|XDG_RUNTIME_DIR)=' > "$generator_log" || true
if [ "$proof_mode" = actions-fixture ]; then
  export HOME="$home" XDG_CONFIG_HOME="$home/.config" XDG_RUNTIME_DIR="/run/user/$uid"
fi
env | grep -E '^(HOME|XDG_CONFIG_HOME|XDG_RUNTIME_DIR)=' > "$generator_effective_log" || true
exec /usr/lib/systemd/user-generators/podman-user-generator "\$@"
EOF
if [[ ! -d "$generator_dir" ]]; then sudo install -d -m 0755 "$generator_dir"; generator_dir_created=true; fi
sudo install -m 0755 "$tmp/podman-user-generator" "$generator_wrapper"
generator_wrapper_installed=true
test -f /sys/fs/cgroup/cgroup.controllers
test "$(rootless /usr/bin/podman info --format '{{.Host.Security.Rootless}}')" = true
rootless mkdir -p "$home/.config/containers/systemd"
rootless test ! -e "$fixture_quadlet" && rootless test ! -L "$fixture_quadlet"
fixture_quadlet_installed=true
cat <<'QUADLET' | rootless tee "$home/.config/containers/systemd/codexia-fixture.network" >/dev/null
[Network]
NetworkName=codexia-fixture
Driver=bridge
Internal=true
QUADLET
rootless chmod 0600 "$home/.config/containers/systemd/codexia-fixture.network"
# Only the Actions fixture receives a service drop-in. The clean proof
# must run the generated service with the environment it actually inherits.
if [[ "$proof_mode" == actions-fixture ]]; then
  unit_dropin_dir="$home/.config/systemd/user/codexia-fixture-network.service.d"
  rootless test ! -e "$fixture_unit_dropin" && rootless test ! -L "$fixture_unit_dropin"
  fixture_unit_dropin_installed=true
  rootless install -d -m 0755 "$unit_dropin_dir"
  cat <<EOF | rootless tee "$unit_dropin_dir/10-codexia-ci-runtime.conf" >/dev/null
[Service]
Environment=HOME=$home
Environment=XDG_CONFIG_HOME=$home/.config
Environment=XDG_RUNTIME_DIR=/run/user/$uid
EOF
  rootless chmod 0600 "$unit_dropin_dir/10-codexia-ci-runtime.conf"
fi
rootless systemctl --user daemon-reload
if ! sudo test -s "$generator_log"; then
  echo 'The Podman generator wrapper did not run; inspect the user generator path.' >&2
  exit 1
fi
generator_environment=$(sudo cat "$generator_log")
effective_environment=$(sudo cat "$generator_effective_log")
if ! assert_runtime_environment "$generator_environment"; then
  printf '%s\n' "$generator_environment" >&2
  if [[ "$proof_mode" == clean ]]; then
    echo 'The clean VM generator inherited incorrect paths.' >&2; exit 1
  fi
  echo 'NOT_CHECKED: unmodified generator environment on a clean target VM (Actions runner contamination).'
fi
if ! assert_runtime_environment "$effective_environment"; then
  printf '%s\n' "$effective_environment" >&2
  echo 'The generator effective paths are incorrect.' >&2; exit 1
fi
if ! rootless systemctl --user start codexia-fixture-network.service; then
  echo 'Quadlet network unit failed to start; checking systemd and Podman diagnostics.' >&2
  rootless systemctl --user status codexia-fixture-network.service --no-pager || true
  rootless journalctl --user --boot --unit=codexia-fixture-network.service --no-pager || true
  rootless /usr/bin/podman network inspect codexia-fixture || true
  rootless stat -c '%n %U:%G %a' "$home/.config/containers/systemd/codexia-fixture.network"
  manager_pid=$(sudo systemctl show --property=MainPID --value "user@$uid.service")
  if [[ -n "$manager_pid" ]]; then
    sudo sh -c 'tr "\0" "\n" < "/proc/$1/environ" | grep -E "^(HOME|XDG_CONFIG_HOME|XDG_RUNTIME_DIR)="' _ "$manager_pid" || true
  fi
  printf '%s\n' "$manager_session_environment" >&2
  rootless systemd-analyze --user unit-paths
  rootless find "/run/user/$uid/systemd/generator" -maxdepth 1 -type f -name '*codexia-fixture*' -printf '%f\n' || true
  rootless journalctl --user --boot --grep='quadlet|generator' --no-pager || true
  rootless /usr/lib/systemd/user-generators/podman-user-generator -dryrun -v
  rootless systemctl --user list-unit-files --no-legend
  exit 1
fi
rootless /usr/bin/podman network exists codexia-fixture
test "$(rootless /usr/bin/podman network inspect --format '{{.Internal}}' codexia-fixture)" = true
rootless systemctl --user stop codexia-fixture-network.service
if [[ "$proof_mode" == clean ]]; then
  printf '%s\n' 'Verified clean Ubuntu host first/repeat convergence and unmodified rootless Quadlet network.'
else
  printf '%s\n' 'Verified Ubuntu host first/repeat convergence and rootless Quadlet network with explicit Actions environment isolation.'
  printf '%s\n' 'NOT_CHECKED: clean target VM convergence without fixture-only manager/generator/service environment repair.'
fi
