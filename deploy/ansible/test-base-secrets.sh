#!/usr/bin/env bash
set -euo pipefail
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
umask 077
service_user=$(id -un)
service_uid=$(id -u)
service_home=$(getent passwd "$service_user" | cut -d: -f6)
mkdir "$tmp/bin" "$tmp/store"
export BASE_SECRET_STORE="$tmp/store" BASE_SECRET_LOG="$tmp/commands" BASE_SECRET_EXISTING="$tmp/has-runtime"
cat > "$tmp/bin/podman" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$BASE_SECRET_LOG"
case "$1 $2" in
  'info --format') printf 'true\n';;
  'volume exists'|'container exists') test "$3" = codexia-postgres && test -f "$BASE_SECRET_EXISTING";;
  'secret exists') test -f "$BASE_SECRET_STORE/$3";;
  'secret inspect') test "$3" = --showsecret; jq -n --arg name "$4" --rawfile value "$BASE_SECRET_STORE/$4" '[{Spec:{Name:$name},SecretData:$value}]';;
  'secret create') test "$4" = -; test ! -e "$BASE_SECRET_STORE/$3"; cat > "$BASE_SECRET_STORE/$3"; printf 'created\n';;
  *) exit 99;;
esac
SH
chmod 700 "$tmp/bin/podman"
export PATH="$tmp/bin:$PATH"
printf 'fixture-auth-token-0123456789abcdef\n' > "$tmp/auth"
printf 'fixture-tunnel-token\n' > "$tmp/tunnel"
printf '%064d' 1 > "$tmp/admin"
printf '%064d\n' 2 > "$tmp/app"
cat > "$tmp/test.yml" <<YAML
- hosts: localhost
  connection: local
  gather_facts: false
  vars:
    codexia_service_user: $service_user
    codexia_service_uid: $service_uid
    codexia_service_home: "$service_home"
    codexia_secrets_approved: true
    codexia_auth_token_file: "$tmp/auth"
    codexia_tunnel_token_file: "$tmp/tunnel"
    codexia_postgres_admin_password_file: "$tmp/admin"
    codexia_postgres_app_password_file: "$tmp/app"
  tasks:
    - ansible.builtin.include_tasks: "$(pwd)/deploy/ansible/base-secrets.yml"
YAML
apply() { "${ANSIBLE_PLAYBOOK:-ansible-playbook}" -i localhost, "$tmp/test.yml" "$@"; }
expect_fail() {
  if apply "$@" > "$tmp/fail.log"; then
    echo 'Unsafe base secret operation accepted' >&2; exit 1
  fi
  if grep -Eq 'fixture-auth-token|fixture-tunnel-token|0{63}[12]' "$tmp/fail.log"; then
    echo 'Credential appeared in Ansible output' >&2; exit 1
  fi
}
# Invalid input or reused DB password must fail before any creation.
printf 'fixture-auth-token\n' > "$tmp/auth"
expect_fail
test -z "$(ls -A "$tmp/store")"
printf 'fixture-auth-token-0123456789abcdef\n' > "$tmp/auth"
chmod 0644 "$tmp/auth"
expect_fail
test -z "$(ls -A "$tmp/store")"
chmod 0600 "$tmp/auth"
ln -s "$tmp/auth" "$tmp/auth-link"
sed "s#$tmp/auth#$tmp/auth-link#" "$tmp/test.yml" > "$tmp/link.yml"
if "${ANSIBLE_PLAYBOOK:-ansible-playbook}" -i localhost, "$tmp/link.yml" > "$tmp/link.log"; then
  echo 'Symlink secret input accepted' >&2; exit 1
fi
test -z "$(ls -A "$tmp/store")"
cp "$tmp/app" "$tmp/app.original"
printf 'invalid' > "$tmp/app"
expect_fail
test -z "$(ls -A "$tmp/store")"
cp "$tmp/admin" "$tmp/app"
expect_fail
test -z "$(ls -A "$tmp/store")"
mv "$tmp/app.original" "$tmp/app"
apply > "$tmp/first.log" || { cat "$tmp/first.log"; exit 1; }
for name in auth tunnel admin app; do
  case "$name" in
    auth) target=codexia-auth-token;;
    tunnel) target=codexia-tunnel-token;;
    admin) target=codexia-postgres-admin-password;;
    app) target=codexia-postgres-app-password;;
  esac
  cmp "$tmp/$name" "$tmp/store/$target"
done
apply > "$tmp/second.log" || { cat "$tmp/second.log"; exit 1; }
grep -q 'changed=0' "$tmp/second.log"
# Mismatch of one existing secret must not create another missing secret.
mv "$tmp/store/codexia-tunnel-token" "$tmp/missing"
printf 'fixture-auth-token-different-0123456789\n' > "$tmp/auth"
expect_fail
test ! -e "$tmp/store/codexia-tunnel-token"
printf 'fixture-auth-token-0123456789abcdef\n' > "$tmp/auth"
touch "$BASE_SECRET_EXISTING"
expect_fail
test ! -e "$tmp/store/codexia-tunnel-token"
mv "$tmp/missing" "$tmp/store/codexia-tunnel-token"
apply > "$tmp/adopt.log" || { cat "$tmp/adopt.log"; exit 1; }
grep -q 'changed=0' "$tmp/adopt.log"
if grep -Eq 'fixture-auth-token|fixture-tunnel-token|0{63}[12]' "$tmp/first.log" "$tmp/second.log" "$tmp/adopt.log"; then
  echo 'Credential appeared in Ansible output' >&2; exit 1
fi
