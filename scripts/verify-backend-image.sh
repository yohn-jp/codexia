#!/usr/bin/env bash
set -euo pipefail

engine="${1:-docker}"
image="${2:-codexia-backend-ci}"
container_name="codexia-backend-smoke-${RANDOM}-${RANDOM}"
token="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))')"

cleanup() {
  "$engine" rm -f "$container_name" >/dev/null 2>&1 || true
}
trap cleanup EXIT

"$engine" run --detach --name "$container_name" \
  --publish 127.0.0.1::3000 \
  --env "CODEXIA_AUTH_TOKEN=$token" \
  --env CODEXIA_DATA_DIR=/data \
  --env CODEXIA_USAGE_DIR=/history \
  "$image" >/dev/null

port="$("$engine" port "$container_name" 3000/tcp | sed -n 's/.*://p')"
if [[ -z "$port" ]]; then
  echo "The backend test container did not publish its temporary local probe port." >&2
  exit 1
fi

ready=0
for attempt in $(seq 1 60); do
  if curl --fail --silent "http://127.0.0.1:$port/health/ready" >/dev/null; then
    ready=1
    break
  fi
  if [[ "$("$engine" inspect --format '{{.State.Running}}' "$container_name")" != true ]]; then break; fi
  sleep 1
done
if [[ "$ready" != 1 ]]; then
  "$engine" logs "$container_name" >&2 || true
  echo "The backend did not become ready." >&2
  exit 1
fi

for endpoint in /health/startup /health/live /api/health /api/ready; do
  curl --fail --silent "http://127.0.0.1:$port$endpoint" >/dev/null
done

session_status="$(curl --silent --output /dev/null --write-out '%{http_code}' "http://127.0.0.1:$port/api/session")"
root_response="$(curl --silent --write-out '\n%{http_code}' "http://127.0.0.1:$port/")"
desktop_response="$(curl --silent --write-out '\n%{http_code}' "http://127.0.0.1:$port/desktop/")"
root_status="${root_response##*$'\n'}"
desktop_status="${desktop_response##*$'\n'}"
[[ "$session_status" == 401 ]] || { echo "Unauthenticated API session returned HTTP $session_status." >&2; exit 1; }
[[ "$root_status" == 503 && "$root_response" == *'"code":"APP_NOT_BUILT"'* &&
   "$desktop_status" == 503 && "$desktop_response" == *'"code":"APP_NOT_BUILT"'* ]] || {
  echo "Backend image did not keep the UI outside its image (root=$root_status, desktop=$desktop_status)." >&2
  exit 1
}

uid="$("$engine" exec "$container_name" node -p 'process.getuid()')"
[[ "$uid" == 1000 ]] || { echo "Expected backend UID 1000; got $uid." >&2; exit 1; }
"$engine" exec "$container_name" node -e "const fs = require('node:fs'); if (fs.existsSync('/app/app/dist/index.html')) process.exit(1); fs.writeFileSync('/data/.deployment-smoke', 'ok'); fs.unlinkSync('/data/.deployment-smoke')"

"$engine" kill --signal TERM "$container_name" >/dev/null
exit_code="$("$engine" wait "$container_name")"
[[ "$exit_code" == 0 ]] || { echo "Backend did not exit cleanly after SIGTERM (exit $exit_code)." >&2; exit 1; }
"$engine" logs "$container_name" 2>&1 | grep -Fq 'Codexia shutdown complete'
echo "Backend OCI checks passed: health/readiness, auth boundary, no UI assets, nonroot UID, writable persistence, and graceful shutdown."
