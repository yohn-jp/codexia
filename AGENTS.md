# Codexia — Agent instructions

Codexia is independently governed. **Approved design documents, not implementation code, are the architecture's source of truth.** Use accepted product decisions, Issues and the owning normative designs for requirements; code, tests and CI are implementation and verification evidence, not design authorities. Treat conflicts as implementation deviations or explicit design changes, never silently conform the specification to legacy code. Do not assume instructions or skills from another repository are available or applicable.

## Architecture and authority

PostgreSQL is the sole manuscript authority. Git persistence, synchronization, history, and compatibility fallbacks are retired.

Read only the contracts relevant to the task:
- Design authority and system boundaries: [Documentation authority](docs/architecture/DOCUMENTATION-AUTHORITY.sdoc), [System design](docs/architecture/SYSTEM-DESIGN.sdoc), [Data model](docs/architecture/DATA-MODEL.sdoc).
- Mandatory flows: [Production deployment lifecycle](docs/deployment/DEPLOYMENT-LIFECYCLE.sdoc), [User screens](docs/design/USER-SCREEN-FLOW.sdoc), [Owner security](docs/design/ADMIN-SCREEN-FLOW.sdoc), [Initial deployment](docs/deployment/INITIAL-DEPLOYMENT-FLOW.sdoc) and [Compatible updates](docs/deployment/UPDATE-FLOW.sdoc).
- Shared ownership and refactoring: [Internal boundaries](docs/architecture/INTERNAL-BOUNDARIES.sdoc).
- AI integration and frozen internal LLM calls: [MCP-first architecture](docs/architecture/MCP-FIRST.sdoc).
- Application boundaries: [Core](docs/architecture/CORE.sdoc), [Modular Workspace](docs/architecture/MODULAR-WORKSPACE.sdoc), and [Modules](docs/architecture/MODULES.sdoc).
- Backend read/performance: [Backend read model](docs/architecture/BACKEND-READ-MODEL.sdoc).
- UI/UX: [Design and UX contract](docs/design/UX-CONTRACT.sdoc). **Target: Windows Chromium Desktop Web React + native iOS SwiftUI, with no Mobile Web/PWA authoring support or React mobile-viewport acceptance.** Desktop/iOS share server API and domain invariants, not UI components or client-side coordinators. Native design: [iOS SwiftUI architecture](docs/architecture/IOS-SWIFTUI-ARCHITECTURE.sdoc). Ionic/Capacitor authoring has been removed and is not an adopted target. Mockups are not specifications.
- Web frontend design, implementation, or review: [app design system](app/DESIGN.md), project-local [Impeccable](.agents/skills/impeccable/SKILL.md) and [Modern Web Guidance](.agents/skills/modern-web-guidance/SKILL.md).
- CI/release: [CI/CD architecture](docs/verification/CI-CD.sdoc) and [Test architecture](docs/verification/TEST-ARCHITECTURE-OPTIMIZATION.sdoc) and [E2E execution](docs/verification/E2E-EXECUTION.sdoc). Do not add cross-browser author UI compatibility requirements; retain independent public/auth obligations.
- **Approved implementation workstreams and backup console:** [implementation contract](docs/architecture/SPECIFICATION-IMPLEMENTATION-CONTRACT.sdoc), [owner backup/S3 configuration](docs/architecture/BACKUP-CONSOLE-CONTRACT.sdoc), [XState state machine](docs/design/XSTATE-STATE-MACHINE-CONTRACT.sdoc). Web config/backup requests never confer OPERATOR, SSH, raw VM command, IAM management or production restore capability. The approved backup producer and host lock remain canonical.
- **Specification tooling and migration acceptance:** [Specification toolchain](docs/architecture/SPECIFICATION-TOOLCHAIN.sdoc), [Fastify schema-first HTTP migration](docs/architecture/HTTP-PLATFORM-MIGRATION.sdoc), [MCP v2 migration](docs/architecture/MCP-V2-MIGRATION.sdoc), [tooling acceptance](docs/verification/SPECIFICATION-TOOLING-ACCEPTANCE.sdoc). These documents do not prove that the current Fastify API uses TypeSpec-generated route schemas or MCP v2; follow the explicit migration acceptance gates and do not maintain permanent dual implementations. Fastify remains the HTTP runtime; Hono is not an approved replacement.
- Initial deployment registration: [codexiactl](docs/deployment/CODEXIACTL.sdoc) owns the SSH-side guided provider authentication, protected input registration and existing Workflow dispatch contract; no local Ansible/Terraform, persistent controller, duplicate deployment authority or bypass of approval/owner enrollment.
- VM configuration: [Infrastructure as code](docs/deployment/IAC.sdoc), the Ansible desired-state and lifecycle contract. The accepted replacement backend delivery path is GitHub Actions → Cloudflare Access Service Auth → Cloudflare Tunnel → pinned OpenSSH → Ansible → rootless Podman Quadlet. Follow the approved [single Tunnel migration and qualification](docs/deployment/DEPLOYMENT-LIFECYCLE.sdoc); do not implement before the applicable real-service qualification or release before integrated acceptance. Retire Tailscale, not as a permanent fallback. Keep Cloudflare Terraform and protected release publication as distinct authorities.

[Plugin Platform](docs/architecture/PLUGIN-PLATFORM.sdoc) is a proposal, not the trusted module runtime contract. Use the [documentation index](docs/README.md) to locate the owning contract. Design targets are not implementation evidence.

## Execution

Follow the latest explicit user instruction, accepted Issue/implementation contract, and repository-local canonical sources. Implement only the accepted scope; do not introduce speculative abstractions, compatibility paths, or unrelated refactors. Reuse existing authorities and components.

Work on an isolated branch/worktree; never change `main` directly. Submit a PR for implementation changes. Merge, publish, or deploy only when explicitly authorized. Before an authorized merge, confirm the latest PR head is based on the current `main` and the exact-head Verify has succeeded; use the read-only `scripts/ci/certification/merge-readiness.mjs` advisory when available. Do not force a full PR plan solely to make main proof reusable. Do not overwrite unrelated work or bypass guards. Keep execution prompts and verification results in PRs or test artifacts, not maintained product documentation. Preserve the closed migration evidence in `evidence/migration`; do not reopen its ledger.

## Validation

Use `pnpm install --frozen-lockfile`, `pnpm typecheck`, `pnpm test`, `pnpm build`, and `pnpm audit:core` as applicable. Follow [verification](docs/verification/VERIFICATION-REFERENCE.sdoc) for test-source/safety, browser, integration, and OCI checks when affected. Report checks actually executed; never treat pending or unavailable checks as passed. Verification does not publish or deploy; only the gated release workflow publishes. Follow [documentation rules](CONTRIBUTING.md#documentation).
