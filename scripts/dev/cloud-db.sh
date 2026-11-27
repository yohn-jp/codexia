#!/usr/bin/env bash
# Start only the disposable verification database service.
set -euo pipefail
umask 077

here="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
state="${CODEXIA_CLOUD_STATE_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/codexia-cloud}"
mkdir -p -- "$state"
chmod 700 -- "$state"
state="$(cd -- "$state" && pwd)"
runtime="$state/runtime.env"

if [[ ! -s "$runtime" ]]; then
  password="$(openssl rand -hex 32)"
  port=55440
  base="postgres://codexia:${password}@127.0.0.1:${port}"
  temporary="$(mktemp "$state/runtime.XXXXXX")"
  trap 'rm -f -- "$temporary"' EXIT
  cat > "$temporary" <<EOF
CODEXIA_CLOUD_DB_PASSWORD=$password
CODEXIA_CLOUD_DB_PORT=$port
CODEXIA_TEST_DATABASE_URL=$base/codexia_test
CODEXIA_AUTH_TEST_DATABASE_URL=$base/codexia_auth_test
CODEXIA_AUTH_TEST_DISPOSABLE=1
CODEXIA_E2E_DATABASE_URL=$base/codexia_e2e_compat_cloud
CODEXIA_WEB_OAUTH_TEST_DATABASE_URL=$base/codexia_web_oauth_test
EOF
  mv -- "$temporary" "$runtime"
  trap - EXIT
fi

# The entrypoint reads this bind mount as postgres. Cloud checkouts can leave
# tracked files readable only by the host user.
init_copy="$(mktemp "$state/init.XXXXXX")"
trap 'rm -f -- "$init_copy"' EXIT
install -m 0444 -- "$here/init.sql" "$init_copy"
mv -- "$init_copy" "$state/init.sql"
trap - EXIT

# Use the saved password and port, not an ambient override. Compose provides
# startup, health-based waiting, and container/volume lifecycle management.
env -u CODEXIA_CLOUD_DB_PASSWORD -u CODEXIA_CLOUD_DB_PORT \
  docker compose --project-name codexia-cloud-test \
  --project-directory "$state" --env-file "$runtime" -f "$here/compose.yaml" up -d --wait --wait-timeout 60
printf 'Disposable PostgreSQL ready. Source %s for database-backed checks.\n' "$runtime"
