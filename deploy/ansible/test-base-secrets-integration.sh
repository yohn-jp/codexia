#!/usr/bin/env bash
# Only run on a disposable CI VM. All credentials below are synthetic fixtures.
set -euo pipefail
test "${GITHUB_ACTIONS:-}" = true
test "$(lsb_release -rs)" = 26.04
tmp=$(mktemp -d /tmp/codexia-base-secrets.XXXXXX)
cleanup() {
  local status=$?
  trap - EXIT
  if [[ "$tmp" == /tmp/codexia-base-secrets.* && -d "$tmp" && ! -L "$tmp" ]]; then
    sudo rm -rf -- "$tmp" || printf 'Phase B secrets fixture cleanup could not remove its temporary directory.\n' >&2
  fi
  printf 'Phase B secrets fixture cleanup preserved script status %s.\n' "$status" >&2
  exit "$status"
}
trap cleanup EXIT
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
for name in codexia-postgres-admin-password codexia-postgres-app-password codexia-tunnel-token; do
  rc=0; podman secret exists "$name" || rc=$?
  test "$rc" = 1
done
for name in codexia-postgres codexia-data codexia-history; do
  rc=0; podman volume exists "$name" || rc=$?
  test "$rc" = 1
done
# Exercise the production VM helper against real Podman before the standalone
# file-adoption fixture creates its synthetic baseline.
managed_names=(codexia-postgres-admin-password codexia-postgres-app-password
               codexia-auth-database-url codexia-auth-secret codexia-oauth-introspection-client-secret)
for name in "${managed_names[@]}"; do
  rc=0; podman secret exists "$name" || rc=$?
  test "$rc" = 1
done
state_dir="$service_home/.local/state/codexia-deploy"
helper="$service_home/.local/bin/codexia-bootstrap-secrets"
as_service mkdir -p -m 0700 "$state_dir" "$service_home/.local/bin"
sudo install -o "$service_user" -g "$(id -gn "$service_user")" -m 0700 deploy/ansible/managed-bootstrap-secrets.py "$helper"
host_id=$(tr -d '\n' </etc/machine-id | sha256sum | cut -d' ' -f1)
admission=$(jq -cn --arg host "$host_id" '{host:$host, hashes:{}}')
receipt="$state_dir/bootstrap-secret-ids.json"
test "$(as_service "$helper" "$admission" install)" = INITIALIZED
admission=$(as_service cat "$receipt" | jq -c --arg host "$host_id" '{host:$host, hashes:.}')
test "$(as_service "$helper" "$admission" adopt)" = VERIFIED
as_service "$helper" auth-password | base64 -d | grep -qxE '[a-f0-9]{64}'
for name in "${managed_names[@]}"; do podman secret rm "$name" >/dev/null; done
as_service rm "$receipt"
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
        codexia_postgres_admin_password_file: "$tmp/admin"
        codexia_postgres_app_password_file: "$tmp/app"
YAML
apply() { ANSIBLE_LOCAL_TEMP="$tmp/ansible-local" "${ANSIBLE_PLAYBOOK:-ansible-playbook}" -i "$tmp/inventory.yml" deploy/ansible/site.yml; }
printf 'invalid' > "$tmp/app"
if apply > "$tmp/invalid-database-secret.log"; then echo 'Malformed database credential accepted' >&2; exit 1; fi
for name in codexia-postgres-admin-password codexia-postgres-app-password; do
  rc=0; podman secret exists "$name" || rc=$?
  test "$rc" = 1
done
printf '%064d\n' 2 > "$tmp/app"
apply > "$tmp/first.log" || { cat "$tmp/first.log"; exit 1; }
for pair in 'admin codexia-postgres-admin-password' 'app codexia-postgres-app-password'; do
  read -r file name <<< "$pair"
  podman secret inspect --showsecret "$name" | jq -j '.[0].SecretData' | cmp - "$tmp/$file"
done
apply > "$tmp/repeat.log" || { cat "$tmp/repeat.log"; exit 1; }
grep -q 'changed=0' "$tmp/repeat.log"
podman volume create codexia-postgres >/dev/null
apply > "$tmp/adopt.log" || { cat "$tmp/adopt.log"; exit 1; }
grep -q 'changed=0' "$tmp/adopt.log"
# A missing secret on a pre-existing volume must not be recreated.
podman secret rm codexia-postgres-app-password >/dev/null
if apply > "$tmp/fail.log"; then echo 'Existing volume with missing secret accepted' >&2; exit 1; fi
rc=0; podman secret exists codexia-postgres-app-password || rc=$?
test "$rc" = 1
printf '%064d\n' 2 | podman secret create codexia-postgres-app-password - >/dev/null
podman secret inspect --showsecret codexia-postgres-app-password | jq -j '.[0].SecretData' | cmp - <(printf '%064d\n' 2)
if grep -Eq '0{63}[12]' "$tmp/"*.log; then
  echo 'Credential appeared in Ansible output' >&2; exit 1
fi
printf '%s\n' 'Verified real rootless Podman secret creation, exact adoption, idempotence and existing-data missing-secret denial.'
