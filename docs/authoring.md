# Authoring and recovery

## PostgreSQL projects

Codexia stores projects, hierarchy, manuscript revisions, Knowledge, Evidence and approved changes in PostgreSQL. The authoring API exposes this data through stable project/document identifiers; compatibility paths do not represent a Git checkout.

The writing hierarchy uses the familiar YAML and Markdown shape:

```text
plot/volumes/<volume>/volume.yaml
plot/volumes/<volume>/chapters/<chapter>/chapter.yaml
plot/volumes/<volume>/chapters/<chapter>/scenes/<scene>.yaml
manuscript/<volume>/<chapter>/<scene>.md
```

Scene metadata names its Markdown document with `manuscript: manuscript/.../scene.md`. The UI creates and reorders hierarchy entries through reviewed Core operations. Editing a manuscript preserves frontmatter, unsupported metadata and unrelated records.

## Draft and Saved

| State | Meaning | Recovery boundary |
| --- | --- | --- |
| Draft | Text retained in the browser recovery journal | Same browser, author and origin |
| Saved | The PostgreSQL revision transaction has committed | Recoverable from PostgreSQL project history |

The browser reconciles its journal before presenting an editor as recovered and writable. Changing scenes, switching shells or refreshing must preserve recoverable input. A storage error is shown to the author; it is not reported as saved. Clearing browser storage removes that browser recovery copy. Keep pending work in the same browser and origin until it has been saved.

Project versions and document revision IDs fence writes. When another operation has changed the selected base version, Codexia reports a conflict and keeps the author's text for review. It does not automatically merge manuscript prose or overwrite a newer revision.

## Desktop and mobile

Choose Desktop or Mobile explicitly; the selection is remembered for this origin. The `/desktop/` and `/mobile/` routes select separately built shells sharing the same project, save, review and recovery services. Viewport size does not choose a shell.

The editor supports Japanese manuscript typography, ruby and vertical reading. Finish an IME composition before navigation that would unmount the editor; blocked navigation keeps the active text.

## Workspace layouts

Writing, Research and Review presets assemble independent Editor, Outline, Inspector, History and Review panels. Desktop panel grips and dock targets, plus keyboard-accessible move controls, support splits, tabs, ordering, resizing and visibility.

**Save layout** stores the arrangement for the author and desktop/mobile device class in this browser, separately from draft recovery and PostgreSQL. A malformed layout falls back to a Core preset while preserving the stored value until an explicit replacement save. Missing optional contributions do not prevent other panels from working.

## Search and terminology

The optional Search/Terminology module indexes PostgreSQL document revisions. It supports lexical, exact, prefix and scoped queries. Dictionary changes use reviewable proposals.

Term links are temporary editor and reading decorations; they do not insert links into Markdown. Use Ctrl/Command-click or Ctrl/Command-Enter on an editor term to navigate. Ambiguous aliases remain plain text and can be inspected in the terminology panel.

Search can explicitly request NLP or Semantic capabilities. Ordinary lexical search does not load models. A Core-only build retains editing without the search module.

## Optional analysis

Module settings distinguish absent, disabled, enabled-idle and active modules. A missing package requires a compatible image; an enable toggle does not install executable code. Analysis results carry their source project/document revision. Applying a proposal requires author approval and revision validation.

Assistant provider execution requires configuration and explicit consent for external transmission. Selecting no provider keeps local writing and review available. Host-owned usage and job history is stored separately from project data; preserve the deployment's history volume when replacing a container.
