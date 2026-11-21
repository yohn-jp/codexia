#!/usr/bin/env bash
set -euo pipefail
command -v ansible-playbook >/dev/null || { echo 'ansible-playbook is required' >&2; exit 1; }
root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
playbook="$root/deploy/ansible/test-lifecycle-contract.yml"
tmp="$(mktemp -d)"
api_pid=
trap '[[ -z "${api_pid:-}" ]] || kill "$api_pid" 2>/dev/null || true; rm -rf -- "$tmp"' EXIT
mkdir -m 0700 "$tmp/bin"

cat > "$tmp/bin/codexia-lifecycle-updater" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
operation="${1:?}"
case "$operation" in
  verify-resume)
    [ "${CODEXIA_LIFECYCLE_BAD_RECOVERY:-false}" != true ] || exit 9
    printf '%s\n' '{"state":{"journal":{"phase":"idle","active":{"slot":"blue"}},"lastError":"Interrupted update recovered from durable journal","paused":false,"installed":{"image":"ghcr.io/yohn-jp/codexia-backend@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},"previous":{"image":"ghcr.io/yohn-jp/codexia-backend@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"},"failedImages":[]},"observed":{"writers":[{"slot":"blue","image":"ghcr.io/yohn-jp/codexia-backend@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}],"route":"blue"}}'
    ;;
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
    selected="${CODEXIA_LIFECYCLE_STAGE:-}"
    if [ -n "${CODEXIA_LIFECYCLE_OPERATION_FILE:-}" ] && [ -f "$CODEXIA_LIFECYCLE_OPERATION_FILE" ]; then
      selected="$(cat -- "$CODEXIA_LIFECYCLE_OPERATION_FILE")"
    fi
    case "$selected" in
      pause|enable) paused=true; slot=blue; image=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa ;;
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
    printf '{"state":{"journal":{"phase":"idle","active":{"slot":"%s"}},"lastError":null,"paused":%s,"installed":{"image":"ghcr.io/yohn-jp/codexia-backend@sha256:%s","version":"1.2.3","profile":"core","apiEpoch":1},"previous":{"image":"ghcr.io/yohn-jp/codexia-backend@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},"failedImages":%s},"observed":{"writers":[{"slot":"%s","image":"ghcr.io/yohn-jp/codexia-backend@sha256:%s"}],"route":"%s"}}\n' "$slot" "$paused" "$image" "$failed_images" "$slot" "$image" "$slot"
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

## Rotation must stop before inspecting or staging protected files without approval,
## and check mode must never authorize a real password mutation.
for mode in unapproved check-mode; do
  log="$tmp/rotate-app-password-$mode.log"
  if [[ "$mode" == unapproved ]]; then
    if ansible-playbook -i localhost, -c local "$root/deploy/ansible/test-app-password-rotation-gate.yml" > "$log" 2>&1; then
      cat "$log" >&2
      echo 'App-password rotation unexpectedly passed without explicit approval' >&2
      exit 1
    fi
    grep -Fq 'PostgreSQL app password rotation requires an initialized controller, verified backup and restore receipt, and explicit approval.' "$log"
  else
    if ansible-playbook --check -i localhost, -c local "$root/deploy/ansible/test-app-password-rotation-gate.yml" \
      -e codexia_app_password_rotation_approved=true > "$log" 2>&1; then
      cat "$log" >&2
      echo 'App-password rotation unexpectedly passed in check mode' >&2
      exit 1
    fi
    grep -Fq 'PostgreSQL app password rotation requires an initialized controller, verified backup and restore receipt, and explicit approval.' "$log"
  fi
done

## Preflight-password rotation requires its own explicit approval.
for mode in unapproved check-mode; do
  log="$tmp/rotate-preflight-password-$mode.log"
  if [[ "$mode" == unapproved ]]; then
    if ansible-playbook -i localhost, -c local "$root/deploy/ansible/test-preflight-password-rotation-gate.yml" > "$log" 2>&1; then
      cat "$log" >&2
      echo 'Preflight-password rotation unexpectedly passed without explicit approval' >&2
      exit 1
    fi
  else
    if ansible-playbook --check -i localhost, -c local "$root/deploy/ansible/test-preflight-password-rotation-gate.yml" \
      -e codexia_preflight_password_rotation_approved=true > "$log" 2>&1; then
      cat "$log" >&2
      echo 'Preflight-password rotation unexpectedly passed in check mode' >&2
      exit 1
    fi
  fi
  grep -Fq 'PostgreSQL preflight-password rotation requires an initialized controller, verified backup and restore receipt, and explicit approval.' "$log"
done

preflight_rotation_password='abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789'
preflight_rotation_file="$tmp/preflight-password"
preflight_restore_receipt="$tmp/preflight-restore-receipt.json"
printf '%s' "$preflight_rotation_password" > "$preflight_rotation_file"
printf '%s\n' '{"format":"codexia-restore-receipt/v1"}' > "$preflight_restore_receipt"
chmod 0600 "$preflight_rotation_file" "$preflight_restore_receipt"
CODEXIA_TEST_PREFLIGHT_PASSWORD_FILE="$preflight_rotation_file" CODEXIA_TEST_PREFLIGHT_RESTORE_RECEIPT_FILE="$preflight_restore_receipt" \
  ansible-playbook -i localhost, -c local "$root/deploy/ansible/test-preflight-password-rotation-inputs.yml" > "$tmp/preflight-rotation-valid-no-lf.log" 2>&1 || {
    cat "$tmp/preflight-rotation-valid-no-lf.log" >&2
    echo 'Valid protected preflight-password input without LF was rejected' >&2
    exit 1
  }
printf '%s\n' "$preflight_rotation_password" > "$preflight_rotation_file"
CODEXIA_TEST_PREFLIGHT_PASSWORD_FILE="$preflight_rotation_file" CODEXIA_TEST_PREFLIGHT_RESTORE_RECEIPT_FILE="$preflight_restore_receipt" \
  ansible-playbook -i localhost, -c local "$root/deploy/ansible/test-preflight-password-rotation-inputs.yml" > "$tmp/preflight-rotation-valid-lf.log" 2>&1 || {
    cat "$tmp/preflight-rotation-valid-lf.log" >&2
    echo 'Valid protected preflight-password input with final LF was rejected' >&2
    exit 1
  }
chmod 0644 "$preflight_rotation_file"
if CODEXIA_TEST_PREFLIGHT_PASSWORD_FILE="$preflight_rotation_file" CODEXIA_TEST_PREFLIGHT_RESTORE_RECEIPT_FILE="$preflight_restore_receipt" \
  ansible-playbook -i localhost, -c local "$root/deploy/ansible/test-preflight-password-rotation-inputs.yml" > "$tmp/preflight-rotation-mode.log" 2>&1; then
  cat "$tmp/preflight-rotation-mode.log" >&2
  echo 'Unprotected preflight-password file was accepted' >&2
  exit 1
fi
! grep -Fq "$preflight_rotation_password" "$tmp/preflight-rotation-mode.log"

rotation_password='0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
rotation_password_file="$tmp/app-password"
rotation_receipt_file="$tmp/restore-receipt.json"
printf '%s\n' "$rotation_password" > "$rotation_password_file"
printf '%s\n' '{"format":"codexia-restore-receipt/v1"}' > "$rotation_receipt_file"
chmod 0600 "$rotation_password_file" "$rotation_receipt_file"
CODEXIA_TEST_APP_PASSWORD_FILE="$rotation_password_file" CODEXIA_TEST_RESTORE_RECEIPT_FILE="$rotation_receipt_file" \
  ansible-playbook -i localhost, -c local "$root/deploy/ansible/test-app-password-rotation.yml" > "$tmp/rotate-app-password-valid.log" 2>&1 || {
    cat "$tmp/rotate-app-password-valid.log" >&2
    echo 'Valid protected app-password inputs were rejected' >&2
    exit 1
  }
chmod 0644 "$rotation_password_file"
if CODEXIA_TEST_APP_PASSWORD_FILE="$rotation_password_file" CODEXIA_TEST_RESTORE_RECEIPT_FILE="$rotation_receipt_file" \
  ansible-playbook -i localhost, -c local "$root/deploy/ansible/test-app-password-rotation.yml" > "$tmp/rotate-app-password-mode.log" 2>&1; then
  cat "$tmp/rotate-app-password-mode.log" >&2
  echo 'Unprotected app-password file was accepted' >&2
  exit 1
fi
! grep -Fq "$rotation_password" "$tmp/rotate-app-password-mode.log"
chmod 0600 "$rotation_password_file"
mv "$rotation_receipt_file" "$tmp/restore-receipt-target.json"
ln -s "$tmp/restore-receipt-target.json" "$rotation_receipt_file"
if CODEXIA_TEST_APP_PASSWORD_FILE="$rotation_password_file" CODEXIA_TEST_RESTORE_RECEIPT_FILE="$rotation_receipt_file" \
  ansible-playbook -i localhost, -c local "$root/deploy/ansible/test-app-password-rotation.yml" > "$tmp/rotate-app-password-symlink.log" 2>&1; then
  cat "$tmp/rotate-app-password-symlink.log" >&2
  echo 'Symlinked restore receipt was accepted' >&2
  exit 1
fi
! grep -Fq "$rotation_password" "$tmp/rotate-app-password-symlink.log"

## API token rotation requires operator approval and a protected, non-symlink token input.
for mode in unapproved check-mode; do
  log="$tmp/rotate-api-token-$mode.log"
  if [[ "$mode" == unapproved ]]; then
    if ansible-playbook -i localhost, -c local "$root/deploy/ansible/test-api-auth-token-rotation.yml" > "$log" 2>&1; then
      cat "$log" >&2
      echo 'API token rotation unexpectedly passed without explicit approval' >&2
      exit 1
    fi
  else
    if ansible-playbook --check -i localhost, -c local "$root/deploy/ansible/test-api-auth-token-rotation.yml" \
      -e codexia_api_auth_token_rotation_approved=true > "$log" 2>&1; then
      cat "$log" >&2
      echo 'API token rotation unexpectedly passed in check mode' >&2
      exit 1
    fi
  fi
  grep -Fq 'API token rotation requires an initialized reviewed controller, a paused writer, and explicit approval.' "$log"
done

api_token='fixture-standalone-api-token-0123456789'
api_token_file="$tmp/api-auth-token"
printf '%s' "$api_token" > "$api_token_file"
chmod 0600 "$api_token_file"
CODEXIA_TEST_API_AUTH_TOKEN_FILE="$api_token_file" ansible-playbook -i localhost, -c local \
  "$root/deploy/ansible/test-api-auth-token-rotation-inputs.yml" > "$tmp/rotate-api-token-valid.log" 2>&1 || {
    cat "$tmp/rotate-api-token-valid.log" >&2
    echo 'Valid protected API token input was rejected' >&2
    exit 1
  }
chmod 0644 "$api_token_file"
if CODEXIA_TEST_API_AUTH_TOKEN_FILE="$api_token_file" ansible-playbook -i localhost, -c local \
  "$root/deploy/ansible/test-api-auth-token-rotation-inputs.yml" > "$tmp/rotate-api-token-mode.log" 2>&1; then
  cat "$tmp/rotate-api-token-mode.log" >&2
  echo 'Unprotected API token input was accepted' >&2
  exit 1
fi
! grep -Fq "$api_token" "$tmp/rotate-api-token-mode.log"
chmod 0600 "$api_token_file"
mv "$api_token_file" "$tmp/api-auth-token-target"
ln -s "$tmp/api-auth-token-target" "$api_token_file"
if CODEXIA_TEST_API_AUTH_TOKEN_FILE="$api_token_file" ansible-playbook -i localhost, -c local \
  "$root/deploy/ansible/test-api-auth-token-rotation-inputs.yml" > "$tmp/rotate-api-token-symlink.log" 2>&1; then
  cat "$tmp/rotate-api-token-symlink.log" >&2
  echo 'Symlinked API token input was accepted' >&2
  exit 1
fi
! grep -Fq "$api_token" "$tmp/rotate-api-token-symlink.log"

## Tunnel token rotation requires approval and a protected control-node input.
for mode in unapproved check-mode; do
  log="$tmp/rotate-tunnel-token-$mode.log"
  if [[ "$mode" == unapproved ]]; then
    if ansible-playbook -i localhost, -c local "$root/deploy/ansible/test-tunnel-token-rotation-gate.yml" > "$log" 2>&1; then
      cat "$log" >&2
      echo 'Tunnel token rotation unexpectedly passed without explicit approval' >&2
      exit 1
    fi
  else
    if ansible-playbook --check -i localhost, -c local "$root/deploy/ansible/test-tunnel-token-rotation-gate.yml" \
      -e codexia_tunnel_token_rotation_approved=true > "$log" 2>&1; then
      cat "$log" >&2
      echo 'Tunnel token rotation unexpectedly passed in check mode' >&2
      exit 1
    fi
  fi
  grep -Fq 'Tunnel token rotation requires an initialized reviewed runtime, a protected replacement token, and explicit approval.' "$log"
done

tunnel_token='fixture-tunnel-token-rotation-1234567890'
tunnel_token_file="$tmp/tunnel-token"
printf '%s' "$tunnel_token" > "$tunnel_token_file"
chmod 0600 "$tunnel_token_file"
CODEXIA_TEST_TUNNEL_TOKEN_FILE="$tunnel_token_file" ansible-playbook -i localhost, -c local \
  "$root/deploy/ansible/test-tunnel-token-rotation-inputs.yml" > "$tmp/rotate-tunnel-token-valid.log" 2>&1 || {
    cat "$tmp/rotate-tunnel-token-valid.log" >&2
    echo 'Valid protected Tunnel token input was rejected' >&2
    exit 1
  }
chmod 0644 "$tunnel_token_file"
if CODEXIA_TEST_TUNNEL_TOKEN_FILE="$tunnel_token_file" ansible-playbook -i localhost, -c local \
  "$root/deploy/ansible/test-tunnel-token-rotation-inputs.yml" > "$tmp/rotate-tunnel-token-mode.log" 2>&1; then
  cat "$tmp/rotate-tunnel-token-mode.log" >&2
  echo 'Unprotected Tunnel token input was accepted' >&2
  exit 1
fi
! grep -Fq "$tunnel_token" "$tmp/rotate-tunnel-token-mode.log"
chmod 0600 "$tunnel_token_file"
mv "$tunnel_token_file" "$tmp/tunnel-token-target"
ln -s "$tmp/tunnel-token-target" "$tunnel_token_file"
if CODEXIA_TEST_TUNNEL_TOKEN_FILE="$tunnel_token_file" ansible-playbook -i localhost, -c local \
  "$root/deploy/ansible/test-tunnel-token-rotation-inputs.yml" > "$tmp/rotate-tunnel-token-symlink.log" 2>&1; then
  cat "$tmp/rotate-tunnel-token-symlink.log" >&2
  echo 'Symlinked Tunnel token input was accepted' >&2
  exit 1
fi
! grep -Fq "$tunnel_token" "$tmp/rotate-tunnel-token-symlink.log"

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

# Explicit resume may clear only the supported recovered-update error after a
# locked read-only check of the exact writer and route. This exercises the real
# site dispatcher and verify-resume task with disposable command fixtures.
cp "$root/deploy/ansible/verify.yml" "$tmp/site/"
for task_file in verify-updater-inputs.yml verify-updater-units.yml verify-timer.yml; do
  printf '%s\n' '---' '- ansible.builtin.debug:' '    msg: "isolated contract stub"' > "$tmp/site/$task_file"
done
recovery_operation="$tmp/site-resume-recovered.operation"
CODEXIA_LIFECYCLE_STAGE=resume CODEXIA_LIFECYCLE_CONFIG_ENABLED=false CODEXIA_LIFECYCLE_PAUSED=true \
  CODEXIA_LIFECYCLE_TIMER_STATE=inactive CODEXIA_LIFECYCLE_RECOVERY_ERROR='Interrupted update recovered from durable journal' \
  CODEXIA_LIFECYCLE_FAKE_UPDATER="$tmp/bin/codexia-lifecycle-updater" CODEXIA_LIFECYCLE_OPERATION_FILE="$recovery_operation" PATH="$tmp/bin:$PATH" \
  ansible-playbook -i 'codexia,' -c local "$tmp/site/site.yml" \
    -e codexia_stage=resume -e codexia_maintenance_approved=true -e "state_dir=$tmp/site-state" \
    -e 'codexia_frontend_origin=https://fixture.invalid' -e "codexia_proxy_image=ghcr.io/yohn-jp/codexia-backend@sha256:$(printf '%064d' 0)" \
    -e '{"codexia_browser_auth":{"mode":"token"},"codexia_runtime":{"format":"codexia-runtime/v1","profile":"core","modelCachePath":null,"tmpfs":{"tempSize":"64m","moduleCacheSize":"1g"},"resources":{"memoryMaxBytes":null,"cpuQuotaPercent":null}}}' \
    -e "updater=$tmp/bin/codexia-lifecycle-updater" -e 'config_path=/tmp/codexia-lifecycle-test-config.json' \
    > "$tmp/site-resume-recovered.log" 2>&1 || { cat "$tmp/site-resume-recovered.log" >&2; exit 1; }
[[ "$(cat "$recovery_operation")" == resume ]]
rejected_operation="$tmp/site-resume-rejected.operation"
if CODEXIA_LIFECYCLE_STAGE=resume CODEXIA_LIFECYCLE_CONFIG_ENABLED=false CODEXIA_LIFECYCLE_PAUSED=true \
  CODEXIA_LIFECYCLE_TIMER_STATE=inactive CODEXIA_LIFECYCLE_RECOVERY_ERROR='Interrupted update recovered from durable journal' CODEXIA_LIFECYCLE_BAD_RECOVERY=true \
  CODEXIA_LIFECYCLE_FAKE_UPDATER="$tmp/bin/codexia-lifecycle-updater" CODEXIA_LIFECYCLE_OPERATION_FILE="$rejected_operation" PATH="$tmp/bin:$PATH" \
  ansible-playbook -i 'codexia,' -c local "$tmp/site/site.yml" \
    -e codexia_stage=resume -e codexia_maintenance_approved=true -e "state_dir=$tmp/site-state" \
    -e 'codexia_frontend_origin=https://fixture.invalid' -e "codexia_proxy_image=ghcr.io/yohn-jp/codexia-backend@sha256:$(printf '%064d' 0)" \
    -e '{"codexia_browser_auth":{"mode":"token"},"codexia_runtime":{"format":"codexia-runtime/v1","profile":"core","modelCachePath":null,"tmpfs":{"tempSize":"64m","moduleCacheSize":"1g"},"resources":{"memoryMaxBytes":null,"cpuQuotaPercent":null}}}' \
    -e "updater=$tmp/bin/codexia-lifecycle-updater" -e 'config_path=/tmp/codexia-lifecycle-test-config.json' \
    > "$tmp/site-resume-rejected.log" 2>&1; then
  cat "$tmp/site-resume-rejected.log" >&2
  echo 'Unsupported resume recovery state unexpectedly passed' >&2
  exit 1
fi
[[ ! -e "$rejected_operation" ]]

# Exercise the real enable task from the site stage. The fixture starts with an
# enabled controller config and an inactive, disabled timer to model a crash
# after the config write. Its identity endpoint and systemctl shim are local.
cp "$root/deploy/ansible/enable.yml" "$tmp/site/"
cp "$root/deploy/ansible/verify-timer.yml" "$tmp/site/"
enabled_config="$tmp/enable-config.json"
printf '{"enabled":true}\n' > "$enabled_config"
chmod 0600 "$enabled_config"
cat > "$tmp/site/verify-updater-inputs.yml" <<YAML
---
- ansible.builtin.slurp:
    src: "$enabled_config"
  register: saved_config
YAML
mkdir -p "$tmp/api" "$tmp/enable-bin"
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -keyout "$tmp/api/key.pem" -out "$tmp/api/cert.pem" \
  -subj '/CN=127.0.0.1' -addext 'subjectAltName=IP:127.0.0.1' > /dev/null 2>&1
cat > "$tmp/api/server.py" <<'PY'
from http.server import BaseHTTPRequestHandler, HTTPServer
import json, os, ssl
class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        version_file = os.environ.get("CODEXIA_FIXTURE_API_VERSION_FILE")
        version = open(version_file).read().strip() if version_file and os.path.exists(version_file) else "1.2.3"
        body = {"name": "codexia", "version": version, "profile": "core", "apiEpoch": 1, "browserAuth": "token"}
        payload = json.dumps(body).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)
    def log_message(self, *args): pass
server = HTTPServer(("127.0.0.1", 0), Handler)
context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
context.load_cert_chain(os.environ["CODEXIA_FIXTURE_CERT"], os.environ["CODEXIA_FIXTURE_KEY"])
server.socket = context.wrap_socket(server.socket, server_side=True)
with open(os.environ["CODEXIA_FIXTURE_PORT_FILE"], "w") as port_file:
    port_file.write(str(server.server_port))
server.serve_forever()
PY
CODEXIA_FIXTURE_PORT_FILE="$tmp/api/port" CODEXIA_FIXTURE_API_VERSION_FILE="$tmp/api/version" CODEXIA_FIXTURE_CERT="$tmp/api/cert.pem" CODEXIA_FIXTURE_KEY="$tmp/api/key.pem" \
  python3 "$tmp/api/server.py" > "$tmp/api/server.log" 2>&1 &
api_pid=$!
for attempt in {1..50}; do [[ -s "$tmp/api/port" ]] && break; sleep 0.1; done
[[ -s "$tmp/api/port" ]] || { cat "$tmp/api/server.log" >&2; exit 1; }
api_port="$(cat "$tmp/api/port")"
cat > "$tmp/enable-bin/systemctl" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
state_file="${CODEXIA_ENABLE_TIMER_STATE_FILE:?}"
read_state() { mapfile -t values < "$state_file"; }
write_state() { printf '%s\n%s\n' "$1" "$2" > "$state_file"; }
if [[ "$*" == '--user show --property=Version' ]]; then echo 'Version=259'; exit 0; fi
read_state
case "${2:-}" in
  show)
    printf 'LoadState=loaded\nActiveState=%s\nUnitFileState=%s\n' "${values[1]}" "${values[0]}"
    ;;
  is-active)
    echo "${values[1]}"
    [[ "${values[1]}" == active ]] && exit 0 || exit 3
    ;;
  is-enabled)
    echo "${values[0]}"
    [[ "${values[0]}" == enabled ]] && exit 0 || exit 1
    ;;
  enable) write_state enabled "${values[1]}" ;;
  start) write_state "${values[0]}" active ;;
  *) echo "unexpected systemctl fixture invocation: $*" >&2; exit 99 ;;
esac
SH
chmod 0700 "$tmp/enable-bin/systemctl"
printf 'disabled\ninactive\n' > "$tmp/timer-state"
printf '1.2.3\n' > "$tmp/api/version"
printf 'fixture-access-id\n' > "$tmp/access-id"
printf 'fixture-access-secret\n' > "$tmp/access-secret"
chmod 0600 "$tmp/access-id" "$tmp/access-secret"
enable_operation="$tmp/enable.operation"
CODEXIA_LIFECYCLE_STAGE=enable CODEXIA_LIFECYCLE_CONFIG_ENABLED=true CODEXIA_LIFECYCLE_PAUSED=true \
  CODEXIA_LIFECYCLE_TIMER_STATE=inactive CODEXIA_LIFECYCLE_FAKE_UPDATER="$tmp/bin/codexia-lifecycle-updater" \
  CODEXIA_LIFECYCLE_OPERATION_FILE="$enable_operation" CODEXIA_ENABLE_TIMER_STATE_FILE="$tmp/timer-state" \
  SSL_CERT_FILE="$tmp/api/cert.pem" PATH="$tmp/enable-bin:$tmp/bin:$PATH" \
  ansible-playbook -i 'codexia,' -c local "$tmp/site/site.yml" \
    -e codexia_stage=enable -e codexia_acceptance_approved=true \
    -e codexia_frontend_origin="https://127.0.0.1:$api_port" -e "codexia_proxy_image=ghcr.io/yohn-jp/codexia-backend@sha256:$(printf '%064d' 0)" \
    -e '{"codexia_browser_auth":{"mode":"token"},"codexia_runtime":{"format":"codexia-runtime/v1","profile":"core","modelCachePath":null,"tmpfs":{"tempSize":"64m","moduleCacheSize":"1g"},"resources":{"memoryMaxBytes":null,"cpuQuotaPercent":null}}}' \
    -e "state_dir=$tmp/site-state" -e "updater=$tmp/bin/codexia-lifecycle-updater" \
    -e "config_path=$enabled_config" -e "codexia_access_id_file=$tmp/access-id" -e "codexia_access_secret_file=$tmp/access-secret" \
    -e "repo_root=$root" > "$tmp/site-enable.log" 2>&1 || { cat "$tmp/site-enable.log" >&2; exit 1; }
[[ "$(cat "$enable_operation")" == resume ]]
[[ "$(sed -n '1p' "$tmp/timer-state")" == enabled && "$(sed -n '2p' "$tmp/timer-state")" == active ]]
python3 - "$enabled_config" <<'PY'
import json, sys
with open(sys.argv[1]) as f:
    assert json.load(f)["enabled"] is True
PY
# Missing acceptance approval fails before the updater or timer is changed.
printf 'disabled\ninactive\n' > "$tmp/timer-state"
unapproved_operation="$tmp/enable-unapproved.operation"
if CODEXIA_LIFECYCLE_STAGE=enable CODEXIA_LIFECYCLE_CONFIG_ENABLED=true CODEXIA_LIFECYCLE_PAUSED=true \
  CODEXIA_LIFECYCLE_TIMER_STATE=inactive CODEXIA_LIFECYCLE_FAKE_UPDATER="$tmp/bin/codexia-lifecycle-updater" \
  CODEXIA_LIFECYCLE_OPERATION_FILE="$unapproved_operation" CODEXIA_ENABLE_TIMER_STATE_FILE="$tmp/timer-state" \
  SSL_CERT_FILE="$tmp/api/cert.pem" PATH="$tmp/enable-bin:$tmp/bin:$PATH" \
  ansible-playbook -i 'codexia,' -c local "$tmp/site/site.yml" \
    -e codexia_stage=enable -e codexia_frontend_origin="https://127.0.0.1:$api_port" \
    -e "codexia_proxy_image=ghcr.io/yohn-jp/codexia-backend@sha256:$(printf '%064d' 0)" \
    -e '{"codexia_browser_auth":{"mode":"token"},"codexia_runtime":{"format":"codexia-runtime/v1","profile":"core","modelCachePath":null,"tmpfs":{"tempSize":"64m","moduleCacheSize":"1g"},"resources":{"memoryMaxBytes":null,"cpuQuotaPercent":null}}}' \
    -e "state_dir=$tmp/site-state" -e "updater=$tmp/bin/codexia-lifecycle-updater" \
    -e "config_path=$enabled_config" -e "codexia_access_id_file=$tmp/access-id" -e "codexia_access_secret_file=$tmp/access-secret" \
    -e "repo_root=$root" > "$tmp/site-enable-unapproved.log" 2>&1; then
  cat "$tmp/site-enable-unapproved.log" >&2
  echo 'Enable unexpectedly passed without acceptance approval' >&2
  exit 1
fi
[[ ! -e "$unapproved_operation" ]]
[[ "$(sed -n '1p' "$tmp/timer-state")" == disabled && "$(sed -n '2p' "$tmp/timer-state")" == inactive ]]
# A failed live identity check likewise leaves the forward interruption for
# review instead of starting the timer.
printf '9.9.9\n' > "$tmp/api/version"
identity_operation="$tmp/enable-identity-mismatch.operation"
if CODEXIA_LIFECYCLE_STAGE=enable CODEXIA_LIFECYCLE_CONFIG_ENABLED=true CODEXIA_LIFECYCLE_PAUSED=true \
  CODEXIA_LIFECYCLE_TIMER_STATE=inactive CODEXIA_LIFECYCLE_FAKE_UPDATER="$tmp/bin/codexia-lifecycle-updater" \
  CODEXIA_LIFECYCLE_OPERATION_FILE="$identity_operation" CODEXIA_ENABLE_TIMER_STATE_FILE="$tmp/timer-state" \
  SSL_CERT_FILE="$tmp/api/cert.pem" PATH="$tmp/enable-bin:$tmp/bin:$PATH" \
  ansible-playbook -i 'codexia,' -c local "$tmp/site/site.yml" \
    -e codexia_stage=enable -e codexia_acceptance_approved=true \
    -e codexia_frontend_origin="https://127.0.0.1:$api_port" \
    -e "codexia_proxy_image=ghcr.io/yohn-jp/codexia-backend@sha256:$(printf '%064d' 0)" \
    -e '{"codexia_browser_auth":{"mode":"token"},"codexia_runtime":{"format":"codexia-runtime/v1","profile":"core","modelCachePath":null,"tmpfs":{"tempSize":"64m","moduleCacheSize":"1g"},"resources":{"memoryMaxBytes":null,"cpuQuotaPercent":null}}}' \
    -e "state_dir=$tmp/site-state" -e "updater=$tmp/bin/codexia-lifecycle-updater" \
    -e "config_path=$enabled_config" -e "codexia_access_id_file=$tmp/access-id" -e "codexia_access_secret_file=$tmp/access-secret" \
    -e "repo_root=$root" > "$tmp/site-enable-identity-mismatch.log" 2>&1; then
  cat "$tmp/site-enable-identity-mismatch.log" >&2
  echo 'Enable unexpectedly passed with a mismatched live API identity' >&2
  exit 1
fi
[[ ! -e "$identity_operation" ]]
[[ "$(sed -n '1p' "$tmp/timer-state")" == disabled && "$(sed -n '2p' "$tmp/timer-state")" == inactive ]]
kill "$api_pid"
# Restore is an independent local operation, even if the source is down or not
# present in the inventory. Exercise the real site dispatcher and recovery
# tasks; only the already separately tested Podman/age drill helper is stubbed.
cp "$root/deploy/ansible/restore-drill.yml" "$tmp/site/"
mkdir -p "$tmp/recovery-repo/deploy/updater" "$tmp/recovery-backup"
touch "$tmp/recovery-key"
chmod 0600 "$tmp/recovery-key"
cat > "$tmp/recovery-repo/deploy/updater/standalone-backup.sh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
[[ $# == 4 && "$1" == drill && -d "$2" && -f "$3" && "$4" == --approved ]]
printf 'executed\n' >> "$2/drill-invoked"
printf 'Isolated restore verified: database and history fingerprints match\n'
printf 'Verified checksum manifest sha256: %064d\n' 0
SH
cat > "$tmp/unavailable-source.yml" <<'YAML'
all:
  children:
    codexia:
      hosts:
        unavailable-source:
          ansible_connection: ssh
          ansible_host: 127.0.0.1
          ansible_port: 1
YAML
restore_args=(
  "$tmp/site/site.yml" -e codexia_stage=restore-drill
  -e "repo_root=$tmp/recovery-repo"
  -e "codexia_backup_directory=$tmp/recovery-backup"
  -e "codexia_recovery_identity_file=$tmp/recovery-key"
)
receipt_index=0
for inventory in "$tmp/unavailable-source.yml" 'localhost,'; do
  receipt_index=$((receipt_index+1))
  receipt="$tmp/restore-receipt-$receipt_index.json"
  connection=()
  [[ "$inventory" != 'localhost,' ]] || connection=(-c local)
  ansible-playbook -i "$inventory" "${connection[@]}" "${restore_args[@]}" \
    -e codexia_restore_drill_approved=true -e "codexia_restore_receipt_output_file=$receipt" > "$tmp/restore-dispatch.log" 2>&1 || { cat "$tmp/restore-dispatch.log" >&2; exit 1; }
  [[ "$(stat -c %a "$receipt")" == 600 ]]
  python3 - "$receipt" <<'PY'
import json, sys
with open(sys.argv[1]) as f:
    assert json.load(f) == {"format": "codexia-restore-receipt/v1", "checksumManifestSha256": "0"*64}
PY
done
[[ "$(wc -l < "$tmp/recovery-backup/drill-invoked")" == 2 ]]
for mode in unapproved check; do
  extra=()
  [[ "$mode" != check ]] || extra=(--check -e codexia_restore_drill_approved=true)
  if ansible-playbook -i "$tmp/unavailable-source.yml" "${restore_args[@]}" "${extra[@]}" > "$tmp/restore-$mode.log" 2>&1; then
    echo "Restore dispatcher unexpectedly accepted $mode" >&2
    exit 1
  fi
done
[[ "$(wc -l < "$tmp/recovery-backup/drill-invoked")" == 2 ]]

# The same source/configuration guard used before verify and backup must
# reject drift before invoking an installed updater, even before a journal exists.
guard="$tmp/guard"
mkdir -p "$guard/source/deploy/updater" "$guard/source/scripts" "$guard/quadlet"
for file in deploy/updater/{codexia-updater,standalone-updater.mjs,standalone-host.mjs,standalone-maintenance.mjs,proxy.mjs,provision-preflight-role.sql,standalone-backup.sh} scripts/{standalone-update-controller.mjs,standalone-schema-maintenance.mjs,update-host-state.mjs,update-channel.mjs,update-release-policy.mjs}; do
  install -m 0600 "$root/$file" "$guard/source/$file"
done
printf 'fixture proxy\n' > "$guard/quadlet/codexia-api-proxy.container"
printf '{"enabled":false}\n' > "$guard/config.json"
cat > "$guard/guard.yml" <<YAML
---
- hosts: localhost
  connection: local
  gather_facts: false
  vars:
    repo_root: "$root"
    source_dir: "$guard/source"
    quadlet_dir: "$guard/quadlet"
    config_path: "$guard/config.json"
    desired_proxy_quadlet: "fixture proxy\\n"
    desired_config: {enabled: false}
  tasks:
    - ansible.builtin.include_tasks: "$root/deploy/ansible/verify-updater-inputs.yml"
YAML
ansible-playbook -i localhost, "$guard/guard.yml" > "$guard/valid.log" || { cat "$guard/valid.log"; exit 1; }
printf '# drift\n' >> "$guard/source/deploy/updater/codexia-updater"
if ansible-playbook -i localhost, "$guard/guard.yml" > "$guard/drift.log" 2>&1; then
  echo 'Drifted updater source was accepted' >&2
  exit 1
fi
grep -q 'Installed updater source differs from the reviewed repository' "$guard/drift.log"
echo 'Ansible lifecycle stage contract checks passed'
