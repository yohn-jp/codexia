#!/usr/bin/env bash
# The GitHub-hosted runner is disposable. No production runner or service account is reused.
set -Eeuo pipefail
umask 077
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.."

readonly prior_source=c9d0b5f82576f78491c4f98c62309b3835de7562
readonly candidate_source=${EPOCH_FIXTURE_SOURCE_SHA:?Exact operation source is required}
readonly fixture_home=/home/codexia
readonly report_dir=${RUNNER_TEMP:?}/codexia-epoch-cutover-evidence
readonly fixture_tag="localhost/codexia-epoch-cutover-${GITHUB_RUN_ID:?}-${GITHUB_RUN_ATTEMPT:?}"

[[ "${GITHUB_ACTIONS:-}" == true && "${RUNNER_ENVIRONMENT:-}" == github-hosted ]]
[[ "$candidate_source" =~ ^[0-9a-f]{40}$ && "$(git rev-parse HEAD)" == "$candidate_source" ]]
if getent passwd codexia >/dev/null || getent group codexia >/dev/null || [[ -e "$fixture_home" || -L "$fixture_home" ]]; then
  echo 'The fixture requires a fresh codexia service account.' >&2
  exit 1
fi

mkdir -p "$report_dir"
work=$(mktemp -d "${RUNNER_TEMP}/codexia-epoch-cutover.XXXXXXXX")
created_user=false
fixture_uid=
manager_dropin=
environment_generator=

run_as_codexia() {
  sudo -n -u codexia env -i HOME="$fixture_home" USER=codexia LOGNAME=codexia \
    PATH="$(dirname -- "$(command -v node)"):/usr/bin:/bin" \
    XDG_CONFIG_HOME="$fixture_home/.config" \
    XDG_RUNTIME_DIR="/run/user/$fixture_uid" DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$fixture_uid/bus" \
    /bin/bash -c 'cd -- "$HOME"; exec "$@"' bash "$@"
}

cleanup() {
  local status=$? result remaining_containers attempt
  trap - EXIT
  set +e
  if [[ "$created_user" == true ]]; then
    for result in images.json prior.json candidate.json restored.json assertions.json; do
      if run_as_codexia test -f "$fixture_home/fixture/evidence/$result"; then
        run_as_codexia cat "$fixture_home/fixture/evidence/$result" > "$report_dir/$result" || status=1
      fi
    done
    run_as_codexia systemctl --user stop codexia-api.service codexia-tunnel.service codexia-db.service >/dev/null 2>&1
    # Remove fixture containers in the rootless session before resetting its
    # storage. A network-endpoint teardown error never certifies a remaining container.
    run_as_codexia podman rm --force --ignore codexia-api codexia-tunnel codexia-db \
      codexia-cutover-maintenance codexia-auth-registration fixture-oidc fixture-registry >/dev/null
    if ! remaining_containers=$(run_as_codexia podman ps --all --quiet) || [[ -n "$remaining_containers" ]]; then
      echo 'Disposable container cleanup did not verify an empty rootless inventory.' >&2
      status=1
    fi
    run_as_codexia podman system reset --force >/dev/null || status=1
    sudo -n loginctl disable-linger codexia || status=1
    sudo -n systemctl stop "user@$fixture_uid.service" || status=1
    sudo -n loginctl terminate-user codexia >/dev/null 2>&1
    # Netavark's final rootless helper can survive outside the user-manager
    # scope. The fixture account was created for this run and owns no other work.
    if [[ "$fixture_uid" =~ ^[1-9][0-9]*$ && "$(id -u codexia)" == "$fixture_uid" ]]; then
      if pgrep -U "$fixture_uid" >/dev/null; then
        sudo -n pkill --signal KILL -U "$fixture_uid" >/dev/null 2>&1
        for ((attempt=0; attempt<20; attempt++)); do
          if ! pgrep -U "$fixture_uid" >/dev/null; then break; fi
          sleep 0.25
        done
      fi
      if pgrep -U "$fixture_uid" >/dev/null; then
        echo 'Disposable user cleanup still has running processes.' >&2
        ps -U "$fixture_uid" -o state=,comm= >&2
        status=1
      fi
    else
      echo 'Could not verify the disposable account UID before process cleanup.' >&2
      status=1
    fi
    sudo -n userdel --remove codexia >/dev/null || status=1
    if getent passwd codexia >/dev/null || [[ -e "$fixture_home" ]]; then
      echo 'Disposable account or home remains after cleanup.' >&2
      status=1
    fi
  fi
  if [[ -n "$environment_generator" ]]; then sudo -n rm -f -- "$environment_generator" || status=1; fi
  if [[ -n "$manager_dropin" ]]; then
    sudo -n rm -f -- "$manager_dropin" || status=1
    sudo -n rmdir -- "$(dirname -- "$manager_dropin")" || status=1
    sudo -n systemctl daemon-reload || status=1
  fi
  rm -rf -- "$work" || status=1
  docker image rm "$fixture_tag:prior" "$fixture_tag:candidate" >/dev/null 2>&1
  jq -n --arg sourceSha "$candidate_source" --arg runId "$GITHUB_RUN_ID" --arg runAttempt "$GITHUB_RUN_ATTEMPT" \
    --argjson exitCode "$status" '{sourceSha:$sourceSha,runId:$runId,runAttempt:$runAttempt,exitCode:$exitCode,status:(if $exitCode == 0 then "PASS" else "FAIL" end)}' \
    > "$report_dir/outcome.json" || status=1
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

build_full() {
  local source=$1 role=$2 version=$3 context="$work/$2"
  mkdir "$context"
  git archive "$source" | tar -xf - -C "$context"
  docker build --platform linux/amd64 -f "$context/Dockerfile.backend" \
    --build-arg PROFILE=full --build-arg "CODEXIA_PRODUCER_REVISION=$source" \
    --build-arg "CODEXIA_RELEASE_VERSION=$version" --tag "$fixture_tag:$role" "$context"
}

# This reviewed historical checkout is the direct parent of the epoch 2 declaration.
# It preserves the same Better Auth schema as the current packaged backend.
build_full "$prior_source" prior 1.0.0
build_full "$candidate_source" candidate 2.0.0

sudo -n useradd --create-home --user-group --home-dir "$fixture_home" --shell /bin/bash codexia
created_user=true
fixture_uid=$(id -u codexia)
grep -q '^codexia:' /etc/subuid
grep -q '^codexia:' /etc/subgid

# Configure the user manager before loginctl starts it. Quadlet reads the
# user manager's generated environment, independently of sudo's shell env.
dropin_directory="/etc/systemd/system/user@$fixture_uid.service.d"
generator_path=/etc/systemd/user-environment-generators/98-codexia-epoch-fixture
[[ ! -e "$dropin_directory" && ! -L "$dropin_directory" && ! -e "$generator_path" && ! -L "$generator_path" ]]
sudo -n install -d -m 0755 "$dropin_directory" "$(dirname -- "$generator_path")"
manager_dropin="$dropin_directory/95-codexia-epoch-fixture.conf"
cat <<SYSTEMD | sudo -n tee "$manager_dropin" >/dev/null
[Service]
Environment=HOME=$fixture_home
Environment=XDG_CONFIG_HOME=$fixture_home/.config
Environment=XDG_RUNTIME_DIR=/run/user/$fixture_uid
SYSTEMD
sudo -n install -m 0755 /dev/null "$generator_path"
environment_generator=$generator_path
cat <<GENERATOR | sudo -n tee "$environment_generator" >/dev/null
#!/bin/sh
if [ "\$(id -u)" = "$fixture_uid" ]; then
  printf '%s\\n' 'XDG_CONFIG_HOME=$fixture_home/.config' 'XDG_RUNTIME_DIR=/run/user/$fixture_uid'
fi
GENERATOR
sudo -n systemctl daemon-reload
sudo -n loginctl enable-linger codexia
sudo -n systemctl start "user@$fixture_uid.service"
run_as_codexia systemctl --user import-environment HOME XDG_CONFIG_HOME XDG_RUNTIME_DIR
run_as_codexia systemctl --user daemon-reload
manager_environment=$(run_as_codexia systemctl --user show-environment)
grep -Fxq "XDG_CONFIG_HOME=$fixture_home/.config" <<< "$manager_environment"
grep -Fxq "XDG_RUNTIME_DIR=/run/user/$fixture_uid" <<< "$manager_environment"
[[ "$(run_as_codexia podman info --format '{{.Host.Security.Rootless}}')" == true ]]

run_as_codexia mkdir -m 0700 "$fixture_home/fixture"
git archive "$candidate_source" deploy/ansible deploy/backup deploy/postgres deploy/quadlet \
  scripts/verification/runtime/better-auth-fixture.sh scripts/deployment/lifecycle/auth-oidc.mjs \
  scripts/release/backend/image-inspection.mjs scripts/release/backend/update-identity.mjs \
  scripts/release/components/version.mjs |
  run_as_codexia tar -xf - -C "$fixture_home/fixture"
docker save "$fixture_tag:prior" "$fixture_tag:candidate" | run_as_codexia podman load >/dev/null
run_as_codexia bash "$fixture_home/fixture/deploy/ansible/epoch-cutover-rootless-fixture.sh" \
  "$fixture_tag" "$prior_source" "$candidate_source"
