# Codexia documentation

Codexia is a PostgreSQL-backed writing workspace with a minimal Core and optional trusted modules. Git repository persistence and publishing are not part of the runtime. **Approved design documents, not the current code, are the architectural source of truth.** Start with [Documentation authority](architecture/DOCUMENTATION-AUTHORITY.sdoc) and [System design](architecture/SYSTEM-DESIGN.sdoc); runtime and CI are compliance evidence, not substitute specifications.

| Topic | Reference |
| --- | --- |
| Browser E2E execution and optimization | [E2E execution](verification/E2E-EXECUTION.sdoc) — Chromium target, migration gates, fixture/artifact reuse and measured optimization |
| Documentation precedence and change governance | [Documentation authority](architecture/DOCUMENTATION-AUTHORITY.sdoc) — canonical design-first governance |
| Implementation workstreams, dependencies and acceptance | [Specification implementation contract](architecture/SPECIFICATION-IMPLEMENTATION-CONTRACT.sdoc) — workstream boundaries and integration gates, not proof of implementation |
| Owner backup management | [Backup console contract](architecture/BACKUP-CONSOLE-CONTRACT.sdoc) · [Backup screen flows](design/ADMIN-SCREEN-FLOW.sdoc) — owner screens for configuration and evidence, backed by the operator-provisioned API and executor |
| XState state-machine adoption | [XState v5 contract](design/XSTATE-STATE-MACHINE-CONTRACT.sdoc) — save/recovery first, independent server/DB invariants retained |
| External dependencies, current-version policy and selected libraries | [Library selection policy](architecture/DEPENDENCY-POLICY.sdoc) — normative library-first choices, compatibility boundaries and adoption criteria |
| Existing dependencies, declared versions and update constraints | [Dependency inventory](architecture/DEPENDENCY-INVENTORY.sdoc) — direct dependencies, version constraints, update lag and coordinated upgrades |
| Approved specification toolchain and alternative decisions | [Toolchain architecture](architecture/SPECIFICATION-TOOLCHAIN.sdoc) — selected targets, implementation not yet certified |
| Design document and requirements migration | [Specification toolchain: StrictDoc adoption](https://yohn-jp.github.io/codexia/requirements/html/docs/architecture/SPECIFICATION-TOOLCHAIN.sdoc.html#DOC-ARCHITECTURE-SPECIFICATION-TOOLCHAIN-strictdocによる設計正本の全面移行採用済み方針) · [StrictDoc traceability](requirements/STRICTDOC-TRACEABILITY.sdoc) · [migration acceptance](https://yohn-jp.github.io/codexia/requirements/html/docs/verification/SPECIFICATION-TOOLING-ACCEPTANCE.sdoc.html#DOC-VERIFICATION-SPECIFICATION-TOOLING-ACCEPTANCE-strictdoc全面移行の受入) — native SDoc target; current sources remain authoritative until accepted migration |
| HTTP/API schema-first target | [TypeSpec → Fastify/Orval](architecture/HTTP-PLATFORM-MIGRATION.sdoc) — schema-first Fastify routes, generated client and acceptance gates |
| PostgreSQL schema verification target | [PostgreSQL verification](architecture/POSTGRES-CONTRACT-VERIFICATION.sdoc) — SQL/pgTAP/catalog/tbls and isolated restore |
| MCP protocol modernization | [MCP SDK v2 migration](architecture/MCP-V2-MIGRATION.sdoc) — 2026-era stateless transport, OAuth and conformance |
| Specification verification and public documentation | [Tooling acceptance](verification/SPECIFICATION-TOOLING-ACCEPTANCE.sdoc) — CI gates, LikeC4, Threagile, k6, Scalar, single Pages publisher |
| Product requirements and stable requirement IDs | [Requirements governance](requirements/REQUIREMENTS-GOVERNANCE.sdoc) · [Requirement register](requirements/REQUIREMENT-REGISTER.sdoc) — initial adopted requirement baseline and explicit gaps; not a proof of complete coverage |
| Requirement → design → code → test → evidence mapping | [Bidirectional traceability](verification/TRACEABILITY-REGISTER.sdoc) — initial path/symbol/test index; statuses are not CI certification |
| HTTP API request/response/error contracts | [API contract](architecture/API-CONTRACT.sdoc) — operation inventory, partial verified source shape and remaining DTO coverage |
| PostgreSQL physical objects and migrations | [DB detail contract](architecture/DATABASE-DETAIL-CONTRACT.sdoc) — tables, constraints, indexes, schema identity |
| External service and protocol interfaces | [External interfaces](architecture/EXTERNAL-INTERFACES.sdoc) — trust, credential, failure/recovery and implementation mapping |
| Principal/URL/HTTP authorization contract | [Route authorization](architecture/ROUTE-AUTHORIZATION-CONTRACT.sdoc) — API privileges by URL, principal, method and setup/owner state |
| Complete screen, control and user journey catalog | [Screen control catalog](design/SCREEN-CONTROL-CATALOG.sdoc) — route/CTA/error/authorization traceability |
| Individual screen state diagrams | [Screen State Atlas](design/SCREEN-STATE-ATLAS.sdoc) — all logical screen transitions and recovery paths |
| Abstract UX journey exploration and design/implementation comparison | [UX Simulator contract](design/UX-SIMULATOR-CONTRACT.sdoc) — derived from design authorities and canonical product sources, generic renderer, no duplicate screens or behavior, independent product acceptance |
| Official product website | [Product site](design/PRODUCT-SITE.sdoc) — normative product-led editorial experience, truthful demo, visual and interaction acceptance, independent Cloudflare delivery · [Enterprise design references](design/PRODUCT-SITE-BENCHMARKS.sdoc) — non-normative comparison and adoption rationale |
| GitHub Pages feature inventory and publication boundaries | [Pages inventory](verification/PAGES-FUNCTION-INVENTORY.sdoc) — generated routes, data sources and publication requirements |
| Development Pages unified portal and screen navigation | [Pages sitemap and UX design](design/DEVELOPMENT-PAGES-UX.sdoc) — portal and shared navigation design; see the Pages inventory for generated features |
| Graphical, source-bound diagrams | [Architecture Atlas](https://yohn-jp.github.io/codexia/architecture/) · [viewer and verification](verification/ARCHITECTURE-ATLAS.sdoc) — SVG diagram viewer, built and validated by Repository Audit Pages |
| Overall architecture and trust boundaries | [System design](architecture/SYSTEM-DESIGN.sdoc) — canonical system design |
| PostgreSQL domain and schema invariants | [Data model](architecture/DATA-MODEL.sdoc) — canonical domain design |
| User screen navigation and recovery | [User screen flows](design/USER-SCREEN-FLOW.sdoc) — canonical state transitions |
| Owner security management and admin boundaries | [Admin screen flows](design/ADMIN-SCREEN-FLOW.sdoc) — Desktop Web Console, owner enrollment, Passkey and session management, and saved OAuth grant revocation. Owner-managed OIDC remains a design target. Backup operations require operator provisioning and separate deployment acceptance. |
| Production deployment lifecycle and route selection | [Deployment lifecycle](deployment/DEPLOYMENT-LIFECYCLE.sdoc) — normative state classification, initial pair activation, compatible updates, maintenance/recovery and shared acceptance |
| SSH-side initial deployment CLI | [codexiactl](deployment/CODEXIACTL.sdoc) — normative command, provider authentication, setup/dispatch, resume and acceptance contract |
| Pristine VM, one-time setup key, first owner and recovery | [Initial deployment flows](deployment/INITIAL-DEPLOYMENT-FLOW.sdoc) — SSH-ready VM, Ansible, Workers setup-only/API, protected activation and existing-owner restore contract |
| Compatible backend updates and rollback | [Update flows](deployment/UPDATE-FLOW.sdoc) — canonical state transitions |
| Visual design system | [App design system](../app/DESIGN.md) — canonical visual direction and owner-confirmed decisions |
| Design, information architecture and UX acceptance | [Design and UX contract](design/UX-CONTRACT.sdoc) — normative target, not a runtime certification |
| Creative workspace information architecture | [Information architecture](design/INFORMATION-ARCHITECTURE.sdoc) — design proposal |
| Desktop writing | [Desktop authoring](design/DESKTOP-AUTHORING.sdoc) — design proposal |
| Knowledge and review | [Knowledge and review](design/KNOWLEDGE-REVIEW.sdoc) — design proposal |
| iOS native writing | [iOS authoring](design/MOBILE-AUTHORING.sdoc) — SwiftUI/TextKit target; development and automatic Xcode validation paused, not accepted on device |
| Visual system history | [Visual system](design/VISUAL-SYSTEM.sdoc) — existing proposals, comparisons and decision history; not the visual source of truth |
| Interaction and recovery states | [Interaction contract](design/INTERACTION-CONTRACT.sdoc) — design proposal |
| Trial-reading files and reader links | [Publishing design](design/PUBLISHING.sdoc) |
| Installation and local startup | [Repository README](../README.md) |
| Editing, recovery, history and layouts | [Authoring](authoring.sdoc) |
| Portable work JSON, new-project import and one-time source conversion | [Portable works](authoring-portable.sdoc) |
| First-party file names and ownership directories | [Source layout and naming](architecture/SOURCE-LAYOUT-CONVENTIONS.sdoc) — approved naming and placement target; code movement not yet implemented |
| Scripts migration tracking | [Issue #690](https://github.com/yohn-jp/codexia/issues/690) — implementation plan and full path map; not a normative document |
| Shared internal ownership and maintainability | [Internal boundaries](architecture/INTERNAL-BOUNDARIES.sdoc) |
| Storage, snapshots, mutation and authentication | [Core architecture](architecture/CORE.sdoc) |
| Passkey-first login, optional OIDC administration, API OAuth and BOLA prevention | [API authentication and authorization](architecture/API-AUTHN-AUTHZ.sdoc) — current behavior and accepted target; not deployment evidence |
| Standalone MCP OAuth resource metadata and operation scopes | [Standalone MCP OAuth](architecture/MCP-OAUTH.sdoc) |
| Backend read models, snapshot reuse and scalability | [Backend read model](architecture/BACKEND-READ-MODEL.sdoc) — normative target |
| Panels, foreground reads, search and terminology | [Modular workspace](architecture/MODULAR-WORKSPACE.sdoc) |
| External AI integration and internal LLM freeze | [MCP-first creative architecture](architecture/MCP-FIRST.sdoc) |
| Optional module ownership and lifecycle | [Modules](architecture/MODULES.sdoc) |
| Native iOS interaction rules | [Native interactions](architecture/MOBILE-INTERACTION-UX.sdoc) |
| External plugin design requirements | [Plugin platform proposal](architecture/PLUGIN-PLATFORM.sdoc) |
| Source ownership and licensing | [Source provenance](architecture/SOURCE-PROVENANCE.md) |
| Standalone image checks | [OCI verification](verification/OCI.sdoc) |
| Edge UI, API service and operations | [Deployment](deployment/DEPLOYMENT-REFERENCE.sdoc) |
| PostgreSQL recovery and backup simplification | [Backup contract](deployment/BACKUP.sdoc) and [backup design decision](deployment/BACKUP-PRODUCT-PROPOSAL.sdoc) |
| Native SwiftUI iOS client and device acceptance | [iOS client](deployment/IOS-CLIENT.sdoc) — native target and manual SwiftUI verification |
| Declarative standalone VM configuration | [Infrastructure as code](deployment/IAC.sdoc) |
| UI visual preview and Impeccable Detector | [UI preview and scanning](verification/UI-PREVIEW.sdoc) — disposable local PostgreSQL, API and authenticated visual baselines |
| Development and verification commands | [Verification](verification/VERIFICATION-REFERENCE.sdoc) |
| Test design and proof placement | [Test architecture](verification/TEST-ARCHITECTURE-OPTIMIZATION.sdoc) — normative target |
| CI graph, artifact trust, certification and delivery gates | [CI/CD architecture](verification/CI-CD.sdoc) — normative target |
| Recovery, MCP and model acceptance | [Integration verification](verification/INTEGRATION.sdoc) |
| Performance measurement | [Performance](performance/PERFORMANCE-MEASUREMENT.sdoc) |
| Release gates | [OCI releases](verification/OCI-RELEASE.sdoc) |

For architecture proposals, see [Integrated creative design](architecture/NEXT-DEVELOPMENT-PLAN.sdoc). The [historical reboot rationale](architecture/CODEXIA-REBOOT-RFC.sdoc) points to the archived source evidence. Neither overrides accepted contracts. The topic owners above are the canonical references; update the owning document rather than adding a competing specification.

Documentation describes supported behavior, contracts, procedures and explicitly identified design proposals. Execution results belong to test reports and build artifacts; contribution rules are in [CONTRIBUTING.md](../CONTRIBUTING.md).

## Supporting and operational document register

These maintained documents supplement the topic owners above. The classification prevents an implementation note, work-in-progress design or generated visual audit from silently becoming an architectural source of truth.

| Scope | Document | Authority |
| --- | --- | --- |
| Governance | [Agent governance](../AGENTS.md) · [Security reporting](../SECURITY.md) | Contributing and disclosure policy; not a second architecture |
| Product brief | [Product purpose](../app/PRODUCT.md) | Product intent and accepted UX context |
| Native SwiftUI implementation | [iOS SwiftUI architecture](architecture/IOS-SWIFTUI-ARCHITECTURE.sdoc) | Normative design with a partial native implementation. Development and automatic Xcode validation are paused. Physical-device acceptance remains required. |
| Authentication provisioning | [Better Auth runbook](deployment/ANSIBLE-AUTH-RUNTIME.sdoc) | Operational procedure |
| Base deployment | [Ansible deployment](deployment/ANSIBLE-PUSH-DEPLOYMENT.sdoc) · [Base runtime](deployment/ANSIBLE-BASE-RUNTIME.sdoc) · [Base secrets](deployment/ANSIBLE-BASE-SECRETS.sdoc) | Operational procedures, subordinate to deployment design |
| Edge configuration | [Cloudflare Access policy migration](deployment/ACCESS-POLICY-MIGRATION.sdoc) | Operational procedure |
| Release and handoff | [Push deployment runbook](deployment/PUSH-DEPLOYMENT.sdoc) · [Handoff revalidation](deployment/BACKEND-HANDOFF-REVALIDATION.sdoc) | Operational procedures, subordinate to update design |
| Recovery | [Encrypted backup, S3-compatible storage and isolated restore](deployment/BACKUP.sdoc) · [Disposable host acceptance](deployment/PUSH-HOST-CI.sdoc) | Operational procedures and recovery acceptance requirements |
| Architecture decisions | [Optimization boundaries](architecture/decisions/OPTIMIZATION-BOUNDARIES.sdoc) | Adopted bounded decisions; no legacy runtime authority |
| Feature expansion | [Development inventory](architecture/NEXT-DEVELOPMENT-INVENTORY.sdoc) · [Headless Tree outline](design/HEADLESS-TREE-OUTLINE.sdoc) | Proposal and acceptance targets |
| CI observability | [CI dashboard](verification/CI-DASHBOARD.sdoc) · [Graphify Pages](verification/GRAPHIFY-PAGES.sdoc) | Verification / visualization guidance, not runtime authority |
| Module runtime | [Module runtime](architecture/MODULE-RUNTIME.sdoc) · [Diagnostics lexicon provenance](../modules/diagnostics/src/data/README.md) | Library guidance and provenance |
| Assets and performance fixtures | [Icon design](design/BRAND-ICON.sdoc) · [Performance harness](performance/PERFORMANCE-HARNESS.sdoc) | Implementation and verification guidance |

Tool-generated design records under `app/.impeccable/`, historical dated plans under `docs/superpowers/`, archived migration evidence under `evidence/`, third-party bundled skills under `.agents/` and Assistant `*.prompt.md` templates are **not normative Codexia architecture documents**. Keep required provenance and licensing, and avoid editing bundled upstream reference material merely to make it look like current product policy.
