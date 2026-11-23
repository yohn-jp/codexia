#!/bin/sh
set -eu
# A unique per-run public key is mounted read-only; no credentials enter OCI layers.
test -s /home/codexia-backup/.ssh/authorized_keys
test "$(stat -c '%a' /home/codexia-backup/.ssh/authorized_keys)" = 600
umask 077
ssh-keygen -q -t ed25519 -N '' -f /etc/ssh/fixture-host-keys/ssh_host_ed25519_key
exec /usr/sbin/sshd -D -e -p 2222 \
  -h /etc/ssh/fixture-host-keys/ssh_host_ed25519_key \
  -o PidFile=/run/sshd/sshd.pid \
  -o PermitRootLogin=no -o PasswordAuthentication=no -o PubkeyAuthentication=yes \
  -o AllowUsers=codexia-backup
