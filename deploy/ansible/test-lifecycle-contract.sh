#!/usr/bin/env bash
set -euo pipefail
command -v ansible-playbook >/dev/null || { echo 'ansible-playbook is required' >&2; exit 1; }
root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
playbook="$root/deploy/ansible/test-lifecycle-contract.yml"
tmp="$(mktemp -d)"
trap 'rm -rf -- "$tmp"' EXIT
mkdir -m 0700 "$tmp/bin"

cat > "$tmp/bin/codexia-lifecycle-updater" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
operation="${1:?}"
case "$operation" in
  pause|resume|rollback|acceptance-rollback)
    printf '%s\n' "$operation" > "$CODEXIA_LIFECYCLE_OPERATION_FILE"
    case "$operation" in
      pause)
        printf '%s\n' '{"format":"codexia-controller-state/v1","journal":{"phase":"idle","active":{"slot":"blue"}},"lastError":null,"paused":true,"installed":{"image":"ghcr.io/yohn-jp/codexia-backend@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},"previous":{"image":"ghcr.io/yohn-jp/codexia-backend@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"},"failedImages":[]}'
        ;;
      resume)
        printf '%s\n' '{"format":"codexia-controller-state/v1","journal":{"phase":"idle","active":{"slot":"blue"}},"lastError":null,"paused":false,"installed":{"image":"ghcr.io/yohn-jp/codexia-backend@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},"previous":{"image":"ghcr.io/yohn-jp/codexia-backend@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"},"failedImages":[]}'
        ;;
      rollback|acceptance-rollback)
        failed_images='["ghcr.io/yohn-jp/codexia-backend@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"]'
        if [ -e "$CODEXIA_LIFECYCLE_OPERATION_FILE.drop-failed-image" ]; then failed_images='[]'; touch "$CODEXIA_LIFECYCLE_OPERATION_FILE.saw-drop"; fi
        printf '{"format":"codexia-controller-state/v1","journal":{"phase":"committed","active":{"slot":"green"}},"lastError":null,"paused":true,"installed":{"image":"ghcr.io/yohn-jp/codexia-backend@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"},"previous":{"image":"ghcr.io/yohn-jp/codexia-backend@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},"failedImages":%s}\n' "$failed_images"
        ;;
    esac
    ;;
  verify)
    selected="$(cat -- "$CODEXIA_LIFECYCLE_OPERATION_FILE")"
    case "$selected" in
      pause) paused=true; slot=blue; image=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa ;;
      resume) paused=false; slot=blue; image=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa ;;
      rollback|acceptance-rollback) paused=true; slot=green; image=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb ;;
      *) exit 9 ;;
    esac
    failed_images='[]'
    case "$selected" in
      rollback|acceptance-rollback)
        failed_images='["ghcr.io/yohn-jp/codexia-backend@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"]'
        if [ -e "$CODEXIA_LIFECYCLE_OPERATION_FILE.drop-verified-failed-image" ]; then failed_images='[]'; fi
        ;;
    esac
    printf '{"state":{"journal":{"phase":"idle","active":{"slot":"%s"}},"lastError":null,"paused":%s,"installed":{"image":"ghcr.io/yohn-jp/codexia-backend@sha256:%s"},"previous":{"image":"ghcr.io/yohn-jp/codexia-backend@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},"failedImages":%s},"observed":{"writers":[{"slot":"%s"}],"route":"%s"}}\n' "$slot" "$paused" "$image" "$failed_images" "$slot" "$slot"
    ;;
  *) exit 8 ;;
esac
SH
chmod 0700 "$tmp/bin/codexia-lifecycle-updater"

cat > "$tmp/bin/systemctl" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == '--user show --property=Version' ]]; then echo 'Version=259'; exit 0; fi
[[ "$*" == '--user is-active codexia-updater.timer' ]] || exit 8
state="${CODEXIA_LIFECYCLE_TIMER_STATE:-inactive}"
if [[ -e "${CODEXIA_LIFECYCLE_OPERATION_FILE:?}" && -f "$CODEXIA_LIFECYCLE_OPERATION_FILE.timer-after" ]]; then
  state="$(cat -- "$CODEXIA_LIFECYCLE_OPERATION_FILE.timer-after")"
fi
printf '%s\n' "$state"
[[ "$state" == active ]] && exit 0
[[ "$state" == inactive ]] && exit 3
exit 8
SH
chmod 0700 "$tmp/bin/systemctl"

run_case(){
  local name="$1" stage="$2" enabled="$3" paused="$4" timer="$5" expected_op="$6" previous="${7:-}" drop_failed="${8:-false}" timer_after="${9:-}" drop_verified_failed="${10:-false}"
  local log="$tmp/$name.log" operation_file="$tmp/$name.operation"
  rm -f -- "$operation_file"
  [[ "$drop_failed" == true ]] && : > "$operation_file.drop-failed-image"
  [[ -n "$timer_after" ]] && printf '%s\n' "$timer_after" > "$operation_file.timer-after"
  [[ "$drop_verified_failed" == true ]] && : > "$operation_file.drop-verified-failed-image"
  if CODEXIA_LIFECYCLE_STAGE="$stage" CODEXIA_LIFECYCLE_CONFIG_ENABLED="$enabled" CODEXIA_LIFECYCLE_PAUSED="$paused" \
    CODEXIA_LIFECYCLE_TIMER_STATE="$timer" CODEXIA_LIFECYCLE_FAKE_UPDATER="$tmp/bin/codexia-lifecycle-updater" \
    CODEXIA_LIFECYCLE_OPERATION_FILE="$operation_file" CODEXIA_LIFECYCLE_PREVIOUS="$previous" \
    PATH="$tmp/bin:$PATH" ansible-playbook -i localhost, -c local "$playbook" > "$log" 2>&1; then
    if [[ "$expected_op" == fail || "$expected_op" == fail-after-* ]]; then
      cat "$log" >&2
      echo "Lifecycle case unexpectedly passed: $name" >&2
      exit 1
    fi
    [[ "$(cat -- "$operation_file")" == "$expected_op" ]] || { cat "$log" >&2; echo "Wrong lifecycle command for $name" >&2; exit 1; }
  else
    if [[ "$expected_op" == fail ]]; then
      [[ ! -e "$operation_file" ]] || { cat "$log" >&2; echo "Rejected lifecycle case invoked the updater: $name" >&2; exit 1; }
    elif [[ "$expected_op" == fail-after-* ]]; then
      [[ "$(cat -- "$operation_file")" == "${expected_op#fail-after-}" ]] || { cat "$log" >&2; echo "Expected post-operation contract failure: $name" >&2; exit 1; }
    else
      cat "$log" >&2
      echo "Lifecycle case failed unexpectedly: $name" >&2
      exit 1
    fi
  fi
}

run_case pause-enabled pause true false active pause
run_case resume-disabled resume false true inactive resume
run_case rollback-enabled rollback true true active rollback
run_case rollback-disabled rollback false true inactive acceptance-rollback
run_case rollback-requires-pause rollback true false active fail
run_case rollback-requires-digest rollback true true active fail not-a-signed-image
run_case rollback-requires-different-image rollback true true active fail ghcr.io/yohn-jp/codexia-backend@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
run_case rollback-requires-failed-image-suppression rollback true true active fail-after-rollback '' true
run_case rollback-verification-preserves-failed-image rollback true true active fail-after-rollback '' false '' true
run_case lifecycle-preserves-timer rollback true true active fail-after-rollback '' false inactive

## Run the real site dispatcher with only the host-specific verification tasks stubbed.
mkdir -p "$tmp/site" "$tmp/site-state"
cp "$root/deploy/ansible/"{site,lifecycle,validate-runtime}.yml "$tmp/site/"
: > "$tmp/site-state/controller.json"
printf '%s\n' '---' '[]' > "$tmp/site/preflight.yml"
# Reuse the synthetic observed controller state from the task-level contract.
sed -n '/    - name: Provide a synthetic initialized controller/,/    - name: Exercise the production lifecycle tasks/{ /    - name: Exercise the production lifecycle tasks/d; s/^    //; p; }' "$playbook" > "$tmp/site/verify.yml"
cat > "$tmp/bin/podman" <<'SH'
#!/bin/sh
exit 0
SH
chmod 0700 "$tmp/bin/podman"
for stage in pause resume rollback; do
  operation_file="$tmp/site-$stage.operation"
  paused=true; [[ "$stage" != pause ]] || paused=false
  CODEXIA_LIFECYCLE_STAGE="$stage" CODEXIA_LIFECYCLE_CONFIG_ENABLED=false CODEXIA_LIFECYCLE_PAUSED="$paused" \
    CODEXIA_LIFECYCLE_TIMER_STATE=inactive CODEXIA_LIFECYCLE_FAKE_UPDATER="$tmp/bin/codexia-lifecycle-updater" \
    CODEXIA_LIFECYCLE_OPERATION_FILE="$operation_file" PATH="$tmp/bin:$PATH" \
    ansible-playbook -i 'codexia,' -c local "$tmp/site/site.yml" \
      -e "codexia_stage=$stage" -e "state_dir=$tmp/site-state" \
      -e 'codexia_frontend_origin=https://fixture.invalid' -e "codexia_proxy_image=ghcr.io/yohn-jp/codexia-backend@sha256:$(printf '%064d' 0)" \
      -e '{"codexia_browser_auth":{"mode":"token"},"codexia_runtime":{"format":"codexia-runtime/v1","profile":"core","modelCachePath":null,"tmpfs":{"tempSize":"64m","moduleCacheSize":"1g"},"resources":{"memoryMaxBytes":null,"cpuQuotaPercent":null}}}' \
      -e "test_stage=$stage" -e "{\"test_paused\":$paused,\"test_config_enabled\":false}" \
      -e "test_active_image=ghcr.io/yohn-jp/codexia-backend@sha256:$(printf 'a%.0s' {1..64})" \
      -e "test_previous=ghcr.io/yohn-jp/codexia-backend@sha256:$(printf 'b%.0s' {1..64})" \
      -e "updater=$tmp/bin/codexia-lifecycle-updater" -e 'config_path=/tmp/codexia-lifecycle-test-config.json' \
      > "$tmp/site-$stage.log" 2>&1 || { cat "$tmp/site-$stage.log" >&2; exit 1; }
  expected="$stage"; [[ "$stage" != rollback ]] || expected=acceptance-rollback
  [[ "$(cat "$operation_file")" == "$expected" ]]
done
echo 'Ansible lifecycle stage contract checks passed'
