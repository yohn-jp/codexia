import {
  atlas, edge, result, failed, nextOperation, leave, draftGuard, writing, sending, reading, recovery,
  history, evidence, knowledge, outline, reviews, modules, display, preferences, jobs,
} from './state.mjs';

const recoveryLink = (context, response) => failed(context, response);
const position = (context, value) => result(context, { selection: value.slice(0, 2), scroll: value[2] });
const edit = (context, draft) => draft === context.draft ? result(context) : result(context, {
  draft, draftVersion: context.draftVersion + 1, journal: 'pending',
});

function prepare(context, kind, text = context.draft) {
  const operation = nextOperation(context, kind);
  return result(context, {
    operation, counter: context.counter + 1, failure: null, receipt: null,
    inFlight: { kind, operation, text, version: context.draftVersion, revision: context.revision, document: context.document,
      generation: context.navigationGeneration },
  }, '送信しました。確定結果を待っています。');
}

function commit(context) {
  const { inFlight: pending } = context;
  const revision = context.revision + 1;
  const restore = pending.kind === 'restore';
  const keepDraft = context.draftVersion !== pending.version;
  const change = {
    operation: null, inFlight: null, failure: null, committed: pending.text, revision,
    revisionHistory: [...context.revisionHistory, { id: context.revision, text: context.committed }],
    receipt: { operation: pending.operation, document: pending.document, revision },
  };
  if (restore && !keepDraft) Object.assign(change, { draft: pending.text, journal: 'protected' });
  const saved = !keepDraft && context.journal === 'protected';
  return result(context, change, saved ? '確定 receipt を照合しました。保存済み。'
    : '送信時点の版を保存しました。追加入力は未保存です。');
}

const receiptGuard = ({ inFlight, navigationGeneration, document }) =>
  Boolean(inFlight && inFlight.generation === navigationGeneration && inFlight.document === document)
    || 'この原稿の保留中の操作がありません。';

const localGuard = ({ composing }) => !composing || '変換を確定してください。';
const clean = ({ draft, committed }) => draft === committed || '原稿を保存して確定 Revision を取得してください。';
const pendingResponses = ['timeout', 'offline', 'stale', 'unauthorized', 'conflict'];
const recoverFailures = (context, response) => result(context, {
  failure: response,
  ...(!pendingResponses.includes(response) ? { inFlight: null, operation: null } : {}),
}, failed(context, response).message);

const samePositionEvents = [writing, sending, recovery].flatMap((at) => [
  edge(at, 'edit', at, { guard: (_context, value) => (typeof value === 'string' && value.length <= 120000) || '原稿が長すぎます。', reduce: edit }),
  edge(at, 'position', at, {
    guard: (_context, value) => (Array.isArray(value) && value.length === 3 && value[0] <= value[1]
      && value.every((number) => Number.isFinite(number) && number >= 0)) || '選択位置を確認してください。',
    reduce: position,
  }),
  edge(at, 'composition-start', at, { reduce: (context) => result(context, { composing: true }) }),
  edge(at, 'composition-end', at, { reduce: (context) => result(context, { composing: false }) }),
]);

export const writingEdges = [
  ...samePositionEvents,
  edge(writing, 'protect', writing, {
    effect: true, guard: localGuard, failure: recovery,
    reduce: (context) => result(context, { journal: 'protected', failure: null }, '下書きを保護しました。'),
    onFailure: (context, response) => result(context, { journal: 'at-risk', failure: response }, failed(context, response).message),
  }),
  edge(sending, 'protect', sending, {
    effect: true, guard: localGuard,
    reduce: (context) => result(context, { journal: 'protected' }),
    onFailure: (context, response) => result(context, { journal: 'at-risk' }, failed(context, response).message),
  }),
  edge(writing, 'save', sending, {
    control: 'WRT-01.A', guardDescription: draftGuard + '・変更がある',
    guard: (context) => {
      const protectedDraft = leave(context);
      return protectedDraft !== true ? protectedDraft : context.draft !== context.committed || '保存する変更がありません。';
    },
    reduce: (context) => prepare(context, 'save'),
  }),
  edge(sending, 'response', writing, {
    effect: true, guard: receiptGuard, failure: recovery, reduce: commit, onFailure: recoverFailures,
  }),
  edge(recovery, 'reconcile', writing, {
    control: 'REC-01.B', effect: true, guard: (context) => ['timeout', 'offline', 'stale'].includes(context.failure)
      ? receiptGuard(context) : '応答不明の操作のみ同じ receipt を照合できます。',
    reduce: commit, onFailure: recoverFailures,
  }),
  edge(recovery, 'protect', writing, {
    control: 'REC-01.A', effect: true, guard: (context) =>
      context.inFlight ? '先に保留中の操作を照合してください。' : localGuard(context),
    reduce: (context) => result(context, { journal: 'protected', failure: null }),
    onFailure: (context, response) => result(context, { journal: 'at-risk', failure: response }, failed(context, response).message),
  }),
  edge(recovery, 'protect-conflict', recovery, {
    control: 'REC-01.A', effect: true, guard: (context) => context.failure === 'conflict' && localGuard(context) === true
      || '競合中の下書きと変換状態を確認してください。',
    reduce: (context) => result(context, { journal: 'protected' }),
    onFailure: (context, response) => result(context, { journal: 'at-risk' }, failed(context, response).message),
  }),
  edge(recovery, 'rebase-draft', sending, {
    control: 'REC-01.C', guard: (context) => context.failure === 'conflict' && localGuard(context) === true
      && context.journal === 'protected' || '競合と保護済み下書きを確認してください。',
    reduce: (context) => prepare({ ...context, revision: context.revision + 1, committed: '確定版には霧の記録が残った。' }, 'save'),
  }),
  edge(recovery, 'discard-draft', writing, {
    control: 'REC-01.C', guard: (context, confirmed) => context.failure === 'conflict' && confirmed === 'confirm'
      || '差分を確認し、下書き破棄を明示してください。',
    replayInputs: ['confirm'],
    reduce: (context) => result(context, {
      draft: '確定版には霧の記録が残った。', committed: '確定版には霧の記録が残った。',
      journal: 'protected', operation: null, inFlight: null, failure: null, revision: context.revision + 1,
    }),
  }),
  edge(recovery, 'reauthenticate', recovery, {
    effect: true, guard: (context) => context.failure === 'unauthorized' && context.journal === 'protected'
      || '失効状態と下書き保護を確認してください。',
    reduce: (context) => result(context, { failure: 'timeout' }, '同じ作者を確認しました。確定 receipt を照合してください。'),
    onFailure: recoverFailures,
  }),
  edge(recovery, 'return-to-editor', writing, {
    guard: ({ inFlight }) => !inFlight || '保留中の操作を先に照合してください。',
  }),
  edge(writing, 'reading', reading, { control: 'WRT-01.B', guard: leave, guardDescription: draftGuard }),
  edge(reading, 'back-editor', writing),
  edge(reading, 'reader-page', reading, { reduce: (context) => result(context, { readerPage: context.readerPage === 2 ? 1 : 2 }) }),
  edge(reading, 'reader-orientation', reading, { reduce: (context) => result(context, {
    typesetting: context.typesetting === 'vertical' ? 'horizontal' : 'vertical',
  }) }),
  edge(reading, 'reader-reference', evidence, { reduce: (context) => result(context, { knowledgeReturn: reading }) }),
  edge(writing, 'history', history, { guard: leave,
    effect: true, onFailure: recoveryLink }),
  edge(history, 'revision', history, {
    control: 'WRT-02.A', guard: ({ revisionHistory }, id) => revisionHistory.some((item) => item.id === id) || 'Revision が見つかりません。',
    reduce: (context, id) => result(context, { comparedRevision: id }),
  }),
  edge(history, 'back-editor', writing),
  edge(history, 'restore', sending, {
    control: 'WRT-02.B', guard: (context, answer) => (answer === 'confirm'
      && context.revisionHistory.some(({ id }) => id === context.comparedRevision) && clean(context) === true)
      || '比較、明示確認、現在の原稿保存が必要です。',
    replayInputs: ['confirm'],
    reduce: (context) => prepare(context, 'restore', context.revisionHistory.find(({ id }) => id === context.comparedRevision).text),
  }),
  edge(writing, 'anchor', evidence, {
    control: 'WRT-01.C', guard: (context) => clean(context) === true && context.selection[0] < context.selection[1]
      && context.selection[1] <= context.committed.length || '確定版の本文範囲を選択してください。',
    effect: true, onFailure: failed,
    reduce: (context) => result(context, { knowledgeReturn: writing, anchor: {
      revision: context.revision, project: context.project, document: context.document, selection: context.selection,
      quote: context.committed.slice(...context.selection),
    } }),
  }),
  edge(writing, 'editor-style', writing, {
    control: 'WRT-01.D', reduce: (context) => result(context, { font: context.font === 'large' ? 'normal' : 'large' }),
  }),
  ...[
    ['outline', outline], ['knowledge', knowledge], ['review', reviews], ['modules', modules],
    ['display', display], ['preferences', preferences], ['jobs', jobs],
  ].map(([event, to]) => edge(writing, event, to, { guard: leave, guardDescription: draftGuard,
    reduce: (context) => result(context, { knowledgeReturn: writing }) })),
];
