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

run_as_codexia() {
  sudo -n -u codexia env -i HOME="$fixture_home" USER=codexia LOGNAME=codexia \
    PATH="$(dirname -- "$(command -v node)"):/usr/bin:/bin" \
    XDG_RUNTIME_DIR="/run/user/$fixture_uid" DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$fixture_uid/bus" \
    /bin/bash -c 'cd -- "$HOME"; exec "$@"' bash "$@"
}

cleanup() {
  local status=$? result
  trap - EXIT
  set +e
  if [[ "$created_user" == true ]]; then
    for result in images.json prior.json candidate.json restored.json assertions.json; do
      if run_as_codexia test -f "$fixture_home/fixture/evidence/$result"; then
        run_as_codexia cat "$fixture_home/fixture/evidence/$result" > "$report_dir/$result" || status=1
      fi
    done
    run_as_codexia systemctl --user stop codexia-api.service codexia-tunnel.service codexia-db.service >/dev/null 2>&1
    run_as_codexia podman system reset --force >/dev/null || status=1
    sudo -n loginctl disable-linger codexia || status=1
    sudo -n loginctl terminate-user codexia >/dev/null 2>&1
    sudo -n userdel --remove codexia >/dev/null || status=1
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
sudo -n loginctl enable-linger codexia
sudo -n systemctl start "user@$fixture_uid.service"
run_as_codexia systemctl --user show --property=Version >/dev/null
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
