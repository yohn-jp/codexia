#!/usr/bin/env bash
# Run only inside test-base-runtime-integration.sh after its disposable DB is ready.
set -Eeuo pipefail
trap 'status=$?; printf "Auth runtime fixture failed at line %s (status %s)\n" "$LINENO" "$status" >&2; exit "$status"' ERR
test "${GITHUB_ACTIONS:-}" = true
test "${CODEXIA_DISPOSABLE_HOST:-}" = base-integration
service_user=${CODEXIA_SERVICE_USER:?missing rootless fixture identity}
service_uid=$(id -u "$service_user")
service_group=$(id -gn "$service_user")
service_home=$(getent passwd "$service_user" | cut -d: -f6)
repo_root=$(git rev-parse --show-toplevel)
tmp=$(mktemp -d /tmp/codexia-auth-runtime.XXXXXX)
secret_names=(codexia-auth-database-url codexia-auth-secret codexia-oidc-client-secret codexia-oauth-introspection-client-secret)
created_secrets=()
cleanup() {
  local status=$?
  trap - EXIT ERR
  set +e
  for name in "${created_secrets[@]}"; do podman secret rm "$name" >/dev/null 2>&1; done
  if [[ "$tmp" == /tmp/codexia-auth-runtime.* && -d "$tmp" && ! -L "$tmp" ]]; then rm -rf -- "$tmp"; fi
  exit "$status"
}
trap cleanup EXIT

test "$(id -un)" != "$service_user"
sudo -n true
as_service() {
  sudo -u "$service_user" env HOME="$service_home" XDG_CONFIG_HOME="$service_home/.config" XDG_DATA_HOME="$service_home/.local/share" XDG_STATE_HOME="$service_home/.local/state" XDG_RUNTIME_DIR="/run/user/$service_uid" DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$service_uid/bus" bash -c 'cd "$HOME" && exec "$@"' bash "$@"
}
podman() { as_service /usr/bin/podman "$@"; }
admin_psql() {
  podman exec -i codexia-db sh -ec 'export PGPASSWORD="$(cat /run/secrets/admin-password)"; exec psql -X -qAt -v ON_ERROR_STOP=1 -U codexia_admin -d codexia' "$@"
}
runtime_psql() {
  local password_file=$1
  { cat "$password_file"; printf '\n'; cat; } | podman exec -i codexia-db sh -ec 'IFS= read -r PGPASSWORD || exit 72; export PGPASSWORD; exec psql -X -qAt -v ON_ERROR_STOP=1 -h 127.0.0.1 -U codexia_auth_runtime -d codexia'
}
apply_stage() {
  ANSIBLE_LOCAL_TEMP="$tmp/ansible-local" "${ANSIBLE_PLAYBOOK:-ansible-playbook}" -i "$tmp/auth-inventory.yml" "$repo_root/deploy/ansible/site.yml"
}

for name in "${secret_names[@]}"; do
  if podman secret exists "$name"; then
    printf 'Refusing to reuse a pre-existing auth fixture secret: %s\n' "$name" >&2
    exit 1
  fi
done
created_secrets=("${secret_names[@]}")
auth_state=$(admin_psql <<'SQL'
SELECT (EXISTS (SELECT 1 FROM pg_roles WHERE rolname='codexia_auth_runtime'))::text || '|' ||
       (EXISTS (SELECT 1 FROM pg_namespace WHERE nspname='codexia_auth'))::text;
SQL
)
test "$auth_state" = 'false|false'

umask 077
printf '%s' 'postgresql://codexia_auth_runtime:Auth%40fixture%3Asecret-3981@codexia-db:5432/codexia' > "$tmp/database-url"
printf '%s' 'Auth@fixture:secret-3981' > "$tmp/runtime-password"
printf '%s' 'fixture-auth-signing-key-value-39017' > "$tmp/auth-secret"
printf '%s' 'fixture-oidc-client-secret-39017' > "$tmp/oidc-secret"
printf '%s' 'fixture-introspection-client-secret-39017' > "$tmp/introspection-secret"
chmod 0600 "$tmp"/*
for path in "$tmp/database-url" "$tmp/runtime-password" "$tmp/auth-secret" "$tmp/oidc-secret" "$tmp/introspection-secret"; do
  test "$(stat -c '%a' "$path")" = 600
  test "$(stat -c '%u' "$path")" = "$(id -u)"
done

cat > "$tmp/auth-inventory.yml" <<YAML
all:
  children:
    codexia:
      hosts:
        localhost:
          ansible_connection: local
          ansible_python_interpreter: /usr/bin/python3
      vars:
        codexia_stage: auth-runtime
        codexia_auth_runtime_approved: false
        codexia_service_user: $service_user
        codexia_service_group: $service_group
        codexia_service_uid: $service_uid
        codexia_service_home: "$service_home"
        codexia_auth_database_url_file: "$tmp/database-url"
        codexia_auth_secret_file: "$tmp/auth-secret"
        codexia_oidc_client_secret_file: "$tmp/oidc-secret"
        codexia_oauth_introspection_client_secret_file: "$tmp/introspection-secret"
        codexia_public_origin: https://codexia.example.invalid
        codexia_oidc_issuer: https://idp.example.invalid/oidc
        codexia_oidc_client_id: codexia-web
        codexia_oauth_introspection_client_id: codexia-resource-server
        codexia_oauth_owner_subject: fixture-provider|stable-owner-subject
        codexia_oauth_owner_client_ids: codexia-web,codexia-ios
        codexia_api_audience: https://codexia.example.invalid/api
YAML

# False approval must fail before creating Podman secrets or PostgreSQL state.
if apply_stage > "$tmp/approval-denied.log" 2>&1; then
  echo 'Auth runtime stage ignored its explicit approval gate' >&2
  exit 1
fi
if ! grep -q 'Better Auth provisioning requires explicit approval' "$tmp/approval-denied.log"; then
  printf 'False-approval run did not report the expected guard; task names observed:\n' >&2
  grep -E '^TASK \[' "$tmp/approval-denied.log" >&2 || true
  exit 1
fi
for name in "${secret_names[@]}"; do
  rc=0; podman secret exists "$name" || rc=$?
  test "$rc" = 1
done
test "$(admin_psql <<'SQL'
SELECT (EXISTS (SELECT 1 FROM pg_roles WHERE rolname='codexia_auth_runtime'))::text || '|' ||
       (EXISTS (SELECT 1 FROM pg_namespace WHERE nspname='codexia_auth'))::text;
SQL
)" = 'false|false'

# A malformed upstream issuer must fail before secret creation or database mutation.
sed -i 's/codexia_auth_runtime_approved: false/codexia_auth_runtime_approved: true/; s#codexia_oidc_issuer: https:#codexia_oidc_issuer: http:#' "$tmp/auth-inventory.yml"
if apply_stage > "$tmp/issuer-denied.log" 2>&1; then
  echo 'Auth runtime stage accepted an insecure upstream issuer' >&2
  exit 1
fi
grep -q 'validated public configuration' "$tmp/issuer-denied.log"
for name in "${secret_names[@]}"; do
  rc=0; podman secret exists "$name" || rc=$?
  test "$rc" = 1
done
test "$(admin_psql <<'SQL'
SELECT (EXISTS (SELECT 1 FROM pg_roles WHERE rolname='codexia_auth_runtime'))::text || '|' ||
       (EXISTS (SELECT 1 FROM pg_namespace WHERE nspname='codexia_auth'))::text;
SQL
)" = 'false|false'
sed -i 's#codexia_oidc_issuer: http:#codexia_oidc_issuer: https:#' "$tmp/auth-inventory.yml"

# Seed a partial exact secret set to exercise retry-safe first convergence.
for index in 0 1; do
  name=${secret_names[$index]}
  file=("$tmp/database-url" "$tmp/auth-secret" "$tmp/oidc-secret" "$tmp/introspection-secret")
  podman secret create "$name" - < "${file[$index]}" >/dev/null
done
apply_stage > "$tmp/auth-first.log" 2>&1 || { cat "$tmp/auth-first.log"; exit 1; }
grep -Eq 'changed=[1-9]' "$tmp/auth-first.log"

for name in "${secret_names[@]}"; do podman secret exists "$name"; done
role_state=$(admin_psql <<'SQL'
SELECT (r.rolcanlogin AND NOT r.rolsuper AND NOT r.rolcreatedb AND NOT r.rolcreaterole AND NOT r.rolinherit AND NOT r.rolreplication AND NOT r.rolbypassrls)::text || '|' ||
       pg_get_userbyid(n.nspowner) || '|' ||
       has_table_privilege('codexia_auth_runtime','public.phase_b_adoption_probe','SELECT')::text || '|' ||
       has_table_privilege('codexia_auth_runtime','public.codexia_schema_migrations','SELECT')::text || '|' ||
       has_schema_privilege('codexia_auth_runtime','public','CREATE')::text
FROM pg_roles r CROSS JOIN pg_namespace n
WHERE r.rolname='codexia_auth_runtime' AND n.nspname='codexia_auth';
SQL
)
test "$role_state" = 'true|codexia_auth_runtime|false|false|false'

runtime_identity=$(runtime_psql "$tmp/runtime-password" <<'SQL'
SELECT current_user || '|' || current_schema();
CREATE TABLE codexia_auth.acceptance_probe (id integer PRIMARY KEY, value text NOT NULL);
INSERT INTO codexia_auth.acceptance_probe VALUES (1, 'durable-auth-fixture');
SQL
)
test "$runtime_identity" = 'codexia_auth_runtime|codexia_auth'
if runtime_psql "$tmp/runtime-password" <<'SQL' > "$tmp/denied-core.log" 2>&1
\set VERBOSITY verbose
SELECT * FROM public.phase_b_adoption_probe;
SQL
then
  echo 'Better Auth runtime role could read an application-owned public table' >&2
  exit 1
fi
grep -Fq '42501:' "$tmp/denied-core.log"
if runtime_psql "$tmp/runtime-password" <<'SQL' > "$tmp/denied-create-core.log" 2>&1
\set VERBOSITY verbose
CREATE TABLE public.auth_runtime_must_not_create (id integer);
SQL
then
  echo 'Better Auth runtime role could create objects in the Core schema' >&2
  exit 1
fi
grep -Fq '42501:' "$tmp/denied-create-core.log"

env_output=$(podman run --rm --network codexia-data \
  --secret=codexia-auth-database-url,type=env,target=CODEXIA_AUTH_DATABASE_URL \
  --secret=codexia-auth-secret,type=env,target=CODEXIA_AUTH_SECRET \
  --secret=codexia-oidc-client-secret,type=env,target=CODEXIA_OIDC_CLIENT_SECRET \
  --secret=codexia-oauth-introspection-client-secret,type=env,target=CODEXIA_OAUTH_INTROSPECTION_CLIENT_SECRET \
  --entrypoint sh "$(podman inspect --format '{{.Config.Image}}' codexia-db)" \
  -ec 'test -n "$CODEXIA_AUTH_DATABASE_URL" && test -n "$CODEXIA_AUTH_SECRET" && test -n "$CODEXIA_OIDC_CLIENT_SECRET" && test -n "$CODEXIA_OAUTH_INTROSPECTION_CLIENT_SECRET" && printf AUTH_ENV_SECRET_INJECTION_VERIFIED')
test "$env_output" = AUTH_ENV_SECRET_INJECTION_VERIFIED

apply_stage > "$tmp/auth-repeat.log" 2>&1 || { cat "$tmp/auth-repeat.log"; exit 1; }
grep -q 'changed=0' "$tmp/auth-repeat.log"
test "$(runtime_psql "$tmp/runtime-password" <<'SQL'
SELECT value FROM codexia_auth.acceptance_probe WHERE id=1;
SQL
)" = durable-auth-fixture
runtime_env="$service_home/.config/codexia-auth/runtime.env"
test "$(as_service stat -c '%a:%U' "$runtime_env")" = "600:$service_user"
as_service cat "$runtime_env" > "$tmp/runtime.env"
if grep -Eq 'Auth%40fixture|fixture-auth-signing-key|fixture-oidc-client-secret|fixture-introspection-client-secret|DATABASE_URL' "$tmp/runtime.env"; then
  echo 'Secret material or database URL appeared in the nonsecret auth environment file' >&2
  exit 1
fi
test ! -e "$repo_root/deploy/quadlet/codexia-api.better-auth.container"

# An existing schema cannot be adopted while any protected runtime secret is missing.
podman secret rm codexia-oidc-client-secret >/dev/null
if apply_stage > "$tmp/auth-missing-secret.log" 2>&1; then
  echo 'Auth runtime stage accepted an existing schema with a missing secret' >&2
  exit 1
fi
grep -q 'Require all secrets for an existing auth schema' "$tmp/auth-missing-secret.log"
podman secret create codexia-oidc-client-secret - < "$tmp/oidc-secret" >/dev/null

# Existing-schema secret drift must be rejected before database or file changes.
printf '%s' 'fixture-introspection-client-secret-drift' > "$tmp/introspection-secret"
if apply_stage > "$tmp/auth-drift.log" 2>&1; then
  echo 'Auth runtime stage accepted secret rotation without an explicit path' >&2
  exit 1
fi
grep -q 'Refuse to rotate or replace an existing auth secret' "$tmp/auth-drift.log"
if grep -Eq 'fixture-introspection-client-secret-drift' "$tmp/auth-drift.log"; then
  echo 'Secret input leaked into Ansible failure output' >&2
  exit 1
fi
test "$(runtime_psql "$tmp/runtime-password" <<'SQL'
SELECT value FROM codexia_auth.acceptance_probe WHERE id=1;
SQL
)" = durable-auth-fixture

for secret_value in 'Auth%40fixture%3Asecret-3981' 'fixture-auth-signing-key-value-39017' 'fixture-oidc-client-secret-39017' 'fixture-introspection-client-secret-39017'; do
  if grep -Fq "$secret_value" "$tmp"/*.log; then
    echo 'Synthetic secret material appeared in Ansible output' >&2
    exit 1
  fi
done
printf '%s\n' 'Verified real rootless auth secret injection, partial initial retry, isolated role/schema permissions, current_schema, repeat convergence, secret drift denial, and no runtime activation.'
