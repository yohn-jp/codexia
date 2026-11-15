# Standalone Ansible entrypoint

The target desired-state contract is [IAC](../../docs/deployment/IAC.md) (design PR #177). The current implementation is incremental; an inspect result is not proof of convergence.

## Read-only host inspection

Use a private SSH inventory with host-key verification and `codexia_service_user` set to the existing rootless runtime account. No secret inputs are required for this stage:

```sh
ansible-playbook -i /private/codexia-inventory.yml deploy/ansible/site.yml -e codexia_stage=inspect
```

The stage validates the Ubuntu 26.04 amd64/systemd/cgroup-v2 baseline, reports tool availability and existing account state, then (only under the existing runtime SSH identity) observes canonical file presence, lingering, and existing rootless Podman networks, volumes, secret names and container identities. It never reads secret values or invokes service mutation. A missing or noncanonical rootless store is reported as NOT_CHECKED; an absent account is reported as absent rather than created. This is a first inventory step, not a complete drift comparison: exact file content, credential equality, DB schema, external routes, Full workload and fresh host convergence remain separate work.

The existing `prepare`, `initialize`, `verify`, `enable` and acceptance stages retain their current behavior during the migration. Do not run them merely to inspect the host.
