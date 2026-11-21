#!/usr/bin/env bash
# Exercise actual Ubuntu guest reboot recovery under rootless systemd/Podman.
set -Eeuo pipefail
umask 077

fail() { printf '%s\n' "$*" >&2; exit 1; }
[[ "${GITHUB_ACTIONS:-}" == true && "${CODEXIA_DISPOSABLE_HOST:-}" == phase-f-push-vm-reboot ]] || fail 'Run only inside the dedicated disposable Phase F VM reboot workflow.'
[[ -n "${RUNNER_TEMP:-}" && -d "$RUNNER_TEMP" && "${GITHUB_SHA:-}" =~ ^[a-f0-9]{40}$ && "${GITHUB_RUN_ID:-}" =~ ^[0-9]+$ ]] || fail 'GitHub run evidence environment is incomplete.'
ansible_playbook=${ANSIBLE_PLAYBOOK:-}
[[ -x "$ansible_playbook" ]] || fail 'The isolated Ansible control environment is unavailable.'
for tool in curl cloud-localds qemu-img qemu-system-x86_64 ssh ssh-keygen ssh-keyscan timeout; do command -v "$tool" >/dev/null 2>&1 || fail "Required VM tool is unavailable: $tool"; done

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)
service_user=codexia
service_uid=22001
service_group=codexia
service_gid=22001
service_home=/home/codexia
bootstrap_user=codexia-bootstrap
image_url=https://cloud-images.ubuntu.com/releases/resolute/release-20261108/ubuntu-26.04-server-cloudimg-amd64.img
image_sha256=7b90593f5532b49b7e3fe3d2743f0d1f0d822e5b07cebcd8e00c0df8069ecab9
vm_port=2222
phase=capability-check
failure_code=FIXTURE_ASSERTION_FAILED
identity_before=''; volume_before=''; image_id_before=''; boot_id_before=''
identity_after=''; volume_after=''; image_id_after=''; boot_id_after=''
qemu_pid=''

tmp=$(mktemp -d "$RUNNER_TEMP/codexia-phase-f-vm-reboot.XXXXXX")
evidence_dir="$RUNNER_TEMP/codexia-phase-f-vm-reboot-evidence"
mkdir -m 0700 "$evidence_dir"
private_key="$tmp/bootstrap_ed25519"
known_hosts="$tmp/known_hosts"
image="$tmp/ubuntu-26.04-server-cloudimg-amd64.img"
overlay="$tmp/guest-overlay.qcow2"
seed="$tmp/seed.iso"
serial_log="$tmp/guest-serial.log"
qemu_pidfile="$tmp/qemu.pid"
ssh_opts=(-p "$vm_port" -i "$private_key" -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=5 -o UserKnownHostsFile="$known_hosts" -o StrictHostKeyChecking=yes)
remote="$bootstrap_user@127.0.0.1"
guest_sudo() { ssh "${ssh_opts[@]}" "$remote" 'sudo -n bash -s'; }
cleanup() {
  local status=$? cleanup_status=0 outcome
  trap - EXIT
  set +e
  if [[ -n "$qemu_pid" ]] && kill -0 "$qemu_pid" >/dev/null 2>&1; then
    kill -TERM "$qemu_pid" >/dev/null 2>&1 || cleanup_status=1
    for _ in {1..20}; do kill -0 "$qemu_pid" >/dev/null 2>&1 || break; sleep 1; done
    if kill -0 "$qemu_pid" >/dev/null 2>&1; then
      kill -KILL "$qemu_pid" >/dev/null 2>&1 || cleanup_status=1
      for _ in {1..5}; do kill -0 "$qemu_pid" >/dev/null 2>&1 || break; sleep 1; done
      kill -0 "$qemu_pid" >/dev/null 2>&1 && cleanup_status=1
    fi
  fi
  if [[ -n "${tmp:-}" && "$tmp" == "$RUNNER_TEMP"/codexia-phase-f-vm-reboot.* && -d "$tmp" && ! -L "$tmp" ]]; then
    rm -rf -- "$tmp" || cleanup_status=1
  fi
  if (( status == 0 && cleanup_status != 0 )); then status=$cleanup_status; fi
  if (( cleanup_status != 0 )); then failure_code=CLEANUP_FAILED; fi
  if (( status == 0 )); then outcome=PASS; else outcome=FAIL; fi
  if [[ -n "${evidence_dir:-}" && -d "$evidence_dir" ]]; then
    node --input-type=module - "$evidence_dir/vm-reboot-result.json" "$outcome" "$status" "$phase" "$failure_code" \
      "$identity_before" "$volume_before" "$image_id_before" "$boot_id_before" "$identity_after" "$volume_after" "$image_id_after" "$boot_id_after" <<'NODE'
import { writeFile } from 'node:fs/promises';
const [file, outcome, exitStatus, lastPhase, failureCode, idBefore, volumeBefore, imageBefore, bootBefore, idAfter, volumeAfter, imageAfter, bootAfter] = process.argv.slice(2);
const result = {
  format: 'codexia-phase-f-push-vm-reboot/v1', sourceSha: process.env.GITHUB_SHA,
  workflowRunId: process.env.GITHUB_RUN_ID, runAttempt: process.env.GITHUB_RUN_ATTEMPT,
  runnerName: process.env.RUNNER_NAME, outcome, exitStatus: Number(exitStatus), lastPhase, failureCode,
  guest: { image: 'Ubuntu 26.04 amd64 cloud image release-20261108', imageSha256: '7b90593f5532b49b7e3fe3d2743f0d1f0d822e5b07cebcd8e00c0df8069ecab9',
    qemuAcceleration: 'tcg-threaded',
    serviceUser: 'codexia', serviceUid: 22001, serviceGroup: 'codexia', serviceGid: 22001, serviceHome: '/home/codexia',
    rebootObserved: outcome === 'PASS' && bootBefore !== bootAfter, bootIdBefore: bootBefore || null, bootIdAfter: bootAfter || null },
  persistence: { postgresSystemIdentifierBefore: idBefore || null, postgresSystemIdentifierAfter: idAfter || null,
    postgresSystemIdentifierPreserved: outcome === 'PASS' && idBefore === idAfter, volumeBefore: volumeBefore || null,
    volumeAfter: volumeAfter || null, volumeIdentityPreserved: outcome === 'PASS' && volumeBefore === volumeAfter,
    imageIdBefore: imageBefore || null, imageIdAfter: imageAfter || null, markerRowPreserved: outcome === 'PASS', databaseReadinessAfterReboot: outcome === 'PASS' },
  lifecycleBoundary: 'This proves guest reboot recovery of the isolated rootless PostgreSQL fixture and host service account only. It does not prove the push deployment playbook, Codexia API readiness, release rollback, live VM/Tailscale access, or production acceptance.'
};
if (!/^[a-f0-9]{40}$/u.test(result.sourceSha ?? '') || !/^\d+$/u.test(result.workflowRunId ?? '') || !result.runnerName) throw new Error('Refusing unbound Phase F VM reboot evidence.');
if (outcome === 'PASS' && (bootBefore === bootAfter || idBefore !== idAfter || volumeBefore !== volumeAfter)) throw new Error('Refusing PASS without changed guest boot ID and preserved DB/volume identity.');
await writeFile(file, JSON.stringify(result, null, 2) + '\n', { mode: 0o644, flag: 'wx' });
NODE
    if (( $? != 0 )); then cleanup_status=1; status=1; fi
  else cleanup_status=1; status=1; fi
  if (( status == 0 && cleanup_status != 0 )); then status=$cleanup_status; fi
  printf 'Phase F VM reboot fixture exited with status=%s cleanup=%s outcome=%s phase=%s.\n' "$status" "$cleanup_status" "$outcome" "$phase" >&2
  exit "$status"
}
trap cleanup EXIT

phase=download-pinned-guest-image
curl --fail --location --silent --show-error "$image_url" --output "$image"
printf '%s  %s\n' "$image_sha256" "$image" | sha256sum --check --status || fail 'Pinned Ubuntu guest image checksum mismatch.'
ssh-keygen -q -t ed25519 -N '' -f "$private_key" -C codexia-phase-f-vm-fixture
public_key=$(ssh-keygen -y -f "$private_key")
qemu-img create -f qcow2 -F qcow2 -b "$image" "$overlay" 16G >/dev/null
cat > "$tmp/user-data" <<EOF
#cloud-config
users:
  - name: $bootstrap_user
    groups: [sudo]
    shell: /bin/bash
    sudo: ALL=(ALL) NOPASSWD:ALL
    lock_passwd: true
    ssh_authorized_keys:
      - $public_key
ssh_pwauth: false
disable_root: true
EOF
cat > "$tmp/meta-data" <<EOF
instance-id: codexia-phase-f-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}
local-hostname: codexia-phase-f-reboot
EOF
cloud-localds "$seed" "$tmp/user-data" "$tmp/meta-data"

phase=qemu-guest-boot
# TCG provides a genuine guest kernel and reboot path without nested KVM support.
# Keep this on a dedicated runner; do not substitute a host service restart.
qemu-system-x86_64 -machine type=q35 -accel tcg,thread=multi -cpu max -smp 2 -m 4096 \
  -drive "file=$overlay,if=virtio,format=qcow2" -drive "file=$seed,media=cdrom,readonly=on" \
  -netdev "user,id=net0,hostfwd=tcp:127.0.0.1:$vm_port-:22" -device virtio-net-pci,netdev=net0 \
  -display none -serial "file:$serial_log" -monitor none -daemonize -pidfile "$qemu_pidfile"
qemu_pid=$(cat "$qemu_pidfile")
[[ "$qemu_pid" =~ ^[0-9]+$ ]] || fail 'QEMU did not publish a valid guest process ID.'
phase=guest-ssh-readiness
for _ in {1..120}; do
  : > "$tmp/keyscan"
  if timeout 5 ssh-keyscan -p "$vm_port" -t ed25519 127.0.0.1 > "$tmp/keyscan" 2>/dev/null && [[ -s "$tmp/keyscan" ]]; then install -m 0600 "$tmp/keyscan" "$known_hosts"; break; fi
  sleep 3
done
[[ -s "$known_hosts" ]] || fail 'Timed out waiting for the disposable VM SSH host key.'
ssh-keygen -lf "$known_hosts" >/dev/null || fail 'Disposable VM SSH host key was malformed.'
ssh "${ssh_opts[@]}" "$remote" 'sudo -n cloud-init status --wait' >/dev/null || fail 'Cloud-init did not finish successfully in the disposable guest.'

phase=ansible-host-bootstrap
inventory="$tmp/guest-inventory.json"
python3 - "$inventory" "$private_key" "$known_hosts" <<'PY'
import json, sys
path, key_file, known_hosts = sys.argv[1:]
host = {
    "ansible_host": "127.0.0.1", "ansible_port": 2222,
    "ansible_user": "codexia-bootstrap", "ansible_connection": "ssh",
    "ansible_become": True, "ansible_python_interpreter": "/usr/bin/python3",
    "ansible_ssh_private_key_file": key_file,
    "ansible_ssh_common_args": f"-o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile={known_hosts}",
}
group_vars = {
    "codexia_stage": "host", "codexia_host_approved": True,
    "codexia_create_service_account": True, "codexia_service_user": "codexia",
    "codexia_service_group": "codexia", "codexia_service_uid": 22001,
    "codexia_service_gid": 22001, "codexia_service_home": "/home/codexia",
}
inventory = {"all": {"children": {"codexia": {"hosts": {"phase-f-guest": host}, "vars": group_vars}}}}
with open(path,"w",encoding="utf-8") as output: json.dump(inventory,output)
PY
if [[ -n "${CODEXIA_HOST_CONVERGENCE:-}" ]]; then
  [[ -x "$CODEXIA_HOST_CONVERGENCE" ]] || fail 'Configured host convergence callable is not executable.'
  "$CODEXIA_HOST_CONVERGENCE" "$inventory" host | tee "$tmp/host-first.log"
  "$CODEXIA_HOST_CONVERGENCE" "$inventory" host | tee "$tmp/host-repeat.log"
else
  "$ansible_playbook" -i "$inventory" "$repo_root/deploy/ansible/site.yml" | tee "$tmp/host-first.log"
  "$ansible_playbook" -i "$inventory" "$repo_root/deploy/ansible/site.yml" | tee "$tmp/host-repeat.log"
fi
grep -Eq 'changed=[1-9][0-9]*' "$tmp/host-first.log" || fail 'Fresh remote Ansible host convergence reported no changes.'
grep -q 'changed=0' "$tmp/host-repeat.log" || fail 'Repeated remote Ansible host convergence was not idempotent.'

phase=fixture-postgres-install
guest_sudo <<'GUEST'
set -Eeuo pipefail
install -d -o codexia -g codexia -m 0700 /home/codexia/.local/state/phase-f-vm-reboot
install -d -o codexia -g codexia -m 0700 /home/codexia/.local/share
install -d -o codexia -g codexia -m 0700 /home/codexia/.config
install -d -o codexia -g codexia -m 0700 /home/codexia/.config/containers
install -d -o codexia -g codexia -m 0700 /home/codexia/.config/containers/systemd
test "$(stat -c '%U:%G' /home/codexia/.config)" = codexia:codexia
test "$(stat -c '%U:%G' /home/codexia/.config/containers)" = codexia:codexia
test "$(stat -c '%U:%G' /home/codexia/.config/containers/systemd)" = codexia:codexia
secret_file=/home/codexia/.local/state/phase-f-vm-reboot/postgres-password
sudo -u codexia bash -c 'umask 077; openssl rand -hex 32 > "$1"' _ "$secret_file"
cd /
sudo -H -u codexia env HOME=/home/codexia XDG_CONFIG_HOME=/home/codexia/.config XDG_DATA_HOME=/home/codexia/.local/share XDG_STATE_HOME=/home/codexia/.local/state XDG_RUNTIME_DIR=/run/user/22001 DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/22001/bus /usr/bin/podman secret create phase-f-vm-reboot-postgres-password "$secret_file" >/dev/null
sudo -H -u codexia env HOME=/home/codexia XDG_CONFIG_HOME=/home/codexia/.config XDG_DATA_HOME=/home/codexia/.local/share XDG_STATE_HOME=/home/codexia/.local/state XDG_RUNTIME_DIR=/run/user/22001 DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/22001/bus bash -s <<'SERVICE'
set -Eeuo pipefail
cd "$HOME"
dir="$HOME/.config/containers/systemd"
cat > "$dir/phase-f-vm-reboot-postgres.volume" <<'QUADLET'
[Volume]
VolumeName=phase-f-vm-reboot-postgres
QUADLET
cat > "$dir/phase-f-vm-reboot-db.container" <<'QUADLET'
[Unit]
Description=Disposable Phase F reboot continuity PostgreSQL
[Container]
Image=docker.io/library/postgres:17-bookworm@sha256:40865bc877a289da75963d97d72b59633f639fc5af7a4e856bfa3714cae5b536
ContainerName=phase-f-vm-reboot-db
Network=none
Volume=phase-f-vm-reboot-postgres.volume:/var/lib/postgresql/data
Secret=phase-f-vm-reboot-postgres-password,type=mount,target=/run/secrets/postgres-password
Environment=POSTGRES_DB=codexia
Environment=POSTGRES_USER=codexia_admin
Environment=POSTGRES_PASSWORD_FILE=/run/secrets/postgres-password
Environment=PGDATA=/var/lib/postgresql/data/pgdata
ReadOnly=true
Tmpfs=/tmp:rw,nosuid,nodev,noexec,size=64m
Tmpfs=/var/run/postgresql:rw,nosuid,nodev,noexec,size=16m
NoNewPrivileges=true
HealthCmd=pg_isready -U codexia_admin -d codexia
HealthInterval=5s
HealthTimeout=3s
HealthStartPeriod=20s
HealthRetries=12
[Service]
Restart=on-failure
RestartSec=2s
TimeoutStartSec=120
[Install]
WantedBy=default.target
QUADLET
/usr/bin/systemctl --user daemon-reload
if ! /usr/bin/systemctl --user start phase-f-vm-reboot-postgres-volume.service; then
  printf '%s\n' 'Sanitized diagnostics for the fixture PostgreSQL volume unit:' >&2
  {
    /usr/bin/systemctl --user show phase-f-vm-reboot-postgres-volume.service --property=ActiveState,SubState,Result,ExecMainStatus --no-pager 2>&1 || true
    /usr/bin/journalctl --user --boot --no-pager --lines=40 --unit=phase-f-vm-reboot-postgres-volume.service 2>&1 || true
  } | sed -E 's/[A-Fa-f0-9]{64}/[redacted-digest]/g' >&2
  exit 1
fi
/usr/bin/systemctl --user start phase-f-vm-reboot-db.service
for _ in {1..120}; do /usr/bin/podman exec phase-f-vm-reboot-db pg_isready -U codexia_admin -d codexia >/dev/null 2>&1 && break; sleep 2; done
/usr/bin/podman exec phase-f-vm-reboot-db pg_isready -U codexia_admin -d codexia >/dev/null
/usr/bin/podman exec -i phase-f-vm-reboot-db psql -v ON_ERROR_STOP=1 -U codexia_admin -d codexia <<'SQL'
CREATE TABLE phase_f_reboot_marker (id integer PRIMARY KEY, value text NOT NULL);
INSERT INTO phase_f_reboot_marker (id, value) VALUES (1, 'persisted-before-real-guest-reboot');
SQL
/usr/bin/podman healthcheck run phase-f-vm-reboot-db
SERVICE
GUEST

read_guest_state() {
  guest_sudo <<'GUEST'
set -Eeuo pipefail
cd /
sudo -H -u codexia env HOME=/home/codexia XDG_CONFIG_HOME=/home/codexia/.config XDG_DATA_HOME=/home/codexia/.local/share XDG_STATE_HOME=/home/codexia/.local/state XDG_RUNTIME_DIR=/run/user/22001 DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/22001/bus bash -s <<'SERVICE'
set -Eeuo pipefail
cd "$HOME"
podman exec phase-f-vm-reboot-db pg_isready -U codexia_admin -d codexia >/dev/null
systemctl --user is-active phase-f-vm-reboot-db.service >/dev/null
podman healthcheck run phase-f-vm-reboot-db >/dev/null
cluster=$(podman exec phase-f-vm-reboot-db psql -At -U codexia_admin -d codexia -c 'SELECT system_identifier FROM pg_control_system()')
marker=$(podman exec phase-f-vm-reboot-db psql -At -U codexia_admin -d codexia -c 'SELECT value FROM phase_f_reboot_marker WHERE id=1')
volume=$(podman volume inspect --format '{{.Name}}|{{.Mountpoint}}|{{.Driver}}' phase-f-vm-reboot-postgres)
image_id=$(podman inspect --format '{{.Image}}' phase-f-vm-reboot-db)
running=$(podman ps --filter name=phase-f-vm-reboot-db --format '{{.Names}}')
[[ "$running" == phase-f-vm-reboot-db ]]
printf 'boot_id=%s\ncluster_id=%s\nmarker=%s\nvolume=%s\nimage_id=%s\n' "$(cat /proc/sys/kernel/random/boot_id)" "$cluster" "$marker" "$volume" "$image_id"
SERVICE
GUEST
}

phase=record-pre-reboot-identities
ssh "${ssh_opts[@]}" "$remote" 'sudo -n loginctl show-user codexia --property=Linger --value' | grep -qx yes || fail 'codexia lingering was not active before reboot.'
state_before=$(read_guest_state)
boot_id_before=$(printf '%s\n' "$state_before" | sed -n 's/^boot_id=//p')
identity_before=$(printf '%s\n' "$state_before" | sed -n 's/^cluster_id=//p')
volume_before=$(printf '%s\n' "$state_before" | sed -n 's/^volume=//p')
image_id_before=$(printf '%s\n' "$state_before" | sed -n 's/^image_id=//p')
[[ -n "$boot_id_before" && -n "$identity_before" && -n "$volume_before" && -n "$image_id_before" ]] || fail 'Pre-reboot PostgreSQL identities were incomplete.'
[[ "$(printf '%s\n' "$state_before" | sed -n 's/^marker=//p')" == persisted-before-real-guest-reboot ]] || fail 'Pre-reboot marker row was unexpected.'

phase=request-guest-reboot
set +e
ssh "${ssh_opts[@]}" "$remote" 'sudo -n systemctl reboot' >/dev/null 2>&1
reboot_ssh_status=$?
set -e
# SSH normally returns 255 while systemd tears down the guest. The changed boot
# ID, not that connection loss, proves that a VM reboot actually happened.
[[ "$reboot_ssh_status" == 0 || "$reboot_ssh_status" == 255 ]] || fail 'Guest reboot command failed before disconnect.'
phase=wait-for-new-guest-boot-id
for _ in {1..150}; do
  current_boot=$(ssh "${ssh_opts[@]}" "$remote" 'cat /proc/sys/kernel/random/boot_id' 2>/dev/null || true)
  if [[ -n "$current_boot" && "$current_boot" != "$boot_id_before" ]]; then boot_id_after=$current_boot; break; fi
  sleep 2
done
[[ -n "$boot_id_after" && "$boot_id_after" != "$boot_id_before" ]] || fail 'A changed guest boot ID was not observed after reboot.'

phase=post-reboot-service-and-data-readiness
ssh "${ssh_opts[@]}" "$remote" 'sudo -n loginctl show-user codexia --property=Linger --value' | grep -qx yes || fail 'codexia lingering did not survive reboot.'
state_after=$(read_guest_state)
boot_from_guest=$(printf '%s\n' "$state_after" | sed -n 's/^boot_id=//p')
identity_after=$(printf '%s\n' "$state_after" | sed -n 's/^cluster_id=//p')
volume_after=$(printf '%s\n' "$state_after" | sed -n 's/^volume=//p')
image_id_after=$(printf '%s\n' "$state_after" | sed -n 's/^image_id=//p')
[[ "$boot_from_guest" == "$boot_id_after" ]] || fail 'Post-reboot guest boot ID did not match the observed new boot.'
[[ "$identity_after" == "$identity_before" ]] || fail 'PostgreSQL cluster system identifier changed across guest reboot.'
[[ "$volume_after" == "$volume_before" ]] || fail 'PostgreSQL volume identity changed across guest reboot.'
[[ "$image_id_after" == "$image_id_before" ]] || fail 'PostgreSQL image identity changed across guest reboot.'
[[ "$(printf '%s\n' "$state_after" | sed -n 's/^marker=//p')" == persisted-before-real-guest-reboot ]] || fail 'PostgreSQL marker row did not survive guest reboot.'
phase=passed
printf '%s\n' 'PASS: observed a new QEMU guest boot ID with rootless PostgreSQL readiness, cluster identity, persistent volume identity, and marker row preserved.'
