#!/usr/bin/env bash
# Invoked by auth-runtime for approved first installation, or explicitly by an operator.
set -Eeuo pipefail
umask 077

die() { printf '%s\n' "$1" >&2; exit 1; }
[[ $# -ge 2 && $# -le 4 ]] || die 'An explicit owner setup operation and reviewed Full image are required'
operation="$1"
image="$2"
[[ "$image" =~ ^ghcr\.io/yohn-jp/codexia-backend@sha256:[a-f0-9]{64}$ ]] || die 'A reviewed immutable Full image is required'
config_dir="$HOME/.config/codexia-auth"
state_dir="$HOME/.local/state/codexia-deploy"
unit_dir="$HOME/.config/containers/systemd"
unit="$unit_dir/codexia-api.container"
setup_unit="$config_dir/owner-setup.container"
handoff="$state_dir/owner-setup.age"
marker="$state_dir/owner-setup.installation"
intent="$state_dir/owner-setup.intent"
pending_handoff="$state_dir/owner-setup.age.pending"
promoted="$state_dir/owner-setup.promoted"
runtime="$config_dir/runtime.env"
setup_env="$config_dir/owner-setup.env"

exec 9>"$state_dir/host.lock"
flock --exclusive --nonblock 9 || die 'Another Codexia operation holds the deployment host lock'
present() { [[ -e "$1" || -L "$1" ]]; }
private_file() { [[ -f "$1" && ! -L "$1" && -O "$1" && "$(stat -c %a -- "$1")" == 600 ]]; }
for journal in {deployed-release,deploy-transaction,cutover-transaction}.json; do
  if present "$state_dir/$journal"; then die 'Owner setup requires a pre-activation deployment'; fi
done
private_file "$runtime" && private_file "$setup_env" && private_file "$setup_unit" ||
  die 'Protected owner setup inputs are missing'
grep -Fxq "Image=$image" "$setup_unit" || die 'The reviewed Full image does not match the staged setup'

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
  local encrypted
  write_marker "$pending_handoff" 'handoff-in-progress'
  encrypted="$(mktemp "$state_dir/.owner-setup.XXXXXX")"
  if ! (
    set -o pipefail
    run_image "$operator_script" "$@" | age --encrypt --recipient "$recipient" >"$encrypted"
  ); then
    rm -f -- "$encrypted"
    die 'Owner grant could not be handed off. Inspect its state before independently approving reissue'
  fi
  mv -fT -- "$encrypted" "$handoff"
  sync -f -- "$state_dir"
  rm -f -- "$pending_handoff"
  sync -f -- "$state_dir"
}

case "$operation" in
  --initialize)
    [[ $# == 2 ]] && ! present "$promoted" ||
      die 'Owner setup initialization requires an unprepared installation'
    if present "$marker"; then
      assert_installation
    else
      assert_intent
      "$HOME/.local/bin/codexia-require-clean-api-target"
      run_image /app/node_modules/@codexia/api/dist/migrate-auth.js --apply
      run_image "$operator_script" --describe >/dev/null
      write_marker "$marker" "${database%%:*}"
    fi
    ;;
  --converge)
    [[ $# == 4 && ( "$3" == NEW_APPROVED || "$3" == OBSERVE_ONLY ) ]] && ! present "$promoted" ||
      die 'Owner setup convergence requires an approved fresh or existing setup installation'
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
        [[ "$3" == NEW_APPROVED ]] && ! present "$handoff" &&
          jq -e '.grantId == null' <<<"$description" >/dev/null ||
          die 'The current database has no issued setup grant'
        assert_intent
        if ! present "$marker"; then write_marker "$marker" "${database%%:*}"; fi
        encrypt_grant "$4" --issue-new-approved
        ;;
      SETUP_PENDING)
        assert_installation
        [[ "$(read_database "SELECT EXISTS (SELECT FROM codexia_auth.owner_setup WHERE id='first-owner' AND expires_at > now() AND consumed_at IS NULL)")" == t ]] ||
          die 'Existing owner grant is expired or unavailable. Inspect before independently approving reissue'
        private_file "$handoff" && [[ -s "$handoff" ]] && ! present "$pending_handoff" ||
          die 'Existing owner grant handoff is incomplete. Verify the grant before independently approving reissue'
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
    systemctl --user start codexia-tunnel.service
    printf '%s\n' 'Setup-only API and Tunnel started. Check the approved browser origin before delivering the encrypted grant.'
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
