#!/bin/sh
set -eu
# This file is injected read-only from a unique per-run host keypair. Never bake keys into OCI.
test -s /home/codexia-backup/.ssh/authorized_keys
test "$(stat -c '%a' /home/codexia-backup/.ssh/authorized_keys)" = 600
install -d -o root -g root -m 0755 /run/sshd
ssh-keygen -A
chown -R codexia-backup:codexia-backup /backups
exec /usr/sbin/sshd -D -e -p 22 \
  -o PermitRootLogin=no -o PasswordAuthentication=no -o PubkeyAuthentication=yes \
  -o AllowUsers=codexia-backup
