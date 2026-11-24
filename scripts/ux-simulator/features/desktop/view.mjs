import { button, confirmAction, h } from '../../dom.mjs';
import { archiveFixture } from './library.mjs';

const labels = {
  outline: '構成', manuscript: '本文', reference: '参照', writing: 'Writing', research: 'Research', review: 'Review',
  split: '分割', tabs: 'タブ', narrow: '狭い', standard: '標準', wide: '広い',
  light: 'ライト', paper: '紙', dark: 'ダーク', horizontal: '横書き', vertical: '縦書き',
  volume: '巻', chapter: '章', scene: 'シーン',
};

const actions = (...items) => h('div', { class: 'actions' }, items);
const act = (send, event, label, value, primary = false) =>
  button(label, () => send(event, typeof value === 'function' ? value() : value), {
    class: primary ? 'primary' : '', 'data-focus-key': event + '-' + label,
  });
function named(label, input) {
  input.setAttribute('aria-label', label);
  return h('label', { class: 'desktop-field' }, h('span', {}, label), input);
}
const input = (value = '', options = {}) => h('input', { value, maxlength: 120, ...options });
const area = (value, options = {}) => h('textarea', { ...options }, value);
const select = (items, current) => h('select', {}, items.map((item) => {
  const [value, label] = Array.isArray(item) ? item : [item, labels[item] ?? item];
  return h('option', { value, selected: value === current }, label);
}));
const back = (send, event = 'back-editor', label = '本文に戻る') => act(send, event, label);
const info = (value) => h('p', { class: 'desktop-meta' }, value);
const manuscript = (content, orientation = 'horizontal') => h('div', { class: 'desktop-manuscript', 'data-orientation': orientation }, content);
const paragraph = (text) => h('p', {}, text);
const heading = (text) => h('h2', {}, text);

function confirm(send, event, label, title, body, value = 'confirm', cancel) {
  return button(label, () => confirmAction(title, body, label, () => send(event, typeof value === 'function' ? value() : value),
    cancel ? () => send(cancel) : undefined));
}

function libraryView(state, send) {
  const { context, phase } = state;
  if (phase === 'create') {
    const name = input(context.pendingName ?? '');
    return [heading('新しい作品'), named('作品名', name),
      actions(back(send, 'cancel', '取消'), confirm(send, 'confirm-project', '作品を作成', '新しい作品を作成しますか？',
        '作品ライブラリに追加します。', () => name.value))];
  }
  if (phase === 'import') {
    const raw = area(context.pendingImport ?? '', { rows: 7, maxlength: 16000 });
    return [heading('作品 JSON を取り込む'), named('合成アーカイブ JSON', raw),
      actions(button('サンプルを入力', () => { raw.value = archiveFixture; raw.focus(); }),
        back(send, 'cancel', '取消'), act(send, 'import-project', '検証して取り込む', () => raw.value, true))];
  }
  const previousProjects = Object.values(context.projects).filter(({ project }) => project !== context.project);
  return [heading('作品ライブラリ'), h('div', { class: 'desktop-list-item' }, h('h3', {}, context.title),
    context.documents.length ? info(context.documents.filter(({ kind }) => kind === 'scene').length + ' シーン') : info('構成が空です。'),
    actions(act(send, 'open-project', '作品を開く', undefined, true), act(send, 'resume-project', '続きから書く'))),
  ...previousProjects.map((project) => h('div', { class: 'desktop-list-item' }, h('h3', {}, project.title),
    act(send, 'open-project', project.title + 'を開く', project.project))),
  actions(act(send, 'create-project', '新しい作品'), act(send, 'import', 'JSON を取り込む'), act(send, 'export-project', 'JSON を書き出す')),
  context.archive && named('書き出した合成スナップショット', area(JSON.stringify(context.archive, null, 2), { readonly: true, rows: 4 })),
  context.archive && button('JSON をダウンロード', () => {
    const file = new Blob([JSON.stringify(context.archive, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(file);
    const download = h('a', { href: url, download: 'codexia-synthetic-archive.json' });
    document.body.append(download);
    download.click();
    download.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  })];
}

function outlineView({ context }, send) {
  const { documents } = context;
  const search = input(context.query, { type: 'search', 'data-focus-key': 'outline-search' });
  const kind = select(['volume', 'chapter', 'scene'], 'scene');
  const parents = [['', '親なし'], ...documents.filter(({ kind }) => kind !== 'scene').map(({ id, title }) => [id, title])];
  const parent = select(parents, documents.find(({ kind }) => kind === 'chapter')?.id);
  const title = input();
  const shown = documents.filter(({ title, kind }) =>
    (!context.query || title.includes(context.query)) && (context.outlineExpanded !== false || kind === 'volume'));
  return [heading('構成'), info(context.title),
    actions(back(send, 'back-library', '作品一覧に戻る'), context.document && back(send)),
    named('巻・章・シーンを検索', search), actions(act(send, 'filter-outline', '検索', () => search.value),
      act(send, 'expand-outline', context.outlineExpanded === false ? 'すべて展開' : '巻だけ表示'), act(send, 'outline-zoom', '構成を拡大・縮小')),
    shown.length ? h('ul', { class: 'desktop-outline', 'data-zoom': context.zoomOutline ? 'large' : 'normal' },
      shown.map((item) => {
        const name = input(item.title);
        const parent = select(parents, item.parent);
        const order = select([['same', 'そのまま'], ['first', '先頭'], ['last', '末尾']], 'same');
        return h('li', { 'data-kind': item.kind },
          item.kind === 'scene' ? act(send, 'open-document', item.title, item.id) : h('strong', {}, item.title),
          h('details', {}, h('summary', {}, '名前・親・順序／削除'),
            named('名前', name), named('親', parent), named('順序', order),
            actions(act(send, 'move-document', '構成の変更を保存', () => ({ id: item.id, title: name.value, parent: parent.value, order: order.value })),
              confirm(send, 'delete-document', '削除', item.title + ' を削除しますか？', '構成から外します。履歴は保持します。',
                () => ({ id: item.id, confirmed: true })))));
      })) : paragraph(context.query ? '検索条件に一致する項目がありません。' : '構成に項目がありません。'),
    h('details', {}, h('summary', {}, '巻・章・シーンを追加'),
      named('種類', kind), named('親', parent), named('名前', title),
      act(send, 'add-document', '追加する', () => ({ kind: kind.value, parent: parent.value, title: title.value })))];
}

function editorBox(context, send) {
  const editor = area(context.draft, {
    rows: 12, maxlength: 120000, 'data-focus-key': 'draft', 'data-font': context.font ?? 'normal', 'aria-label': '原稿本文',
  });
  let position = [...context.selection, context.scroll];
  const location = () => {
    const next = [editor.selectionStart, editor.selectionEnd, editor.scrollTop];
    if (next.every((value, index) => value === position[index])) return;
    position = next;
    send('position', next, { paint: false });
  };
  editor.addEventListener('input', () => { send('edit', editor.value, { paint: false }); location(); });
  editor.addEventListener('select', location);
  editor.addEventListener('pointerup', location);
  editor.addEventListener('keyup', location);
  editor.addEventListener('scroll', location);
  editor.addEventListener('compositionstart', () => send('composition-start', undefined, { paint: false }));
  editor.addEventListener('compositionend', () => send('composition-end', undefined, { paint: false }));
  editor.setSelectionRange(...context.selection);
  requestAnimationFrame(() => {
    editor.scrollTop = context.scroll;
    position = [editor.selectionStart, editor.selectionEnd, editor.scrollTop];
  });
  return editor;
}

function editorView(state, send) {
  const { context, phase } = state;
  const emit = send;
  let composing = context.composing;
  send = (event, input, options) => {
    if (event === 'composition-start') composing = true;
    if (event === 'composition-end') composing = false;
    const next = emit(event, input, options ?? (composing ? { paint: false } : undefined));
    if (composing && next.notice) {
      // Announce the guarded refusal without unmounting the composing textarea.
      document.querySelector('.ux-notice').textContent = next.notice;
    }
    return next;
  };
  const editor = editorBox(context, send);
  const title = context.documents.find(({ id }) => id === context.document)?.title ?? '原稿';
  const sections = {
    outline: h('aside', { class: 'desktop-subpanel', 'aria-label': '構成' }, h('h3', {}, '構成'), paragraph(context.title),
      act(send, 'outline', '構成を開く')),
    manuscript: h('div', { class: 'desktop-work', 'data-panel': 'manuscript' },
      editor, info('Revision ' + context.revision + ' · ' + (context.journal === 'protected' ? '下書き保護済み' : '下書き保護が必要')),
      actions(act(send, 'protect', '下書きを保護'),
        phase === 'submitting' ? act(send, 'response', '保存結果を確認', undefined, true) : act(send, 'save', '保存', undefined, true))),
    reference: h('aside', { class: 'desktop-subpanel', 'aria-label': '参照' }, h('h3', {}, '参照'),
      act(send, 'knowledge', '知識を開く'), act(send, 'review', '提案を開く')),
  };
  const visible = context.layout.order.filter((panel) => !context.layout.hidden.includes(panel));
  const shown = state.phase === 'submitting' ? ['manuscript'] : visible;
  const workspace = context.layout.arrangement === 'tabs' && state.phase !== 'submitting'
    ? h('div', { class: 'desktop-workspace-tabbed' },
      shown.map((name) => h('details', { open: name === 'manuscript', name: 'workspace-panels' }, h('summary', {}, labels[name]), sections[name])))
    : h('div', { class: 'desktop-workspace', 'data-width': context.layout.width }, shown.map((name) => sections[name]));
  const links = phase === 'submitting' ? [] : [
    act(send, 'outline', '構成'), act(send, 'reading', '読む'), act(send, 'history', 'Revision 履歴'),
    act(send, 'anchor', '選択範囲を根拠に登録'), act(send, 'editor-style', '文字サイズ'),
    act(send, 'modules', 'モジュール'), act(send, 'jobs', '受信箱'), act(send, 'display', '表示設定'), act(send, 'preferences', '本人設定'),
    context.evidenceVisit && act(send, 'back-evidence', '参照元に戻る'),
  ];
  return [heading(title), info(context.title + ' / 執筆'), links.length > 0 && actions(links), workspace];
}

function historyView({ context }, send) {
  const item = context.revisionHistory.find(({ id }) => id === context.comparedRevision);
  return [heading('Revision 履歴'), back(send),
    actions(context.revisionHistory.map(({ id }) => act(send, 'revision', 'Revision ' + id + ' を比較', id))),
    item ? h('div', { class: 'desktop-diff' },
      h('div', {}, h('h3', {}, '比較 Revision ' + item.id), manuscript(item.text)),
      h('div', {}, h('h3', {}, '現在 Revision ' + context.revision), manuscript(context.committed))) : paragraph('比較する版を選んでください。'),
    item && confirm(send, 'restore', 'この版を復元', '新しい Revision として復元しますか？', '現在の確定版も履歴に保持します。')];
}

function recoveryView({ context }, send) {
  const unlock = context.failure === 'unauthorized';
  const conflict = context.failure === 'conflict';
  return [heading('原稿の復旧'), info('Revision ' + context.revision + (context.operation ? ' / ' + context.operation : '')),
    !unlock && editorBox(context, send),
    conflict && h('div', { class: 'desktop-diff' },
      h('div', {}, h('h3', {}, 'あなたの下書き'), manuscript(context.draft)),
      h('div', {}, h('h3', {}, '確定版'), manuscript('確定版には霧の記録が残った。'))),
    actions(
      unlock && act(send, 'reauthenticate', '同じ作者として再認証'),
      !unlock && context.inFlight && !conflict && act(send, 'reconcile', '同じ操作を照合', undefined, true),
      !context.inFlight && act(send, 'protect', '下書きを再保護', undefined, true),
      conflict && context.journal !== 'protected' && act(send, 'protect-conflict', '競合中の下書きを保護'),
      conflict && act(send, 'rebase-draft', '下書きを保って再保存', undefined, true),
      conflict && confirm(send, 'discard-draft', '下書きを破棄', '下書きを破棄しますか？', '比較した確定版を開きます。'),
      !context.inFlight && back(send, 'return-to-editor'))];
}

function readerView({ context }, send) {
  return [heading('読書'), actions(back(send, 'back-editor', '編集に戻る'), act(send, 'reader-page', 'ページを切り替え'),
    act(send, 'reader-orientation', '縦書き・横書き'), act(send, 'reader-reference', '根拠を参照')),
    info(context.title + ' · Revision ' + context.revision + ' · ' + (context.readerPage ?? 1) + ' ページ'),
    manuscript(context.committed, context.typesetting)];
}

function knowledgeView({ context }, send) {
  const query = input(context.query, { type: 'search' });
  const name = input(context.pendingNode?.name ?? '');
  const matches = context.node && (!context.query || context.node.name.includes(context.query));
  return [heading('知識'), back(send), named('候補を検索', query),
    actions(act(send, 'search-knowledge', '検索', () => query.value), act(send, 'more-knowledge', '追加読込')),
    matches ? act(send, 'open-node', context.node.name) : paragraph('検索条件に一致する候補がありません。'),
    named('新しい候補名', name), act(send, 'save-node', '候補を確定', () => name.value, true)];
}

function evidenceView({ context }, send) {
  const relation = input(context.node?.relation ?? '');
  return [heading(context.node?.name ?? '根拠'), info('参照 Revision ' + (context.anchor?.revision ?? context.node?.revision ?? '—')),
    context.anchor && manuscript(context.anchor.quote),
    actions(back(send, 'back-knowledge', '知識一覧に戻る'), back(send, 'back-reading', '読書に戻る'),
      act(send, 'open-evidence', '原稿の該当箇所を開く', undefined, true)),
    named('関係・記述', relation), actions(act(send, 'change-relation', '関係を更新', () => relation.value),
      act(send, 'merge-preview', '知識統合をプレビュー')),
    context.merge && h('section', { class: 'desktop-list-item' }, h('h3', {}, '統合プレビュー'),
      paragraph('灯台の関係と根拠を一つのノードへ統合します。'),
      actions(act(send, 'cancel-merge', '取消'), confirm(send, 'merge-node', '統合する', '知識を統合しますか？', '同じ版の統合プレビューを適用します。'))),
    context.mergeReceipt && info(context.mergeReceipt)];
}

function reviewView({ context, screen }, send) {
  if (screen === 'REV-01') {
    return [heading('提案・ChangeSet'), back(send), context.proposalHidden
      ? act(send, 'show-proposal', '非表示を解除')
      : act(send, 'open-proposal', '灯台の描写を確認', undefined, true)];
  }
  const title = context.proposalKind === 'publish' ? '読者リンクの発行'
    : context.proposalKind === 'revoke' ? '読者リンクの失効' : '灯台の描写';
  return [heading(title), info('提案状態: ' + context.proposal),
    h('div', { class: 'desktop-diff' }, h('div', {}, h('h3', {}, '変更前'), manuscript(context.proposalTarget?.before ?? context.committed)),
      h('div', {}, h('h3', {}, '変更後'), manuscript(context.proposalTarget?.after ?? ('対象 ' + (context.proposalTarget?.scope ?? '—'))))),
    actions(act(send, 'approve', '作者として承認'), confirm(send, 'reject', '提案を却下', '提案を却下しますか？', '提案の状態を更新します。'),
      act(send, 'apply', '承認した提案を適用', undefined, true), context.pendingApply && act(send, 'reconcile-application', '適用結果を照合')),
    actions(back(send, 'back-review', '提案一覧に戻る'), context.proposalKind && back(send, 'back-publishing', 'Publishing に戻る'),
      context.proposal === 'applied' && back(send, 'open-applied-document', '反映先の原稿を開く'), act(send, 'hide-proposal', '一覧から非表示'))];
}

function moduleView({ context, phase }, send) {
  if (phase === 'publishing') {
    const scope = select([['', '巻・章・シーンを選ぶ'], ...context.documents.map(({ id, title }) => [id, title])], context.scope ?? '');
    scope.addEventListener('change', () => send('publishing-scope', scope.value));
    const format = select([['epub', 'EPUB'], ['text', 'テキスト'], ['print', '縦書きプレビュー']], 'text');
    const hours = select([['1', '1時間'], ['24', '24時間'], ['72', '72時間']], '24');
    return [heading('Publishing'), back(send, 'back-modules', 'モジュールに戻る'), named('出力・共有範囲', scope),
      named('書き出し形式', format), act(send, 'publishing-export', '保存済み本文を準備', () => format.value),
      context.preview && manuscript(context.preview.text || '本文がありません。', context.preview.format === 'print' ? 'vertical' : 'horizontal'),
      h('h3', {}, '読者リンク'), info('状態: ' + context.shared),
      context.shareUnknown && info('発行結果を確認できません。一覧と提案を確認するまで配布しないでください。'),
      context.shareUnknown && act(send, 'reconcile-share', '同じ発行操作を照合'),
      named('有効時間', hours),
      actions(act(send, 'propose-share', '読者リンク発行を提案', () => hours.value),
        context.shared === 'published' && act(send, 'open-reader', '公開リーダーを開く'),
        context.shared === 'published' && act(send, 'propose-revoke', 'リンクの失効を提案'))];
  }
  return [heading('モジュール'), back(send), info(context.moduleEnabled ? '任意モジュールを利用できます。' : '任意モジュールは無効です。本文には戻れます。'),
    actions(act(send, 'toggle-module', context.moduleEnabled ? '無効にする' : '有効にする'),
      act(send, 'module-action', '参照を取得', 'read'), act(send, 'module-action', '分析を実行', 'compute'),
      act(send, 'module-job', '背景ジョブを開始'), act(send, 'publishing', 'Publishing を開く')),
    context.moduleResult && info(context.moduleResult.action + ' · Revision ' + context.moduleResult.revision)];
}

function displayView({ context }, send) {
  const { layout } = context;
  const preset = select(['writing', 'research', 'review'], layout.preset);
  const panel = select(['outline', 'manuscript', 'reference'], layout.order[0]);
  const hiddenPanel = select(['outline', 'reference'], 'reference');
  const arrangement = select(['split', 'tabs'], layout.arrangement);
  const width = select(['narrow', 'standard', 'wide'], layout.width);
  const theme = select(['light', 'paper', 'dark'], context.theme);
  const orientation = select(['horizontal', 'vertical'], context.typesetting);
  const change = (control, event, label) => [named(label, control), act(send, event, '選択を適用', () => control.value)];
  return [heading('表示と Workspace'), back(send),
    layout.status === 'fallback' && info('利用可能な初期配置を表示しています。前の設定は保持しています。'),
    h('p', {}, layout.order.filter((key) => !layout.hidden.includes(key)).map((key) => labels[key]).join(' / ')),
    h('div', { class: 'desktop-settings' },
      change(preset, 'preset', '初期配置'), [named('配置順を変えるパネル', panel), act(send, 'move-panel', '先頭へ移動', () => panel.value)],
      [named('表示・非表示にする補助パネル', hiddenPanel), act(send, 'toggle-panel', '表示を切り替え', () => hiddenPanel.value)],
      change(arrangement, 'arrange', '配置方法'), change(width, 'resize-panel', '本文パネル幅'), change(theme, 'theme', 'テーマ'),
      change(orientation, 'orientation', '組版')),
    actions(act(send, 'save-layout', 'この表示設定を保存', undefined, true))];
}

const views = {
  'ENTRY-01': ({ context }, send) => [heading('執筆を始める'), paragraph('合成ワークスペースで作品を開きます。'),
    actions(act(send, 'launch', 'Desktop Web を起動', undefined, true),
      context.principal === 'OWNER-API' && act(send, 'resume-session', '確認済みの合成セッションを開く'))],
  'LIB-01': libraryView, 'OUT-01': outlineView, 'WRT-01': editorView, 'READ-01': readerView,
  'WRT-02': historyView, 'REC-01': recoveryView, 'KNO-01': knowledgeView, 'KNO-02': evidenceView,
  'REV-01': reviewView, 'REV-02': reviewView, 'TOOL-01': moduleView, 'DISPLAY-01': displayView,
  'JOB-01': ({ context }, send) => [heading('受信箱・ジョブ履歴'), info(context.unread ? '未読の通知があります。' : '通知は既読です。'),
    info(context.run ? context.run + ' · ' + context.jobState : '背景ジョブはありません。'),
    actions(act(send, 'refresh-jobs', '再取得'), act(send, 'read-notification', '既読にする'),
      context.jobReturn && back(send, 'back-modules', 'モジュールに戻る'), back(send, 'back-editor', '受信箱を閉じる'))],
  'PREF-01': (_state, send) => [heading('本人設定'), back(send),
    paragraph('Passkey とセッションは管理コンソールで確認します。'), act(send, 'security', 'セキュリティ設定を開く', undefined, true)],
};

export function render({ state, send }) {
  if (!document.querySelector('#desktop-simulator-css')) {
    document.head.append(h('link', { id: 'desktop-simulator-css', rel: 'stylesheet', href: new URL('./style.css', import.meta.url).href }));
  }
  return h('section', { class: 'desktop-surface', 'data-theme': state.context.theme, 'aria-label': 'Desktop Workspace' },
    views[state.screen](state, send));
}
