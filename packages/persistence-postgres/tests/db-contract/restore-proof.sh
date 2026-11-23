#!/bin/bash
set -euo pipefail
umask 077

database="codexia-schema-proof-$(cat /proc/sys/kernel/random/uuid)"
cleanup(){ /usr/bin/podman rm -f "$database" >/dev/null 2>&1 || true; }
trap cleanup EXIT

podman run -d --name "$database" --network none --security-opt no-new-privileges \
  -e POSTGRES_DB=codexia -e POSTGRES_HOST_AUTH_METHOD=trust "$CODEXIA_PG_IMAGE_ID" >/dev/null
for attempt in $(seq 1 60); do
  if podman exec "$database" psql -X -qAt -v ON_ERROR_STOP=1 -h 127.0.0.1 -U postgres -d codexia -c 'SELECT 1' >/dev/null 2>&1; then break; fi
  sleep 1
done
podman exec "$database" psql -X -qAt -v ON_ERROR_STOP=1 -h 127.0.0.1 -U postgres -d codexia -c 'SELECT 1' >/dev/null

age -d -i /contract/identity /contract/backup/database.dump.age |
  podman exec -i "$database" pg_restore --exit-on-error --no-owner --no-privileges -U postgres -d codexia
podman exec -i "$database" psql -X -qAt -v ON_ERROR_STOP=1 -U postgres -d codexia \
  -c 'SELECT json_agg(json_build_array(version,btrim(checksum)) ORDER BY version)::text FROM public.codexia_schema_migrations' \
  > /contract/restore-proof/migration-ledger.json
podman exec -i "$database" psql -X -qAt -v ON_ERROR_STOP=1 -U postgres -d codexia \
  < /contract/auth-fingerprint.sql > /contract/restore-proof/auth-definitions.txt
podman exec -i "$database" psql -X -qAt -v ON_ERROR_STOP=1 -U postgres -d codexia \
  -v contract_project_id="$CODEXIA_RESTORE_PROJECT_ID" \
  < /contract/restore-identity.sql \
  > /contract/restore-proof/owner-identity.json
[[ -s /contract/restore-proof/owner-identity.json ]]
