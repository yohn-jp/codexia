#!/usr/bin/env bash
# Transparent timing wrapper; preserves arguments, stdout, stderr and exit code.
# Never records playbook arguments, environment variables or credential contents.
set -uo pipefail
test "$GITHUB_ACTIONS" = true
test -x "$ANSIBLE_REAL_PLAYBOOK"
test -n "$ANSIBLE_AB_METRIC_FILE"
test -n "$ANSIBLE_AB_ARM"
start=$(date +%s%N)
"$ANSIBLE_REAL_PLAYBOOK" "$@"
status=$?
end=$(date +%s%N)
printf '%s,%s,%s\n' "$ANSIBLE_AB_ARM" "$(((end - start) / 1000000))" "$status" >> "$ANSIBLE_AB_METRIC_FILE"
exit "$status"
