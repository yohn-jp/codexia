#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

die(){ printf '%s\n' "$1" >&2; exit 1; }
[[ $# -ge 2 && $# -le 6 ]] || die 'An auth bootstrap operation and its protected inputs are required'
operation="$1"
lock_file="$2"
image="${3:-}"
image_repository="${CODEXIA_IMAGE_REPOSITORY:-}"
reviewed_image() {
  [[ "$image_repository" =~ ^ghcr\.io/[a-z0-9-]+/codexia-backend$ &&
     "$1" == "$image_repository@"* && "${1#*@}" =~ ^sha256:[a-f0-9]{64}$ ]]
}
[[ "$lock_file" == /* && ! "$lock_file" =~ [[:cntrl:]] ]] || die 'Invalid auth bootstrap lock path'
[[ "$lock_file" == "$HOME/.local/state/codexia-deploy/host.lock" ]] || die 'Auth bootstrap requires the canonical host lock'
if [[ -e "$lock_file" || -L "$lock_file" ]]; then
  [[ -f "$lock_file" && ! -L "$lock_file" && -O "$lock_file" ]] ||
    die 'The canonical deployment host lock is unsafe'
elif [[ "$operation" != inspect ]]; then
  die 'The canonical deployment host lock is missing'
fi
repository="${CODEXIA_TARGET_REPOSITORY:-}"
repository_id="${CODEXIA_TARGET_REPOSITORY_ID:-}"
owner_id="${CODEXIA_TARGET_OWNER_ID:-}"
if [[ -n "$image" ]]; then
  [[ "$repository" =~ ^[A-Za-z0-9-]+/codexia$ && "$repository_id" =~ ^[1-9][0-9]*$ && "$owner_id" =~ ^[1-9][0-9]*$ ]] ||
    die 'Reviewed deployment repository identity is required'
fi
case "$operation" in
  inspect|verify|verify-permissions) [[ $# == 2 ]] || die 'Unexpected auth bootstrap argument' ;;
  initialize-application)
    reviewed_image "$image" && [[
       ( $# == 3 || ( $# == 4 && "$4" == OWNER_SETUP ) ) ]] ||
      die 'Application initialization requires a reviewed immutable Full image' ;;
  verify-bootstrap-resume|converge)
    [[ "$operation" == converge && $# == 2 ]] ||
      { reviewed_image "$image" &&
        [[ ( $# == 5 || ( $# == 6 && "$6" == empty-auth-schema ) ) &&
           "$4" =~ ^[1-9][0-9]{0,19}:[1-9][0-9]{0,9}$ && "$5" =~ ^sha256:[a-f0-9]{64}$ ]]; } ||
      die 'Bootstrap resumption requires the approved database, Full image and migration fingerprint' ;;
  verify-empty-auth-resume-held)
    reviewed_image "$image" && [[ $# == 5 &&
       "$4" =~ ^[1-9][0-9]{0,19}:[1-9][0-9]{0,9}$ &&
       ( "$5" == candidate || "$5" =~ ^sha256:[a-f0-9]{64}$ ) ]] ||
      die 'Empty-auth resumption requires the approved database, Full image and migration fingerprint' ;;
  *) die 'Invalid auth bootstrap operation' ;;
esac

if [[ "$operation" == verify-empty-auth-resume-held ]]; then
  [[ -e /proc/self/fd/9 && "$(readlink -- /proc/self/fd/9)" == "$lock_file" ]] ||
    die 'Empty-auth validation requires the caller-held deployment host lock'
  flock --exclusive --nonblock 9 || die 'The caller no longer holds the deployment host lock'
else
  if [[ "$operation" == inspect && ! -e "$lock_file" && ! -L "$lock_file" ]]; then
    exec 9>"$lock_file"
  else
    exec 9<>"$lock_file"
  fi
  flock --exclusive --nonblock 9 || die 'Another Codexia deployment or backup holds the host lock'
fi

read_auth_password(){
  case "${CODEXIA_AUTH_PASSWORD_SOURCE:-stdin}" in
    stdin) IFS= read -r auth_password_b64 || die 'Auth password input is missing' ;;
    podman) auth_password_b64="$("$HOME/.local/bin/codexia-bootstrap-secrets" auth-password)" || die 'Cannot read the installed Auth database credential' ;;
    *) die 'Unknown Auth database credential source' ;;
  esac
  [[ "$auth_password_b64" =~ ^[A-Za-z0-9+/]+={0,2}$ ]] || die 'Auth password input is invalid'
  auth_password="$(printf '%s' "$auth_password_b64" | base64 --decode)" || die 'Auth password input is invalid'
  [[ -n "$auth_password" && ! "$auth_password" =~ [[:cntrl:]] ]] || die 'Auth password input is invalid'
}

admin_psql(){
  podman exec -i codexia-db sh -ec 'export PGPASSWORD="$(cat /run/secrets/admin-password)"; exec psql -X -qAt -v ON_ERROR_STOP=1 -U codexia_admin -d codexia'
}

application_schema(){
  podman run --rm --pull=missing --network codexia-data \
    --secret=codexia-postgres-app-password,type=mount,target=/run/secrets/app-password \
    --entrypoint=node "$image" --input-type=module -e '
      import { readFileSync } from "node:fs";
      import { initializeFreshPostgresSchema, inspectFreshPostgresSchema } from "@codexia/persistence-postgres";
      const identity = JSON.parse(readFileSync("/app/update-identity.json", "utf8"));
      if (identity.format !== "codexia-backend-identity/v1" || identity.profile !== "full") {
        throw new Error("Application initialization requires a packaged Full image");
      }
      const password = readFileSync("/run/secrets/app-password", "utf8").trim();
      if (!/^[a-fA-F0-9]{64}$/.test(password)) throw new Error("Database application secret is invalid");
      const connection = `postgres://codexia:${password}@codexia-db:5432/codexia`;
      const [operation, fingerprint] = process.argv.slice(1);
      if (operation === "apply") {
        const applied = await initializeFreshPostgresSchema(connection);
        console.log(applied.length ? "INITIALIZED_FRESH_SCHEMA" : "VERIFIED_EXACT_SCHEMA");
      } else {
        const observed = await inspectFreshPostgresSchema(connection);
        const expected = fingerprint === "candidate" ? identity.migrationFingerprint : fingerprint;
        if (operation === "require-pristine" && !observed.pristine) {
          throw new Error("Fresh owner setup refuses an existing application ledger");
        }
        if (operation === "require-ledger" && (observed.pristine || observed.fingerprint !== expected ||
            identity.migrationFingerprint !== expected)) {
          throw new Error("Bootstrap resumption requires the exact approved application ledger");
        }
      }
    ' "$@"
}

verify_bootstrap_resume(){
  local expected_database="$1" fingerprint="$2" database intent
  local state_dir="$HOME/.local/state/codexia-deploy"
  "$HOME/.local/bin/codexia-require-clean-api-target"
  intent="$state_dir/owner-setup.intent"
  [[ -f "$intent" && ! -L "$intent" && -O "$intent" && "$(stat -c %a -- "$intent")" == 600 &&
     "$(cat -- "$intent")" == "$repository:$repository_id:$owner_id:$expected_database:$image" ]] ||
    die 'Bootstrap resumption requires the exact recorded initial installation'
  for evidence in owner-setup.installation owner-setup.promoted owner-setup.age owner-setup.age.pending cutover-transaction.json; do
    [[ ! -e "$state_dir/$evidence" && ! -L "$state_dir/$evidence" ]] ||
      die 'Bootstrap resumption requires a target without owner setup or cutover evidence'
  done
  database="$(admin_psql <<'SQL'
SELECT system_identifier || chr(58) || (SELECT oid FROM pg_database WHERE datname=current_database())
FROM pg_control_system()
WHERE to_regclass('public.codexia_schema_migrations') IS NOT NULL
  AND NOT EXISTS (SELECT FROM pg_namespace WHERE nspname='codexia_auth');
SQL
)"
  [[ "$database" == "$expected_database" ]] ||
    die 'Bootstrap resumption no longer matches the current database or Auth schema state'
  application_schema require-ledger "$fingerprint"
}

verify_empty_auth_resume(){
  local expected_database="$1" fingerprint="$2"
  local state_dir="$HOME/.local/state/codexia-deploy" intent database
  "$HOME/.local/bin/codexia-require-clean-api-target"
  intent="$state_dir/owner-setup.intent"
  [[ -f "$intent" && ! -L "$intent" && -O "$intent" && "$(stat -c %a -- "$intent")" == 600 &&
     "$(cat -- "$intent")" == "$repository:$repository_id:$owner_id:$expected_database:$image" ]] ||
    die 'Empty-auth resumption requires the exact recorded initial installation'
  for evidence in owner-setup.installation owner-setup.promoted owner-setup.age owner-setup.age.pending cutover-transaction.json; do
    [[ ! -e "$state_dir/$evidence" && ! -L "$state_dir/$evidence" ]] ||
      die 'Empty-auth resumption found owner or API deployment residue'
  done
  database="$(admin_psql <<'SQL'
SELECT system_identifier || chr(58) || d.oid::text
FROM pg_control_system(), pg_database d JOIN pg_namespace n ON n.nspname='codexia_auth'
JOIN pg_roles r ON r.rolname='codexia_auth_runtime' AND n.nspowner=r.oid
WHERE d.datname=current_database() AND r.rolcanlogin AND NOT r.rolsuper AND NOT r.rolcreatedb
  AND NOT r.rolcreaterole AND NOT r.rolinherit AND NOT r.rolreplication AND NOT r.rolbypassrls
  AND NOT EXISTS (SELECT FROM pg_auth_members WHERE member=r.oid OR roleid=r.oid)
  AND NOT EXISTS (SELECT FROM pg_default_acl WHERE defaclrole=r.oid)
  AND NOT EXISTS (SELECT FROM aclexplode(COALESCE(n.nspacl, acldefault('n',n.nspowner))) a WHERE a.grantee<>n.nspowner)
  AND NOT EXISTS (SELECT FROM pg_depend dep WHERE dep.refclassid='pg_namespace'::regclass AND dep.refobjid=n.oid)
  AND NOT EXISTS (SELECT FROM pg_class c WHERE c.relnamespace=n.oid)
  AND NOT EXISTS (SELECT FROM pg_proc p WHERE p.pronamespace=n.oid)
  AND NOT EXISTS (SELECT FROM pg_type t WHERE t.typnamespace=n.oid)
SQL
)"
  [[ "$database" == "$expected_database" ]] || die 'Empty-auth resumption no longer matches the approved database or namespace'
  application_schema require-ledger "$fingerprint"
  assert_role_state
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
    "$HOME/.local/bin/codexia-require-clean-api-target"
    if [[ $# == 4 ]]; then
      state_dir="$HOME/.local/state/codexia-deploy"
      intent="$state_dir/owner-setup.intent"
      database="$(admin_psql <<'SQL'
SELECT system_identifier || chr(58) || (SELECT oid FROM pg_database WHERE datname=current_database())
FROM pg_control_system()
WHERE NOT EXISTS (SELECT FROM pg_namespace WHERE nspname='codexia_auth');
SQL
)"
      [[ "$database" =~ ^[1-9][0-9]{0,19}:[1-9][0-9]{0,9}$ ]] ||
        die 'Fresh owner setup requires a known PostgreSQL database without an auth schema'
      if [[ -e "$intent" || -L "$intent" ]]; then
        [[ -f "$intent" && ! -L "$intent" && -O "$intent" && "$(stat -c %a -- "$intent")" == 600 &&
           "$(cat -- "$intent")" == "$repository:$repository_id:$owner_id:$database:$image" ]] ||
          die 'Fresh owner setup must match the recorded database and Full image'
      else
        for evidence in owner-setup.installation owner-setup.promoted owner-setup.age owner-setup.age.pending; do
          [[ ! -e "$state_dir/$evidence" && ! -L "$state_dir/$evidence" ]] ||
            die 'Fresh owner setup refuses existing owner installation evidence'
        done
        [[ ! -e "$HOME/.config/codexia-auth/runtime.env" && ! -L "$HOME/.config/codexia-auth/runtime.env" ]] ||
          die 'Fresh owner setup refuses existing runtime configuration'
        application_schema require-pristine
        temporary="$(mktemp "$state_dir/.owner-setup.XXXXXX")"
        printf '%s\n' "$repository:$repository_id:$owner_id:$database:$image" >"$temporary"
        mv -fT -- "$temporary" "$intent"
        sync -f -- "$state_dir"
      fi
    fi
    application_schema apply
    ;;
  verify-bootstrap-resume)
    if [[ $# == 6 ]]; then
      verify_empty_auth_resume "$4" "$5"
    else
      verify_bootstrap_resume "$4" "$5"
    fi
    ;;
  verify-empty-auth-resume-held)
    verify_empty_auth_resume "$4" "$5"
    ;;
  verify)
    read_auth_password
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
    if [[ $# == 5 ]]; then verify_bootstrap_resume "$4" "$5"; fi
    if [[ $# == 6 ]]; then verify_empty_auth_resume "$4" "$5"; fi
    read_auth_password
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
