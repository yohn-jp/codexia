#!/usr/bin/env bash
set -euo pipefail
engine="${1:-docker}"
image="${2:-codexia-backend-ci}"
: "${CODEXIA_TEST_DATABASE_URL:?A disposable PostgreSQL database is required}"
container_name="codexia-backend-smoke-${RANDOM}-${RANDOM}"
token="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))')"
port="$(node -e 'const s=require("node:net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')"
cleanup() { "$engine" rm -f "$container_name" >/dev/null 2>&1 || true; }
trap cleanup EXIT
"$engine" run --detach --name "$container_name" --network host --read-only --tmpfs /tmp:rw,nosuid,nodev,size=64m \
  --env "CODEXIA_AUTH_TOKEN=$token" --env "CODEXIA_DATABASE_URL=$CODEXIA_TEST_DATABASE_URL" \
  --env CODEXIA_DATABASE_MIGRATE_ON_START=1 --env "PORT=$port" "$image" >/dev/null
ready=0
for attempt in $(seq 1 60); do
  if curl --fail --silent "http://127.0.0.1:$port/health/ready" >/dev/null; then ready=1; break; fi
  if [[ "$("$engine" inspect --format '{{.State.Running}}' "$container_name")" != true ]]; then break; fi
  sleep 1
done
if [[ "$ready" != 1 ]]; then "$engine" logs "$container_name" >&2; exit 1; fi
for endpoint in /health/startup /health/live /api/health /api/ready; do curl --fail --silent "http://127.0.0.1:$port$endpoint" >/dev/null; done
[[ "$(curl --silent --output /dev/null --write-out '%{http_code}' "http://127.0.0.1:$port/api/session")" == 401 ]]
[[ "$(curl --silent --output /dev/null --write-out '%{http_code}' "http://127.0.0.1:$port/")" == 503 ]]
for endpoint in /api/projects /api/modules /api/actions; do
  [[ "$(curl --silent --header "Authorization: Bearer $token" --output /dev/null --write-out '%{http_code}' "http://127.0.0.1:$port$endpoint")" == 404 ]]
done
curl --fail --silent --header "Authorization: Bearer $token" "http://127.0.0.1:$port/api/v1/persistence/status" | grep -Fq '"provider":"postgres"'
[[ "$("$engine" exec "$container_name" node -p 'process.getuid()')" == 1000 ]]
"$engine" exec "$container_name" sh -c '! command -v git && test ! -e /app/app/dist'
"$engine" kill --signal TERM "$container_name" >/dev/null
[[ "$("$engine" wait "$container_name")" == 0 ]]
"$engine" logs "$container_name" 2>&1 | grep -Fq 'Codexia shutdown complete'
echo "PostgreSQL-only OCI checks passed: readiness, auth, retired endpoints absent, no Git executable, read-only nonroot runtime and graceful shutdown."
