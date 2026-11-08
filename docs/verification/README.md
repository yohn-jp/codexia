# PostgreSQL-only verification

Verification is defined by the actual PostgreSQL runtime, the browser acceptance tests, and CI evidence. Git/Core, module-composition and legacy publication tests are not the current runtime's verification contract.

## Local commands

Use Node.js 24+ and pnpm 12.10.1:

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm typecheck:tests
pnpm typecheck:safety
pnpm test
pnpm build
pnpm audit:core
pnpm typecheck:deployment
pnpm test:deployment
pnpm verify:deployment
```

Set `CODEXIA_TEST_DATABASE_URL` to a **disposable PostgreSQL 17 database** before `pnpm test`. Integration tests apply checksum-verified migrations and may leave test fixtures behind. Do not use a production URL for any test.

## Chromium and WebKit acceptance

Use another disposable database for UI tests, with Playwright browsers installed:

```sh
pnpm exec playwright install chromium webkit
export CODEXIA_E2E_DATABASE_URL="postgres://codexia:password@127.0.0.1:5432/codexia_e2e"
pnpm build
pnpm exec playwright test --config tests/e2e/playwright.config.ts --project chromium
pnpm exec playwright test --config tests/e2e/playwright.config.ts --project webkit
```

`tests/e2e/persistence-database.acceptance.spec.ts` covers PostgreSQL-only entry routing, same-origin authentication, project and document creation, Markdown saves, IndexedDB recovery, concurrent Revision conflicts, Revision restore and Knowledge/Text Anchor links. Both browsers must actually start and pass; a green build or lint does not substitute for an E2E result. Physical Japanese IME, native mobile keyboard and accessibility behaviors still require separate on-device checks.

## CI and release evidence

`.github/workflows/verify.yml` runs plan, unit, types, build, Chromium, WebKit, OCI and certification jobs. The certification job checks the actual jobs and commit SHA. A failing or cancelled browser check blocks certification and release. `scripts/verify-release-source.mjs` requires a successful exact-source main run before the backend image or Cloudflare UI is published. Deployment is never a substitute for verification.

Backups require a separate **real isolated PostgreSQL restore** as described in [deployment](../deployment/README.md). Source-code or CI success alone does not certify RPO/RTO or disaster recovery.
