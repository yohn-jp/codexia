#!/usr/bin/env bash
# Only run on a disposable CI VM. All credentials below are synthetic fixtures.
set -euo pipefail
test "${GITHUB_ACTIONS:-}" = true
test "$(lsb_release -rs)" = 26.04
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
umask 077
service_user=${CODEXIA_SERVICE_USER:?missing rootless fixture identity}
service_uid=$(id -u "$service_user")
service_home=$(getent passwd "$service_user" | cut -d: -f6)
test "$(id -un)" != "$service_user"
sudo -n true
as_service() {
  sudo -u "$service_user" env HOME="$service_home" XDG_CONFIG_HOME="$service_home/.config" XDG_DATA_HOME="$service_home/.local/share" XDG_STATE_HOME="$service_home/.local/state" XDG_RUNTIME_DIR="/run/user/$service_uid" DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$service_uid/bus" bash -c 'cd "$HOME" && exec "$@"' bash "$@"
}
podman() { as_service /usr/bin/podman "$@"; }
systemctl() {
  if [[ "${1:-}" == --user ]]; then as_service /usr/bin/systemctl "$@"; else command systemctl "$@"; fi
}
export XDG_RUNTIME_DIR="/run/user/$service_uid"
export DBUS_SESSION_BUS_ADDRESS="unix:path=$XDG_RUNTIME_DIR/bus"
for _ in $(seq 1 20); do
  if systemctl --user show --property=Version >/dev/null 2>&1; then break; fi
  sleep 1
done
systemctl --user show --property=Version
test "$(podman info --format '{{.Host.Security.Rootless}}')" = true
for name in codexia-auth-token codexia-tunnel-token codexia-postgres-admin-password codexia-postgres-app-password; do
  rc=0; podman secret exists "$name" || rc=$?
  test "$rc" = 1
done
for name in codexia-postgres codexia-data codexia-history; do
  rc=0; podman volume exists "$name" || rc=$?
  test "$rc" = 1
done
printf 'fixture-auth-token' > "$tmp/auth"
printf 'fixture-tunnel-token\n' > "$tmp/tunnel"
printf '%064d' 1 > "$tmp/admin"
printf '%064d\n' 2 > "$tmp/app"
cat > "$tmp/inventory.yml" <<YAML
all:
  children:
    codexia:
      hosts:
        localhost:
          ansible_connection: local
          ansible_python_interpreter: /usr/bin/python3
      vars:
        codexia_stage: secrets
        codexia_service_user: $service_user
        codexia_service_uid: $service_uid
        codexia_service_home: "$service_home"
        codexia_secrets_approved: true
        codexia_auth_token_file: "$tmp/auth"
        codexia_tunnel_token_file: "$tmp/tunnel"
        codexia_postgres_admin_password_file: "$tmp/admin"
        codexia_postgres_app_password_file: "$tmp/app"
YAML
apply() { ANSIBLE_LOCAL_TEMP="$tmp/ansible-local" "${ANSIBLE_PLAYBOOK:-ansible-playbook}" -i "$tmp/inventory.yml" deploy/ansible/site.yml; }
apply > "$tmp/first.log" || { cat "$tmp/first.log"; exit 1; }
for pair in 'auth codexia-auth-token' 'tunnel codexia-tunnel-token' 'admin codexia-postgres-admin-password' 'app codexia-postgres-app-password'; do
  read -r file name <<< "$pair"
  podman secret inspect --showsecret "$name" | jq -j '.[0].SecretData' | cmp - "$tmp/$file"
done
apply > "$tmp/repeat.log" || { cat "$tmp/repeat.log"; exit 1; }
grep -q 'changed=0' "$tmp/repeat.log"
podman volume create codexia-postgres >/dev/null
apply > "$tmp/adopt.log" || { cat "$tmp/adopt.log"; exit 1; }
grep -q 'changed=0' "$tmp/adopt.log"
# A missing secret on a pre-existing volume must not be recreated.
podman secret rm codexia-tunnel-token >/dev/null
if apply > "$tmp/fail.log"; then echo 'Existing volume with missing secret accepted' >&2; exit 1; fi
rc=0; podman secret exists codexia-tunnel-token || rc=$?
test "$rc" = 1
if grep -Eq 'fixture-auth-token|fixture-tunnel-token|0{63}[12]' "$tmp/"*.log; then
  echo 'Credential appeared in Ansible output' >&2; exit 1
fi
printf '%s\n' 'Verified real rootless Podman secret creation, exact adoption, idempotence and existing-data missing-secret denial.'
