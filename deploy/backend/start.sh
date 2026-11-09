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

if [ -n "${CODEXIA_DATABASE_PASSWORD_FILE:-}" ]; then
  database_password=$(read_secret_file "$CODEXIA_DATABASE_PASSWORD_FILE")
  database_user=${CODEXIA_DATABASE_USER:-codexia}
  database_name=${CODEXIA_DATABASE_NAME:-codexia}
  database_host=${CODEXIA_DATABASE_HOST:-codexia-db}
  case "$database_user$database_name" in *[!A-Za-z0-9_-]*|'') echo "Database user and name must be URL-safe identifiers" >&2; exit 1 ;; esac
  case "$database_host" in *[!A-Za-z0-9.-]*|'') echo "Database host must be a hostname" >&2; exit 1 ;; esac
  case "$database_password" in *[!A-Fa-f0-9]*|'') echo "Database password must be a non-empty hexadecimal secret" >&2; exit 1 ;; esac
  CODEXIA_DATABASE_URL="postgres://${database_user}:${database_password}@${database_host}:5432/${database_name}"
  export CODEXIA_DATABASE_URL
  unset CODEXIA_DATABASE_PASSWORD_FILE database_password
fi

exec node /app/launch.mjs
