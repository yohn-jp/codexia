#!/usr/bin/env bash
set -euo pipefail
# This is an isolated, read-only benchmark checkout. Its dependency resolution
# is not a certified product input; the candidate lock is retained for review.
export NX_DAEMON=false NX_NO_CLOUD=true NX_TASKS_RUNNER_DYNAMIC_OUTPUT=false
export NX_CACHE_DIRECTORY="$RUNNER_TEMP/codexia-nx-cache"
cp scripts/ci/benchmark/nx.json nx.json
pnpm add --workspace-root --save-dev --save-exact --ignore-scripts nx@24.0.6
mkdir -p "$RUNNER_TEMP/nx-candidate"
cp package.json pnpm-lock.yaml nx.json "$RUNNER_TEMP/nx-candidate/"
mapfile -t projects < <(node --input-type=module -e '
  import {readFileSync} from "node:fs";
  const profile = JSON.parse(readFileSync("profiles/full.json", "utf8"));
  console.log(["@codexia/api", ...profile.modules.map(id => "@codexia/module-" + id)].join("\n"));
')
filters=()
for project in "${projects[@]}"; do filters+=(--filter "$project..."); done
project_csv="$(IFS=,; echo "${projects[*]}")"
clear_outputs() {
  find packages modules -mindepth 2 -maxdepth 2 -type d -name dist -exec rm -rf -- {} +
  # tsc -b may otherwise treat deleted dist outputs as current.
  find packages modules -mindepth 2 -maxdepth 2 -type f -name '*.tsbuildinfo' -delete
}
snapshot() {
  find packages modules -path '*/dist/*' -type f -print0 | sort -z | xargs -0 -r sha256sum > "$RUNNER_TEMP/$1.sha256"
  test -s "$RUNNER_TEMP/$1.sha256"
}
measure() {
  local name="$1"; shift
  local start end
  start=$(date +%s%N)
  "$@"
  end=$(date +%s%N)
  printf '| %s | %s ms |\n' "$name" "$(( (end-start)/1000000 ))" | tee -a "$GITHUB_STEP_SUMMARY"
}
printf '| Build engine | Wall time |\n|---|---:|\n' >> "$GITHUB_STEP_SUMMARY"
clear_outputs
measure pnpm-cold pnpm --recursive --sort --workspace-concurrency=2 --fail-if-no-match "${filters[@]}" run build
snapshot pnpm
clear_outputs
measure nx-cold pnpm exec nx run-many -t build --projects="$project_csv" --parallel=2 --skipRemoteCache
snapshot nx-cold
diff -u "$RUNNER_TEMP/pnpm.sha256" "$RUNNER_TEMP/nx-cold.sha256"
for trial in 1 2 3; do
  clear_outputs
  measure "nx-warm-$trial" pnpm exec nx run-many -t build --projects="$project_csv" --parallel=2 --skipRemoteCache
  snapshot "nx-warm-$trial"
  diff -u "$RUNNER_TEMP/pnpm.sha256" "$RUNNER_TEMP/nx-warm-$trial.sha256"
done
cp "$RUNNER_TEMP/"*.sha256 "$RUNNER_TEMP/nx-candidate/"
