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
| `CODEXIA_PUSH_DEPLOYMENT_ENABLED` | Variable | Set to the exact string `true` only after the production cutover is accepted. |

The private age identity used for restore verification stays on a separate recovery host. The deployment workflow neither reads nor transmits it. Do not add a decryption identity to the production Environment.

## Deployment contract

The production job runs only after the read-only handoff workflow verifies a successful main `Verify Codexia` run, the corresponding backend publication, and the certified Full digest and deployment certificate. It consumes the handoff job outputs; it does not resolve a tag or build a second image. Pull request validation and the handoff verifier have no production Environment and cannot mint a Tailscale OIDC identity.

The Ansible `deploy` stage requires a running, healthy Full API under the `codexia` rootless account. It verifies that the certificate identity matches the exact image digest and requires the candidate's migration fingerprint, API epoch and persistence format to equal the running image and deployed UI. Its Quadlet disables startup schema migration. A database change requires a separately reviewed database maintenance and backup operation; replacing a container does not restore or roll back PostgreSQL.

Before stopping the API, Ansible verifies that the configured backup directory is an existing remote filesystem. It then holds the host lock while it stops the application Tunnel and API, creates and validates an encrypted database/history backup, installs the digest-specific Quadlet, starts the candidate, and waits for readiness. Backup admission requires the API and Tunnel systemd units to be inactive and the API container to be stopped; it verifies ownership of the inherited host lock. If startup or readiness fails, Ansible restores the prior Quadlet and checks that the healthy running image matches the recorded prior digest before returning failure. A durable transaction record lets the next invocation recover the prior release if the runner or SSH connection disappears mid-deploy. Recovery leaves its record in place and keeps the Tunnel stopped if it cannot verify both prior health and image identity. A repeated application of the running digest verifies service health and performs no image switch.

The API and Tunnel receive systemd user activation links so the Quadlet services return after a VM reboot. The API depends on the database unit; the Tunnel starts only after the API is healthy. The management connection remains available through Tailscale and SSH even if either application unit fails.

## Acceptance order

The current production job is an image-update path, not a fresh VM initializer. Before enabling it, the target needs the `codexia` account, rootless Podman and user systemd, canonical database and Tunnel resources, protected Podman secrets, an initialized and verified database, the dedicated SSH key, a pinned host key, and a mounted off-VM backup destination. Do not point the job at the existing `sophia` storage or remove that account's data as part of account creation.

Acceptance must record separate evidence for CI certification and VM behavior. On the target, verify Tailscale SSH, first deployment from a clean `codexia` runtime with preserved or explicitly restored data, same-digest reapplication, a compatible update, a deliberately failing candidate and verified restoration, host-lock contention, service recovery after reboot, encrypted backup and isolated restore, and external application health through Cloudflare Tunnel.
