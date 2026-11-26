# Codexia — Internal Boundaries and Maintainability Contract

> This is a normative architecture contract, not an audit log or implementation-status report. It defines the desired responsibility boundaries regardless of branch, release or verification date. Execution evidence belongs in tests, Issues, PRs and verification records.

System-level ownership and authority are defined by [System design](SYSTEM-DESIGN.md) and [Documentation authority](DOCUMENTATION-AUTHORITY.md); implementation is checked against those contracts, not treated as their source. First-party path and filename conventions are governed by [Source layout and naming](SOURCE-LAYOUT-CONVENTIONS.md); the separate [migration Issue #690](https://github.com/yohn-jp/codexia/issues/690) changes paths only, not these module/application responsibility boundaries.

## 1. Authority and architectural decision

This contract refines the internal implementation boundaries of [Core](CORE.md), [Codexia reboot](CODEXIA-REBOOT-RFC.md) and [Modular Workspace](MODULAR-WORKSPACE.md). It does not replace their canonical persistence, recovery, module, authorization or presentation contracts. The independently planned [Public Plugin Platform](PLUGIN-PLATFORM.md) is a separate architectural capability; an internal refactor does not confer untrusted-plugin isolation.

**Decision:** retain one PostgreSQL manuscript authority and one HTTP admission boundary. Desktop React Web owns its browser recovery and Web authoring coordinator; SwiftUI iOS owns its protected native draft journal and Swift coordinator. They implement the same API/Revision/receipt invariants **without sharing React state or creating a second server writer**. See [native design](IOS-SWIFTUI-ARCHITECTURE.md).

### Dependency direction

```text
DesktopShell / Workspace                 SwiftUI / UIKit TextKit editor
            |                                        |
Web authoring coordinator                     Swift authoring coordinator
       |             |                           |             |
IndexedDB journal  Web typed client       Native draft journal  Swift typed client
       |             |                           |             |
       +-------------+---------------------------+-------------+
                                 |
                      authenticated API admission
                                 |
                Persistence / Core module coordinator
                                 |
                    PostgreSQL transactions/revisions
```

## 2. Invariants every refactor preserves

1. **Canonical data:** PostgreSQL holds projects, hierarchy, immutable document revisions, Knowledge, Evidence, Text Anchors and module records. Desktop IndexedDB and iOS protected native files hold recoverable drafts, not authoritative manuscripts. Layouts, caches and analysis indexes are not manuscript authorities.
2. **Durability:** input, journaled draft, in-flight write and confirmed database revision are distinct. An optimistic UI transition is not a save receipt.
3. **Concurrency:** mutations require project authorization, exact revision/version preconditions and stable operation identities. Module proposals require authenticated author approval. No automatic prose merge or hidden mutation.
4. **Recoverability:** retries retain operation identity, generation, project/author scope and proposal bindings. Abort, response loss, conflicts, IndexedDB failure and container replacement never silently discard recovery records.
5. **Foreground correctness:** Desktop CodeMirror and native iOS TextKit buffers remain immediately authoritative for locally pending edits. Slow network, background refresh, deferred rendering and stale navigation responses cannot replace current input.
6. **Profiles and trust:** Core authoring has no optional model dependency. Built-in modules remain trusted; worker supervision is not a third-party security sandbox.
7. **Verification truth:** checks apply to the submitted source revision. Missing, skipped, stale or blocked validation is not passing evidence. Keep the canonical CI inventory, coverage detection, exact-source certification and gated release requirements.

## 3. One durable save protocol

The authoring coordinator journals the current draft before a server write, binds the save to its observed revision and stable idempotency key, then records the confirmed result before clearing redundant recovery data. Proposal review follows the same principle: preserve the exact payload and approval binding until its durable application receipt is reconciled.

A 409 conflict preserves the current draft for explicit author recovery. A lost response is reconciled against the original operation identity. Navigation generations fence presentation; they cannot undo a database write that already committed. Normal saves and recovery must share these rules rather than maintaining independent state machines.

## 4. Shared authoring coordinator and presentation

`SharedApplication` is the Desktop Web React composition root, not a shared runtime for SwiftUI. The independent Swift native authoring coordinator implements the same API save/receipt/recovery contract without importing React state.

- Keep the existing synchronous editor/session reference and bounded deferred React publication: render state is a projection, not a second write authority.
- Extract **presentation-only** sections (library/outline, document/inspector, status/recovery visibility, and available panels) into small components receiving explicit data and callbacks. A component extracted solely for its line count is not an improvement.
- Desktop React Web is the supported authoring client during the iOS freeze. The [Desktop-only interim decision](IOS-SWIFTUI-ARCHITECTURE.md#7-implementation-slices-and-acceptance-gates) retired Mobile Web independently of native acceptance. Keep Desktop accessibility when resizing the browser. SwiftUI owns its own UI components.
- Keep journal reconciliation and navigation guards owned once. If a self-contained application hook is extracted, it must not duplicate the session, timers, abort signals, author scope or polling across hooks.
- Workspace layout and module panels consume permission-checked host contributions; they do not own manuscript durability, write receipts, database transactions or revision authority.

Minimal design target: the authoring coordinator chooses *what* state and commands are available; presentational components decide *how* to render them; the save protocol decides *how one save attempt proceeds*. Do not add Redux, an event bus, a DI container or new observable state infrastructure.

## 5. Built-in module identity and extensibility

Define a single `BUILTIN_MODULE_IDS` readonly tuple in `@codexia/contracts` and derive the internal `ModuleId` union from its values. The existing IDs and contract wire values remain compatible.

- Module Runtime's membership validation and browser HTTP DTO guards consume this value rather than independently maintaining a list of recognized built-in IDs.
- Build profiles, manifests, registered workspaces and CI inventories may retain their own *responsibilities*; where they enumerate the installed built-ins, executable conformance checks must reject missing or extra IDs. Do not rely on `satisfies readonly ModuleId[]` alone as proof that every ID is registered.
- Importing the identifier metadata must not load module implementations, native models or workers into the Core-only dependency closure. Runtime activation stays lazy and capability-scoped.
- This internal, closed built-in vocabulary is not the public Plugin ID namespace. Public manifest/ABI negotiation and untrusted execution isolation remain governed by `PLUGIN-PLATFORM.md` and require separate acceptance.

## 6. Core computation and persistence effects

Core owns consistent module snapshots, domain projections, approved proposal coordination and receipt lookup through the existing Persistence boundary. [Backend read model](BACKEND-READ-MODEL.md) owns the detailed read and scalability contract. PostgreSQL transactions own canonical writes. Keep normalization, digest and read-set validation deterministic; do not duplicate authorities or replace durable records with process-local state.

Document and module revisions, project version fences, scope membership guards and approval identity must be checked in the same transaction as application. A pinned historical reader must not silently read current records. Module paths are validated domain identifiers over database records, never filesystem paths for manuscript storage.

## 7. API admission stays centralized

Fastify's shared request handler remains the admission boundary for Better Auth authentication, author and MCP project authorization, CSRF/origin checks, lifecycle draining, request cancellation, activity accounting and error serialization. Domain handlers may be isolated **inside** this boundary when a specific behavior change is proven; route-table fragmentation or a second authorization adapter is not part of internal maintainability work.

OAuth verification and introspection outages fail closed. The browser continues to validate successful JSON responses at its API boundary.

## 8. Verification authority

[CI/CD architecture](../verification/CI-CD.md) owns execution, evidence and release gates; [Test architecture](../verification/TEST-ARCHITECTURE-OPTIMIZATION.md) owns proof placement. The executable inventory remains in `scripts/ci/impact/contract.mjs`. Keep workspace prerequisites declared in package scripts and dependencies; no duplicate task authority.

## 9. Structural acceptance contract

| Boundary | Executable proof required |
| --- | --- |
| Revision protocol | Normal and recovery entrypoints use one effect sequence; injected failures at journal/propose/approve/save/receipt/cleanup preserve recovery, ID and scope; lost response is reconcilable; existing real browser/Core durability tests pass |
| Client authoring split | Desktop Web and native iOS separately prove editing, journal, scope, API receipt and conflict recovery. Desktop browser E2E and iOS physical-device tests are distinct; Mobile React viewport E2E is not a target |
| Built-in registration | Type derives from one canonical value; Runtime and DTO guard accept exactly the known built-ins; all supported profiles, manifests and CI registrations are checked for omissions and extras; Core-only closure stays clean |
| Core pure helpers | Golden operation/proposal digests, serialized records, stale preconditions, replay, conflict, path safety and one-writer semantics match the prior behavior and acceptance fixtures |
| CI workspace preparation | Independent unit-target preparation remains valid if root test orchestration is reordered without semantic change; current CI inventory, all gates, exact-source attestation and release-policy deny cases still pass |

Run focused assertions at each changed boundary before full integrated verification. Report source SHA, commands, test outcomes and conditional skips precisely. Browser, deployment, release and model acceptance require their own executed checks.

## 10. Implementation and evolution rules

- Consolidate the save protocol before extracting UI presentation that depends on it. The built-in ID, Core pure helper and CI workspace-preparation changes are otherwise independent and may be implemented in isolated worktrees.
- Assign exactly one owner to each shared contract or touched implementation file. Integrate dependent changes against the actual accepted producer SHA, not sibling uncommitted files. Keep the set of changes bounded; finish each boundary with its focused tests before composing the next.
- Prefer deletion of duplicate code and dependencies to new interfaces. If an extraction adds more concepts than it removes, keep the existing owner and narrow the extraction.
- Issue state, implementation state and verification state are separate. Resolve historical lifecycle Issues by mapping each original criterion to real evidence; an open Issue alone does not mean an absent feature. Do not reopen completed migration work or silently claim previously unexecuted external validation.
- Evolve this document when the *design contract* changes, not by appending audit dates, HEAD snapshots, transient job counts, benchmark tables or implementation diaries. Store those in Issues, PRs and versioned verification evidence.

## 11. Non-goals

Adding an ORM or a second manuscript authority, automatically approving module proposals, forcing shared React/SwiftUI UI components, creating a new routing framework, introducing a state-management platform, implementing the public third-party Plugin SDK/sandbox/marketplace, re-running completed migration phases, changing production resources or publishing OCI images solely because of this refactor.
