import type { Transaction } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { externalDocumentSync } from './textAnchorDecorations';

export function dispatchManuscriptTransactions(transactions: readonly Transaction[], view: Pick<EditorView, 'update'>): void {
  // Some CodeMirror commands opt out of state transaction filters.
  if (
    transactions.some(
      transaction => transaction.startState.readOnly && transaction.docChanged && !transaction.annotation(externalDocumentSync),
    )
  )
    return;
  view.update(transactions);
}
