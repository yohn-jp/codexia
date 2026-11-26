import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { Compartment, EditorState, Transaction } from '@codemirror/state';
import { placeholder as cmPlaceholder, drawSelection, EditorView, highlightActiveLine, keymap } from '@codemirror/view';
import { type CSSProperties, forwardRef, useCallback, useEffect, useImperativeHandle, useRef } from 'react';
import { createUiSentencePositionIndexCache, type UiSentencePositionIndexCache } from '../resume/continueCandidates';
import { bracketPairsExtension } from './cm/bracketPairs';
import { editorCompositionExtension, isViewComposing } from './cm/compositionGuard';
import { dispatchManuscriptTransactions } from './cm/editability';
import { ellipsisNormalizeExtension } from './cm/ellipsisNormalize';
import { refreshTermAdornments, termAdornmentsExtension } from './cm/termAdornments';
import { externalDocumentSync, setDocumentEvidence, textAnchorDecorationsExtension } from './cm/textAnchorDecorations';
import { type DocumentEvidenceState, emptyDocumentEvidence, markEvidenceNeedsReview, type TextChange } from './evidence';
import { editorOffsetReader, sourceEdit, sourceSelection } from './sourceText';
import type { ResolveEditorTerms } from './terms';
import { planWritingSymbol, type WritingSymbolId } from './writingSymbols';
import './terminology.css';

export interface ManuscriptInputHandle {
  focus(): void;
  isComposing(): boolean;
  flushComposition(): Promise<string>;
  readForNavigation(): string;
  insert(symbol: WritingSymbolId): void;
  revealOffset(offset: number, focus?: boolean): boolean;
  restorePosition(position: ManuscriptPosition): void;
  getScrollTop(): number;
  getSelection(): { from: number; to: number; text: string } | null;
}

export interface ManuscriptPosition {
  cursorSentenceIndex: number | null;
  scrollTop: number;
}

export interface EvidenceRangeRequest {
  revisionId: string;
  from: number;
  to: number;
  quote: string;
}

export interface ManuscriptInputProps {
  value: string;
  externalTextRevision: number;
  readOnly?: boolean;
  onChange: (value: string, changes: TextChange[]) => void;
  onSelectionLengthChange?: (length: number) => void;
  onSelectionChange?: (selection: { from: number; to: number; text: string } | null) => void;
  onCursorPositionChange?: (cursorSentenceIndex: number | null, scrollTop: number) => void;
  requestedPosition?: ManuscriptPosition;
  consumeRequestedPosition?: (position: ManuscriptPosition) => boolean;
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
  evidenceRangeRequest?: EvidenceRangeRequest;
  onEvidenceRangeResult?: (request: EvidenceRangeRequest, revealed: boolean) => void;
}

/** CodeMirror adapter retaining IME-safe editing, source bracket/ellipsis rules and history keymaps. */
export const ManuscriptInput = forwardRef<ManuscriptInputHandle, ManuscriptInputProps>(function ManuscriptInput(
  {
    value,
    externalTextRevision,
    readOnly = false,
    onChange,
    onSelectionLengthChange,
    onSelectionChange,
    onCursorPositionChange,
    requestedPosition,
    consumeRequestedPosition,
    placeholder,
    labelledBy,
    style,
    resolveTerms,
    onTermNavigate,
    termResolutionKey,
    documentRevision = '',
    evidenceState = null,
    evidenceLoadKey = 0,
    evidenceSourceText = value,
    onEvidenceChange,
    evidenceRangeRequest,
    onEvidenceRangeResult,
  },
  ref,
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const sourceTextRef = useRef(value);
  sourceTextRef.current = value;
  const sentencePositionIndexRef = useRef<UiSentencePositionIndexCache<EditorState['doc']> | null>(null);
  const editabilityCompartment = useRef(new Compartment()).current;
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

  const sentencePositionIndex = useCallback((doc: EditorState['doc'], text?: string) => {
    sentencePositionIndexRef.current ??= createUiSentencePositionIndexCache<EditorState['doc']>();
    return sentencePositionIndexRef.current.get(doc, text);
  }, []);

  const restorePosition = useCallback(
    (position: ManuscriptPosition) => {
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
      requestAnimationFrame(() => {
        suppressPositionRef.current = false;
      });
    },
    [sentencePositionIndex],
  );

  function reportPosition(view: EditorView): void {
    if (suppressPositionRef.current) return;
    const selection = view.state.selection.main;
    latestRef.current.onCursorPositionChange?.(
      sentencePositionIndex(view.state.doc).indexAtOffset(selection.head),
      Math.max(0, view.scrollDOM.scrollTop),
    );
  }

  useImperativeHandle(
    ref,
    () => ({
      focus() {
        viewRef.current?.focus();
      },
      isComposing() {
        const view = viewRef.current;
        return Boolean(view && isViewComposing(view));
      },
      readForNavigation() {
        const view = viewRef.current;
        if (!view) throw new Error('原稿エディタが初期化されていません。本文を保護するため、画面の切り替えを中止しました。');
        if (isViewComposing(view)) throw new Error('日本語入力の変換が完了していません。変換を確定してから画面を切り替えてください。');
        return readSourceText(view, sourceTextRef.current);
      },
      async flushComposition() {
        const view = viewRef.current;
        if (!view) return '';
        if (isViewComposing(view)) {
          view.contentDOM.blur();
          await new Promise<void>(resolve => window.setTimeout(resolve, 0));
          await new Promise<void>(resolve => window.setTimeout(resolve, 0));
          if (isViewComposing(view)) {
            throw new Error('日本語入力の変換が完了していません。変換を確定してから画面を切り替えてください。');
          }
        }
        return readSourceText(view, sourceTextRef.current);
      },
      insert(symbol) {
        const view = viewRef.current;
        if (!view || view.state.readOnly) return;
        const selection = view.state.selection.main;
        const plan = planWritingSymbol(view.state.doc.toString(), selection.from, selection.to, symbol);
        view.dispatch({
          changes: { from: plan.from, to: plan.to, insert: plan.insert },
          selection: { anchor: plan.cursor },
          userEvent: 'input.type',
        });
        view.focus();
        view.dispatch({ selection: { anchor: plan.cursor }, scrollIntoView: true });
        const cursorDomPosition = view.domAtPos(plan.cursor);
        view.contentDOM.ownerDocument.getSelection()?.collapse(cursorDomPosition.node, cursorDomPosition.offset);
      },
      revealOffset(offset, focus = true) {
        const view = viewRef.current;
        if (!view || isViewComposing(view) || !Number.isSafeInteger(offset) || offset < 0 || offset > view.state.doc.length) return false;
        suppressPositionRef.current = true;
        view.dispatch({
          selection: { anchor: offset },
          scrollIntoView: true,
          annotations: Transaction.addToHistory.of(false),
        });
        if (focus) view.focus();
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            suppressPositionRef.current = false;
          }),
        );
        return true;
      },
      restorePosition,
      getScrollTop() {
        return Math.max(0, viewRef.current?.scrollDOM.scrollTop ?? 0);
      },
      getSelection() {
        const view = viewRef.current;
        if (!view) return null;
        const selection = view.state.selection.main;
        return sourceSelection(readSourceText(view, sourceTextRef.current), selection.from, selection.to);
      },
    }),
    [restorePosition],
  );

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
        textAnchorDecorationsExtension(evidenceRef, documentRevisionRef, evidenceCallbackRef, navigatorRef, sourceTextRef),
        styleNonceExtension(),
        EditorView.lineWrapping,
        EditorView.contentAttributes.of({
          id: 'manuscript',
          'aria-labelledby': labelledBy,
          'aria-multiline': 'true',
          role: 'textbox',
          spellcheck: 'false',
          autocapitalize: 'off',
          enterkeyhint: 'enter',
        }),
        EditorView.updateListener.of(update => {
          const changedText = update.docChanged ? update.state.doc.toString() : null;
          const textChanges: TextChange[] = [];
          if (update.docChanged)
            update.changes.iterChanges((from, to, _newFrom, _newTo, inserted) => {
              textChanges.push({ from, to, insert: inserted.toString() });
            });
          const changedDocumentIndex = update.docChanged ? sentencePositionIndex(update.state.doc, changedText ?? undefined) : null;
          const externalSync = update.transactions.some(transaction => transaction.annotation(externalDocumentSync));
          if (changedText !== null && !externalSync) {
            const edit = sourceEdit(sourceTextRef.current, changedText, textChanges);
            sourceTextRef.current = edit.markdown;
            latestRef.current.onChange(edit.markdown, edit.changes);
          }
          if (update.docChanged || update.selectionSet) {
            const selection = update.state.selection.main;
            latestRef.current.onSelectionLengthChange?.(selection.empty ? 0 : Math.abs(selection.to - selection.from));
            latestRef.current.onSelectionChange?.(sourceSelection(sourceTextRef.current, selection.from, selection.to));
            if (!suppressPositionRef.current) {
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
    const view = new EditorView({ state, parent, dispatchTransactions: dispatchManuscriptTransactions });
    viewRef.current = view;
    const onScroll = () => reportPosition(view);
    view.scrollDOM.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      view.scrollDOM.removeEventListener('scroll', onScroll);
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
    const next =
      evidenceState?.positionsTrusted && readSourceText(view, sourceTextRef.current) !== evidenceSourceText
        ? markEvidenceNeedsReview(evidenceState)
        : (evidenceState ?? emptyDocumentEvidence(value, documentRevision));
    view.dispatch({ effects: setDocumentEvidence.of(next) });
  }, [evidenceLoadKey, evidenceState, evidenceSourceText, value, documentRevision]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || readSourceText(view, value) === value) return;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: value },
      annotations: [Transaction.addToHistory.of(false), externalDocumentSync.of(true)],
    });
  }, [externalTextRevision, value]);

  useEffect(() => {
    if (!requestedPosition || !consumeRequestedPosition) return;
    const frame = requestAnimationFrame(() => {
      if (viewRef.current && consumeRequestedPosition(requestedPosition)) restorePosition(requestedPosition);
    });
    return () => cancelAnimationFrame(frame);
  }, [consumeRequestedPosition, requestedPosition, restorePosition]);

  useEffect(() => {
    if (!evidenceRangeRequest || !onEvidenceRangeResult) return;
    const request = evidenceRangeRequest;
    const frame = requestAnimationFrame(() => {
      const view = viewRef.current;
      const offset = editorOffsetReader(evidenceSourceText);
      const from = offset(request.from);
      const to = offset(request.to);
      const valid =
        view &&
        !isViewComposing(view) &&
        request.revisionId === documentRevisionRef.current &&
        readSourceText(view, sourceTextRef.current) === evidenceSourceText &&
        from !== null &&
        to !== null &&
        to > from &&
        evidenceSourceText.slice(request.from, request.to) === request.quote;
      if (view && valid) {
        view.dispatch({
          selection: { anchor: from, head: to },
          scrollIntoView: true,
          annotations: Transaction.addToHistory.of(false),
        });
        view.focus();
      }
      onEvidenceRangeResult(request, Boolean(valid));
    });
    return () => cancelAnimationFrame(frame);
  }, [evidenceRangeRequest, onEvidenceRangeResult, evidenceSourceText]);

  return <div ref={containerRef} className="manuscript-input" style={style} data-testid="manuscript-input" />;
});

function styleNonceExtension() {
  const nonce = document.querySelector<HTMLMetaElement>('meta[name="codexia-style-nonce"]')?.content;
  return nonce && nonce !== '__CODEXIA_STYLE_NONCE__' ? EditorView.cspNonce.of(nonce) : [];
}

function editabilityExtensions(readOnly: boolean) {
  return [EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)];
}

/** CodeMirror represents all line breaks as LF. A navigation read must retain unchanged source bytes. */
function readSourceText(view: EditorView, source: string): string {
  const text = view.state.doc.toString();
  return source.includes('\r') && source.replace(/\r\n?/gu, '\n') === text ? source : text;
}
