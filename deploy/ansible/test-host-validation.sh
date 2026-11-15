#!/usr/bin/env bash
set -euo pipefail
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
cat > "$tmp/test.yml" <<YAML
- hosts: localhost
  connection: local
  gather_facts: false
  vars:
    ansible_facts:
      distribution: Ubuntu
      distribution_version: '26.04'
      architecture: x86_64
      service_mgr: systemd
    codexia_host_approved: true
    codexia_service_user: codexia
    codexia_service_group: codexia
    codexia_service_uid: 1001
    codexia_service_gid: 1001
    codexia_service_home: /home/codexia
  tasks:
    - ansible.builtin.include_tasks: "$(pwd)/deploy/ansible/host-validate.yml"
YAML
cat > "$tmp/syntax.yml" <<YAML
- hosts: localhost
  gather_facts: false
  tasks:
    - ansible.builtin.import_tasks: "$(pwd)/deploy/ansible/host.yml"
YAML
"${ANSIBLE_PLAYBOOK:-ansible-playbook}" -i localhost, "$tmp/syntax.yml" --syntax-check
run() { "${ANSIBLE_PLAYBOOK:-ansible-playbook}" -i localhost, "$tmp/test.yml" "$@"; }
run > "$tmp/valid.log" || { cat "$tmp/valid.log"; exit 1; }
grep -q 'changed=0' "$tmp/valid.log"
for invalid in '{"codexia_host_approved":false}' '{"codexia_service_uid":0}' '{"codexia_service_home":"/etc"}' '{"codexia_service_user":"root"}' '{"codexia_service_gid":"1001"}'; do
  if run -e "$invalid" > "$tmp/invalid.log"; then
    echo "Invalid host contract was accepted: $invalid" >&2; exit 1
  fi
  grep -q 'changed=0' "$tmp/invalid.log"
done
