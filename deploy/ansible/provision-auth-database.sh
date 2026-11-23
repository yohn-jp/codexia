#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

die(){ printf '%s\n' "$1" >&2; exit 1; }
[[ $# == 2 || $# == 3 ]] || die 'Usage: codexia-auth-runtime-bootstrap <operation> /absolute/lock-file [reviewed immutable Full image]'
operation="$1"
lock_file="$2"
[[ "$lock_file" == /* && ! "$lock_file" =~ [[:cntrl:]] ]] || die 'Invalid auth bootstrap lock path'
case "$operation" in
  inspect|verify|verify-permissions|converge) [[ $# == 2 ]] || die 'Unexpected auth bootstrap argument' ;;
  initialize-application)
    [[ $# == 3 && "$3" =~ ^ghcr\.io/yohn-jp/codexia-backend@sha256:[a-f0-9]{64}$ ]] ||
      die 'Application initialization requires a reviewed immutable Full image' ;;
  *) die 'Invalid auth bootstrap operation' ;;
esac

exec 9>"$lock_file"
flock --exclusive --nonblock 9 || die 'Another Codexia deployment or backup holds the host lock'

admin_psql(){
  podman exec -i codexia-db sh -ec 'export PGPASSWORD="$(cat /run/secrets/admin-password)"; exec psql -X -qAt -v ON_ERROR_STOP=1 -U codexia_admin -d codexia'
}

assert_role_security(){
  admin_psql <<'SQL'
DO $codexia_auth_check$
DECLARE
  auth_role_oid oid;
  role_is_restricted boolean;
  invalid_auth_memberships integer;
BEGIN
  SELECT oid INTO auth_role_oid FROM pg_authid WHERE rolname='codexia_auth_runtime';
  IF auth_role_oid IS NULL THEN RAISE EXCEPTION 'Auth runtime role is missing'; END IF;
  SELECT rolcanlogin AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolinherit AND NOT rolreplication AND NOT rolbypassrls
    INTO role_is_restricted
  FROM pg_roles WHERE rolname='codexia_auth_runtime';
  IF NOT role_is_restricted THEN RAISE EXCEPTION 'Auth runtime role has unexpected PostgreSQL attributes'; END IF;
  SELECT count(*) INTO invalid_auth_memberships FROM pg_auth_members WHERE member=auth_role_oid OR roleid=auth_role_oid;
  IF invalid_auth_memberships<>0 THEN RAISE EXCEPTION 'Auth runtime role has unexpected role memberships'; END IF;
END
$codexia_auth_check$;
SQL
}

assert_role_state(){
  assert_role_security
  admin_psql <<'SQL'
DO $codexia_auth_check$
DECLARE
  auth_role_oid oid;
  invalid_auth_table_grants integer;
  invalid_auth_sequence_grants integer;
  invalid_schema_create integer;
  invalid_auth_table_owners integer;
  invalid_auth_schema_grants integer;
  invalid_auth_object_grants integer;
  invalid_auth_function_owners integer;
BEGIN
  SELECT oid INTO auth_role_oid FROM pg_authid WHERE rolname='codexia_auth_runtime';
  IF auth_role_oid IS NULL THEN RAISE EXCEPTION 'Auth runtime role is missing'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname='codexia_auth' AND nspowner=auth_role_oid) THEN
    RAISE EXCEPTION 'Auth schema is missing or has an unexpected owner';
  END IF;
  SELECT count(*) INTO invalid_auth_schema_grants
  FROM pg_namespace n,
       LATERAL aclexplode(COALESCE(n.nspacl, acldefault('n',n.nspowner))) acl
  WHERE n.nspname='codexia_auth' AND acl.grantee<>auth_role_oid;
  IF invalid_auth_schema_grants<>0 THEN RAISE EXCEPTION 'Auth schema is granted to another role or PUBLIC'; END IF;
  SELECT count(*) INTO invalid_auth_table_owners
  FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='codexia_auth' AND c.relkind IN ('r','p','v','m','f','S') AND c.relowner<>auth_role_oid;
  IF invalid_auth_table_owners<>0 THEN RAISE EXCEPTION 'Auth schema contains objects owned by another role'; END IF;
  SELECT count(*) INTO invalid_auth_function_owners
  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='codexia_auth' AND p.proowner<>auth_role_oid;
  IF invalid_auth_function_owners<>0 THEN RAISE EXCEPTION 'Auth schema contains functions owned by another role'; END IF;
  SELECT count(*) INTO invalid_auth_object_grants
  FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace,
       LATERAL aclexplode(c.relacl) acl
  WHERE n.nspname='codexia_auth' AND c.relkind IN ('r','p','v','m','f','S') AND acl.grantee<>auth_role_oid;
  IF invalid_auth_object_grants<>0 THEN RAISE EXCEPTION 'Auth schema objects are granted to another role or PUBLIC'; END IF;
  SELECT count(*) INTO invalid_auth_object_grants
  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace,
       LATERAL aclexplode(p.proacl) acl
  WHERE n.nspname='codexia_auth' AND acl.grantee<>auth_role_oid;
  IF invalid_auth_object_grants<>0 THEN RAISE EXCEPTION 'Auth schema functions are granted to another role or PUBLIC'; END IF;
  SELECT count(*) INTO invalid_auth_table_grants
  FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname NOT IN ('codexia_auth','information_schema') AND n.nspname NOT LIKE 'pg_%'
    AND c.relkind IN ('r','p','v','m','f')
    AND (has_table_privilege('codexia_auth_runtime',c.oid,'SELECT') OR
         has_table_privilege('codexia_auth_runtime',c.oid,'INSERT') OR
         has_table_privilege('codexia_auth_runtime',c.oid,'UPDATE') OR
         has_table_privilege('codexia_auth_runtime',c.oid,'DELETE') OR
         has_table_privilege('codexia_auth_runtime',c.oid,'TRUNCATE') OR
         has_table_privilege('codexia_auth_runtime',c.oid,'REFERENCES') OR
         has_table_privilege('codexia_auth_runtime',c.oid,'TRIGGER'));
  IF invalid_auth_table_grants<>0 THEN RAISE EXCEPTION 'Auth runtime role can access tables outside codexia_auth'; END IF;
  SELECT count(*) INTO invalid_auth_sequence_grants
  FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname NOT IN ('codexia_auth','information_schema') AND n.nspname NOT LIKE 'pg_%'
    AND c.relkind='S' AND (has_sequence_privilege('codexia_auth_runtime',c.oid,'USAGE') OR
                           has_sequence_privilege('codexia_auth_runtime',c.oid,'SELECT') OR
                           has_sequence_privilege('codexia_auth_runtime',c.oid,'UPDATE'));
  IF invalid_auth_sequence_grants<>0 THEN RAISE EXCEPTION 'Auth runtime role can access sequences outside codexia_auth'; END IF;
  SELECT count(*) INTO invalid_schema_create
  FROM pg_namespace n
  WHERE n.nspname NOT IN ('codexia_auth','information_schema') AND n.nspname NOT LIKE 'pg_%'
    AND has_schema_privilege('codexia_auth_runtime',n.oid,'CREATE');
  IF invalid_schema_create<>0 THEN RAISE EXCEPTION 'Auth runtime role can create objects outside codexia_auth'; END IF;
END
$codexia_auth_check$;
SQL
}

assert_role_permissions(){
  assert_role_security
  admin_psql <<'SQL'
DO $codexia_auth_check$
DECLARE
  invalid_auth_table_grants integer;
  invalid_auth_sequence_grants integer;
  invalid_schema_create integer;
BEGIN
  SELECT count(*) INTO invalid_auth_table_grants
  FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname NOT IN ('codexia_auth','information_schema') AND n.nspname NOT LIKE 'pg_%'
    AND c.relkind IN ('r','p','v','m','f')
    AND (has_table_privilege('codexia_auth_runtime',c.oid,'SELECT') OR
         has_table_privilege('codexia_auth_runtime',c.oid,'INSERT') OR
         has_table_privilege('codexia_auth_runtime',c.oid,'UPDATE') OR
         has_table_privilege('codexia_auth_runtime',c.oid,'DELETE') OR
         has_table_privilege('codexia_auth_runtime',c.oid,'TRUNCATE') OR
         has_table_privilege('codexia_auth_runtime',c.oid,'REFERENCES') OR
         has_table_privilege('codexia_auth_runtime',c.oid,'TRIGGER'));
  IF invalid_auth_table_grants<>0 THEN RAISE EXCEPTION 'Auth runtime role can access tables outside codexia_auth'; END IF;
  SELECT count(*) INTO invalid_auth_sequence_grants
  FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname NOT IN ('codexia_auth','information_schema') AND n.nspname NOT LIKE 'pg_%'
    AND c.relkind='S' AND (has_sequence_privilege('codexia_auth_runtime',c.oid,'USAGE') OR
                           has_sequence_privilege('codexia_auth_runtime',c.oid,'SELECT') OR
                           has_sequence_privilege('codexia_auth_runtime',c.oid,'UPDATE'));
  IF invalid_auth_sequence_grants<>0 THEN RAISE EXCEPTION 'Auth runtime role can access sequences outside codexia_auth'; END IF;
  SELECT count(*) INTO invalid_schema_create
  FROM pg_namespace n
  WHERE n.nspname NOT IN ('codexia_auth','information_schema') AND n.nspname NOT LIKE 'pg_%'
    AND has_schema_privilege('codexia_auth_runtime',n.oid,'CREATE');
  IF invalid_schema_create<>0 THEN RAISE EXCEPTION 'Auth runtime role can create objects outside codexia_auth'; END IF;
END
$codexia_auth_check$;
SQL
}

case "$operation" in
  inspect)
    admin_psql <<'SQL'
SELECT json_build_object(
  'applicationLedgerExists', to_regclass('public.codexia_schema_migrations') IS NOT NULL,
  'roleExists', EXISTS (SELECT 1 FROM pg_roles WHERE rolname='codexia_auth_runtime'),
  'schemaExists', EXISTS (SELECT 1 FROM pg_namespace WHERE nspname='codexia_auth'),
  'schemaOwner', COALESCE((SELECT pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname='codexia_auth'),''),
  'authObjects', (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='codexia_auth' AND c.relkind IN ('r','p','v','m','f'))
)::text;
SQL
    ;;
  initialize-application)
    image="$3"
    state_dir="$(dirname -- "$lock_file")"
    pending="$state_dir/deploy-transaction.json"
    unit="$HOME/.config/containers/systemd/codexia-api.container"
    [[ ! -e "$pending" && ! -L "$pending" && ! -e "$unit" && ! -L "$unit" ]] ||
      die 'Application initialization requires a fresh host without an API unit or pending deployment'
    if podman container exists codexia-api; then
      die 'Application initialization requires a fresh host without an API container'
    elif [[ $? != 1 ]]; then
      die 'Could not verify that no API container exists'
    fi
    podman run --rm --pull=missing --network codexia-data \
      --secret=codexia-postgres-app-password,type=mount,target=/run/secrets/app-password \
      --entrypoint=node "$image" --input-type=module -e '
        import { readFileSync } from "node:fs";
        import { initializeFreshPostgresSchema } from "@codexia/persistence-postgres";
        const identity = JSON.parse(readFileSync("/app/update-identity.json", "utf8"));
        if (identity.format !== "codexia-backend-identity/v1" || identity.profile !== "full") {
          throw new Error("Application initialization requires a packaged Full image");
        }
        const password = readFileSync("/run/secrets/app-password", "utf8").trim();
        if (!/^[a-fA-F0-9]{64}$/.test(password)) throw new Error("Database application secret is invalid");
        const applied = await initializeFreshPostgresSchema(`postgres://codexia:${password}@codexia-db:5432/codexia`);
        console.log(applied.length ? "INITIALIZED_FRESH_SCHEMA" : "VERIFIED_EXACT_SCHEMA");
      '
    ;;
  verify)
    IFS= read -r auth_password_b64 || die 'Auth password input is missing'
    [[ "$auth_password_b64" =~ ^[A-Za-z0-9+/]+={0,2}$ ]] || die 'Auth password input is invalid'
    auth_password="$(printf '%s' "$auth_password_b64" | base64 --decode)" || die 'Auth password input is invalid'
    [[ -n "$auth_password" && ! "$auth_password" =~ [[:cntrl:]] ]] || die 'Auth password input is invalid'
    assert_role_security
    runtime_user="$(printf '%s\n' "$auth_password" | podman exec -i codexia-db sh -ec '
      IFS= read -r PGPASSWORD || exit 72
      export PGPASSWORD
      exec psql -X -qAt -v ON_ERROR_STOP=1 -h 127.0.0.1 -U codexia_auth_runtime -d codexia -c "SELECT current_user"
    ')" || die 'Auth runtime role password or login is invalid'
    [[ "$runtime_user" == codexia_auth_runtime ]] || die 'Auth runtime role login identity is invalid'
    printf '%s\n' 'AUTH_RUNTIME_ROLE_VERIFIED'
    ;;
  verify-permissions)
    assert_role_permissions
    schema_exists="$(admin_psql <<'SQL'
SELECT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname='codexia_auth');
SQL
)"
    if [[ "$schema_exists" == t ]]; then assert_role_state; fi
    printf '%s\n' 'AUTH_RUNTIME_ROLE_PERMISSIONS_VERIFIED'
    ;;
  converge)
    IFS= read -r auth_password_b64 || die 'Auth password input is missing'
    [[ "$auth_password_b64" =~ ^[A-Za-z0-9+/]+={0,2}$ ]] || die 'Auth password input is invalid'
    auth_password="$(printf '%s' "$auth_password_b64" | base64 --decode)" || die 'Auth password input is invalid'
    [[ -n "$auth_password" && ! "$auth_password" =~ [[:cntrl:]] ]] || die 'Auth password input is invalid'
    {
      printf "\\set auth_password_b64 '%s'\n" "$auth_password_b64"
      cat <<'SQL'
SELECT format('CREATE ROLE codexia_auth_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD %L', convert_from(decode(:'auth_password_b64','base64'),'UTF8'))
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='codexia_auth_runtime')
\gexec
DO $codexia_auth_existing_schema_check$
DECLARE auth_role_oid oid;
BEGIN
  SELECT oid INTO auth_role_oid FROM pg_authid WHERE rolname='codexia_auth_runtime';
  IF auth_role_oid IS NULL THEN RAISE EXCEPTION 'Auth runtime role could not be created'; END IF;
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname='codexia_auth' AND nspowner<>auth_role_oid) THEN
    RAISE EXCEPTION 'Auth schema exists with an unexpected owner';
  END IF;
END
$codexia_auth_existing_schema_check$;
  SELECT format('CREATE SCHEMA codexia_auth AUTHORIZATION codexia_auth_runtime')
WHERE NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname='codexia_auth')
\gexec
GRANT CONNECT ON DATABASE codexia TO codexia_auth_runtime;
GRANT USAGE, CREATE ON SCHEMA codexia_auth TO codexia_auth_runtime;
ALTER ROLE codexia_auth_runtime IN DATABASE codexia SET search_path TO codexia_auth;
SQL
    } | admin_psql
    assert_role_state
    runtime_user="$(printf '%s\n' "$auth_password" | podman exec -i codexia-db sh -ec '
      IFS= read -r PGPASSWORD || exit 72
      export PGPASSWORD
      exec psql -X -qAt -v ON_ERROR_STOP=1 -h 127.0.0.1 -U codexia_auth_runtime -d codexia -c "SELECT current_user || chr(124) || current_schema()"
    ')" || die 'Auth runtime role password or login is invalid'
    [[ "$runtime_user" == 'codexia_auth_runtime|codexia_auth' ]] || die 'Auth runtime role search path is invalid'
    printf '%s\n' 'AUTH_RUNTIME_ROLE_AND_SCHEMA_VERIFIED'
    ;;
esac
