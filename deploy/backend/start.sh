#!/bin/sh
set -eu

read_secret_file() {
  secret_path="$1"
  if [ ! -r "$secret_path" ]; then
    echo "Configured Codexia secret file is unavailable" >&2
    exit 1
  fi
  secret_value=$(cat "$secret_path")
  if [ -z "$secret_value" ]; then
    echo "Configured Codexia secret file is empty" >&2
    exit 1
  fi
  printf '%s' "$secret_value"
}

if [ -n "${CODEXIA_AUTH_TOKEN_FILE:-}" ]; then
  CODEXIA_AUTH_TOKEN=$(read_secret_file "$CODEXIA_AUTH_TOKEN_FILE")
  export CODEXIA_AUTH_TOKEN
  unset CODEXIA_AUTH_TOKEN_FILE
fi

if [ -n "${CODEXIA_GITHUB_TOKEN_FILE:-}" ]; then
  CODEXIA_GITHUB_TOKEN=$(read_secret_file "$CODEXIA_GITHUB_TOKEN_FILE")
  export CODEXIA_GITHUB_TOKEN
  unset CODEXIA_GITHUB_TOKEN_FILE
fi

exec node /app/launch.mjs
