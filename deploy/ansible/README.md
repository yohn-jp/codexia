# Standalone Ansible entrypoint

The target desired-state contract is [IAC](../../docs/deployment/IAC.md). The current implementation is incremental; an inspect result is not proof of convergence.

## Read-only host inspection

Use a private SSH inventory with host-key verification and `codexia_service_user` set to the existing rootless runtime account. No secret inputs are required for this stage:

```sh
ansible-playbook -i /private/codexia-inventory.yml deploy/ansible/site.yml -e codexia_stage=inspect
```

The stage validates the Ubuntu 26.04 amd64/systemd/cgroup-v2 baseline, reports tool availability and existing account state, then (only under the existing runtime SSH identity) observes canonical file presence, lingering, and existing rootless Podman networks, volumes, secret names and container identities. It never reads secret values or invokes service mutation. A missing or noncanonical rootless store is reported as NOT_CHECKED; an absent account is reported as absent rather than created. This is a first inventory step, not a complete drift comparison: exact file content, credential equality, DB schema, external routes, Full workload and fresh host convergence remain separate work.

The existing `prepare`, `initialize`, `verify`, `enable` and acceptance stages retain their current behavior during the migration. Do not run them merely to inspect the host.

## Host baseline convergence

Use the private bootstrap SSH identity with sudo and explicitly set the existing service account's name, primary group, UID, GID and home in inventory. For a new VM explicitly authorize account creation. Then run:

```sh
ansible-playbook -i /private/codexia-inventory.yml deploy/ansible/site.yml -e codexia_stage=host -e codexia_host_approved=true
```

The host stage installs only missing distribution packages (Podman, Node.js and rootless/backup dependencies; no broad system upgrade or package removal), verifies Podman >=5.7 and Node >=22, adopts matching existing identity or creates the explicitly authorized new account, verifies system-allocated subordinate ID ranges, enables lingering and verifies the user manager. It does not start/restart any Codexia unit, touch volumes or initialize Podman storage. Existing account identity or subordinate-ID drift fails closed. An inactive existing user manager with unit directories requires maintenance rather than implicit activation via lingering. Existing manually installed incompatible toolchains require a separately reviewed maintenance plan. Account creation does not provision SSH keys: SSH trust remains external. The host stage is not a dry-run; use inspect for observation. A real Ubuntu 26.04 fresh/repeat test is still required.
