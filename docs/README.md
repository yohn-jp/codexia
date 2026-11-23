# Codexia documentation

Codexia is a PostgreSQL-backed writing workspace with a minimal Core and optional trusted modules. Git repository persistence and publishing are not part of the runtime. **Approved design documents, not the current code, are the architectural source of truth.** Start with [Documentation authority](architecture/DOCUMENTATION-AUTHORITY.md) and [System design](architecture/SYSTEM-DESIGN.md); runtime and CI are compliance evidence, not substitute specifications.

| Topic | Reference |
| --- | --- |
| Documentation precedence and change governance | [Documentation authority](architecture/DOCUMENTATION-AUTHORITY.md) — canonical design-first governance |
| Principal/URL/HTTP authorization contract | [Route authorization](architecture/ROUTE-AUTHORIZATION-CONTRACT.md) — API privileges by URL, principal, method and setup/owner state |
| Complete screen, control and user journey catalog | [Screen control catalog](design/SCREEN-CONTROL-CATALOG.md) — route/CTA/error/authorization traceability |
| Individual screen state diagrams | [Screen State Atlas](design/SCREEN-STATE-ATLAS.md) — all logical screen transitions and recovery paths |
| GitHub Pages feature inventory and publication boundaries | [Pages inventory](verification/PAGES-FUNCTION-INVENTORY.md) — observed routes, sources, limitations, gaps, live deployment not verified |
| Development Pages unified portal and screen navigation | [Pages sitemap and UX proposal](design/DEVELOPMENT-PAGES-UX.md) — proposed homepage, Graphify improvements and six task-flow diagrams; not implemented |
| Graphical, source-bound diagrams | [Architecture Atlas](https://yohn-jp.github.io/codexia/architecture/) · [viewer and verification](verification/ARCHITECTURE-ATLAS.md) — SVG diagram viewer, built and validated by Repository Audit Pages |
| Overall architecture and trust boundaries | [System design](architecture/SYSTEM-DESIGN.md) — canonical system design |
| PostgreSQL domain and schema invariants | [Data model](architecture/DATA-MODEL.md) — canonical domain design |
| User screen navigation and recovery | [User screen flows](design/USER-SCREEN-FLOW.md) — canonical state transitions |
| Owner security management and admin boundaries | [Admin screen flows](design/ADMIN-SCREEN-FLOW.md) — canonical `/console`, `/console/setup`, `/console/security`, `/console/identity` routing and state transitions (target, not implemented) |
| Pristine VM, one-time setup key, first owner and recovery | [Initial deployment flows](deployment/INITIAL-DEPLOYMENT-FLOW.md) — SSH-ready VM, Ansible, Workers setup-only/API, protected activation and existing-owner restore contract |
| Compatible backend updates and rollback | [Update flows](deployment/UPDATE-FLOW.md) — canonical state transitions |
| Visual design system | [App design system](../app/DESIGN.md) — canonical visual direction and owner-confirmed decisions |
| Design, information architecture and UX acceptance | [Design and UX contract](design/UX-CONTRACT.md) — normative target, not a runtime certification |
| Creative workspace information architecture | [Information architecture](design/INFORMATION-ARCHITECTURE.md) — design proposal |
| Desktop writing | [Desktop authoring](design/DESKTOP-AUTHORING.md) — design proposal |
| Knowledge and review | [Knowledge and review](design/KNOWLEDGE-REVIEW.md) — design proposal |
| Mobile writing | [Mobile authoring](design/MOBILE-AUTHORING.md) — design proposal |
| Visual system history | [Visual system](design/VISUAL-SYSTEM.md) — existing proposals, comparisons and decision history; not the visual source of truth |
| Interaction and recovery states | [Interaction contract](design/INTERACTION-CONTRACT.md) — design proposal |
| Trial-reading files and reader links | [Publishing design](design/PUBLISHING.md) |
| Installation and local startup | [Repository README](../README.md) |
| Editing, recovery, history and layouts | [Authoring](authoring.md) |
| Portable work JSON, new-project import and one-time source conversion | [Portable works](authoring-portable.md) |
| Shared internal ownership and maintainability | [Internal boundaries](architecture/INTERNAL-BOUNDARIES.md) |
| Storage, snapshots, mutation and authentication | [Core architecture](architecture/CORE.md) |
| Passkey-first login, optional OIDC administration, API OAuth and BOLA prevention | [API authentication and authorization](architecture/API-AUTHN-AUTHZ.md) — current behavior and accepted target; not deployment evidence |
| Standalone MCP OAuth resource metadata and operation scopes | [Standalone MCP OAuth](architecture/MCP-OAUTH.md) |
| Backend read models, snapshot reuse and scalability | [Backend read model](architecture/BACKEND-READ-MODEL.md) — normative target |
| Panels, foreground reads, search and terminology | [Modular workspace](architecture/MODULAR-WORKSPACE.md) |
| External AI integration and internal LLM freeze | [MCP-first creative architecture](architecture/MCP-FIRST.md) |
| Optional module ownership and lifecycle | [Modules](architecture/MODULES.md) |
| Mobile interaction rules | [Mobile interactions](architecture/MOBILE-INTERACTION-UX.md) |
| External plugin design requirements | [Plugin platform proposal](architecture/PLUGIN-PLATFORM.md) |
| Source ownership and licensing | [Source provenance](architecture/SOURCE-PROVENANCE.md) |
| Standalone image checks | [OCI verification](verification/OCI.md) |
| Edge UI, API service and operations | [Deployment](deployment/README.md) |
| Native iOS client, on-demand unsigned IPA workflow and personal-device acceptance | [iOS client](deployment/IOS-CLIENT.md) — workflow implemented; physical-device acceptance unverified |
| Declarative standalone VM configuration | [Infrastructure as code](deployment/IAC.md) |
| UI visual preview and Impeccable Detector | [UI preview and scanning](verification/UI-PREVIEW.md) — disposable local PostgreSQL, API and authenticated visual baselines |
| Development and verification commands | [Verification](verification/README.md) |
| Test design and proof placement | [Test architecture](verification/TEST-ARCHITECTURE-OPTIMIZATION.md) — normative target |
| CI graph, artifact trust, certification and delivery gates | [CI/CD architecture](verification/CI-CD.md) — normative target |
| Recovery, MCP and model acceptance | [Integration verification](verification/INTEGRATION.md) |
| Performance measurement | [Performance](performance/README.md) |
| Release gates | [OCI releases](verification/OCI-RELEASE.md) |

For architecture proposals, see [Integrated creative design](architecture/NEXT-DEVELOPMENT-PLAN.md). The [historical reboot rationale](architecture/CODEXIA-REBOOT-RFC.md) points to the archived source evidence. Neither overrides accepted contracts. The topic owners above are the canonical references; update the owning document rather than adding a competing specification.

Documentation describes supported behavior, contracts, procedures and explicitly identified design proposals. Execution results belong to test reports and build artifacts; contribution rules are in [CONTRIBUTING.md](../CONTRIBUTING.md).

## Supporting and operational document register

These maintained documents supplement the topic owners above. The classification prevents an implementation note, work-in-progress design or generated visual audit from silently becoming an architectural source of truth.

| Scope | Document | Authority |
| --- | --- | --- |
| Governance | [Agent governance](../AGENTS.md) · [Security reporting](../SECURITY.md) | Contributing and disclosure policy; not a second architecture |
| Product brief | [Product purpose](../app/PRODUCT.md) | Product intent and accepted UX context |
| Native packaging | [Capacitor client notes](../app/native/README.md) | Implementation and build guidance |
| Authentication provisioning | [Better Auth runbook](../deploy/ansible/AUTH-RUNTIME.md) | Operational procedure |
| Base deployment | [Ansible deployment](../deploy/ansible/README.md) · [Base runtime](../deploy/ansible/BASE-RUNTIME.md) · [Base secrets](../deploy/ansible/BASE-SECRETS.md) | Operational procedures, subordinate to deployment design |
| Edge configuration | [Cloudflare Access policy migration](../deploy/cloudflare/terraform/ACCESS-POLICY-MIGRATION.md) | Operational procedure |
| Release and handoff | [Push deployment runbook](deployment/PUSH-DEPLOYMENT.md) · [Handoff revalidation](deployment/BACKEND-HANDOFF-REVALIDATION.md) | Operational procedures, subordinate to update design |
| Recovery | [Encrypted backup and restore](deployment/BACKUP.md) · [Disposable host acceptance](deployment/PUSH-HOST-CI.md) | Operational / verification procedures |
| Architecture decisions | [Optimization boundaries](architecture/decisions/OPTIMIZATION-BOUNDARIES.md) | Adopted bounded decisions; no legacy runtime authority |
| Feature expansion | [Development inventory](architecture/NEXT-DEVELOPMENT-INVENTORY.md) · [Headless Tree outline](design/HEADLESS-TREE-OUTLINE.md) | Proposal and acceptance targets |
| CI observability | [CI dashboard](verification/CI-DASHBOARD.md) · [Graphify Pages](verification/GRAPHIFY-PAGES.md) | Verification / visualization guidance, not runtime authority |
| Module runtime | [Module runtime](../packages/module-runtime/README.md) · [Diagnostics lexicon provenance](../modules/diagnostics/src/data/README.md) | Library guidance and provenance |
| Assets and performance fixtures | [Icon design](../scripts/branding/README.md) · [Performance harness](../scripts/performance/README.md) | Implementation and verification guidance |

Tool-generated design records under `app/.impeccable/`, historical dated plans under `docs/superpowers/`, archived migration evidence under `evidence/`, third-party bundled skills under `.agents/` and Assistant `*.prompt.md` templates are **not normative Codexia architecture documents**. Keep required provenance and licensing, and avoid editing bundled upstream reference material merely to make it look like current product policy.
