#!/usr/bin/env bash
# Build an isolated StrictDoc environment from the existing exact-version lock.
set -euo pipefail
venv="$1"
lock="$2"
python_bin="$(command -v python)"
test -f "$lock"
test ! -e "$venv"
work="$(mktemp -d "$RUNNER_TEMP/strictdoc-uv.XXXXXXXX")"
trap 'rm -rf -- "$work"' EXIT
start="$(date +%s%3N)"
curl --fail --location --silent --show-error --retry 2 \
  'https://github.com/astral-sh/uv/releases/download/0.13.10/uv-x86_64-unknown-linux-gnu.tar.gz' \
  --output "$work/uv.tar.gz"
echo "bf65ac1a0af10f92c522d91ac096c7c0a39657647b155577e7836c2cbbb4526c  $work/uv.tar.gz" | sha256sum --check
tar -xzf "$work/uv.tar.gz" -C "$work"
uv="$work/uv-x86_64-unknown-linux-gnu/uv"
"$uv" --version
echo "StrictDoc uv acquisition_ms=$(($(date +%s%3N)-start))"
export UV_NO_MANAGED_PYTHON=1 UV_LINK_MODE=copy UV_CACHE_DIR="$work/cache"
start="$(date +%s%3N)"
"$uv" venv --python "$python_bin" "$venv"
"$uv" pip install --python "$venv/bin/python" --requirement "$lock"
echo "StrictDoc uv environment_ms=$(($(date +%s%3N)-start))"
"$uv" pip check --python "$venv/bin/python"
