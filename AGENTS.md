# Codexia — Agent instructions

Codexia is independently governed. Use this repository's accepted Issues, canonical code, architecture, tests, and documentation as task authority. Do not assume instructions or skills from another repository are available or applicable.

## Architecture and authority

PostgreSQL is the sole manuscript authority. Git persistence, synchronization, history, and compatibility fallbacks are retired.

Read only the contracts relevant to the task:
- Shared ownership and refactoring: [Internal boundaries](docs/architecture/INTERNAL-BOUNDARIES.md).
- AI integration and frozen internal LLM calls: [MCP-first architecture](docs/architecture/MCP-FIRST.md).
- Application boundaries: [Core](docs/architecture/CORE.md), [Modular Workspace](docs/architecture/MODULAR-WORKSPACE.md), and [Modules](docs/architecture/MODULES.md).
- Backend read/performance: [Backend read model](docs/architecture/BACKEND-READ-MODEL.md).
- UI/UX: [Design and UX contract](docs/design/UX-CONTRACT.md). Preserve distinct Desktop/Mobile shells and shared authoring, durability, and authorization boundaries. Mockups are not specifications.
- Web frontend design, implementation, or review: project-local [Modern Web Guidance](.agents/skills/modern-web-guidance/SKILL.md).
- CI/release: [CI/CD architecture](docs/verification/CI-CD.md) and [Test architecture](docs/verification/TEST-ARCHITECTURE-OPTIMIZATION.md).
- VM configuration: [Infrastructure as code](docs/deployment/IAC.md), the Ansible desired-state and lifecycle contract. The sole backend delivery path is GitHub Actions → Tailscale OIDC → pinned SSH → Ansible → rootless Podman Quadlet. Keep Cloudflare Terraform and protected release publication as distinct authorities.

[Plugin Platform](docs/architecture/PLUGIN-PLATFORM.md) is a proposal, not the trusted module runtime contract. Use the [documentation index](docs/README.md) to locate the owning contract. Design targets are not implementation evidence.

## Execution

Follow the latest explicit user instruction, accepted Issue/implementation contract, and repository-local canonical sources. Implement only the accepted scope; do not introduce speculative abstractions, compatibility paths, or unrelated refactors. Reuse existing authorities and components.

Work on an isolated branch/worktree; never change `main` directly. Submit a PR for implementation changes. Merge, publish, or deploy only when explicitly authorized. Do not overwrite unrelated work or bypass guards. Keep execution prompts and verification results in PRs or test artifacts, not maintained product documentation. Preserve the closed migration evidence in `evidence/migration`; do not reopen its ledger.

## Validation

Use `pnpm install --frozen-lockfile`, `pnpm typecheck`, `pnpm test`, `pnpm build`, and `pnpm audit:core` as applicable. Follow [verification](docs/verification/README.md) for test-source/safety, browser, integration, and OCI checks when affected. Report checks actually executed; never treat pending or unavailable checks as passed. Verification does not publish or deploy; only the gated release workflow publishes. Follow [documentation rules](CONTRIBUTING.md#documentation).
