# Source layout and file naming — normative contract

**Status: accepted target architecture; W1 and W2 are adopted on main, and W3–W5 paths are implemented in the Issue #690 migration PR.**
**Owner:** source layout, naming and script responsibility boundaries. **Audience:** contributors, implementation agents and reviewers.  
**Authority:** [Documentation authority](DOCUMENTATION-AUTHORITY.md) and [Internal boundaries](INTERNAL-BOUNDARIES.md). Runtime and CI contracts remain owned by [CI/CD](../verification/CI-CD.md), [Dependency policy](DEPENDENCY-POLICY.md) and their respective domain designs. This document defines **where code belongs**, not a second implementation, task inventory or deployment interface.

## 1. Scope and design rules

- Apply to **new or relocated first-party source** in `scripts/`, `packages/`, `modules/`, `app/` and first-party tools. The approved first migration is **`scripts/` only**, governed by [Issue #690](https://github.com/yohn-jp/codexia/issues/690).
- A directory denotes a **responsibility owner**, not file type, language, length, activity verb or presumed execution frequency. Place each implementation at one owner. Keep imports pointing to that owner; do not duplicate logic to satisfy old paths.
- Name a file by its **local role** within its owner. Do not repeat the directory's domain prefix (e.g., `ci/impact/plan.mjs`, not `ci/impact/ci-impact.mjs`). Names must be intelligible in an editor/search result without relying on `index`.
- Prefer `scripts/<domain>/<responsibility>/<file>` (three levels below the repository root); a domain-level entry such as `scripts/build/root.mjs` is permitted. Add a deeper level only for separately owned resources such as `ci/dashboard/site/`.
- Co-locate a test with the production module it verifies where one exists; a cross-domain contract/acceptance test belongs to the owner of the **tested invariant**, not arbitrarily to its fixture. Test-only files are valid.
- Avoid one-file directories, speculative abstractions, umbrella `utils/` and repeated `common/` packages. `scripts/shared/` is allowed only for established helpers used across distinct domain owners; owners remain explicit.
- No permanent aliases, forwarding scripts, symlinks, wrappers, parallel source trees or old-path compatibility layers to accomplish a move. Migrate callers and test assertions in the same implementation PR.
- Preserve stable external names whose spelling is a tool/protocol contract (e.g., `package.json`, `Dockerfile`, `Package.swift`, `.github/workflows/*.yml`). Do not bulk-rename `app/`, `packages/` or `modules/` as part of the scripts migration.

## 2. Naming contract

| Kind | Naming rule | Example | Exception |
| --- | --- | --- | --- |
| Directory | lowercase kebab-case | `release-management/`, `ci/` | framework/OS mandated names |
| JS/TS source module and CLI entry | lowercase kebab-case | `input-proof.mjs`, `revision-store.ts` | fixed tooling entry or generated file |
| JS/TS test | exact tested stem + `.test.<ext>` | `input-proof.test.mjs` | externally prescribed E2E `.spec.ts` naming |
| React/SwiftUI view component and its direct source | PascalCase | `DocumentEditor.tsx`, `DocumentEditor.swift` | keep existing framework conventions |
| React UI style via vanilla-extract | kebab-case + `.css.ts` | `document-editor.css.ts` | external styles belonging to editor/library |
| Shell, Python, CSS, HTML | lowercase kebab-case | `oci.sh`, `candidates.py`, `dashboard.css` | supplied vendor or tool-defined files |
| JSON/configuration/lockfiles | required ecosystem name first | `package.json`, `tsconfig.json` | no custom filename casing policy over tool contracts |
| Identifiers *inside code* | language convention, independent of filename | `camelCase`, `PascalCase` | standard language conventions |

Use lowercase ASCII for new first-party paths unless a language/tool contract expressly requires otherwise. Avoid whitespace, mixed-case alternate spelling and `index.mjs` as a default generic entrypoint. Keeping kebab-case for scripts does **not** imply changing TypeScript identifiers, SwiftUI class names or existing runtime routes.

## 3. Adopted `scripts/` ownership tree

```text
scripts/
├── ci/
│   ├── impact/            # canonical task inventory, diff analysis and affected plan
│   ├── execution/         # workspace preparation, bounded group execution, test-type checks
│   ├── evidence/          # task inputs, receipts, artifacts, optional selected-task proof
│   ├── certification/     # exact-source certification and merge-proof admission
│   ├── browser/           # browser shards, fixtures, pinned runtime checks
│   └── dashboard/         # CI Observatory generation, assets and timing
├── build/
│   ├── frontend/          # frontend build and UI development preview/scan
│   ├── backend/           # reserved for a real separately owned backend build module
│   └── packaging/         # core/full profile packaging and build preparation
├── release/
│   ├── frontend/          # frontend release/promotion contracts
│   ├── backend/           # backend registry, release identity and promotion
│   └── components/        # shared release policy, version and source gate
├── deployment/
│   ├── admission/         # preflight, guarded admission and certificates
│   ├── lifecycle/         # push/host lifecycle and authenticated updates
│   ├── handoff/           # backend and promotion handoff verification
│   └── recovery/          # interrupted deployment and backup recovery checks
├── verification/
│   ├── run.mjs             # top-level local verification runner
│   ├── runtime/           # OCI/runtime verification and fixtures
│   ├── dependencies/      # dependency closure and runtime dependency audit
│   ├── artifacts/         # artifact, Pages, migration ledger validation
│   └── infrastructure/    # deployment config and public identity probes
├── shared/                # only proven cross-owner helpers
├── architecture/          # retained diagram/source contract verifier
├── code-scanning-pages/   # retained static security report publisher
├── postgres-contract/     # retained database contract runner
├── strictdoc/             # retained requirements trace toolchain
├── audit/                 # retain existing audit subdomain
├── performance/           # retain existing performance subdomain
├── branding/              # retain existing branding subdomain
├── ios/                   # retain existing native tooling
├── graphify-pages/        # retain existing Graphify publisher
├── architecture-diagrams/ # retain existing diagram publisher
└── pages-ui/              # retain existing Pages navigation tooling
```

Directory names in this tree define **ownership namespaces**, not an obligation to create empty folders. In particular, `build/backend/` is a reserved responsibility; do not create it or move unrelated OCI checks there solely to match the drawing.

### Boundary decisions

| Responsibility | Sole owner | Not owned here |
| --- | --- | --- |
| Verification inventory and impact selection | `ci/impact/` | individual test logic or CI job outcome |
| Runner selection and execution | `ci/execution/` and `ci/browser/` | release admission |
| Input closure / reusable proof | `ci/evidence/` | deciding which tests are affected |
| Exact-source pass/fail certification | `ci/certification/` | changing the impact plan because a proof is missing |
| Build/profile packaging | `build/` | publishing/promoting releases |
| Artifact verification | `verification/artifacts/` | a second artifact/release canonical owner |
| Release eligibility, promotion | `release/` | deployment permissions and transactional update |
| Deployment actions/rollback | `deployment/` | CI task inventory |
| Audit, performance and individual Pages tools | their established directories | generic CI execution |

The normative [CI/CD contract](../verification/CI-CD.md) is unchanged: `NOT_SELECTED` is distinct from `PASSED` and `REUSED`. Renaming files must never silently broaden/narrow impact selection or bypass existing exact-source evidence and security gates.

## 4. Migration acceptance

[Issue #690](https://github.com/yohn-jp/codexia/issues/690) owns the complete source-to-target mapping, migration waves, prerequisites and verification. Every migrated PR must update imports, child-process commands, workspaces, package scripts, Docker/OCI contexts, workflows, test fixtures, documentation links and literal source-input closures affected by the move **atomically**. Keep executable path/permissions of `.sh` tools, relative `import.meta.url` resources and ESM resolution valid. A clean build is not a substitute for tested CI/release/host behavior.

If a target collision or ownership contradiction is discovered, first amend this normative file and the path map; never introduce a temporary duplicate authority. Documentation acceptance does not assert any file was already moved.
