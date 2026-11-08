# Codexia

Codexia is a PostgreSQL-backed Markdown authoring workspace. PostgreSQL is the **only canonical project store**: project/document metadata, immutable revisions, Text Anchors, Knowledge, Evidence and approval state are not Git work-repository records. GitHub is used to version the **application source**, not to store or synchronize authors' manuscripts.

Desktop and Mobile use the same PostgreSQL authoring API and the same CodeMirror editing and browser-local IndexedDB recovery model. The author can create a project and document, edit and autosave Markdown, inspect or restore revisions, resolve a revision conflict, and attach confirmed Knowledge to revision-bound Text Anchors.

This is an intentionally breaking replacement of the retired Git/Core workspace. Existing Git works are **not** copied, migrated or imported automatically. The prior Story, Search, Assistant, Publishing and other Git/Core-coupled modules are not provided by this PostgreSQL-only runtime: deleting their old implementation is **not equivalent to migrating their functionality**. Their PostgreSQL-native replacements require separate implementation and acceptance. A portable project ZIP exporter/importer is also not shipped by this runtime; use verified PostgreSQL backups for operational recovery.

## Local startup

Prerequisites: Node.js 24+, pnpm 12.10.1 and a PostgreSQL 17 database accessible to the API. Use an isolated development database and credentials.

```sh
pnpm install --frozen-lockfile
pnpm build
export CODEXIA_AUTH_TOKEN="$(openssl rand -hex 32)"
export CODEXIA_DATABASE_URL="postgres://codexia:password@127.0.0.1:5432/codexia"
export CODEXIA_DATABASE_MIGRATE_ON_START=1
pnpm start
```

The server fails to start if `CODEXIA_DATABASE_URL` is absent. Do not enable automatic migration for an account that should not apply schema changes; instead run the checked migrations through `pnpm --filter @codexia/persistence-postgres migrate` before starting.

Open `http://127.0.0.1:3000`. Sign in with the server-side author token; the browser receives an HttpOnly session cookie. `CODEXIA_TRUST_PROXY=1` is only appropriate behind the trusted TLS-terminating origin. No GitHub credential is required or accepted for manuscript persistence.

## Verification

Run the normal repository checks before release:

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm typecheck:tests
pnpm typecheck:safety
pnpm test
pnpm build
pnpm audit:core
```

PostgreSQL tests need a disposable database in `CODEXIA_TEST_DATABASE_URL`. Browser E2E additionally requires `CODEXIA_E2E_DATABASE_URL`, Playwright Chromium and WebKit, and a disposable database; those tests create persistent fixtures. Source builds are not a substitute for browser verification and isolated restore testing.

## Deployment and data safety

The browser assets are built separately for Cloudflare Workers Static Assets; the Node API and private PostgreSQL run on a VM via Podman Quadlet. The Worker does not proxy `/api/*`. DNS, Cloudflare Access, Tunnel and Worker Route provisioning are separate operator steps and must not be inferred from a successful Workers upload. The API must be ready against its database before UI publication is treated as operational.

Use encrypted off-VM `pg_dump -Fc` backups, preserve any authoritative external assets, and periodically perform an isolated restore. Browser-local unsaved recovery drafts are **not included** in database backups. See [deployment operations](docs/deployment/README.md) and [verification](docs/verification/README.md).

The [Codexia reboot RFC](docs/architecture/CODEXIA-REBOOT-RFC.md) records architectural intent, not a certification of unimplemented phases. Several inherited design documents still describe the retired Git workspace; they are historical references and are not operational instructions for this runtime.
