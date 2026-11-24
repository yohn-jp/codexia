#!/usr/bin/env bash
set -euo pipefail

: "${EXPECTED_SHA:?}" "${LANE:?}" "${MODE:?}" "${RUNNER_TEMP:?}"
test "$(git rev-parse HEAD)" = "$EXPECTED_SHA"
test "$(uname -m)" = arm64
root="$(git rev-parse --show-toplevel)"
out="$RUNNER_TEMP/ios-ci-benchmark"
derived="$RUNNER_TEMP/ios-ci-benchmark-derived"
packages="$RUNNER_TEMP/ios-ci-benchmark-packages"
cas="$RUNNER_TEMP/ios-ci-benchmark-cas"
mkdir -p "$out"
export BENCH_OUT="$out" BENCH_CAS="$cas"
start="$(date +%s)"
xcodebuild -version | tee "$out/xcode.txt"
grep -E '^Xcode 27\.' "$out/xcode.txt"
xcrun --sdk iphonesimulator --show-sdk-version | tee "$out/sdk.txt"
grep -E '^27(\.|$)' "$out/sdk.txt"
swift --version > "$out/swift.txt"
xcrun simctl list devices available -j > "$out/devices.json"
# Match the certified workflow's device selection; keep runtime/name for comparison.
device="$(python3 - "$out/devices.json" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))["devices"]
print(next(x["udid"] for runtime, group in d.items() if ".iOS-27-" in runtime for x in group if x["name"].startswith("iPhone")))
PY
)"
export BENCH_DEVICE="$device"
snapshot() {
  { date -u; sysctl hw.ncpu hw.memsize; vm_stat; df -k "$RUNNER_TEMP"; } > "$out/$1-system.txt"
}
phase() {
  local name="$1" begin rc=0
  shift
  begin="$(date +%s)"
  /usr/bin/time -l "$@" 2>&1 | tee "$out/$name.log" || rc=$?
  printf '%s\n' "$(( $(date +%s) - begin ))" > "$out/$name.seconds"
  return "$rc"
}
case "$LANE" in
  editor) cd "$root/ios/CodexiaEditor"; scheme=(-scheme CodexiaEditor) ;;
  app) cd "$root"; scheme=(-project ios/CodexiaApp/CodexiaApp.xcodeproj -scheme CodexiaAppUI) ;;
  *) exit 2 ;;
esac
args=("${scheme[@]}" -derivedDataPath "$derived" -onlyUsePackageVersionsFromResolvedFile -parallel-testing-enabled NO -showBuildTimingSummary)
case "$MODE" in
  baseline)
    args+=(-destination "platform=iOS Simulator,id=$device")
    ;;
  serial-generic)
    args+=(-destination 'generic/platform=iOS Simulator' ARCHS=arm64)
    ;;
  serial-no-index)
    args+=(-destination 'generic/platform=iOS Simulator' ARCHS=arm64 COMPILER_INDEX_STORE_ENABLE=NO)
    ;;
  warm-control|warm-cas)
    args+=(-destination 'generic/platform=iOS Simulator' ARCHS=arm64 COMPILER_INDEX_STORE_ENABLE=NO
      -clonedSourcePackagesDirPath "$packages")
    if [[ "$MODE" == warm-cas ]]; then
      args+=(COMPILATION_CACHE_ENABLE_CACHING=YES COMPILATION_CACHE_ENABLE_DIAGNOSTIC_REMARKS=YES "COMPILATION_CACHE_CAS_PATH=$cas")
    else
      args+=(COMPILATION_CACHE_ENABLE_CACHING=NO)
    fi
    ;;
  *) exit 2 ;;
esac
snapshot before
if [[ "$MODE" == baseline ]]; then
  phase boot xcrun simctl bootstatus "$device" -b &
  boot_pid=$!
  trap 'kill "$boot_pid" 2>/dev/null || true' EXIT
fi
phase cold-build xcodebuild "${args[@]}" -resultBundlePath "$out/cold.xcresult" build-for-testing
snapshot after-cold
if [[ "$MODE" == warm-control || "$MODE" == warm-cas ]]; then
  # Remove all per-build products/intermediates, preserving only the explicitly
  # separate locked dependency checkout and (for warm-cas) the compiler CAS.
  # Same checkout and derived-data paths ensure comparable compiler inputs.
  test "$derived" = "$RUNNER_TEMP/ios-ci-benchmark-derived"
  rm -rf "$derived"
  if [[ "$MODE" == warm-cas ]]; then
    test -d "$cas"
    du -sk "$cas" > "$out/cas-cold-kib.txt"
  fi
  phase warm-build xcodebuild "${args[@]}" -resultBundlePath "$out/warm.xcresult" build-for-testing
  snapshot after-warm
fi
if [[ "$MODE" == baseline ]]; then
  wait "$boot_pid"
  trap - EXIT
else
  phase boot xcrun simctl bootstatus "$device" -b
fi
test_run="$(python3 - "$derived" <<'PY'
import pathlib, sys
runs = sorted((pathlib.Path(sys.argv[1]) / "Build" / "Products").glob("*.xctestrun"))
if len(runs) != 1 or not runs[0].is_file():
    raise SystemExit(f"Expected exactly one xctestrun, found {runs}")
print(runs[0])
PY
)"
phase test xcodebuild -xctestrun "$test_run" -destination "platform=iOS Simulator,id=$device" -parallel-testing-enabled NO -resultBundlePath "$out/test.xcresult" test-without-building
test -d "$out/test.xcresult"
xcrun xcresulttool get test-results summary --path "$out/test.xcresult" > "$out/test-summary.json"
# Keep the exact source and its locks unchanged; no source or generated product reuse.
git -C "$root" diff --exit-code HEAD -- ios
test "$(git -C "$root" rev-parse HEAD)" = "$EXPECTED_SHA"
snapshot after-test
export BENCH_ELAPSED="$(( $(date +%s) - start ))"
python3 - <<'PY'
import json, os, pathlib, re, subprocess
out = pathlib.Path(os.environ["BENCH_OUT"])
cas = pathlib.Path(os.environ["BENCH_CAS"])
tests = {}
for name, outcome in re.findall(r"Test Case '-\[([^\]]+)\]' (passed|failed|skipped)", (out / "test.log").read_text(errors="replace")):
    if name in tests and tests[name] != outcome:
        raise SystemExit(f"conflicting test outcome for {name}")
    tests[name] = outcome
if not tests or any(x != "passed" for x in tests.values()):
    raise SystemExit(f"missing or non-passing XCTest outcomes: {tests}")
devices = json.loads((out / "devices.json").read_text())["devices"]
runtime, device = next((runtime, d["name"]) for runtime, ds in devices.items() for d in ds if d["udid"] == os.environ["BENCH_DEVICE"])
report = {
    "source": os.environ["EXPECTED_SHA"], "lane": os.environ["LANE"], "mode": os.environ["MODE"],
    "image_version": os.environ.get("ImageVersion", "not-reported"), "xcode": (out / "xcode.txt").read_text().strip(),
    "sdk": (out / "sdk.txt").read_text().strip(), "runtime": runtime, "device": device,
    "arch": subprocess.check_output(["uname", "-m"], text=True).strip(),
    "phases": {p.stem: int(p.read_text()) for p in out.glob("*.seconds")},
    "tests": tests, "elapsed": int(os.environ["BENCH_ELAPSED"]),
    "cas_kib": int(subprocess.check_output(["du", "-sk", str(cas)], text=True).split()[0]) if cas.is_dir() else 0,
}
(out / "report.json").write_text(json.dumps(report, indent=2) + "\n")
print(json.dumps(report, indent=2))
PY
