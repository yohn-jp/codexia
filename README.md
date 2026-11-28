# Codexia

**Architecture authority:** The [canonical system design](docs/architecture/SYSTEM-DESIGN.sdoc) and [documentation governance](docs/architecture/DOCUMENTATION-AUTHORITY.sdoc) govern changes; the [PostgreSQL data model](docs/architecture/DATA-MODEL.sdoc) defines persistent domain ownership. Code and CI provide conformance evidence, not a competing specification. The [documentation index](docs/README.md) includes user, owner-security, first-deployment and update state diagrams.

A modular writing workspace with PostgreSQL as the sole authority for projects, hierarchy, Markdown documents, immutable revisions, Knowledge, Evidence and Text Anchors. **The currently supported authoring product is Windows Chromium (Chrome/Edge) Desktop React Web.** Native SwiftUI iOS remains an accepted target, but development and automatic Xcode validation are paused; implementation and physical-device acceptance are incomplete, so it is not currently a supported authoring deliverable. Desktop and iOS do not share UI components or client-side state; Core/API/Revision semantics are shared. Mobile Web/PWA and Capacitor WebView authoring have been retired, including the `/mobile/` route (see [iOS architecture](docs/architecture/IOS-SWIFTUI-ARCHITECTURE.sdoc)). Other author Web OS/browser combinations are outside the supported product boundary; this does not impose user-agent blocking or change public-reader/auth obligations. See [system design](docs/architecture/SYSTEM-DESIGN.sdoc) and [E2E execution](docs/verification/E2E-EXECUTION.sdoc). The Core profile runs without optional analysis or model dependencies; the full profile composes nine independent add-ons.

Edit with revision checks, compare conflicts without losing drafts, restore earlier revisions, review module proposals, and export from consistent database snapshots. One server serves one trusted owner. Registered MCP clients operate within their assigned projects and OAuth scopes.

[Documentation](docs/README.md) covers authoring, architecture, deployment and verification. The [external Plugin Platform proposal](docs/architecture/PLUGIN-PLATFORM.sdoc) specifies a separate isolation and distribution design; built-in modules execute as trusted application code.

The [Codexia reboot RFC](docs/architecture/CODEXIA-REBOOT-RFC.sdoc) contains broader design proposals; [Core architecture](docs/architecture/CORE.sdoc) defines the supported persistence contract.

## Run locally

For isolated Codex Cloud tasks, follow the [Cloud development environment](docs/verification/CLOUD-DEVELOPMENT.sdoc).

Use the [local UI preview](docs/verification/UI-PREVIEW.sdoc) to try the currently implemented Desktop React Web. The preview does not provide the paused native iOS target. It runs a disposable PostgreSQL container and a local Better Auth issuer. Install Node.js and pnpm versions satisfying [`package.json`](package.json), and start Docker or Podman.

```sh
pnpm install --frozen-lockfile
pnpm ui:preview --no-capture
```

Open `http://127.0.0.1:4173/desktop/` and choose OAuth sign-in with the local preview identity provider. Stopping the preview removes its database.

For a persistent standalone installation, follow [Better Auth provisioning and owner enrollment](docs/deployment/ANSIBLE-AUTH-RUNTIME.sdoc) and [protected first activation](https://yohn-jp.github.io/codexia/requirements/html/docs/deployment/PUSH-DEPLOYMENT.sdoc.html#DOC-DEPLOYMENT-PUSH-DEPLOYMENT-first-application-activation). The API requires migrated PostgreSQL storage and an enrolled owner with registered OAuth clients. [.env.example](.env.example) lists runtime settings. The process reads its environment directly.

Use the work panel to export a portable `codexia-work/v1` JSON snapshot or import one as a new project. This preserves current manuscripts, hierarchy, Knowledge and supported Evidence without turning legacy source conversion into an application feature. Historical revisions and browser drafts are not part of the JSON; see [portable works](docs/authoring-portable.sdoc).

Create projects and documents in the workspace. Local drafts live in IndexedDB until the server confirms a database revision. Stale saves preserve the draft and expose conflict recovery. Browser recovery belongs to the same browser/origin; clearing its storage removes that recovery copy. Back up PostgreSQL and private host history separately, following [deployment](docs/deployment/DEPLOYMENT-REFERENCE.sdoc).

Writing, Research, and Review presets assemble independent Editor, Outline, Inspector, History, and Review panels. Use panel grips and dock targets, or the keyboard-accessible move controls, to split, tab, reorder, resize, show, and hide panels. **Save layout** stores the arrangement for the current author in this browser, separately from draft recovery and PostgreSQL. Invalid saved layouts fall back without erasing the prior setting until an explicit save.

Search/Terminology is optional: it indexes snapshot revisions, using PostgreSQL project/document revisions, and supports lexical, exact, prefix, and scoped queries. The term dictionary is changed through reviewable proposals. Automatic term links are temporary editor/reading decorations and never insert links into Markdown; use Ctrl/Command-click or Ctrl/Command-Enter on an editor term to navigate. Ambiguous aliases remain plain text and can be inspected in the terminology panel. Search can explicitly request existing NLP or Semantic capabilities; ordinary search does not load models. Core-only builds retain authoring without this plugin.

For a local preview of the Full composition, pass `--profile full` to `pnpm ui:preview`. Full includes Story, Diagnostics, NLP, Semantic, Speaker, Assistant, Publishing, MCP, and Search/Terminology. Module settings distinguish absent, disabled, enabled-idle and active modules. Heavy engines run in supervised child processes. Assistant provider execution requires provider configuration and author consent. Local writing and review remain available without a model provider.

## MCP access

The optional MCP module exposes Streamable HTTP at `/mcp`. Configure a registered client to use `https://<application-origin>/mcp`. A client assigned several projects selects one with `/mcp?projectId=<assigned-id>` and sends every MCP request to that URL. Public OAuth resource metadata is available at `/.well-known/oauth-protected-resource` and describes how the client connects to Better Auth.

For local stdio, run `codexia-mcp` with an OAuth access token already issued to the registered MCP client in `CODEXIA_MCP_ACCESS_TOKEN`. Both transports enforce the same project assignments and `mcp:read`, `mcp:compute` and `mcp:propose` scopes. Applying proposals requires author approval. [MCP OAuth contract](docs/architecture/MCP-OAUTH.sdoc)

## Single OCI image

The API requires a PostgreSQL database URL. The [OCI verification script](docs/verification/OCI.sdoc) starts isolated PostgreSQL and Better Auth fixtures. For a persistent deployment, provision the auth database role, enroll the owner, register clients and [activate the reviewed image](https://yohn-jp.github.io/codexia/requirements/html/docs/deployment/PUSH-DEPLOYMENT.sdoc.html#DOC-DEPLOYMENT-PUSH-DEPLOYMENT-first-application-activation).

```sh
podman build --format oci --build-arg PROFILE=core -t codexia:local .
```

Use `PROFILE=full` with the same Dockerfile for the full composition. The existing volume names are retained for upgrades. Keep `/data` and `/history` persistent: `/history` holds private usage and job history separately from PostgreSQL manuscript records. Use HTTPS through a trusted reverse proxy when accessing the instance beyond localhost. Do not run multiple containers against one workspace volume. This is a single-owner application.

## Development portal

[Development Portal](https://yohn-jp.github.io/codexia/) · [Architecture Atlas](https://yohn-jp.github.io/codexia/architecture/) · [Code Map](https://yohn-jp.github.io/codexia/graph/) · [CI Observatory](https://yohn-jp.github.io/codexia/ci/) · [Source Audit](https://yohn-jp.github.io/codexia/audit/)

The [site manifest](https://yohn-jp.github.io/codexia/site-manifest.json) lists the generated pages and their sources. Architecture and Graphify show the build SHA, CI Observatory fetches a bounded sample of public Actions data when opened, and Source Audit records each observed branch HEAD in its [branch manifest](https://yohn-jp.github.io/codexia/manifest.json).

### Repository source audit

The repository audit workflow exports each observed remote branch HEAD with the same main-branch Repomix policy, independent of product releases. Main pushes and manual dispatches on main refresh the portal; branch-only changes are included on the next main push or manual dispatch; they do not trigger a refresh themselves. Check the exported SHA before reviewing a moving branch. The portal intentionally does not launch a second workflow for every branch push. Select a branch and click **Gemini review · 1 Markdown** for one self-contained review input. Full Repomix JSON remains available for repository-wide context. Download up to nine responsibility-based JSON parts directly from the branch row: architecture, frontend, core/contracts, API, persistence, authoring modules, platform modules, infrastructure/CI, and verification/tooling. Each part identifies the source SHA and original file paths; files are never split internally. The snapshot manifest is available separately, and the full JSON also has a View JSON link. Read the snapshot manifest for original blob hashes, output checksums and excluded paths. The portal does not contain uncommitted changes or claim full coverage of excluded files.
The same workflow also runs **OCR Delegate** (without an LLM) for every observed non-main HEAD using its merge-base with the observed main SHA. OCR deterministically lists reviewable and excluded files and resolves per-file rules. The publisher combines every selected **verified** changed source file, its diff and rules, plus available `AGENTS.md` / `SECURITY.md` guidance, into one standalone `gemini-review.md` per branch. For constrained model context, an alternative `gemini-diff.md` contains only the diffs and rules; **the diff-only option is not equivalent to deep source review**. The portal links directly to the complete Markdown download. Files are never split by size, and neither ZIP extraction nor GitHub Import Code is required. The Markdown packet has one document-level title, fixed-SHA coverage metadata, one shared section per distinct OCR rule, stable `F001`-style file identities, exact unified diffs, 1-based numbered HEAD source, and explicit begin/end file markers. Source/diff hashes and a content-integrity footer permit external verification; the packet ID binds source, diff, rule, mode and provenance. Gemini's ability to repeat these markers is an ingestion sanity check, not proof that it semantically reviewed every line.

**Gemini App workflow:** open the audit portal, select the branch and verify its SHA; download **one** `gemini-review.md`; in the Gemini web app use **Add files → Upload files** (not Import Code or GitHub URL) and attach only that Markdown. Ask Gemini first to quote its `PACKET_ID`, `HEAD_SHA`, `INCLUDED`, and final `END_OF_PACKET` marker to detect unreadable/truncated imports. Then ask it for evidence-grounded findings, file-by-file coverage and explicit limitations. Never interpret OCR-selected file counts or the model's summary as proof of a complete audit.

`preview.json` lists all OCR-selected and OCR-excluded paths; `rules.json` records rule resolution; each review manifest gives output checksums, covered paths and reasons for missing selected sources. Files absent from the verified Repomix export are withheld. Removed lines whose merge-base preimage was not verified against current main are redacted and must be treated as unverified. Unchanged dependencies and GitHub Issues/PR descriptions are not necessarily inside the packet; request additional verified context instead of making unsupported claims. This is review preparation, **not an AI review result**. Main has no diff and retains the Repomix whole-repository audit. No additional workflow or review API key is added.

Public Pages deployment requires **Settings → Pages → Build and deployment → Source: GitHub Actions**. Only main runs publish. A main push or manual dispatch on main builds the integrated site and enumerates the canonical public repository's advertised remote branch HEADs. Branch-only pushes do not trigger publication. The index records the observation time. PRs that affect the site produce a non-publishing preview artifact after the generated pages, manifests, links and Chromium navigation checks pass. Identical HEADs share a snapshot and unchanged, checksum-verified exports may be reused.

For local generation from the repository root, use a separate installation of Repomix 1.19.0 and absolute output paths outside the checkout:

```sh
node scripts/audit/export.mjs /tmp/codexia-audit-site /tmp/codexia-audit-cache /absolute/path/to/repomix
```

The exporter reads Git blobs, never executes branch code or uses branch-specific packer configuration, excludes binary/non-UTF-8 content, private-data paths, credential filenames and the entire historical `evidence/` directory (including generated Markdown manuscripts), and enables Repomix secret scanning. The publication policy excludes matching source files before packaging and records the affected snapshots as partial. The assembled-site check runs the same credential-pattern checks before upload.

## Development and verification

```sh
pnpm typecheck
pnpm test
pnpm build
pnpm audit:core
```

See [verification](docs/verification/VERIFICATION-REFERENCE.sdoc) for browser, OCI, MCP, model, recovery and deployment checks. `pnpm verify` runs the local composed checks; inputs and separate integration gates are documented there. Repository CI certifies the exact source before the [gated release workflow](docs/verification/OCI-RELEASE.sdoc) may publish.

See [Core architecture](docs/architecture/CORE.sdoc), [Modules](docs/architecture/MODULES.sdoc) and [Modular Workspace](docs/architecture/MODULAR-WORKSPACE.sdoc) for ownership and safety contracts. Read [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md) and [LICENSE](LICENSE) before contributing or distributing.
