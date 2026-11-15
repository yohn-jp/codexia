#!/usr/bin/env bash
set -euo pipefail
name="codexia-iac-test-$$"
password=$(printf '%064d' 1)
trap 'docker rm -f "$name" >/dev/null 2>&1 || true' EXIT
docker run -d --name "$name" -e POSTGRES_PASSWORD=test -e POSTGRES_DB=codexia docker.io/library/postgres:17-bookworm@sha256:665dc7b37ac52a17e298511414c21d23ffa4e6a6ef6225b3e5d59c7afb35e994 >/dev/null
for i in $(seq 1 60); do
  if docker exec "$name" pg_isready -h 127.0.0.1 -U postgres -d codexia >/dev/null 2>&1; then break; fi
  sleep 1
done
sql() { docker exec -i "$name" psql -X -qAt -v ON_ERROR_STOP=1 -U postgres -d codexia "$@"; }
sql -c 'CREATE TABLE public.canon(id integer); INSERT INTO public.canon VALUES (1);'
apply() { { printf '\\set preflight_password %s\n' "$password"; cat deploy/updater/provision-preflight-role.sql; } | sql; }
first=$(apply)
grep -qx changed <<<"$first"
test -z "$(apply)"
reader() { docker exec -e PGPASSWORD="$password" "$name" psql -X -qAt -v ON_ERROR_STOP=1 -h 127.0.0.1 -U codexia_preflight -d codexia "$@"; }
test "$(reader -c 'SHOW transaction_read_only')" = on
test "$(reader -c 'SELECT id FROM public.canon')" = 1
if reader -c 'SET default_transaction_read_only=off; INSERT INTO public.canon VALUES (2);'; then exit 1; fi
sql -c 'CREATE TABLE public.new_canon(id integer);'
grep -qx changed <<<"$(apply)"
test -z "$(apply)"
sql -c 'GRANT INSERT ON public.canon TO codexia_preflight;'
if apply; then echo 'Unsafe role accepted' >&2; exit 1; fi
