#!/usr/bin/env bash
# Run only on a disposable Ubuntu 26.04 systemd VM (never production).
set -euo pipefail
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
apply() { "${ANSIBLE_PLAYBOOK:-ansible-playbook}" -i "$tmp/inventory.yml" deploy/ansible/site.yml; }
apply | tee "$tmp/first.log"
grep -Eq 'changed=[1-9][0-9]*' "$tmp/first.log"
apply | tee "$tmp/second.log"
grep -q 'changed=0' "$tmp/second.log"
test "$(id -u "$user")" = "$uid"
test "$(id -g "$user")" = "$uid"
test "$(loginctl show-user "$user" --property=Linger --value)" = yes
rootless() {
  sudo -u "$user" env HOME="$home" XDG_RUNTIME_DIR="/run/user/$uid" \
    DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$uid/bus" "$@"
}
test "$(rootless /usr/bin/podman info --format '{{.Host.Security.Rootless}} {{.Host.CgroupVersion}}')" = 'true v2'
rootless mkdir -p "$home/.config/containers/systemd"
cat <<'QUADLET' | rootless tee "$home/.config/containers/systemd/codexia-fixture.network" >/dev/null
[Network]
NetworkName=codexia-fixture
Driver=bridge
Internal=true
QUADLET
rootless systemctl --user daemon-reload
rootless systemctl --user start codexia-fixture-network.service
rootless /usr/bin/podman network exists codexia-fixture
test "$(rootless /usr/bin/podman network inspect --format '{{.Internal}}' codexia-fixture)" = true
rootless systemctl --user stop codexia-fixture-network.service
printf '%s\n' 'Verified real Ubuntu host first/repeat convergence and rootless Quadlet network.'
