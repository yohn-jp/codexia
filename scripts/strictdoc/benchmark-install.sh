#!/usr/bin/env bash
# Experimental timings only; no cache writes, production changes, or certification reuse.
set -euo pipefail
root="$RUNNER_TEMP/strictdoc-install-benchmark"
results="$root/results"
mkdir -p "$results"
lock="$PWD/scripts/strictdoc/requirements.lock.txt"
python_bin="$(command -v python)"
printf 'method\tcondition\tvenv_ms\tinstall_ms\tverify_ms\tcache_kib\n' > "$results/timing.tsv"
printf 'source=%s\npython=%s\nlock=%s\nrunner=%s\n' "$(git rev-parse HEAD)" "$("$python_bin" --version)" "$(sha256sum "$lock")" "$ImageOS $ImageVersion" > "$results/environment.txt"
now() { date +%s%3N; }
start="$(now)"
curl --fail --location --silent --show-error --retry 2 \
  'https://github.com/astral-sh/uv/releases/download/0.13.10/uv-x86_64-unknown-linux-gnu.tar.gz' \
  --output "$root/uv.tar.gz"
echo "bf65ac1a0af10f92c522d91ac096c7c0a39657647b155577e7836c2cbbb4526c  $root/uv.tar.gz" | sha256sum --check
tar -xzf "$root/uv.tar.gz" -C "$root"
uv="$root/uv-x86_64-unknown-linux-gnu/uv"
"$uv" --version | tee "$results/uv-version.txt"
echo "uv acquisition_ms=$(($(now)-start))" | tee "$results/uv-acquisition.txt"
export UV_NO_MANAGED_PYTHON=1 UV_LINK_MODE=copy
export PIP_DISABLE_PIP_VERSION_CHECK=1
export PIP_INDEX_URL=https://pypi.org/simple
export UV_DEFAULT_INDEX=https://pypi.org/simple
unset PIP_EXTRA_INDEX_URL UV_INDEX_URL UV_EXTRA_INDEX_URL
# The warm arm reuses only the manager's local package cache, never an environment.
measure() {
  local manager="$1" condition="$2" start venv_ms install_ms verify_ms cache_kib
  local envdir="$root/$manager-$condition" cache="$root/$manager-cache"
  mkdir -p "$cache"
  start="$(now)"
  if [[ "$manager" == pip ]]; then
    "$python_bin" -m venv "$envdir"
  else
    "$uv" venv --python "$python_bin" "$envdir"
  fi
  venv_ms=$(($(now)-start))
  start="$(now)"
  if [[ "$manager" == pip ]]; then
    PIP_CACHE_DIR="$cache" "$envdir/bin/python" -m pip install --requirement "$lock"
  else
    UV_CACHE_DIR="$cache" "$uv" pip install --python "$envdir/bin/python" --requirement "$lock"
  fi
  install_ms=$(($(now)-start))
  echo "INSTALL_RESULT $manager $condition venv_ms=$venv_ms install_ms=$install_ms"
  if [[ "$manager" == pip ]]; then
    "$envdir/bin/python" -m pip check
  else
    "$uv" pip check --python "$envdir/bin/python"
  fi
  "$envdir/bin/python" - "$lock" "$results/$manager-$condition-packages.json" <<'PY'
import importlib.metadata as md
import json
import re
import sys
def canonical(name):
    return re.sub(r"[-_.]+", "-", name).lower()
expected = dict((canonical(name), version) for name, version in
                (line.strip().split("==", 1) for line in open(sys.argv[1]) if line.strip()))
installed = {canonical(d.metadata["Name"]): d for d in md.distributions()}
actual = {name: dist.version for name, dist in installed.items()
          if name in expected or name not in {"pip", "setuptools"}}
assert actual == expected, (set(expected.items()) - set(actual.items()), set(actual.items()) - set(expected.items()))
with open(sys.argv[2], "w") as out:
    json.dump({"packages": actual, "requires": {name: dist.requires or [] for name, dist in installed.items()
               if name in expected}}, out, indent=2, sort_keys=True)
print("PACKAGE_PARITY", len(actual))
PY
  start="$(now)"
  node scripts/strictdoc/verify.mjs --strictdoc "$envdir/bin/strictdoc" \
    --output-dir "$root/$manager-$condition-output" --report "$results/$manager-$condition-trace.json"
  verify_ms=$(($(now)-start))
  cache_kib="$(du -sk "$cache" | cut -f1)"
  printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$manager" "$condition" "$venv_ms" "$install_ms" "$verify_ms" "$cache_kib" | tee -a "$results/timing.tsv"
  echo "TRACE_BENCHMARK_RESULT $manager $condition venv_ms=$venv_ms install_ms=$install_ms verify_ms=$verify_ms cache_kib=$cache_kib"
}
# Alternate manager order across matched runners; never run competitors concurrently.
if [[ "$BENCH_SAMPLE" == 2 ]]; then
  order="uv pip"
else
  order="pip uv"
fi
for manager in $order; do
  measure "$manager" cold
  measure "$manager" warm
done
cat "$results/timing.tsv"
{
  echo '### StrictDoc dependency benchmark (not certification)'
  echo 'Cold = empty manager cache; warm = same local cache, new virtual environment.'
  echo 'uv acquisition is separate. Remote cache restore/save is not measured.'
  echo '~~~'
  cat "$results/environment.txt" "$results/uv-version.txt" "$results/uv-acquisition.txt" "$results/timing.tsv"
  echo '~~~'
} >> "$GITHUB_STEP_SUMMARY"
