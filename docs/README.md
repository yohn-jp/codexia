# Codexia documentation

Codexia is a PostgreSQL-backed writing workspace with a minimal Core and optional trusted modules. Git repository persistence and publishing are not part of the runtime.

| Topic | Reference |
| --- | --- |
| Design, information architecture and UX acceptance | [Design and UX contract](design/UX-CONTRACT.md) — normative target, not a runtime certification |
| Creative workspace information architecture | [Information architecture](design/INFORMATION-ARCHITECTURE.md) — design proposal |
| Desktop writing | [Desktop authoring](design/DESKTOP-AUTHORING.md) — design proposal |
| Knowledge and review | [Knowledge and review](design/KNOWLEDGE-REVIEW.md) — design proposal |
| Mobile writing | [Mobile authoring](design/MOBILE-AUTHORING.md) — design proposal |
| Visual system | [Visual system](design/VISUAL-SYSTEM.md) — design proposal |
| Interaction and recovery states | [Interaction contract](design/INTERACTION-CONTRACT.md) — design proposal |
| Installation and local startup | [Repository README](../README.md) |
| Editing, recovery, history and layouts | [Authoring](authoring.md) |
| Portable work JSON, new-project import and one-time source conversion | [Portable works](authoring-portable.md) |
| Shared internal ownership and maintainability | [Internal boundaries](architecture/INTERNAL-BOUNDARIES.md) |
| Storage, snapshots, mutation and authentication | [Core architecture](architecture/CORE.md) |
| Backend read models, snapshot reuse and scalability | [Backend read model](architecture/BACKEND-READ-MODEL.md) — normative target |
| Panels, foreground reads, search and terminology | [Modular workspace](architecture/MODULAR-WORKSPACE.md) |
| External AI integration and internal LLM freeze | [MCP-first creative architecture](architecture/MCP-FIRST.md) |
| Optional module ownership and lifecycle | [Modules](architecture/MODULES.md) |
| Mobile interaction rules | [Mobile interactions](architecture/MOBILE-INTERACTION-UX.md) |
| External plugin design requirements | [Plugin platform proposal](architecture/PLUGIN-PLATFORM.md) |
| Source ownership and licensing | [Source provenance](architecture/SOURCE-PROVENANCE.md) |
| Standalone image checks | [OCI verification](verification/OCI.md) |
| Hosted builds and runtime configuration | [Hosted deployment](HOSTED-DEPLOYMENT.md) |
| Edge UI, API service and operations | [Deployment](deployment/README.md) |
| Declarative standalone VM configuration | [Infrastructure as code](deployment/IAC.md) |
| Hosted producer signing | [Producer attestation](hosted-producer-attestation.md) |
| Development and verification commands | [Verification](verification/README.md) |
| Test design and proof placement | [Test architecture](verification/TEST-ARCHITECTURE-OPTIMIZATION.md) — normative target |
| CI graph, artifact trust, certification and delivery gates | [CI/CD architecture](verification/CI-CD.md) — normative target |
| Recovery, MCP and model acceptance | [Integration verification](verification/INTEGRATION.md) |
| Performance measurement | [Performance](performance/README.md) |
| Release gates | [OCI releases](verification/OCI-RELEASE.md) |

For architecture proposals, see [Integrated creative design](architecture/NEXT-DEVELOPMENT-PLAN.md). The [historical reboot rationale](architecture/CODEXIA-REBOOT-RFC.md) points to the archived source evidence. Neither overrides accepted contracts. The topic owners above are the canonical references; update the owning document rather than adding a competing specification.

Documentation describes supported behavior, contracts, procedures and explicitly identified design proposals. Execution results belong to test reports and build artifacts; contribution rules are in [CONTRIBUTING.md](../CONTRIBUTING.md).
