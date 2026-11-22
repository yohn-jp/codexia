#!/usr/bin/env bash
# Experimental, non-certifying comparison of identical real browser shards.
set -euo pipefail
engine="${1:?expected docker, podman, or native}"
variant="${2:?expected image variant}"
mode="${3:-acceptance}"

official='mcr.microsoft.com/playwright@sha256:1507cbfc550a63a6b7396791ca4f00df17beb56342d2447b3f106c306f525579'
case "$variant" in
  official) image="$official" ;;
  mirror) image='ghcr.io/yohn-jp/codexia/playwright-mirror-all@sha256:09bbfa8d79c3db51a51c8d77f4e7dd725068d60f2b2aa2a47a300e24a2f850d5' ;;
  ubuntu-webkit) image='ghcr.io/yohn-jp/codexia/playwright-ubuntu-webkit@sha256:bc6fd8952f5b82671a46a0f2dc02c70820edc83b7eb74e2f81a99863e59b97b4' ;;
  minimal-webkit) image='ghcr.io/yohn-jp/codexia/playwright-webkit@sha256:4e8ffa23fb1636bf3d98a2b84216e0b768ae55634d95a8b369696f697b60f15b' ;;
  dual-local) image='localhost/codexia-playwright-dual-benchmark:pw-1.65.1' ;;
  *) echo "Unknown variant: $variant" >&2; exit 2 ;;
esac
if [[ "$mode" != probe && "$mode" != acceptance ]]; then echo "Unsupported mode: $mode" >&2; exit 2; fi

if [[ "$engine" == native ]]; then
  [[ "$mode" == acceptance ]] || exit 2
  : "${CODEXIA_PROFILE:?required profile}"
  : "${CODEXIA_E2E_DATABASE_URL:?required disposable postgres URL}"
  if [[ "${CODEXIA_BENCH_NODE_MOUNT:-}" == 1 ]]; then
    # The Actions Node 24 toolcache is mounted read-only into host-launched images.
    # Provide a writable pnpm shim without modifying that toolcache.
    mkdir -p /tmp/codexia-bench-bin
    cat > /tmp/codexia-bench-bin/pnpm <<'PNSH'
#!/bin/sh
exec corepack pnpm "$@"
PNSH
    chmod +x /tmp/codexia-bench-bin/pnpm
    export PATH="/tmp/codexia-bench-bin:$PATH"
  else
    corepack enable
  fi
  corepack pnpm@12.21.0 --version
  git --version
  test "$(node --version)" = 'v24.22.3'
  test "$(node -p 'require("./node_modules/@playwright/test/package.json").version')" = '1.65.1'
  service_url="$CODEXIA_E2E_DATABASE_URL"
  test "${service_url%/codexia_test}" != "$service_url"
  start=$(date +%s%N)
  for suite in auth-recovery oauth-web ui-v1 webkit; do
    export CODEXIA_E2E_DATABASE_URL="$service_url"
    db_name=$(node scripts/ci-playwright-benchmark-db.mjs)
    export CODEXIA_E2E_DATABASE_URL="${service_url%/codexia_test}/$db_name"
    echo "::group::REAL_BROWSER_SUITE profile=$CODEXIA_PROFILE suite=$suite"
    suite_start=$(date +%s%N)
    export CODEXIA_CI_REPORT_DIR="$PWD/tests/e2e/test-results/benchmark-$suite"
    node scripts/run-browser-shard.mjs --profile "$CODEXIA_PROFILE" --suite "$suite" --prebuilt
    suite_ms=$(( ($(date +%s%N)-suite_start)/1000000 ))
    printf 'BENCHMARK_SUITE profile=%s suite=%s ms=%s\n' "$CODEXIA_PROFILE" "$suite" "$suite_ms"
    echo '::endgroup::'
  done
  printf 'BENCHMARK_ACCEPTANCE profile=%s total_ms=%s\n' "$CODEXIA_PROFILE" "$(( ($(date +%s%N)-start)/1000000 ))"
  exit 0
fi

if [[ "$engine" != docker && "$engine" != podman ]]; then echo "Unknown engine: $engine" >&2; exit 2; fi
if [[ "$variant" != official && "$variant" != dual-local ]]; then
  : "${GHCR_TOKEN:?required GHCR read token}"
  printf '%s' "$GHCR_TOKEN" | "$engine" login ghcr.io --username "$GITHUB_ACTOR" --password-stdin >/dev/null
fi
if [[ "$variant" != dual-local ]]; then
  "$engine" image rm "$image" >/dev/null 2>&1 || true
  pull_start=$(date +%s%N)
  "$engine" pull "$image"
  pull_ms=$(( ($(date +%s%N)-pull_start)/1000000 ))
else
  pull_ms=0
fi
image_bytes=$("$engine" image inspect "$image" --format '{{.Size}}')
probe_start=$(date +%s%N)
capabilities=$("$engine" run --rm --pull=never --entrypoint /bin/sh "$image" -ec '
  has_chromium=false; has_webkit=false; has_git=false
  if find /ms-playwright -maxdepth 1 -type d -name "chromium_headless_shell-*" | grep -q .; then has_chromium=true; fi
  if find /ms-playwright -maxdepth 1 -type d -name "webkit-*" | grep -q .; then has_webkit=true; fi
  if command -v git >/dev/null 2>&1; then has_git=true; fi
  printf "CAPABILITY chromium=%s webkit=%s git=%s node=%s\n" "$has_chromium" "$has_webkit" "$has_git" "$(node --version)"
')
probe_ms=$(( ($(date +%s%N)-probe_start)/1000000 ))
echo "$capabilities"
eligible=false
if [[ "$capabilities" == *'chromium=true webkit=true git=true'* ]]; then eligible=true; fi
printf 'BENCHMARK_IMAGE engine=%s variant=%s runner=%s pull_ms=%s probe_ms=%s uncompressed_bytes=%s full_webkit_eligible=%s\n' "$engine" "$variant" "${ImageVersion:-unknown}" "$pull_ms" "$probe_ms" "$image_bytes" "$eligible"
{
  echo "### $engine / $variant / ${CODEXIA_PROFILE:-probe}"
  echo "- Runner: ${ImageVersion:-unknown}"
  echo "- Pull: $pull_ms ms, probe: $probe_ms ms, uncompressed: $image_bytes bytes"
  echo "- Complete WebKit lane capable: $eligible"
} >> "${GITHUB_STEP_SUMMARY:-/dev/null}"

if [[ "$mode" == probe ]]; then exit 0; fi
if [[ "$eligible" != true ]]; then echo "Incompatible: full WebKit group also requires Chromium and Git" >&2; exit 1; fi
: "${GITHUB_WORKSPACE:?required checkout}"
: "${CODEXIA_E2E_DATABASE_URL:?required postgres URL}"
test "${CI:-}" = true
host_node=$(readlink -f "$(command -v node)")
host_node_prefix="${host_node%/bin/node}"
test -x "$host_node_prefix/bin/node"
test "$("$host_node_prefix/bin/node" --version)" = 'v24.22.3'
runtime_start=$(date +%s%N)
"$engine" run --rm --pull=never --init --ipc=host --network host --add-host postgres:127.0.0.1 \
  --volume "$GITHUB_WORKSPACE:/work" --volume "$host_node_prefix:/opt/codexia-node:ro" --workdir /work \
  --env PATH="/opt/codexia-node/bin:/usr/local/bin:/usr/bin:/bin" \
  --env CODEXIA_BENCH_NODE_MOUNT=1 \
  --env CI --env CODEXIA_PROFILE --env CODEXIA_E2E_DATABASE_URL \
  --entrypoint /bin/bash "$image" \
  /work/scripts/ci-playwright-engine-benchmark.sh native "$variant" acceptance
runtime_ms=$(( ($(date +%s%N)-runtime_start)/1000000 ))
printf 'BENCHMARK_REAL engine=%s variant=%s profile=%s runner=%s pull_ms=%s runtime_ms=%s total_ms=%s\n' \
  "$engine" "$variant" "$CODEXIA_PROFILE" "${ImageVersion:-unknown}" "$pull_ms" "$runtime_ms" "$((pull_ms+probe_ms+runtime_ms))"
echo "- Four real shards: $runtime_ms ms (pull + probe + shards: $((pull_ms+probe_ms+runtime_ms)) ms)" >> "$GITHUB_STEP_SUMMARY"
