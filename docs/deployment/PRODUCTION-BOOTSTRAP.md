# Protected production Bootstrap workflow

The protected Bootstrap workflow implements R4 host and database convergence and R5 first-owner enrollment and preparation. [Initial deployment](INITIAL-DEPLOYMENT-FLOW.md) defines the install sequence and [Deployment lifecycle](DEPLOYMENT-LIFECYCLE.md) defines route admission and the separate R6 activation. The VM control path is GitHub Actions → Tailscale OIDC → pinned SSH → Ansible → rootless Podman Quadlet.

## Read-only lifecycle preflight

Use [Production Access Preflight](../../.github/workflows/production-preflight.yml) on protected main with `mode=lifecycle` before choosing an installation or maintenance route. For R4 and the R5 owner operations select `management=bootstrap` to use the independently pinned administrator connection. For initial canonical frontend publication select `management=runtime` after R4 has created the service account. It observes existing rootless resources through the owning service account. Use the pinned runtime connection for installed-runtime observations when preparing an ordinary release or first Backend activation. The ordinary scheduled Access-only probe is unchanged.

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

R4 derives the public half of the existing protected production SSH key in `codexia-production`, converges it through the existing authorized-key task even when the host baseline is already ready, and verifies a real pinned `codexia` SSH connection to the same observed VM before reporting Bootstrap success. No runtime private key is copied into the administrator environment. An inventory-supplied deployment public key must match the derived key; omission is supported. The administrator SSH identity must be distinct from `codexia` and have approved noninteractive sudo. The rootless service account keeps its existing authority. Each mutation revalidates the Full OCI certificate, exact source and producer, actual image identity and candidate compatibility before it uses the administrator connection.

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

## Publishing the normal frontend for first-owner enrollment

The only UI publication target is the normal private `codexia-frontend` Worker. The ordinary Full frontend archive already contains the `/console/setup` route in the desktop application. Do not build or deploy a separate setup Worker, create a separate GitHub Environment, or switch Terraform routes for owner registration. The existing Access parent protects the normal UI and Tunnel APIs; the same Full Backend image and canonical API slot run in setup-only mode until the owner is prepared. The application, not a separate edge deployment, enforces the first-owner-only API boundary.

With the existing Cloudflare infrastructure approval, prepare the normal Worker and canonical UI/origin routes once (`manage_frontend_worker=true` when absent, `frontend_route_enabled=true`). Keep public OAuth/MCP bypass disabled until normal runtime acceptance. Do not alter these UI routes during enrollment or activation.

After R4, run lifecycle Preflight with `management=runtime`, `intent=install` and the exact certified candidate pair. Use [Codexia UI Static Assets](../../.github/workflows/frontend-release.yml) on main with the same request, reviewed `preflight_run_id`, `plan_sha256`, and approval phrase `PUBLISH_INITIAL_FRONTEND`. This R5-only entry uses the existing `codexia-production` Environment, pinned runtime SSH observation, exact-source artifact verification, canonical Wrangler configuration and existing Worker write credential. It requires a fresh matching R5 plan, pending owner and no ordinary API writer, verifies Access and canonical ingress, enforces monotonic frontend identity, publishes the entire certified normal archive using the existing immutable Worker version uploader (including the first version of an unused normal Worker), verifies the exact live identity, then writes the canonical immutable Frontend release record. An exact already-deployed identity skips version upload/promotion and still reconciles the release record. If a response is lost or recording fails, obtain a fresh matching R5 plan and retry. Ordinary release admission is unchanged.

Run lifecycle Preflight with `management=bootstrap` again before starting owner enrollment. The certified normal frontend and its exact immutable release record must both be verified, with the reviewed origin, canonical routes, public protocols disabled and no maintenance fence. Registration and subsequent activation retain the same frontend Worker and routes.

## Running the workflow

1. Use `mode=preflight` with the exact current `main_sha` to check the administrator connection. Use lifecycle Preflight with the exact certified pair to determine the route and review the plan.
2. For R4, dispatch `mode=bootstrap` with the exact `main_sha`, `request`, `full_image`, `plan_sha256` and `preflight_run_id` from the reviewed inputs and plan. Enter `BOOTSTRAP_CODEXIA`. Set both `initialize_database` and the protected initialization approval only for the separately authorized new database. For a positively absent database in an existing VM, request `intent=install` with the same initialization approval. R4 clears only stale DB-bound API/owner deployment state under the host lock and creates the missing logical database (or converges an absent cluster). Use `intent=restore` instead when restoring prior data. An unreachable or unverified database never authorizes initialization.
3. For R5, publish or verify the normal frontend as above, review the refreshed administrator plan and dispatch `mode=owner-setup` with `OWNER_SETUP_CODEXIA`. Follow the [encrypted handoff procedure](../../deploy/ansible/AUTH-RUNTIME.md#first-owner-through-the-browser) and complete Passkey enrollment in the browser.
4. Observe the enrolled owner, review the resulting R5 plan and dispatch `mode=prepare-activation` with `OWNER_SETUP_CODEXIA`. Keep the normal frontend and routes unchanged, confirm the API slot is clean and run Preflight for R6. The separate activation route requires the first-install, database-use and publication approvals. Use [the protected Backend-only activation](PUSH-DEPLOYMENT.md#first-application-activation) with the already-published compatible frontend. A changed or missing frontend after enrollment stops R6. Reobserve the R5 completion and resolve the deployment state without a pair-activation executor or another owner registration.

Existing database roles, secrets and owners are preserved. If the application ledger was committed before the Auth schema was created, run a fresh Preflight. R4 admits an Auth-only continuation when the durable installation intent matches the cluster, database OID, certified Full image and exact ledger, and the API slot is still clean. Review the new plan and keep the separate database-initialization approval for this continuation. If the recorded evidence does not match, stop and inspect it before attempting recovery. Run Preflight again after the installation marker, grant or prepared owner settings change. The protected owner command rechecks the approved checkpoint under the host lock before it changes the grant or API slot. Resolve a missing, expired or unusable encrypted handoff through the separately approved owner reissue procedure.

## Verification

The pull-request workflow exercises the protected input and admission contracts with credential-free fixtures and checks Ansible syntax. The protected `preflight` checks live SSH and sudo and inspects the controller inventory. Real production acceptance separately verifies the enrolled owner, client behavior and active release.
