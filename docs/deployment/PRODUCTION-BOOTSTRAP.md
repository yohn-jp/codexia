# Protected production Bootstrap workflow

This workflow implements part of the initial-deployment controller defined by [Initial deployment](INITIAL-DEPLOYMENT-FLOW.md). The normative [Deployment lifecycle](DEPLOYMENT-LIFECYCLE.md) additionally requires full read-only state classification, certified bootstrap artifacts, resumable checkpoints and a protected handoff to activation; the current controller's preflight is not the complete lifecycle preflight. It is **not** the application release workflow and cannot activate Backend 2 or Frontend 2. The only production control path is GitHub Actions → Tailscale OIDC → pinned SSH → Ansible → rootless Podman Quadlet.

## Read-only lifecycle preflight

Use [Production Access Preflight](../../.github/workflows/production-preflight.yml) on protected main with `mode=lifecycle` before choosing an installation or maintenance route. For an unconstructed VM select the independent bootstrap administrator connection; for an existing runtime select the pinned service-account connection. The ordinary scheduled Access-only probe is unchanged.

The request identifies the certified Full backend publisher run, optionally the currently installed backend publisher run, the exact frontend producer/Verify/artifact IDs and archive SHA-256, the intent, and any maintenance window. Use the keys `backendPublisherRunId`, `priorBackendPublisherRunId`, `frontend: {runId, verifyRunId, artifactId, artifactDigest}`, `intent`, and `window: {id, notBefore, notAfter}`. Do not supply credentials, observed state, or backup/approval claims in this input. The lifecycle jobs verify the certified artifacts before observing the host, then reuse the protected SSH, Access and Cloudflare read credentials. The plan artifact binds observed state and verified candidate identities to the main revision and run attempt. A delayed approval or runner allocation that makes the observation stale requires a new preflight.

Review the redacted lifecycle plan's `candidateRoute`, `route`, `blockers`, `requiredApprovals`, and `planSha256`. An approval-required or evidence-deficient result stops at R0. Stale observations require a new observation; a denied or unavailable probe is never proof of absence. A plan is not an authorization to converge the host, change a fence, publish a Worker or activate a backend. The owning mutation workflow must consume the plan with the actual approved grants and revalidate evidence under the existing queue/lock. Existing recovery/transition and preservation adapters provide their own evidence; missing evidence stops the plan. Real-environment acceptance remains separate.

## Scope and isolation

[Production Bootstrap](../../.github/workflows/production-bootstrap.yml) is manual on protected `main`. `preflight` validates the pinned administrator connection, protected inventory and Ansible configuration without invoking a state-changing Ansible stage. `bootstrap` runs the canonical `codexia_stage=bootstrap` and its existing `host`, `secrets`, `base`, and `auth-runtime` tasks. Neither mode deletes a database or deploys the normal application image or frontend. An explicitly approved first-owner browser setup may launch only the restricted setup-only API and Tunnel, as specified by the existing auth-runtime stage; it must not be treated as normal API activation or Cloudflare policy deployment. The normal production deployment key is not suitable: this operation requires a **distinct administrator SSH identity** with reviewed passwordless sudo; the rootless `codexia` identity must remain unprivileged.

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

Supply an existing, reviewed `deploy/ansible/inventory.example.yml`-compatible `inventory.yml` in the protected bundle, with exactly one `codexia` host and the approved `codexia` UID/GID. The file must contain **no embedded credentials**; protected files should be declared externally. The bundle is a gzip tar archive of **regular files only** with the exact names:

```
inventory.yml
private/tunnel-token
private/postgres-admin-password
private/postgres-app-password
private/codexia-auth-database-url
private/codexia-auth-secret
private/codexia-oauth-introspection-client-secret
```

Optional: `private/codexia-oidc-client-secret` when the inventory configures OIDC, or the complete legacy enrollment triplet `private/enrollment/bootstrap.env`, `private/enrollment/tls.crt`, `private/enrollment/tls.key` when its legacy step is explicitly approved. The controller overrides all credential file locations to its private ephemeral directory. Inventory `codexia_host_approved`, `codexia_secrets_approved`, `codexia_base_approved`, and `codexia_auth_runtime_approved` must each be true for a mutating run. Store the base64 archive only in the protected secret store, **never in git, a PR, Actions logs or artifacts**. Do not mint replacement secrets for existing PostgreSQL, Cloudflare Tunnel or Better Auth instances; stage their existing values.

## Running the workflow

1. Review the existing production database, other databases, `codexia-history` volume, API service, protected backup and immutable certified Full OCI image before making a deletion decision. **This workflow does not authorize deletion.**
2. Dispatch from the current `main` with `mode=preflight`, its exact `main_sha`, and both initialization booleans false. Verify protected SSH and Ansible syntax. If the current main moves, redispatch after review.
3. For a new/empty Codexia cluster, separately approve the initialization, set `CODEXIA_BOOTSTRAP_ENABLED=true` and `CODEXIA_DATABASE_INITIALIZATION_APPROVED=true` in the protected Environment, provide the immutable Full image digest, and dispatch `mode=bootstrap`, `initialize_database=true`, `approval_phrase=BOOTSTRAP_CODEXIA`.
4. **Special recovery from deliberate deletion of only the logical `codexia` DB:** retain the PostgreSQL service and `codexia-postgres` volume. First confirm from the real host that the old API container, API unit and API Quadlet are absent, the database `codexia` is genuinely missing, and an independently verified backup exists where relevant. Dispatch the same approved bootstrap with `recreate_missing_database=true`. The additional Ansible task rejects a running/installed API, an unexpected DB owner or an incorrect app role, and executes only `CREATE DATABASE codexia OWNER codexia` when the database is absent. It never drops or recreates any other database or Podman volume.
5. Complete owner enrollment through the approved `/console/setup` flow, verify credentials and client registrations, and run the [protected owner activation preparation](../../deploy/ansible/AUTH-RUNTIME.md#first-owner-through-the-browser). Request the **separate** activation route; use the coordinated route if the deployed frontend is absent or incompatible. Bootstrap does not itself dispatch that release. Clear temporary bootstrap approvals afterward.

A normal repeat run must preserve existing roles and secrets and fail closed on drift. Incomplete/unknown volume state, unapproved changes, missing secret input, invalid SSH pin and incomplete owner enrollment must stop rather than reset the environment. API and Tunnel activation, frontend rollout, epoch switch and production reboot/restore acceptance are separate operations. A green Bootstrap workflow by itself establishes none of those outcomes.

## Verification

The pull-request workflow runs credential-free input/admission tests plus an Ansible syntax check. It cannot prove production reachability or live database behavior. The protected `preflight` performs live, read-only SSH/sudo capability checks and the inventory syntax check. The mutating `bootstrap` should be run only after the protected inputs are installed and separately approved; retain its run ID and target-host observations for production acceptance.
