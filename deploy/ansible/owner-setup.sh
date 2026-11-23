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
promoted="$state_dir/owner-setup.promoted"
runtime="$config_dir/runtime.env"
setup_env="$config_dir/owner-setup.env"

exec 9>"$state_dir/host.lock"
flock --exclusive --nonblock 9 || die 'Another Codexia operation holds the deployment host lock'
[[ ! -e "$state_dir/deployed-release.json" && ! -e "$state_dir/deploy-transaction.json" ]] ||
  die 'Owner setup requires a pre-activation deployment'
[[ -f "$runtime" && ! -L "$runtime" && -f "$setup_env" && ! -L "$setup_env" ]] ||
  die 'Protected owner setup inputs are missing'

run_image() {
  podman run --rm --pull=missing --read-only --network codexia-data     --secret=codexia-auth-database-url,type=env,target=CODEXIA_AUTH_DATABASE_URL     --secret=codexia-auth-secret,type=env,target=CODEXIA_AUTH_SECRET     --secret=codexia-oauth-introspection-client-secret,type=env,target=CODEXIA_OAUTH_INTROSPECTION_CLIENT_SECRET     --env-file "$runtime" --env-file "$setup_env" --env CODEXIA_AUTH_MODE=setup-only     --entrypoint=node "$image" "$@"
}

operator_script=/app/node_modules/@codexia/api/dist/owner-setup-operator.js

cluster_identity() {
  podman exec -i codexia-db sh -ec '
    export PGPASSWORD="$(cat /run/secrets/admin-password)"
    exec psql -X -qAt -v ON_ERROR_STOP=1 -U codexia_admin -d codexia -c "SELECT system_identifier FROM pg_control_system()"
  '
}

assert_installation() {
  [[ -f "$marker" && ! -L "$marker" ]] || die 'This VM has no approved initial setup record'
  [[ "$(cat "$marker")" == "$(cluster_identity)" ]] || die 'Owner setup cannot be adopted on a replacement PostgreSQL cluster'
}

assert_setup_unit_or_clean() {
  if [[ -f "$unit" && ! -L "$unit" ]]; then
    cmp -s "$setup_unit" "$unit" || die 'The active API unit differs from the approved setup unit'
  else
    "$HOME/.local/bin/codexia-require-clean-api-target"
  fi
}

encrypt_grant() {
  local recipient="$1"
  shift
  [[ "$recipient" =~ ^age1[0-9a-z]+$ ]] || die 'Owner setup requires a reviewed age recipient'
  local encrypted
  encrypted="$(mktemp "$state_dir/.owner-setup.XXXXXX")"
  if ! (
    set -o pipefail
    run_image "$operator_script" "$@" | age --encrypt --recipient "$recipient" >"$encrypted"
  ); then
    rm -f -- "$encrypted"
    die 'Owner grant could not be handed off. Inspect its state before independently approving reissue'
  fi
  mv -f -- "$encrypted" "$handoff"
}

case "$operation" in
  --converge)
    [[ $# == 4 && ( "$3" == NEW_APPROVED || "$3" == OBSERVE_ONLY ) && ! -e "$promoted" ]] ||
      die 'Owner setup convergence requires an approved fresh or existing setup installation'
    assert_setup_unit_or_clean
    if [[ "$3" == NEW_APPROVED ]]; then
      [[ ! -e "$marker" && ! -e "$handoff" ]] || die 'An installation record already exists'
      cluster="$(cluster_identity)"
      [[ "$cluster" =~ ^[0-9]+$ ]] || die 'Could not verify the PostgreSQL cluster identity'
      run_image /app/node_modules/@codexia/api/dist/migrate-auth.js --apply
      printf '%s\n' "$cluster" >"$marker"
      encrypt_grant "$4" --issue-new-approved
    else
      assert_installation
      state="$(run_image "$operator_script" --describe | jq -er .state)"
      [[ "$state" == SETUP_PENDING || "$state" == OWNER_ENROLLED ]] ||
        die 'The current database has no issued setup grant'
    fi
    if [[ ! -e "$unit" ]]; then
      install -m 0600 "$setup_unit" "$unit"
      systemctl --user daemon-reload
    fi
    systemctl --user start codexia-api.service
    systemctl --user start codexia-tunnel.service
    printf '%s\n' 'Setup-only API and Tunnel started. Check the approved browser origin before delivering the encrypted grant.'
    ;;
  --inspect)
    [[ $# == 2 && ! -e "$promoted" ]] || die 'The setup operation is closed'
    assert_installation
    run_image "$operator_script" --describe
    ;;
  --replace-explicitly-approved)
    [[ $# == 4 && ! -e "$promoted" && "$3" =~ ^[a-f0-9-]{36}$ ]] || die 'Explicit replacement requires the previous grant ID'
    assert_installation
    assert_setup_unit_or_clean
    encrypt_grant "$4" --replace-explicitly-approved "$3"
    printf '%s\n' 'The selected grant was replaced. Hand off the newly encrypted grant.'
    ;;
  --prepare-activation)
    [[ $# == 2 && ! -e "$promoted" ]] || die 'Activation has already been prepared'
    assert_installation
    assert_setup_unit_or_clean
    owner="$(run_image "$operator_script" --prepare-activation)"
    [[ "$owner" =~ ^[a-f0-9-]{36}$ ]] || die 'Could not verify the enrolled owner and approved OAuth clients'
    if [[ -e "$unit" ]]; then
      systemctl --user stop codexia-tunnel.service codexia-api.service
      rm -f -- "$unit"
      systemctl --user daemon-reload
    fi
    "$HOME/.local/bin/codexia-require-clean-api-target"
    settings="$(mktemp "$config_dir/.runtime.XXXXXX")"
    awk '!/^CODEXIA_OAUTH_OWNER_SUBJECT=/' "$runtime" >"$settings"
    printf 'CODEXIA_OAUTH_OWNER_SUBJECT=%s\n' "$owner" >>"$settings"
    mv -f -- "$settings" "$runtime"
    touch "$promoted"
    printf '%s\n' 'Owner and OAuth clients verified. Awaiting the separately approved protected first deployment.'
    ;;
  *) die 'Unknown owner setup operation' ;;
esac
