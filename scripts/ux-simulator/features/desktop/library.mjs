import {
  edge, result, failed, leave, draftGuard, titleInput, openDocument, nextOperation, remember,
  entry, library, outline, writing,
} from './state.mjs';

export const archiveFixture = JSON.stringify({
  schemaVersion: 1, id: 'synthetic-import', title: '波の手紙',
  documents: [
    { id: 'import-volume', parent: '', kind: 'volume', title: '波の手紙' },
    { id: 'import-chapter', parent: 'import-volume', kind: 'chapter', title: '第一章' },
    { id: 'import-scene-1', parent: 'import-chapter', kind: 'scene', title: '拾った手紙', text: '便箋には港の名があった。' },
  ],
});
const create = 'LIB-01/create';
const importing = 'LIB-01/import';
const projectFields = ['project', 'title', 'documents', 'workByDocument', 'document', 'draft', 'committed',
  'draftVersion', 'revision', 'revisionHistory', 'selection', 'scroll', 'receipt', 'journal', 'node', 'shared', 'share',
  'proposal', 'proposalKind', 'proposalTarget', 'pendingApply', 'proposalReceipt', 'deletedDocuments'];

const takeProject = (context) => Object.fromEntries(projectFields.map((field) => [field, context[field]]));
function project(context, title, id, documents) {
  const previous = { ...context.projects, [context.project]: takeProject(context) };
  const empty = {
    project: id, title, documents, workByDocument: {}, document: null, draft: '', committed: '',
    draftVersion: 0, revision: 1, revisionHistory: [], selection: [0, 0], scroll: 0, receipt: null, journal: 'protected',
    node: null, shared: 'unpublished', share: null, proposal: 'proposed', proposalKind: null, proposalTarget: null,
    pendingApply: null, proposalReceipt: null, deletedDocuments: [],
  };
  return result(context, { ...empty, projects: previous, archive: null, failure: null, query: '' }, '作品を確認しました。');
}

function switchProject(context, id) {
  if (!id || id === context.project) return result(context);
  return result(context, {
    ...context.projects[id],
    projects: { ...context.projects, [context.project]: takeProject(context) },
    archive: null, failure: null, query: '',
  });
}

function imported(raw) {
  if (typeof raw !== 'string' || raw.length > 160000) return null;
  try {
    const { schemaVersion, id, title, documents } = JSON.parse(raw);
    if (schemaVersion !== 1 || typeof id !== 'string' || !/^synthetic-[a-z0-9-]+$/.test(id) || !titleInput(title)
      || !Array.isArray(documents) || documents.length > 80) return null;
    const ids = new Set();
    for (const document of documents) {
      if (!document || typeof document.id !== 'string' || !/^[a-z0-9-]{1,80}$/.test(document.id) || ids.has(document.id)
        || !titleInput(document.title) || !validParent({ documents }, document.kind, document.parent)
        || (document.kind === 'scene' && (typeof document.text !== 'string' || document.text.length > 120000))) return null;
      ids.add(document.id);
    }
    return { id, title, documents: documents.map(({ id, parent, kind, title, text }) => ({ id, parent, kind, title, ...(kind === 'scene' ? { text } : {}) })) };
  } catch {
    return null;
  }
}

const knownScene = (context, id) => context.documents.some((item) => item.id === id && item.kind === 'scene');
const natural = (context, value) => {
  const guard = leave(context);
  return guard !== true ? guard : knownScene(context, value) || '同じ作品のシーンを選んでください。';
};
const acceptedKind = ['volume', 'chapter', 'scene'];
const parentKind = { volume: null, chapter: 'volume', scene: 'chapter' };
function validParent(context, kind, parent) {
  return acceptedKind.includes(kind) && (kind === 'volume' ? parent === ''
    : context.documents.some((item) => item.id === parent && item.kind === parentKind[kind]));
}

const updateDocument = (list, id, change) => list.map((item) => item.id === id ? { ...item, ...change } : item);

export const libraryEdges = [
  edge(entry, 'launch', 'AUTH-01/ready', {
    control: 'ENTRY-01.A', handoff: { platform: 'auth', scenario: 'owner-login', checkpoint: 'start' },
    carry: () => ({ returnPlatform: 'desktop' }),
  }),
  edge(entry, 'resume-session', library, {
    control: 'ENTRY-01.A', effect: true,
    guard: ({ principal }) => principal === 'OWNER-API' || 'ログインするか、合成済みセッションの開始状態を選んでください。',
    onFailure: failed,
  }),
  edge(library, 'open-project', outline, {
    control: 'LIB-01.A', effect: true, onFailure: failed,
    guard: (context, id) => (!id || id === context.project || Object.hasOwn(context.projects, id)) || '作品の同一性を確認できません。',
    reduce: switchProject,
  }),
  edge(library, 'resume-project', writing, {
    control: 'LIB-01.A', effect: true, guard: ({ documents }) => documents.some(({ kind }) => kind === 'scene')
      || 'まだ再開できる原稿がありません。', onFailure: failed,
    reduce: (context) => openDocument(context, context.documents.find(({ kind }) => kind === 'scene').id),
  }),
  edge(library, 'create-project', create, { control: 'LIB-01.B' }),
  edge(create, 'cancel', library),
  edge(create, 'confirm-project', outline, {
    control: 'LIB-01.B', effect: true, guard: (context, name) => titleInput(name) && (!context.projectOperation || context.pendingName === name)
      || '結果不明の作成は同じ作品名で照合してください。',
    onFailure: (context, response, name) => result(context, {
      pendingName: name, failure: response, projectOperation: ['timeout', 'offline', 'stale'].includes(response) ? context.projectOperation ?? nextOperation(context, 'create-project') : null,
    }, failed(context, response).message),
    reduce: (context, name) => ({ ...project({
      ...context, counter: context.counter + 1, projectOperation: null,
    }, name.trim(), context.projectOperation ?? nextOperation(context, 'create-project'), []) }),
  }),
  edge(library, 'import', importing, { control: 'LIB-01.C' }),
  edge(importing, 'cancel', library),
  edge(importing, 'import-project', outline, {
    control: 'LIB-01.C', effect: true,
    guard: (context, raw) => {
      const item = imported(raw);
      return (item && item.id !== context.project && !Object.hasOwn(context.projects, item.id)) || '合成アーカイブの定義と重複を確認してください。';
    },
    onFailure: (context, response, raw) => result(context, { pendingImport: raw, failure: response }, failed(context, response).message),
    reduce: (context, raw) => {
      const value = imported(raw);
      return project(context, value.title, value.id, value.documents);
    },
  }),
  edge(library, 'export-project', library, {
    control: 'LIB-01.D', effect: true, onFailure: failed,
    reduce: (context) => result(context, { archive: { schemaVersion: 1, id: context.project, title: context.title,
      documents: context.documents.map((item) => item.kind === 'scene' ? { ...item,
        text: item.id === context.document ? context.committed : context.workByDocument[item.id]?.committed ?? item.text ?? '',
      } : item) } },
      '合成スナップショットの書き出しを確認しました。'),
  }),
  edge(outline, 'filter-outline', outline, {
    control: 'OUT-01.A', guard: (_context, query) => typeof query === 'string',
    reduce: (context, query) => result(context, { query }),
  }),
  edge(outline, 'outline-zoom', outline, {
    control: 'OUT-01.A', reduce: (context) => result(context, { zoomOutline: !context.zoomOutline }),
  }),
  edge(outline, 'expand-outline', outline, {
    control: 'OUT-01.A', reduce: (context) => result(context, { outlineExpanded: context.outlineExpanded === false }),
  }),
  edge(outline, 'open-document', writing, { control: 'OUT-01.B', effect: true, guard: natural, reduce: openDocument, onFailure: failed }),
  edge(outline, 'add-document', outline, {
    control: 'OUT-01.C', effect: true, onFailure: failed,
    guard: (context, form) => (form && titleInput(form.title) && validParent(context, form.kind, form.parent)) || '名前、種類、親を確認してください。',
    reduce: (context, form) => result(context, {
      counter: context.counter + 1,
      documents: [...context.documents, { id: nextOperation(context, 'document'), title: form.title.trim(), kind: form.kind, parent: form.parent }],
    }, '構成に追加しました。'),
  }),
  edge(outline, 'move-document', outline, {
    control: 'OUT-01.D', effect: true, onFailure: failed,
    guard: (context, form) => {
      const item = form && context.documents.find(({ id }) => id === form.id);
      return (item && titleInput(form.title) && validParent(context, item.kind, form.parent)) || '同じ作品の親、種類、名前を確認してください。';
    },
    reduce: (context, form) => {
      const documents = updateDocument(context.documents, form.id, { title: form.title.trim(), parent: form.parent });
      if (form.order === 'first') documents.unshift(...documents.splice(documents.findIndex(({ id }) => id === form.id), 1));
      if (form.order === 'last') documents.push(...documents.splice(documents.findIndex(({ id }) => id === form.id), 1));
      return result(context, { documents }, '構成を更新しました。');
    },
  }),
  edge(outline, 'delete-document', outline, {
    control: 'OUT-01.E', effect: true, onFailure: failed,
    guard: (context, form) => (form?.confirmed && context.documents.some(({ id }) => id === form.id)
      && !context.documents.some(({ parent }) => parent === form.id) && leave(context) === true) || '対象、下書き保護、確認を見直してください。',
    reduce: (context, form) => result(context, {
      documents: context.documents.filter(({ id }) => id !== form.id),
      document: context.document === form.id ? null : context.document,
      deletedDocuments: [...(context.deletedDocuments ?? []), {
        ...context.documents.find(({ id }) => id === form.id), work: remember(context)[form.id],
      }],
    }, '構成から削除しました。'),
  }),
  edge(outline, 'back-library', library, { guard: leave, guardDescription: draftGuard }),
  edge(outline, 'back-editor', writing, { guard: (context) => knownScene(context, context.document) || '本文を選んでください。' }),
  edge(library, 'back-entry', entry),
];
