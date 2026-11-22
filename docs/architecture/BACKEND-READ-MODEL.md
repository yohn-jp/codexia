# Backend read model and scalability contract

Normative architecture for PostgreSQL-backed reads and derived computation. [Core](CORE.md) owns canonical records, mutation and SnapshotId semantics; [Internal boundaries](INTERNAL-BOUNDARIES.md) owns dependency direction; [Modular workspace](MODULAR-WORKSPACE.md) owns foreground/background scheduling. This document specifies the read implementation target, not a claim that every optimization is already implemented.

## Authority and identity

- PostgreSQL is the sole durable authority. Every read is authorized at API admission before entering Core; project identity is mandatory in queries, cache keys and every join. Hosted and MCP do not gain author rights through cache hits or shared services.
- A current read observes the project version from PostgreSQL in the same consistent read transaction as any dependent records. A pinned read resolves precisely the requested project and version or returns the existing unavailable/scope error. It never falls back to head. Revision contents and projected path bytes must remain identical for the same retained snapshot.
- Distinguish canonical records, durable pinned projections (which support historical readers across restart), and evictable in-memory indexes. An in-memory cache is never a substitute for durable historical availability, approvals, receipts or read-set validation. No TTL may define currentness.
- Keep the existing public HTTP/MCP DTOs, errors, IDs, ordering, Unicode semantics and authorization contracts. No API epoch, migration fingerprint or persistence-format change is implied by internal optimization.

## Project library

- Owner project discovery is a bounded keyset read ordered by `updatedAt` descending and project ID ascending. `GET /api/v1/persistence/projects?page=1&limit=200` returns `{ projects, nextCursor }`; pass the opaque `nextCursor` as `cursor` to continue. MCP `list_projects` exposes the same continuation as `next_cursor`.
- The no-page HTTP response remains the legacy array for existing clients. Hosted pages contain only the assigned project and never enumerate the owner library. A project deep link reads its requested identity directly; a missing target is an error and must not select the first listed project.

## Read paths and ownership

| Path | Required behavior | Owner |
| --- | --- | --- |
| Current scene / outline | Resolve current version and read the minimum needed data; no optional worker, external provider, or unrelated projection on the foreground critical path unless required to preserve the existing snapshot contract | Core, via Persistence |
| Pinned module reader | Resolve exact retained version, preserve file paths, hashes, enumeration and immutable historical reads | Core |
| Knowledge / Evidence projection | Read nodes, aliases, relations, mentions, anchors, source revisions and assertions consistently; preserve explicit mapping, classifications, quote validation and omission | Core projection; SQL and row mapping in Persistence |
| Literal search, tree and writing statistics | Reuse snapshot-local indexes; preserve search scoring/ties, Unicode offsets, hierarchy ordering and count rules | Core |
| Revision history | Project/document-scoped, bounded and deterministically ordered; avoid loading irrelevant bodies where only metadata is needed | Persistence and Core |
| Optional search / semantic / Story | Existing module-owned derivatives keyed to the exact source identity; see [Modular workspace](MODULAR-WORKSPACE.md) and [MCP-first](MCP-FIRST.md) | Module Runtime and respective module |

HTTP and MCP reuse the same domain operations. Do not introduce a second snapshot authority or generic read service.

Workspace module initialization uses the pinned snapshot identity and the active document path and revision hash from `GET /api/projects/{projectId}/snapshot?projection=editor`. This view resolves at most one canonical document path through Core's snapshot reader. The bulk endpoint retains its file count and UTF-8 response limits for clients requesting the full file projection.

## Snapshot materialization and reuse

Separate the semantic snapshot identity from physical materialization. The current-version path may reuse the durable projection for the observed version only after demonstrating that every dependency that affects its bytes advances that version atomically. Audit project metadata, document hierarchy and heads, Knowledge/Evidence and relevant module records, including changes introduced through ChangeSets. Internal proposal/receipt/snapshot bookkeeping must not spuriously advance the content version; if bookkeeping is part of a projection, its identity must be addressed explicitly. Do not reuse across incompatible projection implementations without proving exact byte/hash equivalence or defining an explicitly compatible format transition. Existing pinned records remain readable. The current projection epoch has a separate authority proof tied to the immutable snapshot record version. Legacy records without this proof are compared against a freshly materialized projection before reuse. At backend startup, before request admission, check the assigned Hosted project or bounded pages of standalone projects. If the legacy current projection is equivalent, record the proof without changing the content version. If its bytes differ, explicitly allocate a new project version under the project fence without modifying author data; the previous SnapshotId remains pinned to its original bytes and version-bound proposals become stale. The dedicated read-only updater preflight validates legacy projections without certifying or advancing versions; only the exclusive writer performs the transition. Ordinary reads fail closed on an incompatible untransitioned current record and never advance the version. A future incompatible projection implementation must advance the proof epoch and establish rollback compatibility.

For a cold version, obtain required data in one repeatable-read transaction. Batch lookups where applicable. Persist the exact pinned projection through the existing transaction and conflict boundary before promising durable availability. If concurrent builders race, reuse the winning equivalent representation or fail closed on discrepancy; do not overwrite an immutable retained version. A version change after the read does not transform its result into a new snapshot. Preserve missing-head-revision errors and stale proposal rejection. Avoid holding project writer locks during unrelated CPU computation or warm reads.

Derive a single request/snapshot-local index over document IDs, parent IDs, logical IDs, and metadata/body paths. Preserve collisions, order and lookup precedence; do not treat a same-name or duplicate logical ID as proof of identity. Share only immutable, bounded entries; account for memory, bytes and eviction. No unbounded process-global cache or new external cache service.

## Set-oriented persistence reads

The PostgreSQL adapter owns parameterized SQL, transaction scope, deterministic ordering and row mapping. Replace per-document head-revision lookups and repeated per-node/per-anchor lookups with bounded set-oriented reads where equivalence is established. Include project ID and exact document/revision keys, not just revision UUID or current head. Chunk large input sets within measured resource bounds; do not replace serial SQL with unbounded Promise.all across separate transactions.

Preserve each existing per-parent limit, sort order, inclusion/exclusion rule and limit-reached indicator. A global LIMIT over many parents is not equivalent. Apply quote byte budgets in the original deterministic projection order and retain quote hash/UTF-16 verification, historical source revisions, missing-record handling and ambiguous mapping. Distinguish empty results from truncated or failed reads. Reuse shared evidence/revision/ assertion data within the same snapshot where safe. Do not join rows in a way that multiplies evidence or changes provenance.

For history, the selected manifest's document head bounds the reachable revision ancestry for lists, full reads and restore proposals. Push filtering, ordering and bounded selection toward PostgreSQL without changing existing visible history semantics. Establish a stable tie policy consistent with the previous contract; any externally observable change requires explicit acceptance. Preserve immutable revision bodies for full historical reads; metadata-only results must not masquerade as full revisions.

## Resource envelope and long-form works

The existing 1,000-document materialization guard, projection per-node/per-anchor bounds, quote budgets and API result byte limits are explicit compatibility/safety boundaries until deliberately revised. They are not evidence of a supported maximum-size product. In particular, a full page at the existing snapshot limit is ambiguous; never silently truncate a hierarchy or claim an incomplete snapshot is complete.

The long-term target is long-form manuscripts without full-work CPU/SQL/serialization on every scene switch. Establish supported dataset sizes and resource budgets with actual PostgreSQL measurements, including boundary cases around the existing guard, many revisions and dense Knowledge/Evidence. Use deterministic paging or bounded bulk reads inside one consistent snapshot when evolving limits. Separate foreground reads from complete module projections where semantics allow; retain immutable revision/path behavior and prove callers that need the full projection still receive it. Reject unsupported work explicitly rather than returning partial success. Changing SQL schema or durable snapshot encoding requires a separately accepted compatibility/upgrade design under [Push deployment](../deployment/PUSH-DEPLOYMENT.md).

Retained projection volume, write amplification, transaction duration, connection-pool contention and process memory must be measured. Do not delete historical snapshots, introduce retention expiry, compress durable records or change backup requirements as a side effect of speed work. A new retention/storage design must prove referenced jobs, historical reads, approval/receipt recovery and restore remain available.

## Acceptance

| Boundary | Required proof |
| --- | --- |
| Cold vs warm snapshot | Equal outputs/hashes on identical version; no regeneration/write lock on a valid warm reuse path; fresh reads reflect committed changes; pinned reads remain identical after mutation and restart |
| Concurrency and isolation | Real PostgreSQL tests for interleaving mutation/read, concurrent builders, project/author separation, missing revision and stale version; no cross-version result or hidden canonical mutation |
| Batch reads | Compare with existing single-record semantics for missing rows, duplicate keys, empty sets, multiple parents, truncation, ordering, historical revision and quote budget |
| Tree/search/stats/history | Golden outputs on nested hierarchy, duplicate logical IDs, Japanese/Unicode bodies, equal scores, deleted documents and historical views; demonstrate work scales with inputs rather than repeated full scans |
| Work envelope | Record supported vs rejected cases, query count, DB time, row/byte volume, lock/transaction time, memory and cold/warm latency; no silent partial result |
| Integration | Existing Core/Full, HTTP/MCP, persistence, approval/replay and browser acceptance remain valid; no optional model dependency in Core |

Use [Performance measurement](../performance/README.md) for evidence and [test architecture](../verification/TEST-ARCHITECTURE-OPTIMIZATION.md) for test placement. The optimization order is to establish the PostgreSQL baseline, eliminate redundant materialization and SQL round trips, then address larger work envelopes and retention by measured need. No new infrastructure, migration or public contract change is authorized merely to improve a benchmark.
