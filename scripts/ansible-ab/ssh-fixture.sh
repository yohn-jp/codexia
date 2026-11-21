#!/usr/bin/env bash
# Loopback SSH fixture for the standalone Ansible A/B workflow only.
# No production inventory, credentials, network, service account or VM is touched.
set -euo pipefail
test "$GITHUB_ACTIONS" = true
test "$(lsb_release -rs)" = 26.04
test -n "$RUNNER_TEMP"

root="$RUNNER_TEMP/codexia-ansible-ab-ssh"
ssh_user=codexia-ab-ssh
service_user=codexia-ab-service
sudoers=/etc/sudoers.d/codexia-ansible-ab-ssh
action=$1

if [[ "$action" == cleanup ]]; then
  if [[ ! -f "$root/fixture-owned" ]]; then
    echo 'No owned A/B fixture marker; nothing to remove.'
    exit 0
  fi
  if [[ -f "$root/sshd.pid" ]]; then
    sudo kill "$(sudo cat "$root/sshd.pid")" 2>/dev/null || true
  fi
  # GitHub may cancel a running playbook before its SSH sessions exit.
  # Both accounts were newly created under this workflow-owned marker.
  sudo pkill -KILL -u "$ssh_user" 2>/dev/null || true
  sudo pkill -KILL -u "$service_user" 2>/dev/null || true
  sudo rm -f -- "$sudoers"
  for account in "$ssh_user" "$service_user"; do
    if getent passwd "$account" >/dev/null; then
      if [[ "$(getent passwd "$account" | cut -d: -f6)" != "/home/$account" ]]; then
        echo "Unexpected home; refusing to delete account: $account" >&2
        exit 1
      fi
      sudo userdel --remove "$account" || exit 1
    fi
  done
  rm -rf -- "$root"
  exit 0
fi

if [[ "$action" != create ]]; then
  echo 'Use create or cleanup' >&2
  exit 2
fi
if [[ -e "$root" || -e "$sudoers" ]] || getent passwd "$ssh_user" >/dev/null || getent passwd "$service_user" >/dev/null; then
  echo 'Refusing to adopt an existing A/B SSH fixture or user' >&2
  exit 1
fi

umask 077
mkdir -m 0700 "$root"
touch "$root/fixture-owned"
empty_skel=$(mktemp -d "$root/skel.XXXXXX")
sudo useradd --create-home --skel "$empty_skel" --user-group --shell /bin/bash "$ssh_user"
sudo useradd --create-home --skel "$empty_skel" --user-group --shell /bin/bash "$service_user"
rmdir "$empty_skel"

probe_dir="/home/$service_user/codexia-ab-probes"
sudo install -d -o "$service_user" -g "$service_user" -m 0700 "$probe_dir"
printf 'codexia-ab-service\n' | sudo tee "$probe_dir/identity" >/dev/null
sudo chown "$service_user:$service_user" "$probe_dir/identity"
sudo chmod 0600 "$probe_dir/identity"
for number in $(seq 0 11); do
  sudo install -o "$service_user" -g "$service_user" -m 0600 /dev/null "$probe_dir/probe-$number"
done

printf '%s ALL=(%s) NOPASSWD: ALL\n' "$ssh_user" "$service_user" | sudo tee "$sudoers" >/dev/null
sudo chmod 0440 "$sudoers"
sudo visudo -cf "$sudoers"

ssh-keygen -q -t ed25519 -N '' -f "$root/ssh_client"
ssh-keygen -q -t ed25519 -N '' -f "$root/ssh_host_ed25519"
sudo chown root:root "$root/ssh_host_ed25519"
sudo chmod 0600 "$root/ssh_host_ed25519"
sudo install -d -o "$ssh_user" -g "$ssh_user" -m 0700 "/home/$ssh_user/.ssh"
sudo install -o "$ssh_user" -g "$ssh_user" -m 0600 "$root/ssh_client.pub" "/home/$ssh_user/.ssh/authorized_keys"
printf '[127.0.0.1]:22222 %s\n' "$(cut -d' ' -f1-2 "$root/ssh_host_ed25519.pub")" > "$root/known_hosts"

cat > "$root/sshd_config" <<EOF
Port 22222
ListenAddress 127.0.0.1
HostKey $root/ssh_host_ed25519
PidFile $root/sshd.pid
AuthorizedKeysFile .ssh/authorized_keys
PermitRootLogin no
PasswordAuthentication no
KbdInteractiveAuthentication no
AuthenticationMethods publickey
UsePAM yes
AllowUsers $ssh_user
LogLevel ERROR
EOF
sudo install -d -m 0755 /run/sshd
sudo /usr/sbin/sshd -t -f "$root/sshd_config"
sudo /usr/sbin/sshd -f "$root/sshd_config" -E "$root/sshd.log"
for attempt in 1 2 3 4 5; do
  if ssh -p 22222 -i "$root/ssh_client" \
    -o BatchMode=yes -o IdentitiesOnly=yes \
    -o StrictHostKeyChecking=yes -o UserKnownHostsFile="$root/known_hosts" \
    "$ssh_user@127.0.0.1" /usr/bin/id -un > "$root/identity-observed"; then
    break
  fi
  sleep 1
done
test "$(cat "$root/identity-observed")" = "$ssh_user"

cat > "$root/inventory.yml" <<EOF
all:
  children:
    codexia:
      hosts:
        ab-target:
          ansible_host: 127.0.0.1
          ansible_port: 22222
          ansible_user: $ssh_user
          ansible_connection: ssh
          ansible_python_interpreter: /usr/bin/python3
          ansible_ssh_private_key_file: "$root/ssh_client"
EOF
printf '%s\n' 'Disposable SSH fixture ready: pinned host key, key-only loopback SSH and constrained fixture service user.'
