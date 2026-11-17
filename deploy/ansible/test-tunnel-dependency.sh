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

# Both exact directives can be separated by other bytes. Preserve those bytes
# and file mode while changing the dependency pair in one atomic replace.
sed '/^Requires=codexia-api\.service$/a # retained dependency comment' \
  deploy/quadlet/codexia-tunnel.container > "$tmp/valid/codexia-tunnel.container"
chmod 0600 "$tmp/valid/codexia-tunnel.container"
sed \
  -e 's/^Requires=codexia-api\.service$/Requires=codexia-api-proxy.service/' \
  -e 's/^After=network-online\.target codexia-api\.service$/After=network-online.target codexia-api-proxy.service/' \
  "$tmp/valid/codexia-tunnel.container" > "$tmp/nonadjacent-expected.container"
"${ANSIBLE_PLAYBOOK:-ansible-playbook}" -i localhost, "$tmp/switch.yml" > "$tmp/nonadjacent.log"
cmp "$tmp/nonadjacent-expected.container" "$tmp/valid/codexia-tunnel.container"
test "$(stat -c '%a' "$tmp/valid/codexia-tunnel.container")" = 600

# Reject interrupted/mixed state and duplicate directives before any write.
for variant in mixed duplicate; do
  case "$variant" in
    mixed)
      sed 's/^Requires=codexia-api\.service$/Requires=codexia-api-proxy.service/' \
        deploy/quadlet/codexia-tunnel.container > "$tmp/invalid/codexia-tunnel.container" ;;
    duplicate)
      sed '/^Requires=codexia-api\.service$/p' \
        deploy/quadlet/codexia-tunnel.container > "$tmp/invalid/codexia-tunnel.container" ;;
  esac
  cp "$tmp/invalid/codexia-tunnel.container" "$tmp/invalid-before.container"
  if "${ANSIBLE_PLAYBOOK:-ansible-playbook}" -i localhost, "$tmp/reject.yml" > "$tmp/$variant.log" 2>&1; then
    echo "Tunnel dependency switch accepted $variant state" >&2; exit 1
  fi
  grep -Fq 'Tunnel Quadlet is not in the canonical legacy state' "$tmp/$variant.log"
  cmp "$tmp/invalid-before.container" "$tmp/invalid/codexia-tunnel.container"
done

# A symlink must not allow replacing the target outside the Quadlet directory.
rm -- "$tmp/invalid/codexia-tunnel.container"
cp deploy/quadlet/codexia-tunnel.container "$tmp/link-target.container"
ln -s "$tmp/link-target.container" "$tmp/invalid/codexia-tunnel.container"
if "${ANSIBLE_PLAYBOOK:-ansible-playbook}" -i localhost, "$tmp/reject.yml" > "$tmp/symlink.log" 2>&1; then
  echo 'Tunnel dependency switch accepted a symlink' >&2; exit 1
fi
grep -Fq 'Tunnel Quadlet must be a regular non-symlink file' "$tmp/symlink.log"
test -L "$tmp/invalid/codexia-tunnel.container"
cmp deploy/quadlet/codexia-tunnel.container "$tmp/link-target.container"

printf '%s\n' 'Verified one atomic dependency replacement, exact byte and mode preservation, and rejection of mixed, duplicate, repeated, unknown or symlink states.'
