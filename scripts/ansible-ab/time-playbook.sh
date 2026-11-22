#!/usr/bin/env bash
# Transparent timing wrapper; preserves arguments, stdout, stderr and exit code.
# Never records playbook arguments, environment variables or credential contents.
set -euo pipefail
test "$GITHUB_ACTIONS" = true
test -x "$ANSIBLE_REAL_PLAYBOOK"
test -n "$ANSIBLE_AB_METRIC_FILE"
test -n "$ANSIBLE_AB_ARM"
if [[ "$ANSIBLE_AB_ARM" == mitogen_linear && "$CODEXIA_SERVICE_USER" == codexia-ab-rootless ]]; then
  # The canonical rootless tests generate a few small, runner-private playbooks
  # under /tmp. Mitogen requires cwd traversal after become_user. Grant only
  # execute on these owned directories, not read or write privileges.
  for arg in "$@"; do
    if [[ "$arg" == /tmp/codexia-base-runtime.*/*.yml ]]; then
      dir=${arg%/*}
      if [[ -d "$dir" && -O "$dir" ]]; then
        sudo setfacl -m "u:$CODEXIA_SERVICE_USER:--x" "$dir"
      fi
    fi
  done
fi
start=$(date +%s%N)
status=0
"$ANSIBLE_REAL_PLAYBOOK" "$@" || status=$?
end=$(date +%s%N)
printf '%s,%s,%s\n' "$ANSIBLE_AB_ARM" "$(((end - start) / 1000000))" "$status" >> "$ANSIBLE_AB_METRIC_FILE"
exit "$status"
