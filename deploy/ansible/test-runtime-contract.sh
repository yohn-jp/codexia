#!/usr/bin/env bash
set -euo pipefail
ansible=${ANSIBLE_PLAYBOOK:-ansible-playbook}
repo_root=$(cd "$(dirname "$0")/../.." && pwd)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
cat > "$tmp/runtime.yml" <<YAML
---
- hosts: localhost
  connection: local
  gather_facts: false
  tasks:
    - ansible.builtin.include_tasks: "$repo_root/deploy/ansible/validate-runtime.yml"
YAML

core='{"format":"codexia-runtime/v1","profile":"core","modelCachePath":null,"tmpfs":{"tempSize":"64m","moduleCacheSize":"1g"},"resources":{"memoryMaxBytes":null,"cpuQuotaPercent":null}}'
full='{"format":"codexia-runtime/v1","profile":"full","modelCachePath":"/var/cache/codexia/models","tmpfs":{"tempSize":"64m","moduleCacheSize":"512m"},"resources":{"memoryMaxBytes":8589934592,"cpuQuotaPercent":250}}'
full_nested='{"format":"codexia-runtime/v1","profile":"full","modelCachePath":"/var/cache/codexia/models/semantic","tmpfs":{"tempSize":"64m","moduleCacheSize":"512m"},"resources":{"memoryMaxBytes":8589934592,"cpuQuotaPercent":250}}'
run_runtime() {
  node -e 'process.stdout.write(JSON.stringify({codexia_runtime:JSON.parse(process.argv[1])}))' "$1" > "$tmp/vars.json"
  "$ansible" -i localhost, "$tmp/runtime.yml" -e "@$tmp/vars.json"
}
run_runtime "$core" > "$tmp/core.log"
run_runtime "$full" > "$tmp/full.log"
run_runtime "$full_nested" > "$tmp/full-nested.log"

reject_runtime() {
  local runtime_json=$1
  if run_runtime "$runtime_json" > "$tmp/rejected.log" 2>&1; then
    echo 'Invalid runtime contract passed Ansible validation' >&2
    exit 1
  fi
  grep -q 'The declared Codexia runtime is invalid or outside the supported bounded profile' "$tmp/rejected.log"
}
reject_runtime '{"format":"codexia-runtime/v1","profile":"full","modelCachePath":null,"tmpfs":{"tempSize":"64m","moduleCacheSize":"512m"},"resources":{"memoryMaxBytes":8589934592,"cpuQuotaPercent":250}}'
reject_runtime '{"format":"codexia-runtime/v1","profile":"full","modelCachePath":"/var/cache/codexia/models","extraEnvironment":{},"tmpfs":{"tempSize":"64m","moduleCacheSize":"512m"},"resources":{"memoryMaxBytes":8589934592,"cpuQuotaPercent":250}}'
reject_runtime '{"format":"codexia-runtime/v1","profile":"full","modelCachePath":"/var/cache/../etc","tmpfs":{"tempSize":"64m","moduleCacheSize":"512m"},"resources":{"memoryMaxBytes":8589934592,"cpuQuotaPercent":250}}'
reject_runtime '{"format":"codexia-runtime/v1","profile":"full","modelCachePath":"/etc","tmpfs":{"tempSize":"64m","moduleCacheSize":"512m"},"resources":{"memoryMaxBytes":8589934592,"cpuQuotaPercent":250}}'
reject_runtime '{"format":"codexia-runtime/v1","profile":"full","modelCachePath":"/home/codexia/.ssh","tmpfs":{"tempSize":"64m","moduleCacheSize":"512m"},"resources":{"memoryMaxBytes":8589934592,"cpuQuotaPercent":250}}'
reject_runtime '{"format":"codexia-runtime/v1","profile":"full","modelCachePath":"/var/cache/codexia/models-evil","tmpfs":{"tempSize":"64m","moduleCacheSize":"512m"},"resources":{"memoryMaxBytes":8589934592,"cpuQuotaPercent":250}}'
reject_runtime '{"format":"codexia-runtime/v1","profile":"full","modelCachePath":"/var//cache/models","tmpfs":{"tempSize":"64m","moduleCacheSize":"512m"},"resources":{"memoryMaxBytes":8589934592,"cpuQuotaPercent":250}}'
reject_runtime '{"format":"codexia-runtime/v1","profile":"full","modelCachePath":"/var/cache/codexia/models","tmpfs":{"tempSize":"64m","moduleCacheSize":"8g"},"resources":{"memoryMaxBytes":8589934592,"cpuQuotaPercent":250}}'
reject_runtime '{"format":"codexia-runtime/v1","profile":"full","modelCachePath":"/var/cache/codexia/models","tmpfs":{"tempSize":"64m","moduleCacheSize":"512m"},"resources":{"memoryMaxBytes":268435456,"cpuQuotaPercent":250}}'
reject_runtime '{"format":"codexia-runtime/v1","profile":"full","modelCachePath":"/var/cache/codexia/models","tmpfs":{"tempSize":"64m","moduleCacheSize":"512m"},"resources":{"memoryMaxBytes":8589934592,"cpuQuotaPercent":0}}'
printf '%s\n' 'Validated Core/Full runtime profiles and rejected malformed, unsafe, unknown, or undersized contracts before host tasks.'
