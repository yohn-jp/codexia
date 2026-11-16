#!/usr/bin/env bash
# Run only after test-base-secrets-integration.sh on a disposable Ubuntu runner.
set -euo pipefail
test "${GITHUB_ACTIONS:-}" = true
test "${CODEXIA_DISPOSABLE_HOST:-}" = phase-b-integration
test "$(lsb_release -rs)" = 26.04
service_user=${CODEXIA_SERVICE_USER:?missing rootless fixture identity}
service_uid=$(id -u "$service_user")
service_home=$(getent passwd "$service_user" | cut -d: -f6)
test "$(id -un)" != "$service_user"
sudo -n true
as_service() {
  sudo -u "$service_user" env HOME="$service_home" XDG_CONFIG_HOME="$service_home/.config" XDG_DATA_HOME="$service_home/.local/share" XDG_STATE_HOME="$service_home/.local/state" XDG_RUNTIME_DIR="/run/user/$service_uid" DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$service_uid/bus" "$@"
}
podman() { as_service /usr/bin/podman "$@"; }
systemctl() {
  if [[ "${1:-}" == --user ]]; then as_service /usr/bin/systemctl "$@"; else command systemctl "$@"; fi
}
test "$(podman info --format '{{.Host.Security.Rootless}}')" = true
test "$(id -u)" != 0

export XDG_RUNTIME_DIR="/run/user/$service_uid"
export DBUS_SESSION_BUS_ADDRESS="unix:path=$XDG_RUNTIME_DIR/bus"
systemctl --user show --property=Version >/dev/null

quadlet_dir="$service_home/.config/containers/systemd"
as_service test ! -e "$service_home/unexpected-tunnel-mount"
for container in codexia-db codexia-tunnel codexia-api codexia-api-proxy; do
  rc=0; podman container exists "$container" || rc=$?
  test "$rc" = 1
done
for network in codexia codexia-data; do
  rc=0; podman network exists "$network" || rc=$?
  test "$rc" = 1
done
for volume in codexia-data codexia-history; do
  rc=0; podman volume exists "$volume" || rc=$?
  test "$rc" = 1
done
podman volume exists codexia-postgres
for secret in codexia-auth-token codexia-tunnel-token codexia-postgres-admin-password codexia-postgres-app-password; do
  podman secret exists "$secret"
done
rc=0; podman secret exists codexia-postgres-preflight-password || rc=$?
test "$rc" = 1
test ! -e /etc/codexia
for file in codexia.network codexia-data.network codexia-postgres.volume codexia-data.volume codexia-history.volume codexia-db.container codexia-tunnel.container; do
  as_service test ! -e "$quadlet_dir/$file"
done

tmp=$(mktemp -d "${TMPDIR:-/tmp}/codexia-base-runtime.XXXXXX")
cleanup() {
  systemctl --user stop codexia-tunnel.service codexia-db.service >/dev/null 2>&1 || true
  podman rm -f codexia-tunnel codexia-db >/dev/null 2>&1 || true
  as_service rm -f \
    "$quadlet_dir/codexia.network" \
    "$quadlet_dir/codexia-data.network" \
    "$quadlet_dir/codexia-postgres.volume" \
    "$quadlet_dir/codexia-data.volume" \
    "$quadlet_dir/codexia-history.volume" \
    "$quadlet_dir/codexia-db.container" \
    "$quadlet_dir/codexia-tunnel.container"
  systemctl --user daemon-reload >/dev/null 2>&1 || true
  systemctl --user reset-failed codexia-tunnel.service codexia-db.service >/dev/null 2>&1 || true
  podman network rm codexia-data codexia >/dev/null 2>&1 || true
  podman volume rm codexia-postgres codexia-data codexia-history >/dev/null 2>&1 || true
  podman secret rm \
    codexia-auth-token \
    codexia-tunnel-token \
    codexia-tunnel-token-wrong \
    codexia-postgres-admin-password \
    codexia-postgres-app-password \
    codexia-postgres-preflight-password >/dev/null 2>&1 || true
  as_service rm -rf "$service_home/unexpected-tunnel-mount" >/dev/null 2>&1 || true
  sudo rm -f /etc/codexia/postgres/010-create-app-role.sh
  sudo rmdir /etc/codexia/postgres /etc/codexia 2>/dev/null || true
  rm -rf "$tmp"
}
trap cleanup EXIT
umask 077

repo_root=$(pwd)
cat > "$tmp/base-inventory.yml" <<YAML
all:
  children:
    codexia:
      hosts:
        localhost:
          ansible_connection: local
          ansible_python_interpreter: /usr/bin/python3
      vars:
        codexia_stage: base
        codexia_base_approved: true
        codexia_database_initialization_approved: true
        codexia_service_user: $service_user
        codexia_service_uid: $service_uid
        codexia_service_home: "$service_home"
YAML
apply_base() {
  "${ANSIBLE_PLAYBOOK:-ansible-playbook}" -i "$tmp/base-inventory.yml" deploy/ansible/site.yml "$@"
}
# Existing Quadlet drift must be detected before other files, directories, or runtime resources are created.
as_service mkdir -p "$quadlet_dir"
cat deploy/quadlet/codexia-data.network | as_service tee "$quadlet_dir/codexia-data.network" >/dev/null
as_service sh -c 'printf "# fixture drift\\n" >> "$1"' _ "$quadlet_dir/codexia-data.network"
if apply_base > "$tmp/quadlet-drift.log" 2>&1; then
  echo 'Base convergence accepted an existing noncanonical Quadlet' >&2
  exit 1
fi
grep -q 'Existing Codexia Quadlet differs from the reviewed source' "$tmp/quadlet-drift.log"
test "$(as_service find "$quadlet_dir" -mindepth 1 -maxdepth 1 -type f | wc -l)" -eq 1
test ! -e /etc/codexia
for network in codexia codexia-data; do
  rc=0; podman network exists "$network" || rc=$?
  test "$rc" = 1
done
for volume in codexia-data codexia-history; do
  rc=0; podman volume exists "$volume" || rc=$?
  test "$rc" = 1
done
rc=0; podman container exists codexia-db || rc=$?
test "$rc" = 1
as_service rm "$quadlet_dir/codexia-data.network"

# A fresh or empty PostgreSQL volume requires its own explicit approval.
sed -i 's/codexia_database_initialization_approved: true/codexia_database_initialization_approved: false/' "$tmp/base-inventory.yml"
if apply_base > "$tmp/database-init-denied.log" 2>&1; then
  echo 'Fresh PostgreSQL initialization did not require explicit approval' >&2
  exit 1
fi
grep -q 'Explicit approval is required before initializing an empty PostgreSQL volume' "$tmp/database-init-denied.log"
test ! -e /etc/codexia
for network in codexia codexia-data; do
  rc=0; podman network exists "$network" || rc=$?
  test "$rc" = 1
done
sed -i 's/codexia_database_initialization_approved: false/codexia_database_initialization_approved: true/' "$tmp/base-inventory.yml"

apply_base > "$tmp/first.log" || { cat "$tmp/first.log"; exit 1; }
grep -Eq 'changed=[1-9]' "$tmp/first.log"
apply_base > "$tmp/second.log" || { cat "$tmp/second.log"; exit 1; }
grep -q 'changed=0' "$tmp/second.log"

test "$(podman network inspect --format '{{.Name}}|{{.Driver}}|{{.Internal}}' codexia-data)" = 'codexia-data|bridge|true'
test "$(podman network inspect --format '{{.Name}}|{{.Driver}}|{{.Internal}}' codexia)" = 'codexia|bridge|false'
for volume in codexia-postgres codexia-data codexia-history; do
  test "$(podman volume inspect --format '{{.Name}}' "$volume")" = "$volume"
done
test "$(podman inspect --format '{{.Config.Image}}' codexia-db)" = 'docker.io/library/postgres:17-bookworm@sha256:40865bc877a289da75963d97d72b59633f639fc5af7a4e856bfa3714cae5b536'
test "$(podman inspect --format '{{json .NetworkSettings.Networks}}' codexia-db | jq -r 'keys | join(",")')" = codexia-data
test "$(podman inspect --format '{{json .HostConfig.PortBindings}}' codexia-db | jq -c 'if . == null then {} else . end')" = '{}'
test "$(podman inspect --format '{{range .Mounts}}{{if eq .Type "volume"}}{{.Name}}|{{.Destination}}{{"\n"}}{{end}}{{end}}' codexia-db)" = 'codexia-postgres|/var/lib/postgresql/data'
podman inspect --format '{{json .Mounts}}' codexia-db | jq -e '[.[] | select(.Destination == "/var/lib/postgresql/data" or (.Destination | startswith("/var/lib/postgresql/data/")) or (.Destination | startswith("/var/lib/postgresql/")))] | length == 1 and .[0].Type == "volume" and .[0].Name == "codexia-postgres" and .[0].Destination == "/var/lib/postgresql/data" and .[0].RW == true' >/dev/null
podman inspect --format '{{json .Config.Env}}' codexia-db | jq -e 'index("PGDATA=/var/lib/postgresql/data/pgdata") != null and index("POSTGRES_DB=codexia") != null and index("POSTGRES_USER=codexia_admin") != null and index("POSTGRES_PASSWORD_FILE=/run/secrets/admin-password") != null' >/dev/null
podman exec codexia-db pg_isready -U codexia -d codexia >/dev/null

# Existing Tunnel adoption checks inspect actual Podman state before any host mutation.
tunnel_image='docker.io/cloudflare/cloudflared@sha256:b94b96edf2c9c4360f8879c8580cfaa99077f19c849ec595ca2f711b27d4f344'
podman pull "$tunnel_image" >/dev/null
cat > "$tmp/verify-tunnel.yml" <<YAML
---
- hosts: localhost
  connection: local
  gather_facts: false
  become: true
  become_user: $service_user
  environment:
    HOME: "$service_home"
    XDG_CONFIG_HOME: "$service_home/.config"
    XDG_RUNTIME_DIR: "/run/user/$service_uid"
    DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/$service_uid/bus"
  tasks:
    - ansible.builtin.include_tasks: "$repo_root/deploy/ansible/verify-base-tunnel-container.yml"
YAML
verify_tunnel() {
  "${ANSIBLE_PLAYBOOK:-ansible-playbook}" -i localhost, "$tmp/verify-tunnel.yml"
}
expect_tunnel_drift_rejection() {
  if verify_tunnel > "$tmp/tunnel-runtime-drift.log" 2>&1; then
    echo 'Tunnel adoption accepted noncanonical runtime state' >&2
    exit 1
  fi
  grep -q 'Existing Tunnel image, private network, loopback-only port' "$tmp/tunnel-runtime-drift.log"
}
create_tunnel_fixture() {
  podman create --name codexia-tunnel "$@" --secret "${tunnel_fixture_secret:-codexia-tunnel-token}",type=mount,target=/run/secrets/token --read-only --tmpfs /tmp:rw,nosuid,nodev,noexec,size=16m "$tunnel_image" tunnel --no-autoupdate --metrics 0.0.0.0:2000 run --token-file /run/secrets/token >/dev/null
}
create_bind_tunnel_fixture() {
  podman create --name codexia-tunnel "$@" --read-only --tmpfs /tmp:rw,nosuid,nodev,noexec,size=16m "$tunnel_image" tunnel --no-autoupdate --metrics 0.0.0.0:2000 run --token-file /run/secrets/token >/dev/null
}
create_tunnel_fixture --network codexia-data --publish 127.0.0.1:2000:2000/tcp
expect_tunnel_drift_rejection
podman rm codexia-tunnel >/dev/null
create_tunnel_fixture --network codexia --publish 0.0.0.0:2000:2000/tcp
expect_tunnel_drift_rejection
podman rm codexia-tunnel >/dev/null
printf 'wrong-tunnel-token' | podman secret create codexia-tunnel-token-wrong - >/dev/null
tunnel_fixture_secret=codexia-tunnel-token-wrong
create_tunnel_fixture --network codexia --publish 127.0.0.1:2000:2000/tcp
expect_tunnel_drift_rejection
podman rm codexia-tunnel >/dev/null
podman secret rm codexia-tunnel-token-wrong >/dev/null
tunnel_fixture_secret=codexia-tunnel-token
as_service mkdir -p "$service_home/unexpected-tunnel-mount"
create_bind_tunnel_fixture --network codexia --publish 127.0.0.1:2000:2000/tcp --volume "$service_home/unexpected-tunnel-mount:/run/secrets/token:ro"
expect_tunnel_drift_rejection
podman rm codexia-tunnel >/dev/null
create_tunnel_fixture --network codexia --publish 127.0.0.1:2000:2000/tcp --volume "$service_home/unexpected-tunnel-mount:/unexpected:ro"
expect_tunnel_drift_rejection
podman rm codexia-tunnel >/dev/null
create_tunnel_fixture --network codexia --publish 127.0.0.1:2000:2000/tcp
verify_tunnel > "$tmp/tunnel-runtime-canonical.log" || { cat "$tmp/tunnel-runtime-canonical.log"; exit 1; }
podman rm codexia-tunnel >/dev/null
as_service rmdir "$service_home/unexpected-tunnel-mount"

# Loading the generated Tunnel unit must not start the Tunnel during base convergence.
systemctl --user daemon-reload
rc=0; systemctl --user is-active codexia-tunnel.service >/dev/null 2>&1 || rc=$?
test "$rc" != 0
rc=0; podman container exists codexia-tunnel || rc=$?
test "$rc" = 1
test "$(podman inspect --format '{{json .HostConfig.PortBindings}}' codexia-db | jq -c 'if . == null then {} else . end')" = '{}'

legacy_requires=$(systemctl --user show --property=Requires --value codexia-tunnel.service)
legacy_after=$(systemctl --user show --property=After --value codexia-tunnel.service)
case " $legacy_requires " in *' codexia-api.service '*) ;; *) echo 'Tunnel did not require the legacy API unit' >&2; exit 1;; esac
case " $legacy_after " in *' codexia-api.service '*) ;; *) echo 'Tunnel was not ordered after the legacy API unit' >&2; exit 1;; esac
case " $legacy_after " in *' network-online.target '*) ;; *) echo 'Tunnel lost network-online ordering' >&2; exit 1;; esac

# Simulate initdb interruption after the role transaction rolled back: the
# empty database remains, the role is absent, and a repeat base apply repairs it
# from the same protected secret without replacing the volume.
podman exec codexia-db psql -X -v ON_ERROR_STOP=1 -U codexia_admin -d codexia -c 'ALTER SCHEMA public OWNER TO codexia_admin' >/dev/null
podman exec codexia-db psql -X -v ON_ERROR_STOP=1 -U codexia_admin -d postgres -c 'ALTER DATABASE codexia OWNER TO codexia_admin; DROP ROLE codexia' >/dev/null
apply_base > "$tmp/init-recovery.log" || { cat "$tmp/init-recovery.log"; exit 1; }
test "$(podman exec codexia-db psql -X -qAt -U codexia_admin -d postgres -c "SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname='codexia'")" = codexia

# Apply the repository's exact migration set so later convergence proves a
# real schema adoption instead of accepting an untracked application database.
migration_sql="$tmp/migrations.sql"
{
  cat <<'SQL'
\set ON_ERROR_STOP on
BEGIN;
SELECT pg_advisory_xact_lock(hashtext('codexia.persistence.migrations'));
CREATE TABLE codexia_schema_migrations (
  version text PRIMARY KEY,
  checksum char(64) NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$'),
  applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
SQL
  while IFS= read -r migration; do
    version=$(basename "$migration")
    checksum=$(sha256sum "$migration" | cut -d' ' -f1)
    cat "$migration"
    printf "\nINSERT INTO codexia_schema_migrations(version, checksum) VALUES ('%s', '%s');\n" "$version" "$checksum"
  done < <(find "$repo_root/packages/persistence-postgres/migrations" -maxdepth 1 -type f -name '*.sql' | sort)
  printf '\nCOMMIT;\n'
} > "$migration_sql"
podman exec -i codexia-db psql -X -v ON_ERROR_STOP=1 -U codexia_admin -d codexia < "$migration_sql" >/dev/null
apply_base > "$tmp/schema-adoption.log" || { cat "$tmp/schema-adoption.log"; exit 1; }
grep -q 'changed=0' "$tmp/schema-adoption.log"

podman exec codexia-db sh -ec 'export PGPASSWORD="$(cat /run/secrets/app-password)"; psql -X -v ON_ERROR_STOP=1 -h 127.0.0.1 -U codexia -d codexia -c "CREATE TABLE public.phase_b_adoption_probe(id integer PRIMARY KEY, value text NOT NULL); INSERT INTO public.phase_b_adoption_probe VALUES (1, '\''preserved-data'\'');"' >/dev/null

preflight_password=$(printf '%064d' 3)
cat > "$tmp/preflight.yml" <<YAML
- hosts: localhost
  connection: local
  gather_facts: false
  become: true
  become_user: $service_user
  environment:
    HOME: "$service_home"
    XDG_CONFIG_HOME: "$service_home/.config"
    XDG_RUNTIME_DIR: "/run/user/$service_uid"
    DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/$service_uid/bus"
  vars:
    ansible_python_interpreter: /usr/bin/python3
    repo_root: "$repo_root"
    codexia_preflight_password: "$preflight_password"
    preflight_verify_only: false
  tasks:
    - ansible.builtin.include_tasks: "$repo_root/deploy/ansible/preflight.yml"
YAML
apply_preflight() {
  "${ANSIBLE_PLAYBOOK:-ansible-playbook}" -i localhost, "$tmp/preflight.yml" "$@"
}
apply_preflight > "$tmp/preflight-first.log" || { cat "$tmp/preflight-first.log"; exit 1; }
grep -Eq 'changed=[1-9]' "$tmp/preflight-first.log"
apply_preflight > "$tmp/preflight-second.log" || { cat "$tmp/preflight-second.log"; exit 1; }
grep -q 'changed=0' "$tmp/preflight-second.log"
apply_preflight -e preflight_verify_only=true > "$tmp/preflight-verify.log" || { cat "$tmp/preflight-verify.log"; exit 1; }
grep -q 'changed=0' "$tmp/preflight-verify.log"
test "$(printf '%s\n' "$preflight_password" | podman exec -i codexia-db sh -ec 'IFS= read -r PGPASSWORD; export PGPASSWORD; exec psql -X -qAt -h 127.0.0.1 -U codexia_preflight -d codexia -c "SELECT current_user || chr(58) || current_setting('\''default_transaction_read_only'\'')"')" = 'codexia_preflight:on'
test "$(printf '%s\n' "$preflight_password" | podman exec -i codexia-db sh -ec 'IFS= read -r PGPASSWORD; export PGPASSWORD; exec psql -X -qAt -h 127.0.0.1 -U codexia_preflight -d codexia -c "SELECT value FROM public.phase_b_adoption_probe WHERE id=1"')" = preserved-data
if printf '%s\n' "$preflight_password" | podman exec -i codexia-db sh -ec 'IFS= read -r PGPASSWORD; export PGPASSWORD; exec psql -X -v ON_ERROR_STOP=1 -h 127.0.0.1 -U codexia_preflight -d codexia -c "INSERT INTO public.phase_b_adoption_probe VALUES (2, '\''forbidden'\'')"' > "$tmp/preflight-write.log" 2>&1; then
  echo 'The preflight role unexpectedly wrote to the persistent database' >&2
  exit 1
fi

# A role privilege mismatch must fail verification without silently repairing it.
podman exec codexia-db psql -X -v ON_ERROR_STOP=1 -U codexia_admin -d codexia -c 'ALTER ROLE codexia WITH SUPERUSER' >/dev/null
if apply_base > "$tmp/role-mismatch.log" 2>&1; then
  echo 'Base verification accepted a superuser application role' >&2
  exit 1
fi
test "$(podman exec codexia-db psql -X -qAt -U codexia_admin -d codexia -c "SELECT rolsuper FROM pg_roles WHERE rolname='codexia'")" = t
podman exec codexia-db psql -X -v ON_ERROR_STOP=1 -U codexia_admin -d codexia -c 'ALTER ROLE codexia WITH NOSUPERUSER' >/dev/null
apply_base > "$tmp/role-restored.log" || { cat "$tmp/role-restored.log"; exit 1; }

# A schema checksum mismatch is detected and left untouched for operator repair.
first_migration=$(find "$repo_root/packages/persistence-postgres/migrations" -maxdepth 1 -type f -name '*.sql' | sort | head -1)
first_version=$(basename "$first_migration")
first_checksum=$(sha256sum "$first_migration" | cut -d' ' -f1)
podman exec codexia-db psql -X -v ON_ERROR_STOP=1 -U codexia_admin -d codexia -c "UPDATE codexia_schema_migrations SET checksum=repeat('0',64) WHERE version='$first_version'" >/dev/null
if apply_base > "$tmp/schema-mismatch.log" 2>&1; then
  echo 'Base verification accepted schema migration drift' >&2
  exit 1
fi
grep -q 'PostgreSQL schema migration ledger differs from the packaged release' "$tmp/schema-mismatch.log"
test "$(podman exec codexia-db psql -X -qAt -U codexia_admin -d codexia -c "SELECT checksum FROM codexia_schema_migrations WHERE version='$first_version'")" = "$(printf '%064d' 0)"
podman exec codexia-db psql -X -v ON_ERROR_STOP=1 -U codexia_admin -d codexia -c "UPDATE codexia_schema_migrations SET checksum='$first_checksum' WHERE version='$first_version'" >/dev/null
apply_base > "$tmp/schema-restored.log" || { cat "$tmp/schema-restored.log"; exit 1; }

# Killing the connection after CREATE ROLE but before the following statement
# rolls back the role. The canonical initializer keeps these effects in one txn.
interrupted_role=codexia_phase_b_interrupted
if podman exec codexia-db psql -X -v ON_ERROR_STOP=1 -U codexia_admin -d codexia -c "BEGIN; CREATE ROLE $interrupted_role LOGIN; SELECT pg_terminate_backend(pg_backend_pid()); ALTER DATABASE codexia OWNER TO $interrupted_role; COMMIT" > "$tmp/init-interrupted.log" 2>&1; then
  echo 'Database interruption fixture unexpectedly completed' >&2
  exit 1
fi
test "$(podman exec codexia-db psql -X -qAt -U codexia_admin -d codexia -c "SELECT count(*) FROM pg_roles WHERE rolname='$interrupted_role'")" = 0
test "$(podman exec codexia-db psql -X -qAt -U codexia_admin -d codexia -c "SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname='codexia'")" = codexia

# Stop and remove only this disposable container while retaining the exact named volume.
volume_created=$(podman volume inspect --format '{{.CreatedAt}}|{{.Mountpoint}}' codexia-postgres)
systemctl --user stop codexia-db.service
if podman container exists codexia-db; then
  test "$(podman inspect --format '{{.State.Running}}' codexia-db)" = false
  podman rm codexia-db >/dev/null
fi
systemctl --user reset-failed codexia-db.service >/dev/null 2>&1 || true
apply_base > "$tmp/adopt.log" || { cat "$tmp/adopt.log"; exit 1; }
test "$(podman volume inspect --format '{{.CreatedAt}}|{{.Mountpoint}}' codexia-postgres)" = "$volume_created"
test "$(podman exec codexia-db sh -ec 'export PGPASSWORD="$(cat /run/secrets/app-password)"; psql -X -qAt -h 127.0.0.1 -U codexia -d codexia -c "SELECT value FROM public.phase_b_adoption_probe WHERE id=1"')" = preserved-data

# A major-version mismatch must fail before a new database process can touch that volume.
mountpoint=${volume_created#*|}
systemctl --user stop codexia-db.service
if podman container exists codexia-db; then
  test "$(podman inspect --format '{{.State.Running}}' codexia-db)" = false
  podman rm codexia-db >/dev/null
fi
systemctl --user reset-failed codexia-db.service >/dev/null 2>&1 || true
podman unshare sh -ec 'printf "16\n" > "$1/pgdata/PG_VERSION"' sh "$mountpoint"
if apply_base > "$tmp/major-mismatch.log" 2>&1; then
  echo 'Base convergence accepted a PostgreSQL major-version mismatch' >&2
  exit 1
fi
rc=0; podman container exists codexia-db || rc=$?
test "$rc" = 1
rc=0; systemctl --user is-active codexia-db.service >/dev/null 2>&1 || rc=$?
test "$rc" != 0
test "$(podman unshare cat "$mountpoint/pgdata/PG_VERSION")" = 16

switch_playbook="$tmp/switch-tunnel.yml"
cat > "$switch_playbook" <<YAML
- hosts: localhost
  connection: local
  gather_facts: false
  vars:
    ansible_python_interpreter: /usr/bin/python3
    quadlet_dir: "$quadlet_dir"
  tasks:
    - ansible.builtin.include_tasks: "$repo_root/deploy/ansible/switch-tunnel-to-proxy.yml"
YAML
"${ANSIBLE_PLAYBOOK:-ansible-playbook}" -i localhost, "$switch_playbook" > "$tmp/switch-tunnel.log" || { cat "$tmp/switch-tunnel.log"; exit 1; }
systemctl --user daemon-reload
proxy_requires=$(systemctl --user show --property=Requires --value codexia-tunnel.service)
proxy_after=$(systemctl --user show --property=After --value codexia-tunnel.service)
case " $proxy_requires " in *' codexia-api-proxy.service '*) ;; *) echo 'Tunnel did not switch to the private proxy dependency' >&2; exit 1;; esac
case " $proxy_requires " in *' codexia-api.service '*) echo 'Tunnel retained the legacy writer dependency' >&2; exit 1;; esac
case " $proxy_after " in *' codexia-api-proxy.service '*) ;; *) echo 'Tunnel was not ordered after the private proxy' >&2; exit 1;; esac
case " $proxy_after " in *' network-online.target '*) ;; *) echo 'Tunnel lost network-online ordering during switch' >&2; exit 1;; esac
rc=0; systemctl --user is-active codexia-tunnel.service >/dev/null 2>&1 || rc=$?
test "$rc" != 0
rc=0; podman container exists codexia-tunnel || rc=$?
test "$rc" = 1
if "${ANSIBLE_PLAYBOOK:-ansible-playbook}" -i localhost, "$switch_playbook" > "$tmp/switch-repeat.log" 2>&1; then
  echo 'Tunnel dependency switch accepted an already switched or unexpected state' >&2
  exit 1
fi

for secret in fixture-auth-token fixture-tunnel-token "$(printf '%064d' 1)" "$(printf '%064d' 2)" "$preflight_password"; do
  if grep -Fq "$secret" "$tmp"/*.log; then
    echo 'A database credential appeared in an Ansible or test log' >&2
    exit 1
  fi
done

printf '%s\n' 'Verified rootless Quadlet convergence, fresh PostgreSQL init, no-change repeat, data adoption, mismatch denial, pinned roles, private networks, no DB ports, and controlled legacy/proxy Tunnel dependency.'
