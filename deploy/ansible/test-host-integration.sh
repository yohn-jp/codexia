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
# The hosted runner may have XDG values in PID 1's environment; seed this isolated
# fixture manager with the service identity before its generator is exercised.
sudo systemctl set-environment "HOME=$home" "XDG_CONFIG_HOME=$home/.config" "XDG_RUNTIME_DIR=/run/user/$uid"
sudo systemctl restart "user@$uid.service"
manager_pid=$(sudo systemctl show --property=MainPID --value "user@$uid.service")
test -n "$manager_pid"
manager_environment=$(sudo sh -c 'tr "\\0" "\\n" < "/proc/$1/environ"' _ "$manager_pid")
if ! printf '%s\n' "$manager_environment" | grep -Fqx "HOME=$home" || ! printf '%s\n' "$manager_environment" | grep -Fqx "XDG_RUNTIME_DIR=/run/user/$uid"; then
  printf '%s\n' "$manager_environment" | grep -E '^(HOME|XDG_CONFIG_HOME|XDG_RUNTIME_DIR)=' >&2 || true
  echo 'The fixture user manager did not start with the service account home/runtime.' >&2; exit 1
fi
sudo systemctl unset-environment HOME XDG_CONFIG_HOME XDG_RUNTIME_DIR
rootless systemctl --user set-environment "XDG_CONFIG_HOME=$home/.config" "XDG_RUNTIME_DIR=/run/user/$uid"
rootless systemctl --user daemon-reexec
rootless systemctl --user show-environment | grep -Fqx "XDG_CONFIG_HOME=$home/.config"
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
if ! rootless systemctl --user start codexia-fixture-network.service; then
  echo 'Quadlet network unit was not loaded; checking the source and generator output.' >&2
  rootless stat -c '%n %U:%G %a' "$home/.config/containers/systemd/codexia-fixture.network"
  manager_pid=$(rootless pgrep -u "$uid" -xo systemd || true)
  if [[ -n "$manager_pid" ]]; then
    rootless sh -c 'tr "\0" "\n" < "/proc/$1/environ" | grep -E "^(HOME|XDG_CONFIG_HOME|XDG_RUNTIME_DIR)="' _ "$manager_pid" || true
  fi
  rootless systemctl --user show-environment | awk -F= '$1 ~ /^(HOME|XDG_CONFIG_HOME|XDG_RUNTIME_DIR)$/ {print}'
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
