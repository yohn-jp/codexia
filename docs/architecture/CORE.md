# Core architecture

PostgreSQL is the sole authority for projects, document hierarchy, Markdown bodies, immutable revisions, Knowledge, Evidence, Text Anchors and module-owned records. Core authoring works without optional modules or model credentials. A missing or unavailable database fails closed; no Git workspace or filesystem manuscript fallback is available.

## Ownership and dependency direction

Desktop and Mobile shells use the authenticated API. API admission owns authentication, project authorization, origin checks, cancellation and lifecycle draining. Core coordinates module snapshots and approved mutations through Persistence; the PostgreSQL adapter owns transactions and record validation. Core never imports optional module implementations or model providers.

| Area | Owner |
| --- | --- |
| Snapshot, operation and trusted module contracts | `packages/contracts` |
| Canonical records, revision and ChangeSet interfaces | `packages/persistence-contracts` |
| PostgreSQL transactions, schema and checked migrations | `packages/persistence-postgres` |
| Project read models and module proposal coordination | `packages/core` |
| Authentication, API admission and host integration | `packages/api` |
| Lazy module activation and supervised workers | `packages/module-runtime` |
| Read-only legacy inspection and import proposals | `packages/migration` |
| Authoring, browser recovery and separate shells | `app` |

## Canonical state and snapshots

Documents retain stable IDs, hierarchy, order and immutable body revisions. Metadata changes use version preconditions. Deletion preserves historical revisions and evidence rather than erasing author data. Knowledge and Evidence are project-scoped; Text Anchors bind UTF-16 ranges and quote hashes to exact document revisions. Saving a body maps unaffected anchors and marks overlapping or removed ranges for review.

A module `SnapshotId` contains `projectId` and `projectVersion`. The Core materializes one consistent PostgreSQL read and retains pinned views for asynchronous work. Content mutations advance the project version atomically. Read models cannot combine content from different snapshots or substitute current content for an unavailable historical revision.

The module file-shaped reader is a projection over PostgreSQL records. Stable manuscript, hierarchy and `meta/scriptorium/modules/<module-id>/` paths are domain identifiers, not checkout locations. They preserve existing module formats and unknown data without introducing another authority. Search indexes, model artifacts and caches remain reconstructible derivatives keyed by source revision and model/schema identity.

## Mutation and recovery

Document saves require the observed base revision, exact text changes, resulting hash and an idempotency key. A stale base conflicts without overwriting the author's draft. Revision restore creates a new immutable revision. Retry returns the original successful result rather than duplicating the write.

Modules and MCP receive read and proposal ports. Only the authenticated author boundary may approve. Approved operations declare their read/write sets and scope guards; PostgreSQL transactions recheck preconditions and apply writes atomically. Durable proposal state and application receipts survive process or local-state replacement. Cancellation or a lost response does not imply that an accepted write was rolled back.

Browser IndexedDB stores recoverable drafts and pending proposals separately from canonical records. Input and IME state remain immediately authoritative while editing. A save indicator requires the database result and the corresponding durable local journal transition. Conflicts, storage errors and uncertain responses preserve recovery data. Author/project scope and navigation generations fence late responses.

## Portable work import, export and backup

The standard product exchange is a versioned `codexia-work/v1` JSON current-state archive. Export reads one consistent PostgreSQL snapshot of work metadata, Markdown, Knowledge, supported Evidence and author-owned module records. Import validates references and hashes, creates a fresh project atomically, and never overwrites an existing project. Stale Evidence is retained explicitly without forging a current anchor. Historical revisions, credentials, approval state and browser drafts are not silently presented as portable content; see [Portable works](../authoring-portable.md).\n\nLegacy inspection reads explicitly selected source directories without modifying files, SQLite sidecars or Git metadata. Git source inspection is restricted to offline migration recovery; it never serves as application persistence, synchronization or runtime fallback. The one-time source conversion is an operator task external to the normal product importer. Existing read-only migration inspection capabilities do not act as a second manuscript authority; author-approved import operations remain subject to Core permissions. Secrets are excluded, unresolved records are reported, and source data remains intact.

Publishing exports read pinned PostgreSQL projections. Operational recovery uses protected PostgreSQL backups plus private host-history backups; see [deployment](../deployment/README.md). Rehearse restoration into an isolated replacement database before changing service routing. Do not restore over the only copy or operate on production data during verification.
