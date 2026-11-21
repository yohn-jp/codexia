# CI Observatory — GitHub Pages timing dashboard

Status: **implemented as read-only observability; the first live Actions collection and Pages deployment require a main-branch run**. This page does not certify, shorten or replace required checks.

## Deployment and ownership

- Single publishing authority: [Repository Audit Pages](../../.github/workflows/repository-audit.yml). The CI dashboard is bundled at **/ci/** inside its existing Pages artifact. No second Pages publisher or competing root site.
- Triggers are unchanged: main push or manual workflow dispatch, plus the existing audit PR preview. **No schedule and no workflow_run trigger.** PR previews intentionally contain an empty, explicitly labeled dataset.
- Existing Pages upload/deploy actions and the **github-pages** environment are reused. Pages Source must be GitHub Actions.
- Read-only **actions: read** permission is added to the existing packaging job. No logs, artifacts, DB access, tokens in published JSON or untrusted PR code execution.
- Published URL: the repository's configured Pages base plus **/ci/** (typically https://yohn-jp.github.io/codexia/ci/ unless a custom domain is configured).
- Data is refreshed during each eligible main Pages publish, **not** on every PR completion. To manually refresh without a main push, dispatch Repository Audit Pages on main. This avoids rerunning the heavy branch audit for each PR.

## Source and sampling

Collector: [collect.mjs](../../scripts/ci-dashboard/collect.mjs); analyzer: [analysis.mjs](../../scripts/ci-dashboard/analysis.mjs); [static client](../../scripts/ci-dashboard/site/).

1. Query up to four recent pages of repository pull_request Actions runs (up to 400 records). Include only GitHub-provided PR number and exact PR head SHA.
2. Group by PR number and head SHA. Keep the latest run per workflow ID, and only groups containing an observed Verify Codexia. Bound output to 24 PR revisions and 90 workflow runs. Mark truncated history.
3. Fetch attempt-scoped job inventories and recorded step timestamps. Fail the collector on incomplete job pagination; never infer skipped or cancelled work as successful validation.
4. Only public run/job/step metadata is serialized. No downloaded logs, tokens, artifacts or executable PR code.

## Metrics and limitations

| Metric | Definition |
| --- | --- |
| Observed PR window | First selected workflow creation to last selected job completion, only if all selected workflows finished. Not proof that every required check was discovered. |
| Verify certification | Certification job completion minus attempt boundary. Separate from whole Verify workflow elapsed. |
| Runner time | Sum of current-attempt job execution intervals, excluding skipped/carried jobs. Not billed minutes. |
| Queue intervals | Sum of recorded job creation-to-start intervals. Does not isolate runner capacity, dependency waiting or network pulls. |
| Blocking chain | Walk the current Verify YAML needs graph backwards from successful certification, selecting each latest completed predecessor. The DAG comes from the workflow file; dynamic job names are matched to its templates. |
| Longest steps | API step start-to-end intervals. Install/container phases are not pure download timings. |
| History p50 / p90 | Nearest-rank of complete initial-attempt selected workflow windows; not normalized for full/affected plans, runner/image, cache or missing external checks. |

The chain is the **observed latest-finishing dependency chain**, not a calculated counterfactual critical path or guaranteed saving. For unavailable or ambiguous DAG/timestamps, show unknown rather than inventing a value. A long job outside the certification path may still affect total workflow completion but not the certification gate.

The sample does **not** establish all required checks: bounded history can omit workflows; third-party checks/branch rules are not enumerated; some runs lack PR head association. Verify is canonical certification, not the repository's whole merge-protection policy. **Never use the dashboard as release or merge authority.** See [CI/CD contract](CI-CD.md).

## Optimization procedure

1. Compare at least three matched successful **full-plan** runs for the same tested source classes, profiles, toolchain, runner/image and cache state where feasible.
2. Break down plan, dependency install, producer build, browser test, queue intervals and certification. Confirm whether a candidate is on the observed blocking chain.
3. Change only a demonstrated bottleneck without weakening per-task proofs, exact-source certification, browser coverage, PostgreSQL isolation or producer identity.
4. Re-measure equivalent runs and compare **both** gate completion and runner seconds. A faster job outside the gate is not necessarily a faster PR.
5. Compare Xcode/ARM and Intel only using equivalent work, not hardware specifications. Xcode 27 is native iOS packaging, not a replacement for Ubuntu browser certification.

## CI impact and iOS agreement

Pure changes under **scripts/ci-dashboard/**, **scripts/ios/** and **app/native/**, or to the manual iOS IPA workflow, select the canonical **unit-root + coverage** task pair instead of the full browser/OCI graph. Unknown paths remain full; mixed shared application changes retain affected tests. This addresses the unnecessary all-tasks selection observed in [#449](https://github.com/yohn-jp/codexia/issues/449). Its measured improvement must still be checked against a real PR run.

The unsigned IPA workflow runs for native-related PR changes or manual dispatch, and moves to **xcode-27 ARM64** and **iOS 27.0 minimum**. React + Ionic + Capacitor remain the architecture; Swift/SwiftUI do not replace the editor. A native unsigned archive does not prove Simulator acceptance, Apple signing, Keychain or physical installation. See [iOS client contract](../deployment/IOS-CLIENT.md).

## Local checks

With repository Node/pnpm dependencies installed:

~~~sh
node --test scripts/ci-dashboard/*.test.mjs scripts/ci-impact.test.mjs
~~~

An empty static preview requires no GitHub credentials:

~~~sh
mkdir -p /tmp/codexia-audit-site
node scripts/ci-dashboard/collect.mjs /tmp/codexia-audit-site --preview
~~~

If GitHub's read-only telemetry API fails during main publishing, the collector writes a visible unavailable state to /ci/data.json rather than erasing the separate audit portal. Inspect the packaging job logs and summary; do not interpret a green Pages deployment as successful data collection. The browser client renders job names as text and permits only constrained GitHub run URLs.
