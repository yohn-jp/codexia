# Codexia PostgreSQL-only deployment

This runbook describes **the replacement PostgreSQL runtime**, not the retired Git/Core Hosted product. Deployment is split between Cloudflare Workers Static Assets and a private VM running a Node API plus PostgreSQL 17. A successful build or Worker upload does not prove the hostname or API is live.

## Network and authority

```text
Browser -> Cloudflare Access -> Worker Route -> codexia-frontend static assets
                             -> /api/* via Tunnel -> codexia-api -> codexia-db
```

The application uses same-origin `/api/*` requests. Cloudflare Access is the outer identity gate; the API separately authenticates the author using `CODEXIA_AUTH_TOKEN` and an HttpOnly session cookie. The Worker never proxies `/api/*`, stores no manuscript state, and has no database binding. PostgreSQL is the sole canonical manuscript writer. No Git repository, local clone, GitHub token, `CoreStore` or legacy hosted runtime is needed.

`deploy/cloudflare/ui-routes.json` defines Worker-only routes. Terraform under `deploy/cloudflare/terraform/` manages the Access application, DNS CNAME, Tunnel and optional routes. Frontend routes are disabled until `frontend_route_enabled` is explicitly configured. Never infer a configured custom domain or working API from the existence of the Worker script.

## VM provisioning

Use a rootless Podman service account, permanent volumes and the deployment files in `deploy/quadlet/`. The relevant units are `codexia-db.service`, `codexia-api.service` and `codexia-tunnel.service`; the API connects to DB on the internal-only `codexia-data` network, while the Tunnel can reach only the API's ordinary private network.

Before the first PostgreSQL start, install `deploy/postgres/010-create-app-role.sh` as `/etc/codexia/postgres/010-create-app-role.sh` so the official PostgreSQL entrypoint initializes the restricted application role. Create protected rootless Podman secrets:

- `codexia-postgres-admin-password`: PostgreSQL initialization superuser secret
- `codexia-postgres-app-password`: hexadecimal application role secret; API receives only this password
- `codexia-auth-token`: randomly generated author token of at least 32 characters
- `codexia-tunnel-token`: Cloudflare Tunnel enrollment secret

Use distinct 32-byte hexadecimal database passwords. The Quadlet binds the files to `/run/secrets`; `deploy/backend/start.sh` reads the API secret and builds a private `CODEXIA_DATABASE_URL`. Do not place secrets in Quadlet text, Git, image layers, Worker variables or CI logs. Production configuration requires `CODEXIA_DATABASE_MIGRATE_ON_START=1` only when its application role is explicitly allowed to apply the checksum-verified migrations.

Install the Quadlet files in the rootless service user's `~/.config/containers/systemd/`, enable user lingering and run `systemctl --user daemon-reload` before starting the DB, API and Tunnel units. Keep the API and database without published host ports. The API container is nonroot and read-only, with writable temporary storage explicitly mounted. It is not coupled to a filesystem Git writer.

Health checks: `/health/startup`, `/health/live`, `/health/ready` and `/api/ready`; readiness fails when PostgreSQL cannot answer a health query. The origin must be secured behind the trusted TLS-terminating Tunnel and Access policy. `CODEXIA_TRUST_PROXY=1` is only valid for that trusted boundary.

## Release gating

The UI job builds the Vite app for root, Desktop and Mobile, checks Worker routes, and uploads only static assets. The backend job builds and tests an immutable, commit-addressed GHCR image. Both publishing steps require a **successful exact-source main verification** via `scripts/verify-release-source.mjs`; a PR build never deploys production.

The UI and backend release independently; an image publication does **not** automatically update VM Quadlet digests. The VM operator must explicitly deploy the verified digest and check database readiness and a real authenticated read/write before exposing the new UI. Cloudflare/Terraform routes remain separately managed and must be enabled only when the origin is operational. Do not publish a new interface that has no compatible API.

## Backup and restoration

A portable Markdown export is **not** a database backup and no complete portable exporter is claimed to exist here. The operator must take consistent full-database `pg_dump -Fc` backups, encrypt them, store copies off-VM and maintain a tested retention schedule. Back up any authoritative binary assets at a coordinated point. For point-in-time restore, retain WAL according to the actual RPO; a logical dump alone cannot provide arbitrary PITR.

```sh
# Example: write a logical archive on the trusted VM. Protect and encrypt it immediately.
podman exec codexia-db pg_dump -U codexia_admin -d codexia -Fc > codexia.dump
```

Test restoration into an **isolated replacement database**, never directly over a live production instance. Restore the dump and matching authoritative assets, verify migrations and record counts, hash representative immutable Markdown revisions, inspect Knowledge/Evidence relations, and exercise both authenticated read and write before declaring a usable recovery point. Record actual restore results outside the product documentation. Do not include API/DB credentials in a project archive or public artifact.

Browser IndexedDB draft journals are client-local. They are never included in `pg_dump`; explain this distinction when making a recovery guarantee. Existing Git-managed manuscripts are not migrated automatically.

## Limits

The deprecated `CODEXIA_HOSTED_MODE=1` Git-hosted runtime is unsupported by the replacement server. The ModuleRuntime/Story/Assistant/Search and other old Git-based capabilities have not been converted just because their old source was removed. A fully operational release requires their explicit PostgreSQL-native acceptance or a clear decision not to support them.
