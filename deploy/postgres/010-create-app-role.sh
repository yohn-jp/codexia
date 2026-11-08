#!/bin/sh
set -eu

PG_APP_PASSWORD=$(cat /run/secrets/app-password)
export PG_APP_PASSWORD
case "$PG_APP_PASSWORD" in *[!A-Fa-f0-9]*|'') echo "PostgreSQL application password must be hexadecimal" >&2; exit 1 ;; esac

psql --set=ON_ERROR_STOP=1 \
  --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<'SQL'
\getenv app_password PG_APP_PASSWORD
SELECT format('CREATE ROLE codexia LOGIN PASSWORD %L', :'app_password') \gexec
ALTER DATABASE codexia OWNER TO codexia;
SQL

unset PG_APP_PASSWORD
