# Distinct Legacy Bootstrap Cutover

## Goal

Implement a dedicated, recoverable transition from the currently serving legacy release to a separately signed candidate release. Preserve the backup and restore-receipt identity as the legacy release while the durable controller journal records the candidate after cutover.

## Scope and authority

This plan addresses the outstanding #181 old-epoch cutover contract only. It follows `docs/deployment/IAC.md`, the accepted bootstrap preflight and release policy contracts, and repository `AGENTS.md`. It does not implement fresh public handoff, production credentials, publication, Terraform, API/Tunnel/DB-admin/preflight secret rotation, or schema/epoch application changes. Do not infer production digests or epochs.

## Acceptance criteria

- A separate `bootstrap-cutover` stage and updater command are explicit; existing `initialize` and fresh-only `initialize-schema` semantics remain unchanged.
- Both releases are independently validated against the signed channel. The durable transaction records `legacyRelease` and `candidateRelease` as distinct identities.
- Backup and restore receipt remain bound to the observed legacy release; the candidate is installed and journaled only after read-only candidate preflight confirms schema, persistence, profile, and platform compatibility against the real UI epoch and explicitly absent legacy API epoch.
- Before disruption, revalidate release membership, source/runtime identity, backup checkpoint, and serving legacy state. Keep proxy blocked during transition and use the existing locked writer/Tunnel startup fence.
- Failure before candidate journal commit restores and verifies legacy service/config. Failure after commit or reboot may resume only the candidate with proxy blocked until writer and serving probes pass. Ambiguous recovery remains paused and blocked.
- Unit and rootless runtime tests cover receipt identity, distinct candidate identity, preflight rejection, pre/post journal failure, and reboot recovery.
- Ansible configuration validation and canonical CI pass on exact PR head.

## Implementation tasks

1. Inspect the signed-channel policy helpers, bootstrap preflight, updater CLI, controller transaction and recovery, Ansible stage dispatch, and disposable runtime test harness. Record invariants before editing.
2. Add failing unit tests for a distinct legacy/candidate transaction, including legacy-bound receipt and candidate-bound journal/recovery; reject incompatible candidate metadata and stale source/checkpoint.
3. Implement versioned durable intent with separately persisted legacy/candidate records. Keep old release restore identity separate from candidate activation identity in recovery.
4. Add the explicit updater command and Ansible `bootstrap-cutover` stage, validation, dispatch, and safe service environment. Ensure retries/reboots enter recovery before normal maintenance.
5. Extend the rootless Podman/systemd disposable contract to execute the distinct-release cutover and exercise pre/post-journal interruption and recovery.
6. Run focused unit tests, Ansible/IAC verification, and relevant rootless integration checks. Review diff against the acceptance criteria, commit, open PR, wait for exact-head CI, address findings, then merge under the user's authorization.

## Self-review

This plan keeps legacy backup provenance distinct from candidate activation state, uses a dedicated operator stage, and confines itself to the identified #181 code gap. Production completion still requires externally supplied protected signing/publication and target-host acceptance evidence; code CI cannot substitute for those proofs.
