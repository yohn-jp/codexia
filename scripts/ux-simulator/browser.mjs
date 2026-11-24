import { compare, comparisonBase, snapshot } from './build.mjs';
import { button, h } from './dom.mjs';
import { back, begin, choices, replay, share, step, trace, visit } from './model.mjs';

const root = document.querySelector('#simulator');
const labels = { desktop: 'Desktop Web', ios: 'Native iOS', auth: 'ログイン・同意', console: '管理コンソール',
  reader: '公開リーダー', 'legacy-mobile-web': '旧 Mobile Web' };
const modeLabels = { expected: '設計投影', observed: '実装投影' };
const statusLabels = {
  observed: '実行観測あり', unobserved: '実行未観測', unextracted: '未抽出', unimplemented: '未実装',
  'implementation-only': '実装のみ', excluded: '対象外', proposal: '未採用', external: '外部境界', conceptual: '概念',
};
const notice = h('p', { class: 'ux-notice', role: 'status' });
const stage = h('section', { class: 'ux-stage', 'aria-label': '画面と遷移' });
const main = h('section', { class: 'ux-player', 'aria-label': '操作画面', tabindex: '-1' }, notice, stage);
const inspectorBody = h('div');
const inspector = h('details', { class: 'ux-inspector', open: matchMedia('(min-width: 1100px)').matches },
  h('summary', {}, 'インスペクター'), inspectorBody);
const catalogBody = h('div');
const catalog = h('details', { class: 'ux-catalog', open: matchMedia('(min-width: 900px)').matches },
  h('summary', {}, '画面・シナリオ'), catalogBody);
const comparePanel = h('section', { class: 'ux-comparison', hidden: true, 'aria-label': '版比較' });
const layout = h('div', { class: 'ux-layout' }, catalog, main, inspector);
const compareTab = button('比較', () => showCompare(true), { 'aria-pressed': 'false' });
const playTab = button('探索', () => showCompare(false), { 'aria-pressed': 'true' });
root.append(h('nav', { class: 'ux-tabs', 'aria-label': 'UX Simulator' }, playTab, compareTab), layout, comparePanel);

let state;
let problem = '';
let compared = false;
let selectedControl;
let activeMode = 'expected';

function ref(location, label = '根拠') {
  if (!location) return null;
  const path = location.path.split('/').map(encodeURIComponent).join('/');
  const anchor = location.anchor ? '#' + encodeURIComponent(location.anchor) : '#L' + location.line;
  return h('a', { href: 'https://github.com/yohn-jp/codexia/blob/' + snapshot.sourceSha + '/' + path + anchor }, label);
}

function showCompare(active) {
  layout.hidden = active;
  comparePanel.hidden = !active;
  playTab.setAttribute('aria-pressed', String(!active));
  compareTab.setAttribute('aria-pressed', String(active));
  if (!active || compared) return;
  compared = true;
  if (compare) compare(comparePanel, { snapshot, left: comparisonBase, rightSnapshot: comparisonBase ? snapshot : null });
  else comparePanel.append(h('h2', {}, '比較'), h('p', {}, 'この生成物には比較の提供データがありません。'));
}

function open(projection, platform, scenario, checkpoint = 'start') {
  try {
    state = begin(snapshot, projection, platform, scenario, checkpoint);
    const url = share(state);
    if (url !== location.search) history.pushState(null, '', url);
    activeMode = projection;
  } catch (error) {
    state = null;
    problem = error.message;
    paint();
    return;
  }
  problem = '';
  selectedControl = null;
  if (matchMedia('(max-width: 899px)').matches) catalog.open = false;
  paint();
  main.focus();
}

function restore() {
  state = null;
  selectedControl = null;
  problem = '';
  try {
    state = location.search ? replay(snapshot, location.search)
      : begin(snapshot, 'expected', 'desktop', snapshot.expected.scenarios[0].id, 'start');
    activeMode = state.projection;
  } catch (error) {
    problem = error.message;
  }
  paint();
}

function changeMode(projection) {
  if (activeMode === projection) return;
  const platform = state?.platform ?? 'desktop';
  const screen = current()?.screen ?? scenario()?.screens[0];
  const candidates = snapshot[projection].scenarios.filter(({ platforms }) => platforms.includes(platform));
  const next = candidates.find(({ screens }) => screens.includes(screen)) ?? (!screen ? candidates[0] : null);
  if (next) {
    open(projection, platform, next.id);
  } else {
    activeMode = projection;
    problem = 'この画面の' + modeLabels[projection] + 'は利用できません。カタログで対応状況を確認できます。';
    state = null;
    selectedControl = null;
    paint();
  }
}

function scenario() {
  return state.snapshot[state.projection].scenarios.find(({ id, platforms }) => id === state.scenario && platforms.includes(state.platform));
}

function current() {
  if (!state) return null;
  return snapshot[state.projection].states.find(({ id, platform }) => id === state.at && (!platform || platform === state.platform));
}

function apply(next) {
  state = next;
  problem = '';
  selectedControl = null;
  paintStage();
  paintInspector();
  (stage.querySelector('[data-current-state]') ?? main).focus();
}

function memberFields(screen) {
  if (state.projection === 'observed') return screen?.regions ?? [];
  const form = screen?.form ?? 'page';
  return [{ id: 'layout', role: form, label: screen?.title ?? '画面領域' }];
}

function screenControls(id) {
  if (!state || !id) return [];
  return snapshot[state.projection].controls.filter(({ screen, id: control, platforms, platform }) =>
    (screen ?? control.split('.')[0]) === id && (platform === state.platform || platforms?.includes(state.platform)));
}

function paintStage() {
  notice.textContent = problem || state?.notice || '';
  if (!state) {
    for (const key of ['screen', 'platform', 'projection']) delete stage.dataset[key];
    stage.replaceChildren(h('p', {}, 'カタログから画面・経路を選択してください。'));
    return;
  }
  const item = current();
  const flow = scenario();
  const graph = snapshot[state.projection];
  const screenId = item?.screen ?? flow.screens[0];
  const screen = graph.screens.find(({ id, platform }) => id === screenId && (!platform || platform === state.platform));
  const variant = screen?.form ?? 'page';
  const menu = choices(state);
  const linked = item?.linkedScreen && snapshot.expected.scenarios.find(({ id, screens }) =>
    id !== flow.id && screens.includes(item.linkedScreen));
  stage.dataset.platform = state.platform;
  stage.dataset.screen = screenId ?? '';
  stage.dataset.projection = state.projection;
  const heading = h('h2', { tabindex: '-1', 'data-current-state': true }, item?.label ?? state.at);
  const graphStates = state.projection === 'expected'
    ? graph.states.filter(({ id, platforms }) => id.startsWith(flow.id + '/') && (!platforms || platforms.includes(state.platform)))
    : graph.states.filter(({ id, platform, screen }) => platform === state.platform && (screen === screenId || id === state.at));
  stage.replaceChildren(
    h('p', { class: 'ux-source' }, [labels[state.platform], modeLabels[state.projection], flow.label].join(' · ')),
    h('div', { class: 'ux-wireframe', 'data-form': variant },
      heading,
      memberFields(screen).map((region) => h('section', { class: 'ux-region' },
        h('h3', {}, region.label ?? region.id), h('small', {}, region.role ?? '領域'))),
      screenControls(screenId).length > 0 && h('details', { class: 'ux-control-list' }, h('summary', {}, '操作仕様'),
        h('ul', {}, screenControls(screenId).map((control) => h('li', {},
          button(control.id + '　' + (control.label ?? control.role ?? ''), () => {
            selectedControl = control;
            paintInspector();
            inspector.open = true;
          })))))),
    h('h3', {}, '選べる操作・分岐'),
    menu.length ? h('ol', { class: 'ux-branches' }, menu.map((edge) => h('li', {},
      button(edge.event ?? edge.id, () => apply(step(state, edge.id))), h('small', {}, edge.method === 'static' ? '静的結線 · 実行未観測'
        : edge.method === 'trace' ? '実行証拠あり' : '設計正本'))))
      : h('p', {}, state.projection === 'expected' ? 'この図の終端です。' : 'この位置から辿れる正規ソースの遷移がありません。'),
    h('div', { class: 'actions' },
      button('一つ戻る', () => apply(back(state)), { disabled: !state.stack.length }),
      linked && button('参照先 ' + item.linkedScreen + ' の図', () =>
        apply(visit(state, linked.platforms.includes(state.platform) ? state.platform : linked.platforms[0], linked.id)))),
    linked && !linked.platforms.includes(state.platform) && h('p', { class: 'ux-source' },
      '外部画面の根拠を参照 · ' + labels[linked.platforms[0]]),
    h('details', { class: 'ux-route-map' }, h('summary', {}, '遷移の全体図'),
      h('ul', {}, graphStates.map((node) => {
        const outgoing = graph.transitions.filter(({ from, platform }) => from === node.id && (!platform || platform === state.platform));
        return h('li', { 'aria-current': node.id === state.at ? 'step' : null }, h('strong', {}, node.label),
          outgoing.length ? h('span', {}, ' → ' + outgoing.map(({ to }) =>
            graphStates.find(({ id }) => id === to)?.label ?? to).join(' / ')) : null);
      }))));
}

function readout() {
  const item = current();
  const flow = scenario();
  const selected = state.snapshot[state.projection].transitions.find(({ id }) => id === state.history.at(-1)?.edge);
  return h('dl', { class: 'ux-state' },
    h('dt', {}, '投影'), h('dd', {}, modeLabels[state.projection]),
    h('dt', {}, '開始方法'), h('dd', {}, state.entry === 'direct' ? '直接表示' : '経路の入口'),
    h('dt', {}, '位置'), h('dd', {}, state.at),
    h('dt', {}, '操作数'), h('dd', {}, state.history.filter(({ edge }) => edge).length),
    h('dt', {}, '条件・結果'), h('dd', {}, selected?.condition ?? '根拠が明示する場合のみ表示'),
    h('dt', {}, '根拠'), h('dd', {}, ref(item?.source ?? flow.source)),
    selected?.evidence && h('dt', {}, '実行試験'),
    selected?.evidence && h('dd', {}, ref(selected.evidence.expectation, '正規試験の期待値')),
    selected?.context?.operationId && h('dt', {}, '操作 ID'),
    selected?.context?.operationId && h('dd', {}, selected.context.operationId),
    selected?.context?.receiptId && h('dt', {}, 'Receipt ID'),
    selected?.context?.receiptId && h('dd', {}, selected.context.receiptId),
  );
}

function paintInspector() {
  if (!state) {
    inspectorBody.replaceChildren(h('p', {}, 'カタログから経路を選んでください。'));
    return;
  }
  inspectorBody.replaceChildren(
    readout(),
    selectedControl && h('section', { class: 'ux-selected-control' }, h('h3', {}, selectedControl.id),
      h('p', {}, selectedControl.label), h('p', {}, selectedControl.prerequisite ?? selectedControl.handler ?? '条件未抽出'),
      selectedControl.success && h('p', {}, '正常経路　' + selectedControl.success),
      selectedControl.recovery && h('p', {}, '復帰　' + selectedControl.recovery), ref(selectedControl.source)),
    h('div', { class: 'actions' },
      button('リセット', () => apply(replay(snapshot, share(state)))),
      button('再現リンク', () => showExport('再現リンク', location.origin + location.pathname + share(state))),
      button('探索トレース', () => showExport('探索トレース', JSON.stringify(trace(state), null, 2)))),
    h('h3', {}, '探索履歴'),
    state.history.length ? h('ol', { class: 'ux-history' }, state.history.slice(-30).reverse().map((entry) =>
      h('li', {}, h('div', {}, entry.from + ' → ' + entry.to),
        h('small', {}, { design: '設計', static: '静的結線', trace: '観測証拠あり', reference: '出典の参照', back: '戻る', unknown: '不明' }[entry.kind]),
        entry.source && h('div', {}, ref(entry.source))))) : h('p', {}, '探索履歴はまだありません。'));
}

function showExport(label, value) {
  const dialog = h('dialog', { 'aria-label': label });
  const output = h('textarea', { readonly: true, 'aria-label': label, rows: 6, autofocus: true }, value);
  dialog.append(h('h2', {}, label), output, h('div', { class: 'actions' },
    button('コピー', async () => {
      output.select();
      try { await navigator.clipboard.writeText(value); } catch { output.focus(); }
    }), button('閉じる', () => dialog.close())));
  document.body.append(dialog);
  dialog.addEventListener('close', () => dialog.remove(), { once: true });
  dialog.showModal();
}

const search = h('input', { id: 'catalog-search', type: 'search', placeholder: '画面・操作・権限' });
const platform = h('select', { id: 'catalog-platform' }, h('option', { value: '' }, 'すべてのプラットフォーム'),
  Object.entries(labels).map(([id, label]) => h('option', { value: id }, label)));
const results = h('div', { class: 'ux-catalog-results' });
catalogBody.append(h('label', { for: 'catalog-search' }, 'カタログ検索'), search,
  h('label', { for: 'catalog-platform' }, 'プラットフォーム'), platform, results);
search.addEventListener('input', paintCatalog);
platform.addEventListener('change', paintCatalog);

function paintCatalog() {
  const terms = search.value.toLowerCase().trim().split(/\s+/).filter(Boolean);
  const matches = (record) => terms.every((term) => JSON.stringify(record).toLowerCase().includes(term));
  const flows = (records) => records.filter((flow) => matches(flow) && (!platform.value || flow.platforms.includes(platform.value)));
  const scenarios = flows(snapshot[activeMode].scenarios);
  const controls = snapshot.expected.controls;
  const rows = snapshot.expected.screens.filter((screen) => matches({
    ...screen, controls: controls.filter(({ screen: id }) => id === screen.id),
    coverage: snapshot.coverage.filter(({ id }) => id === screen.id),
  }));
  const status = (id) => snapshot.coverage.filter(({ id: entry, platform: scope, status }) => entry === id
    && (platform.value ? scope === platform.value : status !== 'excluded'));
  const coverage = (rows) => rows.map((entry) => h('small', { class: 'ux-coverage-label' },
    [labels[entry.platform], statusLabels[entry.status], entry.reason].filter(Boolean).join(' · ')));
  results.replaceChildren(
    h('div', { class: 'actions', 'aria-label': '投影の切替' },
      ...Object.entries(modeLabels).map(([mode, label]) => button(label, () => changeMode(mode), { 'aria-pressed': String(activeMode === mode) }))),
    h('h2', {}, '経路'),
    scenarios.length ? h('ul', { class: 'ux-scenarios' }, scenarios.map((flow) =>
      h('li', {}, h('strong', {}, flow.label),
        h('div', { class: 'actions' }, flow.platforms.filter((value) => !platform.value || value === platform.value).map((value) =>
          button(labels[value], () => open(activeMode, value, flow.id)))),
        activeMode === 'expected' && h('details', {}, h('summary', {}, '状態を直接表示'),
          h('ul', {}, snapshot.expected.states.filter(({ id, platforms }) => id.startsWith(flow.id + '/')
            && (!platform.value || !platforms || platforms.includes(platform.value))).map((node) => {
            const available = node.platforms ?? flow.platforms;
            const scope = platform.value || (available.includes(state?.platform) ? state.platform : available[0]);
            return h('li', {}, button(node.label, () => open(activeMode, scope, flow.id, node.id)));
          }))))))
      : h('p', {}, '該当する経路はありません。'),
    h('details', {}, h('summary', {}, '必須ジャーニー'), h('ul', {},
      snapshot.expected.journeys.filter(matches).map((journey) => h('li', {}, h('strong', {}, journey.label + ' '),
        journey.summary, ' ', ref(journey.source))))),
    h('h2', {}, '画面と操作の対応'),
    rows.map((screen) => h('details', { class: 'ux-screen-details' }, h('summary', {}, screen.id + ' · ' + screen.purpose),
      coverage(status(screen.id)), ref(screen.source, '設計正本'),
      h('ul', {}, controls.filter(({ screen: id }) => id === screen.id).map((control) =>
        h('li', {}, control.id + ' ' + control.label, coverage(status(control.id))))))));
}

function paint() {
  paintStage();
  paintInspector();
  paintCatalog();
}

window.addEventListener('popstate', restore);
restore();
