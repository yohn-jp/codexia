# CI Observatory — GitHub Pages timing dashboard

CI Observatory displays a progressively enumerated inventory of public GitHub Actions PR revisions and retrieves job/step metadata only for the selected revision inside the development portal. The selected PR, full executed SHA and observation time identify the source of each result. See the [CI screen design](../design/DEVELOPMENT-PAGES-UX.md#5-ci分析のux).

## Deployment and ownership

- Single publishing authority: [Repository Audit Pages](../../.github/workflows/repository-audit.yml). The CI dashboard is bundled at **/ci/** inside its existing Pages artifact. No second Pages publisher or competing root site.
- Triggers are unchanged: main push or manual workflow dispatch, plus the existing audit PR preview. **No schedule and no workflow_run trigger.** The static bundle contains no captured run data.
- Existing Pages upload/deploy actions and the **github-pages** environment are reused. Pages Source must be GitHub Actions.
- The packaging workflow needs only **contents: read**. The browser requests public Actions metadata directly from GitHub's unauthenticated API.
- Published URL: the repository's configured Pages base plus **/ci/** (typically https://yohn-jp.github.io/codexia/ci/ unless a custom domain is configured).
- Data is fetched when a visitor opens **/ci/**, so it reflects current public run metadata without publishing a generated data file. The initial request reads up to 100 workflow runs. **残りのPR・リビジョンを全件読み込む** fetches successive inventory pages without the former 20-PR/20-workflow cap. Job/step requests are made only for the selected revision (up to 20 job pages per workflow, failing rather than silently truncating beyond that bound). API rate limits, history retention and API search-result limits can still prevent a truly complete historical inventory; the UI must report that it is partial, not assert completeness.

## Source and sampling

Collector: [collect.mjs](../../scripts/ci/dashboard/collect.mjs); analyzer: [analysis.mjs](../../scripts/ci/dashboard/analysis.mjs); [static client](../../scripts/ci/dashboard/site/).

1. The browser initially queries one page of repository `pull_request` Actions runs (100 records). The full-history control requests additional pages until the API stops returning pages or an error interrupts the scan. After ten full pages in one filtered GitHub search (the 1,000-result search window), it advances a dated `created` cursor to continue with older runs and deduplicates overlapping boundary records. Runs are deduplicated by run ID across pages. The status reports fetched runs, GitHub's reported total when supplied, unresolved associations, and whether more history may exist.
2. A run is attributable only when `run.head_sha` is a valid executed source SHA and GitHub associates it with exactly one distinct PR number. The mutable `pull_requests[].head.sha` is not used for grouping. Runs with missing or ambiguous PR/source identity are excluded and counted as unresolved. **No Verify requirement or fixed PR/workflow count may hide otherwise attributable revisions.**
3. Group by PR number and executed `run.head_sha`; retain the newest attempt per workflow ID. Do not download every group's jobs during enumeration. Selecting a revision downloads its workflow attempts' job/step records, and the browser caches those observations by the exact run IDs and attempts. A new inventory page invalidates a cache entry if its run group changed.
4. Historical comparison and diagnostic JSON use only revisions whose job/step metadata has actually been fetched. A revision without an observed Verify remains selectable, but is not a successful Verify comparison sample. Unloaded revisions have unknown timing, not zero.
5. The browser fetches only public run/job/step metadata. No downloaded logs, tokens, artifacts or executable PR code. An API rate-limit or pagination failure retains already enumerated revisions but must not certify a complete history. The UI's full-history control means **attempt to enumerate all GitHub API-accessible history**, not a guarantee that every historical PR commit or expired run exists in the API.

The selected revision can be shared through `?pr=<number>&sha=<executed-sha>` while GitHub still exposes its run. A direct link scans subsequent inventory pages until that revision is found or the available API history is exhausted. Each workflow links to its recorded run. Expanding a job shows its recorded steps, including steps with unavailable timing.

## Bottleneck attribution (first-attempt successful Verify only)

- The **last canonical validation leaf** is the latest finished required validation job preceding successful `certification`. Its observed dependency ancestry is derived from the exact published Verify needs graph, not inferred from bar lengths alone.
- Profile validation is called through `profile-core` and `profile-full`; each reusable call owns its `build-<profile>` job and corresponding `browser-<group>` matrix. Interpret the matching Build → Browser dependency within that call as the artifact producer edge. The two profile calls are independent siblings under Plan, and Certification waits for both calls and the other required lanes. Job names remain the validation identities; a reusable workflow call or matrix display name does not replace the canonical task inventory.
- **Runner queue** is the recorded job creation-to-start interval. **Before validation** is the job start to `Run selected validations` step start; it may include VM/container provisioning, checkout, dependency installation, artifact restoration and runtime checks. It is **not** a pure image pull or startup measurement.
- **Container initialization** is the `Initialize containers` step duration when GitHub provides it. **Validation** is only the duration of `Run selected validations`; it includes all tasks scheduled by `group.mjs` and is not a sum of per-task execution times. **After validation** is the interval from that step's end to the job's end.
- **Runner-up gap** is the observed finish-time difference between the last canonical validation leaf and the second-latest one. **Near finish** lists other leaves within 15 seconds of that finish. The gap is not guaranteed time saved by optimizing one job: shared resource contention and reruns can alter the result.
- **Certification tail** is last-leaf completion to certification completion, including dependency/job scheduling and the certification steps.
- Missing, cancelled, failed, carried or subsequent-attempt evidence yields an unavailable attribution, not a successful claim. Missing step timestamps render individual phase values unknown, not zero.
- Individual tasks already report timing in the `group.mjs` logs and `ci-evidence-*/report.json` artifacts. The public, no-token dashboard deliberately does not download job logs or authenticated artifacts, and therefore **cannot identify the slowest Playwright task**. Use the exact run's logs or evidence artifact for task-level attribution; a future telemetry export must be independently reviewed for permissions, privacy and source identity.

## Copyable diagnostic JSON

**診断JSONをコピー** copies a source-bound, selected-revision
`codexia-ci-diagnostics/v1` JSON document for the selected PR revision
using the browser's HTTPS clipboard API. It adds no alternate publisher, file export,
GitHub token, new API fetch, CI task or certification gate. Copy failure is reported,
not silently treated as success.

The copied diagnostic model aggregates:

- Executed source SHA, PR number, observation timestamp, enumerated history/identity
  coverage, workflow IDs, attempts, outcomes, timing and current-attempt job/step evidence.
- Per-job queue and execution elapsed seconds, GitHub runner labels, raw step timestamps
  and durations, classified phase totals, validation start/end, container initialization,
  and missing step counts. A missing stage is `null`, never zero.
- Observed Verify dependency family, prerequisite release-to-start interval,
  last canonical leaf, latest-finishing competing leaves, remaining finish-time slack,
  certification tail, longest jobs/steps and measured runner time by step phase.
- Bounded historical comparisons: first-attempt complete successful Verify runs
  with the **same executed job-name set**, among previously inspected revisions, plus sample count, p50/p90/min/max/mean
  for certification/queue/runner and each job. Matching names do not prove matching
  selected tasks, cache state, VM/image, source input closure or runner load.
- Explicit `interpretation.notMeasured` reasons for unavailable telemetry.

**Collection boundary:** The browser only reads public GitHub Actions REST run/job/step
metadata. The existing per-task timings in `group.mjs` logs and `ci-evidence`
artifacts cannot be read as API step metrics. Likewise, CPU PSI, memory usage,
I/O, per-test Playwright timings, pure image pull and cache-hit evidence remain
unavailable without separately authorized CI telemetry collection. The JSON does not
fabricate those values, retrieve logs or artifact ZIPs, or claim all branch-protection
checks have been sampled. Observed dependencies and slack are not counterfactual
speedup predictions.

## Metrics and limitations

| Metric | Definition |
| --- | --- |
| Observed PR window | First selected workflow creation to last selected job completion, only if all selected workflows finished. Not proof that every required check was discovered. |
| Verify certification | Certification job completion minus attempt boundary. Separate from whole Verify workflow elapsed. |
| Runner time | Sum of current-attempt job execution intervals, excluding skipped/carried jobs. Not billed minutes. |
| Queue intervals | Sum of recorded job creation-to-start intervals. Does not isolate runner capacity, dependency waiting or network pulls. |
| Blocking chain | Walk the current Verify and reusable profile workflow needs graphs backwards from successful certification, selecting each latest completed predecessor. The DAG comes from those workflow files; reusable call identities and dynamic matrix job names are matched to their templates. |
| Longest steps | API step start-to-end intervals. Install/container phases are not pure download timings. |
| History p50 / p90 | Nearest-rank of **inspected** complete initial-attempt PR/source groups containing Verify; uninspected, incomplete or Verify-less groups are excluded. Not normalized for full/affected plans, runner/image, cache or missing external checks. |

The chain is the **observed latest-finishing dependency chain**, not a calculated counterfactual critical path or guaranteed saving. For unavailable or ambiguous DAG/timestamps, show unknown rather than inventing a value. A long job outside the certification path may still affect total workflow completion but not the certification gate.

The inventory does **not** establish all required checks: API history retention, partial pagination and unresolved associations can omit workflows; third-party checks/branch rules are not enumerated; some runs lack PR head association. Verify is canonical certification, not the repository's whole merge-protection policy. **Never use the dashboard as release or merge authority.** See [CI/CD contract](CI-CD.md).

## Optimization procedure

1. Compare at least three matched successful **full-plan** runs for the same tested source classes, profiles, toolchain, runner/image and cache state where feasible.
2. Break down plan, dependency install, each profile Build, same-profile Browser matrix, artifact transfer/restoration, queue intervals and certification. Confirm whether a candidate is on the observed blocking chain.
3. Change only a demonstrated bottleneck without weakening per-task proofs, exact-source certification, browser coverage, PostgreSQL isolation or producer identity.
4. Re-measure equivalent runs and compare **both** gate completion and runner seconds. A faster job outside the gate is not necessarily a faster PR.
5. Compare Xcode/ARM and Intel only using equivalent work, not hardware specifications. Xcode 27 is native iOS packaging, not a replacement for Ubuntu browser certification.

## CI impact and iOS agreement

Pure changes under **scripts/ci/dashboard/** select the canonical **unit-root + coverage** task pair instead of the full browser/OCI graph. Unknown paths remain full; mixed shared application changes retain affected tests. This addresses the unnecessary all-tasks selection observed in [#449](https://github.com/yohn-jp/codexia/issues/449). Its measured improvement must still be checked against a real PR run.

The [Native iOS workflow](../../.github/workflows/ios-editor.yml) builds the unsigned SwiftUI app on manual dispatch using Xcode 27 on ARM64 with a minimum deployment target of iOS 27.0. Simulator testing, device signing and physical installation have separate acceptance criteria in the [iOS client contract](../deployment/IOS-CLIENT.md).

## Local checks

With repository Node/pnpm dependencies installed:

~~~sh
node --test scripts/ci/dashboard/*.test.mjs scripts/ci/impact/plan.test.mjs
~~~

The static preview bundle requires no GitHub credentials:

~~~sh
mkdir -p /tmp/codexia-audit-site
node scripts/ci/dashboard/collect.mjs /tmp/codexia-audit-site --preview
~~~

If GitHub's public telemetry API is unavailable or rate-limited, the page shows the error with a retry control and a link to GitHub Actions. The browser client renders job names as text and permits only constrained GitHub run URLs.
