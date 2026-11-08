# Codexia documentation

**Active runtime:** PostgreSQL-backed authoring. Git is used for application source control only, never as a manuscript authority. The retired Git/Core workspaces and their module runtime have no supported authoring route.

| Subject | Current source |
| --- | --- |
| Installation, supported capability and known non-parity | [Repository README](../README.md) |
| PostgreSQL projects, revisions, Knowledge and Evidence | [PostgreSQL persistence contracts](../packages/persistence-contracts/src/index.ts) and [Postgres adapter](../packages/persistence-postgres/src/postgres-store.ts) |
| Authenticated API | [Persistence routes](../packages/api/src/persistence-routes.ts) and [server](../packages/api/src/server.ts) |
| Desktop/Mobile manuscript editing and recovery | [PersistenceWorkspace](../app/src/persistence/PersistenceWorkspace.tsx) and [browser Journal](../app/src/storage/journal.ts) |
| Deployment, secrets, database and backup | [Deployment operations](deployment/README.md) |
| Real verification gates | [Verification](verification/README.md) |
| PostgreSQL design intent and future capabilities | [Reboot RFC](architecture/CODEXIA-REBOOT-RFC.md) |

The remaining Scriptorium-era Git/Core architecture, modular-workspace, hosted, authoring and UX documents are **historical references** until reconciled with the PostgreSQL-only runtime. They must not be cited as proof that a deleted module, Git-backed publication, public reader or missing export/import feature is implemented.

Execution outcomes belong in CI, PRs and test artifacts, not normative documentation. Follow [AGENTS.md](../AGENTS.md) and [CONTRIBUTING.md](../CONTRIBUTING.md).
