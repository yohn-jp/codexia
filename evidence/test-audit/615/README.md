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

## Result ledgers and final reconciliation

The TSVs in this directory record the original inventory and its ownership. The completed domain records are committed in `evidence/test-audit-615/*.tsv` on the audit result branches and gathered on the integration branch. Resolve each baseline path to one final authoritative row. When a follow-up supersedes a decision, record its source and reason and use that row for the final count. In particular, the follow-up to #614 owns the final disposition of `packages/contracts/src/index.test.ts`.

Reconcile against the exact integration commit. Re-enumerate tracked test names and test-only support from the final test runners and workflows using the inventory method above. Name matching alone omits helpers, fixtures, snapshots and CI verification scripts. Compare the old and final trees to find paths added, renamed or removed during the audit.

```sh
baseline=52cd5f6b21fdb2114a43d9bff482b7eca889c5d5
final=$(git rev-parse HEAD)
git diff --name-status --find-renames "$baseline" "$final"
git ls-tree -r --name-only "$final" | rg '\.(test|spec|acceptance)\.'
```

Use the TSV header to read each record's `path`, `decision`, evidence commit (`commit_sha` or `evidence_sha`) and verification result (`action_and_verification` or `result`). For the final comparison, build three path sets from the original inventory, the final tree's re-enumerated verification assets and the authoritative result rows.

- Every baseline path must have a result row with a completed disposition. Report missing and ambiguous rows and any records still marked unassessed. Count each baseline path once.
- Record new verification assets with result rows and report their count separately. Investigate any result path absent from the original inventory and final verification assets.
- For an absent baseline path, verify `MERGE`, `DELETE` or a recorded rename in the Git diff. Resolve a rename to its final path. Where a contract survived removal, check the replacement path and counterexample evidence. Keep the removed path in the baseline count.
- Resolve each evidence SHA with `git cat-file -e "$sha^{commit}"` after fetching its branch or PR ref if needed. Compare the tested change with the integrated diff and check that the recorded verification applies. A source SHA can differ after integration. The final required CI must validate the exact integration commit.
- Check the results and artifacts for the final commit against [issue #615](https://github.com/yohn-jp/codexia/issues/615). Keep optional historical or environment-dependent probes marked unexecuted when their required inputs were unavailable. A pending or skipped required check does not establish success.

The reconciliation is complete only after the final inventory, authoritative rows, retained contracts and exact-head CI agree.
