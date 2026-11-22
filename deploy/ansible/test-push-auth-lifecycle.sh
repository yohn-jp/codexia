#!/usr/bin/env bash
# Run inside the disposable host, SSHFS and OCI registry from test-push-app-lifecycle.sh.
run_better_auth_lifecycle() {
  local auth_context="$build_context/auth"
  local proxy_context="$build_context/auth-proxy"
  local auth_dir="$fixture_home/.config/codexia-auth"
  local origin=https://codexia-lifecycle-proxy:4443
  local web=codexia-fixture-web ios=codexia-fixture-ios introspection=codexia-fixture-introspection
  local base_image primary_image update_image failed_image launcher_pid owner token proof prior database_before

  auth_fixture() {
    rootless_podman exec -i codexia-lifecycle-proxy node /fixture/push-auth-lifecycle-oidc.mjs "$@"
  }
  build_auth_candidate() {
    local scenario=$1 tag digest immutable digest_file recipe
    tag="localhost:5000/yohn-jp/codexia-backend:$scenario-$source_sha"
    digest_file="$auth_context/$scenario.digest"
    recipe="$auth_context/$scenario.Dockerfile"
    rootless cp "$auth_context/Dockerfile" "$recipe" || return
    if [[ "$scenario" == auth-failed ]]; then
      rootless sh -c 'printf "%s\n" "ENTRYPOINT [\"/bin/false\"]" >> "$1"' sh "$recipe" || return
    fi
    rootless_podman build --no-cache --pull=never --build-arg "BASE_IMAGE=$base_image" \
      --label "org.codexia.lifecycle-scenario=$scenario" --file "$recipe" \
      -t "$tag" "$auth_context" >"$tmp/$scenario-build.log" 2>&1 || {
        redact_log "$tmp/$scenario-build.log" "$RUNNER_TEMP/codexia-push-app-lifecycle/$scenario-build-bounded.log"
        return 1
      }
    rootless_podman push --digestfile "$digest_file" "$tag" >"$tmp/$scenario-push.log" 2>&1 || {
      redact_log "$tmp/$scenario-push.log" "$RUNNER_TEMP/codexia-push-app-lifecycle/$scenario-push-bounded.log"
      return 1
    }
    digest=$(rootless cat "$digest_file") || return
    immutable="ghcr.io/yohn-jp/codexia-backend@$digest"
    node "$repo_root/scripts/push-app-lifecycle.mjs" record-auth "$scenario" "$immutable" || return
    printf '%s\n' "$immutable"
  }
  observe_auth() {
    local image=$1
    rootless cat "$fixture_home/.local/state/codexia-deploy/deployed-release.json" | node -e '
      const assert=require("node:assert/strict"), fs=require("node:fs");
      const release=JSON.parse(fs.readFileSync(0,"utf8"));
      assert.equal(release.authMode,"better-auth");
      assert.match(release.authSettingsSha256,/^[a-f0-9]{64}$/);
      assert.equal(release.image,process.argv[1]);
      console.log(release.authSettingsSha256);' "$image"
    printf '%s' "$token" | auth_fixture probe -
    rootless_podman exec codexia-db sh -ec 'export PGPASSWORD="$(cat /run/secrets/admin-password)"; exec psql -X -Aqt -v ON_ERROR_STOP=1 -U codexia_admin -d codexia -c "SELECT oid || chr(58) || pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname = '\''codexia_auth'\'';"'
  }
  record_auth() {
    local checkpoint=$1 candidate=$2 observation=$3
    local public_proof
    public_proof=$(node - "$checkpoint" "$candidate" "$observation" <<'NODE'
const assert = require('node:assert/strict');
const [checkpoint, image, observation] = process.argv.slice(2);
const [settingsSha256, jwks, schemaIdentity] = observation.trim().split('\n');
const {keyIds} = JSON.parse(jwks);
assert.match(settingsSha256, /^[a-f0-9]{64}$/);
assert.ok(Array.isArray(keyIds) && keyIds.length > 0 && keyIds.every(key => typeof key === 'string'));
assert.match(schemaIdentity, /^[0-9]+:codexia_auth_runtime$/);
console.log(JSON.stringify({ checkpoint, image, settingsSha256, keyIds, schemaIdentity, ownerSessionVerified: true }));
NODE
)
    append_observation betterAuth "$public_proof"
  }
  release_checksums() {
    rootless sha256sum "$fixture_home/.local/state/codexia-deploy/deployed-release.json" \
      "$fixture_home/.config/containers/systemd/codexia-api.container"
  }
  observe_auth_database() {
    rootless_podman exec -i codexia-db sh -ec 'export PGPASSWORD="$(cat /run/secrets/admin-password)"; exec psql -X -Aqt -v ON_ERROR_STOP=1 -U codexia_admin -d codexia' <<'SQL'
BEGIN READ ONLY;
SELECT COALESCE((SELECT (to_jsonb(r) - 'rolpassword')::text FROM pg_roles r WHERE rolname = 'codexia_auth_runtime'), 'no auth role');
SELECT COALESCE((SELECT oid || ':' || pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname = 'codexia_auth'), 'no auth schema');
SELECT COALESCE(string_agg(n.nspname || '.' || c.relname || ':' || c.oid, ',' ORDER BY n.nspname, c.relname), 'no application relations')
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname IN ('public', 'codexia_auth');
SELECT to_regclass('public.codexia_schema_migrations') IS NOT NULL AS has_ledger \gset
\if :has_ledger
SELECT COALESCE(jsonb_agg(to_jsonb(m) ORDER BY to_jsonb(m))::text, '[]') FROM public.codexia_schema_migrations m;
\else
SELECT 'no application ledger';
\endif
COMMIT;
SQL
  }
  require_inactive_api() {
    local status=0
    rootless_podman container exists codexia-api || status=$?
    [[ $status == 1 ]]
    [[ "$(rootless_systemctl show --property=ActiveState --value codexia-api.service)" == inactive ]]
    rootless test ! -e "$fixture_home/.config/containers/systemd/codexia-api.container"
    rootless test ! -e "$fixture_home/.local/state/codexia-deploy/deployed-release.json"
    rootless test ! -e "$fixture_home/.local/state/codexia-deploy/deploy-transaction.json"
  }
  require_approval_rejection() {
    local name=$1 expected_task=$2
    awk -v expected_task="$expected_task" '
      /^TASK \[/ { is_approval_task = index($0, "[" expected_task "]") != 0 }
      is_approval_task && /^fatal: .*FAILED!/ { rejected = 1 }
      END { exit !rejected }
    ' "$tmp/$name.log" || {
      echo "$name failed outside the expected approval gate" >&2
      cat "$RUNNER_TEMP/codexia-push-app-lifecycle/$name-bounded.log" >&2
      return 1
    }
  }

  set_state better_auth_activation IN_PROGRESS
  sudo install -d -o codexia -g codexia -m 0755 "$auth_context" "$proxy_context"
  openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj /CN=codexia-lifecycle-proxy \
    -addext 'subjectAltName=DNS:codexia-lifecycle-proxy,DNS:codexia-auth-registration' \
    -keyout "$tmp/auth-tls.key" -out "$tmp/auth-tls.crt" >"$tmp/auth-certificate.log" 2>&1
  sudo install -o codexia -g codexia -m 0644 "$tmp/auth-tls.crt" "$auth_context/tls.crt"
  sudo install -o codexia -g codexia -m 0644 "$tmp/auth-tls.crt" "$proxy_context/tls.crt"
  sudo install -o codexia -g codexia -m 0644 "$repo_root/scripts/push-auth-lifecycle-oidc.mjs" "$proxy_context/push-auth-lifecycle-oidc.mjs"
  sudo install -o codexia -g codexia -m 0600 "$tmp/auth-tls.key" "$proxy_context/tls.key"
  base_image=$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).candidates.head.image' "$evidence")
  cat >"$tmp/auth.Dockerfile" <<'DOCKERFILE'
ARG BASE_IMAGE
FROM $BASE_IMAGE
COPY tls.crt /fixture-ca.crt
ENV NODE_EXTRA_CA_CERTS=/fixture-ca.crt
DOCKERFILE
  sudo install -o codexia -g codexia -m 0644 "$tmp/auth.Dockerfile" "$auth_context/Dockerfile"
  primary_image=$(build_auth_candidate auth-primary)
  update_image=$(build_auth_candidate auth-update)
  failed_image=$(build_auth_candidate auth-failed)
  [[ "$primary_image" != "$update_image" && "$primary_image" != "$failed_image" && "$update_image" != "$failed_image" ]]
  rootless_podman run -d --name codexia-lifecycle-proxy --userns=keep-id:uid=1000,gid=1000 \
    --user 1000:1000 --network codexia --read-only --cap-drop=all --security-opt=no-new-privileges \
    --volume "$proxy_context:/fixture:ro" --entrypoint=node "$primary_image" \
    /fixture/push-auth-lifecycle-oidc.mjs serve >/dev/null

  rootless_podman pull "$primary_image" >/dev/null
  if rootless_podman secret exists codexia-auth-token; then
    echo 'Fresh deployment fixture unexpectedly has a legacy application token' >&2
    return 1
  fi
  printf '%s' 'postgresql://codexia_auth_runtime:codexia-fixture-database-32-characters@codexia-db:5432/codexia' >"$tmp/auth-database-url"
  printf '%s' 'codexia-fixture-auth-secret-32-characters' >"$tmp/auth-secret"
  printf '%s' 'codexia-fixture-oidc-secret-32-characters' >"$tmp/auth-oidc-secret"
  printf '%s' 'codexia-fixture-introspection-secret-32-characters' >"$tmp/auth-introspection-secret"
  chmod 0600 "$tmp/auth-database-url" "$tmp/auth-secret" "$tmp/auth-oidc-secret" "$tmp/auth-introspection-secret"
  cat > "$tmp/auth-stage.yml" <<YAML
codexia_stage: auth-runtime
codexia_service_user: codexia
codexia_service_group: codexia
codexia_service_uid: $fixture_uid
codexia_service_home: "$fixture_home"
codexia_auth_runtime_approved: true
codexia_database_initialization_approved: true
codexia_auth_bootstrap_image: "$primary_image"
codexia_auth_registration_pending: true
codexia_auth_database_url_file: "$tmp/auth-database-url"
codexia_auth_secret_file: "$tmp/auth-secret"
codexia_oidc_client_secret_file: "$tmp/auth-oidc-secret"
codexia_oauth_introspection_client_secret_file: "$tmp/auth-introspection-secret"
codexia_public_origin: "$origin"
codexia_oidc_issuer: "$origin/idp"
codexia_oidc_client_id: codexia-fixture-client
codexia_oauth_introspection_client_id: "$introspection"
codexia_oauth_owner_client_ids: "$web,$ios"
YAML
  sed 's/codexia_database_initialization_approved: true/codexia_database_initialization_approved: false/' \
    "$tmp/auth-stage.yml" > "$tmp/auth-stage-unapproved.yml"
  database_before=$(observe_auth_database)
  [[ "$database_before" == $'no auth role\nno auth schema\nno application relations\nno application ledger' ]]
  require_inactive_api
  if run_playbook "$tmp/auth-stage-unapproved.yml" auth-schema-unapproved; then
    echo 'Fresh application schema initialization bypassed approval' >&2
    return 1
  fi
  require_approval_rejection auth-schema-unapproved \
    'Require explicit approval and a reviewed immutable Full image before initializing application storage'
  [[ "$(observe_auth_database)" == "$database_before" ]]
  require_inactive_api
  run_playbook "$tmp/auth-stage.yml" auth-stage-pending
  cat >"$tmp/bootstrap.env" <<ENV
CODEXIA_AUTH_BOOTSTRAP_ORIGIN=https://codexia-auth-registration:8443
CODEXIA_AUTH_BOOTSTRAP_OWNER_OIDC_SUBJECT=codexia-fixture-owner
CODEXIA_AUTH_BOOTSTRAP_WEB_REDIRECT_URIS=$origin/desktop,$origin/mobile
ENV
  sudo install -o codexia -g codexia -m 0600 "$tmp/bootstrap.env" "$tmp/auth-tls.key" "$tmp/auth-tls.crt" "$auth_dir"
  rootless mv "$auth_dir/auth-tls.key" "$auth_dir/tls.key"
  rootless mv "$auth_dir/auth-tls.crt" "$auth_dir/tls.crt"
  rootless "$fixture_home/.local/bin/codexia-register-auth" --apply "$primary_image" >"$tmp/auth-bootstrap.log" 2>&1 &
  launcher_pid=$!
  for _ in $(seq 1 60); do
    grep -Fq 'Better Auth bootstrap is ready.' "$tmp/auth-bootstrap.log" && break
    kill -0 "$launcher_pid" || { wait "$launcher_pid"; return 1; }
    sleep 1
  done
  grep -Fq 'Better Auth bootstrap is ready.' "$tmp/auth-bootstrap.log"
  auth_fixture register >"$tmp/auth-registration.json"
  owner=$(node - "$tmp/auth-registration.json" "$web" "$ios" "$introspection" <<'NODE'
const assert = require('node:assert/strict');
const fs = require('node:fs');
const [file, web, ios, introspection] = process.argv.slice(2);
const record = JSON.parse(fs.readFileSync(file, 'utf8'));
assert.deepEqual([record.webClientId, record.iosClientId, record.introspectionClientId], [web, ios, introspection]);
assert.match(record.ownerSubject, /^[a-zA-Z0-9._@:/|+-]+$/);
process.stdout.write(record.ownerSubject);
NODE
)
  rootless_podman stop --time 10 codexia-auth-registration >/dev/null
  wait "$launcher_pid"
  rootless rm -f "$auth_dir/bootstrap.env" "$auth_dir/tls.crt" "$auth_dir/tls.key"
  sed -i 's/codexia_auth_registration_pending: true/codexia_auth_registration_pending: false/' "$tmp/auth-stage.yml"
  printf 'codexia_oauth_owner_subject: "%s"\n' "$owner" >>"$tmp/auth-stage.yml"
  run_playbook "$tmp/auth-stage.yml" auth-stage-final

  database_before=$(observe_auth_database)
  [[ "$database_before" != *'no auth role'* && "$database_before" != *'no auth schema'* && "$database_before" != *'no application ledger'* ]]
  require_inactive_api
  if run_deploy head false '' auth-first-install-unapproved; then
    echo 'Fresh Better Auth activation bypassed its explicit installation approval' >&2
    return 1
  fi
  require_approval_rejection auth-first-install-unapproved \
    'Require explicit disposable approvals for pristine database initialization'
  [[ "$(observe_auth_database)" == "$database_before" ]]
  require_inactive_api
  run_application_lifecycle

  run_deploy auth-primary false '' auth-verified-activation
  auth_fixture authorize "$web" "$owner" >"$tmp/auth-session.json"
  token=$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).accessToken' "$tmp/auth-session.json")
  proof=$(observe_auth "$primary_image")
  grep -Eq '^[0-9]+:codexia_auth_runtime$' <<<"$proof"
  observe_runtime better-auth-activation auth-primary
  record_auth better-auth-activation "$primary_image" "$proof"
  set_state better_auth_activation PASS 'isolated HTTPS registration, discovery and protected owner session verified'

  prior=$(release_checksums)
  run_deploy auth-primary false '' auth-same-digest
  [[ "$(release_checksums)" == "$prior" && "$(observe_auth "$primary_image")" == "$proof" ]]
  observe_runtime better-auth-same-digest auth-primary
  record_auth better-auth-same-digest "$primary_image" "$proof"
  set_state better_auth_same_digest PASS 'same release, settings, signing keys, auth schema and owner session'

  run_deploy auth-update false '' auth-compatible-update
  [[ "$(observe_auth "$update_image")" == "$proof" ]]
  observe_runtime better-auth-compatible-update auth-update
  record_auth better-auth-compatible-update "$update_image" "$proof"
  set_state better_auth_compatible_update PASS 'alternate OCI digest with original signing keys, schema and owner session'

  prior=$(release_checksums)
  if run_deploy auth-failed false '' auth-failed-candidate; then
    echo 'Deliberately failing Better Auth candidate unexpectedly deployed' >&2
    return 1
  fi
  grep -Eq 'Deployment transaction failed during candidate API (startup|readiness)' "$tmp/auth-failed-candidate.log"
  [[ "$(release_checksums)" == "$prior" && "$(observe_auth "$update_image")" == "$proof" ]]
  rootless test ! -e "$fixture_home/.local/state/codexia-deploy/deploy-transaction.json"
  observe_runtime better-auth-rollback auth-update
  record_auth better-auth-rollback "$update_image" "$proof"
  set_state better_auth_rollback PASS 'failed candidate restored exact Better Auth Quadlet, release, keys, schema and owner session'
}
