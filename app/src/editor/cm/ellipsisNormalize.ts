import { EditorState, type Extension } from '@codemirror/state';
import { externalDocumentSync } from './textAnchorDecorations';

const ELLIPSIS_LONE = /(?<!…)…(?!…)/gu;

export function normalizeEllipsisInsert(before: string, insert: string, after: string): string {
  if (!insert.includes('…')) return insert;
  const combined = before + insert + after;
  const normalized = combined.replace(ELLIPSIS_LONE, '……');
  if (normalized === combined) return insert;
  return normalized.slice(before.length, normalized.length - after.length);
}

function isMidCompositionTransaction(transaction: { isUserEvent: (event: string) => boolean }): boolean {
  return transaction.isUserEvent('input.type.compose') && !transaction.isUserEvent('input.type.compose.end');
}

export function ellipsisNormalizeExtension(): Extension {
  return EditorState.transactionFilter.of(transaction => {
    // A server/recovery snapshot is already canonical source text.  In
    // particular, do not rewrite a persisted single ellipsis while loading it
    // into the editor; normalization is only for local authoring input.
    if (!transaction.docChanged || isMidCompositionTransaction(transaction) || transaction.annotation(externalDocumentSync))
      return transaction;
    const replacements: { from: number; to: number; insert: string }[] = [];
    transaction.changes.iterChanges((fromA, _toA, fromB, toB, inserted) => {
      const previousIsEllipsis = fromA > 0 && transaction.startState.doc.sliceString(fromA - 1, fromA) === '…';
      if (!previousIsEllipsis && !inserted.toString().includes('…')) return;
      const doc = transaction.newDoc;
      let from = fromB;
      let to = toB;
      while (from > 0 && doc.sliceString(from - 1, from) === '…') from -= 1;
      while (to < doc.length && doc.sliceString(to, to + 1) === '…') to += 1;
      for (const match of doc.sliceString(from, to).matchAll(ELLIPSIS_LONE)) {
        const at = from + match.index;
        if (at !== replacements.at(-1)?.from) replacements.push({ from: at, to: at + 1, insert: '……' });
      }
    });
    // Compose the expansion with the input so CodeMirror maps its caret and retains its event and history metadata.
    return replacements.length ? [transaction, { changes: replacements, sequential: true }] : transaction;
  });
}
