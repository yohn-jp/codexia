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

## Locked updater lifecycle

The `pause`, `resume` and `rollback` stages require `codexia_maintenance_approved=true` and use the existing updater wrapper and host lock. Pause/resume preserve the configured enabled state and timer state. Rollback requires an explicitly paused, healthy controller and a previous digest that the updater still verifies as signed, published and compatible. If automatic updates are enabled in the saved configuration, Ansible invokes the ordinary locked `rollback` operation. If they are disabled, it invokes the existing locked `acceptance-rollback` operation, which preserves the disabled and paused state while recording the rolled-back image in `failedImages`. Both paths require the real signed rollback transition to complete; there is no implicit credential rotation or live database restore. Schema/epoch maintenance remains the separate signed bootstrap transition defined by the canonical IAC plan.

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
