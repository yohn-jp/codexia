# Standalone infrastructure as code

This is the ownership and operation contract for an existing standalone rootless VM. Hosted deployment is out of scope. The [deployment architecture](README.md) and [Standalone updater](STANDALONE-UPDATER.md) retain their existing runtime, security, signed-release and recovery contracts.

| Authority | Desired state and responsibility |
| --- | --- |
| Terraform (`deploy/cloudflare/terraform`) | Access, DNS, Tunnel and Worker routes; the private origin is `http://codexia-api-proxy:3000` after cutover. |
| Ansible (`deploy/ansible`) | Bootstrap/adopt an existing VM's standalone updater, private configuration, least-privileged preflight role and secret, proxy Quadlet, boot and timer units. |
| Existing Quadlets (`deploy/quadlet`) | PostgreSQL, networks, persistent volumes and Tunnel. The existing deployment remains authoritative for these resources; do not recreate or overwrite them. |
| Standalone updater | Exclusive writer slots, immutable release admission, journal, route, reconciliation, rollback. Ansible must never generate a slot or edit the journal. |
| GitHub Actions | Verify and publish certified artifacts and signed stable channel; no VM credentials or automatic infrastructure apply. |

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
