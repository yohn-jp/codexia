#!/usr/bin/env bash
# Run only on a disposable Ubuntu 26.04 systemd VM (never production).
set -euo pipefail
umask 077
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
test "$(lsb_release -rs)" = 26.04
test "$(uname -m)" = x86_64
user=codexia-ci-host
uid=22001
home="/home/$user"
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
        codexia_service_group: $user
        codexia_service_uid: $uid
        codexia_service_gid: $uid
        codexia_service_home: $home
YAML
apply() { env -u XDG_CONFIG_HOME "${ANSIBLE_PLAYBOOK:-ansible-playbook}" -i "$tmp/inventory.yml" deploy/ansible/site.yml; }
# Set only the not-yet-created fixture account's manager environment before
# Ansible enables lingering and starts its first user manager.
manager_dropin_dir="/run/systemd/system/user@$uid.service.d"
sudo install -d -m 0755 "$manager_dropin_dir"
manager_dropin="$manager_dropin_dir/10-codexia-ci-xdg.conf"
test ! -e "$manager_dropin"
cat <<EOF | sudo tee "$manager_dropin" >/dev/null
[Service]
Environment=HOME=$home
Environment=XDG_CONFIG_HOME=$home/.config
Environment=XDG_RUNTIME_DIR=/run/user/$uid
EOF
sudo systemctl daemon-reload
apply | tee "$tmp/first.log"
grep -Eq 'changed=[1-9][0-9]*' "$tmp/first.log"
apply | tee "$tmp/second.log"
grep -q 'changed=0' "$tmp/second.log"
test "$(id -u "$user")" = "$uid"
test "$(id -g "$user")" = "$uid"
test "$(loginctl show-user "$user" --property=Linger --value)" = yes
rootless() (
  # The runner checkout is intentionally inaccessible to the fixture account.
  cd /
  sudo -H -u "$user" env HOME="$home" XDG_CONFIG_HOME="$home/.config" XDG_DATA_HOME="$home/.local/share" XDG_STATE_HOME="$home/.local/state" XDG_RUNTIME_DIR="/run/user/$uid" \
    DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$uid/bus" "$@"
)
# Verify the user manager retained the service account paths from its first start.
manager_pid=$(sudo systemctl show --property=MainPID --value "user@$uid.service")
test -n "$manager_pid"
manager_environment=$(sudo sh -c 'tr "\\0" "\\n" < "/proc/$1/environ"' _ "$manager_pid")
if ! printf '%s\n' "$manager_environment" | grep -Fqx "HOME=$home" || ! printf '%s\n' "$manager_environment" | grep -Fqx "XDG_RUNTIME_DIR=/run/user/$uid"; then
  printf '%s\n' "$manager_environment" | grep -E '^(HOME|XDG_CONFIG_HOME|XDG_RUNTIME_DIR)=' >&2 || true
  echo 'The fixture user manager did not start with the service account home/runtime.' >&2; exit 1
fi
if ! printf '%s\n' "$manager_environment" | grep -Fqx "XDG_CONFIG_HOME=$home/.config"; then
  printf '%s\n' "$manager_environment" | grep -E '^(HOME|XDG_CONFIG_HOME|XDG_RUNTIME_DIR)=' >&2 || true
  echo 'The fixture user manager did not start with its XDG config home.' >&2; exit 1
fi
# systemctl --user show-environment reports imported client variables. The
# generator wrapper below checks the environment actually passed by systemd.
manager_session_environment=$(rootless systemctl --user show-environment | awk -F= '$1 ~ /^(HOME|XDG_CONFIG_HOME|XDG_RUNTIME_DIR)$/ {print}')
generator_dir=/run/systemd/user-generators
generator_wrapper="$generator_dir/podman-user-generator"
generator_log="/run/user/$uid/codexia-podman-user-generator.log"
test ! -e "$generator_wrapper"
rootless test ! -e "$generator_log"
cat > "$tmp/podman-user-generator" <<EOF
#!/bin/sh
printf 'uid=%s\\n' "\$(id -u)" >> "$generator_log"
env | grep -E '^(HOME|XDG_CONFIG_HOME|XDG_RUNTIME_DIR)=' >> "$generator_log" || true
exec /usr/lib/systemd/user-generators/podman-user-generator "\$@"
EOF
sudo install -d -m 0755 "$generator_dir"
sudo install -m 0755 "$tmp/podman-user-generator" "$generator_wrapper"
test -f /sys/fs/cgroup/cgroup.controllers
test "$(rootless /usr/bin/podman info --format '{{.Host.Security.Rootless}}')" = true
rootless mkdir -p "$home/.config/containers/systemd"
cat <<'QUADLET' | rootless tee "$home/.config/containers/systemd/codexia-fixture.network" >/dev/null
[Network]
NetworkName=codexia-fixture
Driver=bridge
Internal=true
QUADLET
rootless chmod 0600 "$home/.config/containers/systemd/codexia-fixture.network"
rootless systemctl --user daemon-reload
if ! sudo test -s "$generator_log"; then
  echo 'The Podman generator wrapper did not run; inspect the user generator path.' >&2
  exit 1
fi
generator_environment=$(sudo cat "$generator_log")
if ! printf '%s\n' "$generator_environment" | grep -Fqx "HOME=$home" || ! printf '%s\n' "$generator_environment" | grep -Fqx "XDG_RUNTIME_DIR=/run/user/$uid" || ! printf '%s\n' "$generator_environment" | grep -Fqx "XDG_CONFIG_HOME=$home/.config"; then
  printf '%s\n' "$generator_environment" >&2
  echo 'The user manager passed an unexpected environment to the Podman generator.' >&2; exit 1
fi
if ! rootless systemctl --user start codexia-fixture-network.service; then
  echo 'Quadlet network unit was not loaded; checking the source and generator output.' >&2
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
printf '%s\n' 'Verified real Ubuntu host first/repeat convergence and rootless Quadlet network.'
