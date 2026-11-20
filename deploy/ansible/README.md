# Standalone Ansible entrypoint

The target desired-state contract is [IAC](../../docs/deployment/IAC.md). The current implementation is incremental; an inspect result is not proof of convergence.

## Read-only host inspection

Use a private SSH inventory with host-key verification and `codexia_service_user` set to the existing rootless runtime account. No secret inputs are required for this stage:

```sh
ansible-playbook -i /private/codexia-inventory.yml deploy/ansible/site.yml -e codexia_stage=inspect
```

The stage validates the Ubuntu 26.04 amd64/systemd/cgroup-v2 baseline, reports tool availability and existing account state, then (only under the existing runtime SSH identity) observes canonical file presence, lingering, and existing rootless Podman networks, volumes, secret names and container identities. It never reads secret values or invokes service mutation. A missing or noncanonical rootless store is reported as NOT_CHECKED; an absent account is reported as absent rather than created. This is a first inventory step, not a complete drift comparison: exact file content, credential equality, DB schema, external routes, Full workload and fresh host convergence remain separate work.

The existing `prepare`, `initialize`, `verify`, `enable` and acceptance stages retain their current behavior during the migration. Do not run them merely to inspect the host.

## Base secrets and runtime

The explicit `secrets` stage converges protected Podman credentials without rotation. After it succeeds, the `base` stage converges fixed networks, volumes, PostgreSQL and the legacy Tunnel unit without replacing existing data or starting the Tunnel. Run these two stages through a separate bootstrap SSH account with Ansible privilege escalation; Ansible executes rootless Podman/systemd work as `codexia_service_user`, which does not receive sudo. Follow [Base secret convergence](BASE-SECRETS.md) and [Base runtime convergence](BASE-RUNTIME.md) for required approvals, adoption rules and recovery behavior. These stages do not complete signed release admission, writer cutover or target-host acceptance.

## Fresh schema initialization

After `base` and `prepare` on a fresh host, explicitly select `codexia_stage=initialize-schema`, `codexia_database_initialization_approved=true` and `codexia_installed_release_file` pointing to the exact published signed release. The candidate must include the fresh-only migration entrypoint and match the real deployed frontend. The locked updater refuses existing writer Quadlets, loaded writer units, writer/preflight containers, active Tunnel/polling or an initialized journal. It runs only the packaged migration transaction with the application database secret, without persistent application mounts or starting an API. An existing exact migration ledger is verified without changes only when the durable initialization intent proves that this database was previously observed pristine; partial ledgers, untracked schema objects and unproven existing databases are rejected. The intent binds the exact signed release, PostgreSQL cluster system ID and database OID before migration and is completed only after fingerprint verification. The stage then converges and verifies the dedicated read-only preflight grants. It is not an activation or a substitute for the remaining fresh/legacy cutover and recovery contract.

## Fresh private activation

After successful `initialize-schema`, run `codexia_stage=initialize-fresh` with `codexia_maintenance_approved=true` and the same exact release record. The locked controller requires its durable fresh schema receipt, absent legacy identity, stopped Tunnel/polling, signed channel and real frontend compatibility; it starts and checks the blocked private proxy, persists the authenticated initial journal, then runs the existing read-only preflight and exclusive writer recovery. Repeating the stage recovers a pending first activation or verifies the settled private runtime without restarting the writer. It installs and enables reviewed boot recovery units before the first journal is written, without starting the boot service until private activation succeeds; polling stays disabled. It does not change the Tunnel source, start public ingress, apply Terraform or claim public acceptance. Legacy adoption is a separate path.

## Pre-journal bootstrap preflight

After `prepare`, use the existing private inventory and set `codexia_stage=bootstrap-preflight`, `codexia_installed_release_file` and `codexia_bootstrap_candidate_file` to the exact signed-channel release records. The installed image and source are checked against the live legacy writer; a missing legacy API epoch is recorded as null, not inferred. The distinct forward candidate must match the actual deployed UI epoch and retain the same profile, platform, migration fingerprint and persistence format. The protected read-only database preflight must become ready before any writer is stopped. The stage does not initialize a journal, change routing, stop the legacy writer, enable polling or authorize activation.

Only after verifying an off-VM backup and isolated restore receipt bound to the legacy release, run `codexia_stage=bootstrap-cutover` with `codexia_maintenance_approved=true` and the same two signed release files. The locked `bootstrap-cutover` transaction rechecks channel membership, legacy source/runtime identities, backup checkpoint and UI epoch immediately before disruption; it stores the legacy release in backup recovery intent and the candidate in a versioned cutover intent. Pre-journal recovery restores the legacy writer and configuration. Once the candidate journal is durable, recovery can only resume that candidate with the route blocked until writer probes succeed. Polling remains disabled. Existing v1 same-release cutover markers remain recoverable.

Ordinary same-image `initialize` provisions reviewed boot recovery first and uses one locked cutover operation with matching restore evidence, durable legacy source/identity intent and startup fence. A pre-journal interruption restores the legacy topology; post-journal recovery resumes only the journal-owned writer before Tunnel handoff. It still requires the legacy API to advertise its exact epoch.

## Locked updater lifecycle

The `pause`, `resume` and `rollback` stages require `codexia_maintenance_approved=true` and use the existing updater wrapper and host lock. Pause/resume preserve the configured enabled state and timer state. Resume first uses the same locked serving verification as `verify`; it also admits the exact durable-journal recovery error after the backup gate, stable-journal, writer-unit, route and serving-probe checks pass. Unrecognized errors and nonstable states remain blocked. Rollback requires an explicitly paused, healthy controller and a previous digest that the updater still verifies as signed, published and compatible. If automatic updates are enabled in the saved configuration, Ansible invokes the ordinary locked `rollback` operation. If they are disabled, it invokes the existing locked `acceptance-rollback` operation, which preserves the disabled and paused state while recording the rolled-back image in `failedImages`. Both paths require the real signed rollback transition to complete; there is no implicit credential rotation or live database restore. Schema/epoch maintenance remains the separate signed bootstrap transition defined by the canonical IAC plan.

Examples:

```sh
ansible-playbook -i /private/codexia-inventory.yml deploy/ansible/site.yml -e codexia_stage=pause -e codexia_maintenance_approved=true
ansible-playbook -i /private/codexia-inventory.yml deploy/ansible/site.yml -e codexia_stage=resume -e codexia_maintenance_approved=true
ansible-playbook -i /private/codexia-inventory.yml deploy/ansible/site.yml -e codexia_stage=rollback -e codexia_maintenance_approved=true
```

## Host baseline convergence

Use the private bootstrap SSH identity with sudo and explicitly set the existing service account's name, primary group, UID, GID and home in inventory. For a new VM explicitly authorize account creation. Then run:

```sh
ansible-playbook -i /private/codexia-inventory.yml deploy/ansible/site.yml -e ansible_user=codexia-bootstrap -e codexia_stage=host -e codexia_host_approved=true
```

The host stage installs only missing distribution packages (Podman, Node.js and rootless/backup dependencies; no broad system upgrade or package removal), verifies Podman >=5.7 and Node >=22, adopts matching existing identity or creates the explicitly authorized new account, verifies system-allocated subordinate ID ranges, enables lingering and verifies the user manager. It does not start/restart any Codexia unit, touch volumes or initialize Podman storage. Existing account identity or subordinate-ID drift fails closed. An inactive existing user manager with unit directories requires maintenance rather than implicit activation via lingering. Existing manually installed incompatible toolchains require a separately reviewed maintenance plan. Account creation does not provision SSH keys: SSH trust remains external. The host stage is not a dry-run; use inspect for observation. The dedicated host CI runs only for host-stage inputs and uses an isolated Ubuntu 26.04 Actions runner for first/repeat application and a real rootless Quadlet smoke test with explicit runner-only environment isolation. The inherited generator environment is recorded before isolation; a successful runner smoke test is not proof of unmodified target-host convergence. On a clean disposable Ubuntu 26.04 systemd VM, with a non-root bootstrap user with sudo and the supported Ansible controller environment, run `ANSIBLE_PLAYBOOK=/absolute/path/to/ansible-playbook bash deploy/ansible/test-host-integration.sh` from the repository root. This default clean mode uses no fixture-only manager/service drop-ins or generator environment overrides, rejects wrong inherited paths, and asserts the real rootless internal network. Target-production adoption is separately required. Use the Ansible version pinned in `requirements.txt` (controller Python 3.12–3.14).

## PostgreSQL app password rotation

Install the reviewed maintenance runtime first. Verify an off-VM backup and isolated restore receipt for the exact current controller generation and PostgreSQL database identity. Set `codexia_postgres_app_password_rotation_file` and `codexia_app_password_restore_receipt_file` to private control-node files, then run `-e codexia_stage=rotate-app-password -e codexia_app_password_rotation_approved=true`. The stage permits a temporary API outage while the updater lock pauses polling, blocks route admission, updates the PostgreSQL `codexia` role, replaces the immutable Podman secret and restarts the reviewed database and committed writer. It verifies identity and serving state before restoring the prior route and timer. Interrupted recovery restores the old SQL password and secret; uncertain recovery leaves the route blocked, polling stopped and marker retained. Keep the old credential valid until success, then run `verify`. A disposable rootless PostgreSQL/systemd crash-recovery run is required before production use.

## Standalone API token rotation

Pause the initialized controller and install the reviewed maintenance runtime first. Set `codexia_api_auth_token_rotation_file` to a private control-node file containing a replacement standalone API token, then run `-e codexia_stage=rotate-api-auth-token -e codexia_api_auth_token_rotation_approved=true`. The transaction replaces only the immutable `codexia-auth-token` Podman secret under the updater lock, blocks route admission, and restarts the committed writer. Before restoring the route, it verifies that the replacement bearer token authenticates and the previous token receives `401`; then it verifies routed readiness. The durable recovery marker retains private prior/replacement token snapshots until completion. Interruption before the durable completion marker restores and verifies the previous token; interruption after it completes verification against the replacement token. Any unprovable identity or auth result leaves the route blocked and polling stopped. API restart clears in-memory cookie sessions; old bearer and login tokens stop working after success. Update MCP and other API callers before the window, and have the replacement token available for reauthentication. A disposable rootless Podman/systemd interruption and boot-recovery exercise is required before production use.
