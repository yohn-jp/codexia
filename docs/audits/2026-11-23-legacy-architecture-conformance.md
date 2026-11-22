# Architecture conformance audit — legacy runtime removal

Baseline: `main@91b6cb64a85da6c8f4b864a5843ac7fb776e08fa` (2026-11-23).
Scope: 2,255 tracked paths, including application, API, modules, persistence, deployment, tests, CI, and documentation.
This is an **audit and removal contract**, not an implementation of the removals.

## Authority and boundaries

- PostgreSQL is the runtime authority for projects, documents, immutable revisions, Knowledge, and module snapshots; Git runtime save/sync/publish/history/fallback is retired. See merged PR #14 and `docs/architecture/CORE.md`.
- External AI accesses the same core operations through MCP; runtime internal LLM calls remain frozen.
- Passkey-first Better Auth, optional OIDC and OAuth-protected MCP replace static application tokens. See merged PR #605 and current auth documentation.
- Do not preserve historical Hosted/Praetorium or Scriptorium interfaces merely for backward compatibility.
- **Do not conflate** canonical PostgreSQL revision history, scoped browser draft recovery, or explicitly approved portable import/export with Git runtime compatibility. Preserve documented current behavior unless a newer canonical specification supersedes it.

## Confirmed violations and required remediation

### P0 — preserved legacy Story entity can shadow current entity

- Evidence: `modules/story/src/snapshot.ts` around line 171; `modules/story/src/actions.ts` around line 791.
- Reproduction in disposable PostgreSQL: insert a preserved legacy character and a current character sharing an identifier; load Story and approve an edit. The preserved copy is modified while the current record remains unchanged. NLP can return both.
- Violation: normal authoring resolves a preservation artifact as a live entity.
- Correction: exclude preserved/import-only records from normal Story resolution and mutation; resolve canonical project-scoped current entity deterministically. Keep preservation read-only and separate.
- Acceptance: the current character alone changes; preserved copy is unchanged; NLP returns the current entity once; collision and noncollision cases pass.

### P0 — public standalone MCP route gated by retired Hosted mode

- Evidence: `packages/api/src/server.ts` around line 2524; `deploy/ansible/auth-runtime.env.j2` around line 7.
- Reproduction: anonymous `POST /mcp` returns 404, while the project-scoped MCP route returns an OAuth challenge.
- Correction: expose the documented standalone MCP entry point with Better Auth/OAuth authorization and project scoping, independent of Hosted/Praetorium; propagate approved client and project assignment configuration through deployment.
- Acceptance: unauthenticated requests receive the specified OAuth challenge rather than 404; authenticated clients can access only assigned projects.

### P0 — obsolete static token blocks fresh Better Auth deployment

- Evidence: `deploy/ansible/deploy-transaction.yml` around line 184; `packages/api/src/server.ts` around line 630; `packages/api/test/passkey-bootstrap.acceptance.test.ts` around line 682.
- Reproduction: first deployment rejects Better Auth without the old API credential; legacy `/api/login` still issues a cookie. CI run [45070509913](https://github.com/yohn-jp/codexia/actions/runs/45070509913) failed passkey bootstrap with mixed legacy and Better Auth settings.
- Correction: eliminate the static-token authentication mode and all startup/deployment requirements for it, and repair tests to exercise the canonical Better Auth bootstrap alone.
- Acceptance: clean PostgreSQL + fresh deployment works without any legacy token; no static-token login route; real WebAuthn and MCP OAuth acceptance pass.

### P1 — retired behavior remains in CI and distribution declarations

- Evidence: `scripts/ci-contract.mjs` around line 24; `scripts/composition-persistence.mjs` around line 2; `tests/e2e/auth-recovery.acceptance.spec.ts` around lines 249 and 273.
- Observation: Hosted/Praetorium scenarios are still tested as production contracts; composition metadata advertises Git-format read/write capabilities even with an empty module selection.
- Correction: delete obsolete scenarios and declarations, not merely skip them. Replace with current canonical behavior tests.
- Acceptance: no runtime or distributed artifact advertises Git persistence or Hosted/Praetorium support; tests fail if these paths are reintroduced.

## Additional audit areas to resolve before declaring debt eliminated

1. Manifest/StoredFile virtual path projection: distinguish a documented module snapshot contract from unnecessary emulation of Git paths. Remove only the latter, including tests and public types.
2. Offline SQLite conversion and legacy import: ensure migration-only code is unreachable from normal Story startup, browsing, and editing.
3. Historical Scriptorium names, environment aliases, cookies, Git refs, and MCP aliases introduced by PR #1: remove those without a current explicit requirement.
4. Scripts, Ansible, OCI, release artifacts, module capability manifests, examples, and test fixtures: remove their obsolete consumers and producers together.
5. Documentation authority: replace stale historical instructions in active docs; historical PRs and immutable records are evidence, not current requirements.

## Verification gate

- Inventory all tracked paths against the baseline commit, classify each as canonical, violating, historical-only, or needing evidence; do not infer violations from keyword matches alone.
- For every confirmed violation, record source contract, call path, reproduction, impact, correction, and test proof.
- Run typechecks, focused unit/integration tests, actual PostgreSQL persistence tests, Chromium/WebKit E2E, fresh Better Auth enrollment, MCP OAuth and deployment contract checks.
- Require green exact-head GitHub checks; no silent skips or test rewrites that merely ratify old behavior.
- Do not merge while P0 violations remain. No production VM/data changes are authorized by this audit.
