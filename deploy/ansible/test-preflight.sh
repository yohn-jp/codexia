#!/usr/bin/env bash
set -euo pipefail
name="codexia-iac-test-$$"
password=$(printf '%064d' 1)
tmp=$(mktemp -d)
trap 'docker rm -f "$name" >/dev/null 2>&1 || true; rm -rf "$tmp"' EXIT
docker run -d --name "$name" -e POSTGRES_USER=codexia_admin -e POSTGRES_PASSWORD=test -e POSTGRES_DB=codexia docker.io/library/postgres:17-bookworm@sha256:665dc7b37ac52a17e298511414c21d23ffa4e6a6ef6225b3e5d59c7afb35e994 >/dev/null
for i in $(seq 1 60); do
  if docker exec "$name" pg_isready -h 127.0.0.1 -U codexia_admin -d codexia >/dev/null 2>&1; then break; fi
  sleep 1
done
sql() { docker exec -i "$name" psql -X -qAt -v ON_ERROR_STOP=1 -U codexia_admin -d codexia "$@"; }
sql -c 'CREATE TABLE public.canon(id integer); INSERT INTO public.canon VALUES (1);'
docker exec "$name" sh -ec 'mkdir -p /run/secrets; printf test > /run/secrets/admin-password; printf writer > /run/secrets/app-password'
# The adapter only substitutes Podman transport; Ansible executes the actual
# production task file, including real PostgreSQL authentication and SQL.
cat > "$tmp/podman" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
case "$1 $2" in
  'exec -i') test "$3" = codexia-db; shift 3; exec docker exec -i "$CODEXIA_TEST_CONTAINER" "$@" ;;
  'secret exists') test -f "$CODEXIA_TEST_SECRET" ;;
  'secret inspect') test "$3" = --showsecret; jq -n --rawfile value "$CODEXIA_TEST_SECRET" '[{SecretData:$value}]' ;;
  'secret create') test ! -e "$CODEXIA_TEST_SECRET"; cat > "$CODEXIA_TEST_SECRET" ;;
  *) exit 99 ;;
esac
SH
chmod 700 "$tmp/podman"
export CODEXIA_TEST_CONTAINER="$name" CODEXIA_TEST_SECRET="$tmp/secret"
export PATH="$tmp:$PATH"
cat > "$tmp/test.yml" <<YAML
- hosts: localhost
  connection: local
  gather_facts: false
  vars:
    repo_root: "$(pwd)"
    codexia_preflight_password: "$password"
  tasks:
    - ansible.builtin.include_tasks: "$(pwd)/deploy/ansible/preflight.yml"
YAML
apply() { "${ANSIBLE_PLAYBOOK:-ansible-playbook}" -i localhost, "$tmp/test.yml" -e "{\"preflight_verify_only\":$1}"; }
# The production Ansible tasks must create once, converge unchanged, and verify read-only.
apply false > "$tmp/first.log" || { cat "$tmp/first.log"; exit 1; }
grep -Eq 'changed=[1-9]' "$tmp/first.log"
apply false > "$tmp/second.log" || { cat "$tmp/second.log"; exit 1; }
grep -q 'changed=0' "$tmp/second.log"
apply true > "$tmp/verify.log" || { cat "$tmp/verify.log"; exit 1; }
grep -q 'changed=0' "$tmp/verify.log"
reader() { docker exec -e PGPASSWORD="$password" "$name" psql -X -qAt -v ON_ERROR_STOP=1 -h 127.0.0.1 -U codexia_preflight -d codexia "$@"; }
test "$(reader -c 'SHOW transaction_read_only')" = on
test "$(reader -c 'SELECT id FROM public.canon')" = 1
if reader -c 'SET default_transaction_read_only=off' -c 'INSERT INTO public.canon VALUES (2)' > "$tmp/denied" 2>&1; then exit 1; fi
grep -q 'permission denied for table canon' "$tmp/denied"
sql -c 'CREATE TABLE public.new_canon(id integer);'
if apply true > "$tmp/drift.log"; then echo 'Missing grant accepted in verify' >&2; exit 1; fi
test "$(sql -c "SELECT has_table_privilege('codexia_preflight','public.new_canon','SELECT')")" = f
apply false > "$tmp/converge.log" || { cat "$tmp/converge.log"; exit 1; }
grep -Eq 'changed=[1-9]' "$tmp/converge.log"
apply true > "$tmp/verify.log" || { cat "$tmp/verify.log"; exit 1; }
for grant in 'INSERT' 'UPDATE (id)' 'INSERT (id)'; do
  sql -c "GRANT $grant ON public.canon TO codexia_preflight;"
  if apply true > "$tmp/drift.log"; then echo "Unsafe $grant accepted in verify" >&2; exit 1; fi
  if apply false > "$tmp/drift.log"; then echo "Unsafe $grant accepted in converge" >&2; exit 1; fi
  sql -c "REVOKE $grant ON public.canon FROM codexia_preflight;"
done
mv "$CODEXIA_TEST_SECRET" "$tmp/saved-secret"
if apply true > "$tmp/drift.log"; then echo 'Missing secret accepted' >&2; exit 1; fi
test ! -e "$CODEXIA_TEST_SECRET"
mv "$tmp/saved-secret" "$CODEXIA_TEST_SECRET"
apply true > "$tmp/verify.log" || { cat "$tmp/verify.log"; exit 1; }
# Reject reuse of the existing administrator password before SQL connection.
docker exec -i "$name" sh -ec 'cat > /run/secrets/admin-password' <<< "$password"
if apply true > "$tmp/admin-reuse.log"; then echo 'Admin password reuse accepted' >&2; exit 1; fi
grep -q 'Reject reuse of the existing writer or administrator credential' "$tmp/admin-reuse.log"
docker exec "$name" sh -ec 'printf test > /run/secrets/admin-password'
apply true > "$tmp/verify.log" || { cat "$tmp/verify.log"; exit 1; }
