# Codexia repository instructions

## Authority

Follow the latest explicit owner instructions, this repository's current PostgreSQL-only code and acceptance tests, and the organization-wide `yohn-jp/.github/.github/agent-governance/AGENTS.md`. The [reboot RFC](docs/architecture/CODEXIA-REBOOT-RFC.md) defines the PostgreSQL data model and long-term product intent. Its historical Git migration phases and inherited Git-only contracts must not override the explicit PostgreSQL-only decision.

## Canonical implementation

- PostgreSQL is the **only manuscript authority**. The `@codexia/persistence-contracts` domain model and `@codexia/persistence-postgres` adapter own document/revision and Knowledge/Evidence persistence.
- The authenticated `packages/api` HTTP admission is the sole server mutation path. Browser editors use `app/src/persistence/`, the CodeMirror editor adapter, and the IndexedDB recovery journal.
- Do not reintroduce `CoreStore`, repository registration, Git snapshots, GitHub publication, Git-writer fallback, a second persistence authority, or the retired browser module composition simply to make a test pass.
- Removal of Git-coupled Story, Search, Assistant, Publishing or other modules must not be reported as their feature migration. Each future feature needs PostgreSQL-native contracts and actual verification.
- Do not mutate or reopen the closed migration evidence under `evidence/migration`; `white-sigil` is a later explicit, one-time user action, not an automatic import.
- Preserve separate Desktop/Mobile presentation and shared Markdown/Revision/Evidence semantics. Maintain exact UTF-8 manuscript bytes and UTF-16 Anchor positions; never treat a browser Draft Journal as server-saved data.
- Neither source-control Git nor a portable export substitutes for PostgreSQL database backup/restore.

## Execution and validation

Use an isolated branch and PR. Do not alter `main`, merge, or deploy without authorization. Keep changes limited to the request; correct the implementation rather than suppressing checks. Verify frozen install, `pnpm typecheck`, `pnpm typecheck:tests`, `pnpm typecheck:safety`, `pnpm test`, `pnpm build`, `pnpm audit:core`, and relevant PostgreSQL/Chromium/WebKit/OCI checks. Browser E2E must use a disposable database. For any CI or live deployment claim, report the observed result; never infer success from an unrun test or a build alone.

Read [the deployment runbook](docs/deployment/README.md) for the API/Worker/DB split, and [verification](docs/verification/README.md) for exact checks. Historical Git-based documentation may be used to understand old design but is **not** the PostgreSQL runtime contract.
