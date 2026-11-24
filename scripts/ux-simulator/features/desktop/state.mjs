export const atlas = 'docs/design/SCREEN-STATE-ATLAS.md';
export const publishing = 'docs/design/PUBLISHING.md';
export const owner = 'OWNER-API';
export const entry = 'ENTRY-01/ready';
export const library = 'LIB-01/ready';
export const outline = 'OUT-01/ready';
export const writing = 'WRT-01/ready';
export const sending = 'WRT-01/submitting';
export const reading = 'READ-01/ready';
export const history = 'WRT-02/ready';
export const recovery = 'REC-01/ready';
export const knowledge = 'KNO-01/ready';
export const evidence = 'KNO-02/ready';
export const reviews = 'REV-01/ready';
export const proposal = 'REV-02/ready';
export const modules = 'TOOL-01/ready';
export const publishingPanel = 'TOOL-01/publishing';
export const jobs = 'JOB-01/ready';
export const display = 'DISPLAY-01/ready';
export const preferences = 'PREF-01/ready';

const initialLayout = { preset: 'writing', order: ['outline', 'manuscript', 'reference'], arrangement: 'split', width: 'standard', hidden: [], status: 'ready' };

export const fixture = {
  principal: owner, actor: 'author', project: 'synthetic-tide', title: '潮待ち', document: 'scene-departure',
  navigationGeneration: 0, revision: 2, draftVersion: 0, journal: 'protected', selection: [0, 0], scroll: 0,
  committed: '汽笛が一度鳴った。\n岸壁に寄せた波が、眠る街の下で音を立てた。',
  draft: '汽笛が一度鳴った。\n岸壁に寄せた波が、眠る街の下で音を立てた。',
  documents: [
    { id: 'volume-harbor', title: '潮待ち', kind: 'volume', parent: '' },
    { id: 'chapter-two', title: '第二章', kind: 'chapter', parent: 'volume-harbor' },
    { id: 'scene-departure', title: '出港', kind: 'scene', parent: 'chapter-two' },
    { id: 'scene-fog', title: '霧の中', kind: 'scene', parent: 'chapter-two', text: '灯台の光が消えた。' },
    { id: 'chapter-three', title: '第三章', kind: 'chapter', parent: 'volume-harbor' },
    { id: 'scene-return', title: '帰港', kind: 'scene', parent: 'chapter-three', text: '明日の便で帰る。' },
  ],
  projects: {}, workByDocument: {}, revisionHistory: [{ id: 1, text: '汽笛が一度鳴った。' }],
  counter: 0, operation: null, receipt: null, failure: null, composing: false,
  layout: initialLayout, savedLayout: initialLayout, theme: 'light', typesetting: 'horizontal',
  proposal: 'proposed', moduleEnabled: true, unread: true, query: '', archive: null, shared: 'unpublished',
  node: { id: 'synthetic-lighthouse', name: '灯台', project: 'synthetic-tide', relation: '港の入口', revision: 2, document: 'scene-departure' },
};

export const result = (context, change = {}, message) => ({ context: { ...context, ...change }, message });
export const hasOwner = ({ principal }) => principal === owner || '作者の認可を確認してください。';
export const leave = ({ composing, journal, inFlight }) =>
  composing ? '変換を確定してから移動してください。'
    : journal !== 'protected' ? '下書きを保護してから移動してください。'
      : inFlight ? '送信中の操作を照合してから移動してください。' : true;
export const draftGuard = '同じ作者、IME 確定、下書き保護、未解決操作なし';

export function edge(from, event, to, rules = {}) {
  const prior = rules.guard;
  const allowed = from === entry ? null : hasOwner;
  const guard = allowed || prior ? (context, input) => {
    const permission = allowed?.(context) ?? true;
    return permission === true ? prior?.(context, input) ?? true : permission;
  } : undefined;
  return {
    id: from.replace('/', '-') + '.' + event,
    from, event, to, source: atlas, ...rules, guard,
    guardDescription: guard ? rules.guardDescription ?? '作者スコープと操作対象の確認' : undefined,
  };
}

export function remember(context) {
  if (!context.document) return context.workByDocument;
  return { ...context.workByDocument, [context.document]: {
    draft: context.draft, committed: context.committed, revision: context.revision,
    revisionHistory: context.revisionHistory, draftVersion: context.draftVersion, journal: context.journal,
    selection: context.selection, scroll: context.scroll, receipt: context.receipt,
  } };
}

export function openDocument(context, id) {
  const workByDocument = remember(context);
  const document = context.documents.find(({ id: key }) => key === id);
  const text = document.text ?? '';
  const newWork = {
    draft: text, committed: text, revision: 1, revisionHistory: [],
    draftVersion: 0, journal: 'protected', selection: [0, 0], scroll: 0, receipt: null,
  };
  return result(context, {
    ...newWork, ...(workByDocument[id] ?? {}), workByDocument,
    document: id, failure: null, navigationGeneration: context.navigationGeneration + 1,
  });
}

export function nextOperation(context, type) {
  return 'synthetic-' + type + '-' + (context.counter + 1);
}

export const formatFailure = {
  cancelled: '操作を中止しました。', forbidden: '対象の権限がありません。', unauthorized: '認証が失効しました。',
  'not-found': '対象を取得できません。', conflict: '確定版と競合しています。', stale: '古い版の応答を無視しました。',
  timeout: '結果を確認できません。同じ操作を照合してください。', offline: '接続が途切れました。',
  quota: '下書き保護領域の空きがありません。', invalid: '入力を確認してください。', unavailable: '現在は利用できません。',
};

export function failed(context, response) {
  return result(context, { failure: response }, formatFailure[response]);
}

export function publishedText(context, scope) {
  const selected = context.documents.find(({ id }) => id === scope);
  if (!selected) return '';
  const chapters = new Set(context.documents.filter(({ parent }) => parent === scope).map(({ id }) => id));
  return context.documents.filter(({ kind, id, parent }) =>
    kind === 'scene' && (id === scope || parent === scope || chapters.has(parent)))
    .map(({ id, text }) => id === context.document ? context.committed : context.workByDocument[id]?.committed ?? text ?? '')
    .filter(Boolean).join('\n');
}

export const choose = (values, message) => (_context, value) => values.includes(value) || message;
export const titleInput = (value) => typeof value === 'string' && value.trim().length > 0 && value.trim().length <= 120;
