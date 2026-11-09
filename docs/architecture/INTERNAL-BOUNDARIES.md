# Codexia — Internal Boundaries and Maintainability Contract

> This is a normative architecture contract, not an audit log or implementation-status report. It defines the desired responsibility boundaries regardless of branch, release or verification date. Execution evidence belongs in tests, Issues, PRs and verification records.

## 1. Authority and architectural decision

This contract refines the internal implementation boundaries of [Core](CORE.md), [Full Migration](FULL-MIGRATION.md) and [Modular Workspace](MODULAR-WORKSPACE.md). It does not replace their canonical persistence, recovery, module, authorization or presentation contracts. The independently planned [Public Plugin Platform](PLUGIN-PLATFORM.md) is a separate architectural capability; an internal refactor does not confer untrusted-plugin isolation.

**Decision:** retain one PostgreSQL manuscript authority, one browser recovery authority, one HTTP admission boundary and one shared authoring coordinator. Presentation and module algorithms consume these boundaries without owning competing writers.

### Dependency direction

```text
DesktopShell / MobileShell / Workspace
                 |
Shared PostgreSQL authoring and recovery coordinator
       |                         |
IndexedDB draft journal      typed HTTP client
                                 |
                      authenticated API admission
                                 |
                Persistence / Core module coordinator
                                 |
                    PostgreSQL transactions/revisions
```

## 2. Invariants every refactor preserves

1. **Canonical data:** PostgreSQL holds projects, hierarchy, immutable document revisions, Knowledge, Evidence, Text Anchors and module records. IndexedDB holds recoverable local drafts. Layouts, caches and analysis indexes are not manuscript authorities.
2. **Durability:** input, journaled draft, in-flight write and confirmed database revision are distinct. An optimistic UI transition is not a save receipt.
3. **Concurrency:** mutations require project authorization, exact revision/version preconditions and stable operation identities. Module proposals require authenticated author approval. No automatic prose merge or hidden mutation.
4. **Recoverability:** retries retain operation identity, generation, project/author scope and proposal bindings. Abort, response loss, conflicts, IndexedDB failure and container replacement never silently discard recovery records.
5. **Foreground correctness:** CodeMirror input/IME remains immediately authoritative. Slow network, background refresh, deferred rendering and stale navigation responses cannot replace current input.
6. **Profiles and trust:** Core authoring has no optional model dependency. Built-in modules remain trusted; worker supervision is not a third-party security sandbox.
7. **Verification truth:** checks apply to the submitted source revision. Missing, skipped, stale or blocked validation is not passing evidence. Keep the canonical CI inventory, coverage detection, exact-source certification and gated release requirements.

## 3. One durable save protocol

The authoring coordinator journals the current draft before a server write, binds the save to its observed revision and stable idempotency key, then records the confirmed result before clearing redundant recovery data. Proposal review follows the same principle: preserve the exact payload and approval binding until its durable application receipt is reconciled.

A 409 conflict preserves the current draft for explicit author recovery. A lost response is reconciled against the original operation identity. Navigation generations fence presentation; they cannot undo a database write that already committed. Normal saves and recovery must share these rules rather than maintaining independent state machines.

## 4. Shared authoring coordinator and presentation

`SharedApplication` is the composition root for authoring behavior, not a place to implement a second copy of each service. It owns only the active author/work/editor session, navigation generation, coordination of recovery, network observation and commands exposed to Desktop and Mobile.

- Keep the existing synchronous editor/session reference and bounded deferred React publication: render state is a projection, not a second write authority.
- Extract **presentation-only** sections (library/outline, document/inspector, status/recovery visibility, and available panels) into small components receiving explicit data and callbacks. A component extracted solely for its line count is not an improvement.
- Keep the existing Desktop and Mobile entrypoints and distinct Shell implementations. Sharing behavior must not collapse touch/keyboard and desktop interactions into a viewport-switched component.
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

Core owns consistent module snapshots, domain projections, approved proposal coordination and receipt lookup through the existing Persistence boundary. PostgreSQL transactions own canonical writes. Keep normalization, digest and read-set validation deterministic; do not duplicate authorities or replace durable records with process-local state.

Document and module revisions, project version fences, scope membership guards and approval identity must be checked in the same transaction as application. A pinned historical reader must not silently read current records. Module paths are validated domain identifiers over database records, never filesystem paths for manuscript storage.

## 7. API admission stays centralized

Fastify's shared request handler remains the admission boundary for authentication, Hosted authorization, CSRF/origin checks, quiesce/drain, request cancellation, activity accounting and error serialization. Domain handlers may be isolated **inside** this boundary when a specific behavior change is proven; route-table fragmentation or a second authorization adapter is not part of internal maintainability work.

Hosted authorization dependency outages must remain distinguishable from authentication failures (502/503 versus 401/403), and previously successful JSON responses must continue to be validated at the browser boundary. Neither concern warrants weakening authorization or duplicating validators.

## 8. Verification graph is declarative, not inferred from prose

`scripts/ci-contract.mjs` retains authority for the validation inventory, bounded execution groups, browser/profile coverage and exact-source certification. `scripts/ci-impact.mjs` selects affected PR validations; unknown changes or missing diff inputs select the complete inventory. Main pushes and manual verification always select the complete inventory. Grouped execution preserves individual validation results, and certification checks their source and plan identities as well as successful execution. Each package's own `package.json` defines its test command and necessary self-build; workspace dependency manifests determine dependency preparation.

`scripts/ci-workspace.mjs` must **not** infer per-workspace unit-build requirements by splitting and regex-matching the root `package.json` `test` command. A formatting change to root orchestration must not change per-workspace test prerequisites. Prefer existing package scripts and the declared workspace dependency graph over additional parallel registries or custom task runners.

Preserve mandatory coverage detection, frozen installs, production and test-source typing, scoped safety checks, unit tests, Core/Full build and dependency audit, browser matrices, OCI startup, native Hosted composition and the exact-main-SHA fail-closed certification. Maintain release immutability and explicit `NOT_CHECKED` reporting for unavailable external prerequisites. Do not trade away any accepted gate to make the workflow look simpler.

## 9. Structural acceptance contract

| Boundary | Executable proof required |
| --- | --- |
| Revision protocol | Normal and recovery entrypoints use one effect sequence; injected failures at journal/propose/approve/save/receipt/cleanup preserve recovery, ID and scope; lost response is reconcilable; existing real browser/Core durability tests pass |
| Shared authoring UI | Desktop and Mobile use the same session and authorized commands without shared layout; editor/IME, scene-navigation generations, replay after reload, panel unmount and error/status visibility retain their behavior in real browser cases |
| Built-in registration | Type derives from one canonical value; Runtime and DTO guard accept exactly the known built-ins; all supported profiles, manifests and CI registrations are checked for omissions and extras; Core-only closure stays clean |
| Core pure helpers | Golden operation/proposal digests, serialized records, stale preconditions, replay, conflict, path safety and one-writer semantics match the prior behavior and acceptance fixtures |
| CI workspace preparation | Independent unit-target preparation remains valid if root test orchestration is reordered without semantic change; current CI inventory, all gates, exact-source attestation and release-policy deny cases still pass |

Run focused assertions at each changed boundary before full integrated verification. Report source SHA, commands, test outcomes and conditional skips precisely. A typecheck or a green historical run is not an executed browser, hosted deployment, release or model acceptance.

## 10. Implementation and evolution rules

- Consolidate the save protocol before extracting UI presentation that depends on it. The built-in ID, Core pure helper and CI workspace-preparation changes are otherwise independent and may be implemented in isolated worktrees.
- Assign exactly one owner to each shared contract or touched implementation file. Integrate dependent changes against the actual accepted producer SHA, not sibling uncommitted files. Keep the set of changes bounded; finish each boundary with its focused tests before composing the next.
- Prefer deletion of duplicate code and dependencies to new interfaces. If an extraction adds more concepts than it removes, keep the existing owner and narrow the extraction.
- Issue state, implementation state and verification state are separate. Resolve historical lifecycle Issues by mapping each original criterion to real evidence; an open Issue alone does not mean an absent feature. Do not reopen completed migration work or silently claim previously unexecuted external validation.
- Evolve this document when the *design contract* changes, not by appending audit dates, HEAD snapshots, transient job counts, benchmark tables or implementation diaries. Store those in Issues, PRs and versioned verification evidence.

## 11. Non-goals

Adding an ORM or a second manuscript authority, automatically approving module proposals, unifying Desktop/Mobile visual shells, creating a new routing framework, introducing a state-management platform, implementing the public third-party Plugin SDK/sandbox/marketplace, re-running completed migration phases, changing production resources or publishing OCI images solely because of this refactor.
