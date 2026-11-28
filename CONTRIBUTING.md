# Contributing to Codexia

Start with the [documentation index](docs/README.md), [design authority](docs/architecture/DOCUMENTATION-AUTHORITY.sdoc), [system design](docs/architecture/SYSTEM-DESIGN.sdoc) and the owning domain contract. Code and tests must conform to accepted designs; their current contents are not normative specifications.

For third-party dependencies, follow the [normative library selection policy](docs/architecture/DEPENDENCY-POLICY.sdoc) and [existing dependency register](docs/architecture/DEPENDENCY-INVENTORY.sdoc): prefer maintained libraries for security-sensitive general-purpose behavior, select the latest stable release, distinguish manifest SemVer ranges from lockfile-resolved versions, record any evidence-backed compatibility exception, and verify affected contracts. Update the direct-dependency register in the **same PR** as any dependency manifest change. A selected dependency is not evidence that implementation or CI validation is complete.

- Agree on a scoped problem and acceptance criteria before implementation.
- Work on an isolated branch and submit a pull request; do not write directly to `main`.
- Preserve Core's dependency boundary and shared authorization, mutation and recovery contracts.
- Describe behavior changes, relevant dependencies and validation actually executed.
- Keep work repositories, manuscripts, credentials, caches, embeddings and model artifacts out of source control.
- Use the applicable organization agent governance for agent-assisted changes.

Run `pnpm install --frozen-lockfile`, `pnpm typecheck`, `pnpm test`, `pnpm build` and `pnpm audit:core`. Run test-source/safety type checks and the browser, integration or image checks appropriate to the changed paths; see [verification](docs/verification/VERIFICATION-REFERENCE.sdoc). Verification does not publish or deploy. Publication uses the [gated release workflow](docs/verification/OCI-RELEASE.sdoc).

## Documentation

Update the owning normative design document before implementing architectural changes. Classify it as normative, runbook, proposal or historical evidence according to [design authority](docs/architecture/DOCUMENTATION-AUTHORITY.sdoc). A code/design mismatch is a deviation until an explicit design change is approved.

Write documentation as a maintained reference for users, contributors or operators. Describe supported behavior, ownership, invariants and reproducible procedures. Identify design proposals by their intended contract and keep them separate from supported runtime behavior.

Do not put dates, dated filenames, inspected branch/commit snapshots, Issue/PR/Epic numbers, waves, implementation phases, campaign instructions, progress checklists or execution results in documentation. Put work tracking in issues and pull requests, and machine results in check artifacts. A required API identifier, configuration name, dependency version or artifact-digest placeholder belongs in the procedure that uses it.

Update references when moving or removing documents. Check relative links and verify commands against the repository entry points. Preserve licensing/provenance requirements and immutable verification inputs without treating historical audit material as product instructions.

For security concerns, use [SECURITY.md](SECURITY.md).
