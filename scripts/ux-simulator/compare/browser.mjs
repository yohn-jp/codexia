import { button, h } from '../dom.mjs';
import { compareDesign, compareVersions, maxBytes, validateOperand } from './model.mjs';

const labels = {
  observed: '実行観測あり', unobserved: '実行未観測', unextracted: '未抽出', unimplemented: '未実装',
  'implementation-only': '実装のみ', excluded: '対象外', proposal: '未採用', external: '外部境界', conceptual: '概念',
  added: '追加', removed: '削除', changed: '変更',
};

function summarize(record) {
  if (!record) return '—';
  return [record.label ?? record.title, record.role ?? record.form, record.route,
    record.from && record.to ? [record.from, record.event, record.to].filter(Boolean).join(' → ') : null,
    record.condition, record.reason].filter(Boolean).join(' · ') || record.id;
}

function ref(record, sha) {
  const source = record?.source;
  const path = source?.path;
  if (typeof path !== 'string' || !/^[\w./@+-]+$/.test(path) || !path.split('/').every((part) => part && part !== '.' && part !== '..')
    || !Number.isSafeInteger(source.line) || source.line < 1 || !/^[0-9a-f]{40}$/.test(sha ?? '')) return null;
  const destination = 'https://github.com/yohn-jp/codexia/blob/' + sha + '/' + path.split('/').map(encodeURIComponent).join('/') + '#L' + source.line;
  return h('a', { href: destination }, '根拠');
}

function item(record, sha) {
  return h('span', {}, summarize(record), ' ', ref(record, sha));
}

function routes(row, sha) {
  if (!row.designTransitions?.length && !row.implementationTransitions?.length) return null;
  const group = (title, edges) => [h('h4', {}, title),
    edges.length ? h('ol', {}, edges.map((edge) =>
      h('li', {}, item(edge, sha), edge.method === 'static' && h('small', {}, ' · 実行未観測'))))
      : h('p', {}, 'この項目に結び付く遷移はありません。')];
  return h('details', {}, h('summary', {}, '状態・遷移の根拠'),
    group('設計投影', row.designTransitions), group('実装投影', row.implementationTransitions));
}

function loadOperand(legend, available, onChange, verifiedSnapshot) {
  const status = h('p', { role: 'status' }, verifiedSnapshot ? 'このビルドの検証済み投影 · ' + verifiedSnapshot.sourceSha
    : available ? '検証済みのビルド入力を読み込み中' : '比較元は未取得です。');
  const manifest = h('input', { type: 'file', accept: '.json,application/json', 'aria-label': legend + ' の manifest.json' });
  const snapshot = h('input', { type: 'file', accept: '.json,application/json', 'aria-label': legend + ' の snapshot.json' });
  let generation = 0;
  async function accept(input, trusted) {
    const active = ++generation;
    onChange(null);
    try {
      const data = await input();
      if (!data) {
        if (active === generation) status.textContent = 'manifest.json と snapshot.json を選んでください。';
        return;
      }
      const value = await validateOperand(data);
      if (active !== generation) return;
      status.textContent = (trusted ? 'ビルドで確認済み' : 'ファイルの SHA と整合性を確認 · 配布元は未確認') + ' · ' + value.sourceSha;
      onChange(value);
    } catch {
      if (active === generation) status.textContent = '比較元を利用できません。版、形式、ダイジェストを確認してください。';
    }
  }
  const read = () => accept(async () => {
    const [manifestFile] = manifest.files;
    const [snapshotFile] = snapshot.files;
    if (!manifestFile || !snapshotFile) return null;
    if (manifestFile.size > maxBytes || snapshotFile.size > maxBytes) throw new Error('Artifact exceeds size limit');
    const [metadata, raw] = await Promise.all([manifestFile.text(), snapshotFile.text()]);
    return { manifest: JSON.parse(metadata), raw };
  }, false);
  manifest.addEventListener('change', read);
  snapshot.addEventListener('change', read);
  if (available) void accept(() => available, true);
  return h('fieldset', {}, h('legend', {}, legend), h('label', {}, 'manifest.json', manifest),
    h('label', {}, 'snapshot.json', snapshot), status);
}

export function renderCompare(root, { snapshot, left, right, rightSnapshot } = {}) {
  const filter = h('input', { type: 'search', 'aria-label': '比較結果の検索', placeholder: '画面 ID、操作 ID、観測状態' });
  const body = h('ul', { class: 'ux-compare-results ux-compare-list' });
  const resultStatus = h('p', { role: 'status', class: 'ux-compare-status' });
  const design = compareDesign(snapshot);
  let lhs;
  let rhs = rightSnapshot;
  let mode = 'design';
  const designButton = button('設計と実装', () => select('design'));
  const versions = button('2 版の差分', () => select('versions'));
  const sources = h('div', { class: 'ux-compare-inputs', hidden: true });
  sources.append(loadOperand('比較元', left, (value) => { lhs = value; paint(); }),
    loadOperand('比較先', right, (value) => { rhs = value; paint(); }, rightSnapshot));

  function select(next) {
    mode = next;
    sources.hidden = mode === 'design';
    designButton.setAttribute('aria-pressed', String(mode === 'design'));
    versions.setAttribute('aria-pressed', String(mode === 'versions'));
    paint();
  }

  function paint() {
    if (mode === 'versions' && (!lhs || !rhs)) {
      resultStatus.textContent = '版差分は利用できません。比較する 2 版の生成物を選択してください。';
      body.replaceChildren();
      return;
    }
    const search = filter.value.toLowerCase().trim();
    const rows = (mode === 'design' ? design : compareVersions(lhs, rhs))
      .filter((row) => [JSON.stringify(row), labels[row.status ?? row.change]].join(' ').toLowerCase().includes(search));
    resultStatus.textContent = rows.length ? String(rows.length) + ' 件'
      : mode === 'design' ? '検索条件に一致する項目がありません。' : '表示条件に該当する差分はありません。';
    body.replaceChildren(...rows.map((row) => {
      const left = mode === 'design' ? row.expected : row.before;
      const right = mode === 'design' ? row.observed : row.after;
      return h('li', {}, h('h3', {}, row.id), h('p', { class: 'ux-compare-status' },
        [row.platform, row.type, labels[row.status ?? row.change]].filter(Boolean).join(' · ')),
      row.reason && h('p', {}, row.reason),
      h('dl', {}, h('dt', {}, mode === 'design' ? '設計' : '比較元'),
        h('dd', {}, item(left, mode === 'design' ? snapshot.sourceSha : lhs.sourceSha)),
        h('dt', {}, mode === 'design' ? '実装' : '比較先'),
        h('dd', {}, item(right, mode === 'design' ? snapshot.sourceSha : rhs.sourceSha))),
      mode === 'design' && routes(row, snapshot.sourceSha));
    }));
  }

  filter.addEventListener('input', paint);
  root.append(h('h2', {}, '比較'), h('div', { class: 'actions' }, designButton, versions), sources,
    h('label', { class: 'ux-compare-search' }, '比較結果の検索', filter), resultStatus,
    body);
  select('design');
}
