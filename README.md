# Codexia

Codexia is a modular writing workspace backed by PostgreSQL. Projects, hierarchy, manuscript revisions, knowledge, evidence, module settings, proposals and applied changes use PostgreSQL as their canonical store. Browser IndexedDB keeps recoverable drafts separately. The Core profile runs without optional analysis or model dependencies; the Full profile composes nine trusted add-ons.

Create projects, browse volumes, chapters and scenes, edit Markdown, review revision history, restore prior revisions, resolve conflicts, and link UTF-16 text anchors to Knowledge and Evidence in the shared CodeMirror editor. Standalone mode serves one trusted owner and its PostgreSQL projects. Hosted mode binds each runtime to one explicitly assigned PostgreSQL project.

[Documentation](docs/README.md) covers authoring, architecture, deployment and verification. The [external Plugin Platform proposal](docs/architecture/PLUGIN-PLATFORM.md) specifies a separate isolation and distribution design; built-in modules execute as trusted application code.

The [Codexia reboot RFC](docs/architecture/CODEXIA-REBOOT-RFC.md) remains a broader design proposal. The implemented application uses PostgreSQL for authoring and does not fall back to Git storage or repository publishing.

## Run locally

Requires Node.js 24+, PostgreSQL, and pnpm 12.10.1.

Create a PostgreSQL database, then install, migrate and start Codexia:

```sh
createdb codexia
pnpm install --frozen-lockfile
pnpm build
export CODEXIA_DATABASE_URL='postgres://localhost/codexia'
pnpm --filter @codexia/persistence-postgres migrate
export CODEXIA_AUTH_TOKEN="$(openssl rand -hex 32)"
pnpm start
```

Open `http://127.0.0.1:3000` and sign in with `CODEXIA_AUTH_TOKEN`. PostgreSQL is required for every API startup. Set `CODEXIA_DATABASE_MIGRATE_ON_START=1` only when the API database role may apply the checked migrations. See [.env.example](.env.example); environment files are not automatically loaded.

The compatibility authoring paths follow this hierarchy:

```text
plot/volumes/<volume>/volume.yaml
plot/volumes/<volume>/chapters/<chapter>/chapter.yaml
plot/volumes/<volume>/chapters/<chapter>/scenes/<scene>.yaml
manuscript/<volume>/<chapter>/<scene>.md
```

These paths identify records exposed by Core; they are not Git repository files. Scene metadata names its Markdown document with `manuscript: manuscript/.../scene.md`. Unsupported metadata is preserved. Existing manuscripts can be brought into PostgreSQL through the explicit migration workflow.

Draft means browser recovery storage; Saved means the PostgreSQL transaction has committed. Revision checks protect editing and report conflicts without automatically resolving manuscript text. Retried operations retain their identities across response loss. Browser recovery uses the same browser and origin; clearing browser storage removes that recovery copy.

Writing, Research and Review presets assemble independent Editor, Outline, Inspector, History and Review panels. Use panel grips and dock targets on desktop, or keyboard-accessible move controls, to split, tab, reorder, resize, show and hide panels. **Save layout** stores the arrangement for the current author and desktop/mobile device class in this browser, separately from draft recovery and PostgreSQL.

Search/Terminology is optional: it indexes PostgreSQL revision history and supports lexical, exact, prefix and scoped queries. The term dictionary changes through reviewable proposals. Automatic term links are temporary editor/reading decorations and never insert links into Markdown; use Ctrl/Command-click or Ctrl/Command-Enter on an editor term to navigate. Ambiguous aliases remain plain text and can be inspected in the terminology panel. Search can explicitly request existing NLP or Semantic capabilities; ordinary search does not load models. Core-only builds retain authoring without this plugin.

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
  --mount type=volume,src=codexia-data,dst=/data \
  --mount type=volume,src=codexia-history,dst=/history \
  codexia:local
```

Use `PROFILE=full` with the same Dockerfile for the Full composition. Keep PostgreSQL, `/data` and `/history` persistent. PostgreSQL owns authoring state; `/data` contains derived module caches and `/history` contains private usage/job history. This is a single-owner application. Use HTTPS through a trusted reverse proxy beyond localhost.

## Development and verification

```sh
pnpm typecheck
pnpm test
pnpm build
pnpm audit:core
```

See [verification](docs/verification/README.md) for browser, OCI, MCP, model, recovery and Hosted producer checks. `pnpm verify` runs the local composed checks; inputs and separate integration gates are documented there. Repository CI certifies the exact source before the [gated release workflow](docs/verification/OCI-RELEASE.md) may publish.

See [Core architecture](docs/architecture/CORE.md), [Modules](docs/architecture/MODULES.md) and [Modular Workspace](docs/architecture/MODULAR-WORKSPACE.md) for ownership and safety contracts. Read [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md) and [LICENSE](LICENSE) before contributing or distributing.
