#!/usr/bin/env bash
set -euo pipefail
[[ "${BENCH_HEAD:?}" =~ ^[a-f0-9]{40}$ && "${BENCH_BASE:?}" =~ ^[a-f0-9]{40}$ ]]
[[ "$GITHUB_REPOSITORY" == "yohn-jp/codexia" ]]
out="$RUNNER_TEMP/checkout-candidate"
mkdir -p "$out"
repo="$RUNNER_TEMP/codexia-checkout-trial"
event="$out/event.json"
printf '{"pull_request":{"base":{"sha":"%s"},"head":{"sha":"%s"}}}\n' "$BENCH_BASE" "$BENCH_HEAD" > "$event"
echo '| Checkout | Fetch ms | Checkout ms | Proof ms | Pack bytes before proof | Pack bytes after proof | Worktree files | Worktree bytes |' >> "$GITHUB_STEP_SUMMARY"
echo '|---|---:|---:|---:|---:|---:|---:|---:|' >> "$GITHUB_STEP_SUMMARY"
for mode in full blobless sparse; do
  rm -rf "$repo"; mkdir -p "$repo"
  git -C "$repo" init -q
  git -C "$repo" remote add origin "https://github.com/$GITHUB_REPOSITORY.git"
  args=()
  if [[ "$mode" != full ]]; then
    git -C "$repo" config remote.origin.promisor true
    git -C "$repo" config remote.origin.partialclonefilter blob:none
    args+=(--filter=blob:none)
  fi
  start=$(date +%s%N)
  git -C "$repo" fetch --no-tags "${args[@]}" origin "$BENCH_HEAD:refs/remotes/origin/benchmark-head" "$BENCH_BASE:refs/remotes/origin/benchmark-base"
  fetched=$(date +%s%N)
  if [[ "$mode" == sparse ]]; then
    (
      cd "$repo"
      export EVIDENCE_INPUT_SELECTOR="$GITHUB_WORKSPACE/scripts/ci/impact/evidence-checkout.mjs"
      git ls-tree -r -z --name-only "$BENCH_HEAD" | node --input-type=module -e '
        import {readFileSync} from "node:fs";
        import {pathToFileURL} from "node:url";
        const {evidenceCheckoutInputs}=await import(pathToFileURL(process.env.EVIDENCE_INPUT_SELECTOR));
        const inputs=evidenceCheckoutInputs(readFileSync(0,"utf8").split("\0").filter(Boolean));
        if(!inputs) throw Error("Sparse candidate requires full fallback");
        console.log(inputs.patterns.join("\n"));
      '
    ) > "$out/sparse-patterns.txt"
    git -C "$repo" sparse-checkout set --no-cone --stdin < "$out/sparse-patterns.txt"
  fi
  git -C "$repo" checkout --detach -q "$BENCH_HEAD"
  checked=$(date +%s%N)
  [[ "$(git -C "$repo" rev-parse HEAD)" == "$BENCH_HEAD" ]]
  [[ "$(git -C "$repo" merge-base "$BENCH_BASE" "$BENCH_HEAD")" =~ ^[a-f0-9]{40}$ ]]
  before=$(du -sb "$repo/.git/objects" | cut -f1)
  count=$(git -C "$repo" ls-files -t | awk '$1 != "S" {n++} END {print n+0}')
  bytes=$(du -sb --exclude=.git "$repo" | cut -f1)
  (
    cd "$repo"
    unset GITHUB_OUTPUT GITHUB_STEP_SUMMARY
    export CODEXIA_EXPECTED_SHA="$BENCH_HEAD" GITHUB_EVENT_NAME=pull_request GITHUB_EVENT_PATH="$event"
    export CODEXIA_CI_PLAN_PATH="$out/$mode-plan.json"
    node scripts/ci/impact/plan.mjs > "$out/$mode-plan.log"
    node --input-type=module -e '
      import {writeFileSync} from "node:fs";
      import {coverageRuntime,coverageInvocation,captureCoverageInputClosure} from "./scripts/ci/evidence/coverage-inputs.mjs";
      import {captureTaskInputSource} from "./scripts/ci/evidence/task-inputs.mjs";
      import {VERIFICATION_TASKS} from "./scripts/ci/impact/contract.mjs";
      const runtime=coverageRuntime();
      const coverage=await captureCoverageInputClosure({root:process.cwd(),runtime,invocation:coverageInvocation(runtime.execPath),workflowJob:"types"});
      const taskClosure=captureTaskInputSource({root:process.cwd(),sha:process.env.CODEXIA_EXPECTED_SHA,runtime});
      writeFileSync(process.argv[1],JSON.stringify({coverage,tasks:Object.fromEntries(VERIFICATION_TASKS.map(task=>[task,taskClosure(task)]))},null,2)+"\n");
    ' "$out/$mode-inputs.json"
    test -z "$(git status --porcelain)"
  )
  finished=$(date +%s%N)
  after=$(du -sb "$repo/.git/objects" | cut -f1)
  printf '| %s | %s | %s | %s | %s | %s | %s | %s |\n' "$mode" "$(( (fetched-start)/1000000 ))" "$(( (checked-fetched)/1000000 ))" "$(( (finished-checked)/1000000 ))" "$before" "$after" "$count" "$bytes" | tee -a "$GITHUB_STEP_SUMMARY"
  if [[ "$mode" != full ]]; then
    for kind in plan inputs; do
      diff -u "$out/full-$kind.json" "$out/$mode-$kind.json"
    done
  fi
done
echo 'All three variants: plan, coverage and every task closure identical. Pack bytes are local object storage, not measured network traffic.' | tee -a "$GITHUB_STEP_SUMMARY"
