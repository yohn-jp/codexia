# MCP-first creative architecture

Status: accepted architecture contract. This defines the target architecture, not a claim of implementation or deployment acceptance. It refines [Core](CORE.md), [Internal boundaries](INTERNAL-BOUNDARIES.md), [Modules](MODULES.md), [Modular workspace](MODULAR-WORKSPACE.md) and [Integrated creative design](NEXT-DEVELOPMENT-PLAN.md). Where older proposals describe expanding internal LLM execution, this contract takes precedence. Existing storage, authoring, authorization and release invariants remain authoritative.

## Product boundary

Codexia owns manuscript and creative knowledge, structured retrieval, deterministic validation, proposals, review and durable application. External AI clients (ChatGPT, Codex and other MCP clients) own generative inference, reasoning and drafting. MCP is the primary integration surface for these clients, not a second business logic or persistence layer.

Internal LLM API execution is frozen: do not extend provider integrations, model selection, generation, streaming, inference queues, token charging or provider-backed workflows. Preserve existing Assistant assets, stored data and compatibility while transitioning; their presence is not authority to expand or depend on them. Integration of previously prepared work is a baseline consolidation, not an exception permitting new provider development. Runtime removal or default changes must preserve author data and be separately verified. Optional local NLP, lexical/semantic retrieval, embeddings, speaker attribution and deterministic diagnostics remain distinct capabilities; do not make them Core dependencies.

## Logical architecture

```text
External AI -> MCP adapter (stdio / Streamable HTTP) --+
Web UI      -> authenticated HTTP API ----------------+ 
                                                       v
                         Shared Action / application services
                         Story | Knowledge | Evidence | Search
                         Context | Scenario | Diagnostics | other modules
                                                       v
                         Core / native Persistence ChangeSet
                         PostgreSQL (sole canonical authority)
```

Retain the trusted module runtime and its profile, capability and lifecycle contracts. Functional decomposition is an internal ownership decision, not a requirement for independent deployment, additional databases, microservices or untrusted-plugin isolation. Keep each domain operation owned once. HTTP and MCP delegate to the same application service, using existing Action dispatch where applicable. Extract only shared logic needed to make this true; keep transport, authorization, cancellation, error serialization and snapshot fences centralized. Organize MCP tool registration by feature where it improves ownership; preserve existing compatible tool IDs and contracts.

## Action and authorization boundary

Use the existing discovery and invocation interfaces and typed domain contracts. Publish bounded, documented input/output schemas for feature tools; generic dispatch cannot bypass the same exposure policy. A read/compute/propose effect alone is insufficient to authorize provider execution or author-only operations. The target MCP surface must not invoke internal generative LLMs, directly or transitively, including through generic dispatch, named tools or streaming routes. Enforce this in the shared server-side admission/dispatch path rather than only hiding tools. Existing generation features remain frozen legacy behavior until the transition is implemented and verified.

Bind requests to the authenticated actor, authorized project and selected snapshot. Derive actor/provenance server-side. Enforce enabled capabilities, read and proposal scopes, cancellation, bounded results and stale preconditions. Context returned through MCP is subject to explicit authenticated project access and scope; author, character and reader views must not be confused. Do not forward MCP data to a separate model provider.

MCP may read, compute and submit proposals, not authorize or apply canonical changes, publish, reconcile author recovery, or perform direct author persistence mutations. Ordinary authenticated author edits retain their current save protocol. Proposal creation, explicit author approval and transactional application are separate operations; proposal status and receipts are queryable. Do not treat a client-supplied approval flag as author authority.

## Domain surfaces

| Domain | Contract |
| --- | --- |
| Knowledge | Stable PostgreSQL node IDs, lookup, aliases, relationships, proposed creation/edit/merge; explicit identity mapping with Story; no same-name inference |
| Evidence | Revision-bound anchors, quotes, mentions, assertions, reverse lookup and history; distinguish confirmed, candidate, stale and orphaned evidence |
| Story | Existing entities, hierarchy, world state, chronology, thread lifecycle, narrative review and explicit perspectives; reuse current domain calculations |
| Search | Ordinary lexical retrieval via Search; optional Semantic enrichment when enabled; explicit Knowledge UUID references and collision-safe aliases |
| Context | Shared snapshot-bound package of manuscript excerpts, Knowledge, Evidence, world state, perspectives, threads, source revisions and exclusions; independent of Assistant provider |
| Scenario | Compare externally supplied alternatives against a fixed snapshot; save and propose adoption through existing Story operations; no contamination of canon |
| Editing / diagnostics | External agent supplies proposed text, structured facts or findings; Codexia validates against observed revisions and produces reviewable operations |

Knowledge/Evidence is a Core responsibility even when optional modules are absent. Reuse the existing native typed ChangeSet operations, read/write sets, versions, idempotency and transactions. Connect native proposals to author review and status using a single explicit mapping or the existing native authority; never duplicate a proposal's authority, encode native knowledge as a second file-backed truth, or let MCP call author-only persistence writes. Existing Core module proposals retain their established meaning. Cross-domain operations must preserve atomicity or explicitly separate reviewable units; do not pretend different transactions are atomic.

## Context and editing contract

Build upon Story snapshot projection, existing writing context and manifest, and Knowledge/Evidence reads. Context selects by project, snapshot, target, purpose, perspective and bounded budget; include stable IDs, revision, source quote, certainty, exclusions and truncation. Reader views exclude undisclosed facts and character views exclude unacquired knowledge. A historical snapshot must not silently read current knowledge. Use deterministic ranking and bounded retrieval without depending on an internal LLM. Prompt preview may remain a local formatting convenience, not an execution prerequisite.

The external client reads context, generates alternatives outside Codexia, submits typed changes with the source snapshot and revision preconditions, and receives a durable proposal identifier. The author reviews the exact changes in the existing UI, approves explicitly, and the existing PostgreSQL transaction checks read/write sets and applies them. Retrying uses stable identities; stale inputs, conflicting changes and lost responses preserve review/recovery rather than overwriting data.

## Acceptance

- With Assistant absent, disabled or provider none, the primary MCP workflows remain usable; instrument both transports and dispatch to prove no internal generative provider execution, including transitive and generic actions.
- Stdio and Streamable HTTP expose consistent authorized operations; disabled capabilities, cross-project access and author-only operations fail closed.
- Native Knowledge/Evidence proposals preserve IDs, source revisions, links and history; unapproved changes cannot alter canon, approval/application are transactional and stale/replay cases are tested against real PostgreSQL.
- Ordinary lexical search works without Semantic. Ambiguous aliases do not auto-link. Context and Story results are tied to one snapshot and respect perspective.
- Scenario alternatives remain hypothetical until author-approved adoption. External edits are reviewable and revision-checked through the existing authoring UI.
- Preserve Core/Full profiles, existing migration evidence, browser durability, CI inventory, exact-source certification, and release gates. No changes to the operational update/backup architecture are required by this decision.

Non-goals: replacing PostgreSQL, a new approval engine, rewriting existing domain algorithms, general plugin isolation, microservices, provider-backed AI expansion, or production deployment as part of architecture adoption.
