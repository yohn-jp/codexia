# Headless Tree adoption — Outline integration contract

Status: accepted feature design / implementation to be verified. This document records the agreed scope, not evidence of working integration. The [user screen transitions](USER-SCREEN-FLOW.md) and [system design](../architecture/SYSTEM-DESIGN.md) govern outline navigation, manuscript protection and scope.

## Decision

Use Headless Tree as the sole tree interaction engine for the Desktop React Web Outline. Do not mount React Aria Tree in the same React hierarchy. Native SwiftUI uses a separate outline UI over the same API document hierarchy; see [iOS design](../architecture/IOS-SWIFTUI-ARCHITECTURE.md).

## Authority and ownership

- PostgreSQL `document` remains authoritative: `project_id`, `id`, `parent_id`, `kind`, `order_key`, `head_revision_id`, `version`.
- `document_revision.markdown` remains the authoritative text; headings are derived presentation nodes, never new documents.
- Headless Tree owns client-side expansion, focus, keyboard navigation and drag intent; it does not own persistence or authorization.
- The existing `PersistenceWorkspace` transition protection, journal reconciliation and API calls remain the sole mutation path. Preserve CodeMirror instance, caret, IME composition, undo and pending drafts.
- Do not replace Workspace layouts, panel identifiers, saved layout keys, or the editor.

## Implementation slices

1. Introduce a pure `Document -> TreeItem` adapter keyed by stable document IDs; preserve same-title siblings, project scope, explicit sibling ordering and incomplete hierarchy diagnostics.
2. Integrate Headless Tree's tree instance and feature configuration into the existing Outline panel. Preserve existing keyboard selection and accessible move controls; add inline rename/search only where consistent with current API contracts.
3. Adapt move/reorder intent into existing Core/API mutation contracts. The current `editStructure` targets the active document: introduce an explicit target-document command, guarded by version checks, before enabling arbitrary-node DnD. Never treat optimistic UI as committed persistence.
4. Add derived Markdown heading items under each document only after B-type document hierarchy passes acceptance. Heading activation scrolls within the selected document; it must not invoke document mutation.
5. Verify Desktop keyboard/pointer and screen-reader behavior. SwiftUI outline touch/VoiceOver/keyboard is independently verified on real iOS devices; Mobile React WebView tests are not a release gate.

## Acceptance

- Create, rename, select, expand, collapse, move and reorder document nodes; project and parent boundaries remain enforced.
- Reject cycles, invalid parents, stale versions and unsupported reorder operations without corrupting the UI or PostgreSQL.
- Uncommitted drafts and IME composition survive switching nodes and failed mutations; successful operations re-fetch authoritative structure.
- Keyboard-only and touch-only navigation work; dragging is supplemental and accessible alternatives remain.
- No regressions in Core-only mode, existing Workspace presets, saved layout, CodeMirror, revisions or recovery journal.
- Add focused tests for adapter, mutation failures, accessibility and real browser touch behavior. Run and report actual CI results before requesting merge.

## Non-goals

No new hierarchy table, no second React tree engine, no automatic Markdown section rearrangement or editor/persistence replacement. This Desktop Web workstream does not implement SwiftUI.
