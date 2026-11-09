# Modular workspace architecture

## 1. Product decision

The interface is assembled from movable, replaceable components over PostgreSQL projects, documents, revisions, Knowledge and Evidence. Desktop and Mobile retain separate shells and share authoring and recovery. Search, terminology, NLP and Semantic remain optional modules on top of Core.

The three product goals are:

1. **Perceived immediacy.** Local reads, editor input and navigation take precedence over auxiliary or remote work. Only state required to perform the current action is on its critical path; everything else runs independently, lazily or in parallel where dependencies allow.
2. **Composable workspace.** Editor, outline, search, terminology, inspector, history and module panels are independently positionable. Presets are starting configurations, not locked UI modes; the user may customize them completely.
3. **Optional discoverability.** Full-text search, term resolution and non-destructive automatic links are standard *plugin capabilities*, not prerequisites for Core authoring. Advanced NLP/Semantic features retain separate, optional ownership.

These goals must not weaken manuscript durability, revision preconditions, authentication, project isolation, accessibility, or the minimal Core profile.

## 2. Composition boundaries

The host composes panels and optional capabilities around Core snapshot and mutation contracts.

```text
Browser Workspace
  ├─ Layout Controller (presets, arbitrary dock/split/resize, persistence)
  ├─ Core panels: Editor / Outline / History / Review
  └─ Optional contribution instances: Search / Terms / NLP / Semantic / ...
        │ permitted actions + read-only contexts
        ▼
Composition Host (existing ModuleRuntime + BrowserModule host)
        │
        ├─ Optional Search & Terminology capabilities
        ├─ Existing NLP / Semantic / Story / other modules
        └─ Shared Core document-source capability
                  │
                  ▼
Core: PostgreSQL Snapshot / Document Read / Approved Change Coordinator
                  |
             Persistence transactions
                  |
              PostgreSQL
```

**Dependency direction:** Core never imports an optional module or its index; modules use Core-owned snapshot/document contracts. Workspace owns arrangement and panel lifetimes, not project mutation. Modules never become independent manuscript writers.

## 3. Foreground vs background execution

### 3.1 Foreground contract

The foreground consists of: user input, current scene (including the best recoverable draft), current navigation context, visible panel chrome and only the data required by the active action. Rendering the current document cannot require optional external service availability, a Semantic/NLP model, a complete search index, an invisible panel, or a successful optional module load.

A panel requesting data must bind to the project identity, author scope (if authorized) and selected `SnapshotId`. A response for a superseded navigation generation or mismatched snapshot must never overwrite the current document.

### 3.2 Independent work

Project revision observation, proposal-status refresh, optional module discovery, search indexing, terminology rebuild and non-visible panel activation are independently scheduled. When safe, parallelize unrelated tasks instead of serializing them behind initial navigation. Lazy-load browser entrypoints only when a registered and enabled contribution is actually needed; heavy analysis and models remain optional.

**Correctness boundary:** Browser recovery of pending drafts/save receipts is not merely decorative auxiliary work. The current scene may be displayed promptly, but until its authoritative local recovery state has been reconciled, it must not be represented as a fully recovered, writable canonical editor. Journal recovery, conflict gates and generation checks take precedence over cosmetic immediacy. Failure preserves the recovery record and surfaces a truthful state; it must not silently discard or overwrite typing.

### 3.3 Revision observation

Project version and document revision changes invalidate dependent read models. Unchanged observations do not require rebuilding the tree or analysis indexes. A changed revision must pass recovery and conflict guards before updating visible authoring state. Database failure exposes an unavailable state and preserves local drafts; it never selects another persistence backend.

### 3.4 Read model and cache

Core owns consistent snapshot readers keyed by PostgreSQL project identity and version. Derived indexes support enumeration, bulk reads and changed-path calculation using document/artifact revisions. Mutable drafts remain separate. Optional index failure cannot prevent Core writing.

## 4. Workspace composition

### 4.1 Vocabulary and ownership

- **Panel definition:** A stable contribution ID, provider module, title, capabilities and supported contexts. It specifies *what* can be mounted, not *where*.
- **Panel instance:** A placement of a definition in a layout, with an instance ID and only permitted view-local settings. One definition may support more than one instance if the implementation declares that safe.
- **Workspace layout:** A tree of split, stack/tab and leaf nodes with panel-instance references and sizes. The layout controller manages drag/drop, docking, resize, tabs, hide/show and focus.
- **Preset:** A versioned initial layout plus a declared fallback for unavailable optional panels. Applying a preset creates an editable user layout.
- **Workspace state:** User/device UI preference; never manuscript YAML/Markdown, database revisions by default.

Core authoring panels (including Editor) remain available without modules. Optional modules may contribute full panels, editor adornments or contextual actions. These are distinct contribution kinds; do not force an inline text decoration into a dockable panel. One module may contribute several items, and multiple modules may contribute to one editor surface.

### 4.2 Composition constraints

The workspace host owns component mounting and lifetime. The module owns its rendered content, but cannot set global layout or bypass host actions. Modules receive only permitted, snapshot-scoped context; they cannot read another project or invoke mutation APIs without the existing proposal/approval flow.

Minimum layout semantics:

- Arbitrary user reordering and placement across allowed containers; horizontal/vertical splits, tab groups, resizing and hiding.
- Presets for **Writing**, **Research** and **Review** as initial compositions (exact default panel selections are UX configuration, not Core semantics).
- Save and restore a custom workspace, distinguish desktop/mobile arrangements, and persist schema version.
- Unknown/disabled/uninstalled contributions are omitted from rendering with a recoverable placeholder or reversible layout fallback; other panels remain usable.
- Mobile offers accessible alternative panel navigation without assuming desktop drag gestures; keyboard controls and focus restoration remain supported.
- Loading/closing/switching panels cancels pending requests, disposes module mounts and releases optional resources; unsaved manuscript drafts are not discarded.

The layout schema must be validated before use, including depth, size, IDs, duplicate panel instances and permission to mount each contribution. Malformed persisted state falls back to an accessible Core preset without deleting the prior state until the user explicitly saves a replacement.

### 4.3 Persistence and synchronization

Workspace layout is scoped to user/author identity and device class. It is separate from canonical manuscript data. The host persists layouts in browser storage; layouts are not synchronized through work repositories.

The layout stores declarative IDs/settings, never executable component source, secrets, arbitrary paths or full manuscript contents. Persist preferences independently from IndexedDB draft/save recovery, with different storage keys and failure handling.

## 5. Search and terminology as optional capabilities

### 5.1 Ownership

- **Core document source:** Snapshot-scoped enumeration, reads and incremental changed-document descriptions. It supplies no semantic ranking and does not depend on search/NLP packages.
- **Standard lexical-search module:** An optional, lightweight local index; full-text, exact term/alias and prefix lookups, scope filters, ranking of lexical hits and bounded result navigation. No model dependency.
- **Terminology capability:** A canonical term registry/aliases/target references and a resolver returning document spans for visible text. It shares the optional Search module and its index.
- **Existing NLP/Semantic modules:** Optional tokenization, extraction, embeddings and semantic ranking. They may enhance or contribute separate search modes through declared capabilities; no implicit model loading for lexical search.

Core snapshot search, indexed lexical search and Semantic search have distinct owners and consumers. Changes must preserve their observable contracts and avoid redundant indexes.

### 5.2 Index lifecycle

An indexed revision is identified by PostgreSQL project snapshot and the indexed document-set definition. Start from Core's canonical document list; apply deltas for changed paths when available. A project revision change, document save, document creation/removal, terminology dictionary update or relevant module settings change invalidates only the affected index entries. An index ready for an older revision must not be projected as current.

Build/warm indexes after the foreground scene is ready, in bounded, cancellable work; visible searches may request priority. Plugin installation/enablement controls code loading and any background work. Disabled search leaves Core editor, navigation, history, save and restore operational.

Index bytes are derived data in bounded plugin-owned cache, not canonical project data, not the browser recovery journal and not authoritative data. Corruption is discarded and rebuilt without affecting the manuscript.

### 5.3 Automatic links

Resolve known canonical terms and aliases against visible text, producing transient ranges of `(document revision, start, end, target term ID)`. Do **not** mutate Markdown source to insert automatic links. Resolve collisions/overlaps deterministically and provide a way to dismiss or inspect an ambiguous match rather than guessing a target.

An editor decoration must not break caret position, IME composition, selection, ruby typography or input latency. Recompute on bounded visible ranges or idle tasks and invalidate on document revision changes. The link target is project-scoped and must be validated on navigation; missing targets degrade to plain text.

The user can navigate links from writing/reading views, search results and terminology panels; no separate untrusted HTML rendering or model output is allowed to introduce executable links.

## 6. Contribution registration and lifecycle

`ModuleManifest`, `UiContribution`, `BrowserModuleDefinition` and `ModuleRuntime` supply the shared contribution boundary. Contribution metadata declares a version, kind, supported workspace/editor/reading contexts and multiple-instance policy. A placement slot supplies host defaults; workspace panel identity and layout determine user-owned placement.

The runtime is the activation and capability authority. An unavailable or disabled module contributes neither active workers nor invisible heavy browser code. Profiles control artifact closure; Core does not transitively depend on optional search, NLP, Semantic or model assets. Background indexing and jobs require explicit declared activation; hiding a panel does not authorize work.

This contract covers trusted modules installed at build time. It does not grant arbitrary third-party execution or runtime package installation.

## 7. State and failure invariants

1. PostgreSQL remains the durable project authority; local Draft, in-flight save and confirmed Revision remain distinct states.
2. Current author edits and recovery state are never replaced by a stale asynchronous read, module result or layout switch.
3. A module's failure cannot prevent minimal Core authoring or delete user work.
4. Optional analysis never mutates manuscripts directly. Changes require Core proposal, authenticated approval and PostgreSQL application.
5. Snapshot-indexed output may be shown as current only for the exact bound revision; stale results are labeled or discarded.
6. Module and panel identity, enabled profile, authorization and project scopes are checked by the host before mounting/invocation.
7. Layout changes and derived indexes are not persisted as manuscript revisions.
8. Unavailable PostgreSQL preserves recoverable local drafts and blocks server saves; it never activates another manuscript store.

## 8. Explicit non-goals

- Adding another manuscript authority or compatibility fallback.
- Replacing existing NLP/Semantic modules or duplicating their indexes without a demonstrated gap.
- Introducing an entire external plugin SDK, arbitrary third-party code sandbox, a second database authority or module orchestration service.
- Coupling layout choices to repository data or requiring all optional modules for the Core profile.

## 9. Architectural decision summary

**Decision:** PostgreSQL Core with a minimal, responsive foreground read model; a host-owned composable Workspace with presets and complete customization; search/terminology and advanced intelligence as optional, capability-based modules.

**Why:** One immutable document authority and one module runtime provide consistent revision identity, minimal startup dependency closure and freely assembled UX without duplicating persistence ownership or forcing heavy features onto ordinary editing.
