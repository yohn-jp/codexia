#!/usr/bin/env bash
set -euo pipefail
out="$RUNNER_TEMP/pnpm-filter-candidate"
mkdir -p "$out"
echo '| Install | Install ms | Store bytes | node_modules bytes (root) | Core package build |' >> "$GITHUB_STEP_SUMMARY"
echo '|---|---:|---:|---:|---|' >> "$GITHUB_STEP_SUMMARY"
for mode in full core core-root; do
  dir="$RUNNER_TEMP/pnpm-trial-$mode"
  store="$RUNNER_TEMP/pnpm-store-$mode"
  mkdir -p "$dir" "$store"
  git archive HEAD | tar -x -C "$dir"
  args=()
  if [[ "$mode" != full ]]; then args+=(--filter @codexia/profile-core...); fi
  if [[ "$mode" == core-root ]]; then args+=(--filter codexia); fi
  start=$(date +%s%N)
  result=0
  (cd "$dir"; pnpm "${args[@]}" install --frozen-lockfile --store-dir "$store") > "$out/$mode-install.log" 2>&1 || result=$?
  finish=$(date +%s%N)
  size=$(du -sb "$store" | cut -f1)
  nm=0; if [[ -d "$dir/node_modules" ]]; then nm=$(du -sb "$dir/node_modules" | cut -f1); fi
  if [[ "$result" == 0 ]]; then
    (cd "$dir"; pnpm --recursive --sort --workspace-concurrency=2 --filter @codexia/api... run build) > "$out/$mode-build.log" 2>&1 || result=$?
  fi
  outcome="FAILED($result)"
  if [[ "$result" == 0 ]]; then
    (cd "$dir"; find packages -path '*/dist/*' -type f -print0 | sort -z | xargs -0 -r sha256sum) > "$out/$mode.sha256"
    test -s "$out/$mode.sha256"
    outcome=PASS
    if [[ "$mode" != full ]]; then
      if ! diff -u "$out/full.sha256" "$out/$mode.sha256" > "$out/$mode-diff.log"; then outcome=DIFFERENT; fi
    fi
  fi
  printf '| %s | %s | %s | %s | %s |\n' "$mode" "$(( (finish-start)/1000000 ))" "$size" "$nm" "$outcome" | tee -a "$GITHUB_STEP_SUMMARY"
  if [[ "$mode" == full && "$outcome" != PASS ]]; then cat "$out/$mode-install.log"; cat "$out/$mode-build.log" || true; exit 1; fi
  if [[ "$result" != 0 ]]; then tail -n 20 "$out/$mode-install.log"; tail -n 30 "$out/$mode-build.log" || true; fi
  rm -rf "$dir" "$store"
done
echo 'Filtered installs are candidates only; failure or different outputs preclude admission.' >> "$GITHUB_STEP_SUMMARY"
