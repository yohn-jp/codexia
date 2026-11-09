import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { Compartment, EditorState, Transaction } from "@codemirror/state";
import {
  drawSelection,
  EditorView,
  highlightActiveLine,
  keymap,
  placeholder as cmPlaceholder,
} from "@codemirror/view";
import { forwardRef, useEffect, useImperativeHandle, useRef, type CSSProperties } from "react";
import { bracketPairsExtension } from "./cm/bracketPairs";
import { editorCompositionExtension, isViewComposing } from "./cm/compositionGuard";
import { ellipsisNormalizeExtension } from "./cm/ellipsisNormalize";
import { refreshTermAdornments, termAdornmentsExtension } from "./cm/termAdornments";
import { externalDocumentSync, setDocumentEvidence, textAnchorDecorationsExtension } from "./cm/textAnchorDecorations";
import { emptyDocumentEvidence, markEvidenceNeedsReview, type DocumentEvidenceState, type TextChange } from "./evidence";
import { planWritingSymbol, type WritingSymbolId } from "./writingSymbols";
import { type ResolveEditorTerms } from "./terms";
import { createUiSentencePositionIndexCache, type UiSentencePositionIndexCache } from "../resume/continueCandidates";
import "./terminology.css";

export interface ManuscriptInputHandle {
  focus(): void;
  flushComposition(): Promise<string>;
  readForNavigation(): string;
  insert(symbol: WritingSymbolId): void;
  restorePosition(position: { cursorSentenceIndex: number | null; scrollTop: number }): void;
  getScrollTop(): number;
  getSelection(): { from: number; to: number; text: string } | null;
}

export interface ManuscriptInputProps {
  value: string;
  externalTextRevision: number;
  readOnly?: boolean;
  onChange: (value: string, changes: TextChange[]) => void;
  onSelectionLengthChange?: (length: number) => void;
  onSelectionChange?: (selection: { from: number; to: number; text: string } | null) => void;
  onCursorPositionChange?: (cursorSentenceIndex: number | null, scrollTop: number) => void;
  placeholder?: string;
  labelledBy: string;
  style?: CSSProperties;
  resolveTerms?: ResolveEditorTerms;
  onTermNavigate?: (targetPath: string, termId: string) => void;
  termResolutionKey?: string;
  documentRevision?: string;
  evidenceState?: DocumentEvidenceState | null;
  evidenceLoadKey?: number;
  evidenceSourceText?: string;
  onEvidenceChange?: (state: DocumentEvidenceState) => void;
}

/** CodeMirror adapter retaining IME-safe editing, source bracket/ellipsis rules and history keymaps. */
export const ManuscriptInput = forwardRef<ManuscriptInputHandle, ManuscriptInputProps>(function ManuscriptInput({
  value,
  externalTextRevision,
  readOnly = false,
  onChange,
  onSelectionLengthChange,
  onSelectionChange,
  onCursorPositionChange,
  placeholder,
  labelledBy,
  style,
  resolveTerms,
  onTermNavigate,
  termResolutionKey,
  documentRevision = "",
  evidenceState = null,
  evidenceLoadKey = 0,
  evidenceSourceText = value,
  onEvidenceChange,
}, ref) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const sentencePositionIndexRef = useRef<UiSentencePositionIndexCache<EditorState["doc"]> | null>(null);
  const editabilityCompartment = useRef(new Compartment()).current;
  const externalSyncRef = useRef(false);
  const suppressPositionRef = useRef(false);
  const resolverRef = useRef<ResolveEditorTerms | undefined>(resolveTerms);
  const navigatorRef = useRef<((targetPath: string, termId: string) => void) | undefined>(onTermNavigate);
  const evidenceRef = useRef<DocumentEvidenceState | null>(evidenceState);
  const documentRevisionRef = useRef(documentRevision);
  const evidenceCallbackRef = useRef(onEvidenceChange);
  const lastEvidenceLoadKeyRef = useRef(evidenceLoadKey);
  resolverRef.current = resolveTerms;
  navigatorRef.current = onTermNavigate;
  evidenceRef.current = evidenceState;
  documentRevisionRef.current = documentRevision;
  evidenceCallbackRef.current = onEvidenceChange;
  const latestRef = useRef({ onChange, onSelectionLengthChange, onSelectionChange, onCursorPositionChange });
  latestRef.current = { onChange, onSelectionLengthChange, onSelectionChange, onCursorPositionChange };

  function sentencePositionIndex(doc: EditorState["doc"], text?: string) {
    const cache = sentencePositionIndexRef.current ??= createUiSentencePositionIndexCache<EditorState["doc"]>();
    return cache.get(doc, text);
  }

  function reportPosition(view: EditorView): void {
    if (suppressPositionRef.current) return;
    const selection = view.state.selection.main;
    latestRef.current.onCursorPositionChange?.(
      sentencePositionIndex(view.state.doc).indexAtOffset(selection.head),
      Math.max(0, view.scrollDOM.scrollTop),
    );
  }

  useImperativeHandle(ref, () => ({
    focus() {
      viewRef.current?.focus();
    },
    readForNavigation() {
      const view = viewRef.current;
      if (view && isViewComposing(view)) throw new Error("日本語入力の変換が完了していません。変換を確定してから画面を切り替えてください。");
      return view?.state.doc.toString() ?? "";
    },
    async flushComposition() {
      const view = viewRef.current;
      if (!view) return "";
      if (isViewComposing(view)) {
        view.contentDOM.blur();
        await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
        await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
        if (isViewComposing(view)) {
          throw new Error("日本語入力の変換が完了していません。変換を確定してから画面を切り替えてください。");
        }
      }
      return view.state.doc.toString();
    },
    insert(symbol) {
      const view = viewRef.current;
      if (!view) return;
      const selection = view.state.selection.main;
      const plan = planWritingSymbol(view.state.doc.toString(), selection.from, selection.to, symbol);
      view.dispatch({
        changes: { from: plan.from, to: plan.to, insert: plan.insert },
        selection: { anchor: plan.cursor },
        userEvent: "input.type",
      });
      view.focus();
    },
    restorePosition(position) {
      const view = viewRef.current;
      if (!view) return;
      const offset = sentencePositionIndex(view.state.doc).offsetAtIndex(position.cursorSentenceIndex);
      suppressPositionRef.current = true;
      if (offset !== null) {
        view.dispatch({
          selection: { anchor: Math.max(0, Math.min(offset, view.state.doc.length)) },
          annotations: Transaction.addToHistory.of(false),
        });
      }
      view.scrollDOM.scrollTop = Math.max(0, position.scrollTop);
      requestAnimationFrame(() => { suppressPositionRef.current = false; });
    },
    getScrollTop() {
      return Math.max(0, viewRef.current?.scrollDOM.scrollTop ?? 0);
    },
    getSelection() {
      const view = viewRef.current;
      if (!view) return null;
      const selection = view.state.selection.main;
      if (selection.empty) return null;
      return { from: selection.from, to: selection.to, text: view.state.sliceDoc(selection.from, selection.to) };
    },
  }), []);

  useEffect(() => {
    const parent = containerRef.current;
    if (!parent) return;
    const state = EditorState.create({
      doc: value,
      extensions: [
        history(),
        editabilityCompartment.of(editabilityExtensions(readOnly)),
        drawSelection(),
        highlightActiveLine(),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        bracketPairsExtension(),
        ellipsisNormalizeExtension(),
        editorCompositionExtension(),
        termAdornmentsExtension(resolverRef, navigatorRef),
        textAnchorDecorationsExtension(evidenceRef, documentRevisionRef, evidenceCallbackRef, navigatorRef),
        styleNonceExtension(),
        EditorView.lineWrapping,
        EditorView.contentAttributes.of({
          id: "manuscript",
          "aria-labelledby": labelledBy,
          "aria-multiline": "true",
          role: "textbox",
          spellcheck: "false",
          autocapitalize: "off",
          enterkeyhint: "enter",
        }),
        EditorView.updateListener.of((update) => {
          const changedText = update.docChanged ? update.state.doc.toString() : null;
          const textChanges: TextChange[] = [];
          if (update.docChanged) update.changes.iterChanges((from, to, _newFrom, _newTo, inserted) => {
            textChanges.push({ from, to, insert: inserted.toString() });
          });
          const changedDocumentIndex = update.docChanged
            ? sentencePositionIndex(update.state.doc, changedText ?? undefined)
            : null;
          if (update.docChanged) {
            if (externalSyncRef.current) externalSyncRef.current = false;
            else if (changedText !== null) latestRef.current.onChange(changedText, textChanges);
          }
          if (update.docChanged || update.selectionSet) {
            const selection = update.state.selection.main;
            latestRef.current.onSelectionLengthChange?.(selection.empty ? 0 : Math.abs(selection.to - selection.from));
            latestRef.current.onSelectionChange?.(selection.empty ? null : {
              from: Math.min(selection.anchor, selection.head),
              to: Math.max(selection.anchor, selection.head),
              text: update.state.sliceDoc(Math.min(selection.anchor, selection.head), Math.max(selection.anchor, selection.head)),
            });
            if (!externalSyncRef.current) {
              latestRef.current.onCursorPositionChange?.(
                (changedDocumentIndex ?? sentencePositionIndex(update.state.doc)).indexAtOffset(selection.head),
                Math.max(0, viewRef.current?.scrollDOM.scrollTop ?? 0),
              );
            }
          }
        }),
        placeholder ? cmPlaceholder(placeholder) : [],
      ],
    });
    sentencePositionIndex(state.doc, state.doc.toString());
    const view = new EditorView({ state, parent });
    viewRef.current = view;
    const onScroll = () => reportPosition(view);
    view.scrollDOM.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      view.scrollDOM.removeEventListener("scroll", onScroll);
      view.destroy();
      viewRef.current = null;
    };
  // CodeMirror initializes once; changing value and callbacks flow through refs and the sync effect.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const view = viewRef.current;
    if (view) view.dispatch({ effects: editabilityCompartment.reconfigure(editabilityExtensions(readOnly)) });
  }, [editabilityCompartment, readOnly]);

  useEffect(() => {
    const view = viewRef.current;
    if (view) view.dispatch({ effects: refreshTermAdornments.of(null) });
  }, [resolveTerms, onTermNavigate, termResolutionKey]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || lastEvidenceLoadKeyRef.current === evidenceLoadKey) return;
    lastEvidenceLoadKeyRef.current = evidenceLoadKey;
    const next = evidenceState?.positionsTrusted && view.state.doc.toString() !== evidenceSourceText
      ? markEvidenceNeedsReview(evidenceState)
      : evidenceState ?? emptyDocumentEvidence(value, documentRevision);
    view.dispatch({ effects: setDocumentEvidence.of(next) });
  }, [evidenceLoadKey, evidenceState, evidenceSourceText, value, documentRevision]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || view.state.doc.toString() === value) return;
    externalSyncRef.current = true;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: value },
      annotations: [Transaction.addToHistory.of(false), externalDocumentSync.of(true)],
    });
  }, [externalTextRevision, value]);

  return <div ref={containerRef} className="manuscript-input" style={style} data-testid="manuscript-input" />;
});

function styleNonceExtension() {
  const nonce = document.querySelector<HTMLMetaElement>('meta[name="codexia-style-nonce"]')?.content;
  return nonce && nonce !== "__CODEXIA_STYLE_NONCE__" ? EditorView.cspNonce.of(nonce) : [];
}

function editabilityExtensions(readOnly: boolean) {
  return [EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)];
}
