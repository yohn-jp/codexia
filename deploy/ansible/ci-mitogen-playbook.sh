#!/usr/bin/env bash
# CI-only adapter for the pinned Mitogen strategy on a disposable runner.
# The canonical scripts remain unchanged; no production SSH credentials are used.
set -euo pipefail

test "${GITHUB_ACTIONS:-}" = true
test "${CODEXIA_SERVICE_USER:-}" = codexia-phase-b-test
test "${ANSIBLE_STRATEGY:-}" = mitogen_linear
test -x "${ANSIBLE_REAL_PLAYBOOK:?missing pinned Ansible executable}"
test -x "${GITHUB_WORKSPACE:?}/deploy/ansible/site.yml" || test -f "${GITHUB_WORKSPACE}/deploy/ansible/site.yml"

# Some integration tests construct temporary playbooks under private /tmp
# directories. Local Mitogen become requires pathname traversal of the cwd.
# Grant x-only permission to the disposable account on our own directories.
# Never open permissions on source files, credential files or arbitrary paths.
for arg in "$@"; do
  case "$arg" in
    /tmp/codexia-base-runtime.*/*.yml)
      dir=${arg%/*}
      if [[ -d "$dir" && -O "$dir" && ! -L "$dir" ]]; then
        sudo setfacl -m "u:$CODEXIA_SERVICE_USER:--x" "$dir"
      fi
      ;;
  esac
done

exec "$ANSIBLE_REAL_PLAYBOOK" "$@"
