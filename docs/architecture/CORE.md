# Core architecture

Codexia is a TypeScript/Node application with a PostgreSQL-backed Core, a Fastify API and React browser shells. Core authoring works without optional modules or model credentials. PostgreSQL is the only durable authority for projects, documents, revisions, Knowledge, Evidence and approved changes. Runtime storage and browser recovery have separate roles.

## Ownership and dependency direction

```text
Desktop / Mobile / HTTP / MCP
                ↓
Shared read, propose and approved mutation contracts
                ↓
Core project coordinator + immutable PostgreSQL readers
                ↓
Persistence boundary
                ↓
PostgreSQL project records, documents, revisions and module data
```

| Area | Owner |
| --- | --- |
| Revision, operation, snapshot and module contracts | `packages/contracts` |
| Database record/query/transaction contracts | `packages/persistence-contracts` |
| PostgreSQL schema, queries and migrations | `packages/persistence-postgres` |
| Project coordination, snapshots, proposals and application | `packages/core` |
| Authentication, HTTP boundaries, static assets and host integration | `packages/api` |
| Module resolution, activation and supervised workers | `packages/module-runtime` |
| Legacy data import into reviewable operations | `packages/migration` |
| Authoring, browser recovery and shell composition | `app` |
| Domain analysis and optional features | `modules` |

Core does not import optional module packages, model engines or provider SDKs. Modules use public contracts and host capabilities; they do not import Core implementation files or become independent database writers.

## Canonical state and snapshots

PostgreSQL stores project identity and settings, hierarchy records, immutable Markdown revisions, knowledge nodes and relations, evidence anchors and history, module-owned records, and revision-bound proposals. The familiar authoring paths identify records exposed through Core; they are not repository files. Database queries and writes always carry a project ID.

A `SnapshotId` binds a project ID to its project version. A document revision has its own canonical PostgreSQL UUID and immutable body. Project versions advance with successful authoring transactions; document revision IDs support history and restore. Hierarchy caches, search indexes, graphs, downloaded weights and diagnostics are reconstructible derivatives keyed by their source project/document revision and module or model identity.

Unsupported legacy metadata is preserved during explicit import. Runtime authoring does not clone a Git repository, inspect remote branches or fall back to local files when PostgreSQL is unavailable.

## Mutation and revision safety

Persistent changes use the shared proposal, approval and apply boundary. Each operation carries a stable identity, declared read/write sets, project version and document revision preconditions. An authenticated author approves the operation; external tools cannot approve their own proposals.

Core validates the project scope, operation identity, expected project version, document revisions and document content before applying changes in a PostgreSQL transaction. Revision writes, hierarchy updates, knowledge/evidence mutations and associated module records commit together or roll back together. A stale project or document revision returns a conflict; Core does not silently merge prose or overwrite a newer revision.

Idempotency keys preserve operation identity across response loss. Replaying a completed operation returns its original outcome; reusing an identity for different data fails. Browser recovery retains pending operations until the server confirms their durable transition.

## Recovery and history

Browser recovery is scoped to project, author and origin. Journal records retain operation identity, generation and revision bindings. Reconciliation must complete before an editor is represented as recovered and writable. Quota, storage and conflict failures preserve recoverable work and surface their state.

PostgreSQL is the source for project history, immutable document revisions and restore. Private runtime usage and job history live under `CODEXIA_USAGE_DIR` independently from project data. Deployment replacement must preserve the database and the private `/history` volume. `/data` is reserved for derived runtime caches.

## Authentication and isolation

Standalone mode uses one trusted owner token. Every authenticated session can access all PostgreSQL projects served by that instance; this is not a multi-tenant ACL service. `CODEXIA_DATABASE_URL` and healthy PostgreSQL are required for startup and readiness.

Hosted mode validates the mounted Praetorium assignment and signed access grant. Gateway grants bind user, repository, instance, runtime epoch, permissions and authorization/session revisions. `CODEXIA_HOSTED_PROJECT_ID` binds the runtime to one existing PostgreSQL project. Project lists, linked reads, actions, proposals, history and persistence routes enforce that assignment. Hosted project creation is forbidden.

Runtime status and quiesce controls use a separate short-lived signed control credential. Status reports PostgreSQL provider, assigned project ID and project version. Database or project unavailability is reported as unknown durability and blocks a safe quiesce. Runtime draining preserves active job/history checks and does not approve pending changes.

## Runtime and packaging

Core and Full are reproducible profiles of the root Dockerfile. Each deployment uses one application container connected to a private PostgreSQL service. Core excludes optional packages, native model runtimes and weights from its production closure. Full includes trusted modules with lazy activation and supervised computation; module failure must not take basic writing offline.

Shutdown stops new mutations and drains bounded in-flight work. It preserves unresolved database and private job-history status for control-plane decisions. Health, readiness and host-control surfaces are owned by the API.

See [modules](MODULES.md), [workspace composition](MODULAR-WORKSPACE.md), [source provenance](SOURCE-PROVENANCE.md), [Hosted deployment](../HOSTED-DEPLOYMENT.md) and [verification](../verification/README.md) for the corresponding contracts and checks.
