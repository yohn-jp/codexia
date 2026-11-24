import { compare, features, snapshot } from './build.mjs';
import { button, h } from './dom.mjs';
import { dispatch, inject, replay, responses, share, start, trace } from './model.mjs';

const root = document.querySelector('#simulator');
const sha = snapshot.sourceSha;
const labels = { 'legacy-mobile-web': '旧 Mobile Web', desktop: 'Desktop Web', ios: 'Native iOS', auth: 'ログイン・同意', console: '管理コンソール', reader: '公開リーダー' };
const responseLabels = {
  cancelled: '取消', forbidden: '権限拒否', unauthorized: '認証失効', 'not-found': '対象なし', conflict: '競合',
  stale: '古い応答', timeout: '結果不明', offline: '接続断', quota: '容量超過', invalid: '入力不正', unavailable: '利用不可',
};
const contract = 'docs/design/UX-SIMULATOR-CONTRACT.md';
const main = h('section', { class: 'ux-player', 'aria-label': '操作画面', tabindex: '-1' });
const player = h('div', { class: 'ux-stage' });
const notice = h('p', { class: 'ux-notice', role: 'status' });
main.append(notice, player);
const inspectorBody = h('div');
const inspector = h('details', { class: 'ux-inspector', open: matchMedia('(min-width: 1100px)').matches },
  h('summary', {}, 'インスペクター'), inspectorBody);
const catalogBody = h('div');
const catalog = h('details', { class: 'ux-catalog', open: matchMedia('(min-width: 900px)').matches },
  h('summary', {}, '画面・シナリオ'), catalogBody);
const comparison = h('section', { class: 'ux-comparison', hidden: true, 'aria-label': '版比較' });
const layout = h('div', { class: 'ux-layout' }, catalog, main, inspector);
const compareTab = button('版比較', () => tab(true), { 'aria-pressed': 'false' });
const playTab = button('シミュレーション', () => tab(false), { 'aria-pressed': 'true' });
root.append(h('nav', { class: 'ux-tabs', 'aria-label': 'UX Simulator' }, playTab, compareTab), layout, comparison);

let state;
let problem = '';
let compared = false;

function tab(wantsCompare) {
  layout.hidden = wantsCompare;
  comparison.hidden = !wantsCompare;
  compareTab.setAttribute('aria-pressed', String(wantsCompare));
  playTab.setAttribute('aria-pressed', String(!wantsCompare));
  if (wantsCompare && !compared) {
    compared = true;
    if (compare) compare(comparison);
    else comparison.append(h('h2', {}, '版比較'), h('p', {}, 'この生成物では比較を利用できません。'));
  }
}

function sourceLink(source, label) {
  const [path, anchor] = source.split('#');
  return h('a', { href: 'https://github.com/yohn-jp/codexia/blob/' + sha + '/' + path
    + (anchor ? '#' + encodeURIComponent(anchor) : '') }, label);
}

function openScenario(scenario, checkpoint = 'start') {
  state = start(features, scenario.platform, scenario.id, scenario.fixture, checkpoint);
  problem = '';
  const query = share(state, sha);
  if (location.search !== query) history.pushState(null, '', query);
  if (matchMedia('(max-width: 899px)').matches) catalog.open = false;
  paint();
  main.focus();
}

function restore() {
  state = null;
  problem = '';
  try {
    if (location.search) state = replay(location.search, sha, features);
    else if (snapshot.scenarios.length) {
      const first = snapshot.scenarios[0];
      state = start(features, first.platform, first.id, first.fixture, 'start');
    }
  } catch (error) {
    problem = error.message;
  }
  paint();
}

function send(event, value, { paint: repaint = true } = {}) {
  const old = state;
  state = dispatch(state, event, value);
  if (repaint) {
    const active = document.activeElement;
    const inPlayer = player.contains(active);
    const focusKey = active?.dataset?.focusKey;
    const label = active?.tagName === 'BUTTON' && active.textContent;
    paint();
    const matching = [...player.querySelectorAll('button, [data-focus-key]')].find((node) =>
      (focusKey && node.dataset.focusKey === focusKey) || (old.at === state.at && label && node.textContent === label));
    if (matching && inPlayer) matching.focus();
    else if (inPlayer || old.at !== state.at) (player.querySelector('h2') ?? main).focus();
  } else paintInspector();
  return state;
}

function paint() {
  notice.textContent = problem || state?.notice || '';
  if (!state) {
    player.replaceChildren(h('p', {}, problem ? '画面・シナリオから開始状態を選んでください。' : '利用可能なシナリオがありません。'));
    delete player.dataset.platform;
    delete player.dataset.screen;
    delete player.dataset.phase;
  } else {
    player.dataset.platform = state.platform;
    player.dataset.screen = state.screen;
    player.dataset.phase = state.phase;
    const rendered = state.feature.render({ state, send });
    (rendered.matches('h2') ? rendered : rendered.querySelector('h2'))?.setAttribute('tabindex', '-1');
    player.replaceChildren(rendered);
  }
  paintInspector();
}

function readout() {
  const fields = ['principal', 'project', 'document', 'revision', 'selection', 'scroll', 'navigationGeneration', 'operation', 'receipt', 'run', 'journal'];
  return h('dl', { class: 'ux-state' },
    h('dt', {}, '画面 / 状態'), h('dd', {}, state.at),
    h('dt', {}, '開始方法'), h('dd', {}, state.entry === 'direct' ? '状態を直接表示' : 'シナリオの最初から'),
    ...fields.flatMap((field) => {
      const value = state.context[field];
      return value === undefined || value === null ? [] : [h('dt', {}, field), h('dd', {}, JSON.stringify(value))];
    }));
}

function paintInspector() {
  if (!state) {
    inspectorBody.replaceChildren(h('p', {}, 'シナリオを選択すると操作履歴を表示します。'));
    return;
  }
  const source = snapshot.screens.find(({ id }) => id === state.screen);
  const options = h('select', { id: 'synthetic-response' },
    h('option', { value: '' }, '合成応答を選択'),
    responses.map((response) => h('option', { value: response, selected: state.pending === response }, responseLabels[response])));
  const historyList = h('ol', { class: 'ux-history' }, state.history.slice(-30).reverse().map(
    ({ event, transition, outcome, from, to, guard, response, source }) =>
      h('li', {}, h('strong', {}, event), h('div', {}, from + ' → ' + to), h('small', {},
        [outcome, response, guard].filter(Boolean).join(' · ')), source && h('div', {}, sourceLink(source, transition)))));
  inspectorBody.replaceChildren(
    readout(),
    h('p', {}, source && sourceLink(source.source, '画面の正本'), source?.atlas && ' · ',
      source?.atlas && sourceLink(source.atlas, '状態遷移図')),
    h('label', { for: 'synthetic-response' }, '次の合成応答'), options,
    button('応答を予約', () => {
      if (!options.value) return;
      state = inject(state, options.value);
      notice.textContent = '次の外部作用への応答: ' + responseLabels[state.pending];
    }),
    h('div', { class: 'actions ux-inspector-actions' },
      button('リセット', () => { restoreFromStart(); main.focus(); }),
      button('再現リンクを表示', () => showExport('再現リンク', location.origin + location.pathname + share(state, sha))),
      button('合成トレースを表示', () => showExport('合成トレース', JSON.stringify(trace(state, sha), null, 2)))),
    h('h3', {}, '操作履歴'), state.history.length ? historyList : h('p', {}, '操作はまだありません。'));
}

function restoreFromStart() {
  const { platform, scenario, fixture, checkpoint } = state.origin;
  state = start(features, platform, scenario, fixture, checkpoint);
  paint();
}

function showExport(label, value) {
  const dialog = h('dialog', { 'aria-label': label });
  const output = h('textarea', { readonly: true, 'aria-label': label, rows: 6, autofocus: true }, value);
  dialog.append(h('h2', {}, label), output, h('div', { class: 'actions' },
    button('コピー', async () => {
      output.select();
      try {
        await navigator.clipboard.writeText(value);
        output.setAttribute('aria-label', label + '（コピー済み）');
      } catch {
        output.focus();
      }
    }), button('閉じる', () => dialog.close())));
  document.body.append(dialog);
  dialog.addEventListener('close', () => dialog.remove(), { once: true });
  dialog.showModal();
}

const search = h('input', { id: 'catalog-search', type: 'search', placeholder: '画面、操作、権限、正常・異常' });
const platform = h('select', { id: 'catalog-platform' }, h('option', { value: '' }, 'すべてのプラットフォーム'),
  Object.entries(labels).map(([id, label]) => h('option', { value: id }, label)));
const catalogResults = h('div', { class: 'ux-catalog-results' });
catalogBody.append(h('label', { for: 'catalog-search' }, 'カタログ検索'), search,
  h('label', { for: 'catalog-platform' }, 'プラットフォーム'), platform, catalogResults);
search.addEventListener('input', paintCatalog);
platform.addEventListener('change', paintCatalog);

function matches(record, terms) {
  return terms.every((term) => JSON.stringify(record).toLowerCase().includes(term));
}

function paintCatalog() {
  const terms = search.value.toLowerCase().trim().split(/\s+/).filter(Boolean);
  const show = (record) => (!platform.value || record.platform === platform.value || record.platforms?.includes(platform.value))
    && matches(record, terms);
  const scenarios = snapshot.scenarios.filter((scenario) => show({
    ...scenario, kind: scenario.kind === 'failure' ? '異常 障害 failure' : '正常 normal', platformLabel: labels[scenario.platform],
  }));
  const screens = snapshot.screens.filter((screen) => matches({
    ...screen, controls: snapshot.controls.filter(({ screen: id }) => id === screen.id),
    coverage: snapshot.coverage.filter(({ id }) => id === screen.id),
  }, terms));
  const relevant = (id) => snapshot.coverage.filter(({ id: entryId, platform: rowPlatform, status }) =>
    entryId === id && (platform.value ? rowPlatform === platform.value : status !== 'excluded'));
  const statusLabel = (entry) => [labels[entry.platform], entry.status === 'mapped' ? '設計対応あり' : entry.reason].filter(Boolean).join(' · ');
  const rows = screens.map((screen) => {
    const coverage = relevant(screen.id);
    return h('details', { class: 'ux-screen-details' }, h('summary', {}, screen.id + ' · ' + screen.purpose),
      h('p', {}, screen.principal ?? ''),
      ...coverage.map((entry) => h('p', {}, statusLabel(entry))),
      h('ul', {}, snapshot.controls.filter(({ screen: id }) => id === screen.id).map(({ id, label }) =>
        h('li', {}, id + ' ' + label, relevant(id).map((entry) => h('small', { class: 'ux-coverage-label' }, statusLabel(entry)))))),
      sourceLink(screen.source, '設計正本'));
  });
  catalogResults.replaceChildren(
    h('h2', {}, 'シナリオ'),
    scenarios.length ? h('ul', { class: 'ux-scenarios' }, scenarios.map((scenario) => {
      const checkpoints = Object.entries(scenario.checkpoints).filter(([id]) => id !== 'start');
      return h('li', {},
        button(scenario.label, () => openScenario(scenario)),
        h('small', {}, labels[scenario.platform] + ' · ' + (scenario.kind === 'failure' ? '異常系' : '正常系')),
        checkpoints.length > 0 && h('details', {}, h('summary', {}, '直接表示'), checkpoints.map(([id, checkpoint]) =>
          button(checkpoint.at, () => openScenario(scenario, id)))));
    })) : h('p', {}, '一致するシナリオはありません。'),
    h('h2', {}, '設計カタログ'),
    h('p', { class: 'ux-source' }, snapshot.coverage.some(({ status }) => status === 'missing')
      ? '未対応の画面・操作があります（partial）。' : '設計対応表。操作試験の結果は別途確認します。'),
    rows.length ? rows : h('p', {}, '一致する画面・操作はありません。'),
    h('p', { class: 'ux-source' }, sourceLink(contract, 'Simulator の設計正本')));
}

paintCatalog();
restore();
window.addEventListener('popstate', restore);
