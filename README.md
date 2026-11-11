# Codexia

A modular writing workspace with PostgreSQL as the sole authority for projects, hierarchy, Markdown documents, immutable revisions, Knowledge, Evidence and Text Anchors. Desktop and Mobile share authoring and browser recovery while retaining their own shells. The Core profile runs without optional analysis or model dependencies; the full profile composes nine independent add-ons.

Edit with revision checks, compare conflicts without losing drafts, restore earlier revisions, review module proposals, and export from consistent database snapshots. One standalone server serves one trusted owner. Hosted access remains bound to verified assignment, permissions and an explicitly configured PostgreSQL project.

[Documentation](docs/README.md) covers authoring, architecture, deployment and verification. The [external Plugin Platform proposal](docs/architecture/PLUGIN-PLATFORM.md) specifies a separate isolation and distribution design; built-in modules execute as trusted application code.

The [Codexia reboot RFC](docs/architecture/CODEXIA-REBOOT-RFC.md) contains broader design proposals; [Core architecture](docs/architecture/CORE.md) defines the supported persistence contract.

## Run locally

Requires Node.js 24+, pnpm 12.10.1 and PostgreSQL.

```sh
createdb codexia
pnpm install --frozen-lockfile
pnpm build
export CODEXIA_DATABASE_URL='postgres://localhost/codexia'
pnpm --filter @codexia/persistence-postgres migrate
export CODEXIA_AUTH_TOKEN="$(openssl rand -hex 32)"
export CODEXIA_DATABASE_URL='postgres://codexia:password@127.0.0.1:5432/codexia'
pnpm --filter @codexia/persistence-postgres migrate
pnpm start
```

Open `http://127.0.0.1:3000` and sign in with `CODEXIA_AUTH_TOKEN`. Configuration names are in [.env.example](.env.example); environment files are not automatically loaded. Startup requires a reachable PostgreSQL database. Apply checked migrations explicitly, or set `CODEXIA_DATABASE_MIGRATE_ON_START=1` only when the API role is intended to apply migrations. No Git fallback exists.

Use the work panel to export a portable `codexia-work/v1` JSON snapshot or import one as a new project. This preserves current manuscripts, hierarchy, Knowledge and supported Evidence without turning legacy source conversion into an application feature. Historical revisions and browser drafts are not part of the JSON; see [portable works](docs/authoring-portable.md).\n\nCreate projects and documents in the workspace. Local drafts live in IndexedDB until the server confirms a database revision. Stale saves preserve the draft and expose conflict recovery. Browser recovery belongs to the same browser/origin; clearing its storage removes that recovery copy. Back up PostgreSQL and private host history separately, following [deployment](docs/deployment/README.md).

Writing, Research, and Review presets assemble independent Editor, Outline, Inspector, History, and Review panels. Use panel grips and dock targets on desktop, or the keyboard-accessible move controls, to split, tab, reorder, resize, show, and hide panels. **Save layout** stores the arrangement for the current author and desktop/mobile device class in this browser, separately from draft recovery and PostgreSQL. Invalid saved layouts fall back without erasing the prior setting until an explicit save.

Search/Terminology is optional: it indexes snapshot revisions, using PostgreSQL project/document revisions, and supports lexical, exact, prefix, and scoped queries. The term dictionary is changed through reviewable proposals. Automatic term links are temporary editor/reading decorations and never insert links into Markdown; use Ctrl/Command-click or Ctrl/Command-Enter on an editor term to navigate. Ambiguous aliases remain plain text and can be inspected in the terminology panel. Search can explicitly request existing NLP or Semantic capabilities; ordinary search does not load models. Core-only builds retain authoring without this plugin.

To build and run the Full composition, use `CODEXIA_PROFILE=full pnpm build` and `CODEXIA_PROFILE=full pnpm start`. It includes Story, Diagnostics, NLP, Semantic, Speaker, Assistant, Publishing, MCP, and Search/Terminology. Module settings distinguish absent, disabled, enabled-idle and active modules. Heavy engines run in supervised child processes. Assistant provider execution requires provider configuration and author consent; selecting no provider keeps local writing and review available.

## Hosted MCP access

When the optional `mcp` module is included in a Praetorium Hosted composition, the stable application origin exposes `/mcp` (Streamable HTTP) and `/.well-known/oauth-protected-resource` (public OAuth resource discovery), also available at `/.well-known/oauth-protected-resource/mcp` for endpoint-path discovery. Configure a remote MCP client with `https://<stable-application-origin>/mcp`, not the physical Pod hostname or the Praetorium browser entry URL. The resource metadata points to Praetorium for user login, explicit client consent, PKCE token exchange and refresh. Codexia validates the issued short-lived repository/instance/epoch-bound bearer grant and retains the existing proposal/author approval boundary.

A stopped Hosted instance is served by Praetorium's Instance Access fallback: the initial unauthenticated request receives OAuth discovery, while a valid bearer request can trigger the existing authorized Wake path and returns `503 Retry-After` until the same stable URL becomes ready. The caller must retry its request; no MCP request body is queued or replayed by the platform. This service consumes the reusable [Praetorium service MCP contract](https://github.com/yohn-jp/praetorium/blob/main/docs/architecture/SERVICE-MCP.md) rather than implementing an application-specific OAuth issuer.

## Single OCI image

The API requires a PostgreSQL database URL. The OCI verification script starts an isolated PostgreSQL sidecar automatically; standalone operators configure their own database and apply migrations before authoring.

```sh
podman build --format oci --build-arg PROFILE=core -t codexia:local .
podman run --rm -p 127.0.0.1:3000:3000 \
  --env CODEXIA_AUTH_TOKEN --env CODEXIA_DATABASE_URL \
  --mount type=volume,src=scriptorium-data,dst=/data \
  --mount type=volume,src=scriptorium-history,dst=/history \
  codexia:local
```

Use `PROFILE=full` with the same Dockerfile for the full composition. The existing volume names are retained for upgrades. Keep `/data` and `/history` persistent: `/history` holds private usage and job history separately from PostgreSQL manuscript records. Use HTTPS through a trusted reverse proxy when accessing the instance beyond localhost. Do not run multiple containers against one workspace volume. This is a single-owner application.

## Development and verification

```sh
pnpm typecheck
pnpm test
pnpm build
pnpm audit:core
```

See [verification](docs/verification/README.md) for browser, OCI, MCP, model, recovery and Hosted producer checks. `pnpm verify` runs the local composed checks; inputs and separate integration gates are documented there. Repository CI certifies the exact source before the [gated release workflow](docs/verification/OCI-RELEASE.md) may publish.

See [Core architecture](docs/architecture/CORE.md), [Modules](docs/architecture/MODULES.md) and [Modular Workspace](docs/architecture/MODULAR-WORKSPACE.md) for ownership and safety contracts. Read [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md) and [LICENSE](LICENSE) before contributing or distributing.
