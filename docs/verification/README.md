# Verification

For isolated Codex Cloud tasks, use the [Cloud development procedure](CLOUD-DEVELOPMENT.md) rather than a separately maintained application/authentication launcher.

[Pages公開物の機能棚卸し](PAGES-FUNCTION-INVENTORY.md)は単一の公開ワークフローと各画面のデータ出典、観測の限界をまとめる。
[Pages統合サイトマップと画面UX設計](../design/DEVELOPMENT-PAGES-UX.md)は画面の設計正本を定義する。
統合ポータルの受入証拠は、対象SHAのRepository Audit Pagesの結果と生成物を参照する。

[Architecture Atlas](ARCHITECTURE-ATLAS.md) specifies static SVG generation and actual browser acceptance for the canonical architecture and UI/deployment transitions.

Verification demonstrates conformance to the [canonical design](../architecture/SYSTEM-DESIGN.md), [user/owner navigation](../design/USER-SCREEN-FLOW.md), [owner security](../design/ADMIN-SCREEN-FLOW.md), [initial deployment](../deployment/INITIAL-DEPLOYMENT-FLOW.md), and [updates](../deployment/UPDATE-FLOW.md); a passing unit or browser suite does not establish live-VM or independent recovery acceptance.

Run from the repository root with Node.js and pnpm versions satisfying `package.json`.

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm typecheck:tests
pnpm typecheck:safety
pnpm test
pnpm build
pnpm audit:core
```

`pnpm test` runs workspace suites and root script tests. `pnpm typecheck:tests` builds prerequisites for all test-source scopes. To check one scope, run `pnpm typecheck:tests modules`, `pnpm typecheck:tests packages`, or `pnpm typecheck:tests app-e2e`. `typecheck:safety` applies stricter scoped compiler checks. Core dependency auditing requires a Core build; use `CODEXIA_PROFILE=core pnpm build` if a Full build replaced the outputs.

For feedback before pushing, run `pnpm test:unit:changed` from the repository root after installing dependencies. It compares the working tree, including untracked non-ignored files, with the merge base of HEAD and your local `origin/main` ref. Refresh that ref with `git fetch origin main` when needed. Use `pnpm test:unit:changed --list` to preview the selection, or pass a different base, e.g. `pnpm test:unit:changed HEAD` for uncommitted edits. The command uses the PR impact rules, prepares the selected unit suites' workspace dependencies once, and runs those suites. Unknown paths select all unit suites. Database-backed suites require their normal disposable databases. CI owns the broader verification and certification.

The PostgreSQL persistence suite is part of `pnpm test` and requires a disposable PostgreSQL database in `CODEXIA_TEST_DATABASE_URL`. It runs the migrations and exercises persistence transactions; it does not clean the database after the run. The fresh-schema regression creates and removes a separate random disposable database, so use a disposable PostgreSQL server with a test role allowed to create databases. For example, start a disposable local server, then run `CODEXIA_TEST_DATABASE_URL=postgres://codexia:codexia@127.0.0.1:55440/codexia_test pnpm test`. The verification workflow supplies its own PostgreSQL service.

For an application database, apply the schema with `CODEXIA_DATABASE_URL='postgres://user:password@host:5432/database' pnpm --filter @codexia/persistence-postgres migrate`. Migration files are checksum-checked and applied transactionally. API startup verifies that the database migration ledger exactly matches the packaged migration files, even when startup migrations are disabled. Missing, changed or unexpected applied migrations prevent startup. With `CODEXIA_DATABASE_MIGRATE_ON_START=0` (or unset), this verification is read-only and does not initialize or migrate the database.

The packaged migration identity is the SHA-256 of the UTF-8 JSON array of `[filename, checksum]` pairs sorted by filename, prefixed by `sha256:`. Each checksum is computed from the same UTF-8 SQL input used by the migration runner. To obtain the identity without a database, or verify the identity against a real database without applying migrations:

```sh
pnpm --filter @codexia/persistence-postgres build
node packages/persistence-postgres/dist/migrate.js --fingerprint
CODEXIA_DATABASE_URL='<database-url>' node packages/persistence-postgres/dist/migrate.js --verify-fingerprint
```

The second command prints the fingerprint only when the applied ledger exactly matches the packaged migrations. A mismatch or unavailable database is a nonzero exit, not permission to migrate.

## Browser checks

Install Chromium and run acceptance against each profile, as required by [E2E execution](E2E-EXECUTION.md). The duplicate WebKit project is retired:

```sh
pnpm exec playwright install chromium
export CODEXIA_E2E_DATABASE_URL='postgres://user:password@127.0.0.1:5432/codexia_e2e'
# The database above must be disposable; browser tests persist fixtures and do not clean the database.
CODEXIA_PROFILE=core pnpm test:e2e
CODEXIA_PROFILE=full pnpm test:e2e
```

On a verification host (not necessarily a supported product OS), `CODEXIA_E2E_CHROMIUM` selects a system Chromium executable. The Playwright configuration and test sources define browser/display requirements and conditional cases. A skipped case is not a passed check. Physical-device keyboards, OS IME and native gestures require Windows/iPhone device testing beyond Linux Chromium and synthetic composition events.

Browser acceptance covers editing, conflicts, recovery, shell switching, module contributions, workspace layouts, terminology and job review. Tests use generated repositories and isolated browser state. Do not point fixture-driven tests at author work.

## Mixed-version frontend/backend acceptance

A matching API epoch and profile permit independent component replacement; they do not alone prove wire behavior. Before accepting a compatibility-sensitive change without an epoch bump, exercise a previously served frontend source against the candidate API using an isolated PostgreSQL database and existing authoring browser scenarios. Select the prior source from the frontend release identity, not a guessed tag or the candidate's freshly built UI.

From the clean candidate checkout, after installing Chromium on the verification host:

```sh
git worktree add --detach /tmp/codexia-prior-ui "$PRIOR_SOURCE_SHA"
export CODEXIA_E2E_DATABASE_URL='postgres://user:password@127.0.0.1:5432/codexia_e2e_compat_test'
node scripts/release/frontend/verify-mixed-version.mjs /tmp/codexia-prior-ui full
```

Set `PRIOR_SOURCE_SHA` and replace the database credentials with the actual prior release source and a fresh disposable database. Use the deployed profile (Core or Full). The runner verifies distinct clean ancestor/candidate sources and the unchanged epoch, builds the prior frontend separately, validates its generated identity, builds the candidate, and uses only the prior frontend assets in the current E2E server. The browser exercises actual API and PostgreSQL login, editing, save/receipt, immutable revision reads and conflict recovery. Record the source pair, profile, epoch, test results and limitations. A failure caused by a historical UI locator change requires investigation, not weakening the assertions.

This opt-in source-build acceptance is not a replay of the byte-identical deployed release artifact, does not exercise Cloudflare Access or live VM cutover, and does not replace exact-source CI, live release admission or manual epoch/schema transition acceptance. Do not target production. The ordinary CI browser lanes retain their same-source artifact contract; their success is not mixed-version evidence.

## OCI and integration checks

[OCI verification](OCI.md) checks packaging and startup for the Core and Full profiles. [Integration verification](INTEGRATION.md) describes MCP, import, actual model execution and PostgreSQL restore/container replacement.

`pnpm verify` runs frozen installation, production/test-source/safety type checks, tests, Core and Full builds, Core auditing, browser and OCI checks, MCP and Diagnostics persistence acceptance. It requires the configured browsers, OCI engine and tokenizer artifacts. Separate CPU model lifecycle and PostgreSQL restore/container recovery checks require their own inputs and commands. Historical Git publish and real-provider streaming tests remain in repository history.

## Repository CI and release

[CI/CD architecture](CI-CD.md) is the execution, evidence and certification contract. [Test architecture](TEST-ARCHITECTURE-OPTIMIZATION.md) defines the proof placement and model-based/representative E2E strategy. [E2E execution](E2E-EXECUTION.md) defines the browser optimization target and transition gates. The executable inventory is maintained in [ci-contract.mjs](../../scripts/ci/impact/contract.mjs).

Local verification and CI are separate results. Record exact commands, source identity, exits and skipped or blocked cases in PR checks and machine artifacts. Verification does not publish or deploy. See [OCI releases](OCI-RELEASE.md) and [Deployment](../deployment/README.md) for delivery and operational checks.
