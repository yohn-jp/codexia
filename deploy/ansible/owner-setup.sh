#!/usr/bin/env bash
# Invoked by auth-runtime for approved first installation, or explicitly by an operator.
set -Eeuo pipefail
umask 077

die() { printf '%s\n' "$1" >&2; exit 1; }
[[ $# -ge 2 && $# -le 5 ]] || die 'An explicit owner setup operation and reviewed Full image are required'
operation="$1"
image="$2"
[[ "$image" =~ ^ghcr\.io/yohn-jp/codexia-backend@sha256:[a-f0-9]{64}$ ]] || die 'A reviewed immutable Full image is required'
config_dir="$HOME/.config/codexia-auth"
state_dir="$HOME/.local/state/codexia-deploy"
unit_dir="$HOME/.config/containers/systemd"
unit="$unit_dir/codexia-api.container"
setup_unit="$config_dir/owner-setup.container"
handoff="$state_dir/owner-setup.age"
handoff_receipt="$state_dir/owner-setup.age.receipt.json"
marker="$state_dir/owner-setup.installation"
intent="$state_dir/owner-setup.intent"
pending_handoff="$state_dir/owner-setup.age.pending"
promoted="$state_dir/owner-setup.promoted"
runtime="$config_dir/runtime.env"
setup_env="$config_dir/owner-setup.env"

if [[ -e "$state_dir/host.lock" || -L "$state_dir/host.lock" ]]; then
  [[ -f "$state_dir/host.lock" && ! -L "$state_dir/host.lock" && -O "$state_dir/host.lock" ]] ||
    die 'The canonical deployment host lock is unsafe'
  exec 9<>"$state_dir/host.lock"
elif [[ $# == 5 || "$operation" == --export-handoff ]]; then
  die 'The canonical deployment host lock is missing'
else
  exec 9>"$state_dir/host.lock"
fi
flock --exclusive --nonblock 9 || die 'Another Codexia operation holds the deployment host lock'
if [[ -v CODEXIA_OWNER_SETUP_EXPECTED_SECRET_SET_SHA256 ]]; then
  "$HOME/.local/bin/codexia-preflight-observe" verify-secret-identities "$CODEXIA_OWNER_SETUP_EXPECTED_SECRET_SET_SHA256" 9>&9 ||
    die 'Podman credential identities changed after approval'
fi
present() { [[ -e "$1" || -L "$1" ]]; }
private_file() { [[ -f "$1" && ! -L "$1" && -O "$1" && "$(stat -c %a -- "$1")" == 600 ]]; }
for journal in {deployed-release,deploy-transaction,cutover-transaction}.json; do
  if present "$state_dir/$journal"; then die 'Owner setup requires a pre-activation deployment'; fi
done
private_file "$runtime" && private_file "$setup_env" && private_file "$setup_unit" ||
  die 'Protected owner setup inputs are missing'
grep -Fxq "Image=$image" "$setup_unit" || die 'The reviewed Full image does not match the staged setup'

# The protected controller supplies these from the verified frontend proof.
expected_origin="${CODEXIA_OWNER_SETUP_EXPECTED_ORIGIN:-}"
expected_web_client="${CODEXIA_OWNER_SETUP_EXPECTED_WEB_CLIENT_ID:-}"
expected_redirects="${CODEXIA_OWNER_SETUP_EXPECTED_WEB_REDIRECT_URIS:-}"
if [[ -n "$expected_origin$expected_web_client$expected_redirects" ]]; then
  origin="$(sed -n 's/^CODEXIA_PUBLIC_ORIGIN=//p' "$runtime")"
  clients="$(sed -n 's/^CODEXIA_OAUTH_OWNER_CLIENT_IDS=//p' "$runtime")"
  redirects="$(sed -n 's/^CODEXIA_OWNER_SETUP_WEB_REDIRECT_URIS=//p' "$setup_env")"
  [[ -n "$expected_origin" && "$origin" == "$expected_origin" &&
     -n "$expected_web_client" && ! "$clients" =~ [[:cntrl:]] && "${clients%%,*}" == "$expected_web_client" &&
     -n "$expected_redirects" && ! "$redirects" =~ [[:cntrl:]] &&
     "$(tr ',' '\n' <<<"$redirects" | LC_ALL=C sort -u)" == "$(tr ',' '\n' <<<"$expected_redirects" | LC_ALL=C sort -u)" ]] ||
    die 'Staged owner setup origin, client or redirect configuration differs from the certified frontend'
fi

run_image() {
  podman run --rm --pull=missing --read-only --network codexia-data \
    --secret=codexia-auth-database-url,type=env,target=CODEXIA_AUTH_DATABASE_URL \
    --secret=codexia-auth-secret,type=env,target=CODEXIA_AUTH_SECRET \
    --secret=codexia-oauth-introspection-client-secret,type=env,target=CODEXIA_OAUTH_INTROSPECTION_CLIENT_SECRET \
    --env-file "$runtime" --env-file "$setup_env" --env CODEXIA_AUTH_MODE=setup-only \
    --entrypoint=node "$image" "$@"
}

operator_script=/app/node_modules/@codexia/api/dist/owner-setup-operator.js

read_database() {
  podman exec -i codexia-db sh -ec '
    export PGPASSWORD="$(cat /run/secrets/admin-password)"
    export PGOPTIONS="-c default_transaction_read_only=on"
    exec psql -X -qAt -v ON_ERROR_STOP=1 -U codexia_admin -d codexia -c "$1"
  ' sh "$1"
}

# This is the same grant identity used by lifecycle Preflight. It discloses
# neither the grant key nor its database digest.
grant_binding_expression="encode(sha256(convert_to(json_build_array(grant_id, extract(epoch FROM expires_at))::text,'UTF8')),'hex')"

live_grant_binding() {
  read_database "SELECT $grant_binding_expression
    FROM codexia_auth.owner_setup WHERE id='first-owner' AND grant_id IS NOT NULL
      AND expires_at > now() AND consumed_at IS NULL AND owner_id IS NULL"
}

assert_empty_auth_resume() {
  local expected_database="$1" fingerprint="$2"
  "$HOME/.local/bin/codexia-auth-runtime-bootstrap" verify-empty-auth-resume-held \
    "$state_dir/host.lock" "$image" "$expected_database" "$fingerprint" 9>&9 >/dev/null ||
    die 'The locked empty-auth checkpoint changed before owner setup'
}

database="$(read_database 'SELECT system_identifier || chr(58) || (SELECT oid FROM pg_database WHERE datname=current_database()) FROM pg_control_system()')"
[[ "$database" =~ ^[1-9][0-9]{0,19}:[1-9][0-9]{0,9}$ ]] ||
  die 'Could not verify PostgreSQL cluster and database identity'

assert_intent() {
  private_file "$intent" && [[ "$(cat -- "$intent")" == "$database:$image" ]] ||
    die 'The approved fresh installation does not match the current database and reviewed Full image'
}

assert_installation() {
  private_file "$marker" || die 'This VM has no approved initial setup record'
  [[ "$(cat -- "$marker")" == "${database%%:*}" ]] ||
    die 'Owner setup cannot be adopted on a replacement PostgreSQL cluster'
  if present "$intent"; then assert_intent; fi
}

assert_approved_checkpoint() {
  [[ -v CODEXIA_OWNER_SETUP_EXPECTED_CHECKPOINT ]] || return 0
  ! present "$promoted" || die 'The owner setup checkpoint changed after approval'

  local setup_marker=false pending=false encrypted=false grant settings='' observed
  if present "$marker"; then setup_marker=true; fi
  if present "$pending_handoff"; then pending=true; fi
  if private_file "$handoff" && [[ -s "$handoff" ]]; then encrypted=true; fi
  grant="$(read_database "SELECT CASE WHEN grant_id IS NOT NULL
    THEN $grant_binding_expression END
    FROM (SELECT 1) seed LEFT JOIN codexia_auth.owner_setup ON id='first-owner'")"
  if grep -q '^CODEXIA_OAUTH_OWNER_SUBJECT=' "$runtime"; then
    settings="$(sha256sum -- "$runtime")"
    settings="${settings%% *}"
  fi
  observed="$(jq -cn --argjson marker "$setup_marker" --argjson pending "$pending" --argjson encrypted "$encrypted" \
    --arg grant "$grant" --arg settings "$settings" '{
      setupMarkerPresent: $marker,
      grantBindingSha256: (if $grant == "" then null else $grant end),
      pendingHandoff: $pending,
      encryptedHandoffPresent: $encrypted,
      settingsSha256: (if $settings == "" then null else $settings end)
    }')"
  jq -e --argjson observed "$observed" '. == $observed' <<<"$CODEXIA_OWNER_SETUP_EXPECTED_CHECKPOINT" >/dev/null 2>&1 ||
    die 'The owner setup checkpoint changed after approval'
}

assert_setup_unit_or_clean() {
  if present "$unit"; then
    private_file "$unit" && cmp -s "$setup_unit" "$unit" || die 'The active API unit differs from the approved setup unit'
  else
    "$HOME/.local/bin/codexia-require-clean-api-target"
  fi
}

assert_tunnel_stopped() {
  local status=0 active
  active="$(systemctl --user show --property=ActiveState --value codexia-tunnel.service)" || status=$?
  [[ ( "$status" == 0 || "$status" == 4 ) && "$active" == inactive ]] ||
    die 'Activation preparation requires a stopped setup Tunnel'
}

verify_setup_api() {
  timeout 30s podman exec codexia-api node --input-type=module -e '
    import { setTimeout as delay } from "node:timers/promises";
    const get = path => fetch("http://127.0.0.1:3000" + path, { signal: AbortSignal.timeout(1500) });
    let ready = false;
    for (let attempt = 0; attempt < 15 && !ready; attempt++) {
      try {
        const response = await get("/health/ready");
        ready = response.ok && (await response.json()).status === "ready";
      } catch { /* The Quadlet may still be starting. */ }
      if (!ready) await delay(500);
    }
    if (!ready) process.exit(1);
    const setup = await get("/api/auth/codexia/setup/status");
    const allowed = process.argv[1] === "--pending" ? ["setup-pending"] : ["setup-pending", "owner-enrolled"];
    if (!setup.ok || !allowed.includes((await setup.json()).state)) process.exit(1);
    for (const path of ["/api/session", "/api/auth/oauth2/authorize", "/mcp"]) {
      const response = await get(path);
      if (response.status !== 403 || (await response.json()).code !== "SETUP_ONLY") process.exit(1);
    }
  ' -- "${1:-}" >/dev/null 2>&1
}

write_marker() {
  local temporary
  temporary="$(mktemp "$state_dir/.owner-setup.XXXXXX")"
  printf '%s\n' "$2" >"$temporary"
  mv -fT -- "$temporary" "$1"
  sync -f -- "$state_dir"
}

encrypt_grant() {
  local recipient="$1"
  shift
  [[ "$recipient" =~ ^age1[0-9a-z]+$ ]] || die 'Owner setup requires a reviewed age recipient'
  local encrypted grant_binding envelope_hash receipt
  write_marker "$pending_handoff" 'handoff-in-progress'
  encrypted="$(mktemp "$state_dir/.owner-setup.XXXXXX")"
  if ! (
    set -o pipefail
    run_image "$operator_script" "$@" | age --encrypt --recipient "$recipient" >"$encrypted"
  ); then
    rm -f -- "$encrypted"
    die 'Owner grant could not be handed off. Inspect its state before independently approving reissue'
  fi
  grant_binding="$(live_grant_binding)"
  envelope_hash="$(sha256sum -- "$encrypted")"
  envelope_hash="${envelope_hash%% *}"
  if [[ ! "$grant_binding" =~ ^[a-f0-9]{64}$ || ! "$envelope_hash" =~ ^[a-f0-9]{64}$ || ! -s "$encrypted" ]]; then
    rm -f -- "$encrypted"
    die 'Owner grant receipt could not be established. Inspect the grant before independently approving reissue'
  fi
  receipt="$(jq -cn --arg recipient "$recipient" --arg grant "$grant_binding" --arg envelope "$envelope_hash" '{
    format: "codexia-owner-handoff/v1", recipient: $recipient,
    grantBindingSha256: $grant, envelopeSha256: $envelope
  }')"
  mv -fT -- "$encrypted" "$handoff"
  # The pending marker remains until both objects are persisted. An interrupted
  # replacement cannot pair old ciphertext or metadata with a different grant.
  write_marker "$handoff_receipt" "$receipt"
  rm -f -- "$pending_handoff"
  sync -f -- "$state_dir"
}

case "$operation" in
  --initialize)
    [[ ( $# == 2 || ( $# == 5 && "$3" == --resume-bootstrap ) ) ]] && ! present "$promoted" ||
      die 'Owner setup initialization requires an unprepared installation'
    if [[ $# == 5 ]] && present "$marker"; then
      die 'An empty-auth resume cannot reuse a completed owner setup marker'
    fi
    if present "$marker"; then
      assert_installation
    else
      assert_intent
      # Both admitted R4 checkpoints must have reached the same empty schema.
      if [[ $# == 5 ]]; then
        assert_empty_auth_resume "$4" "$5"
      else
        assert_empty_auth_resume "$database" candidate
      fi
      run_image /app/node_modules/@codexia/api/dist/migrate-auth.js --apply
      run_image "$operator_script" --describe >/dev/null
      write_marker "$marker" "${database%%:*}"
    fi
    ;;
  --converge)
    [[ $# == 4 && ( "$3" == NEW_APPROVED || "$3" == OBSERVE_ONLY ) ]] && ! present "$promoted" ||
      die 'Owner setup convergence requires an approved fresh or existing setup installation'
    assert_approved_checkpoint
    assert_setup_unit_or_clean
    if present "$marker"; then
      assert_installation
    else
      assert_intent
    fi
    description="$(run_image "$operator_script" --describe)"
    state="$(jq -er .state <<<"$description")"
    case "$state" in
      BLOCKED)
        [[ "$3" == NEW_APPROVED ]] && ! present "$handoff" && ! present "$handoff_receipt" &&
          jq -e '.grantId == null' <<<"$description" >/dev/null ||
          die 'The current database has no issued setup grant'
        assert_intent
        if ! present "$marker"; then write_marker "$marker" "${database%%:*}"; fi
        encrypt_grant "$4" --issue-new-approved
        ;;
      SETUP_PENDING)
        assert_installation
        grant="$(live_grant_binding)"
        [[ "$grant" =~ ^[a-f0-9]{64}$ ]] ||
          die 'Existing owner grant is expired or unavailable. Inspect before independently approving reissue'
        "$HOME/.local/bin/codexia-preflight-observe" check-owner-handoff 9 "$4" "$grant" ||
          die 'Existing owner grant handoff does not match the grant and reviewed recipient. Inspect before independently approving reissue'
        ;;
      OWNER_ENROLLED) die 'The owner is already enrolled. Run activation preparation' ;;
      *) die 'Owner setup returned an unrecognized state' ;;
    esac
    if ! present "$unit"; then
      staged_unit="$(mktemp "$unit_dir/.codexia-owner-setup.XXXXXX")"
      install -m 0600 "$setup_unit" "$staged_unit"
      mv -fT -- "$staged_unit" "$unit"
    fi
    systemctl --user daemon-reload
    systemctl --user start codexia-api.service
    if ! verify_setup_api; then
      systemctl --user stop codexia-api.service
      die 'The setup-only API did not prove readiness and disabled application routes'
    fi
    systemctl --user start codexia-tunnel.service
    printf '%s\n' 'Setup-only API and Tunnel started. Check the approved browser origin before delivering the encrypted grant.'
    ;;
  --export-handoff)
    [[ $# == 4 && "$3" =~ ^age1[0-9a-z]+$ && "$4" =~ ^[a-f0-9]{64}$ ]] &&
      ! present "$promoted" || die 'The setup handoff requires its reviewed recipient and live grant binding'
    assert_installation
    assert_setup_unit_or_clean
    verify_setup_api --pending || die 'The setup API did not prove readiness and required business-route denial'
    systemctl --user is-active --quiet codexia-tunnel.service &&
      python3 -c '
import http.client
connection = http.client.HTTPConnection("127.0.0.1", 2000, timeout=5)
try:
    connection.request("GET", "/ready")
    raise SystemExit(0 if connection.getresponse().status == 200 else 1)
except OSError:
    raise SystemExit(1)
finally:
    connection.close()
' ||
      die 'The canonical Tunnel has no live Cloudflare connection'
    grant="$(live_grant_binding)"
    [[ "$grant" == "$4" ]] || die 'The outstanding Owner grant no longer matches the reviewed binding'
    "$HOME/.local/bin/codexia-preflight-observe" export-owner-handoff 9 "$3" "$grant" ||
      die 'Existing owner grant handoff does not match the grant and reviewed recipient. Inspect before independently approving reissue'
    ;;
  --inspect)
    [[ $# == 2 ]] && ! present "$promoted" || die 'The setup operation is closed'
    assert_installation
    run_image "$operator_script" --describe
    ;;
  --replace-explicitly-approved)
    [[ $# == 4 && "$3" =~ ^[a-f0-9-]{36}$ ]] && ! present "$promoted" ||
      die 'Explicit replacement requires the previous grant ID'
    assert_installation
    assert_setup_unit_or_clean
    encrypt_grant "$4" --replace-explicitly-approved "$3"
    printf '%s\n' 'The selected grant was replaced. Hand off the newly encrypted grant.'
    ;;
  --prepare-activation)
    [[ $# == 2 ]] || die 'Activation preparation requires the reviewed Full image'
    assert_installation
    assert_approved_checkpoint
    if present "$promoted"; then
      private_file "$promoted" || die 'Owner activation preparation evidence is not a private regular file'
      "$HOME/.local/bin/codexia-require-clean-api-target"
      assert_tunnel_stopped
      run_image /app/node_modules/@codexia/api/dist/verify-auth-clients.js
      exit 0
    fi
    if present "$unit"; then
      assert_setup_unit_or_clean
    else
      # A previous attempt may have removed the unit just before reloading.
      systemctl --user daemon-reload
      "$HOME/.local/bin/codexia-require-clean-api-target"
      assert_tunnel_stopped
    fi
    # An interrupted atomic runtime promotion already has the derived subject.
    # The normal read-only verifier binds it to the enrolled owner and clients.
    if grep -q '^CODEXIA_OAUTH_OWNER_SUBJECT=' "$runtime"; then
      ! present "$unit" || die 'Prepared owner settings coexist with a setup unit'
      run_image /app/node_modules/@codexia/api/dist/verify-auth-clients.js
    else
      owner="$(run_image "$operator_script" --prepare-activation)"
      [[ "$owner" =~ ^[a-f0-9-]{36}$ ]] || die 'Could not verify the enrolled owner and approved OAuth clients'
      if present "$unit"; then
        systemctl --user stop codexia-tunnel.service codexia-api.service
        rm -f -- "$unit"
        systemctl --user daemon-reload
      fi
      "$HOME/.local/bin/codexia-require-clean-api-target"
      assert_tunnel_stopped
      settings="$(mktemp "$config_dir/.runtime.XXXXXX")"
      cat -- "$runtime" >"$settings"
      printf 'CODEXIA_OAUTH_OWNER_SUBJECT=%s\n' "$owner" >>"$settings"
      mv -fT -- "$settings" "$runtime"
      sync -f -- "$config_dir"
    fi
    write_marker "$promoted" 'activation-ready'
    printf '%s\n' 'Owner and OAuth clients verified. Awaiting the separately approved protected first deployment.'
    ;;
  *) die 'Unknown owner setup operation' ;;
esac
