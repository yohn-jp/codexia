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
  'volume exists') [[ "$3" == codexia-postgres && -f "$BASE_SECRET_EXISTING" ]];;
  'container exists') [[ "$3" == codexia-db || "$3" == codexia-api ]] && exit 1;;
  'secret exists') test -f "$BASE_SECRET_STORE/$3";;
  'secret inspect') test "$3" = --showsecret; jq -n --arg name "$4" --rawfile value "$BASE_SECRET_STORE/$4" '[{Spec:{Name:$name},SecretData:$value}]';;
  'secret create') test "$4" = -; test ! -e "$BASE_SECRET_STORE/$3"; cat > "$BASE_SECRET_STORE/$3"; printf 'created\n';;
  *) exit 99;;
esac
SH
chmod 700 "$tmp/bin/podman"
export PATH="$tmp/bin:$PATH"
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
  if grep -Eq '0{63}[123]' "$tmp/fail.log"; then
    echo 'Credential appeared in Ansible output' >&2; exit 1
  fi
}

printf 'invalid' > "$tmp/app"
expect_fail
test -z "$(ls -A "$tmp/store")"
printf '%064d\n' 2 > "$tmp/app"
cp "$tmp/app" "$tmp/app.original"
printf '%064d' 1 > "$tmp/app"
expect_fail
test -z "$(ls -A "$tmp/store")"
mv "$tmp/app.original" "$tmp/app"
ln -s "$tmp/admin" "$tmp/admin-link"
sed "s#$tmp/admin#$tmp/admin-link#" "$tmp/test.yml" > "$tmp/link.yml"
if "${ANSIBLE_PLAYBOOK:-ansible-playbook}" -i localhost, "$tmp/link.yml" > "$tmp/link.log"; then
  echo 'Symlink secret input accepted' >&2; exit 1
fi
test -z "$(ls -A "$tmp/store")"

apply > "$tmp/first.log" || { cat "$tmp/first.log"; exit 1; }
cmp "$tmp/admin" "$tmp/store/codexia-postgres-admin-password"
cmp "$tmp/app" "$tmp/store/codexia-postgres-app-password"
apply > "$tmp/second.log" || { cat "$tmp/second.log"; exit 1; }
grep -q 'changed=0' "$tmp/second.log"

mv "$tmp/store/codexia-postgres-app-password" "$tmp/missing"
printf '%064d' 3 > "$tmp/admin"
expect_fail
test ! -e "$tmp/store/codexia-postgres-app-password"
printf '%064d' 1 > "$tmp/admin"
mv "$tmp/missing" "$tmp/store/codexia-postgres-app-password"
touch "$BASE_SECRET_EXISTING"
mv "$tmp/store/codexia-postgres-app-password" "$tmp/missing"
expect_fail
test ! -e "$tmp/store/codexia-postgres-app-password"
rm "$BASE_SECRET_EXISTING"
mv "$tmp/missing" "$tmp/store/codexia-postgres-app-password"
apply > "$tmp/adopt.log" || { cat "$tmp/adopt.log"; exit 1; }
grep -q 'changed=0' "$tmp/adopt.log"
if grep -Eq '0{63}[123]' "$tmp/first.log" "$tmp/second.log" "$tmp/adopt.log"; then
  echo 'Credential appeared in Ansible output' >&2; exit 1
fi
