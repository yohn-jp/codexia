#!/usr/bin/env bash
set -euo pipefail
image="${1:?immutable StrictDoc runtime required}"
[[ "$image" =~ ^ghcr\.io/yohn-jp/codexia/strictdoc-ci@sha256:[a-f0-9]{64}$ ]]
# Keep all exact-source and evidence paths identical inside the container.
# Forward only the identity and output variables used by the verifier.
docker run --rm --init --ipc=host --user "$(id -u):$(id -g)" \
  --volume "$GITHUB_WORKSPACE:$GITHUB_WORKSPACE" \
  --volume "$RUNNER_TEMP:$RUNNER_TEMP" \
  --workdir "$GITHUB_WORKSPACE" \
  --env HOME=/tmp --env STRICTDOC_BIN=/opt/strictdoc/bin/strictdoc \
  --env PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
  --env CI=true --env ImageOS=ubuntu24 --env "ImageVersion=${image##*@}" \
  --env GITHUB_ACTIONS --env GITHUB_SERVER_URL --env GITHUB_REPOSITORY \
  --env GITHUB_RUN_ID --env GITHUB_RUN_ATTEMPT --env GITHUB_JOB \
  --env GITHUB_SHA --env GITHUB_WORKFLOW_REF --env GITHUB_WORKFLOW_SHA \
  --env GITHUB_STEP_SUMMARY --env GITHUB_WORKSPACE \
  --env RUNNER_OS --env RUNNER_ARCH --env RUNNER_TEMP \
  --env CODEXIA_CI_REPORT_DIR --env CODEXIA_CI_PLAN_PATH \
  "$image" sh -ec '
    test "$(id -u)" -ne 0
    test "$(node --version)" = v24.22.3
    python3 -c "import sys; assert sys.version_info[:2] == (3, 12)"
    cmp scripts/strictdoc/requirements.lock.txt /tmp/strictdoc-requirements.lock.txt
    test "$(/opt/strictdoc/bin/strictdoc --version)" = 0.32.1
    git --version
    exec node scripts/ci/execution/group.mjs types-trace
  '
