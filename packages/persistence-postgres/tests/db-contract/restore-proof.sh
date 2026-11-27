#!/bin/bash
set -euo pipefail
umask 077

[[ $# == 6 ]] || exit 1
backup="$1"; identity="$2"; proof="$3"; pg_image="$4"; pg_image_id="$5"; project_id="$6"
contract_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
database="codexia-schema-proof-$(cat /proc/sys/kernel/random/uuid)"
status=0
podman container exists "$database" || status=$?
[[ "$status" == 1 ]] || { echo 'Isolated proof container name unavailable' >&2; exit 1; }
cleanup(){
  local status=0
  podman container exists "$database" || status=$?
  if [[ "$status" == 0 ]]; then
    podman rm -f --volumes "$database" >/dev/null || return 1
  elif [[ "$status" != 1 ]]; then
    return 1
  fi
  status=0
  podman container exists "$database" || status=$?
  [[ "$status" == 1 ]]
}
finish(){
  local status=$?
  trap - EXIT
  cleanup || { echo 'Isolated proof cleanup failed' >&2; status=1; }
  exit "$status"
}
trap finish EXIT

podman run -d --name "$database" --network none --pull=never --security-opt no-new-privileges \
  -e POSTGRES_DB=codexia -e POSTGRES_HOST_AUTH_METHOD=trust "$pg_image" >/dev/null
[[ "$(podman inspect --format '{{.HostConfig.NetworkMode}}' "$database")" == none ]]
actual_id="$(podman inspect --format '{{.Image}}' "$database")"
[[ "${actual_id#sha256:}" == "${pg_image_id#sha256:}" ]]
for attempt in $(seq 1 60); do
  if podman exec "$database" psql -X -qAt -v ON_ERROR_STOP=1 -h 127.0.0.1 -U postgres -d codexia -c 'SELECT 1' >/dev/null 2>&1; then break; fi
  sleep 1
done
podman exec "$database" psql -X -qAt -v ON_ERROR_STOP=1 -h 127.0.0.1 -U postgres -d codexia -c 'SELECT 1' >/dev/null

age -d -i "$identity" "$backup/database.dump.age" |
  podman exec -i "$database" pg_restore --exit-on-error --no-owner --no-privileges -U postgres -d codexia
podman exec -i "$database" psql -X -qAt -v ON_ERROR_STOP=1 -U postgres -d codexia \
  -c 'SELECT json_agg(json_build_array(version,btrim(checksum)) ORDER BY version)::text FROM public.codexia_schema_migrations' \
  > "$proof/migration-ledger.json"
podman exec -i "$database" psql -X -qAt -v ON_ERROR_STOP=1 -U postgres -d codexia \
  < "$contract_dir/restore-proof-auth.sql" > "$proof/auth-definitions.txt"
podman exec -i "$database" psql -X -qAt -v ON_ERROR_STOP=1 -U postgres -d codexia \
  -v contract_project_id="$project_id" \
  < "$contract_dir/restore-proof-identity.sql" \
  > "$proof/owner-identity.json"
[[ -s "$proof/owner-identity.json" ]]
