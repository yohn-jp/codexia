#!/usr/bin/env bash
set -euo pipefail
: "${CODEXIA_DISPOSABLE_BACKUP_TEST:?This Quadlet recovery test is restricted to the disposable VM fixture}"
test "$(id -u)" -ne 0
systemctl --user show --property=Version >/dev/null
test "$(podman info --format '{{.Host.Security.Rootless}}')" = true

repo_root=$(pwd)
fixture_image=$(sed -n 's/^Image=//p' "$repo_root/deploy/quadlet/codexia-db.container")
test -n "$fixture_image"
quadlet_dir="$HOME/.config/containers/systemd"
unit_dir="$HOME/.config/systemd/user"
state_dir=$(mktemp -d /tmp/codexia-backup-startup-fence.XXXXXX)
intent="$state_dir/backup-intent.json"
snapshot="$state_dir/runtime-identity.json"
api_source="$quadlet_dir/codexia-api.container"
tunnel_source="$quadlet_dir/codexia-tunnel.container"
api_fence="$unit_dir/codexia-api.service.d/90-codexia-backup-recovery.conf"
tunnel_fence="$unit_dir/codexia-tunnel.service.d/90-codexia-backup-recovery.conf"
test ! -e "$api_source" && test ! -L "$api_source"
test ! -e "$tunnel_source" && test ! -L "$tunnel_source"
for container in codexia-api codexia-tunnel; do
  if podman container exists "$container"; then
    echo "Unexpected pre-existing fixture container: $container" >&2
    exit 1
  fi
done

cleanup() {
  local status=$?
  trap - EXIT
  set +e
  systemctl --user stop codexia-tunnel.service codexia-api.service >/dev/null 2>&1
  rm -f -- "$api_source" "$tunnel_source"
  systemctl --user daemon-reload >/dev/null 2>&1
  if test -e "$api_fence" || test -e "$tunnel_fence"; then
    node --input-type=module -e '
      import path from "node:path";
      import {pathToFileURL} from "node:url";
      const root=process.argv[1],quadlet=process.argv[2],state=process.argv[3];
      const {PodmanStandaloneHost}=await import(pathToFileURL(path.join(root,"deploy/updater/standalone-host.mjs")));
      const host=new PodmanStandaloneHost({routeFile:path.join(state,"route"),quadletDirectory:quadlet,githubTokenFile:path.join(state,"token"),
        stateFile:path.join(state,"controller.json"),frontendIdentityUrl:"https://backup-test.invalid/desktop/update-identity.json",browserAuth:{mode:"token"}});
      await host.removeBackupStartupFence();
    ' "$repo_root" "$quadlet_dir" "$state_dir" >/dev/null 2>&1
  fi
  rm -f -- "$XDG_RUNTIME_DIR/codexia-backup-recovery-api.permit" "$XDG_RUNTIME_DIR/codexia-backup-recovery-tunnel.permit"
  rmdir "$unit_dir/codexia-api.service.d" "$unit_dir/codexia-tunnel.service.d" 2>/dev/null
  rmdir "$quadlet_dir" 2>/dev/null
  rmdir "$(dirname "$quadlet_dir")" 2>/dev/null
  rmdir "$(dirname "$(dirname "$quadlet_dir")")" 2>/dev/null
  rm -rf -- "$state_dir"
  exit "$status"
}
trap cleanup EXIT
umask 077
mkdir -p "$quadlet_dir" "$state_dir"
cat > "$api_source" <<EOF
[Unit]
Description=Disposable Codexia API recovery fixture
[Container]
Image=$fixture_image
ContainerName=codexia-api
Network=none
Entrypoint=/bin/sleep
Exec=300
Tmpfs=/var/lib/postgresql/data:rw,nosuid,nodev
[Service]
Restart=no
[Install]
WantedBy=default.target
EOF
cat > "$tunnel_source" <<EOF
[Unit]
Description=Disposable Codexia Tunnel recovery fixture
[Container]
Image=$fixture_image
ContainerName=codexia-tunnel
Network=none
Entrypoint=/bin/sleep
Exec=300
Tmpfs=/var/lib/postgresql/data:rw,nosuid,nodev
[Service]
Restart=no
[Install]
WantedBy=default.target
EOF
chmod 0600 "$api_source" "$tunnel_source"
systemctl --user daemon-reload
systemctl --user start codexia-api.service codexia-tunnel.service
podman inspect codexia-api >/dev/null
podman inspect codexia-tunnel >/dev/null

# Capture live settings and generated Quadlet units before their stop hooks remove containers.
node --input-type=module -e '
  import assert from "node:assert/strict";
  import {execFileSync} from "node:child_process";
  import {writeFile} from "node:fs/promises";
  import path from "node:path";
  import {pathToFileURL} from "node:url";
  const root=process.argv[1],quadlet=process.argv[2],state=process.argv[3],output=process.argv[4];
  const {PodmanStandaloneHost,containerRuntimeFingerprint,containerRuntimeFingerprintProjection}=await import(pathToFileURL(path.join(root,"deploy/updater/standalone-host.mjs")));
  const host=new PodmanStandaloneHost({routeFile:path.join(state,"route"),quadletDirectory:quadlet,githubTokenFile:path.join(state,"token"),
    stateFile:path.join(state,"controller.json"),frontendIdentityUrl:"https://backup-test.invalid/desktop/update-identity.json",browserAuth:{mode:"token"}});
  const api=await host.readBackupQuadletUnit("codexia-api.service","codexia-api.container");
  const apiSecretIdentities=await host.quadletSecretIdentities(api.source);
  const tunnel=await host.legacyBackupTunnelSnapshot();
  const inspect=name=>JSON.parse(execFileSync("podman",["inspect",name],{encoding:"utf8"}))[0];
  const apiInspect=inspect("codexia-api"),tunnelInspect=inspect("codexia-tunnel");
  const identity={apiSource:api.source,apiFragment:api.fragment,apiSecretIdentities,
    apiRuntime:containerRuntimeFingerprint(apiInspect,apiSecretIdentities),
    apiRuntimeProjection:containerRuntimeFingerprintProjection(apiInspect,apiSecretIdentities),
    tunnelSource:tunnel.source,tunnelSecretIdentities:tunnel.secretIdentities,
    tunnelUnitFingerprint:tunnel.unitFingerprint,
    tunnelRuntime:containerRuntimeFingerprint(tunnelInspect,tunnel.secretIdentities),
    tunnelRuntimeProjection:containerRuntimeFingerprintProjection(tunnelInspect,tunnel.secretIdentities),
    autostart:await host.captureBackupAutostart()};
  assert.equal(identity.autostart.apiWasEnabled,true);
  assert.equal(identity.autostart.tunnelWasEnabled,true);
  assert.ok(identity.autostart.autostartLinks.api.generatorTarget);
  assert.ok(identity.autostart.autostartLinks.tunnel.generatorTarget);
  await writeFile(output,JSON.stringify(identity)+"\n",{mode:0o600,flag:"wx"});
  await host.installBackupStartupFence();
' "$repo_root" "$quadlet_dir" "$state_dir" "$snapshot"

# A real generated Quadlet stop removes each Podman container. The generated
# default.target links stay in place; the durable intent condition gates starts.
printf '%s\n' '{"format":"codexia-backup-intent/v3","kind":"legacy"}' > "$intent"
node --input-type=module -e '
  import assert from "node:assert/strict";
  import {execFileSync} from "node:child_process";
  import path from "node:path";
  import {pathToFileURL} from "node:url";
  const root=process.argv[1],quadlet=process.argv[2],state=process.argv[3];
  const {PodmanStandaloneHost}=await import(pathToFileURL(path.join(root,"deploy/updater/standalone-host.mjs")));
  const host=new PodmanStandaloneHost({routeFile:path.join(state,"route"),quadletDirectory:quadlet,githubTokenFile:path.join(state,"token"),
    stateFile:path.join(state,"controller.json"),frontendIdentityUrl:"https://backup-test.invalid/desktop/update-identity.json",browserAuth:{mode:"token"}});
  const autostart=await host.captureBackupAutostart();
  assert.deepEqual(autostart,{...autostart,apiWasEnabled:true,tunnelWasEnabled:true});
  await host.assertBackupAutostartGated({...autostart,timerWasActive:false,tunnelWasActive:true});
' "$repo_root" "$quadlet_dir" "$state_dir"
node --input-type=module -e '
  import path from "node:path";
  import {pathToFileURL} from "node:url";
  const root=process.argv[1],quadlet=process.argv[2],state=process.argv[3],snapshotFile=process.argv[4];
  const {PodmanStandaloneHost}=await import(pathToFileURL(path.join(root,"deploy/updater/standalone-host.mjs")));
  const expected=JSON.parse(await (await import("node:fs/promises")).readFile(snapshotFile,"utf8"));
  const host=new PodmanStandaloneHost({routeFile:path.join(state,"route"),quadletDirectory:quadlet,githubTokenFile:path.join(state,"token"),
    stateFile:path.join(state,"controller.json"),frontendIdentityUrl:"https://backup-test.invalid/desktop/update-identity.json",browserAuth:{mode:"token"}});
  await host.assertBackupAutostartGated({...expected.autostart,timerWasActive:false,tunnelWasActive:true});
' "$repo_root" "$quadlet_dir" "$state_dir" "$snapshot"
systemctl --user stop codexia-tunnel.service codexia-api.service
for container in codexia-api codexia-tunnel; do
  status=0
  podman container exists "$container" || status=$?
  test "$status" = 1
done
systemctl --user reset-failed codexia-api.service codexia-tunnel.service

# Without a recovery permit, systemd must skip both default.target-linked services while
# the durable intent exists. A permitted API restart simulates the recovery crash boundary.
test -L "$XDG_RUNTIME_DIR/systemd/generator/default.target.wants/codexia-api.service"
test -L "$XDG_RUNTIME_DIR/systemd/generator/default.target.wants/codexia-tunnel.service"
systemctl --user start codexia-api.service codexia-tunnel.service
for unit in codexia-api.service codexia-tunnel.service; do
  active_state=$(systemctl --user show --property=ActiveState --value "$unit")
  sub_state=$(systemctl --user show --property=SubState --value "$unit")
  condition_result=$(systemctl --user show --property=ConditionResult --value "$unit")
  if test "$active_state" != inactive || test "$sub_state" != dead || test "$condition_result" != no; then
    systemctl --user show --property=ActiveState --property=SubState --property=Result --property=ConditionResult --property=Conditions "$unit" >&2
    journalctl --user --unit="$unit" --no-pager --lines=12 >&2 || true
    exit 1
  fi
  if ! journalctl --user --unit="$unit" --no-pager --output=cat --lines=12 | grep -Fq 'skipped, no trigger condition checks were met'; then
    echo "$unit did not record a systemd condition skip" >&2
    journalctl --user --unit="$unit" --no-pager --lines=12 >&2 || true
    exit 1
  fi
done
for container in codexia-api codexia-tunnel; do
  status=0
  podman container exists "$container" || status=$?
  test "$status" = 1
done
node --input-type=module -e '
  import assert from "node:assert/strict";
  import {execFileSync} from "node:child_process";
  import path from "node:path";
  import {readFile} from "node:fs/promises";
  import {pathToFileURL} from "node:url";
  const root=process.argv[1],quadlet=process.argv[2],state=process.argv[3],snapshotFile=process.argv[4];
  const {PodmanStandaloneHost,containerRuntimeFingerprint,containerRuntimeFingerprintProjection}=await import(pathToFileURL(path.join(root,"deploy/updater/standalone-host.mjs")));
  const expected=JSON.parse(await readFile(snapshotFile,"utf8"));
  const host=new PodmanStandaloneHost({routeFile:path.join(state,"route"),quadletDirectory:quadlet,githubTokenFile:path.join(state,"token"),
    stateFile:path.join(state,"controller.json"),frontendIdentityUrl:"https://backup-test.invalid/desktop/update-identity.json",browserAuth:{mode:"token"}});
  await host.startLegacyWriter();
  const api=JSON.parse(execFileSync("podman",["inspect","codexia-api"],{encoding:"utf8"}))[0];
  const actualProjection=containerRuntimeFingerprintProjection(api,expected.apiSecretIdentities);
  const differencePaths=(left,right,prefix="")=>{
    if(Array.isArray(left)&&Array.isArray(right)){
      if(left.length!==right.length)return [prefix+"[length]"];
      return left.flatMap((value,index)=>differencePaths(value,right[index],prefix+"["+index+"]"));
    }
    if(left&&right&&typeof left==="object"&&typeof right==="object"&&!Array.isArray(left)&&!Array.isArray(right)){
      const keys=new Set([...Object.keys(left),...Object.keys(right)]);
      return [...keys].flatMap(key=>Object.hasOwn(left,key)&&Object.hasOwn(right,key)
        ?differencePaths(left[key],right[key],prefix?prefix+"."+key:key)
        :[prefix?prefix+"."+key:key]);
    }
    return Object.is(left,right)?[]:[prefix||"<root>"];
  };
  const changedFields=differencePaths(expected.apiRuntimeProjection,actualProjection);
  if(changedFields.length)console.error("API runtime identity changed at fields: "+changedFields.join(", "));
  const changedEnvironmentKeys=changedFields.flatMap(field=>{
    const match=field.match(/^Config\.Env\[(\d+)\]$/);
    if(!match)return [];
    const index=Number(match[1]);
    const key=value=>typeof value==="string"?value.split("=",1)[0]:"<absent>";
    return ["Config.Env["+index+"] keys: "+key(expected.apiRuntimeProjection.Config.Env[index])+" -> "+key(actualProjection.Config.Env[index])];
  });
  if(changedEnvironmentKeys.length)console.error("API runtime environment key drift: "+changedEnvironmentKeys.join(", "));
  assert.equal(containerRuntimeFingerprint(api,expected.apiSecretIdentities),expected.apiRuntime);
  await host.assertBackupAutostartGated({...expected.autostart,timerWasActive:false,tunnelWasActive:true});
' "$repo_root" "$quadlet_dir" "$state_dir" "$snapshot"
test ! -e "$XDG_RUNTIME_DIR/codexia-backup-recovery-api.permit"
test ! -e "$XDG_RUNTIME_DIR/codexia-backup-recovery-tunnel.permit"
test ! -L "$XDG_RUNTIME_DIR/codexia-backup-recovery-api.permit"
test ! -L "$XDG_RUNTIME_DIR/codexia-backup-recovery-tunnel.permit"
test "$(systemctl --user is-active codexia-tunnel.service || true)" = inactive
status=0
podman container exists codexia-tunnel || status=$?
test "$status" = 1

# Drift is rejected before the Tunnel's generated service can recreate its container.
printf '\n# Deliberate recovery drift\n' >> "$tunnel_source"
systemctl --user daemon-reload
node --input-type=module -e '
  import assert from "node:assert/strict";
  import {readFile} from "node:fs/promises";
  import path from "node:path";
  import {pathToFileURL} from "node:url";
  const root=process.argv[1],quadlet=process.argv[2],state=process.argv[3],snapshotFile=process.argv[4];
  const {PodmanStandaloneHost}=await import(pathToFileURL(path.join(root,"deploy/updater/standalone-host.mjs")));
  const expected=JSON.parse(await readFile(snapshotFile,"utf8"));
  const host=new PodmanStandaloneHost({routeFile:path.join(state,"route"),quadletDirectory:quadlet,githubTokenFile:path.join(state,"token"),
    stateFile:path.join(state,"controller.json"),frontendIdentityUrl:"https://backup-test.invalid/desktop/update-identity.json",browserAuth:{mode:"token"}});
  await assert.rejects(host.assertLegacyBackupTunnel({allowStopped:true,expectedIdentity:{unitFingerprint:expected.tunnelUnitFingerprint,runtimeFingerprint:expected.tunnelRuntime}}),/Quadlet\/systemd source drifted/);
' "$repo_root" "$quadlet_dir" "$state_dir" "$snapshot"
systemctl --user start codexia-tunnel.service
test "$(systemctl --user is-active codexia-tunnel.service || true)" = inactive
if podman container exists codexia-tunnel; then
  echo 'Drifted Tunnel Quadlet was started during interrupted recovery' >&2
  exit 1
fi

# Restore the exact captured Quadlet bytes after the deliberate drift check, then start Tunnel
# with its own volatile permit and compare
# its normalized Podman runtime config with the captured pre-stop config.
node --input-type=module -e '
  import {readFile,writeFile} from "node:fs/promises";
  const expected=JSON.parse(await readFile(process.argv[1],"utf8"));
  await writeFile(process.argv[2],expected.tunnelSource,{mode:0o600});
' "$snapshot" "$tunnel_source"
systemctl --user daemon-reload
node --input-type=module -e '
  import assert from "node:assert/strict";
  import {execFileSync} from "node:child_process";
  import {lstat,readFile} from "node:fs/promises";
  import path from "node:path";
  import {pathToFileURL} from "node:url";
  const root=process.argv[1],quadlet=process.argv[2],state=process.argv[3],snapshotFile=process.argv[4];
  const {PodmanStandaloneHost,containerRuntimeFingerprint,containerRuntimeFingerprintProjection}=await import(pathToFileURL(path.join(root,"deploy/updater/standalone-host.mjs")));
  const expected=JSON.parse(await readFile(snapshotFile,"utf8"));
  const host=new PodmanStandaloneHost({routeFile:path.join(state,"route"),quadletDirectory:quadlet,githubTokenFile:path.join(state,"token"),
    stateFile:path.join(state,"controller.json"),frontendIdentityUrl:"https://backup-test.invalid/desktop/update-identity.json",browserAuth:{mode:"token"}});
  const tunnel=await host.readBackupQuadletUnit("codexia-tunnel.service","codexia-tunnel.container");
  assert.equal(tunnel.source,expected.tunnelSource);
  assert.equal((await host.legacyBackupTunnelSnapshot()).unitFingerprint,expected.tunnelUnitFingerprint);
  await host.stopLegacyWriter();
  await host.startTunnel();
  const actual=JSON.parse(execFileSync("podman",["inspect","codexia-tunnel"],{encoding:"utf8"}))[0];
  const actualProjection=containerRuntimeFingerprintProjection(actual,expected.tunnelSecretIdentities);
  const differencePaths=(left,right,prefix="")=>{
    if(Array.isArray(left)&&Array.isArray(right)){
      if(left.length!==right.length)return [prefix+"[length]"];
      return left.flatMap((value,index)=>differencePaths(value,right[index],prefix+"["+index+"]"));
    }
    if(left&&right&&typeof left==="object"&&typeof right==="object"&&!Array.isArray(left)&&!Array.isArray(right)){
      const keys=new Set([...Object.keys(left),...Object.keys(right)]);
      return [...keys].flatMap(key=>Object.hasOwn(left,key)&&Object.hasOwn(right,key)
        ?differencePaths(left[key],right[key],prefix?prefix+"."+key:key)
        :[prefix?prefix+"."+key:key]);
    }
    return Object.is(left,right)?[]:[prefix||"<root>"];
  };
  const changedFields=differencePaths(expected.tunnelRuntimeProjection,actualProjection);
  if(changedFields.length)console.error("Tunnel runtime identity changed at fields: "+changedFields.join(", "));
  const changedEnvironmentKeys=changedFields.flatMap(field=>{
    const match=field.match(/^Config\.Env\[(\d+)\]$/);
    if(!match)return [];
    const index=Number(match[1]);
    const key=value=>typeof value==="string"?value.split("=",1)[0]:"<absent>";
    return ["Config.Env["+index+"] keys: "+key(expected.tunnelRuntimeProjection.Config.Env[index])+" -> "+key(actualProjection.Config.Env[index])];
  });
  if(changedEnvironmentKeys.length)console.error("Tunnel runtime environment key drift: "+changedEnvironmentKeys.join(", "));
  assert.equal(containerRuntimeFingerprint(actual,expected.tunnelSecretIdentities),expected.tunnelRuntime);
  assert.equal(await host.legacyServiceActive(),false,"Tunnel permit started the API writer");
  await assert.rejects(lstat(host.backupStartupFencePaths().tunnel.permit),{code:"ENOENT"});
  await host.startLegacyWriter();
  assert.equal(await host.tunnelServiceActive(),true,"API permit changed Tunnel activity");
  const api=JSON.parse(execFileSync("podman",["inspect","codexia-api"],{encoding:"utf8"}))[0];
  assert.equal(containerRuntimeFingerprint(api,expected.apiSecretIdentities),expected.apiRuntime);
  await assert.rejects(lstat(host.backupStartupFencePaths().api.permit),{code:"ENOENT"});
  await host.assertLegacyBackupTunnel({allowStopped:true,expectedIdentity:{unitFingerprint:expected.tunnelUnitFingerprint,runtimeFingerprint:expected.tunnelRuntime}});
  await host.removeBackupStartupPermits();
  await host.assertBackupAutostartGated({...expected.autostart,timerWasActive:false,tunnelWasActive:true});
' "$repo_root" "$quadlet_dir" "$state_dir" "$snapshot"
test ! -e "$XDG_RUNTIME_DIR/codexia-backup-recovery-api.permit"
test ! -e "$XDG_RUNTIME_DIR/codexia-backup-recovery-tunnel.permit"
test ! -L "$XDG_RUNTIME_DIR/codexia-backup-recovery-api.permit"
test ! -L "$XDG_RUNTIME_DIR/codexia-backup-recovery-tunnel.permit"
test "$(systemctl --user is-active codexia-api.service || true)" = active
rm -f -- "$intent"
node --input-type=module -e '
  import path from "node:path";
  import {pathToFileURL} from "node:url";
  const root=process.argv[1],quadlet=process.argv[2],state=process.argv[3];
  const {PodmanStandaloneHost}=await import(pathToFileURL(path.join(root,"deploy/updater/standalone-host.mjs")));
  const host=new PodmanStandaloneHost({routeFile:path.join(state,"route"),quadletDirectory:quadlet,githubTokenFile:path.join(state,"token"),
    stateFile:path.join(state,"controller.json"),frontendIdentityUrl:"https://backup-test.invalid/desktop/update-identity.json",browserAuth:{mode:"token"}});
  await host.removeBackupStartupFence();
' "$repo_root" "$quadlet_dir" "$state_dir"
printf '%s\n' 'Rootless Quadlet stop removal, interrupted startup gating, and pre-restart Tunnel drift rejection succeeded.'
