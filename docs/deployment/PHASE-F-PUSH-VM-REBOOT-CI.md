# Phase F push VM reboot fixture

The [manual and PR-gated VM reboot workflow](../../.github/workflows/phase-f-push-vm-reboot.yml) provisions a disposable Ubuntu 26.04 guest with QEMU/KVM on a hosted Actions VM. It pins and verifies Ubuntu cloud image `release-20261108`, creates an ephemeral SSH identity, and uses no repository secrets or production environment.

Inside that guest, the real Ansible `host` stage creates the `codexia` service identity and is applied twice. A fixture-only rootless Quadlet then starts digest-pinned PostgreSQL on a named volume, writes a marker row, and records `pg_control_system()` identity, volume identity, image identity, and the guest boot ID. The test invokes a guest OS reboot, waits for SSH to return with a different `/proc/sys/kernel/random/boot_id`, and verifies that lingering, the rootless database service, database readiness, cluster ID, volume identity, image identity, and marker row survived. A systemd service restart alone cannot pass the changed-boot-ID assertion.

The `CODEXIA_HOST_CONVERGENCE` callable seam accepts the private Ansible inventory and lifecycle name `host`, matching the #443 bootstrap fixture contract. If unset, this fixture calls the current host-stage entrypoint. The application deployment portion should later wire the canonical #430 push convergence path through a reviewed fixture adapter; this workflow does not touch #430 deploy or recovery paths.

The workflow first checks for a usable `/dev/kvm`. If unavailable, it writes `CAPABILITY_UNAVAILABLE` evidence and fails. It never substitutes a systemd restart or simulated boot. Success requires a changed boot ID. Evidence is bound to the exact source SHA, run, attempt, and runner. It contains only nonsecret fixture identities; the SSH private key, cloud-init seed, guest image overlay, and PostgreSQL secret remain in runner temporary storage and are removed when QEMU stops.

## Evidence boundary

This proof covers the actual nested guest reboot, rootless service account, and fixture PostgreSQL continuity on the hosted runner. The push deployment playbook, Codexia API readiness, release rollback, the production VM, Tailscale access, backup/restore, and production acceptance remain `NOT_CHECKED`. #183 remains open for the complete application lifecycle and target-host evidence.
