# Verification

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

`pnpm test` runs workspace suites and root script tests. `typecheck:tests` includes test sources, and `typecheck:safety` applies stricter scoped compiler checks. Core dependency auditing requires a Core build; use `CODEXIA_PROFILE=core pnpm build` if a Full build replaced the outputs.

The PostgreSQL persistence suite is part of `pnpm test` and requires a disposable PostgreSQL database in `CODEXIA_TEST_DATABASE_URL`. It runs the migrations and exercises persistence transactions; it does not clean the database after the run. For example, start a disposable local server, then run `CODEXIA_TEST_DATABASE_URL=postgres://codexia:codexia@127.0.0.1:55440/codexia_test pnpm test`. The verification workflow supplies its own PostgreSQL service.

For an application database, apply the schema with `CODEXIA_DATABASE_URL='postgres://user:password@host:5432/database' pnpm --filter @codexia/persistence-postgres migrate`. Migration files are checksum-checked and applied transactionally. API startup verifies that the database migration ledger exactly matches the packaged migration files, even when startup migrations are disabled. Missing, changed or unexpected applied migrations prevent startup. With `CODEXIA_DATABASE_MIGRATE_ON_START=0` (or unset), this verification is read-only and does not initialize or migrate the database.

The packaged migration identity is the SHA-256 of the UTF-8 JSON array of `[filename, checksum]` pairs sorted by filename, prefixed by `sha256:`. Each checksum is computed from the same UTF-8 SQL input used by the migration runner. To obtain the identity without a database, or verify the identity against a real database without applying migrations:

```sh
pnpm --filter @codexia/persistence-postgres build
node packages/persistence-postgres/dist/migrate.js --fingerprint
CODEXIA_DATABASE_URL='<database-url>' node packages/persistence-postgres/dist/migrate.js --verify-fingerprint
```

The second command prints the fingerprint only when the applied ledger exactly matches the packaged migrations. A mismatch or unavailable database is a nonzero exit, not permission to migrate.

## Browser checks

Install the configured browsers and run acceptance against each profile:

```sh
pnpm exec playwright install chromium webkit
export CODEXIA_E2E_DATABASE_URL='postgres://user:password@127.0.0.1:5432/codexia_e2e'
# The database above must be disposable; browser tests persist fixtures and do not clean the database.
CODEXIA_PROFILE=core pnpm test:e2e
CODEXIA_PROFILE=full pnpm test:e2e
```

On a supported host, `CODEXIA_E2E_CHROMIUM` selects a system Chromium executable. The Playwright configuration and test sources define browser/display requirements and conditional cases. A skipped case is not a passed check. Physical-device keyboards, OS IME and native gestures require device testing beyond synthetic composition events.

Browser acceptance covers editing, conflicts, recovery, shell switching, module contributions, workspace layouts, terminology and job review. Tests use generated repositories and isolated browser state. Do not point fixture-driven tests at author work.

## OCI and integration checks

[OCI verification](OCI.md) checks packaging and startup. [Integration verification](INTEGRATION.md) describes MCP, import, actual model execution and PostgreSQL restore/container replacement. Hosted producer checks run with:

```sh
pnpm verify:hosted
```

That command verifies local producer/catalog/build composition contracts; it does not certify a deployed Hosted instance or publish a release. It requires a usable OCI engine and capacity for disposable local builds.

`pnpm verify` runs frozen installation, production/test-source/safety type checks, tests, Core and Full builds, Core auditing, browser and OCI checks, MCP, Diagnostics persistence and legacy import acceptance. It requires the configured browsers, OCI engine and tokenizer artifacts. Separate CPU model lifecycle and PostgreSQL restore/container recovery checks require their own inputs and commands. Legacy Git publish and real-provider streaming acceptance is retired; it is not current verification evidence.

## Repository CI and release

[Test Architecture Optimization](TEST-ARCHITECTURE-OPTIMIZATION.md) defines the proposed test placement, shared build artifacts and dependency-aware execution architecture. The current supported commands and certification rules below remain authoritative until the corresponding implementation and contract changes are accepted.

`.github/workflows/verify.yml` groups workspace unit tests, type checks, safety, builds, auditing, browser tests, OCI checks and Hosted Native composition into at most twenty jobs, including impact planning and the final gate. `scripts/ci-contract.mjs` defines both the execution groups and the complete validation inventory; coverage checks reject omitted workspaces and test sources.

Pull requests select affected validations using `scripts/ci-impact.mjs`. Shared contracts, build inputs, unknown paths and unavailable diff history select full verification. Main pushes and manual runs always execute the full inventory. Plans record the base/head identities, changed paths, selected validations and explicit `NOT_SELECTED` reasons; exclusions are not passing test evidence. Each execution group records individual results and continues independent checks after a failure. Browser groups consume the successful same-profile build artifact instead of compiling again. The producer and consumer bind the exact source, plan, toolchain, run and attempt; each file and the downloaded artifact are digest-checked. A failed or missing producer blocks its browser group, without cancelling independent groups. Certification requires the browser receipt to identify the latest successful producer artifact. The final gate requires every selected validation and its execution group to succeed at the exact source SHA. Release eligibility still requires complete successful main-push verification, including every execution group and certification.

Local verification and CI are separate results. Record exact commands, source identity, exits and skipped or blocked cases in PR checks and machine artifacts. Keep logs, traces and generated reports outside product documentation. Verification does not publish or deploy; [release publication](OCI-RELEASE.md) uses the gated workflow.
