#!/usr/bin/env bash
# Install Python dependencies in the caller's existing interpreter family.
# Only the explicitly admitted S3 runtime may reuse an existing environment.
set -euo pipefail

mode="$1"
python_bin="$(command -v "$2")"
venv="$3"
shift 3
[[ "$mode" == create || "$mode" == ensure ]]
[[ "$venv" == /* && ! -L "$venv" && $# -gt 0 ]]
if [[ "$mode" == create ]]; then
  test ! -e "$venv"
fi

version=0.13.10
case "$(uname -s):$(uname -m)" in
  Linux:x86_64)
    asset=x86_64-unknown-linux-gnu
    sha=bf65ac1a0af10f92c522d91ac096c7c0a39657647b155577e7836c2cbbb4526c ;;
  Linux:aarch64)
    asset=aarch64-unknown-linux-gnu
    sha=14590f644805a6234ffe071154340669e38137f38e60aa9629690119704107d2 ;;
  Darwin:arm64)
    asset=aarch64-apple-darwin
    sha=e419bf07533bdbf48795fc793601c834dd79db57a8c49ce8e25cfe3a8639958d ;;
  Darwin:x86_64)
    asset=x86_64-apple-darwin
    sha=153e03197588204c04fc4c81cc4bafbfa4280222a385e4ee36a87aeec0ae63b4 ;;
  *)
    printf '%s\n' 'Unsupported uv platform' >&2
    exit 1 ;;
esac

work="$(mktemp -d "${TMPDIR:-/tmp}/codexia-uv.XXXXXXXX")"
trap 'rm -rf -- "$work"' EXIT
now_ms() { "$python_bin" -c 'import time; print(time.monotonic_ns() // 1000000)'; }
start="$(now_ms)"
curl --fail --location --silent --show-error --retry 2 --connect-timeout 10 --max-time 120 \
  "https://github.com/astral-sh/uv/releases/download/$version/uv-$asset.tar.gz" \
  --output "$work/uv.tar.gz"
if command -v sha256sum >/dev/null; then
  printf '%s  %s\n' "$sha" "$work/uv.tar.gz" | sha256sum --check
else
  printf '%s  %s\n' "$sha" "$work/uv.tar.gz" | shasum -a 256 -c
fi
tar -xzf "$work/uv.tar.gz" -C "$work"
uv="$work/uv-$asset/uv"
"$uv" --version
echo "uv acquisition_ms=$(($(now_ms)-start))"

export UV_NO_MANAGED_PYTHON=1 UV_LINK_MODE=copy UV_CACHE_DIR="$work/cache"
start="$(now_ms)"
if [[ "$mode" == ensure && -x "$venv/bin/python" ]]; then
  test -f "$venv/pyvenv.cfg"
elif [[ "$mode" == ensure ]]; then
  test ! -e "$venv/bin"
  "$uv" --no-config venv --allow-existing --python "$python_bin" "$venv"
else
  "$uv" --no-config venv --no-clear --python "$python_bin" "$venv"
fi
test -x "$venv/bin/python"
"$uv" --no-config pip install --python "$venv/bin/python" "$@"
echo "uv environment_ms=$(($(now_ms)-start))"
"$uv" --no-config pip check --python "$venv/bin/python"
