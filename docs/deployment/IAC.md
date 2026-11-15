# Standalone infrastructure as code

**Normative target architecture.** Ansible is the single desired-state authority for the Codexia-managed configuration of a standalone VM. The implementation is being migrated from the existing updater-only playbook; the target requirements below are binding for new implementation, not a claim that they are already implemented. Hosted runtime, hypervisor provisioning, initial OS installation and external infrastructure are out of scope.

## 1. Ownership and boundaries

| Authority | Responsibility |
| --- | --- |
| Ansible (`deploy/ansible`) | Converge and verify all Codexia-owned host configuration, dependencies, rootless service identity, files, secrets, networks, persistent volume identities, database, Tunnel connector, updater/proxy, backup and maintenance entrypoints. Adopt existing installations without destroying data. |
| Quadlet (`deploy/quadlet`, updater templates) | Declarative local runtime representation consumed by rootless Podman/systemd. Ansible installs and verifies static units; the updater alone generates writer slots. Quadlet files are not a second desired-state authority. |
| Standalone updater | Authenticated release admission, exclusive writer fencing, slot generation, route/journal, compatibility checks, recovery and rollback. Ansible invokes existing locked operations; never creates a competing writer, edits a journal or changes the route independently. |
| Terraform (`deploy/cloudflare/terraform`) | Cloudflare Access, DNS, remote Tunnel configuration, Worker routes. Existing account-owned policies and shared zone rules retain their owners. Ansible manages the VM-side connector, not Cloudflare resources. |
| GitHub Actions | Exact-source verification, immutable OCI publication, protected signing/channel maintenance and independent static frontend delivery. No VM SSH credentials or automatic infrastructure apply. |
| PostgreSQL | Sole manuscript authority. Data and operational journal are durable runtime state, not desired-state templates. Neither Ansible nor CI overwrites them. |

The required end state is a single reviewed Ansible entrypoint plus explicit lifecycle operations, using private inventory/secret inputs. Routine VM administration must not require copying files, issuing ad hoc Podman/systemd commands or manually editing units on the host. Emergency break-glass recovery remains documented, audited and reconciled via Ansible before returning to normal service.

## 2. Supported baseline and inventory

The starting boundary is an SSH-reachable Linux VM with verified host key, a bootstrap identity able to perform narrowly scoped privileged setup, working package repositories and network access. The initial supported host implementation is Ubuntu 26.04 amd64, systemd, cgroup v2, rootless Podman with Quadlet support, and Node.js >=22. Unsupported distributions or missing required capabilities fail before mutation. Additional OS support needs explicit implementation and acceptance. The VM image, SSH trust enrollment, external backup destination and secret authority remain external inputs; do not manufacture or guess those values.

Use a single validated inventory schema with separate nonsecret configuration and private credential references. Inventory declares:

- service user, UID/GID policy, home, rootless subordinate ID allocation/validation, package/toolchain versions or supported version constraints, lingering, directory ownership and required host capabilities;
- the existing network/volume identities and security constraints, database and cloudflared immutable image digests, selected Core/Full profile, signed backend release reference, immutable proxy image and selected browser-auth configuration;
- explicit permitted runtime options needed by the profile (model/cache paths and read-only artifact mounts where configured, resource limits/tmpfs, storage and ownership). No arbitrary shell, environment passthrough or unrestricted host paths. Authoring storage stays separate from derived caches;
- protected input references for auth token, Tunnel token, independent PostgreSQL admin/app/preflight passwords, GitHub read/registry access where required, scoped Access probe credentials, pinned Ed25519 public key, backup recipient and destination. The signing private key stays in the protected publisher; the recovery private key stays on the isolated recovery host;
- backup/restore policy, retention responsibility, maintenance approval, and desired polling state. Approval flags authorize operations, not proof of execution.

Ansible must validate types, absolute paths, image identity/profile, credential separation, required options and ownership before disruptive work. No real inventory, private URLs/host aliases, tokens, keys, password values or Terraform state are committed. Example inputs are clearly placeholders.

## 3. Desired-state coverage

| Domain | Required convergence and observation |
| --- | --- |
| Host | Package dependencies (Podman/Quadlet, Node, flock, age and backup tooling), service identity, subuid/subgid, lingering, rootless systemd, cgroup and available disk; no broad OS upgrade or unrelated firewall changes. |
| Storage/network | Install canonical network and volume Quadlets, preserve exact existing volume names and data, validate private DB network, permissions, mount semantics and absence of public API/DB ports. Never delete/recreate a data volume to resolve drift. |
| Secrets | Create missing Podman secrets from protected inputs, verify existing values without disclosure, fail closed on mismatch. Explicit coordinated rotation is separate from routine convergence; no implicit DB or signing-key rotation. |
| PostgreSQL | Install pinned DB unit and init script before initial startup; adopt existing DB by verifying identity/roles and schema. Initialize only empty/new storage; never rerun first-install SQL against a live database. Maintain distinct writer/admin/preflight credentials and least-privileged preflight grants. DB image/schema changes require explicit maintenance. |
| Tunnel | Install a complete pinned connector Quadlet with only loopback metrics binding, declared secret and expected proxy dependency. Verify connector readiness; do not rewrite a live route until the corresponding private proxy is verified. |
| Runtime | Validate and apply profile, browser auth, resource and model-cache configuration through a shared typed host contract consumed by the existing updater. Legacy and slot settings must agree with the declared supported runtime; unknown legacy deviations block cutover rather than disappear silently. |
| Updater/proxy | Install the complete runtime dependency closure, private configuration, proxy unit and boot/poll units from the reviewed source. Verify source digests/configuration/units, timer and controller health even after initialization. Controlled maintenance upgrades preserve journal/checkpoint, suspend polling, acquire exclusive control, verify and resume only on success. |
| Backup/recovery | Declare remote destination, encryption recipient, tooling, invocation and restore verification. Reuse existing backup/fingerprint code. Orchestrate writer fencing and resumption through the locked controller, not an independent route writer. Require actual verified off-VM backup evidence before disruptive adoption/migration. Restore to isolated/new storage; production data replacement never implicit. |
| Verification | Report expected vs observed config, image digests, writer count, proxy target, DB schema/roles, network bindings, readiness, API/frontend identity and timer. Probe external Access denial and authenticated functionality using the established scoped probes; human author UI acceptance remains a separate proof. |

## 4. Lifecycle contract

The existing `site.yml` remains the Ansible entrypoint. Implementation may split its tasks into roles or includes; avoid two competing playbooks for the same configuration. Define and document concrete stage names, inputs, output evidence, restart impact and dependencies as they are implemented. The final interface must provide these operations:

1. **Inspect/plan:** read-only inventory and drift report; no application writes or restarts. Unknown topology or unobservable prerequisites fail closed.
2. **Converge base:** prepare an empty SSH-ready VM or adopt an existing one; establish host, secrets, storage/network, database and declared static units without changing a running writer unexpectedly. A second run against matching desired state is unchanged.
3. **Bootstrap/adopt:** distinguish empty install, legacy serving writer, and initialized controller. Verify authenticated signed channel, certified artifact, real frontend identity, backup evidence and DB compatibility before disruption. Handle a legacy API that does not yet advertise an epoch by an explicit compatible bootstrap release transition, not by guessing an epoch or bypassing preflight. A fresh install may initialize DB schema using the existing migration authority once, before updater read-only preflight. No unsigned release or second writer. If the real UI identity is not available/compatible, a coordinated initial deployment must establish the identity contract without weakening normal production gates.
4. **Cutover/acceptance:** preserve the former writer/configuration, fence old writer, initialize controller and prove private proxy readiness, then hand off to the separately reviewed Terraform origin change. Verify routed identity and persistence, anonymous and out-of-scope denial, reboot and update/rollback. Record evidence. Enable polling only after acceptance.
5. **Steady-state converge:** detect and safely repair declared drift after initialization, including controller source/config, units and credentials as appropriate. Routine converge is non-disruptive; runtime/DB changes requiring interruption must be planned and explicitly approved. Respect updater lock and preserve paused/disabled state when intended. No silent changes to release selection, key trust or journal.
6. **Maintenance/recovery:** explicit pause, resume, backup, restore drill, compatible rollback, controlled controller/credential/DB or incompatible epoch transition. Resume the original writer on recoverable failure using the canonical controller; if ownership or compatibility cannot be proven remain blocked and preserve evidence. Reconcile interrupted first adoption, including failure before a journal exists. Do not delete the journal or suppress a failed digest to retry.
7. **Verify:** read-only host and externally routed checks; verify the actually running release, not merely installed files, and distinguish configured, deployed and accepted.

A private Terraform plan/application and publisher provisioning are explicit dependencies, not VM shell tasks. The initial signed channel must be bootstrapped by the protected publisher and advertise a certified release; Ansible only verifies/consumes that trust. Do not introduce CI-to-VM credentials to work around bootstrap. The present legacy origin and missing channel must be resolved through these established authority boundaries.

## 5. Security and failure invariants

- Preserve PostgreSQL and history volumes, existing author data, browser recovery semantics and rootless network isolation. Keep the single-writer invariant across Ansible, updater, backup, reboot and interruption.
- The updater owns host-level locking and writer/route state. Any operation touching those resources must use a compatible locked maintenance interface; do not acquire the same non-reentrant lock and call a second lock-taking process.
- Routine runs must not stop a working service, rotate a credential or downgrade a release as a side effect of file reconciliation. Unsafe drift is reported, not blindly overwritten. Approval never overrides integrity, compatibility or backup verification.
- Secrets use protected files/Vault/external secret inputs, restrictive permissions and no-log/no-diff paths; no credentials in stdout, facts/artifacts, shell arguments, public repo or GitHub Actions VM inputs.
- Artifacts are digest-pinned; verify profile, source, schema fingerprint, API/persistence epochs and signed-channel membership where applicable. Keep existing Access, CSRF, auth and exact-source CI gates.
- Failed adoption must be retryable from observed durable state. Do not manually start slot units or delete state, data, secrets or unrelated host resources as a recovery mechanism.

## 6. Implementation and proof gates

Implement in dependency order using independent Issues and reviewable PRs. The existing tasks and controllers are reused rather than rewritten. The migration is complete only when all lifecycle operations are covered and a real target-host acceptance record exists.

| Phase | Deliverable | Required evidence |
| --- | --- | --- |
| A | Inventory, read-only host inspection, host/account/toolchain convergence | Schema rejection before mutation; matching host second run unchanged; supported rootless systemd/Quadlet on Ubuntu target |
| B | Base networks, volumes, secrets, PostgreSQL, static Tunnel unit | Fresh disposable host convergence, existing-data adoption, second run unchanged, secret mismatch/write denial, no public DB/API binding |
| C | Shared runtime contract and controlled updater lifecycle | Core/Full settings retained across slots and reboot, pinned images, post-init drift verification, controlled source/unit/config update and failure handling |
| D | Legacy/empty bootstrap and cutover | Signed channel admission, old epoch bootstrap, migration ledger and backup proof, no overlapping writers, interruptions before/after journal, proxy/Access compatibility and rollback |
| E | Backup and maintenance lifecycle | Real encrypted remote backup, isolated restore, interruption and failed restore behavior, no live overwrite, recovery/credential/migration operations |
| F | End-to-end integration and operational acceptance | Real Ubuntu VM fresh/repeated apply, existing deployment adoption, reboot, signed update/rollback, Full model workload, external identity/denial and authenticated author smoke test; measured backup/restore and no untracked host drift |

CI must syntax-check and exercise the actual roles, use disposable PostgreSQL and an isolated real rootless Podman/systemd VM for integration proofs (not solely a mocked Podman command). Run fresh converge, repeat, deliberate drift, interrupted operations and recovery. Tests may separate expensive VM proof from PR fast checks, but missing external evidence is NOT_CHECKED, not success. Production application requires explicit authorization and verified recovery evidence. Preserve current exact-source release certification and independent UI/backend release lanes.

## 7. Current transitional implementation (not the target contract)

The following is the existing updater-only runbook retained for safe operation until Phases A–F replace its manual prerequisites. It must not be represented as complete VM convergence. Its current stage names and prerequisites remain accurate for the current code.

## Inputs and trust

Use a reviewed checkout of this repository, an SSH inventory with host-key verification, the existing rootless service account and sudo access for creating /opt/codexia-updater. The host must already have Podman/Quadlet, Node.js 22+, flock, systemd user services with lingering, the canonical database and private networks/volumes, and the existing application/Tunnel credentials. VM creation, base OS installation, initial PostgreSQL data restore and private Terraform state are operator infrastructure prerequisites, not destructive playbook operations.

Install Ansible Core 2.19 in an isolated control-node environment. Copy `deploy/ansible/inventory.example.yml` to a private location; supply real host, Full/Core-compatible public origin, independently trusted signing public key, immutable certified proxy digest and explicit current browserAuth. Supply GitHub repository read and paired Access service credentials as private control-node files; use Ansible Vault or an external secret manager for `codexia_preflight_password` (independent 32-byte hexadecimal secret). Never commit inventory credentials, private files, Terraform state or installed-release records. Existing credentials are not rotated implicitly. The control node and the target service account are trusted; do not run with verbose secret logging.

## Converge

From the repository root, run the following with a private inventory and an encrypted extra-vars file:

```sh
ansible-playbook -i /private/codexia-inventory.yml deploy/ansible/site.yml \
  -e @/private/codexia-vault.yml --ask-vault-pass -e codexia_stage=prepare
```

`prepare` verifies the existing host topology; installs the canonical updater runtime, disabled configuration, private credentials and blocked route; converges the preflight role and secret; and installs the private proxy Quadlet without starting or stopping a writer. The SQL refuses unsafe existing roles rather than silently revoking unknown privileges. A second execution does not recreate the role or secret, rotate passwords or restart services. A check-mode run is useful for file differences but does not execute database convergence or prove runtime acceptance.

For first activation, verify an encrypted off-VM backup and restore; review the legacy writer configuration, including custom mounts/runtime settings (the current controller supports only its canonical slot configuration). Confirm the installed release is signed and compatible with the real frontend; provide its exact release record as `codexia_installed_release_file`. During the approved maintenance window, run the same playbook with `-e codexia_stage=initialize -e codexia_maintenance_approved=true`. It verifies release admission, the running legacy image identity, ready API version and exact browser authentication configuration before stopping the legacy writer, backs up/removes the legacy Quadlet, changes its Tunnel unit dependency, starts the private proxy, invokes the canonical locked controller and installs boot/poll units. It does not enable periodic updates. A failed initialization is fail-closed: inspect the journal and use the existing recovery contract; never delete state to retry or start a second writer. If interruption occurs before a controller journal exists and the legacy writer has stopped, restore the saved legacy Quadlet and its Tunnel dependency under the maintenance procedure, verify the original writer is serving, then retry initialization.

Apply the reviewed Terraform plan with `origin_service = "http://codexia-api-proxy:3000"` using the existing private state; preserve Access and routes. Ansible does not apply Terraform or change Cloudflare access policy. Execute the [target-VM acceptance](STANDALONE-UPDATER.md#acceptance-target-vm-required), including backup/restore, fault/reboot and rollback exercises. For the real update/rollback exercise, keep the timer inactive and the initialized controller disabled and paused. Provide a second forward-compatible published release in the signed channel. Run the playbook with `-e codexia_stage=acceptance-update -e codexia_maintenance_approved=true`, verify the committed candidate, then `-e codexia_stage=acceptance-rollback -e codexia_maintenance_approved=true`. Both commands use the existing locked admission and rollback path, require a real release transition and preserve the paused state; rollback suppresses the exercised digest just as normal rollback does. A missing candidate or previous release fails the exercise. Only after success, run `-e codexia_stage=enable -e codexia_acceptance_approved=true`. It checks controller topology and real public API identity, enables the config, resumes the controller and starts the timer. The approval variables are explicit operator attestations, not proof of backup or acceptance.

Run `-e codexia_stage=verify` to inspect initialized topology, probe the live private proxy and authenticated persistence, and verify existing preflight role grants and secret without mutating them. After initialization, prepare/initialize are read-only verification, not a second bootstrap. Controller runtime upgrades and credential rotation require separate maintenance: stop polling, reconcile state, review the source/config change and verify before resuming. No playbook operation deletes application data or replaces database/volume identities. Do not run simultaneous Ansible invocations against the same VM; the updater owns its own host lock.

## Verification

Repository CI syntax-checks the playbook and exercises the preflight role tasks against a disposable PostgreSQL instance and a test secret adapter. It verifies role/secret idempotency, read-only drift detection and effective write denial. These are not live acceptance. Actual rootless systemd, Podman, Access, live cutover and recovery must be checked on the target VM.
