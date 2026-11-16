#!/usr/bin/env bash
set -euo pipefail
: "${CODEXIA_DISPOSABLE_BACKUP_TEST:?This systemd fence test is restricted to the disposable VM fixture}"
test "$(id -u)" -ne 0
systemctl --user show --property=Version >/dev/null

tmp=$(mktemp -d /tmp/codexia-backup-startup-fence.XXXXXX)
unit_dir="$HOME/.config/systemd/user"
quadlet_dir="$HOME/.config/containers/systemd"
state_dir="$tmp/state"
intent="$tmp/backup-intent.json"
api_unit="$unit_dir/codexia-api.service"
tunnel_unit="$unit_dir/codexia-tunnel.service"
api_dropin_dir="$unit_dir/codexia-api.service.d"
tunnel_dropin_dir="$unit_dir/codexia-tunnel.service.d"
api_dropin="$api_dropin_dir/90-codexia-backup-recovery.conf"
tunnel_dropin="$tunnel_dropin_dir/90-codexia-backup-recovery.conf"
api_marker="$tmp/api-started"
tunnel_marker="$tmp/tunnel-started"

for target in "$api_unit" "$tunnel_unit" "$api_dropin_dir" "$tunnel_dropin_dir" "$quadlet_dir" "$intent" "$api_marker" "$tunnel_marker"; do
  test ! -e "$target" && test ! -L "$target"
done
cleanup() {
  local status=$?
  trap - EXIT
  set +e
  systemctl --user stop codexia-tunnel.service codexia-api.service >/dev/null 2>&1
  systemctl --user disable codexia-tunnel.service codexia-api.service >/dev/null 2>&1
  node --input-type=module -e '
    import path from "node:path";
    import {pathToFileURL} from "node:url";
    const root=process.argv[1],quadlet=process.argv[2],state=process.argv[3];
    const {PodmanStandaloneHost}=await import(pathToFileURL(path.join(root,"deploy/updater/standalone-host.mjs")));
    const host=new PodmanStandaloneHost({routeFile:path.join(state,"route"),quadletDirectory:quadlet,githubTokenFile:path.join(state,"token"),
      stateFile:path.join(state,"controller.json"),frontendIdentityUrl:"https://backup-test.invalid/desktop/update-identity.json",browserAuth:{mode:"token"}});
    await host.removeBackupStartupFence();
  ' "$repo_root" "$quadlet_dir" "$state_dir" >/dev/null 2>&1
  rm -f -- "$api_dropin" "$tunnel_dropin" "$api_unit" "$tunnel_unit"
  rmdir "$unit_dir/codexia-api.service.d" "$unit_dir/codexia-tunnel.service.d" 2>/dev/null
  rmdir "$quadlet_dir" 2>/dev/null
  rmdir "$(dirname "$quadlet_dir")" 2>/dev/null
  rmdir "$(dirname "$(dirname "$quadlet_dir")")" 2>/dev/null
  systemctl --user daemon-reload >/dev/null 2>&1
  rm -rf -- "$tmp"
  exit "$status"
}
trap cleanup EXIT

mkdir -p "$tmp" "$unit_dir"
mkdir -p "$quadlet_dir" "$state_dir"
cat > "$tmp/start-api" <<EOF
#!/bin/sh
touch '$api_marker'
EOF
cat > "$tmp/start-tunnel" <<EOF
#!/bin/sh
touch '$tunnel_marker'
EOF
chmod 0700 "$tmp/start-api" "$tmp/start-tunnel"
cat > "$api_unit" <<EOF
[Unit]
Description=Disposable legacy API startup-fence fixture
[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=$tmp/start-api
[Install]
WantedBy=default.target
EOF
cat > "$tunnel_unit" <<EOF
[Unit]
Description=Disposable legacy Tunnel startup-fence fixture
Requires=codexia-api.service
After=codexia-api.service
[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=$tmp/start-tunnel
[Install]
WantedBy=default.target
EOF
systemctl --user daemon-reload
systemctl --user enable codexia-api.service codexia-tunnel.service >/dev/null
node --input-type=module -e '
  import path from "node:path";
  import {pathToFileURL} from "node:url";
  const root=process.argv[1],quadlet=process.argv[2],state=process.argv[3];
  const {PodmanStandaloneHost}=await import(pathToFileURL(path.join(root,"deploy/updater/standalone-host.mjs")));
  const host=new PodmanStandaloneHost({routeFile:path.join(state,"route"),quadletDirectory:quadlet,githubTokenFile:path.join(state,"token"),
    stateFile:path.join(state,"controller.json"),frontendIdentityUrl:"https://backup-test.invalid/desktop/update-identity.json",browserAuth:{mode:"token"}});
  await host.installBackupStartupFence();
  await host.installBackupStartupFence();
' "$repo_root" "$quadlet_dir" "$state_dir"

# A reboot with a durable backup intent must not launch the legacy writer or ingress before the locked recovery unit.
printf '%s\n' 'codexia-backup-intent/v1' > "$intent"
systemctl --user start codexia-api.service codexia-tunnel.service
test ! -e "$api_marker"
test ! -e "$tunnel_marker"
test "$(systemctl --user show --property=ActiveState --value codexia-api.service)" = inactive
test "$(systemctl --user show --property=ActiveState --value codexia-tunnel.service)" = inactive
test "$(systemctl --user show --property=ConditionResult --value codexia-tunnel.service)" = no

# Once the locked recovery has cleared the intent, the original services may start normally.
rm -- "$intent"
systemctl --user daemon-reload
systemctl --user start codexia-api.service
systemctl --user start codexia-tunnel.service
test -e "$api_marker"
test -e "$tunnel_marker"
printf '%s\n' 'Systemd startup fences suppress legacy API and Tunnel while backup recovery intent exists.'
