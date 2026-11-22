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
manager_configured=false
registry_configured=false
user_created=false
system_config_created=false
runtime_ready=false
cleanup_status=0

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
    durable_interruption_recovery database_volume_writer_quadlet_release_continuity backup_remote_filesystem; do
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
redact_log() {
  local source=$1 target=$2
  sed -E \
    -e 's/(Bearer )[A-Za-z0-9._~-]+/\1[REDACTED]/g' \
    -e 's/(fixture-(auth|tunnel)-token-)[A-Za-z0-9]+/\1[REDACTED]/g' \
    -e 's/((password|token)(_file)?[=: ]+)[^[:space:]]+/\1[REDACTED]/Ig' \
    "$source" | tail -n 160 > "$target"
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
  for log in "$tmp"/*.log; do
    [[ -f "$log" ]] || continue
    if [[ -z "$latest_log" || "$log" -nt "$latest_log" ]]; then latest_log=$log; fi
  done
  if [[ -n "$latest_log" ]]; then
    local bounded="$RUNNER_TEMP/codexia-push-app-lifecycle/failure-bounded.log"
    redact_log "$latest_log" "$bounded"
    printf '%s\n' "Last Ansible log ($latest_log), redacted tail:" >&2
    cat "$bounded" >&2
  fi
  return "$status"
}
run_playbook() {
  local vars=$1 name=$2 status=0
  ANSIBLE_LOCAL_TEMP="$tmp/ansible-local" "$ANSIBLE_PLAYBOOK" -i "$tmp/inventory.yml" \
    "$repo_root/deploy/ansible/site.yml" --extra-vars "@$vars" >"$tmp/$name.log" 2>&1 || status=$?
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
  cat > "$tmp/deploy-vars.yml" <<YAML
codexia_stage: deploy-lifecycle-fixture
codexia_service_user: codexia
codexia_service_uid: $fixture_uid
codexia_service_home: /home/codexia
codexia_lifecycle_verification_file: "$evidence"
codexia_lifecycle_candidate_key: "$key"
codexia_backup_destination: "$fixture_home/.local/state/codexia-backup-mount"
codexia_backup_recipient: "$backup_recipient"
codexia_initial_install_approved: $approvals
codexia_database_initialization_approved: $approvals
$(if [[ -n "$fault_path" ]]; then printf 'codexia_lifecycle_fault_path: "%s"\n' "$fault_path"; fi)
YAML
  run_playbook "$tmp/deploy-vars.yml" "deploy-$key-$RANDOM"
}
observe_runtime() {
  local key=$1
  local container_id image_id api_health api_unit quadlet_sha release_sha pg_volume pg_mount pg_created data_volume data_mount data_created history_volume history_mount history_created db_container api_count sentinel
  container_id=$(rootless_podman inspect --format '{{.Id}}' codexia-api)
  image_id=$(rootless_podman inspect --format '{{.Image}}' codexia-api)
  api_health=$(rootless_podman inspect --format '{{.State.Health.Status}}' codexia-api)
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
  test "$api_health" = healthy && test "$api_unit" = active && test "$api_count" = 1
  rootless_podman exec codexia-api node -e 'fetch("http://127.0.0.1:3000/health/ready").then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))' >/dev/null
  node - "$report" "$key" "$container_id" "$image_id" "$api_health" "$api_unit" "$quadlet_sha" "$release_sha" "$db_container" \
    "$pg_volume" "$pg_mount" "$pg_created" "$data_volume" "$data_mount" "$data_created" "$history_volume" "$history_mount" "$history_created" "$api_count" "$sentinel" <<'NODE'
const fs=require('node:fs');
const [path,key,apiContainer,apiImage,apiHealth,apiUnit,quadletSha,releaseSha,dbContainer,pgVolume,pgMount,pgCreated,dataVolume,dataMount,dataCreated,historyVolume,historyMount,historyCreated,apiCount,sentinel]=process.argv.slice(2);
const report=JSON.parse(fs.readFileSync(path,'utf8'));
const evidence=JSON.parse(fs.readFileSync(process.env.CODEXIA_LIFECYCLE_EVIDENCE_FILE,'utf8'));
const role=['first-activation','same-digest-reapply'].includes(key)?'head':'compatible';
const expectedImageId=evidence.candidates[role].imageId;
if(!expectedImageId||apiImage!==expectedImageId)throw new Error(`${key}: API writer image ID differs from the run-bound ${role} candidate`);
if(sentinel!==(['first-activation','same-digest-reapply'].includes(key)?'not-created':'preserved'))throw new Error(`${key}: PostgreSQL sentinel data was absent or changed`);
report.observations ||= {}; const observations=report.observations.continuity ||= []; const previous=observations.at(-1);
if(previous){
  if(dbContainer!==previous.dbContainer)throw new Error(`${key}: PostgreSQL container identity changed`);
  if(JSON.stringify({postgres:{name:pgVolume,mountpoint:pgMount,createdAt:pgCreated},data:{name:dataVolume,mountpoint:dataMount,createdAt:dataCreated},history:{name:historyVolume,mountpoint:historyMount,createdAt:historyCreated}})!==JSON.stringify(previous.volumes))throw new Error(`${key}: persistent volume identity changed`);
}
if(key==='same-digest-reapply'&&(apiContainer!==previous.apiContainer||quadletSha!==previous.quadletSha||releaseSha!==previous.releaseSha))throw new Error('Same-digest application recreated the API container or changed the Quadlet or release record');
if(key==='compatible-update'&&(quadletSha===previous.quadletSha||releaseSha===previous.releaseSha))throw new Error('Compatible image update did not update the Quadlet and release record');
if(key==='failed-candidate-rollback'&&(quadletSha!==previous.quadletSha||releaseSha!==previous.releaseSha))throw new Error('Failed candidate rollback did not restore the prior Quadlet and release record');
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
    rootless fusermount3 -u "$fixture_home/.local/state/codexia-backup-mount" || cleanup_status=1
    rootless mountpoint -q "$fixture_home/.local/state/codexia-backup-mount" && cleanup_status=1
  fi
  if [[ "$runtime_ready" == true ]] && getent passwd "$fixture_user" >/dev/null 2>&1; then
    rootless_systemctl stop codexia-tunnel.service codexia-api.service codexia-db.service >/dev/null 2>&1 || true
    local name rc
    for name in codexia-api codexia-tunnel codexia-db codexia-lifecycle-registry codexia-backup-sshfs; do
      rc=0; rootless_podman container exists "$name" >/dev/null 2>&1 || rc=$?
      if (( rc == 0 )); then rootless_podman rm -f "$name" >/dev/null 2>&1 || cleanup_status=1; fi
      rc=0; rootless_podman container exists "$name" >/dev/null 2>&1 || rc=$?
      (( rc == 1 )) || cleanup_status=1
    done
    for name in codexia-postgres codexia-data codexia-history; do
      rc=0; rootless_podman volume exists "$name" >/dev/null 2>&1 || rc=$?
      if (( rc == 0 )); then rootless_podman volume rm "$name" >/dev/null 2>&1 || cleanup_status=1; fi
      rc=0; rootless_podman volume exists "$name" >/dev/null 2>&1 || rc=$?
      (( rc == 1 )) || cleanup_status=1
    done
    for name in codexia-data codexia codexia-lifecycle-backup; do
      rc=0; rootless_podman network exists "$name" >/dev/null 2>&1 || rc=$?
      if (( rc == 0 )); then rootless_podman network rm "$name" >/dev/null 2>&1 || cleanup_status=1; fi
      rc=0; rootless_podman network exists "$name" >/dev/null 2>&1 || rc=$?
      (( rc == 1 )) || cleanup_status=1
    done
    for name in codexia-auth-token codexia-tunnel-token codexia-postgres-admin-password codexia-postgres-app-password; do
      rc=0; rootless_podman secret exists "$name" >/dev/null 2>&1 || rc=$?
      if (( rc == 0 )); then rootless_podman secret rm "$name" >/dev/null 2>&1 || cleanup_status=1; fi
      rc=0; rootless_podman secret exists "$name" >/dev/null 2>&1 || rc=$?
      (( rc == 1 )) || cleanup_status=1
    done
  fi
  if [[ -n "$fixture_ip" ]]; then
    sudo sed -i "\\|^$fixture_ip codexia-backup-fixture$|d" /etc/hosts || cleanup_status=1
    grep -q "^$fixture_ip codexia-backup-fixture$" /etc/hosts && cleanup_status=1
  fi
  if [[ "$registry_configured" == true ]]; then
    rootless rm -f "$fixture_home/.config/containers/registries.conf" || cleanup_status=1
    rootless test ! -e "$fixture_home/.config/containers/registries.conf" || cleanup_status=1
  fi
  if [[ "$environment_generator_installed" == true ]]; then
    sudo rm -f -- "$environment_generator" || cleanup_status=1
    [[ ! -e "$environment_generator" && ! -L "$environment_generator" ]] || cleanup_status=1
  fi
  if [[ "$environment_generator_dir_created" == true ]]; then
    sudo rmdir -- "$environment_generator_dir" 2>/dev/null || cleanup_status=1
  fi
  if [[ "$manager_configured" == true ]]; then
    if [[ -e "$manager_dropin" || -L "$manager_dropin" ]]; then sudo rm -f "$manager_dropin" || cleanup_status=1; fi
    if [[ -d "$manager_dropin_dir" ]]; then sudo rmdir "$manager_dropin_dir" 2>/dev/null || cleanup_status=1; fi
    sudo systemctl daemon-reload || cleanup_status=1
    [[ ! -e "$manager_dropin" && ! -d "$manager_dropin_dir" ]] || cleanup_status=1
  fi
  if [[ "$user_created" == true ]]; then
    if getent passwd "$fixture_user" >/dev/null 2>&1; then
      sudo loginctl disable-linger "$fixture_user" || cleanup_status=1
      sudo systemctl stop "user@${fixture_uid}.service" || true
      sudo loginctl kill-user "$fixture_user" 2>/dev/null || true
      sudo userdel --remove "$fixture_user" || cleanup_status=1
    fi
    if getent group "$fixture_user" >/dev/null 2>&1; then sudo groupdel "$fixture_user" || cleanup_status=1; fi
    sudo sed -i '/^codexia:/d' /etc/subuid /etc/subgid || cleanup_status=1
    getent passwd "$fixture_user" >/dev/null 2>&1 && cleanup_status=1
    getent passwd "$fixture_uid" >/dev/null 2>&1 && cleanup_status=1
    getent group "$fixture_user" >/dev/null 2>&1 && cleanup_status=1
    getent group "$fixture_gid" >/dev/null 2>&1 && cleanup_status=1
    [[ ! -e "$fixture_home" ]] || cleanup_status=1
    grep -q '^codexia:' /etc/subuid /etc/subgid && cleanup_status=1
  fi
  if [[ "$system_config_created" == true ]]; then
    sudo rm -rf -- /etc/codexia || cleanup_status=1
    [[ ! -e /etc/codexia && ! -L /etc/codexia ]] || cleanup_status=1
  fi
  rm -rf -- "$tmp" || cleanup_status=1
  node - "$report" "$status" "$cleanup_status" <<'NODE'
const fs=require('node:fs');const [path,status,cleanup]=process.argv.slice(2);try{const r=JSON.parse(fs.readFileSync(path,'utf8'));r.cleanup={status:Number(cleanup)===0?'PASS':'FAIL',exitCode:Number(cleanup)};r.states ||= {};if(Number(cleanup)===0)r.states.fixture_cleanup={status:'PASS',detail:'fixture resources removed'};else r.states.fixture_cleanup={status:'FAIL',detail:'fixture cleanup left a resource or mount'};if(Number(status)!==0&&r.states.backup_remote_filesystem?.status==='IN_PROGRESS')r.states.backup_remote_filesystem={status:'NOT_CHECKED',detail:'deployment did not reach backup artifact creation'};r.logs=fs.readdirSync(require('node:path').dirname(path)).filter(name=>name.endsWith('-bounded.log')).map(name=>({file:name,redacted:true}));if(Number(cleanup)!==0)r.status='FAIL';else if(Number(status)===78)r.status='NOT_CHECKED';else if(Number(status)!==0)r.status=r.status==='NOT_CHECKED'?'NOT_CHECKED':'FAIL';else {const required=['first_activation','same_digest_reapply','compatible_update','failed_candidate_rollback','durable_interruption_recovery','database_volume_writer_quadlet_release_continuity','backup_remote_filesystem','fixture_cleanup'];r.status=required.every(key=>r.states[key]?.status==='PASS')?'PASS':'NOT_CHECKED';}fs.writeFileSync(path,JSON.stringify(r,null,2)+'\n',{mode:0o600});}catch{}
NODE
  if (( status == 0 && cleanup_status != 0 )); then status=$cleanup_status; fi
  exit "$status"
}
trap cleanup EXIT

mkdir -p "$(dirname "$report")"
node - "$report" "$source_sha" "$GITHUB_RUN_ID" "$GITHUB_RUN_ATTEMPT" <<'NODE'
const fs=require('node:fs');const [path,sha,run,attempt]=process.argv.slice(2);const states={};for(const key of ['first_activation','same_digest_reapply','compatible_update','failed_candidate_rollback','durable_interruption_recovery','database_volume_writer_quadlet_release_continuity','backup_remote_filesystem','fixture_cleanup'])states[key]={status:'NOT_CHECKED'};fs.mkdirSync(require('node:path').dirname(path),{recursive:true,mode:0o700});fs.writeFileSync(path,JSON.stringify({schemaVersion:1,sourceSha:sha,runId:Number(run),runAttempt:Number(attempt),status:'IN_PROGRESS',states,images:[],observations:{},logs:[],capabilities:{},createdAt:new Date().toISOString()},null,2)+'\n',{mode:0o600});
NODE
trap 'record_failure "$?" "${BASH_LINENO[0]:-0}" "$BASH_COMMAND"' ERR
set_state first_activation NOT_CHECKED 'runtime fixture not started'
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
sudo systemctl daemon-reload
cat > "$tmp/host.yml" <<YAML
codexia_stage: host
codexia_host_approved: true
codexia_create_service_account: true
YAML
user_created=true
if ! run_playbook "$tmp/host.yml" host; then set_state fixture_cleanup NOT_CHECKED 'host stage failed before application fixture creation'; exit 1; fi
service_uid=$(id -u codexia)
[[ "$service_uid" == "$fixture_uid" ]]
for _ in $(seq 1 30); do
  if rootless_systemctl show --property=Version >/dev/null 2>&1; then break; fi
  sleep 1
done
if ! rootless_systemctl show --property=Version >/dev/null 2>&1; then
  mark_fixture_unavailable 'user systemd manager is unavailable for the configured service identity'
  exit 78
fi
rootless_systemctl import-environment HOME XDG_CONFIG_HOME XDG_RUNTIME_DIR
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
runtime_ready=true

# The service receives synthetic credentials only; all secret-bearing output is suppressed.
mkdir -p "$tmp/secrets"
rootless mkdir -p "$fixture_home/.config/containers" "$fixture_home/.local/state"
printf 'fixture-auth-token-0123456789abcdef0123456789abcdef\n' > "$tmp/secrets/auth"
printf 'fixture-tunnel-token-0123456789abcdef\n' > "$tmp/secrets/tunnel"
printf '%064d' 1 > "$tmp/secrets/admin"
printf '%064d\n' 2 > "$tmp/secrets/app"
chmod 0600 "$tmp/secrets"/*
cat > "$tmp/secrets.yml" <<YAML
codexia_stage: secrets
codexia_secrets_approved: true
codexia_auth_token_file: "$tmp/secrets/auth"
codexia_tunnel_token_file: "$tmp/secrets/tunnel"
codexia_postgres_admin_password_file: "$tmp/secrets/admin"
codexia_postgres_app_password_file: "$tmp/secrets/app"
YAML
run_playbook "$tmp/secrets.yml" secrets
cat > "$tmp/base.yml" <<YAML
codexia_stage: base
codexia_base_approved: true
codexia_database_initialization_approved: true
YAML
system_config_created=true
run_playbook "$tmp/base.yml" base
# Base installs the canonical Tunnel Quadlet but does not start it. Remove that
# external-service unit only inside this disposable fixture; the app transaction
# then exercises the same optional-Tunnel branch without contacting Cloudflare.
rootless rm -f "$fixture_home/.config/containers/systemd/codexia-tunnel.container"
rootless_systemctl daemon-reload
if rootless_systemctl cat codexia-tunnel.service >/dev/null 2>&1; then
  echo 'The disposable fixture unexpectedly retained a Cloudflare Tunnel unit' >&2
  exit 1
fi
podman_version=$(rootless_podman --version | awk '{print $3}')
podman_rootless=$(rootless_podman info --format '{{.Host.Security.Rootless}}')
systemd_version=$(rootless_systemctl --version | head -n 1)
postgres_version=$(rootless_podman exec codexia-db sh -ec 'export PGPASSWORD="$(cat /run/secrets/admin-password)"; psql -X -qAt -U codexia_admin -d codexia -c "SHOW server_version"')
postgres_health=''
for _ in $(seq 1 12); do
  postgres_health=$(rootless_podman inspect --format '{{.State.Health.Status}}' codexia-db)
  [[ "$postgres_health" == healthy ]] && break
  sleep 5
done
if [[ "$postgres_health" != healthy ]]; then
  printf 'PostgreSQL healthcheck did not become healthy (status: %s); health history follows:\n' "$postgres_health" >&2
  rootless_podman inspect --format '{{json .State.Health}}' codexia-db >&2
  exit 1
fi
test "$podman_rootless" = true
node - "$report" "$podman_version" "$podman_rootless" "$systemd_version" "$postgres_version" "$postgres_health" <<'CAPABILITIES'
const fs=require('node:fs');const [path,podman,rootless,systemd,postgres,health]=process.argv.slice(2);const r=JSON.parse(fs.readFileSync(path,'utf8'));r.capabilities={host:{distribution:'Ubuntu 26.04',architecture:process.arch},rootlessPodman:{version:podman,rootless:rootless==='true'},userSystemd:{version:systemd},postgresql:{serverVersion:postgres,health},cloudflareTunnel:{status:'NOT_STARTED',reason:'external provider access is outside this disposable app lifecycle proof'}};r.updatedAt=new Date().toISOString();fs.writeFileSync(path,JSON.stringify(r,null,2)+'\n',{mode:0o600});
CAPABILITIES

# Use a dedicated rootless SSHFS server container. Its IP is distinct from host
# interfaces; backup.sh retains its normal remote-filesystem and same-host checks.
rootless_podman network create codexia-lifecycle-backup >/dev/null
ssh-keygen -q -t ed25519 -N '' -f "$tmp/backup_key"
build_context="$fixture_home/.local/state/codexia-lifecycle-build"
rootless_podman pull docker.io/library/ubuntu:26.04 >/dev/null
ubuntu_image_digest=$(rootless_podman image inspect --format '{{json .RepoDigests}}' docker.io/library/ubuntu:26.04 | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{const a=JSON.parse(s);const v=a.find(x=>/^docker\.io\/library\/ubuntu@sha256:[a-f0-9]{64}$/.test(x));if(!v)process.exit(1);console.log(v)})')
rootless mkdir -p "$build_context/sshfs"
sudo install -o codexia -g codexia -m 0600 "$tmp/backup_key.pub" "$build_context/sshfs/authorized_keys"
cat > "$tmp/sshfs.Dockerfile" <<'DOCKERFILE'
ARG BASE_IMAGE
FROM ${BASE_IMAGE}
RUN apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends openssh-server && rm -rf /var/lib/apt/lists/* && useradd --create-home --shell /bin/bash backup && mkdir -p /home/backup/.ssh /backups && chown -R backup:backup /home/backup/.ssh /backups && chmod 0700 /home/backup/.ssh
COPY --chown=backup:backup authorized_keys /home/backup/.ssh/authorized_keys
RUN chmod 0600 /home/backup/.ssh/authorized_keys
COPY entrypoint.sh /entrypoint.sh
RUN chmod 0755 /entrypoint.sh
EXPOSE 22
ENTRYPOINT ["/entrypoint.sh"]
DOCKERFILE
cat > "$tmp/sshfs.entrypoint.sh" <<'ENTRYPOINT'
#!/bin/sh
set -eu
mkdir -p /run/sshd
ssh-keygen -A
chown -R backup:backup /backups
exec /usr/sbin/sshd -D -e -p 22 -o PermitRootLogin=no -o PasswordAuthentication=no -o PubkeyAuthentication=yes -o AllowUsers=backup
ENTRYPOINT
sudo install -o codexia -g codexia -m 0644 "$tmp/sshfs.Dockerfile" "$build_context/sshfs/Dockerfile"
sudo install -o codexia -g codexia -m 0755 "$tmp/sshfs.entrypoint.sh" "$build_context/sshfs/entrypoint.sh"
rootless_podman build --build-arg "BASE_IMAGE=$ubuntu_image_digest" -t codexia-sshfs-fixture -f "$build_context/sshfs/Dockerfile" "$build_context/sshfs" >"$tmp/sshfs-build.log" 2>&1
rootless_podman run -d --name codexia-backup-sshfs --network codexia-lifecycle-backup -p 127.0.0.1:2222:22 codexia-sshfs-fixture >/dev/null
fixture_ip=$(rootless_podman inspect --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' codexia-backup-sshfs)
test -n "$fixture_ip"
printf '%s codexia-backup-fixture\n' "$fixture_ip" | sudo tee -a /etc/hosts >/dev/null
rootless mkdir -p "$fixture_home/.ssh" "$fixture_home/.local/state/codexia-backup-mount"
rootless chmod 0700 "$fixture_home/.ssh"
sudo install -o codexia -g codexia -m 0600 "$tmp/backup_key" "$fixture_home/.ssh/codexia-backup-key"
cat > "$tmp/ssh-config" <<'SSH_CONFIG'
Host codexia-backup-fixture
  HostName 127.0.0.1
  Port 2222
  User backup
  IdentityFile /home/codexia/.ssh/codexia-backup-key
  IdentitiesOnly yes
  HostKeyAlias codexia-backup-fixture
  UserKnownHostsFile /home/codexia/.ssh/known_hosts
  StrictHostKeyChecking yes
SSH_CONFIG
sudo install -o codexia -g codexia -m 0600 "$tmp/ssh-config" "$fixture_home/.ssh/config"
server_key=$(rootless_podman exec codexia-backup-sshfs cat /etc/ssh/ssh_host_ed25519_key.pub)
printf 'codexia-backup-fixture %s\n' "$server_key" > "$tmp/known_hosts"
sudo install -o codexia -g codexia -m 0600 "$tmp/known_hosts" "$fixture_home/.ssh/known_hosts"
if ! rootless ssh -F "$fixture_home/.ssh/config" -o BatchMode=yes codexia-backup-fixture true; then
  echo 'The isolated SSHFS endpoint failed its pinned-key SSH capability check' >&2
  exit 1
fi
if ! rootless sshfs backup@codexia-backup-fixture:/backups "$fixture_home/.local/state/codexia-backup-mount" -o reconnect -o ServerAliveInterval=15 -o ServerAliveCountMax=3 2>"$tmp/sshfs.log"; then
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
age-keygen -o "$tmp/age-identity" >/dev/null
backup_recipient=$(sed -n 's/^# public key: //p' "$tmp/age-identity")
test "$backup_recipient" != ''

# Resolve and verify published images before installing the disposable registry map.
# This keeps public GHCR pulls pointed at GHCR, never at the empty test registry.
node "$repo_root/scripts/push-app-lifecycle.mjs" prepare

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
REGISTRY
registry_configured=true
sudo install -o codexia -g codexia -m 0600 "$tmp/registries.conf" "$fixture_home/.config/containers/registries.conf"
for _ in $(seq 1 30); do
  if curl --fail --silent http://127.0.0.1:5000/v2/ >/dev/null; then break; fi
  sleep 1
done
curl --fail --silent http://127.0.0.1:5000/v2/ >/dev/null
node "$repo_root/scripts/push-app-lifecycle.mjs" mirror
database_image_name=$(rootless_podman inspect --format '{{.ImageName}}' codexia-db)
database_image_id=$(rootless_podman inspect --format '{{.Image}}' codexia-db)
database_repo_digests=$(rootless_podman image inspect --format '{{json .RepoDigests}}' "$database_image_name")
sshfs_image_id=$(rootless_podman image inspect --format '{{.Id}}' codexia-sshfs-fixture)
registry_image_id=$(rootless_podman image inspect --format '{{.Id}}' "$registry_image_digest")
sshfs_context_sha=$(rootless cat "$build_context/sshfs/Dockerfile" "$build_context/sshfs/entrypoint.sh" "$build_context/sshfs/authorized_keys" | sha256sum | cut -d' ' -f1)
node - "$report" "$database_image_name" "$database_image_id" "$database_repo_digests" "$ubuntu_image_digest" "$sshfs_image_id" "$sshfs_context_sha" "$registry_image_digest" "$registry_image_id" <<'IMAGE_INVENTORY'
const fs=require('node:fs');const [path,dbName,dbId,dbDigests,ubuntu,sshfsId,sshfsSourceSha,registry,registryId]=process.argv.slice(2);const r=JSON.parse(fs.readFileSync(path,'utf8'));r.infrastructureImages=[{role:'postgres',image:dbName,imageId:dbId,repoDigests:JSON.parse(dbDigests),sourceIdentity:'deploy/quadlet/codexia-db.container pinned upstream OCI reference'},{role:'backup-sshfs-server',imageId:sshfsId,sourceIdentity:{kind:'run-local fixture build',contextSha256:sshfsSourceSha,baseImage:ubuntu}},{role:'disposable-registry',image:registry,imageId:registryId,sourceIdentity:'upstream OCI immutable digest'}];r.updatedAt=new Date().toISOString();fs.writeFileSync(path,JSON.stringify(r,null,2)+'\n',{mode:0o600});
IMAGE_INVENTORY

# Exercise only the canonical production transaction code, with its separate
# verification evidence instead of the production admission certificate.
set_state first_activation IN_PROGRESS
run_deploy head true
observe_runtime first-activation
mapfile -t backup_artifacts < <(rootless find "$fixture_home/.local/state/codexia-backup-mount" -mindepth 1 -maxdepth 1 -type d -name 'codexia-*' -print)
[[ "${#backup_artifacts[@]}" == 1 ]]
backup_validation=$(rootless "$fixture_home/.local/bin/codexia-backup" validate-artifact "${backup_artifacts[0]}")
backup_checksum=$(rootless sha256sum "${backup_artifacts[0]}/SHA256SUMS" | cut -d' ' -f1)
node - "$report" "${backup_artifacts[0]}" "$backup_validation" "$backup_checksum" <<'BACKUP_EVIDENCE'
const fs=require('node:fs');const [path,artifact,validation,checksum]=process.argv.slice(2);const r=JSON.parse(fs.readFileSync(path,'utf8'));r.backupEvidence={filesystem:'sshfs',remoteAlias:'codexia-backup-fixture',artifactPath:artifact,validatedBy:'deploy/backup/backup.sh validate-artifact',validation:validation.slice(0,300),sha256SumsFile:checksum,physicalIndependence:'NOT_PROVEN_BY_CI_FIXTURE'};r.states.backup_remote_filesystem={status:'PASS',detail:'canonical deploy transaction created and validated encrypted backup on isolated SSHFS server'};r.updatedAt=new Date().toISOString();fs.writeFileSync(path,JSON.stringify(r,null,2)+'\n',{mode:0o600});
BACKUP_EVIDENCE
set_state first_activation PASS 'fresh schema and API readiness verified on real rootless Podman and PostgreSQL'

run_deploy head false
observe_runtime same-digest-reapply
set_state same_digest_reapply PASS 'same immutable digest remained healthy with stable Quadlet and release record'

rootless_podman exec -i codexia-db sh -ec 'export PGPASSWORD="$(cat /run/secrets/admin-password)"; exec psql -X -q -v ON_ERROR_STOP=1 -U codexia_admin -d codexia' <<'SENTINEL_SQL'
CREATE TABLE codexia_lifecycle_sentinel(id integer PRIMARY KEY, value text NOT NULL);
INSERT INTO codexia_lifecycle_sentinel VALUES (1, 'preserved');
SENTINEL_SQL
run_deploy compatible false
observe_runtime compatible-update
set_state compatible_update PASS 'certified compatible Full image became the sole healthy API writer'

# Deliberately alter only a disposable image entrypoint to exercise real rollback.
failed_context="$build_context/failed"
rootless mkdir -p "$failed_context"
cat > "$tmp/failed.Dockerfile" <<'DOCKERFILE'
ARG BASE_IMAGE
FROM ${BASE_IMAGE}
ENTRYPOINT ["/bin/false"]
DOCKERFILE
sudo install -o codexia -g codexia -m 0644 "$tmp/failed.Dockerfile" "$failed_context/Dockerfile"
compatible_image=$(node -p 'JSON.parse(require("fs").readFileSync(process.env.CODEXIA_LIFECYCLE_EVIDENCE_FILE,"utf8")).candidates.compatible.image')
rootless_podman build --build-arg "BASE_IMAGE=$compatible_image" -t codexia-backend-lifecycle-fail -f "$failed_context/Dockerfile" "$failed_context" >/dev/null
failed_tag="localhost:5000/yohn-jp/codexia-backend:lifecycle-failed-$source_sha"
rootless_podman tag codexia-backend-lifecycle-fail "$failed_tag"
failed_digest_file="$fixture_home/.local/state/codexia-lifecycle-build/failed.digest"
rootless_podman push --digestfile "$failed_digest_file" "$failed_tag" >/dev/null
failed_digest=$(sudo -u codexia cat "$failed_digest_file")
rootless rm -f "$failed_digest_file"
failed_image="ghcr.io/yohn-jp/codexia-backend@$failed_digest"
node "$repo_root/scripts/push-app-lifecycle.mjs" record-failed "$failed_image"
before_failure=$(rootless sha256sum "$fixture_home/.local/state/codexia-deploy/deployed-release.json" | cut -d' ' -f1)
if run_deploy failed false; then echo 'Deliberately failing candidate unexpectedly deployed' >&2; exit 1; fi
observe_runtime failed-candidate-rollback
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
if run_deploy head false "$fault_dir"; then echo 'Injected controller interruption unexpectedly returned success' >&2; exit 1; fi
rootless grep -q '"phase":"pending"' "$fixture_home/.local/state/codexia-deploy/deploy-transaction.json"
run_deploy compatible false
observe_runtime interrupted-recovery
rootless test ! -e "$fixture_home/.local/state/codexia-deploy/deploy-transaction.json"
set_state durable_interruption_recovery PASS 'the next canonical invocation recovered and cleared the durable pending transaction'
set_state database_volume_writer_quadlet_release_continuity PASS 'database sentinel, volume IDs, sole writer, Quadlet and release record were observed after transitions'
node - "$report" <<'REPORT_COMPLETE'
const fs=require('node:fs');const p=process.argv[2],r=JSON.parse(fs.readFileSync(p,'utf8'));r.status='PASS';r.updatedAt=new Date().toISOString();fs.writeFileSync(p,JSON.stringify(r,null,2)+'\n',{mode:0o600});
REPORT_COMPLETE
