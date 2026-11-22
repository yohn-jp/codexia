# Issue #615 audit inventory

The baseline is main commit `52cd5f6b21fdb2114a43d9bff482b7eca889c5d5`. The audit uses the [test architecture](../../../docs/verification/TEST-ARCHITECTURE-OPTIMIZATION.md), the [CI/CD contract](../../../docs/verification/CI-CD.md), and the staged acceptance criteria in [issue #615](https://github.com/yohn-jp/codexia/issues/615).

## Inventory method

The inventory starts with all Git-tracked paths matching `*.test.*`, `*.spec.*`, or `*.acceptance.*`. Additional entries come from workspace runner commands, the scripts and workflow execution graph, Ansible shell/Python verification, explicit acceptance commands, and checked-in test support referenced by suites or their harnesses. The inventory includes optional benchmark and measurement harnesses, since those can supply distinct evidence. Published performance samples and closed migration evidence stay in their existing archives. Their live verification scripts and tests have entries here.

Shared fixture and harness ownership is recorded in `shared.tsv`, including assets physically located within a domain. CI retains its deployment-owned shell and Ansible fixtures. A file's row determines who can edit it. Report cross-domain dependencies to the other owner before changing them.

## Audit records

Each row starts as `UNASSESSED`. The owning audit records the contract source, observable behavior, independent oracle, concrete counterexample, proof layer, real and doubled dependencies, any replacement proof, execution cost, action, verification, and commit. Assign `KEEP`, `REWRITE`, `MERGE`, or `DELETE` after source assessment. Finish a row once its action and verification are recorded. For a support file, identify its consuming proof and the fixture or harness failure that would invalidate that proof.

For a replacement or deletion, record the old assertion and the surviving contract and counterexample. Preserve existing coverage until the replacement has demonstrated equivalent detection. Record a negative control per critical area, before and after timing, and any environment-dependent gaps. Add newly discovered and newly introduced test files with an owner. Reconcile the final audit branch against the inventory, including files removed with documented proof.

## Existing work

- [PR #614](https://github.com/yohn-jp/codexia/pull/614) at `deb856063409e026a2a8cde06b71fb8c48ee3264` covers CI input identity, browser image and shard evidence, and built-in module registration. The affected baseline files are annotated in the TSVs. It also adds `scripts/ci-browser-image-digests.mjs`, which enters scope when that change is integrated. [Certification](https://github.com/yohn-jp/codexia/actions/runs/45028364994/job/137227558587)
- [PR #616](https://github.com/yohn-jp/codexia/pull/616) at `8520b6e56e92731af5a1d22a7a5fe57453af0f49` covers persistence save and replay gates, and fixes the cancellation race between durable binding and a remote save. The affected test is annotated. [Certification](https://github.com/yohn-jp/codexia/actions/runs/45029086752/job/137229754652)

Both PRs were open at inventory time. Reuse their evidence and validate the integrated source before closing the associated rows.
