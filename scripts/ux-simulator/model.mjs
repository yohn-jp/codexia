const urlKeys = ['sha', 'projection', 'platform', 'scenario', 'checkpoint'];
const projectionKeys = ['expected', 'observed'];

export function begin(snapshot, projection, platform, scenario, checkpoint = 'start') {
  if (!projectionKeys.includes(projection)) throw new Error('投影の指定が不正です。');
  const graph = snapshot[projection];
  const chosen = graph.scenarios.find(({ id, platforms }) => id === scenario && platforms.includes(platform));
  if (!chosen) throw new Error('この投影にシナリオがありません。');
  const initial = chosen.initialByPlatform?.[platform] ?? chosen.initial;
  const state = graph.states.find(({ id, platform: scope, platforms }) => id === (checkpoint === 'start' ? initial : checkpoint)
    && (!scope || scope === platform) && (!platforms || platforms.includes(platform)));
  if (!state || (checkpoint !== 'start' && projection === 'expected' && !state.id.startsWith(chosen.id + '/'))) {
    throw new Error('定義済みの開始位置を選択してください。');
  }
  return { snapshot, projection, platform, scenario, checkpoint, origin: { projection, platform, scenario, checkpoint }, entry: checkpoint === 'start' ? 'start' : 'direct',
    at: state.id, stack: [], history: [], notice: '' };
}

export function choices(state) {
  const { projection, at, platform } = state;
  return state.snapshot[projection].transitions.filter((edge) => edge.from === at && (!edge.platform || edge.platform === platform));
}

export function step(state, id) {
  const edge = choices(state).find((edge) => edge.id === id);
  if (!edge?.source) {
    return { ...state, notice: 'この位置から、出典のある分岐を辿れません。',
      history: [...state.history, { from: state.at, to: state.at, kind: 'unknown' }] };
  }
  const kind = state.projection === 'expected' ? 'design' : edge.method === 'trace' ? 'trace' : 'static';
  return { ...state, at: edge.to, stack: [...state.stack, position(state)], notice: '',
    history: [...state.history, { edge: edge.id, from: edge.from, to: edge.to, kind, source: edge.source }] };
}

function position({ platform, scenario, at }) {
  return { platform, scenario, at };
}

export function visit(state, platform, scenario) {
  const from = state.snapshot.expected.states.find(({ id }) => id === state.at);
  const target = state.snapshot.expected.scenarios.find(({ id }) => id === scenario);
  if (state.projection !== 'expected' || !target?.screens.includes(from?.linkedScreen)) return step(state, '');
  const next = begin(state.snapshot, 'expected', platform, scenario);
  return { ...state, ...position(next), notice: '', stack: [...state.stack, position(state)],
    history: [...state.history, { from: state.at, to: next.at, kind: 'reference', source: from.source }] };
}

export function back(state) {
  if (!state.stack.length) return state;
  const previous = state.stack.at(-1);
  return { ...state, ...previous, stack: state.stack.slice(0, -1), notice: '',
    history: [...state.history, { from: state.at, to: previous.at, kind: 'back' }] };
}

export function share({ snapshot, origin }) {
  return '?' + new URLSearchParams({ sha: snapshot.sourceSha, ...origin }).toString();
}

export function replay(snapshot, search) {
  const query = new URLSearchParams(search);
  if (query.size !== urlKeys.length || urlKeys.some((key) => query.getAll(key).length !== 1)) {
    throw new Error('再現リンクの識別子が不正です。');
  }
  if (query.get('sha') !== snapshot.sourceSha) throw new Error('この再現リンクは現在の版と一致しません。');
  return begin(snapshot, ...urlKeys.slice(1).map((key) => query.get(key)));
}

export function trace(state) {
  const { snapshot, origin, entry, history } = state;
  return { schemaVersion: 2, sourceSha: snapshot.sourceSha, ...origin, entry, history };
}
