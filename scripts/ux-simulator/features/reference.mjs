import { button, confirmAction, h } from '../dom.mjs';

const source = 'docs/design/SCREEN-CONTROL-CATALOG.md#コントロール導線台帳ボタンフォーム単位';
const principal = 'OWNER-API';
const library = 'LIB-01/ready';
const outline = 'OUT-01/ready';
const create = 'LIB-01/create';

export const demo = {
  id: 'reference',
  platform: 'desktop',
  screens: ['LIB-01', 'OUT-01'],
  fixtures: {
    'sample-library': { principal, project: 'synthetic-lighthouse', name: '', title: '灯台のノート', document: 'synthetic-chapter-1' },
  },
  scenarios: [{
    id: 'reference-authoring', label: '作品を開く・作成する', kind: 'normal', fixture: 'sample-library',
    checkpoints: { start: { at: library, principal }, outline: { at: outline, principal } },
  }],
  edges: [
    { id: 'open-existing', from: library, event: 'open', to: outline, control: 'LIB-01.A', effect: true },
    { id: 'begin-create', from: library, event: 'create', to: create, control: 'LIB-01.B' },
    { id: 'edit-name', from: create, event: 'name', to: create, reduce: (context, name) => ({ context: { ...context, name } }) },
    { id: 'cancel-create', from: create, event: 'cancel', to: library, reduce: (context) => ({ context: { ...context, name: '' } }) },
    {
      id: 'confirm-create', from: create, event: 'confirm', to: outline, control: 'LIB-01.B', effect: true,
      guard: ({ name, principal }) => (principal === 'OWNER-API' && name.trim().length > 0) || '作品名を入力してください。',
      guardDescription: 'owner と空欄でない作品名',
      reduce: (context) => ({ context: { ...context, project: 'synthetic-new-project', title: context.name.trim(), document: null } }),
    },
    { id: 'outline-back', from: outline, event: 'back', to: library },
  ].map((edge) => ({ source, ...edge })),
  render({ state, send }) {
    const { phase, screen, context } = state;
    if (screen === 'OUT-01') {
      return h('section', { class: 'reference-page' },
        button('作品一覧に戻る', () => send('back')),
        h('h2', {}, context.title),
        h('h3', {}, '構成'),
        context.document ? h('ol', {}, h('li', {}, '第一章　霧の朝')) : h('p', {}, '構成に文書がありません。'));
    }
    if (phase === 'create') {
      const name = h('input', {
        id: 'project-name', value: context.name, maxlength: 120, oninput: (event) => send('name', event.target.value, { paint: false }),
      });
      return h('section', { class: 'reference-page' },
        h('h2', {}, '新しい作品'),
        h('label', { for: 'project-name' }, '作品名'), name,
        h('div', { class: 'actions' },
          button('取消', () => send('cancel')),
          button('確認', () => confirmAction('作品を作成しますか？',
            name.value.trim() || '作品名を入力してください。', '作成', () => send('confirm')), { class: 'primary' })));
    }
    return h('section', { class: 'reference-page' }, h('h2', {}, '作品ライブラリ'),
      h('div', { class: 'library-item' },
        h('h3', {}, context.title),
        button('作品を開く', () => send('open'), { class: 'primary' })),
      button('作品を作成', () => send('create')));
  },
};
