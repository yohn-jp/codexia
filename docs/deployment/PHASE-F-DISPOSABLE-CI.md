# Phase F disposable CI evidence

The Phase F workflow adds a disposable rootless Podman/systemd lifecycle proof and calls the existing Full-model OCI acceptance workflow. It exercises the production locked updater and controller with exact certified backend image digests. A fresh ephemeral Ed25519 key signs only the temporary channel fixture; it validates signature and update mechanics, not production publisher authority. The channel and frontend identity URLs are simulated by a process-scoped Node preload that intercepts those two exact URLs. Every other request uses Node's original `fetch`.

The updater job verifies release tags, direct source commits, successful exact-source `verify.yml` and `backend-release.yml` jobs, pulled GHCR digests, OCI source labels, embedded backend identities, and packaged migration fingerprints. Before starting PostgreSQL, it records the disposable service account and host file ownership/mode, the rootless Podman and container UID/GID maps, and a read-only access check against the exact pinned PostgreSQL image and init-script bind. The `postgres-init-access.txt` artifact contains those diagnostics without secret values. The job then initializes a new disposable database, creates an API project, performs a signed update and rollback, checks container/volume identities and project persistence, kills the updater after the old writer stops, runs boot recovery, and checks that route-state drift is rejected while the proxy returns 503. It does not execute the Ansible lifecycle or start from an existing deployment.

## Acceptance map

| #183 acceptance item | Evidence from these CI jobs | Status boundary |
| --- | --- | --- |
| Fresh and repeated Ansible apply | The separate `Verify Ansible Host` and `Verify Ansible Base Secrets` workflows run against the exact PR checkout for their respective host and base input paths. They cover host-stage repeat and base secret/runtime convergence. The host smoke uses explicit Actions-only environment isolation, so clean unmodified target-host proof remains separate. | Partial: these are separate host/base stages, not end-to-end application convergence. |
| Existing deployment adoption | The Phase B runtime workflow exercises resource, database, migration-ledger, and Tunnel adoption cases. | Partial: it does not adopt a complete existing application deployment. |
| Reboot | No Phase F job reboots its runner or exercises a target VM reboot. | NOT_CHECKED |
| Signed update, rollback, interruption, recovery | The Phase F updater job uses rootless Podman/systemd, real source-certified digest-pinned images, signed temporary channel snapshots, and the existing locked updater/controller. | Proven only for the disposable runner and simulated channel/frontend identity endpoints. |
| Full model workload | The `full-model-oci` reusable workflow job runs the existing pinned Full-model lifecycle proof on the same PR source. | Separate exact-head CI job; its artifact remains distinct from updater evidence. |
| External identity, Access denial, and human author UI | The updater job uses token authentication and a fixture frontend identity. Production preflight is main-only and is not invoked by this PR workflow. | NOT_CHECKED |
| Encrypted backup and isolated restore | This workflow does not perform backup or restore. Reference the separate Phase E exact-head evidence when that workflow is available. | NOT_CHECKED here |
| Remote recovery host, measured RPO/RTO | No remote destination or recovery host is provisioned in CI. | NOT_CHECKED |
| Whole-host drift and D cutover | The updater job rejects route-state drift; it does not inventory the whole host, execute D, or change Terraform/Cloudflare. | NOT_CHECKED |

The workflow uploads JSON evidence without private signing key material. The result artifact labels production channel authority, public identity, Access, author UI, VM reboot, remote recovery/RPO/RTO, and D cutover as `NOT_CHECKED`. These disposable jobs are supplemental evidence; they do not close #183 or replace target-host acceptance.
