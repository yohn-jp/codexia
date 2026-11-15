#!/usr/bin/env bash
set -euo pipefail
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/home/.local/share/containers/storage" "$tmp/bin"
export INSPECT_TEST_HOME="$tmp/home" INSPECT_TEST_LOG="$tmp/commands"
cat > "$tmp/bin/getent" <<'SH'
#!/bin/sh
test "$1" = passwd && test "$2" = codexia-inspect || exit 99
printf 'codexia-inspect:x:1001:1001::%s:/bin/sh\n' "$INSPECT_TEST_HOME"
SH
cat > "$tmp/bin/loginctl" <<'SH'
#!/bin/sh
test "$1" = show-user || exit 99
printf 'yes\n'
SH
cat > "$tmp/bin/podman" <<'SH'
#!/bin/sh
printf '%s\n' "$*" >> "$INSPECT_TEST_LOG"
case "$1 $2" in
  'info --format') printf 'true v2\n';;
  'network exists'|'volume exists'|'secret exists') exit 0;;
  'container exists') test "$3" = codexia-api;;
  'inspect --type') printf 'true sha256:fixture example.invalid/backend@sha256:fixture\n';;
  *) exit 99;;
esac
SH
chmod 700 "$tmp/bin/"*
export PATH="$tmp/bin:$PATH"
cat > "$tmp/inspect.yml" <<YAML
- hosts: localhost
  connection: local
  gather_facts: false
  vars:
    codexia_service_user: codexia-inspect
    ansible_facts:
      distribution: Ubuntu
      distribution_version: '26.04'
      architecture: x86_64
      service_mgr: systemd
      user_id: codexia-inspect
      user_uid: 1001
      user_dir: "$tmp/home"
  tasks:
    - ansible.builtin.include_tasks: "$(pwd)/deploy/ansible/inspect.yml"
    - ansible.builtin.assert:
        that:
          - inspect_podman_available | bool
          - inspect_secrets.results | length == 5
          - inspect_images.results | length == 1
          - inspect_images.results[0].item.item == 'codexia-api'
          - inspect_images.results[0].stdout.startswith('true sha256:fixture')
YAML
"${ANSIBLE_PLAYBOOK:-ansible-playbook}" -i localhost, "$tmp/inspect.yml" > "$tmp/inspect.log" || { cat "$tmp/inspect.log"; exit 1; }
grep -q 'changed=0' "$tmp/inspect.log"
grep -q 'secret exists codexia-tunnel-token' "$INSPECT_TEST_LOG"
! grep -Eq '(^| )(create|start|stop|rm|--showsecret)( |$)' "$INSPECT_TEST_LOG"
# Unsupported input must fail before any Podman operation.
: > "$INSPECT_TEST_LOG"
sed "s/distribution_version: '26.04'/distribution_version: '24.04'/" "$tmp/inspect.yml" > "$tmp/unsupported.yml"
if "${ANSIBLE_PLAYBOOK:-ansible-playbook}" -i localhost, "$tmp/unsupported.yml" > "$tmp/unsupported.log"; then
  echo 'Unsupported baseline accepted' >&2; exit 1
fi
test ! -s "$INSPECT_TEST_LOG"
