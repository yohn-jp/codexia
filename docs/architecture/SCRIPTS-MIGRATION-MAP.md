# Complete scripts file-path migration map

**Document type:** implementation mapping contract (target, not implemented).  
**Baseline:** `main` commit `f0d767e003d29740e8d2f566b8c93288b55168be`; 196 tracked files under `scripts/`.  
**Owner:** [Scripts migration plan](SCRIPTS-MIGRATION-PLAN.md). **Naming rules:** [Source layout conventions](SOURCE-LAYOUT-CONVENTIONS.md).

This map is exhaustive for the baseline: **145 files moved, 51 retained**. It does **not** attest that any move was performed. The implementing PR must reconcile the entire newest `main` file list before moving: additions/deletions are not silently ignored. Paths are first-party repository-relative. Renaming a file also requires updating its imports and every executable consumer; this table alone cannot prove caller migration.

| Wave | Count | Group |
| --- | ---: | --- |
| W1 | 16 | build + shared |
| W2 | 53 | CI (including CI dashboard assets) |
| W3 | 32 | release |
| W4 | 20 | deployment |
| W5 | 24 | verification |
| KEEP | 51 | Existing standalone domains, unchanged |
| **Total** | **196** | **145 moves** |


## W1 — 16 files

| Current path | Target path |
| --- | --- |
| `scripts/build-frontend.mjs` | `scripts/build/frontend/build.mjs` |
| `scripts/frontend-oauth-config.mjs` | `scripts/build/frontend/oauth-config.mjs` |
| `scripts/frontend-oauth-config.test.mjs` | `scripts/build/frontend/oauth-config.test.mjs` |
| `scripts/html-document.mjs` | `scripts/shared/html-document.mjs` |
| `scripts/html-document.test.mjs` | `scripts/shared/html-document.test.mjs` |
| `scripts/profile-build.mjs` | `scripts/build/packaging/profile-build.mjs` |
| `scripts/profile-build.test.mjs` | `scripts/build/packaging/profile-build.test.mjs` |
| `scripts/profile-package.mjs` | `scripts/build/packaging/profile-package.mjs` |
| `scripts/profile-package.test.mjs` | `scripts/build/packaging/profile-package.test.mjs` |
| `scripts/read-regular-file.mjs` | `scripts/shared/read-regular-file.mjs` |
| `scripts/read-regular-file.test.mjs` | `scripts/shared/read-regular-file.test.mjs` |
| `scripts/root-build.mjs` | `scripts/build/root.mjs` |
| `scripts/root-build.test.mjs` | `scripts/build/root.test.mjs` |
| `scripts/ui-preview.mjs` | `scripts/build/frontend/preview.mjs` |
| `scripts/ui-preview.test.mjs` | `scripts/build/frontend/preview.test.mjs` |
| `scripts/ui-scan.mjs` | `scripts/build/frontend/scan.mjs` |

## W2 — 53 files

| Current path | Target path |
| --- | --- |
| `scripts/browser-coverage-reporter.mjs` | `scripts/ci/browser/coverage-reporter.mjs` |
| `scripts/browser-coverage-reporter.test.mjs` | `scripts/ci/browser/coverage-reporter.test.mjs` |
| `scripts/browser-shards.mjs` | `scripts/ci/browser/shards.mjs` |
| `scripts/browser-shards.test.mjs` | `scripts/ci/browser/shards.test.mjs` |
| `scripts/certify-ci.mjs` | `scripts/ci/certification/certify.mjs` |
| `scripts/ci-artifact-selection.mjs` | `scripts/ci/evidence/artifact-selection.mjs` |
| `scripts/ci-artifact-selection.test.mjs` | `scripts/ci/evidence/artifact-selection.test.mjs` |
| `scripts/ci-browser-fixture.mjs` | `scripts/ci/browser/fixture.mjs` |
| `scripts/ci-browser-image-digests.mjs` | `scripts/ci/browser/image-digests.mjs` |
| `scripts/ci-contract.mjs` | `scripts/ci/impact/contract.mjs` |
| `scripts/ci-contract.test.mjs` | `scripts/ci/impact/contract.test.mjs` |
| `scripts/ci-coverage-inputs.mjs` | `scripts/ci/evidence/coverage-inputs.mjs` |
| `scripts/ci-coverage-inputs.test.mjs` | `scripts/ci/evidence/coverage-inputs.test.mjs` |
| `scripts/ci-dashboard/analysis.mjs` | `scripts/ci/dashboard/analysis.mjs` |
| `scripts/ci-dashboard/analysis.test.mjs` | `scripts/ci/dashboard/analysis.test.mjs` |
| `scripts/ci-dashboard/collect.mjs` | `scripts/ci/dashboard/collect.mjs` |
| `scripts/ci-dashboard/collection.mjs` | `scripts/ci/dashboard/collection.mjs` |
| `scripts/ci-dashboard/diagnostics.mjs` | `scripts/ci/dashboard/diagnostics.mjs` |
| `scripts/ci-dashboard/diagnostics.test.mjs` | `scripts/ci/dashboard/diagnostics.test.mjs` |
| `scripts/ci-dashboard/site/dashboard.css` | `scripts/ci/dashboard/site/dashboard.css` |
| `scripts/ci-dashboard/site/dashboard.js` | `scripts/ci/dashboard/site/dashboard.js` |
| `scripts/ci-dashboard/site/index.html` | `scripts/ci/dashboard/site/index.html` |
| `scripts/ci-evidence.mjs` | `scripts/ci/evidence/validation.mjs` |
| `scripts/ci-evidence.test.mjs` | `scripts/ci/evidence/validation.test.mjs` |
| `scripts/ci-group.mjs` | `scripts/ci/execution/group.mjs` |
| `scripts/ci-impact.mjs` | `scripts/ci/impact/plan.mjs` |
| `scripts/ci-impact.test.mjs` | `scripts/ci/impact/plan.test.mjs` |
| `scripts/ci-parallel.mjs` | `scripts/ci/execution/parallel.mjs` |
| `scripts/ci-parallel.test.mjs` | `scripts/ci/execution/parallel.test.mjs` |
| `scripts/ci-producer-artifact.mjs` | `scripts/ci/evidence/producer-artifact.mjs` |
| `scripts/ci-profile-artifact.mjs` | `scripts/ci/evidence/profile-artifact.mjs` |
| `scripts/ci-profile-artifact.test.mjs` | `scripts/ci/evidence/profile-artifact.test.mjs` |
| `scripts/ci-task-input-proof.mjs` | `scripts/ci/evidence/input-proof.mjs` |
| `scripts/ci-task-input-proof.test.mjs` | `scripts/ci/evidence/input-proof.test.mjs` |
| `scripts/ci-task-inputs.mjs` | `scripts/ci/evidence/task-inputs.mjs` |
| `scripts/ci-task-inputs.test.mjs` | `scripts/ci/evidence/task-inputs.test.mjs` |
| `scripts/ci-task-proof-reuse.mjs` | `scripts/ci/evidence/proof-reuse.mjs` |
| `scripts/ci-task-proof-reuse.test.mjs` | `scripts/ci/evidence/proof-reuse.test.mjs` |
| `scripts/ci-timing.mjs` | `scripts/ci/dashboard/timing.mjs` |
| `scripts/ci-timing.test.mjs` | `scripts/ci/dashboard/timing.test.mjs` |
| `scripts/ci-workspace.mjs` | `scripts/ci/execution/workspace.mjs` |
| `scripts/ci-workspace.test.mjs` | `scripts/ci/execution/workspace.test.mjs` |
| `scripts/download-ci-artifacts.mjs` | `scripts/ci/evidence/download-artifacts.mjs` |
| `scripts/download-ci-artifacts.test.mjs` | `scripts/ci/evidence/download-artifacts.test.mjs` |
| `scripts/measure-ci.mjs` | `scripts/ci/dashboard/measure.mjs` |
| `scripts/reuse-ci-task-input-proof.mjs` | `scripts/ci/evidence/reuse-coverage-proof.mjs` |
| `scripts/reuse-pr-verification.mjs` | `scripts/ci/certification/reuse-merged-pr.mjs` |
| `scripts/reuse-pr-verification.test.mjs` | `scripts/ci/certification/reuse-merged-pr.test.mjs` |
| `scripts/run-browser-shard.mjs` | `scripts/ci/browser/run-shard.mjs` |
| `scripts/select-ci-evidence.mjs` | `scripts/ci/certification/select-evidence.mjs` |
| `scripts/select-ci-plan.mjs` | `scripts/ci/certification/select-plan.mjs` |
| `scripts/typecheck-tests.mjs` | `scripts/ci/execution/typecheck-tests.mjs` |
| `scripts/verify-browser-runtime.mjs` | `scripts/ci/browser/verify-runtime.mjs` |

## W3 — 32 files

| Current path | Target path |
| --- | --- |
| `scripts/backend-image-inspection.mjs` | `scripts/release/backend/image-inspection.mjs` |
| `scripts/backend-image-inspection.test.mjs` | `scripts/release/backend/image-inspection.test.mjs` |
| `scripts/backend-promotion-contract.test.mjs` | `scripts/release/backend/promotion-contract.test.mjs` |
| `scripts/backend-registry-tag.mjs` | `scripts/release/backend/registry-tag.mjs` |
| `scripts/backend-registry-tag.test.mjs` | `scripts/release/backend/registry-tag.test.mjs` |
| `scripts/backend-update-identity.mjs` | `scripts/release/backend/update-identity.mjs` |
| `scripts/backend-update-identity.test.mjs` | `scripts/release/backend/update-identity.test.mjs` |
| `scripts/component-release-record.mjs` | `scripts/release/components/record-model.mjs` |
| `scripts/component-release-record.test.mjs` | `scripts/release/components/record-model.test.mjs` |
| `scripts/component-release-version.mjs` | `scripts/release/components/version.mjs` |
| `scripts/component-release-version.test.mjs` | `scripts/release/components/version.test.mjs` |
| `scripts/frontend-promotion-contract.test.mjs` | `scripts/release/frontend/promotion-contract.test.mjs` |
| `scripts/frontend-promotion-handoff.test.mjs` | `scripts/release/frontend/promotion-handoff.test.mjs` |
| `scripts/record-component-release.mjs` | `scripts/release/components/record.mjs` |
| `scripts/release-impact.mjs` | `scripts/release/components/impact.mjs` |
| `scripts/release-impact.test.mjs` | `scripts/release/components/impact.test.mjs` |
| `scripts/release-policy.mjs` | `scripts/release/components/policy.mjs` |
| `scripts/release-policy.test.mjs` | `scripts/release/components/policy.test.mjs` |
| `scripts/release-source-gate.mjs` | `scripts/release/components/source-gate.mjs` |
| `scripts/release-source-gate.test.mjs` | `scripts/release/components/source-gate.test.mjs` |
| `scripts/resolve-backend-promotion.mjs` | `scripts/release/backend/resolve-promotion.mjs` |
| `scripts/resolve-backend-promotion.test.mjs` | `scripts/release/backend/resolve-promotion.test.mjs` |
| `scripts/verify-backend-image-identity.mjs` | `scripts/release/backend/verify-image-identity.mjs` |
| `scripts/verify-commit-source.test.mjs` | `scripts/release/components/verify-commit-source.test.mjs` |
| `scripts/verify-existing-backend-release.mjs` | `scripts/release/backend/verify-existing.mjs` |
| `scripts/verify-existing-backend-release.test.mjs` | `scripts/release/backend/verify-existing.test.mjs` |
| `scripts/verify-frontend-compatibility.mjs` | `scripts/release/frontend/verify-compatibility.mjs` |
| `scripts/verify-frontend-compatibility.test.mjs` | `scripts/release/frontend/verify-compatibility.test.mjs` |
| `scripts/verify-frontend-promotion-reader.test.mjs` | `scripts/release/frontend/verify-promotion-reader.test.mjs` |
| `scripts/verify-mixed-version.mjs` | `scripts/release/frontend/verify-mixed-version.mjs` |
| `scripts/verify-mixed-version.test.mjs` | `scripts/release/frontend/verify-mixed-version.test.mjs` |
| `scripts/verify-release-source.mjs` | `scripts/release/components/verify-source.mjs` |

## W4 — 20 files

| Current path | Target path |
| --- | --- |
| `scripts/backend-deployment-handoff-contract.test.mjs` | `scripts/deployment/handoff/backend-contract.test.mjs` |
| `scripts/backend-handoff-revalidation.test.mjs` | `scripts/deployment/handoff/revalidation.test.mjs` |
| `scripts/create-backend-deployment-certificates.mjs` | `scripts/deployment/admission/create-certificates.mjs` |
| `scripts/prepare-backend-handoff-revalidation.mjs` | `scripts/deployment/handoff/prepare-revalidation.mjs` |
| `scripts/push-app-lifecycle-contract.test.mjs` | `scripts/deployment/lifecycle/app-contract.test.mjs` |
| `scripts/push-app-lifecycle.mjs` | `scripts/deployment/lifecycle/app.mjs` |
| `scripts/push-auth-lifecycle-oidc.mjs` | `scripts/deployment/lifecycle/auth-oidc.mjs` |
| `scripts/push-deployment-admission.mjs` | `scripts/deployment/admission/validate.mjs` |
| `scripts/push-deployment-admission.test.mjs` | `scripts/deployment/admission/validate.test.mjs` |
| `scripts/push-deployment-backup.test.mjs` | `scripts/deployment/recovery/backup.test.mjs` |
| `scripts/push-deployment-certificate.mjs` | `scripts/deployment/admission/certificate.mjs` |
| `scripts/push-deployment-certificate.test.mjs` | `scripts/deployment/admission/certificate.test.mjs` |
| `scripts/push-deployment-contract.test.mjs` | `scripts/deployment/admission/contract.test.mjs` |
| `scripts/push-deployment-documentation.test.mjs` | `scripts/deployment/admission/documentation.test.mjs` |
| `scripts/push-deployment-recovery.test.mjs` | `scripts/deployment/recovery/recovery.test.mjs` |
| `scripts/push-host.test.mjs` | `scripts/deployment/lifecycle/host.test.mjs` |
| `scripts/run-manual-backend-handoff-revalidation.mjs` | `scripts/deployment/handoff/run-revalidation.mjs` |
| `scripts/verify-backend-promotion-handoff.mjs` | `scripts/deployment/handoff/verify-promotion.mjs` |
| `scripts/verify-backend-push-handoff.mjs` | `scripts/deployment/handoff/verify-push.mjs` |
| `scripts/verify-backend-push-handoff.test.mjs` | `scripts/deployment/handoff/verify-push.test.mjs` |

## W5 — 24 files

| Current path | Target path |
| --- | --- |
| `scripts/audit-runtime-deps.mjs` | `scripts/verification/dependencies/audit-runtime.mjs` |
| `scripts/audit-runtime-deps.test.mjs` | `scripts/verification/dependencies/audit-runtime.test.mjs` |
| `scripts/builtin-module-registration.test.mjs` | `scripts/verification/runtime/builtin-module-registration.test.mjs` |
| `scripts/identity-probe-client.mjs` | `scripts/verification/infrastructure/identity-probe-client.mjs` |
| `scripts/model-postgres-fixture.test.mjs` | `scripts/verification/runtime/model-postgres-fixture.test.mjs` |
| `scripts/native-mcp-acceptance.test.mjs` | `scripts/verification/runtime/native-mcp-acceptance.test.mjs` |
| `scripts/oci-better-auth-fixture.sh` | `scripts/verification/runtime/better-auth-fixture.sh` |
| `scripts/pages-smoke.mjs` | `scripts/verification/artifacts/pages-smoke.mjs` |
| `scripts/runtime-package-closure.mjs` | `scripts/verification/dependencies/runtime-package-closure.mjs` |
| `scripts/runtime-package-closure.test.mjs` | `scripts/verification/dependencies/runtime-package-closure.test.mjs` |
| `scripts/verify-backend-artifacts.mjs` | `scripts/verification/artifacts/backend.mjs` |
| `scripts/verify-backend-artifacts.test.mjs` | `scripts/verification/artifacts/backend.test.mjs` |
| `scripts/verify-backend-image.sh` | `scripts/verification/runtime/backend-image.sh` |
| `scripts/verify-deployment-config.mjs` | `scripts/verification/infrastructure/deployment-config.mjs` |
| `scripts/verify-frontend-artifact.mjs` | `scripts/verification/artifacts/frontend.mjs` |
| `scripts/verify-frontend-artifact.test.mjs` | `scripts/verification/artifacts/frontend.test.mjs` |
| `scripts/verify-migration-ledger.mjs` | `scripts/verification/artifacts/migration-ledger.mjs` |
| `scripts/verify-oci-http.mjs` | `scripts/verification/runtime/oci-http.mjs` |
| `scripts/verify-oci.sh` | `scripts/verification/runtime/oci.sh` |
| `scripts/verify-public-oauth-edge.mjs` | `scripts/verification/infrastructure/public-oauth-edge.mjs` |
| `scripts/verify-public-oauth-edge.test.mjs` | `scripts/verification/infrastructure/public-oauth-edge.test.mjs` |
| `scripts/verify-retained-evidence.test.mjs` | `scripts/verification/artifacts/retained-evidence.test.mjs` |
| `scripts/verify-unpublished-image.mjs` | `scripts/verification/artifacts/unpublished-image.mjs` |
| `scripts/verify.mjs` | `scripts/verification/run.mjs` |

## KEEP — 51 files

| Current path | Target path |
| --- | --- |
| `scripts/architecture-diagrams/atlas.css` | `scripts/architecture-diagrams/atlas.css` |
| `scripts/architecture-diagrams/atlas.js` | `scripts/architecture-diagrams/atlas.js` |
| `scripts/architecture-diagrams/index.html` | `scripts/architecture-diagrams/index.html` |
| `scripts/architecture-diagrams/pack.mjs` | `scripts/architecture-diagrams/pack.mjs` |
| `scripts/architecture-diagrams/pack.test.mjs` | `scripts/architecture-diagrams/pack.test.mjs` |
| `scripts/architecture-diagrams/smoke.mjs` | `scripts/architecture-diagrams/smoke.mjs` |
| `scripts/audit/delegate.mjs` | `scripts/audit/delegate.mjs` |
| `scripts/audit/delegate.rules.json` | `scripts/audit/delegate.rules.json` |
| `scripts/audit/delegate.test.mjs` | `scripts/audit/delegate.test.mjs` |
| `scripts/audit/export.mjs` | `scripts/audit/export.mjs` |
| `scripts/audit/export.test.mjs` | `scripts/audit/export.test.mjs` |
| `scripts/audit/packet-format.mjs` | `scripts/audit/packet-format.mjs` |
| `scripts/audit/packet-format.test.mjs` | `scripts/audit/packet-format.test.mjs` |
| `scripts/audit/portal.mjs` | `scripts/audit/portal.mjs` |
| `scripts/audit/portal.test.mjs` | `scripts/audit/portal.test.mjs` |
| `scripts/audit/publication-policy.mjs` | `scripts/audit/publication-policy.mjs` |
| `scripts/audit/repomix.config.json` | `scripts/audit/repomix.config.json` |
| `scripts/branding/README.md` | `scripts/branding/README.md` |
| `scripts/branding/codexia-icon.cjs` | `scripts/branding/codexia-icon.cjs` |
| `scripts/branding/codexia-icon.test.mjs` | `scripts/branding/codexia-icon.test.mjs` |
| `scripts/branding/generate-icons.mjs` | `scripts/branding/generate-icons.mjs` |
| `scripts/branding/preview.html` | `scripts/branding/preview.html` |
| `scripts/graphify-pages/analysis.mjs` | `scripts/graphify-pages/analysis.mjs` |
| `scripts/graphify-pages/analysis.test.mjs` | `scripts/graphify-pages/analysis.test.mjs` |
| `scripts/graphify-pages/candidates.py` | `scripts/graphify-pages/candidates.py` |
| `scripts/graphify-pages/explorer.html` | `scripts/graphify-pages/explorer.html` |
| `scripts/graphify-pages/explorer.ui.test.mjs` | `scripts/graphify-pages/explorer.ui.test.mjs` |
| `scripts/graphify-pages/pack.mjs` | `scripts/graphify-pages/pack.mjs` |
| `scripts/graphify-pages/pack.test.mjs` | `scripts/graphify-pages/pack.test.mjs` |
| `scripts/ios/package-unsigned-ipa.mjs` | `scripts/ios/package-unsigned-ipa.mjs` |
| `scripts/ios/validate-web-bundle.mjs` | `scripts/ios/validate-web-bundle.mjs` |
| `scripts/ios/validate-web-bundle.test.mjs` | `scripts/ios/validate-web-bundle.test.mjs` |
| `scripts/pages-ui/navigation.css` | `scripts/pages-ui/navigation.css` |
| `scripts/pages-ui/navigation.js` | `scripts/pages-ui/navigation.js` |
| `scripts/pages-ui/navigation.mjs` | `scripts/pages-ui/navigation.mjs` |
| `scripts/pages-ui/navigation.test.mjs` | `scripts/pages-ui/navigation.test.mjs` |
| `scripts/performance/README.md` | `scripts/performance/README.md` |
| `scripts/performance/artifacts.mjs` | `scripts/performance/artifacts.mjs` |
| `scripts/performance/artifacts.test.mjs` | `scripts/performance/artifacts.test.mjs` |
| `scripts/performance/browser-probes.mjs` | `scripts/performance/browser-probes.mjs` |
| `scripts/performance/browser.mjs` | `scripts/performance/browser.mjs` |
| `scripts/performance/ci-browser-smoke.mjs` | `scripts/performance/ci-browser-smoke.mjs` |
| `scripts/performance/common.mjs` | `scripts/performance/common.mjs` |
| `scripts/performance/core.mjs` | `scripts/performance/core.mjs` |
| `scripts/performance/dataset.mjs` | `scripts/performance/dataset.mjs` |
| `scripts/performance/instrument-node.mjs` | `scripts/performance/instrument-node.mjs` |
| `scripts/performance/performance.test.mjs` | `scripts/performance/performance.test.mjs` |
| `scripts/performance/postgres-fixture.mjs` | `scripts/performance/postgres-fixture.mjs` |
| `scripts/performance/run.mjs` | `scripts/performance/run.mjs` |
| `scripts/performance/server.mjs` | `scripts/performance/server.mjs` |
| `scripts/performance/summarize.mjs` | `scripts/performance/summarize.mjs` |

## Integrity requirements

- All 196 current paths appear **once** above, and all 196 target paths are **unique**. A KEEP row stays at its original path; other rows must be actual moves (not copies).
- The 136 former root-level files go to responsibility owners. The nine `ci-dashboard/` assets move as one resource bundle to `ci/dashboard/`. No external route/URL rename is implied.
- Existing audit/performance/branding/iOS/Graphify/diagram/Pages navigation files remain at their paths. Do not reorganize them as a side effect.
- Implementation PRs update this table only if current main changes or an architecture decision changes ownership, in which case update the normative design first and explain the deviation.
