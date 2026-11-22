# Push deployment

The backend release workflow publishes Core and Full images by immutable OCI digest and emits certificates bound to successful exact-main verification, the producer artifact and inspected image identities. A separate read-only handoff workflow rechecks the backend publication, artifact receipt and both images before exposing deployment inputs. The production job then checks the live UI/API epoch and Access boundary, connects to the `yohnark.github` tailnet using GitHub OIDC, checks the pinned SSH host key for `100.100.1.68`, and runs Ansible as `codexia`. Cloudflare Tunnel remains the application ingress; it is not used for VM management.

The deployment job is gated by the `CODEXIA_PUSH_DEPLOYMENT_ENABLED` variable in the `codexia-production` GitHub Environment. Keep the value unset or set it to `false` until the service identity, data, secrets, backup destination and rollback path have passed target-host acceptance. The push path is the sole backend activation path.

## Protected inputs

Configure these names in the `codexia-production` GitHub Environment. Never put a private key or credential in the repository.

| Name | GitHub type | Purpose |
| --- | --- | --- |
| `TS_OAUTH_CLIENT_ID` | Secret | Existing Tailscale GitHub OIDC client. |
| `CODEXIA_PUBLIC_ORIGIN` | Variable | HTTPS origin used by the production job to check the deployed UI/API epoch and Access boundary. |
| `CODEXIA_ACCESS_CLIENT_ID` | Secret | Existing Cloudflare Access service-token ID used by the read-only live compatibility preflight. |
| `CODEXIA_ACCESS_CLIENT_SECRET` | Secret | Existing Cloudflare Access service-token secret used by the read-only live compatibility preflight. |
| `CODEXIA_DEPLOY_SSH_PRIVATE_KEY` | Secret | Dedicated Ed25519 key used only by the production deployment job. Install its public key for the `codexia` account on the VM through the approved host channel. |
| `CODEXIA_DEPLOY_SSH_KNOWN_HOSTS` | Variable | Independently verified `known_hosts` line for `100.100.1.68`; the runner rejects an unpinned host. |
| `CODEXIA_BACKUP_DESTINATION` | Variable | Existing absolute mount directory on the VM for encrypted off-VM backups. |
| `CODEXIA_BACKUP_AGE_RECIPIENT` | Variable | Public age recipient used to encrypt backup artifacts. |
| `CODEXIA_INITIAL_INSTALL_APPROVED` | Variable | Exact `true` authorizes activation when no API container exists; default is `false`. |
| `CODEXIA_DATABASE_INITIALIZATION_APPROVED` | Variable | Exact `true` records explicit approval to use the initialized database and, on first activation only, initialize a pristine schema; default is `false`. |
| `CODEXIA_AUTH_MODE` | Variable | `token` (default) keeps current standalone token auth. `better-auth` selects the separately staged Better Auth runtime. |
| `CODEXIA_BETTER_AUTH_ACTIVATION_APPROVED` | Variable | Exact `true` authorizes only a healthy token-to-Better-Auth transition; default is `false`. It is not required for an already active Better Auth update. |
| `CODEXIA_PUSH_DEPLOYMENT_ENABLED` | Variable | Set to the exact string `true` only after the production cutover is accepted. |

The private age identity used for restore verification stays on a separate recovery host. The deployment workflow neither reads nor transmits it. Do not add a decryption identity to the production Environment.

## Deployment contract

The production job runs only after the read-only handoff workflow verifies a successful main `Verify Codexia` run, the corresponding backend publication, and the certified Full digest and deployment certificate. It consumes the handoff job outputs; it does not resolve a tag or build a second image. Pull request validation and the handoff verifier have no production Environment and cannot mint a Tailscale OIDC identity.

The Ansible `deploy` stage requires a running, healthy Full API under the `codexia` rootless account. It verifies that the certificate identity matches the exact image digest and requires the candidate's migration fingerprint, API epoch and persistence format to equal the running image and deployed UI. Its Quadlet disables startup schema migration. A database change requires a separately reviewed database maintenance and backup operation; replacing a container does not restore or roll back PostgreSQL.

Before stopping the API, Ansible verifies that the configured backup directory is an existing remote filesystem. It then holds the host lock while it stops the application Tunnel and API, creates and validates an encrypted database/history backup, installs the digest-specific Quadlet, starts the candidate, and waits for readiness. Backup admission requires the API and Tunnel systemd units to be inactive and the API container to be stopped; it verifies ownership of the inherited host lock. If startup or readiness fails, Ansible restores the prior Quadlet and checks that the healthy running image matches the recorded prior digest before returning failure. A durable transaction record lets the next invocation recover the prior release if the runner or SSH connection disappears mid-deploy. Recovery leaves its record in place and keeps the Tunnel stopped if it cannot verify both prior health and image identity. A repeated application of the running digest verifies service health and performs no image switch.

The API and Tunnel receive systemd user activation links so the Quadlet services return after a VM reboot. The API depends on the database unit; the Tunnel starts only after the API is healthy. The management connection remains available through Tailscale and SSH even if either application unit fails.

## First application activation

First activation uses the existing Ansible stages in order; it does not create or move data automatically. From the approved bootstrap account, inspect the host, converge `host`, install reviewed credentials with `secrets`, then converge `base`. For an absent or empty PostgreSQL volume, set both `codexia_base_approved=true` and `codexia_database_initialization_approved=true` for the `base` invocation. For an existing volume, `base` adopts it only after its pinned PostgreSQL identity, volume layout, database owner, and migration ledger pass the existing checks. It never deletes the volume or repairs an unrecognized database.

Do not run `auth-runtime` before initializing the application schema on a pristine database. The `codexia_auth` namespace is an additional database object, so the fail-closed fresh-schema initializer will reject that database. First activate the current token-authenticated API through `deploy` as described below. **Only after successful first activation**, an independently approved `auth-runtime` stage may provision Better Auth's separate role, schema and protected secrets (`codexia_auth_runtime_approved=true`; see [AUTH-RUNTIME](../../deploy/ansible/AUTH-RUNTIME.md)). It does not run migrations or activate the API.

After token activation, follow the [isolated Better Auth registration procedure](../../deploy/ansible/AUTH-RUNTIME.md#initial-owner-and-oauth-client-registration). It provisions the auth role and schema and registers the approved Web, iOS, and confidential introspection clients through an authenticated Better Auth session. Finish staging the resulting internal owner ID before selecting Better Auth in the protected workflow.

Set `CODEXIA_AUTH_MODE=better-auth` and `CODEXIA_BETTER_AUTH_ACTIVATION_APPROVED=true` for the transition from a healthy token deployment. Ansible verifies the staged private settings and four rootless Podman secrets, takes the encrypted backup, converges the auth schema, and verifies the owner, the registered clients, their API resources, and the introspection credentials before installing the candidate. The API repeats the client and credential checks on startup. After the transition succeeds, clear the approval and keep `CODEXIA_AUTH_MODE=better-auth` for future compatible updates.

The active Quadlet references a private settings file named by its SHA-256. The release record includes the digest and mode. A failed candidate restores the prior Quadlet and release record, so the old image reopens its original settings and the same persistent PostgreSQL schema and signing keys. Compatible updates verify the existing registrations without rerunning migrations. Missing settings, implicit token fallback, and downgrade attempts are rejected.

Run the first API activation through the protected production workflow as the `codexia` service identity with the certified Full digest, the matching certificate and deployed UI epoch, the approved off-VM backup destination, and both GitHub Environment variables `CODEXIA_INITIAL_INSTALL_APPROVED=true` and `CODEXIA_DATABASE_INITIALIZATION_APPROVED=true`. They default to `false`; set them only for the approved first activation and return them to `false` after success. Keep them true for a retry only when the first activation did not complete, after inspecting the durable transaction and database. The second approval is required even when adopting an existing database: it records that the operator verified the database to be used. After backup admission and before starting the API, `deploy` runs the candidate image's `initializeFreshPostgresSchema` helper on the internal database network. It creates the canonical migration ledger only for a pristine database, accepts an exact ledger idempotently, and fails closed on untracked objects or a partial or mismatched ledger. No schema is initialized if an API container already exists. `deploy` refuses an existing API container without a canonical unit, and refuses a unit left behind without its container. Keep the API Tunnel stopped until the candidate passes health checks. Reapplying that same digest verifies health and makes no image switch.

The CI lifecycle fixture tests the Ansible stages only against disposable resources. Its result does not establish that a production VM's existing data is safe to adopt; inspect it and retain an independent backup first. Use the [host bootstrap acceptance](PUSH-HOST-CI.md) as host-stage evidence only.

## Database and schema maintenance boundary

After initial schema creation, image-only `deploy` supports only an unchanged migration fingerprint, API epoch, and persistence format. Schema or persistence changes to a nonempty installation are currently unsupported by the production push workflow. Do not bypass admission or enable startup migrations to apply one. The owning migration change needs an independently reviewed and explicitly approved procedure that defines a pre-change encrypted backup, migration execution and verification, and a tested restore path. The current isolated restore drill verifies a backup copy but does not run a schema migration or restore PostgreSQL roles and Podman secrets. Until that procedure exists and is accepted, keep the candidate blocked and do not treat application rollback as database rollback.

## Acceptance order

The current production job is an image-update path, not a fresh VM initializer. Before enabling it, the target needs the `codexia` account, rootless Podman and user systemd, canonical database and Tunnel resources, protected Podman secrets, the dedicated SSH key, a pinned host key, and a mounted off-VM backup destination. The separately approved first `deploy` activation creates the application schema only in the pristine `codexia` database or verifies an exact migration ledger. Do not point the job at the existing `sophia` storage or remove that account's data as part of account creation.

Acceptance must record separate evidence for CI certification and VM behavior. On the target, verify Tailscale SSH, first deployment from a clean `codexia` runtime with preserved or explicitly restored data, same-digest reapplication, a compatible update, a deliberately failing candidate and verified restoration, host-lock contention, service recovery after reboot, encrypted backup and isolated restore, and external application health through Cloudflare Tunnel.
