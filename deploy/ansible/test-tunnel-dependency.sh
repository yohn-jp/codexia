#!/usr/bin/env bash
set -euo pipefail
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
repo_root=$(pwd)
mkdir -p "$tmp/valid" "$tmp/invalid"
cp deploy/quadlet/codexia-tunnel.container "$tmp/valid/codexia-tunnel.container"
sed 's/^Requires=codexia-api\.service$/Requires=codexia-untrusted.service/' \
  deploy/quadlet/codexia-tunnel.container > "$tmp/invalid/codexia-tunnel.container"

cat > "$tmp/switch.yml" <<YAML
- hosts: localhost
  connection: local
  gather_facts: false
  vars:
    ansible_python_interpreter: /usr/bin/python3
    quadlet_dir: "$tmp/valid"
  tasks:
    - ansible.builtin.include_tasks: "$repo_root/deploy/ansible/switch-tunnel-to-proxy.yml"
YAML
cat > "$tmp/reject.yml" <<YAML
- hosts: localhost
  connection: local
  gather_facts: false
  vars:
    ansible_python_interpreter: /usr/bin/python3
    quadlet_dir: "$tmp/invalid"
  tasks:
    - ansible.builtin.include_tasks: "$repo_root/deploy/ansible/switch-tunnel-to-proxy.yml"
YAML

"${ANSIBLE_PLAYBOOK:-ansible-playbook}" -i localhost, "$tmp/switch.yml" > "$tmp/switch.log"
sed \
  -e 's/^Requires=codexia-api\.service$/Requires=codexia-api-proxy.service/' \
  -e 's/^After=network-online\.target codexia-api\.service$/After=network-online.target codexia-api-proxy.service/' \
  deploy/quadlet/codexia-tunnel.container > "$tmp/expected.container"
cmp "$tmp/expected.container" "$tmp/valid/codexia-tunnel.container"

cp "$tmp/valid/codexia-tunnel.container" "$tmp/after-switch.container"
if "${ANSIBLE_PLAYBOOK:-ansible-playbook}" -i localhost, "$tmp/switch.yml" > "$tmp/repeat.log" 2>&1; then
  echo 'Tunnel dependency switch accepted an already switched state' >&2
  exit 1
fi
cmp "$tmp/after-switch.container" "$tmp/valid/codexia-tunnel.container"

cp "$tmp/invalid/codexia-tunnel.container" "$tmp/invalid-before.container"
if "${ANSIBLE_PLAYBOOK:-ansible-playbook}" -i localhost, "$tmp/reject.yml" > "$tmp/invalid.log" 2>&1; then
  echo 'Tunnel dependency switch accepted an unknown writer dependency' >&2
  exit 1
fi
cmp "$tmp/invalid-before.container" "$tmp/invalid/codexia-tunnel.container"

printf '%s\n' 'Verified exact legacy-to-proxy dependency change, preserved network ordering, and rejection of repeated or unknown dependency states.'
