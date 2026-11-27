# Backend read model and scalability contract

Normative architecture for PostgreSQL-backed reads and derived computation. [Core](CORE.md) owns canonical records, mutation and SnapshotId semantics; [Internal boundaries](INTERNAL-BOUNDARIES.md) owns dependency direction; [Modular workspace](MODULAR-WORKSPACE.md) owns foreground/background scheduling. This document specifies the read implementation target, not a claim that every optimization is already implemented.

## Authority and identity

- PostgreSQL is the sole durable authority. Every API read is authorized before entering Core. Queries, cache keys and joins require the project identity. MCP reads remain within the client's assigned projects and allowed scopes when they reuse a cache or service.
- A current read observes the project version from PostgreSQL in the same consistent read transaction as any dependent records. A pinned read resolves precisely the requested project and version or returns the existing unavailable/scope error. It never falls back to head. Revision contents and projected path bytes must remain identical for the same retained snapshot.
- Distinguish canonical records, durable pinned projections (which support historical readers across restart), and evictable in-memory indexes. An in-memory cache is never a substitute for durable historical availability, approvals, receipts or read-set validation. No TTL may define currentness.
- Keep the existing public HTTP/MCP DTOs, errors, IDs, ordering, Unicode semantics and authorization contracts. No API epoch, migration fingerprint or persistence-format change is implied by internal optimization.

## Project library

- Owner project discovery is a bounded keyset read ordered by `updatedAt` descending and project ID ascending. `GET /api/v1/persistence/projects` returns `{ projects, nextCursor }`. The optional `limit` ranges from 1 to 200 and defaults to 200. Pass the opaque `nextCursor` as `cursor` to continue. A null continuation ends the listing.
- `GET /api/projects` returns `{ projects, nextCursor }` for every successful request. Use optional `limit` (1–200, default 200) and pass a returned opaque string as `cursor`. A null continuation ends the listing. MCP `list_projects` exposes that continuation as `next_cursor`. OAuth MCP discovery includes only the client’s assigned projects. A project deep link reads its requested identity directly and returns an error if the project is missing.
- `core.projects.list` uses the first page of the same authorized discovery with a limit of 200 and returns `{ projects }`. For a scoped MCP caller, select the assigned projects before applying that limit.

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

Workspace module initialization uses the pinned snapshot identity and the active document path and revision hash from `GET /api/projects/{projectId}/snapshot?projection=editor`. This view resolves at most one canonical document path through Core's snapshot reader. API epoch 2 requires `projection=editor` for this route. Domain actions serve scoped module reads, and the portable work archive serves current-state export.

## Snapshot materialization and reuse

Separate the semantic snapshot identity from physical materialization. The current-version path may reuse the durable projection for the observed version only after demonstrating that every dependency that affects its bytes advances that version atomically. Audit project metadata, document hierarchy and heads, Knowledge/Evidence and relevant module records, including changes introduced through ChangeSets. Internal proposal, receipt and snapshot bookkeeping preserves the content version unless it changes the projection. Existing pinned records remain readable. The current projection epoch has a separate authority proof tied to the immutable snapshot record version. Before request admission, a read-only PostgreSQL query checks for current records without proof across the installation's projects. If it finds a gap, startup reports a bounded set of affected project IDs and requires explicit maintenance.

Run the packaged `maintain-snapshot-projections --check [--project UUID]` command with the approved database connection. It reports projects with pending snapshot proofs and projects with live legacy Publishing records separately, including Publishing records for projects without a materialized snapshot. Apply transitions only through approved maintenance using the exact certified image, verified backup and exclusive writer. The `--apply` command first converts the live Publishing records under the project fence, then compares remaining pending snapshot records against the canonical projection. It records proof for equivalent bytes while preserving the project version. If bytes differ, it advances the project version and retains the old SnapshotId and exact pinned bytes. Version-bound proposals then report stale. The check uses read-only queries, and apply requires the writable PostgreSQL role. Normal startup requires both checks to clear for its scope. A future incompatible projection implementation must advance the proof epoch and establish rollback compatibility.

For a cold version, obtain the projection and its document heads in one repeatable-read transaction. New retained manifests store the document ID, immutable revision ID and stored SHA-256 for each manuscript path. PostgreSQL remains the body authority. A body read resolves the exact project, document and revision tuple, checks the retained digest and uses bounded batches for multiple paths. Older pinned manifests retain their exact inline bytes. Hash-only validation uses retained path digests without materializing bodies. Persist the projection before promising durable availability. Concurrent builders reuse an equivalent result or fail on a discrepancy, and a later project version never changes the retained snapshot. Preserve missing-head errors and stale proposal rejection. Keep unrelated work outside the project writer lock.

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
