#!/usr/bin/env bash
set -euo pipefail
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/home/.local/share/containers/storage" "$tmp/bin"
export INSPECT_TEST_HOME="$tmp/home" INSPECT_TEST_LOG="$tmp/commands"
cat > "$tmp/bin/getent" <<'SH'
#!/bin/sh
test "$1" = passwd && test "$2" = codexia-inspect || exit 99
if [ "${INSPECT_TEST_ACCOUNT_ABSENT:-0}" = 1 ]; then exit 2; fi
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
  'info --format') printf 'true\n';;
  'network exists'|'volume exists') exit 0;;
  'secret exists')
    case "$3" in
      codexia-postgres-admin-password|codexia-postgres-app-password) exit 0;;
      codexia-postgres-preflight-password) exit 1;;
      *) exit 99;;
    esac;;
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
YAML
run_inspect() {
  ANSIBLE_STDOUT_CALLBACK=default ANSIBLE_CALLBACK_RESULT_FORMAT=json ANSIBLE_NOCOLOR=true \
    "${ANSIBLE_PLAYBOOK:-ansible-playbook}" -i localhost, "$1"
}
run_inspect "$tmp/inspect.yml" > "$tmp/inspect.log" || { cat "$tmp/inspect.log"; exit 1; }
grep -q 'changed=0' "$tmp/inspect.log"
python3 - "$tmp/inspect.log" <<'PY'
import json
import re
import sys
from pathlib import Path

output = Path(sys.argv[1]).read_text()
reports = []
for result in re.finditer(r"^ok: \[localhost\] => (?=\{)", output, re.MULTILINE):
    decoded, _ = json.JSONDecoder().raw_decode(output[result.end():])
    report = decoded.get("msg")
    if isinstance(report, dict) and "existing_images" in report:
        reports.append(report)
assert len(reports) == 1, "inspect must emit exactly one topology report"
assert reports[0]["existing_images"] == {
    "codexia-api": "true sha256:fixture example.invalid/backend@sha256:fixture",
}, "inspect must show only the observed existing container identity"
assert reports[0]["secrets"] == {
    "codexia-postgres-admin-password": 0,
    "codexia-postgres-app-password": 0,
    "codexia-postgres-preflight-password": 1,
}, "inspect must distinguish the missing preflight secret from the four present secrets"
PY
if grep -Eq '(^| )(create|start|stop|rm|--showsecret)( |$)' "$INSPECT_TEST_LOG"; then
  echo 'Inspection issued a mutating or secret-disclosing command' >&2; exit 1
fi
# A fresh account must not be created and Podman must not be contacted.
: > "$INSPECT_TEST_LOG"
INSPECT_TEST_ACCOUNT_ABSENT=1 run_inspect "$tmp/inspect.yml" > "$tmp/absent.log" || { cat "$tmp/absent.log"; exit 1; }
grep -q 'changed=0' "$tmp/absent.log"
grep -Fq '"service_account_present": false' "$tmp/absent.log"
if grep -Fq '"existing_images"' "$tmp/absent.log"; then
  echo 'Inspect reported topology for a missing runtime account' >&2; exit 1
fi
test ! -s "$INSPECT_TEST_LOG"
# Unsupported input must fail before any Podman operation.
: > "$INSPECT_TEST_LOG"
sed "s/distribution_version: '26.04'/distribution_version: '24.04'/" "$tmp/inspect.yml" > "$tmp/unsupported.yml"
if run_inspect "$tmp/unsupported.yml" > "$tmp/unsupported.log"; then
  echo 'Unsupported baseline accepted' >&2; exit 1
fi
test ! -s "$INSPECT_TEST_LOG"
