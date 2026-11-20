#!/usr/bin/env bash
set -euo pipefail
ansible=${ANSIBLE_PLAYBOOK:-ansible-playbook}
repo_root=$(cd "$(dirname "$0")/../.." && pwd)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

mkdir "$tmp/bin"
cat > "$tmp/bin/systemctl" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
case "${2:-}" in
  is-active)
    printf '%s\n' "$CODEXIA_TEST_TIMER_ACTIVE"
    case "$CODEXIA_TEST_TIMER_ACTIVE" in active) exit 0;; inactive) exit 3;; *) exit 4;; esac
    ;;
  is-enabled)
    printf '%s\n' "$CODEXIA_TEST_TIMER_ENABLED"
    case "$CODEXIA_TEST_TIMER_ENABLED" in enabled) exit 0;; disabled) exit 1;; *) exit 1;; esac
    ;;
  *) exit 99;;
esac
SH
chmod 0755 "$tmp/bin/systemctl"
cat > "$tmp/timer.yml" <<YAML
---
- hosts: localhost
  connection: local
  gather_facts: false
  tasks:
    - ansible.builtin.slurp:
        src: "$tmp/config.json"
      register: saved_config
    - ansible.builtin.include_tasks: "$repo_root/deploy/ansible/verify-timer.yml"
      vars:
        allow_enable_interruption: "{{ lookup('env', 'CODEXIA_TEST_ENABLE_RECOVERY') | default('false', true) | bool }}"
YAML

run_timer_check() {
  local controller_enabled=$1 timer_active=$2 timer_enabled=$3 recovery=$4 expected=$5
  printf '{"enabled":%s}\n' "$controller_enabled" > "$tmp/config.json"
  local status=0
  PATH="$tmp/bin:$PATH" CODEXIA_TEST_TIMER_ACTIVE="$timer_active" CODEXIA_TEST_TIMER_ENABLED="$timer_enabled" CODEXIA_TEST_ENABLE_RECOVERY="$recovery" \
    "$ansible" -i localhost, "$tmp/timer.yml" > "$tmp/result.log" 2>&1 || status=$?
  if [[ "$expected" == pass && "$status" -ne 0 ]]; then cat "$tmp/result.log" >&2; exit 1; fi
  if [[ "$expected" == fail && "$status" -eq 0 ]]; then
    echo "Unexpected timer verification success: enabled=$controller_enabled active=$timer_active unit=$timer_enabled" >&2
    exit 1
  fi
}

run_timer_check true active enabled false pass
run_timer_check false inactive disabled false pass
run_timer_check false active enabled false fail
run_timer_check true inactive disabled false fail
run_timer_check false failed disabled false fail
run_timer_check true inactive disabled true pass
run_timer_check true inactive enabled true pass
run_timer_check true active enabled true pass
run_timer_check true active disabled true fail
run_timer_check false active enabled true fail
printf '%s\n' 'Polling timer verification accepts normal matching state and only the approved enable forward states.'
