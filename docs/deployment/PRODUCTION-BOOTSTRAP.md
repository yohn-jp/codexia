# Protected production Bootstrap workflow

The protected Bootstrap workflow implements R4 host and database convergence and R5 first-owner enrollment and preparation. [Initial deployment](INITIAL-DEPLOYMENT-FLOW.md) defines the install sequence and [Deployment lifecycle](DEPLOYMENT-LIFECYCLE.md) defines route admission and the separate R6 activation. The VM control path is GitHub Actions → Tailscale OIDC → pinned SSH → Ansible → rootless Podman Quadlet.

## Read-only lifecycle preflight

Use [Production Access Preflight](../../.github/workflows/production-preflight.yml) on protected main with `mode=lifecycle` before choosing an installation or maintenance route. For R4 and R5 select `management=bootstrap` to use the independently pinned administrator connection. It observes existing rootless resources through the owning service account. Use the pinned runtime connection for installed-runtime observations when preparing an ordinary release or coordinated cutover. The ordinary scheduled Access-only probe is unchanged.

The request identifies the certified Full backend publisher run, optionally the currently installed backend publisher run, the exact frontend producer/Verify/artifact IDs and archive SHA-256, the intent, and any maintenance window. Use the keys `backendPublisherRunId`, `priorBackendPublisherRunId`, `frontend: {runId, verifyRunId, artifactId, artifactDigest}`, `intent`, and `window: {id, notBefore, notAfter}`. Do not supply credentials, observed state, or backup/approval claims in this input. The lifecycle jobs verify the certified artifacts before observing the host, then reuse the protected SSH, Access and Cloudflare read credentials. The plan artifact binds observed state and verified candidate identities to the main revision and run attempt. Review the plan from the current main revision. Bootstrap loads that run's exact reviewed plan, obtains fresh host and edge evidence inside the production queue and rejects any change to the approved route, target or state.

Review the redacted lifecycle plan's `candidateRoute`, `route`, `blockers`, `requiredApprovals`, and `planSha256`. An approval-required or evidence-deficient result stops at R0. Stale observations require a new observation; a denied or unavailable probe is never proof of absence. A plan is not an authorization to converge the host, change a fence, publish a Worker or activate a backend. The owning mutation workflow must consume the plan with the actual approved grants and revalidate evidence under the existing queue/lock. Existing recovery/transition and preservation adapters provide their own evidence; missing evidence stops the plan. Real-environment acceptance remains separate.

## Scope and isolation

[Production Bootstrap](../../.github/workflows/production-bootstrap.yml) accepts four modes on protected `main`.

| Mode | Outcome |
| --- | --- |
| `preflight` | Verify pinned administrator SSH, noninteractive sudo, inventory and Ansible syntax. |
| `bootstrap` | Use R4 to converge only the required host, secrets, base and auth-runtime stages. A fresh install ends with the database prepared for owner enrollment. |
| `owner-setup` | Use R5 to run the existing setup-only API and prepare the encrypted registration handoff. |
| `prepare-activation` | Use R5 to verify the enrolled owner and clients and stop setup-only. Obtain a new Preflight plan for R6. |

The administrator SSH identity must be distinct from `codexia` and have approved noninteractive sudo. The rootless service account keeps its existing authority. Each mutation revalidates the Full OCI certificate, exact source and producer, actual image identity and candidate compatibility before it uses the administrator connection.

Configure a separate GitHub Environment `codexia-bootstrap` with required operator reviewers, restricted deployment branch `main`, and the following entries. The `codexia-production` deploy Environment and its credentials remain separate.

| Name | Type | Meaning |
| --- | --- | --- |
| `TS_OAUTH_CLIENT_ID` | Secret | Existing approved Tailscale GitHub OIDC client with access to the target. |
| `CODEXIA_BOOTSTRAP_SSH_PRIVATE_KEY` | Secret | Private Ed25519 key for the independent, sudo-capable bootstrap SSH user. |
| `CODEXIA_BOOTSTRAP_BUNDLE_B64` | Secret | Base64 gzip tar containing only the canonical private inventory and credential files listed below. |
| `CODEXIA_BOOTSTRAP_HOST` | Variable | Single, independently verified tailnet hostname or address. |
| `CODEXIA_BOOTSTRAP_SSH_USER` | Variable | Bootstrap SSH login, distinct from `codexia` and `root`. |
| `CODEXIA_BOOTSTRAP_SSH_KNOWN_HOSTS` | Variable | Independently verified SSH host key pin for that exact hostname/address. |
| `CODEXIA_BOOTSTRAP_ENABLED` | Variable | Exact `true` for a separately approved mutating Bootstrap; otherwise `false`. |
| `CODEXIA_DATABASE_INITIALIZATION_APPROVED` | Variable | Exact `true` only when an empty/new Codexia database initialization is separately approved. |
| `CODEXIA_CUTOVER_CLOUDFLARE_TARGET`, `CODEXIA_PUBLIC_ORIGIN` | Variables | The same Cloudflare target and public origin used by lifecycle Preflight. |
| `CODEXIA_CUTOVER_CLOUDFLARE_READ_TOKEN`, `CODEXIA_ACCESS_CLIENT_ID`, `CODEXIA_ACCESS_CLIENT_SECRET` | Secrets | Scope these as for lifecycle Preflight. The bootstrap observer uses them to verify the live edge before admitting a VM change. |
| `VITE_CODEXIA_OAUTH_*`, `VITE_CODEXIA_API_AUDIENCE` | Variables | The public browser configuration used by lifecycle Preflight to verify the certified frontend artifact. |

Supply a reviewed `inventory.yml` with one literal host alias under `all.children.codexia.hosts`. Set only `ansible_host` and `ansible_user` on the host, and supply the approved rootless UID/GID in group variables. Omit the stage, bootstrap image, database and first-install approvals, and controller-selected owner operation from the bundle. The controller supplies them at dispatch. The file must contain **no embedded credentials**; protected files should be declared externally. The bundle is a gzip tar archive of **regular files only** with the exact names:

```
inventory.yml
private/tunnel-token
private/postgres-admin-password
private/postgres-app-password
private/codexia-auth-database-url
private/codexia-auth-secret
private/codexia-oauth-introspection-client-secret
```

Optional: `private/codexia-oidc-client-secret` when the inventory configures OIDC, or the complete legacy enrollment triplet `private/enrollment/bootstrap.env`, `private/enrollment/tls.crt`, `private/enrollment/tls.key` when its legacy step is explicitly approved. The controller overrides all credential file locations to its private ephemeral directory. Inventory `codexia_host_approved`, `codexia_secrets_approved`, `codexia_base_approved`, and `codexia_auth_runtime_approved` must each be true for R4. R5 takes the owner and edge approvals and encryption recipient from the reviewed inventory. Store the base64 archive only in the protected secret store, **never in git, a PR, Actions logs or artifacts**. Do not mint replacement secrets for existing PostgreSQL, Cloudflare Tunnel or Better Auth instances; stage their existing values.

## Preparing limited owner setup ingress

[Stage protected first-owner assets](../../.github/workflows/production-owner-setup-assets.yml) uses a separate `codexia-bootstrap-edge` environment restricted to `main` and reviewed by edge operators. Configure the same Cloudflare read target, read token, origin and public frontend OAuth variables as Preflight. Add `CODEXIA_OWNER_SETUP_WORKER_TOKEN` for Worker deployment in the reviewed account. This environment needs only the Worker write credential plus the read credentials. Keep Terraform credentials and SSH administration in their own environments.

With `public_oauth_edge_enabled=false`, dispatch the staging workflow with the reviewed `install` request. It certifies the candidate pair and stages only `/console/setup` and its assets from the exact frontend archive on the detached `codexia-owner-setup` Worker. The staging workflow checks the Worker version and confirms it has no public route, custom domain or preview URL.

Through the separately approved Terraform process, set `owner_setup_route_enabled=true`. The existing Access parent protects the setup page, its assets and the Tunnel APIs. The limited routes replace the normal frontend routes while enrollment is open. Keep `frontend_route_enabled=true` when an existing normal Worker must retain its exact identity probe, and `false` when no normal Worker is deployed. This does not change the previous normal Worker version. Run lifecycle Preflight again and use the result that binds the attached setup Worker version to the exact archive.

After `prepare-activation` stops the setup API and Tunnel, return `owner_setup_route_enabled` to `false` through Terraform. Observe the resulting ingress before approving activation. The old normal Worker remains available for identity verification if present. The dedicated setup Worker remains detached.

## Running the workflow

1. Use `mode=preflight` with the exact current `main_sha` to check the administrator connection. Use lifecycle Preflight with the exact certified pair to determine the route and review the plan.
2. For R4, dispatch `mode=bootstrap` with the exact `main_sha`, `request`, `full_image`, `plan_sha256` and `preflight_run_id` from the reviewed inputs and plan. Enter `BOOTSTRAP_CODEXIA`. Set both `initialize_database` and the protected initialization approval only for the separately authorized new database. For a missing existing database, obtain a recovery plan.
3. For R5, prepare the limited owner setup ingress, review the refreshed plan and dispatch `mode=owner-setup` with `OWNER_SETUP_CODEXIA`. Follow the [encrypted handoff procedure](../../deploy/ansible/AUTH-RUNTIME.md#first-owner-through-the-browser) and complete Passkey enrollment in the browser.
4. Observe the enrolled owner, review the resulting R5 plan and dispatch `mode=prepare-activation` with `OWNER_SETUP_CODEXIA`. Detach the limited setup routes, confirm the API slot is clean and run Preflight for R6. The separate activation route requires the first-install, database-use and publication approvals. Use the coordinated path when the frontend is absent or incompatible.

Existing database roles, secrets and owners are preserved. If the application ledger was committed before the Auth schema was created, run a fresh Preflight. R4 admits an Auth-only continuation when the durable installation intent matches the cluster, database OID, certified Full image and exact ledger, and the API slot is still clean. Review the new plan and keep the separate database-initialization approval for this continuation. If the recorded evidence does not match, stop and inspect it before attempting recovery. Run Preflight again after the installation marker, grant or prepared owner settings change. A previous plan no longer authorizes the next operation. Resolve a missing, expired or unusable encrypted handoff through the separately approved owner reissue procedure.

## Verification

The pull-request workflow exercises the protected input and admission contracts with credential-free fixtures and checks Ansible syntax. The protected `preflight` checks live SSH and sudo and inspects the controller inventory. Real production acceptance separately verifies the enrolled owner, client behavior and active release.
