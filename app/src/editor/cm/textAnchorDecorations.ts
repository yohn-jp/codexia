import { Annotation, StateEffect } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, keymap, type ViewUpdate } from "@codemirror/view";
import { emptyDocumentEvidence, trackTextChanges, type DocumentEvidenceState, type TextAnchor, type TextChange } from "../evidence";

export const setDocumentEvidence = StateEffect.define<DocumentEvidenceState>();
export const externalDocumentSync = Annotation.define<boolean>();

type EvidenceRef = { current: DocumentEvidenceState | null };
type RevisionRef = { current: string };
type StateCallbackRef = { current: ((state: DocumentEvidenceState) => void) | undefined };
type Navigate = (targetPath: string, knowledgeId: string) => void;
type NavigateRef = { current: Navigate | undefined };

/** Renders revision-pinned Text Anchors and follows the local CodeMirror ChangeSet in UTF-16 offsets. */
export function textAnchorDecorationsExtension(
  evidenceRef: EvidenceRef,
  revisionRef: RevisionRef,
  onChangeRef: StateCallbackRef,
  navigateRef: NavigateRef,
) {
  const plugin = ViewPlugin.fromClass(class {
    decorations = Decoration.none;

    constructor(private readonly view: EditorView) {
      this.state = evidenceRef.current ?? emptyDocumentEvidence(view.state.doc.toString(), revisionRef.current);
      this.decorations = this.toDecorations(this.state, view);
    }

    private state: DocumentEvidenceState;

    update(update: ViewUpdate): void {
      let changed = false;
      for (const transaction of update.transactions) {
        for (const effect of transaction.effects) {
          if (effect.is(setDocumentEvidence)) {
            this.state = effect.value;
            changed = true;
          }
        }
        if (!transaction.docChanged || transaction.annotation(externalDocumentSync)) continue;
        const changes: TextChange[] = [];
        transaction.changes.iterChanges((from, to, _newFrom, _newTo, inserted) => {
          changes.push({ from, to, insert: inserted.toString() });
        });
        this.state = trackTextChanges(this.state, transaction.startState.doc.toString(), transaction.newDoc.toString(), changes);
        changed = true;
      }
      this.decorations = this.toDecorations(this.state, update.view);
      if (changed) onChangeRef.current?.(this.state);
    }

    private toDecorations(state: DocumentEvidenceState, view: EditorView) {
      if (!state.positionsTrusted) return Decoration.none;
      const ranges = state.anchors.flatMap((anchor) => {
        if (anchor.status === "orphaned" || anchor.status === "revision_conflict"
          || anchor.from < 0 || anchor.to <= anchor.from || anchor.to > view.state.doc.length) return [];
        const statusText = anchor.status === "current" ? "確認済み" : "再確認が必要";
        const attributes: Record<string, string> = {
          "data-anchor-id": anchor.id,
          "data-block-id": anchor.blockId,
          "data-knowledge-id": anchor.target.id,
          "data-anchor-status": anchor.status,
          "aria-label": `${anchor.target.label}への知識参照、${statusText}`,
        };
        if (anchor.status === "current" && anchor.target.targetPath && navigateRef.current) {
          attributes.role = "link";
          attributes["aria-keyshortcuts"] = "Control+Enter Meta+Enter";
          attributes["data-target-path"] = anchor.target.targetPath;
        }
        return [Decoration.mark({
          class: `cm-text-anchor cm-text-anchor-${anchor.status}`,
          attributes,
        }).range(anchor.from, anchor.to)];
      });
      return Decoration.set(ranges, true);
    }

    get evidence(): DocumentEvidenceState {
      return this.state;
    }
  }, { decorations: (value) => value.decorations });

  return [
    plugin,
    keymap.of([{
      key: "Mod-Enter",
      run(view) {
        const pluginInstance = view.plugin(plugin);
        const anchors = pluginInstance?.evidence.anchors ?? [];
        const selection = view.state.selection.main;
        const anchor = anchors.find((item) => item.status === "current" && item.target.targetPath
          && (selection.empty
            ? item.from <= selection.head && selection.head < item.to
            : item.from <= selection.from && item.to >= selection.to));
        if (!anchor?.target.targetPath || !navigateRef.current) return false;
        navigateRef.current(anchor.target.targetPath, anchor.target.id);
        return true;
      },
    }]),
    EditorView.domEventHandlers({
      mousedown(event) {
        if (event.button !== 0 || (!event.ctrlKey && !event.metaKey)) return false;
        const mark = anchorMarkFromTarget(event.target);
        const id = mark?.dataset.knowledgeId;
        const targetPath = mark?.dataset.targetPath;
        if (!id || !targetPath || !navigateRef.current) return false;
        event.preventDefault();
        navigateRef.current(targetPath, id);
        return true;
      },
    }),
  ];
}

function anchorMarkFromTarget(target: EventTarget | null): HTMLElement | null {
  if (target instanceof Element) return target.closest<HTMLElement>(".cm-text-anchor-current");
  if (target instanceof Node) return target.parentElement?.closest<HTMLElement>(".cm-text-anchor-current") ?? null;
  return null;
}
