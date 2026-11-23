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
| `CODEXIA_BACKUP_DESTINATION` | Variable | Absolute directory for encrypted backups; defaults to `/home/codexia/backups` (created with mode 0700). Remote storage is optional. |
| `CODEXIA_BACKUP_AGE_RECIPIENT` | Variable | Public age recipient used to encrypt backup artifacts. |
| `CODEXIA_INITIAL_INSTALL_APPROVED` | Variable | Exact `true` authorizes activation when no API container exists; default is `false`. |
| `CODEXIA_DATABASE_INITIALIZATION_APPROVED` | Variable | Exact `true` records explicit approval to use the initialized database for first activation; default is `false`. |
| `CODEXIA_PUSH_DEPLOYMENT_ENABLED` | Variable | Set to the exact string `true` only after the production cutover is accepted. |

The private age identity used for restore verification stays on a separate recovery host. The deployment workflow neither reads nor transmits it. Do not add a decryption identity to the production Environment.

## Deployment contract

The production job runs only after the read-only handoff workflow verifies a successful main `Verify Codexia` run, the corresponding backend publication, and the certified Full digest and deployment certificate. It consumes the handoff job outputs; it does not resolve a tag or build a second image. Pull request validation and the handoff verifier have no production Environment and cannot mint a Tailscale OIDC identity.

For an image-only update, the Ansible `deploy` stage requires a running, healthy Full API under the `codexia` rootless account. First activation is the explicit exception: with both first-install and database-use approvals, it may start only when no API container exists, and it verifies the exact application migration ledger from the certified Full image. For either path, Ansible verifies that the certificate identity matches the exact image digest; updates must retain the running image's migration fingerprint, API epoch and persistence format, and the candidate must match the deployed UI epoch. The Quadlet disables startup schema migration. A database change requires a separately reviewed database maintenance and backup operation; replacing a container does not restore or roll back PostgreSQL.

Before stopping the API, Ansible creates or verifies a private backup directory on the VM. Local filesystems and remote mounts are supported; remote mounts retain their host-identity validation. It then holds the host lock while it stops the application Tunnel and API, creates and validates an encrypted database/history backup, installs the digest-specific Quadlet, starts the candidate, and waits for readiness. Backup admission requires the API and Tunnel systemd units to be inactive and the API container to be stopped; it verifies ownership of the inherited host lock. If startup or readiness fails, Ansible restores the prior Quadlet and checks that the healthy running image matches the recorded prior digest before returning failure. A durable transaction record lets the next invocation recover the prior release if the runner or SSH connection disappears mid-deploy. Recovery leaves its record in place and keeps the Tunnel stopped if it cannot verify both prior health and image identity. A repeated application of the running digest verifies service health and performs no image switch.

The API and Tunnel receive systemd user activation links so the Quadlet services return after a VM reboot. The API depends on the database unit; the Tunnel starts only after the API is healthy. The management connection remains available through Tailscale and SSH even if either application unit fails.

## Disposable app lifecycle CI

The [push-app-lifecycle workflow](../../.github/workflows/push-app-lifecycle.yml) runs manually and on pull requests that change backend image inputs, deployment tasks, backup code, Quadlets or their contracts. It uses an Ubuntu 26.04 GitHub-hosted runner without a production Environment. It checks the exact-source Full OCI artifact and prefers a publication-certified Better Auth update with the same migration fingerprint, API epoch and persistence format. Otherwise the fixture updates to a distinct test-only Full digest built from the exact-source artifact with the same source identity and application layers. A certified pre-cutover image serves as a network-isolated credential-refusal control. If its publication proof cannot be verified, the report marks the historical control `NOT_CHECKED`. The report records each image role and the actual update result separately.

The fixture runs `site.yml` through `host`, `secrets`, `base` and a separate `deploy-lifecycle-fixture` stage. That stage verifies run-bound image evidence, then includes the same `deploy-transaction.yml` used by production `deploy`; the production certificate and installed-image admission remain required by the production stage. The workflow observes first schema initialization, same-digest reapplication, compatible image update, failed-candidate rollback, interrupted-transaction recovery, PostgreSQL data and volume identity, API writer count, Quadlet and release record, and health readiness. It removes the newly installed Tunnel Quadlet only in the disposable fixture before deployment, so no Cloudflare connection or real Tunnel credential is used. It saves a run-bound outcome artifact and bounded redacted logs, then checks fixture cleanup.

With a synthetic OIDC provider, the fixture registers the owner and clients, activates Better Auth, and verifies that the owner session, signing keys and auth schema survive same-digest reapplication, a compatible update and rollback of a failed candidate.

The backup fixture mounts an SSHFS export served by a separate container on the same temporary runner. The real backup helper still checks for a remote filesystem, creates the encrypted archive under its normal lock, and validates the published checksum manifest. The runner and SSHFS server share a host. Production recovery requires a restore on an independent host.

## First application activation

First activation uses the existing Ansible stages in order; it does not create or move data automatically. From the approved bootstrap account, inspect the host, converge `host`, install reviewed credentials with `secrets`, then converge `base`. For an absent or empty PostgreSQL volume, set both `codexia_base_approved=true` and `codexia_database_initialization_approved=true` for the `base` invocation. For an existing volume, `base` adopts it only after its pinned PostgreSQL identity, volume layout, database owner, and migration ledger pass the existing checks. It never deletes the volume or repairs an unrecognized database.

Run `auth-runtime` before `deploy`. Provide `codexia_auth_runtime_approved=true` and review its private configuration. For a pristine database, stage the immutable reviewed Full image in rootless Podman and provide its reference as `codexia_auth_bootstrap_image` along with `codexia_database_initialization_approved=true`. Under the host lock, the stage initializes the application schema before creating the separate authentication role and schema. It leaves the public API stopped.

Follow the [isolated Better Auth registration procedure](../../deploy/ansible/AUTH-RUNTIME.md#initial-owner-and-oauth-client-registration). Register the approved Web, iOS and confidential introspection clients through an authenticated Better Auth session. Finish staging the resulting internal owner ID before calling the protected workflow.

Ansible verifies the staged private settings and protected Podman secrets, takes the encrypted backup, and verifies the owner, registered clients, API resources and introspection credentials before installing the candidate. The API repeats the client and credential checks on startup.

The active Better Auth Quadlet references a private settings file named by its SHA-256. Image-only updates and interrupted updates require a matching release record, Quadlet and settings file. If an earlier token-based deployment has a pending transaction, use the release that recorded it to recover under the approved procedure. The current deployment refuses that pending state before touching services or recovery files. Moving an older installation to the current release requires the coordinated maintenance procedure below.

Run the first API activation through the protected production workflow as the `codexia` service identity with the certified Full digest, the matching certificate and deployed UI epoch, the approved encrypted backup destination, and both GitHub Environment variables `CODEXIA_INITIAL_INSTALL_APPROVED=true` and `CODEXIA_DATABASE_INITIALIZATION_APPROVED=true`. They default to `false`; set them only for the approved first activation and return them to `false` after success. Keep them true for a retry only when the first activation did not complete, after inspecting the durable transaction and database. The second approval is required even when adopting an existing database: it records that the operator verified the database to be used. After backup admission and before starting the API, `deploy` verifies the exact application migration ledger using the certified image on the internal database network. A missing, partial or mismatched ledger blocks activation. `deploy` refuses an existing API container without a canonical unit, and refuses a unit left behind without its container. Keep the API Tunnel stopped until the candidate passes health checks. Reapplying that same digest verifies health and makes no image switch.

Inspect the target data and retain an independent backup before adopting an existing production VM. The [host bootstrap acceptance](PUSH-HOST-CI.md) covers the host stage. On the target, separately verify VM reboot, Cloudflare routing, sign-in through the configured identity provider, and recovery from the independent backup.

## Database and schema maintenance boundary

After initial schema creation, image-only `deploy` supports only an unchanged migration fingerprint, API epoch, and persistence format. The owning migration change needs an independently reviewed and explicitly approved procedure that defines a pre-change encrypted backup, migration execution and verification, and a tested restore path. The [isolated restore drill](BACKUP.md#rehearse-a-reviewed-full-candidate) can rehearse the one-time data conversion on a verified backup copy. PostgreSQL roles and Podman secrets require separate recovery. Production activation remains subject to the compatibility gates and the separately approved paired activation procedure below.

The exact certified image packages `node /app/node_modules/@codexia/api/dist/maintain-snapshot-projections.js --check`. Its read-only connection reports pending snapshot proofs, Publishing records and NLP feature settings. A pending result exits with status 2. During approved maintenance, keep ingress closed and stop the old writer under the host lock. Verify the encrypted backup before running the same command with `--apply` and the authorized writable connection. It converts Publishing records and NLP feature settings before reconciling snapshot proofs. Rerun `--check` and require exit 0. Keep ingress closed until the paired activation and its readiness, sign-in and publication checks are complete. Recovery to the earlier persistence format requires the approved pre-change database restore.

### One-time job history maintenance

Use the exact certified Full image and run the maintenance command as the API's UID 1000. Mount only the installation's `codexia-history` volume at `/history`, preserve its ownership, mode and labels, and disable container networking.

```sh
CODEXIA_USAGE_DIR=/history node /app/node_modules/@codexia/api/dist/maintain-job-history.js --check
```

Exit 0 means the history is already current or absent. Exit 2 means conversion is pending. Exit 1 means invalid history or a maintenance error and blocks activation. If conversion is pending, keep the old writer stopped under the host lock and verify the encrypted pre-change backup. Then run the following command with the same image, UID and scoped mount.

```sh
CODEXIA_USAGE_DIR=/history node /app/node_modules/@codexia/api/dist/maintain-job-history.js --apply
```

Run `--check` again and require exit 0. Complete the applicable PostgreSQL maintenance and its verification before paired activation.

On the [isolated recovery host](BACKUP.md#rehearse-a-reviewed-full-candidate), verify the check, apply and recheck sequence against a restored backup copy. If activation fails and the prior release cannot read the converted history, restore the history from the encrypted pre-change backup before restarting it. Restore the pre-change PostgreSQL backup when the prior release requires it.

## Coordinated API epoch cutover

The standalone OAuth cutover pairs the epoch 2 Full backend with the epoch 2 static frontend and moves installations on persistence format 1 to format 2. The normal frontend workflow requires an already compatible live backend. The backend workflow requires an already compatible live UI and refuses an epoch, persistence-format or migration-fingerprint change to an installed API. Neither workflow implements the public ingress fence, paired activation or cross-component recovery. Keep the ordinary gates in place and use a separately reviewed, explicitly approved maintenance plan for these operations. First-install approvals apply only to an absent API and must never be used to replace an existing installation.

**Pin and stage both releases.** Record the certified Full image digest and certificate, the verified frontend archive digest and producer identity, and the frontend's approved public OAuth configuration. Use the [existing artifact check](../../.github/workflows/frontend-release.yml) to verify the exact frontend archive before using its extracted `app/dist`. Retain the prior backend digest, private authentication configuration, frontend archive and active Worker version ID. From the verified checkout, a separately authorized production operator can use the pinned Wrangler with the existing Worker credentials. `deployments status` records the active version and traffic allocation. `versions upload` returns the candidate UUID without switching traffic.

```sh
npm ci --prefix edge/frontend
edge/frontend/node_modules/.bin/wrangler deployments status --json --config edge/frontend/wrangler.jsonc
edge/frontend/node_modules/.bin/wrangler versions upload --config edge/frontend/wrangler.jsonc
```

**Rehearse the conversion and recovery off the VM.** On the isolated recovery host, use the verified encrypted PostgreSQL and private history backup, the external recovery identity file and the exact Full image already loaded by digest. Set the shell variables below to those three reviewed inputs. Preserve the backup checksum-manifest digest, candidate image digest and successful [rehearsal receipt](BACKUP.md#rehearse-a-reviewed-full-candidate). Confirm recovery of the prior PostgreSQL roles, Podman secrets and authentication configuration separately.

```sh
bash deploy/backup/backup.sh drill "$backup_directory" "$recovery_identity_file" --approved \
  --candidate-full-image "$certified_full_image"
```

**Fence, quiesce and activate.** Pause both ordinary deployment paths. Have the zone owner fence the entire public application hostname, covering the static Worker and Tunnel routes, including any enabled OAuth/MCP paths that bypass the parent Access application. Allow only the exact GETs for `/api/version` and `/desktop/update-identity.json` under their existing Access policies and approved, restricted functional acceptance. Verify that ordinary traffic is blocked before stopping the writer. Under the host lock, stop the Tunnel and old writer and retain a verified encrypted pre-change backup off the VM. Complete the approved history and PostgreSQL maintenance with the certified image and require the applicable maintenance checks to return 0. Start the certified backend. Restore Tunnel connectivity behind the fence and switch the candidate Worker UUID to 100%. Verify the running backend digest and readiness on the host, both live Full/epoch 2 identities, the exact deployed frontend identity, owner sign-in, and the authorized and denied paths for the approved public configuration. Reopen ingress only after both components and their access controls pass.

**Keep the fence on failure.** Restore the retained Worker version to 100%, the prior backend digest and its authentication configuration, and the verified pre-change database and history when the prior release cannot read the converted state. Verify the restored identities, readiness, access controls and data before reopening ingress or resuming ordinary releases.

## Acceptance order

The production job operates on a pre-provisioned host. Before enabling it, the target needs the `codexia` account, rootless Podman and user systemd, canonical database and Tunnel resources, protected Podman secrets, the dedicated SSH key, a pinned host key, and a writable encrypted-backup directory. The approved `auth-runtime` stage initializes an empty application schema during provisioning. The first `deploy` activation, with both explicit approvals, verifies its exact migration ledger. Later `deploy` runs apply compatible image updates. Keep the existing `sophia` storage outside this workflow.

Acceptance must record separate evidence for CI certification and VM behavior. On the target, verify Tailscale SSH, first deployment from a clean `codexia` runtime with preserved or explicitly restored data, same-digest reapplication, a compatible update, a deliberately failing candidate and verified restoration, host-lock contention, service recovery after reboot, encrypted backup and isolated restore, and external application health through Cloudflare Tunnel.

## Backup destination policy

The deployment path accepts an encrypted local backup directory (default `/home/codexia/backups`) and does not require NFS/CIFS/SSHFS. Ansible creates the directory as the `codexia` service user with mode `0700`. The backup helper retains its age encryption, ciphertext checksums, quiesced writer and host-lock requirements. Remote filesystem destinations continue to be checked against local/loopback addresses. A local backup does **not** survive loss of the VM or its disk; operators should copy encrypted archives to independent storage before relying on them for disaster recovery. The `CODEXIA_BACKUP_AGE_RECIPIENT` public recipient is still required; its private identity must be stored separately.
