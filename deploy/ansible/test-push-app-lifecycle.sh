#!/usr/bin/env bash
# Real app lifecycle acceptance on an isolated Ubuntu 26.04 GitHub-hosted runner.
set -Eeuo pipefail
umask 077
repo_root=$(git rev-parse --show-toplevel)
report=${CODEXIA_LIFECYCLE_REPORT_FILE:?}
evidence=${CODEXIA_LIFECYCLE_EVIDENCE_FILE:?}
source_sha=${CODEXIA_LIFECYCLE_SOURCE_SHA:?}
tmp=$(mktemp -d "$RUNNER_TEMP/codexia-lifecycle.XXXXXX")
fixture_user=codexia
fixture_uid=22001
fixture_gid=22001
fixture_home=/home/codexia
manager_dropin_dir="/run/systemd/system/user@${fixture_uid}.service.d"
manager_dropin="$manager_dropin_dir/10-codexia-lifecycle-ci.conf"
environment_generator_dir=/run/systemd/user-environment-generators
environment_generator="$environment_generator_dir/99-codexia-lifecycle-xdg-$fixture_uid"
environment_generator_dir_created=false
environment_generator_installed=false
fixture_ip=''
backup_mounted=false
build_context=''
fixture_image=''
manager_configured=false
registry_configured=false
user_created=false
system_config_created=false
runtime_ready=false
cleanup_status=0
declare -A mitogen_traversal_paths=()

# Mitogen's local become needs directory traversal but not content access.
# This is restricted to the disposable numeric UID and runner-owned directories.
grant_mitogen_traversal() {
  [[ "${ANSIBLE_STRATEGY:-}" == mitogen_linear ]] || {
    echo 'Lifecycle CI must use the pinned mitogen_linear strategy' >&2
    exit 1
  }
  local dir
  for dir in "$repo_root/deploy/ansible" "$tmp"; do
    while [[ "$dir" != /home && "$dir" != / ]]; do
      if [[ -d "$dir" && -O "$dir" && ! -L "$dir" && ! -v mitogen_traversal_paths["$dir"] ]]; then
        sudo setfacl -m "u:$fixture_uid:--x" "$dir"
        mitogen_traversal_paths["$dir"]=1
      fi
      dir=${dir%/*}
      [[ -n "$dir" ]] || dir=/
    done
  done
}

set_state() {
  node - "$report" "$1" "$2" "${3:-}" <<'NODE'
const fs=require('node:fs');
const [path,key,status,detail]=process.argv.slice(2);
const value=JSON.parse(fs.readFileSync(path,'utf8'));
value.states[key]={status,...(detail?{detail}:{}),updatedAt:new Date().toISOString()};
value.updatedAt=new Date().toISOString();
fs.writeFileSync(path,JSON.stringify(value,null,2)+'\n',{mode:0o600});
NODE
}
mark_fixture_unavailable() {
  local reason=$1 key
  for key in first_activation same_digest_reapply compatible_update failed_candidate_rollback \
    durable_interruption_recovery database_volume_writer_quadlet_release_continuity backup_remote_filesystem \
    better_auth_activation better_auth_same_digest better_auth_compatible_update better_auth_rollback; do
    set_state "$key" CAPABILITY_UNAVAILABLE "$reason"
  done
  set_state fixture_cleanup PASS 'no remaining fixture resources required cleanup'
}
append_observation() {
  node - "$report" "$1" "$2" <<'NODE'
const fs=require('node:fs');
const [path,key,json]=process.argv.slice(2);
const value=JSON.parse(fs.readFileSync(path,'utf8'));
value.observations ||= {};
(value.observations[key] ||= []).push(JSON.parse(json));
value.updatedAt=new Date().toISOString();
fs.writeFileSync(path,JSON.stringify(value,null,2)+'\n',{mode:0o600});
NODE
}
record_phase_timing() {
  local key=$1 started=$2 duration
  duration=$(( $(date +%s%3N) - started ))
  node - "$report" "$key" "$duration" <<'PHASE'
const fs=require('node:fs');const [p,key,ms]=process.argv.slice(2);
const r=JSON.parse(fs.readFileSync(p,'utf8'));
r.timings ||= {};r.timings.phases ||= {};
r.timings.phases[key]={durationMs:Number(ms)};
fs.writeFileSync(p,JSON.stringify(r,null,2)+'\n',{mode:0o600});
PHASE
  echo "LIFECYCLE_TIMING ${key}=${duration}ms"
}
redact_log() {
  local source=$1 target=$2
  sed -E \
    -e 's/(Bearer )[A-Za-z0-9._~-]+/\1[REDACTED]/g' \
    -e 's/(fixture-(auth|tunnel)-token-)[A-Za-z0-9]+/\1[REDACTED]/g' \
    -e 's#((postgres(ql)?|mysql|redis)://[^:/@]+:)[^@/[:space:]]+@#\1[REDACTED]@#Ig' \
    -e 's/((password|token)(_file)?[=: ]+)[^[:space:]]+/\1[REDACTED]/Ig' \
    "$source" | tail -n 400 > "$target"
}
capture_failure_runtime() {
  local context="$tmp/runtime-failure.log" unit name
  {
    printf 'Rootless systemd unit state\n'
    for unit in codexia-api.service codexia-db.service codexia-tunnel.service; do
      printf 'UNIT=%s\n' "$unit"
      rootless_systemctl show --no-pager --property=LoadState,ActiveState,SubState,Result,ExecMainCode,ExecMainStatus "$unit" 2>&1 || true
    done
    printf '\nRootless container state\n'
    rootless_podman ps --all --format '{{.Names}} {{.Status}} {{.Image}}' 2>&1 || true
    for name in codexia-api codexia-db codexia-backup-sshfs codexia-lifecycle-registry; do
      if rootless_podman container exists "$name" >/dev/null 2>&1; then
        printf '\nContainer log tail: %s\n' "$name"
        rootless_podman logs --tail 60 "$name" 2>&1 || true
      fi
    done
    printf '\nRecent rootless service warnings and errors\n'
    rootless journalctl --user --no-pager --since='5 minutes ago' --priority=warning \
      -u codexia-api.service -u codexia-db.service -u codexia-tunnel.service 2>&1 || true
    printf '\nBackup mount state\n'
    rootless findmnt -T "$fixture_home/.local/state/codexia-backup-mount" -n -o FSTYPE,SOURCE 2>&1 || true
    rootless find "$fixture_home/.local/state/codexia-backup-mount" -mindepth 1 -maxdepth 2 -printf '%P %y\n' 2>&1 || true
  } > "$context" 2>&1
  redact_log "$context" "$RUNNER_TEMP/codexia-push-app-lifecycle/runtime-failure-bounded.log"
}
cleanup_failed() {
  cleanup_status=1
  printf 'Cleanup check failed at script line %s: %s\n' "$1" "${2:-unspecified check}" >> "$tmp/cleanup-errors.log"
}
record_failure() {
  local status=$1 line=$2 command=$3 latest_log='' log
  trap - ERR
  [[ -n "$command" ]] || command='unknown command'
  node - "$report" "$status" "$line" "$command" <<'FAILURE'
const fs=require('node:fs');const [path,status,line,command]=process.argv.slice(2);const r=JSON.parse(fs.readFileSync(path,'utf8'));r.failure={exitCode:Number(status),line:Number(line),command:command.replace(/(Bearer\s+)[A-Za-z0-9._~-]+/giu,'$1[REDACTED]').replace(/((password|token)(_file)?[=: ]+)[^\s]+/giu,'$1[REDACTED]').replace(/(fixture-(auth|tunnel)-token-)[A-Za-z0-9]+/giu,'$1[REDACTED]').slice(0,500)};r.updatedAt=new Date().toISOString();fs.writeFileSync(path,JSON.stringify(r,null,2)+'\n',{mode:0o600});
FAILURE
  printf 'Lifecycle fixture failed at line %s (exit %s): %s\n' "$line" "$status" \
    "$(node -p 'JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8")).failure.command' "$report")" >&2
  if [[ "$runtime_ready" == true ]]; then capture_failure_runtime; fi
  for log in "$tmp"/*.log; do
    [[ -f "$log" ]] || continue
    if [[ -z "$latest_log" || "$log" -nt "$latest_log" ]]; then latest_log=$log; fi
  done
  if [[ -n "$latest_log" ]]; then
    local bounded="$RUNNER_TEMP/codexia-push-app-lifecycle/failure-bounded.log"
    redact_log "$latest_log" "$bounded"
    printf '%s\n' "Last sanitized fixture log ($latest_log):" >&2
    cat "$bounded" >&2
  fi
  return "$status"
}
run_playbook() {
  local vars=$1 name=$2 status=0
  local -a shared_vars=()
  if [[ -n ${3:-} ]]; then shared_vars=(--extra-vars "@$3"); fi
  local started_ms elapsed_ms
  started_ms=$(date +%s%3N)
  ANSIBLE_LOCAL_TEMP="$tmp/ansible-local" "$ANSIBLE_PLAYBOOK" -i "$tmp/inventory.yml" \
    "$repo_root/deploy/ansible/site.yml" "${shared_vars[@]}" --extra-vars "@$vars" >"$tmp/$name.log" 2>&1 || status=$?
  elapsed_ms=$(( $(date +%s%3N) - started_ms ))
  echo "LIFECYCLE_ANSIBLE_TIMING stage=$name duration_ms=$elapsed_ms status=$status"
  redact_log "$tmp/$name.log" "$RUNNER_TEMP/codexia-push-app-lifecycle/$name-bounded.log"
  return "$status"
}
rootless() {
  sudo -u "$fixture_user" env HOME="$fixture_home" XDG_CONFIG_HOME="$fixture_home/.config" \
    XDG_DATA_HOME="$fixture_home/.local/share" XDG_STATE_HOME="$fixture_home/.local/state" \
    XDG_RUNTIME_DIR="/run/user/$fixture_uid" DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$fixture_uid/bus" \
    /bin/bash -c 'cd "$HOME" && exec "$@"' bash "$@"
}
rootless_podman() { rootless /usr/bin/podman "$@"; }
rootless_systemctl() { rootless /usr/bin/systemctl --user "$@"; }
run_deploy() {
  local key=$1 approvals=${2:-false} fault_path=${3:-}
  local log_name=${4:-deploy-$key-$RANDOM}
  if rootless_podman container exists codexia-api; then
    backup_fixture_attempt "$key" "${5:-}"
  fi
  cat > "$tmp/deploy-vars.yml" <<YAML
codexia_stage: deploy-lifecycle-fixture
codexia_service_user: codexia
codexia_service_uid: $fixture_uid
codexia_service_home: /home/codexia
codexia_lifecycle_verification_file: "$evidence"
codexia_lifecycle_candidate_key: "$key"
codexia_initial_install_approved: $approvals
codexia_database_initialization_approved: $approvals
$(if [[ -n "$fault_path" ]]; then printf 'codexia_lifecycle_fault_path: "%s"\n' "$fault_path"; fi)
YAML
  local begin_ms elapsed_ms status=0
  begin_ms=$(date +%s%3N)
  run_playbook "$tmp/deploy-vars.yml" "$log_name" || status=$?
  elapsed_ms=$(( $(date +%s%3N) - begin_ms ))
  node - "$report" "$log_name" "$elapsed_ms" "$status" <<'TIMING'
const fs=require('node:fs');const [p,label,ms,exit]=process.argv.slice(2);const r=JSON.parse(fs.readFileSync(p,'utf8'));
r.timings ||= {}; (r.timings.ansible ||= []).push({label,durationMs:Number(ms),exitCode:Number(exit)});
fs.writeFileSync(p,JSON.stringify(r,null,2)+'\n',{mode:0o600});
TIMING
  return "$status"
}
observe_runtime() {
  local key=$1 role=$2
  local container_id image_id api_health api_unit quadlet_sha release_sha pg_volume pg_mount pg_created data_volume data_mount data_created history_volume history_mount history_created db_container api_count sentinel
  container_id=$(rootless_podman inspect --format '{{.Id}}' codexia-api)
  image_id=$(rootless_podman inspect --format '{{.Image}}' codexia-api)
  api_health=$(rootless_podman inspect --format '{{.State.Health.Status}}' codexia-api)
  local history_permissions
  history_permissions=$(rootless_podman exec codexia-api stat -c '%u:%g:%a' /history)
  [[ "$history_permissions" == '1000:1000:700' ]] || {
    echo "The mounted API history directory has unexpected owner, group or mode: $history_permissions" >&2
    return 1
  }
  api_unit=$(rootless_systemctl show --property=ActiveState --value codexia-api.service)
  quadlet_sha=$(rootless sha256sum "$fixture_home/.config/containers/systemd/codexia-api.container" | cut -d' ' -f1)
  release_sha=$(rootless sha256sum "$fixture_home/.local/state/codexia-deploy/deployed-release.json" | cut -d' ' -f1)
  db_container=$(rootless_podman inspect --format '{{.Id}}' codexia-db)
  pg_volume=$(rootless_podman volume inspect --format '{{.Name}}' codexia-postgres)
  pg_mount=$(rootless_podman volume inspect --format '{{.Mountpoint}}' codexia-postgres)
  pg_created=$(rootless_podman volume inspect --format '{{.CreatedAt}}' codexia-postgres)
  data_volume=$(rootless_podman volume inspect --format '{{.Name}}' codexia-data)
  data_mount=$(rootless_podman volume inspect --format '{{.Mountpoint}}' codexia-data)
  data_created=$(rootless_podman volume inspect --format '{{.CreatedAt}}' codexia-data)
  history_volume=$(rootless_podman volume inspect --format '{{.Name}}' codexia-history)
  history_mount=$(rootless_podman volume inspect --format '{{.Mountpoint}}' codexia-history)
  history_created=$(rootless_podman volume inspect --format '{{.CreatedAt}}' codexia-history)
  api_count=$(rootless_podman ps --filter name=codexia-api --format '{{.ID}}' | wc -l)
  # PostgreSQL resolves relation references before evaluating CASE; an absent
  # sentinel table must be checked without referring to it in the same query.
  sentinel=$(rootless_podman exec codexia-db sh -ec 'export PGPASSWORD="$(cat /run/secrets/admin-password)"; psql -X -qAt -v ON_ERROR_STOP=1 -U codexia_admin -d codexia -c "$1"' sh "SELECT to_regclass('public.codexia_lifecycle_sentinel') IS NOT NULL")
  if [[ "$sentinel" == t ]]; then
    sentinel=$(rootless_podman exec codexia-db sh -ec 'export PGPASSWORD="$(cat /run/secrets/admin-password)"; psql -X -qAt -v ON_ERROR_STOP=1 -U codexia_admin -d codexia -c "$1"' sh "SELECT value FROM codexia_lifecycle_sentinel WHERE id = 1")
  else
    [[ "$sentinel" == f ]] || return 1
    sentinel=not-created
  fi
  rootless_podman exec codexia-api node -e 'fetch("http://127.0.0.1:3000/health/ready").then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))' >/dev/null
  node - "$report" "$key" "$role" "$container_id" "$image_id" "$api_health" "$api_unit" "$quadlet_sha" "$release_sha" "$db_container" \
    "$pg_volume" "$pg_mount" "$pg_created" "$data_volume" "$data_mount" "$data_created" "$history_volume" "$history_mount" "$history_created" "$api_count" "$sentinel" <<'NODE'
const fs=require('node:fs');
const [path,key,role,apiContainer,apiImage,apiHealth,apiUnit,quadletSha,releaseSha,dbContainer,pgVolume,pgMount,pgCreated,dataVolume,dataMount,dataCreated,historyVolume,historyMount,historyCreated,apiCount,sentinel]=process.argv.slice(2);
const report=JSON.parse(fs.readFileSync(path,'utf8'));
const evidence=JSON.parse(fs.readFileSync(process.env.CODEXIA_LIFECYCLE_EVIDENCE_FILE,'utf8'));
const expectedImageId=evidence.candidates[role]?.imageId;
if(apiHealth!=='healthy'||apiUnit!=='active'||Number(apiCount)!==1)throw new Error('The checkpoint requires exactly one healthy active API writer');
if(!expectedImageId||apiImage!==expectedImageId)throw new Error(`${key}: API writer image ID differs from the run-bound ${role} candidate`);
if(sentinel!==(['first-activation','same-digest-reapply'].includes(key)?'not-created':'preserved'))throw new Error(`${key}: PostgreSQL sentinel data was absent or changed`);
report.observations ||= {}; const observations=report.observations.continuity ||= []; const previous=observations.at(-1);
if(previous){
  if(dbContainer!==previous.dbContainer)throw new Error(`${key}: PostgreSQL container identity changed`);
  if(JSON.stringify({postgres:{name:pgVolume,mountpoint:pgMount,createdAt:pgCreated},data:{name:dataVolume,mountpoint:dataMount,createdAt:dataCreated},history:{name:historyVolume,mountpoint:historyMount,createdAt:historyCreated}})!==JSON.stringify(previous.volumes))throw new Error(`${key}: persistent volume identity changed`);
}
if(['same-digest-reapply','better-auth-same-digest'].includes(key)&&(apiContainer!==previous.apiContainer||quadletSha!==previous.quadletSha||releaseSha!==previous.releaseSha))throw new Error('Same-digest application recreated the API container or changed the Quadlet or release record');
if(['compatible-update','better-auth-compatible-update'].includes(key)&&(quadletSha===previous.quadletSha||releaseSha===previous.releaseSha))throw new Error('Compatible image update did not update the Quadlet and release record');
if((key==='failed-candidate-rollback'||key==='better-auth-rollback')&&apiContainer===previous.apiContainer)throw new Error('Failed candidate rollback did not recreate the previous API writer');
if((key==='failed-candidate-rollback'||key==='better-auth-rollback')&&(quadletSha!==previous.quadletSha||releaseSha!==previous.releaseSha))throw new Error('Failed candidate rollback did not restore the prior Quadlet and release record');
if(key==='interrupted-recovery'&&(quadletSha!==previous.quadletSha||releaseSha!==previous.releaseSha))throw new Error('Interrupted transaction recovery did not preserve the previous Quadlet and release record');
observations.push({checkpoint:key,apiContainer,apiImage,apiHealth,apiUnit,quadletSha,releaseSha,dbContainer,
  volumes:{postgres:{name:pgVolume,mountpoint:pgMount,createdAt:pgCreated},data:{name:dataVolume,mountpoint:dataMount,createdAt:dataCreated},history:{name:historyVolume,mountpoint:historyMount,createdAt:historyCreated}},apiWriterCount:Number(apiCount),databaseSentinel:sentinel});
report.updatedAt=new Date().toISOString();fs.writeFileSync(path,JSON.stringify(report,null,2)+'\n',{mode:0o600});
NODE
}
cleanup() {
  local status=$?
  trap - EXIT
  set +e
  if [[ "$backup_mounted" == true ]] || rootless mountpoint -q "$fixture_home/.local/state/codexia-backup-mount" 2>/dev/null; then
    rootless fusermount3 -u "$fixture_home/.local/state/codexia-backup-mount" || cleanup_failed "$LINENO" 'SSHFS unmount'
    rootless mountpoint -q "$fixture_home/.local/state/codexia-backup-mount" && cleanup_failed "$LINENO" 'SSHFS mount remains'
  fi
  if [[ "$runtime_ready" == true ]] && getent passwd "$fixture_user" >/dev/null 2>&1; then
    rootless_systemctl stop codexia-tunnel.service codexia-api.service codexia-db.service >/dev/null 2>&1 || true
    local name rc
    for name in codexia-api codexia-tunnel codexia-db codexia-lifecycle-registry codexia-backup-sshfs codexia-auth-registration codexia-lifecycle-proxy; do
      rc=0; rootless_podman container exists "$name" >/dev/null 2>&1 || rc=$?
      if (( rc == 0 )); then rootless_podman rm -f "$name" >/dev/null 2>&1 || true; fi
      rc=0; rootless_podman container exists "$name" >/dev/null 2>&1 || rc=$?
      (( rc == 1 )) || cleanup_failed "$LINENO" "$name container absence verification"
    done
    for name in codexia-postgres codexia-data codexia-history; do
      rc=0; rootless_podman volume exists "$name" >/dev/null 2>&1 || rc=$?
      if (( rc == 0 )); then rootless_podman volume rm "$name" >/dev/null 2>&1 || cleanup_failed "$LINENO" "$name volume removal"; fi
      rc=0; rootless_podman volume exists "$name" >/dev/null 2>&1 || rc=$?
      (( rc == 1 )) || cleanup_failed "$LINENO" "$name volume absence verification"
    done
    for name in codexia-data codexia codexia-lifecycle-backup; do
      rc=0; rootless_podman network exists "$name" >/dev/null 2>&1 || rc=$?
      if (( rc == 0 )); then rootless_podman network rm "$name" >/dev/null 2>&1 || cleanup_failed "$LINENO" "$name network removal"; fi
      rc=0; rootless_podman network exists "$name" >/dev/null 2>&1 || rc=$?
      (( rc == 1 )) || cleanup_failed "$LINENO" "$name network absence verification"
    done
    for name in codexia-tunnel-token codexia-postgres-admin-password codexia-postgres-app-password \
      codexia-auth-database-url codexia-auth-secret codexia-oidc-client-secret codexia-oauth-introspection-client-secret; do
      rc=0; rootless_podman secret exists "$name" >/dev/null 2>&1 || rc=$?
      if (( rc == 0 )); then rootless_podman secret rm "$name" >/dev/null 2>&1 || cleanup_failed "$LINENO" "$name secret removal"; fi
      rc=0; rootless_podman secret exists "$name" >/dev/null 2>&1 || rc=$?
      (( rc == 1 )) || cleanup_failed "$LINENO" "$name secret absence verification"
    done
    if [[ -n "$build_context" ]] && rootless test -d "$build_context"; then
      rootless rm -r "$build_context" || cleanup_failed "$LINENO"
      rootless test ! -e "$build_context" || cleanup_failed "$LINENO"
    fi
  fi
  # The alias is a disposable network-namespace address used by the canonical
  # backup destination guard, not the SSH transport endpoint.
  if [[ -n "$fixture_ip" ]]; then
    sudo sed -i "\\|^${fixture_ip//./\\.} codexia-backup-fixture$|d" /etc/hosts || cleanup_failed "$LINENO" 'SSHFS fixture host mapping removal'
    grep -Fxq "$fixture_ip codexia-backup-fixture" /etc/hosts && cleanup_failed "$LINENO" 'SSHFS fixture host mapping remains'
  fi
  if [[ "$registry_configured" == true ]]; then
    rootless rm -f "$fixture_home/.config/containers/registries.conf" || cleanup_failed "$LINENO"
    rootless test ! -e "$fixture_home/.config/containers/registries.conf" || cleanup_failed "$LINENO"
  fi
  if [[ "$environment_generator_installed" == true ]]; then
    sudo rm -f -- "$environment_generator" || cleanup_failed "$LINENO"
    [[ ! -e "$environment_generator" && ! -L "$environment_generator" ]] || cleanup_failed "$LINENO"
  fi
  if [[ "$environment_generator_dir_created" == true ]]; then
    sudo rmdir -- "$environment_generator_dir" 2>/dev/null || cleanup_failed "$LINENO"
  fi
  if [[ "$manager_configured" == true ]]; then
    if [[ -e "$manager_dropin" || -L "$manager_dropin" ]]; then sudo rm -f "$manager_dropin" || cleanup_failed "$LINENO"; fi
    if [[ -d "$manager_dropin_dir" ]]; then sudo rmdir "$manager_dropin_dir" 2>/dev/null || cleanup_failed "$LINENO"; fi
    sudo systemctl daemon-reload || cleanup_failed "$LINENO"
    [[ ! -e "$manager_dropin" && ! -d "$manager_dropin_dir" ]] || cleanup_failed "$LINENO"
  fi
  if [[ "$user_created" == true ]]; then
    if getent passwd "$fixture_user" >/dev/null 2>&1; then
      sudo loginctl disable-linger "$fixture_user" || cleanup_failed "$LINENO"
      sudo systemctl stop "user@${fixture_uid}.service" || true
      sudo loginctl kill-user "$fixture_user" 2>/dev/null || true
      sudo userdel --remove "$fixture_user" || cleanup_failed "$LINENO"
    fi
    if getent group "$fixture_user" >/dev/null 2>&1; then sudo groupdel "$fixture_user" || cleanup_failed "$LINENO"; fi
    sudo sed -i '/^codexia:/d' /etc/subuid /etc/subgid || cleanup_failed "$LINENO"
    getent passwd "$fixture_user" >/dev/null 2>&1 && cleanup_failed "$LINENO"
    getent passwd "$fixture_uid" >/dev/null 2>&1 && cleanup_failed "$LINENO"
    getent group "$fixture_user" >/dev/null 2>&1 && cleanup_failed "$LINENO"
    getent group "$fixture_gid" >/dev/null 2>&1 && cleanup_failed "$LINENO"
    [[ ! -e "$fixture_home" ]] || cleanup_failed "$LINENO"
    grep -q '^codexia:' /etc/subuid /etc/subgid && cleanup_failed "$LINENO"
  fi
  if [[ "$system_config_created" == true ]]; then
    sudo rm -rf -- /etc/codexia || cleanup_failed "$LINENO"
    [[ ! -e /etc/codexia && ! -L /etc/codexia ]] || cleanup_failed "$LINENO"
  fi
  local acl_path
  for acl_path in "${!mitogen_traversal_paths[@]}"; do
    sudo setfacl -x "u:$fixture_uid" "$acl_path" || cleanup_failed "$LINENO" 'Mitogen directory traversal ACL removal'
  done
  if [[ -f "$tmp/cleanup-errors.log" ]]; then
    redact_log "$tmp/cleanup-errors.log" "$RUNNER_TEMP/codexia-push-app-lifecycle/cleanup-errors-bounded.log"
  fi
  rm -rf -- "$tmp" || cleanup_failed "$LINENO"
  node - "$report" "$status" "$cleanup_status" <<'NODE'
const fs=require('node:fs');const [path,status,cleanup]=process.argv.slice(2);try{const r=JSON.parse(fs.readFileSync(path,'utf8'));r.cleanup={status:Number(cleanup)===0?'PASS':'FAIL',exitCode:Number(cleanup)};r.states ||= {};if(Number(cleanup)===0)r.states.fixture_cleanup={status:'PASS',detail:'fixture resources removed'};else r.states.fixture_cleanup={status:'FAIL',detail:'fixture cleanup left a resource or mount'};if(Number(status)!==0&&r.states.backup_remote_filesystem?.status==='IN_PROGRESS')r.states.backup_remote_filesystem={status:'NOT_CHECKED',detail:'deployment did not reach backup artifact creation'};r.logs=fs.readdirSync(require('node:path').dirname(path)).filter(name=>name.endsWith('-bounded.log')).map(name=>({file:name,redacted:true}));if(Number(cleanup)!==0)r.status='FAIL';else if(Number(status)===78)r.status='NOT_CHECKED';else if(Number(status)!==0)r.status=r.status==='NOT_CHECKED'?'NOT_CHECKED':'FAIL';else {const app=['first_activation','same_digest_reapply','compatible_update','failed_candidate_rollback','durable_interruption_recovery','database_volume_writer_quadlet_release_continuity','backup_remote_filesystem'];const auth=['better_auth_activation','better_auth_same_digest','better_auth_compatible_update','better_auth_rollback'];const required=r.scenario==='app'?app:r.scenario==='auth'?auth:[];r.status=required.length>0&&[...required,'fixture_cleanup'].every(key=>r.states[key]?.status==='PASS')?'PASS':'NOT_CHECKED';}fs.writeFileSync(path,JSON.stringify(r,null,2)+'\n',{mode:0o600});}catch{}
NODE
  if (( status == 0 && cleanup_status != 0 )); then status=$cleanup_status; fi
  # A job must never be green when a required transition is NOT_CHECKED.
  if (( status == 0 )) && ! node -e 'const r=JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8"));process.exit(r.status==="PASS"?0:1)' "$report"; then
    echo 'Lifecycle report has unverified required transitions' >&2
    status=1
  fi
  exit "$status"
}
trap cleanup EXIT

mkdir -p "$(dirname "$report")"
node - "$report" "$source_sha" "$GITHUB_RUN_ID" "$GITHUB_RUN_ATTEMPT" <<'NODE'
const fs=require('node:fs');const [path,sha,run,attempt]=process.argv.slice(2);const scenario=process.env.CODEXIA_LIFECYCLE_SCENARIO;const states={};for(const key of ['first_activation','same_digest_reapply','compatible_update','failed_candidate_rollback','durable_interruption_recovery','database_volume_writer_quadlet_release_continuity','backup_remote_filesystem','better_auth_activation','better_auth_same_digest','better_auth_compatible_update','better_auth_rollback','fixture_cleanup'])states[key]={status:'NOT_CHECKED'};fs.mkdirSync(require('node:path').dirname(path),{recursive:true,mode:0o700});fs.writeFileSync(path,JSON.stringify({schemaVersion:1,sourceSha:sha,runId:Number(run),runAttempt:Number(attempt),scenario,status:'IN_PROGRESS',states,images:[],observations:{},timings:{},logs:[],capabilities:{},createdAt:new Date().toISOString()},null,2)+'\n',{mode:0o600});
NODE
trap 'record_failure "$?" "${BASH_LINENO[0]:-0}" "$BASH_COMMAND"' ERR
set_state first_activation NOT_CHECKED 'runtime fixture not started'
bootstrap_started=$(date +%s%3N)
if [[ "${GITHUB_ACTIONS:-}" != true ]]; then
  mark_fixture_unavailable 'execution is not on an isolated GitHub Actions runner'
  exit 78
elif [[ "$(lsb_release -rs)" != 26.04 ]]; then
  mark_fixture_unavailable 'runner is not Ubuntu 26.04'
  exit 78
elif [[ ! -e /dev/fuse ]]; then
  mark_fixture_unavailable 'FUSE device is unavailable for the required SSHFS backup endpoint'
  exit 78
fi
for cmd in sudo podman systemctl loginctl ssh ssh-keygen sshfs fusermount3 ansible-playbook age age-keygen \
  newuidmap newgidmap fuse-overlayfs slirp4netns pasta ip findmnt flock sha256sum sync stat getent mountpoint curl lsb_release node; do
  command -v "$cmd" >/dev/null || { mark_fixture_unavailable "$cmd unavailable"; exit 78; }
done
sudo -n true || { mark_fixture_unavailable 'non-interactive sudo is unavailable for disposable host provisioning'; exit 78; }
if getent passwd "$fixture_user" >/dev/null 2>&1 || getent passwd "$fixture_uid" >/dev/null 2>&1 || \
   getent group "$fixture_user" >/dev/null 2>&1 || getent group "$fixture_gid" >/dev/null 2>&1 || \
   grep -q '^codexia:' /etc/subuid /etc/subgid || [[ -e "$fixture_home" || -e "$manager_dropin" || -d "$manager_dropin_dir" || -e "$environment_generator" || -L "$environment_generator" ]]; then
  set_state fixture_cleanup NOT_CHECKED 'refused to adopt a pre-existing fixture identity, subordinate ID mapping, home or systemd drop-in'
  exit 1
fi
if [[ -e /etc/codexia || -L /etc/codexia ]]; then
  set_state fixture_cleanup NOT_CHECKED 'refused to replace pre-existing /etc/codexia state'
  exit 1
fi

# An explicit local inventory lets every stage execute the same site.yml with
# separate run-bound variables, as the production SSH inventory does.
cat > "$tmp/inventory.yml" <<YAML
all:
  children:
    codexia:
      hosts:
        localhost:
          ansible_connection: local
          ansible_python_interpreter: /usr/bin/python3
      vars:
        codexia_service_user: codexia
        codexia_service_group: codexia
        codexia_service_uid: $fixture_uid
        codexia_service_gid: $fixture_gid
        codexia_service_home: /home/codexia
YAML

# Install the manager environment before the host stage starts lingering services.
manager_configured=true
sudo install -d -m 0755 "$manager_dropin_dir"
cat <<MANAGER_CONF | sudo tee "$manager_dropin" >/dev/null
[Service]
Environment=HOME=$fixture_home
Environment=XDG_CONFIG_HOME=$fixture_home/.config
Environment=XDG_RUNTIME_DIR=/run/user/$fixture_uid
MANAGER_CONF
# Quadlet's user generator reads the manager's generated environment, not
# just this shell's imported values. Reuse the Base Runtime CI fixture contract.
if [[ ! -d "$environment_generator_dir" ]]; then
  sudo install -d -m 0755 "$environment_generator_dir"
  environment_generator_dir_created=true
fi
sudo install -m 0755 /dev/null "$environment_generator"
environment_generator_installed=true
cat <<ENV_GENERATOR | sudo tee "$environment_generator" >/dev/null
#!/bin/sh
if [ "\$(id -u)" = "$fixture_uid" ]; then
  printf '%s\\n' 'XDG_CONFIG_HOME=$fixture_home/.config' 'XDG_RUNTIME_DIR=/run/user/$fixture_uid'
fi
ENV_GENERATOR
sudo systemctl daemon-reload
# The service receives synthetic credentials only; all secret-bearing output is suppressed.
mkdir -p "$tmp/secrets"
printf 'fixture-tunnel-token-0123456789abcdef\n' > "$tmp/secrets/tunnel"
printf '%064d' 1 > "$tmp/secrets/admin"
printf '%064d\n' 2 > "$tmp/secrets/app"
chmod 0600 "$tmp/secrets"/*
ssh-keygen -q -t ed25519 -N '' -f "$tmp/deploy_key"
deploy_public_key=$(cut -d' ' -f1,2 "$tmp/deploy_key.pub")
cat > "$tmp/bootstrap.yml" <<YAML
codexia_stage: bootstrap
codexia_host_approved: true
codexia_create_service_account: true
codexia_deploy_ssh_public_key: "$deploy_public_key"
codexia_secrets_approved: true
codexia_tunnel_token_file: "$tmp/secrets/tunnel"
codexia_postgres_admin_password_file: "$tmp/secrets/admin"
codexia_postgres_app_password_file: "$tmp/secrets/app"
codexia_base_approved: true
codexia_database_initialization_approved: true
YAML
system_config_created=true
user_created=true
runtime_ready=true
grant_mitogen_traversal
run_playbook "$tmp/bootstrap.yml" bootstrap
rootless grep -Fxq "restrict $deploy_public_key" "$fixture_home/.ssh/authorized_keys"
service_uid=$(id -u codexia)
[[ "$service_uid" == "$fixture_uid" ]]
# Wait for the actual systemd user-manager unit, not an arbitrary retry delay.
if ! sudo systemctl start "user@${fixture_uid}.service" ||
   ! rootless_systemctl show --property=Version >/dev/null 2>&1; then
  mark_fixture_unavailable 'user systemd manager is unavailable for the configured service identity'
  exit 78
fi
rootless_systemctl import-environment HOME XDG_CONFIG_HOME XDG_RUNTIME_DIR
rootless_systemctl daemon-reload
for expected in "XDG_CONFIG_HOME=$fixture_home/.config" "XDG_RUNTIME_DIR=/run/user/$fixture_uid"; do
  if ! rootless_systemctl show-environment | grep -Fxq "$expected"; then
    echo "Disposable systemd user manager did not retain $expected after environment generation" >&2
    exit 1
  fi
done
if ! rootless_podman info --format '{{.Host.Security.Rootless}}' | grep -Fxq true; then
  mark_fixture_unavailable 'rootless Podman is unavailable for the configured service identity'
  exit 78
fi

podman_version=$(rootless_podman --version | awk '{print $3}')
podman_rootless=$(rootless_podman info --format '{{.Host.Security.Rootless}}')
systemd_version=$(rootless_systemctl --version | head -n 1)
postgres_version=$(rootless_podman exec codexia-db sh -ec 'export PGPASSWORD="$(cat /run/secrets/admin-password)"; psql -X -qAt -U codexia_admin -d codexia -c "SHOW server_version"')
# Podman handles the condition; timeout only bounds an unready fixture.
if ! rootless /usr/bin/timeout 120s /usr/bin/podman wait --interval 250ms --condition healthy codexia-db >/dev/null; then
  echo 'PostgreSQL did not become healthy within the service startup budget' >&2
fi
postgres_health=$(rootless_podman inspect --format '{{.State.Health.Status}}' codexia-db)
if [[ "$postgres_health" != healthy ]]; then
  printf 'PostgreSQL healthcheck did not become healthy (status: %s); health history follows:\n' "$postgres_health" >&2
  rootless_podman inspect --format '{{json .State.Health}}' codexia-db >&2
  exit 1
fi
test "$podman_rootless" = true
node - "$report" "$podman_version" "$podman_rootless" "$systemd_version" "$postgres_version" "$postgres_health" <<'CAPABILITIES'
const fs=require('node:fs');const [path,podman,rootless,systemd,postgres,health]=process.argv.slice(2);const r=JSON.parse(fs.readFileSync(path,'utf8'));r.capabilities={host:{distribution:'Ubuntu 26.04',architecture:process.arch},rootlessPodman:{version:podman,rootless:rootless==='true'},userSystemd:{version:systemd},postgresql:{serverVersion:postgres,health},cloudflareTunnel:{status:'NOT_STARTED',reason:'external provider access is outside this disposable app lifecycle proof'}};r.updatedAt=new Date().toISOString();fs.writeFileSync(path,JSON.stringify(r,null,2)+'\n',{mode:0o600});
CAPABILITIES

record_phase_timing host_bootstrap "$bootstrap_started"
sshfs_started=$(date +%s%3N)
# Use a dedicated rootless SSHFS server container. Its IP is distinct from host
# interfaces; backup.sh retains its normal remote-filesystem and same-host checks.
rootless_podman network create codexia-lifecycle-backup >/dev/null
ssh-keygen -q -t ed25519 -N '' -f "$tmp/backup_key"
build_context="$fixture_home/.local/state/codexia-lifecycle-build"
# The source-bound fixture is built and SSH-smoked in a separate producer job.
# A unique run key is installed only here, never in the OCI layers or artifact.
: "${CODEXIA_LIFECYCLE_FIXTURE_DIR:?}"
node "$repo_root/scripts/verification/artifacts/sshfs-fixture.mjs" "$CODEXIA_LIFECYCLE_FIXTURE_DIR"
fixture_manifest="$CODEXIA_LIFECYCLE_FIXTURE_DIR/manifest.json"
fixture_image=$(node -p 'JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8")).image' "$fixture_manifest")
fixture_image_id=$(node -p 'JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8")).imageId' "$fixture_manifest")
rootless mkdir -p "$build_context"
sudo install -o codexia -g codexia -m 0600 "$tmp/backup_key.pub" "$build_context/authorized_keys"
# Bind-mounted authorized_keys must belong to the sshd account (container UID 1000).
# Map ownership through the service user's rootless user namespace, not host root.
rootless_podman unshare chown 1000:1000 "$build_context/authorized_keys"
sudo install -o codexia -g codexia -m 0644 "$CODEXIA_LIFECYCLE_FIXTURE_DIR/sshfs-fixture.tar" "$build_context/sshfs-fixture.tar"
rootless_podman load --input "$build_context/sshfs-fixture.tar" >"$tmp/sshfs-load.log" 2>&1
imported_fixture_image_id=$(rootless_podman image inspect "$fixture_image" --format '{{.Id}}')
if [[ ! "$imported_fixture_image_id" =~ ^(sha256:)?[a-f0-9]{64}$ ]] ||
   [[ "${imported_fixture_image_id#sha256:}" != "${fixture_image_id#sha256:}" ]]; then
  printf 'Imported SSHFS image ID differs: producer=%s consumer=%s\n' "$fixture_image_id" "$imported_fixture_image_id" >&2
  exit 1
fi
rootless_podman run -d --name codexia-backup-sshfs --network codexia-lifecycle-backup \
  -p 127.0.0.1:2222:2222 \
  --volume "$build_context/authorized_keys:/home/codexia-backup/.ssh/authorized_keys:ro" \
  --health-cmd 'test -s /etc/ssh/fixture-host-keys/ssh_host_ed25519_key.pub' \
  --health-interval 1s --health-start-period 5s --health-retries 3 \
  "$fixture_image" >/dev/null
rootless mkdir -p "$fixture_home/.ssh" "$fixture_home/.local/state/codexia-backup-mount"
rootless chmod 0700 "$fixture_home/.ssh"
sudo install -o codexia -g codexia -m 0600 "$tmp/backup_key" "$fixture_home/.ssh/codexia-backup-key"
cat > "$tmp/ssh-config" <<'SSH_CONFIG'
Host codexia-backup-fixture
  HostName 127.0.0.1
  Port 2222
  User codexia-backup
  IdentityFile /home/codexia/.ssh/codexia-backup-key
  IdentitiesOnly yes
  HostKeyAlias codexia-backup-fixture
  UserKnownHostsFile /home/codexia/.ssh/known_hosts
  StrictHostKeyChecking yes
SSH_CONFIG
sudo install -o codexia -g codexia -m 0600 "$tmp/ssh-config" "$fixture_home/.ssh/config"
# The container generates its host key on startup. Its detached run can finish
# before ssh-keygen -A, so wait for the real key instead of racing sshd startup.
if ! rootless /usr/bin/timeout 30s /usr/bin/podman wait --interval 250ms --condition healthy codexia-backup-sshfs >/dev/null ||
   ! rootless_podman exec codexia-backup-sshfs test -s /etc/ssh/fixture-host-keys/ssh_host_ed25519_key.pub; then
  echo 'Prebuilt SSHFS fixture did not generate its SSH host key' >&2
  rootless_podman logs --tail 50 codexia-backup-sshfs >&2 || true
  exit 1
fi
server_key=$(rootless_podman exec codexia-backup-sshfs cat /etc/ssh/fixture-host-keys/ssh_host_ed25519_key.pub)
printf 'codexia-backup-fixture %s\n' "$server_key" > "$tmp/known_hosts"
sudo install -o codexia -g codexia -m 0600 "$tmp/known_hosts" "$fixture_home/.ssh/known_hosts"
if ! rootless ssh -F "$fixture_home/.ssh/config" -o BatchMode=yes codexia-backup-fixture true; then
  echo 'The isolated SSHFS endpoint failed its pinned-key SSH capability check' >&2
  exit 1
fi
# The production backup guard resolves the SSHFS mount *source* and must find
# a non-local peer. Name the actual isolated container address, while SSH
# continues to reach that same container over its mapped 127.0.0.1:2222 port.
fixture_ip=$(rootless_podman inspect --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' codexia-backup-sshfs)
[[ "$fixture_ip" =~ ^([0-9]{1,3}[.]){3}[0-9]{1,3}$ ]] || { echo 'SSHFS container has no verifiable network address' >&2; exit 1; }
printf '%s codexia-backup-fixture\n' "$fixture_ip" | sudo tee -a /etc/hosts >/dev/null
getent ahosts codexia-backup-fixture | awk '{print $1}' | grep -Fxq "$fixture_ip" || {
  echo 'SSHFS fixture hostname did not resolve to its isolated container address' >&2
  exit 1
}

if ! rootless sshfs codexia-backup@codexia-backup-fixture:/backups "$fixture_home/.local/state/codexia-backup-mount" -o reconnect -o ServerAliveInterval=15 -o ServerAliveCountMax=3 2>"$tmp/sshfs.log"; then
  redact_log "$tmp/sshfs.log" "$RUNNER_TEMP/codexia-push-app-lifecycle/sshfs-bounded.log"
  if grep -Eqi 'fuse|operation not permitted|permission denied' "$tmp/sshfs.log"; then
    mark_fixture_unavailable 'SSHFS mount capability is unavailable on this hosted runner'
    exit 78
  fi
  exit 1
fi
backup_mounted=true
rootless mountpoint -q "$fixture_home/.local/state/codexia-backup-mount"
set_state backup_remote_filesystem IN_PROGRESS 'isolated SSHFS container mounted; waiting for the canonical deployment backup'
record_phase_timing sshfs_fixture "$sshfs_started"
age-keygen -o "$tmp/age-identity" >/dev/null
backup_recipient=$(sed -n 's/^# public key: //p' "$tmp/age-identity")
test "$backup_recipient" != ''

# Resolve and verify published images before installing the disposable registry map.
# This keeps public GHCR pulls pointed at GHCR, never at the empty test registry.
candidate_started=$(date +%s%3N)
node "$repo_root/scripts/deployment/lifecycle/app.mjs" prepare
record_phase_timing backend_candidate "$candidate_started"
registry_started=$(date +%s%3N)

# The service user's OCI registry map points the production image name at a
# disposable local registry. No image or package is published to GHCR.
rootless_podman pull docker.io/library/registry:2 >/dev/null
registry_image_digest=$(rootless_podman image inspect --format '{{json .RepoDigests}}' docker.io/library/registry:2 | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{const a=JSON.parse(s);const v=a.find(x=>/^docker\.io\/library\/registry@sha256:[a-f0-9]{64}$/.test(x));if(!v)process.exit(1);console.log(v)})')
rootless_podman run -d --name codexia-lifecycle-registry -p 127.0.0.1:5000:5000 "$registry_image_digest" >/dev/null
cat > "$tmp/registries.conf" <<'REGISTRY'
unqualified-search-registries = ["docker.io"]
[[registry]]
prefix = "ghcr.io/yohn-jp/codexia-backend"
location = "localhost:5000/yohn-jp/codexia-backend"
insecure = true
[[registry]]
prefix = "localhost:5000"
location = "localhost:5000"
insecure = true
REGISTRY
registry_configured=true
sudo install -o codexia -g codexia -m 0600 "$tmp/registries.conf" "$fixture_home/.config/containers/registries.conf"
# Retry the live HTTP readiness result, not elapsed time.
curl --fail --silent --retry 20 --retry-all-errors --retry-connrefused \
  --retry-delay 1 --connect-timeout 2 --max-time 3 http://127.0.0.1:5000/v2/ >/dev/null
node "$repo_root/scripts/deployment/lifecycle/app.mjs" mirror
record_phase_timing registry_mirror "$registry_started"
database_image_name=$(rootless_podman inspect --format '{{.ImageName}}' codexia-db)
database_image_id=$(rootless_podman inspect --format '{{.Image}}' codexia-db)
database_repo_digests=$(rootless_podman image inspect --format '{{json .RepoDigests}}' "$database_image_name")
sshfs_image_id=$(rootless_podman image inspect --format '{{.Id}}' "$fixture_image")
registry_image_id=$(rootless_podman image inspect --format '{{.Id}}' "$registry_image_digest")
node - "$report" "$database_image_name" "$database_image_id" "$database_repo_digests" "$fixture_manifest" "$sshfs_image_id" "$registry_image_digest" "$registry_image_id" <<'IMAGE_INVENTORY'
const fs=require('node:fs');
const [p,dbName,dbId,dbDigests,manifestPath,sshfsId,registry,registryId]=process.argv.slice(2);
const r=JSON.parse(fs.readFileSync(p,'utf8')),m=JSON.parse(fs.readFileSync(manifestPath,'utf8'));
r.infrastructureImages=[
  {role:'postgres',image:dbName,imageId:dbId,repoDigests:JSON.parse(dbDigests),sourceIdentity:'deploy/quadlet/codexia-db.container pinned upstream OCI reference'},
  {role:'backup-sshfs-server',image:m.image,imageId:sshfsId,sourceIdentity:{kind:'same-run prebuilt artifact',sourceSha:m.sourceSha,
    runId:m.runId,runAttempt:m.runAttempt,archiveSha256:m.archiveSha256,baseImage:m.baseImage,dockerfileSha256:m.dockerfileSha256,entrypointSha256:m.entrypointSha256}},
  {role:'disposable-registry',image:registry,imageId:registryId,sourceIdentity:'upstream OCI immutable digest'}
];r.updatedAt=new Date().toISOString();fs.writeFileSync(p,JSON.stringify(r,null,2)+'\n',{mode:0o600});

IMAGE_INVENTORY

disable_fixture_tunnel() {
  # Base installs the canonical Tunnel Quadlet but does not start it. Remove that
  # external-service unit only inside this disposable fixture; the app transaction
  # then exercises the same optional-Tunnel branch without contacting Cloudflare.
  rootless rm -f "$fixture_home/.config/containers/systemd/codexia-tunnel.container"
  rootless_systemctl daemon-reload
  if rootless_systemctl cat codexia-tunnel.service >/dev/null 2>&1; then
    echo 'The disposable fixture unexpectedly retained a Cloudflare Tunnel unit' >&2
    exit 1
  fi
}

prepare_app_update() {
  # When no compatible published release exists, create an independent, same-identity
  # test-only digest. This must not depend on the Better Auth lane's database.
  local from candidate tag digest_file digest
  from=$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).candidates.head.image' "$evidence")
  candidate="$build_context/app-update"
  rootless mkdir -p "$candidate"
  cat > "$tmp/app-update.Dockerfile" <<'DOCKERFILE'
ARG BASE_IMAGE
FROM ${BASE_IMAGE}
LABEL org.codexia.lifecycle-scenario="app-update"
DOCKERFILE
  sudo install -o codexia -g codexia -m 0644 "$tmp/app-update.Dockerfile" "$candidate/Dockerfile"
  tag="localhost:5000/yohn-jp/codexia-backend:app-update-$source_sha"
  rootless_podman build --pull=never --build-arg "BASE_IMAGE=$from" -t "$tag" -f "$candidate/Dockerfile" "$candidate" >"$tmp/app-update-build.log" 2>&1
  digest_file="$candidate/digest"
  rootless_podman push --digestfile "$digest_file" "$tag" >"$tmp/app-update-push.log" 2>&1
  digest=$(rootless cat "$digest_file")
  rootless rm -f "$digest_file"
  node "$repo_root/scripts/deployment/lifecycle/app.mjs" record-auth app-update "ghcr.io/yohn-jp/codexia-backend@$digest"
}
seed_database_sentinel() {
  rootless_podman exec -i codexia-db sh -ec 'export PGPASSWORD="$(cat /run/secrets/admin-password)"; exec psql -X -q -v ON_ERROR_STOP=1 -U codexia_admin -d codexia' <<'SENTINEL_SQL'
CREATE TABLE codexia_lifecycle_sentinel(id integer PRIMARY KEY, value text NOT NULL);
INSERT INTO codexia_lifecycle_sentinel VALUES (1, 'preserved');
SENTINEL_SQL
}
run_application_lifecycle() {
  local initial_key update_key update_image failed_image backup_validation backup_checksum
  local -a backup_artifacts=()
  if [[ "$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).transition.kind' "$evidence")" == test-only-digest ]]; then
    prepare_app_update
  fi
  read -r initial_key update_key update_image < <(node - "$evidence" <<'TRANSITION'
const fs = require('node:fs');
const { transition, candidates } = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const { from, to } = transition;
if (candidates[from].image === candidates[to].image) throw new Error('The update requires two distinct OCI digests');
console.log(from, to, candidates[to].image);
TRANSITION
  )
  [[ "$initial_key:$update_key" == prior:head || "$initial_key:$update_key" == head:app-update ]]
# Exercise only the canonical production transaction code, with its separate
# verification evidence instead of the production admission certificate.
set_state first_activation IN_PROGRESS
run_deploy "$initial_key" true
observe_runtime first-activation "$initial_key"
mapfile -t backup_artifacts < <(rootless find "$fixture_home/.local/state/codexia-backup-mount" -mindepth 1 -maxdepth 1 -type d -name 'codexia-*' -print)
[[ "${#backup_artifacts[@]}" == 0 ]]
rootless test ! -e "$fixture_home/.config/codexia-backup/executor.env"
set_state first_activation PASS 'fresh schema and API readiness verified without backup inputs, artifacts or prior writer'

run_deploy "$initial_key" false
observe_runtime same-digest-reapply "$initial_key"
set_state same_digest_reapply PASS 'same immutable digest remained healthy with stable Quadlet and release record'

seed_database_sentinel
if run_deploy "$update_key" false '' deploy-executor-missing; then
  echo 'An update reached candidate activation without protected backup settings' >&2
  return 1
fi
grep -Fq 'Deployment transaction failed during off-VM backup admission' "$tmp/deploy-executor-missing.log"
observe_runtime missing-executor "$initial_key"
prepare_backup_console_fixture
if run_deploy "$update_key" false '' deploy-console-unconfigured console-unconfigured; then
  echo 'An update reached candidate activation before Console backup configuration' >&2
  return 1
fi
grep -Fq 'Deployment transaction failed during off-VM backup admission' "$tmp/deploy-console-unconfigured.log"
observe_runtime console-unconfigured "$initial_key"
rootless test ! -e "$fixture_home/.local/state/codexia-deploy/deploy-transaction.json"
mapfile -t backup_artifacts < <(rootless find "$fixture_home/.local/state/codexia-backup-mount" -mindepth 1 -maxdepth 1 -type d -name 'codexia-*' -print)
[[ "${#backup_artifacts[@]}" == 0 ]]
run_deploy "$update_key" false
observe_runtime compatible-update "$update_key"
set_state compatible_update PASS "$initial_key to $update_key activated the verified digest as the sole healthy API writer"

mapfile -t backup_artifacts < <(rootless find "$fixture_home/.local/state/codexia-backup-mount" -mindepth 1 -maxdepth 1 -type d -name 'codexia-*' -print)
[[ "${#backup_artifacts[@]}" == 1 ]]
backup_validation=$(rootless "$fixture_home/.local/bin/codexia-backup" validate-artifact "${backup_artifacts[0]}")
backup_checksum=$(rootless sha256sum "${backup_artifacts[0]}/SHA256SUMS" | cut -d' ' -f1)
node - "$report" "${backup_artifacts[0]}" "$backup_validation" "$backup_checksum" <<'BACKUP_EVIDENCE'
const fs=require('node:fs');const [path,artifact,validation,checksum]=process.argv.slice(2);const r=JSON.parse(fs.readFileSync(path,'utf8'));r.backupEvidence={filesystem:'sshfs',remoteAlias:'codexia-backup-fixture',artifactPath:artifact,validatedBy:'deploy/backup/backup.sh validate-artifact',validation:validation.slice(0,300),sha256SumsFile:checksum,physicalIndependence:'NOT_PROVEN_BY_CI_FIXTURE'};r.states.backup_remote_filesystem={status:'PASS',detail:'canonical deploy transaction created and validated encrypted backup on isolated SSHFS server'};r.updatedAt=new Date().toISOString();fs.writeFileSync(path,JSON.stringify(r,null,2)+'\n',{mode:0o600});
BACKUP_EVIDENCE

verify_backup_host_lifecycle "$update_key" "$initial_key"
verify_s3_restore_lifecycle "$initial_key" "${backup_artifacts[0]}"

# Deliberately alter only a disposable image entrypoint to exercise real rollback.
failed_context="$build_context/failed"
rootless mkdir -p "$failed_context"
cat > "$tmp/failed.Dockerfile" <<'DOCKERFILE'
ARG BASE_IMAGE
FROM ${BASE_IMAGE}
ENTRYPOINT ["/bin/false"]
DOCKERFILE
sudo install -o codexia -g codexia -m 0644 "$tmp/failed.Dockerfile" "$failed_context/Dockerfile"
rootless_podman build --build-arg "BASE_IMAGE=$update_image" -t codexia-backend-lifecycle-fail -f "$failed_context/Dockerfile" "$failed_context" >/dev/null
failed_tag="localhost:5000/yohn-jp/codexia-backend:lifecycle-failed-$source_sha"
rootless_podman tag codexia-backend-lifecycle-fail "$failed_tag"
failed_digest_file="$fixture_home/.local/state/codexia-lifecycle-build/failed.digest"
rootless_podman push --digestfile "$failed_digest_file" "$failed_tag" >/dev/null
failed_digest=$(sudo -u codexia cat "$failed_digest_file")
rootless rm -f "$failed_digest_file"
failed_image="ghcr.io/yohn-jp/codexia-backend@$failed_digest"
node "$repo_root/scripts/deployment/lifecycle/app.mjs" record-failed "$failed_image"
before_failure=$(rootless sha256sum "$fixture_home/.local/state/codexia-deploy/deployed-release.json" | cut -d' ' -f1)
if run_deploy failed false '' deploy-failed-candidate; then
  echo 'Deliberately failing candidate unexpectedly deployed' >&2
  exit 1
fi
if ! grep -Eq 'Deployment transaction failed during candidate API (startup|readiness)' "$tmp/deploy-failed-candidate.log"; then
  echo 'Deliberately failing candidate did not reach API startup or readiness' >&2
  exit 1
fi
rootless test ! -e "$fixture_home/.local/state/codexia-deploy/deploy-transaction.json"
observe_runtime failed-candidate-rollback "$update_key"
[[ "$(rootless sha256sum "$fixture_home/.local/state/codexia-deploy/deployed-release.json" | cut -d' ' -f1)" == "$before_failure" ]]
set_state failed_candidate_rollback PASS 'candidate start failure restored the previous digest and release record'

# Kill the transaction shell only after the durable pending intent is observable.
fault_dir="$fixture_home/.local/state/codexia-deploy/fault-bin"
rootless mkdir -p "$fault_dir"
cat > "$tmp/fault-systemctl" <<'FAULT_SYSTEMCTL'
#!/bin/bash
/usr/bin/systemctl "$@"
status=$?
if [[ "${1:-}" == --user && "${2:-}" == stop && -f /home/codexia/.local/state/codexia-deploy/deploy-transaction.json ]] && \
   grep -q '"phase":"pending"' /home/codexia/.local/state/codexia-deploy/deploy-transaction.json; then
  kill -KILL "$PPID"
fi
exit "$status"
FAULT_SYSTEMCTL
sudo install -o codexia -g codexia -m 0755 "$tmp/fault-systemctl" "$fault_dir/systemctl"
if run_deploy "$initial_key" false "$fault_dir"; then echo 'Injected controller interruption unexpectedly returned success' >&2; exit 1; fi
rootless grep -q '"phase":"pending"' "$fixture_home/.local/state/codexia-deploy/deploy-transaction.json"
run_deploy "$update_key" false
observe_runtime interrupted-recovery "$update_key"
rootless test ! -e "$fixture_home/.local/state/codexia-deploy/deploy-transaction.json"
set_state durable_interruption_recovery PASS 'the next canonical invocation recovered and cleared the durable pending transaction'
set_state database_volume_writer_quadlet_release_continuity PASS 'database sentinel, volume IDs, sole writer, Quadlet and release record were observed after transitions'
}
source "$repo_root/deploy/ansible/test-push-backup-host-lifecycle.sh"
scenario_started=$(date +%s%3N)
case "${CODEXIA_LIFECYCLE_SCENARIO:?}" in
  app)
    # The standalone API requires the same approved Better Auth bootstrap as the auth lane.
    source "$repo_root/deploy/ansible/test-push-auth-lifecycle.sh"
    run_better_auth_lifecycle app
    ;;
  auth)
    source "$repo_root/deploy/ansible/test-push-auth-lifecycle.sh"
    run_better_auth_lifecycle
    ;;
  *)
    echo "Unknown lifecycle scenario" >&2
    exit 1
    ;;
esac
record_phase_timing "${CODEXIA_LIFECYCLE_SCENARIO}_transitions" "$scenario_started"
node - "$report" <<'REPORT_COMPLETE'
const fs=require('node:fs');const p=process.argv[2],r=JSON.parse(fs.readFileSync(p,'utf8'));r.status='PASS';r.updatedAt=new Date().toISOString();fs.writeFileSync(p,JSON.stringify(r,null,2)+'\n',{mode:0o600});
REPORT_COMPLETE
