# Scripts source-layout migration — implementation plan

**Status: planned; no source files have been moved by this documentation change.**  
**Owner:** `scripts/` path migration, consumer rewiring and verification delivery. **Audience:** implementers/reviewers.  
**Normative contract:** [Source layout and naming](SOURCE-LAYOUT-CONVENTIONS.md). **Complete per-file authority:** [Scripts path map](SCRIPTS-MIGRATION-MAP.md). **Verification authority:** [CI/CD](../verification/CI-CD.md), [Test architecture](../verification/TEST-ARCHITECTURE-OPTIMIZATION.md). This is an implementation plan, not a second CI task inventory.

## 1. Baseline, scope and destination

The inspected `main` baseline is `f0d767e003d29740e8d2f566b8c93288b55168be` (Git tree not truncated). It contains **196 files** under `scripts/`: **136** directly under `scripts/`, **60** in subdirectories. The explicit map accounts for every file:

| Decision | Files | Scope |
| --- | ---: | --- |
| Relocate | **145** | All 136 root files, plus 9 files in `scripts/ci-dashboard/` |
| Preserve at current path | **51** | Existing `audit/`, `performance/`, `branding/`, `ios/`, `graphify-pages/`, `architecture-diagrams/`, `pages-ui/` |
| Total | **196** | No unclassified file, collision or permanent old-path alias is acceptable |

File count and path map describe **this baseline**; each implementation wave must re-run Git inventory on the latest `main` and reconcile added/deleted files **before** moving anything. No binary, generated output, `.agents/` bundle or external vendor file is within the requested move.

The path map is a design decision, not an instruction to instantiate reserved but empty directories. Preserve existing file contents and observable behavior except the minimum changes necessary for paths, imports, commands and documented contracts. Do not move production code into `packages/` as an incidental refactor, and do not combine this effort with TypeScript 7 / vanilla-extract implementation.

## 2. Execution order and dependency boundaries

| Wave | Root-file target (plus nested moves) | Files | Deliverable / dependency | Required evidence |
| --- | --- | ---: | --- | --- |
| **W0** | Documentation and path inventory | 0 moved | This design PR; basename/owner consistency, exhaustive map, no runtime edits | Full current-tree mapping reconciliation and documentation checks |
| **W1** | `build/`, `shared/` | 16 | Move build/packaging/preview and two cross-owner helpers; update package scripts and import consumers | `pnpm build`, profile core/full, `pnpm run test:scripts`, typechecks, relevant build/OCI jobs |
| **W2** | `ci/` incl. `ci-dashboard/` | 53 | **Atomic CI migration**: contract, impact, execution, browser, evidence, certification and Observatory. Depends on W1 destinations | Exact-source plan, NOT_SELECTED semantics, proof reuse, all CI contract tests, Verify workflow, browser E2E and audit Pages generation |
| **W3** | `release/` | 32 | Frontend/backend/component release and promotion; update standalone release workflows and downstream references. Depends on W2 inventory paths | Release source gates, promotion/handoff assertions, OCI/image and frontend artifact verification; no relaxation of release eligibility |
| **W4** | `deployment/` | 20 | Admission, lifecycle, handoff and recovery; update deployment workflows/scripts and security/identity path references. Depends on W3 | Deployment verification, authorization/preflight/recovery contract tests, disposable host/Ansible/Quadlet checks where affected |
| **W5** | `verification/` | 24 | OCI/runtime, dependency closure, artifacts, infrastructure, top-level verify runner; update final references. Depends on W1–W4 | Core/full OCI, verification/infra tests, static Pages artifact checks and full Verify, CodeQL/security as selected |
| **W6** | Final closure (no extra source move) | 0 moved | Audit all active paths, relative imports, docs, static analysis inputs, script permissions, no compatibility shims | Full CI on final exact SHA; record distinct executed/not-executed checks and signed-off map reconciliation |

Wave totals are **16 + 53 + 32 + 20 + 24 = 145**. Each wave is a separate PR from current `main`, with its own mapping subset, complete caller changes and green CI before merge. W2 is one coherent change because its task registry, impact planner, evidence and certifier form a single trust boundary; splitting those across unsynchronized PRs would introduce unsafe intermediate CI states. Do not open parallel PRs that edit the same canonical workflow or task authority; independent preparatory audits may run in parallel, integration does not.

### Per-wave change contract

1. Re-fetch `main` HEAD and compare its script tree to the baseline path map. Account for every added, deleted or renamed file; amend the design/map first if a destination changes.
2. Build an **incoming reference inventory** for each source path across tracked first-party files (ESM imports, `new URL(..., import.meta.url)`, `spawn/exec`, shell invocation, npm/pnpm scripts, workflows, fixtures, config, docs and static content assembly). Include references by suffix/basename, not only exact `scripts/<name>` strings. Existing generated outputs are not a migration authority.
3. Relocate paired implementation/test in one change. Repair relative imports to siblings, repository-root resolution, absolute execution entrypoints, executable bits and source-bound artifact/receipt/manifest paths. Do not create wrappers or a duplicate alias package.
4. Update every **active consumer and canonical assertion** within the same PR. In particular, updating `scripts/ci/impact/contract.mjs` must not leave a second task inventory, and path-driven impact/source closure must retain the same affected-selection and fail-closed behavior.
5. Run the focused tests for the owned boundary and actual commands through the moved entrypoints. Then run GitHub Actions on the exact PR HEAD, inspect job logs and artifacts, and keep the PR open until the required checks are green. An untested E2E or host-dependent acceptance must be reported as not verified.
6. Inspect the diff for logic changes beyond path normalization and necessary fixture updates; isolate unrelated design work to a separate issue. Merge only when checks and review gates permit, then start the next wave from new `main`.

## 3. Known entrypoints and external consumers

These are **confirmed examples**, not an exhaustive caller index; W1–W5 must enumerate all callers through source-wide search.

| Consumer / dependency | Example current reference | Required migration check |
| --- | --- | --- |
| root `package.json` | `scripts/root-build.mjs`, `scripts/ci-workspace.mjs`, `scripts/verify.mjs`, `scripts/audit-runtime-deps.mjs`, `scripts/build-frontend.mjs` | All package commands still launch intended file; `scripts/**/*.test.mjs` discovers relocated tests |
| `.github/workflows/verify.yml` | `scripts/ci-impact.mjs`, `scripts/ci-group.mjs`, `scripts/certify-ci.mjs` | Plan/selector, job matrices, evidence ID/digest and final certification remain exact-source |
| `.github/workflows/repository-audit.yml` | `scripts/ci-dashboard/collect.mjs`, `scripts/ci-timing.mjs`, `scripts/ci-contract.mjs` | CI dashboard Pages assets and scripts have correct relative layout and provenance |
| `.github/workflows/backend-release.yml` | `scripts/profile-build.mjs`, `scripts/read-regular-file.mjs`, `scripts/verify-backend-image.sh` | Build/promotion/registry/source-gate commands run from approved paths |
| `scripts/ci-task-inputs.mjs` and friends | Script paths embedded in task invocation recipes | Update fingerprints/recipes intentionally; certify task inventory and failure handling, not broad skips |
| `scripts/ci-dashboard/collect.mjs` | `../ci-contract.mjs`, `../ci-timing.mjs`, `../../.github/workflows/verify.yml` | Resolve new sibling/root-relative resource paths and emitted CI dashboard bundle |
| `scripts/verify.mjs` | `scripts/verify-oci.sh` | Execute the new OCI path and preserve local verification coverage |
| Markdown and architecture docs | Links into `scripts/` | Update normative and live operational links; keep historical evidence explicitly historical |

Do not equate GitHub's file search excerpts with a complete incoming-reference inventory. Search the entire tracked Git tree in each implementation PR, including Bash, Python, CSS/HTML assets, Dockerfile, JSON, workflow YAML and test snapshots. If a path is a wire-visible identifier or package artifact, assess it as a separate interface rather than blindly replacing it.

## 4. Required test scenarios

| Scenario | Expected behavior |
| --- | --- |
| Docs-only PR after migration | Only impacted documentation assertion/coverage checks run; no proof needed for `NOT_SELECTED` tasks |
| CI script path or CI ownership change | Full or otherwise provably complete affected CI checks, exact-HEAD certification; no skipped selected task |
| Missing/stale exact-main proof | Execute the **selected** test; do not expand impact solely because a proof is unavailable |
| Unknown or missing diff | Safe full plan, no loss of coverage |
| Tampered PR base or source receipt | Certification rejects |
| Changed producer/consumer path | Input closure and artifact identity are revalidated; no stale manifest path accepted |
| Core and Full profiles | Frontend/backend builds and browser authoring tests consume correct profile outputs |
| Repository Audit Pages | Portal/CI dashboard, Graphify and architecture viewer retain their URLs/assets |
| OCI/deployment scripts | Correct executable mode, working directory, bind mount/context paths, runtime image checks and restricted authorization remain intact |
| All relocated `.test.mjs` | Node glob and focused runners still discover and execute them |

### Completion criteria

- The latest tracked `scripts/` tree equals the reconciled mapping: **no original path left for a moved source**, no missing targets, no duplicate implementation, no collision and no symlink compatibility layer.
- Every active literal path, relative import, workflow expression, test fixture, doc link and executable source-input inventory points to the new owner. Any archival text retaining a historical path is explicitly marked historical and cannot be executed as a command.
- The task inventory, impact selection, NOT_SELECTED status, exact-source and artifact-certification checks remain authoritative and pass; `main` still requires its existing complete verification/reuse contract.
- Unit/contract/type/build/OCI/browser/security/Pages/infra results are recorded **for the actual final head and scope**. A skipped check is never reported as passed. No broad suppression or test exclusion is acceptable as a relocation workaround.
- Design documents are updated to the **actual** adopted final paths in the implementation PRs. This plan's baseline map remains a migration contract, not a perpetual runtime manifest.

## 5. Failure and rollback

Each wave must be atomic: a blocked or failing PR is **not** partially merged. Revert that wave's changes in its branch and repair the specific path/consumer/test cause. After a merged wave, subsequent work must start from the new `main` and may not resurrect former executable paths as compatibility shims. Preserve exact PR/CI evidence and review status; do not claim green based on an older SHA.
