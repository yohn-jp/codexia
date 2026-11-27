import { Annotation, StateEffect } from '@codemirror/state';
import { Decoration, EditorView, keymap, ViewPlugin, type ViewUpdate } from '@codemirror/view';
import { type DocumentEvidenceState, emptyDocumentEvidence, type TextAnchor, type TextChange, trackTextChanges } from '../evidence';
import { editorOffsetReader, sourceEdit, sourceOffsetReader } from '../sourceText';

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
  sourceRef: { current: string },
) {
  const plugin = ViewPlugin.fromClass(
    class {
      decorations = Decoration.none;
      private source = sourceRef.current;
      private editorOffset: ReturnType<typeof editorOffsetReader> | undefined;

      private setSource(text: string) {
        if (this.source === text) return;
        this.source = text;
        this.editorOffset = undefined;
      }

      constructor(private readonly view: EditorView) {
        this.state = evidenceRef.current ?? emptyDocumentEvidence(this.source, revisionRef.current);
        this.decorations = this.toDecorations(this.state, view);
      }

      private state: DocumentEvidenceState;

      update(update: ViewUpdate): void {
        let changed = false;
        for (const transaction of update.transactions) {
          for (const effect of transaction.effects) {
            if (effect.is(setDocumentEvidence)) {
              this.setSource(sourceRef.current);
              this.state = effect.value;
              changed = true;
            }
          }
          if (!transaction.docChanged) continue;
          if (transaction.annotation(externalDocumentSync)) {
            this.setSource(sourceRef.current);
            continue;
          }
          const changes: TextChange[] = [];
          transaction.changes.iterChanges((from, to, _newFrom, _newTo, inserted) => {
            changes.push({ from, to, insert: inserted.toString() });
          });
          const edit = sourceEdit(this.source, transaction.newDoc.toString(), changes);
          this.state = trackTextChanges(this.state, this.source, edit.markdown, edit.changes);
          this.setSource(edit.markdown);
          changed = true;
        }
        this.decorations = this.toDecorations(this.state, update.view);
        if (changed) onChangeRef.current?.(this.state);
      }

      private toDecorations(state: DocumentEvidenceState, view: EditorView) {
        if (!state.positionsTrusted || !state.anchors.length) return Decoration.none;
        this.editorOffset ??= editorOffsetReader(this.source);
        const offset = this.editorOffset;
        const ranges = state.anchors.flatMap(anchor => {
          const from = offset(anchor.from);
          const to = offset(anchor.to);
          if (
            anchor.status === 'orphaned' ||
            anchor.status === 'revision_conflict' ||
            from === null ||
            to === null ||
            to <= from ||
            to > view.state.doc.length
          )
            return [];
          const statusText = anchor.status === 'current' ? '確認済み' : anchor.status === 'proposed' ? '未確定' : '再確認が必要';
          const attributes: Record<string, string> = {
            'data-anchor-id': anchor.id,
            ...(anchor.blockId === null ? {} : { 'data-block-id': anchor.blockId }),
            'data-anchor-status': anchor.status,
            'aria-label': anchor.targets?.length
              ? `${anchor.targets.map(target => target.label).join('、')}への知識参照、${statusText}`
              : anchor.target
                ? `${anchor.target.label}への知識参照、${statusText}`
                : `本文の根拠、${statusText}`,
          };
          if (anchor.target) attributes['data-knowledge-id'] = anchor.target.id;
          if (anchor.status === 'current' && anchor.target?.targetPath && navigateRef.current) {
            attributes.role = 'link';
            attributes['aria-keyshortcuts'] = 'Control+Enter Meta+Enter';
            attributes['data-target-path'] = anchor.target.targetPath;
          }
          return [
            Decoration.mark({
              class: `cm-text-anchor cm-text-anchor-${anchor.status}`,
              attributes,
            }).range(from, to),
          ];
        });
        return Decoration.set(ranges, true);
      }

      get evidence(): DocumentEvidenceState {
        return this.state;
      }
    },
    { decorations: value => value.decorations },
  );

  return [
    plugin,
    keymap.of([
      {
        key: 'Mod-Enter',
        run(view) {
          const pluginInstance = view.plugin(plugin);
          const anchors = pluginInstance?.evidence.anchors ?? [];
          const selection = view.state.selection.main;
          const offset = sourceOffsetReader(sourceRef.current);
          const from = offset(selection.from);
          const to = offset(selection.to);
          const anchor = anchors.find(
            item =>
              item.status === 'current' &&
              item.target?.targetPath &&
              (selection.empty ? item.from <= from && from < item.to : item.from <= from && item.to >= to),
          );
          if (!anchor?.target?.targetPath || !navigateRef.current) return false;
          navigateRef.current(anchor.target.targetPath, anchor.target.id);
          return true;
        },
      },
    ]),
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
  if (target instanceof Element) return target.closest<HTMLElement>('.cm-text-anchor-current');
  if (target instanceof Node) return target.parentElement?.closest<HTMLElement>('.cm-text-anchor-current') ?? null;
  return null;
}
