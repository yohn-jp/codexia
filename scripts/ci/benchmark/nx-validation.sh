#!/usr/bin/env bash
set -euo pipefail
export NX_DAEMON=false NX_NO_CLOUD=true NX_TASKS_RUNNER_DYNAMIC_OUTPUT=false
export NX_CACHE_DIRECTORY="$RUNNER_TEMP/codexia-nx-cache"
out="$RUNNER_TEMP/nx-candidate"
# Only these two foundation projects receive experimental test cache config.
# This is not authorization to reuse any canonical unit or integration proof.
node --input-type=module -e '
import {readFileSync,writeFileSync} from "node:fs";
for (const root of ["packages/contracts","packages/persistence-contracts"]) {
  const file=root+"/package.json"; const p=JSON.parse(readFileSync(file,"utf8"));
  p.nx={...p.nx,targets:{...p.nx?.targets,test:{cache:true,dependsOn:["^build"],inputs:["default","^default"],outputs:[]}}};
  writeFileSync(file,JSON.stringify(p,null,2)+"\n");
}'
projects="@codexia/contracts,@codexia/persistence-contracts"
measure() {
  local label="$1"; shift
  local start end
  start=$(date +%s%N)
  "$@" > "$out/$label.log" 2>&1 || { cat "$out/$label.log"; return 1; }
  end=$(date +%s%N)
  printf '| %s | %s ms |\n' "$label" "$(( (end-start)/1000000 ))" | tee -a "$GITHUB_STEP_SUMMARY"
  grep -E 'Cache:|cache instead|cached|Critical path:' "$out/$label.log" || true
}
printf '\n### Static validation local-cache benchmark\n| Run | Elapsed |\n|---|---:|\n' >> "$GITHUB_STEP_SUMMARY"
for target in typecheck test; do
  measure "pnpm-$target" pnpm --recursive --sort --workspace-concurrency=2 --filter @codexia/contracts --filter @codexia/persistence-contracts run "$target"
  measure "nx-$target-cold" pnpm exec nx run-many -t "$target" --projects="$projects" --parallel=2 --skipRemoteCache
  measure "nx-$target-warm" pnpm exec nx run-many -t "$target" --projects="$projects" --parallel=2 --skipRemoteCache
done
source_file=packages/contracts/src/index.ts
test_file=$(find packages/contracts/src -maxdepth 1 -name '*.test.ts' -type f | sort | head -n 1)
test -f "$source_file"; test -f "$test_file"
cp "$source_file" "$out/source-original"
cp "$test_file" "$out/test-original"
trap 'cp "$out/source-original" "$source_file"; cp "$out/test-original" "$test_file"' EXIT
printf '\nexport const nxBenchmarkInvalidType: never = 1;\n' >> "$source_file"
if pnpm exec nx run @codexia/contracts:typecheck --skipRemoteCache > "$out/typecheck-negative.log" 2>&1; then
  echo 'FAIL: mutated source incorrectly accepted'; exit 1
fi
grep -E 'TS2322|not assignable to type.*never' "$out/typecheck-negative.log"
cp "$out/source-original" "$source_file"
printf '\nimport { test as nxBenchmarkTest } from "node:test"; nxBenchmarkTest("NX_BENCH_SENTINEL", () => { throw new Error("NX_BENCH_SENTINEL"); });\n' >> "$test_file"
if pnpm exec nx run @codexia/contracts:test --skipRemoteCache > "$out/test-negative.log" 2>&1; then
  echo 'FAIL: mutated test incorrectly accepted'; exit 1
fi
grep 'NX_BENCH_SENTINEL' "$out/test-negative.log"
cp "$out/test-original" "$test_file"
measure nx-typecheck-restored pnpm exec nx run-many -t typecheck --projects="$projects" --parallel=2 --skipRemoteCache
measure nx-test-restored pnpm exec nx run-many -t test --projects="$projects" --parallel=2 --skipRemoteCache
echo 'Both negative mutations rejected; restored inputs pass.' >> "$GITHUB_STEP_SUMMARY"
rm "$out/source-original" "$out/test-original"
trap - EXIT
