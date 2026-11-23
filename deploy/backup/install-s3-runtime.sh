#!/usr/bin/env bash
set -euo pipefail
umask 077

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
state_root="${XDG_STATE_HOME:-$HOME/.local/state}/codexia-deploy"
target="${1:-$state_root/s3-runtime}"
[[ "$target" == /* && ! -L "$target" ]] || {
  printf '%s\n' 'S3 runtime target must be an absolute path without symlinks' >&2
  exit 1
}
if [[ -e "$target" ]]; then
  [[ -d "$target" && ! -L "$target" ]] || {
    printf '%s\n' 'S3 runtime target must be a real directory' >&2
    exit 1
  }
  [[ "$(stat -Lc '%u:%a' -- "$target")" == "$(id -u):700" ]] || {
    printf '%s\n' 'S3 runtime target must be owned by the current user and mode 0700' >&2
    exit 1
  }
else
  mkdir -p -- "$(dirname -- "$target")"
  mkdir -- "$target"
  chmod 0700 -- "$target"
fi

if [[ ! -x "$target/bin/python" ]]; then
  [[ ! -e "$target/bin" ]] || {
    printf '%s\n' 'Incomplete Python environment exists at the S3 runtime target' >&2
    exit 1
  }
  python3 -m venv "$target"
fi
[[ -x "$target/bin/python" ]] || {
  printf '%s\n' 'Pinned S3 Python environment is invalid' >&2
  exit 1
}

"$target/bin/python" -m pip install \
  --disable-pip-version-check \
  --no-input \
  --require-hashes \
  --force-reinstall \
  -r "$script_dir/requirements.lock" >/dev/null
"$target/bin/python" -c 'import boto3, botocore; assert boto3.__version__ == "1.44.9"; assert botocore.__version__ == "1.44.9"'
printf 'Installed pinned Boto3 runtime at %s\n' "$target"
