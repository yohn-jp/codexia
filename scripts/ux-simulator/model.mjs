export const platforms = ['desktop', 'ios', 'auth', 'console', 'reader'];
export const responses = ['cancelled', 'forbidden', 'unauthorized', 'not-found', 'conflict', 'stale', 'timeout', 'offline', 'quota', 'invalid', 'unavailable'];
const stableId = /^[a-zA-Z][a-zA-Z0-9.-]{0,79}$/;
const sources = /^docs\/[a-zA-Z0-9/_.-]+\.md(?:#[^\s]*)?$/;
const keys = ['sha', 'platform', 'scenario', 'fixture', 'checkpoint'];
const isId = (value) => typeof value === 'string' && stableId.test(value);

function isPosition(value, screens) {
  if (typeof value !== 'string') return false;
  const [screen, phase, ...rest] = value.split('/');
  return rest.length === 0 && isId(screen) && isId(phase) && (!screens || screens.includes(screen));
}

function findScenario(features, platform, scenario) {
  const feature = features.find((candidate) => candidate.platform === platform
    && candidate.scenarios.some(({ id }) => id === scenario));
  return { feature, definition: feature?.scenarios.find(({ id }) => id === scenario) };
}

export function validate(features) {
  const featureIds = new Set();
  const scenarios = new Set();
  for (const feature of features) {
    const { id, platform, screens, edges, fixtures, scenarios: definitions } = feature;
    if (!isId(id) || featureIds.has(id) || !platforms.includes(platform)
      || !screens.length || new Set(screens).size !== screens.length) throw new Error('Invalid feature: ' + id);
    featureIds.add(id);
    const ids = new Set();
    for (const edge of edges) {
      const { id: edgeId, from, event, to, source, control, guard, failure, handoff } = edge;
      if (!isId(edgeId) || !isId(event) || ids.has(edgeId)
        || !isPosition(from, screens) || !isPosition(to, handoff ? undefined : screens)
        || typeof source !== 'string' || !sources.test(source) || (control && control.split('.')[0] !== from.split('/')[0])
        || (guard && (typeof guard !== 'function' || !edge.guardDescription))
        || (failure && !isPosition(failure, screens))
        || (handoff && (!platforms.includes(handoff.platform) || !isId(handoff.scenario) || !isId(handoff.checkpoint)))) {
        throw new Error('Invalid transition: ' + id + '/' + edgeId);
      }
      if (handoff) {
        const { definition } = findScenario(features, handoff.platform, handoff.scenario);
        if (definition && (!Object.hasOwn(definition.checkpoints, handoff.checkpoint)
          || definition.checkpoints[handoff.checkpoint].at !== to)) {
          throw new Error('Handoff target does not match its checkpoint: ' + id + '/' + edgeId);
        }
      }
      ids.add(edgeId);
    }
    const states = new Set(edges.flatMap(({ from, to, failure, handoff }) => [from, handoff ? null : to, failure]));
    for (const [fixture, context] of Object.entries(fixtures)) {
      if (!isId(fixture) || !context || typeof context !== 'object' || !isId(context.principal)) {
        throw new Error('Invalid fixture: ' + id + '/' + fixture);
      }
    }
    for (const scenario of definitions) {
      const { id: scenarioId, fixture, checkpoints } = scenario;
      const key = platform + '/' + scenarioId;
      if ((scenario.responses && (!Array.isArray(scenario.responses)
        || scenario.responses.some((response) => response !== 'ok' && !responses.includes(response))))
        || !isId(scenarioId) || scenarios.has(key) || !Object.hasOwn(fixtures, fixture) || !Object.hasOwn(checkpoints, 'start')) {
        throw new Error('Invalid scenario: ' + key);
      }
      scenarios.add(key);
      for (const [checkpoint, details] of Object.entries(checkpoints)) {
        if (!isId(checkpoint) || !states.has(details.at) || !isId(details.principal)
          || !['normal', 'failure'].includes(scenario.kind)) {
          throw new Error('Invalid checkpoint: ' + key + '/' + checkpoint);
        }
      }
    }
  }
  return features;
}

function position(at) {
  const [screen, phase] = at.split('/');
  return { at, screen, phase };
}

export function start(features, platform, scenario, fixture, checkpoint) {
  const { feature, definition } = findScenario(features, platform, scenario);
  const target = definition && Object.hasOwn(definition.checkpoints, checkpoint) && definition.checkpoints[checkpoint];
  if (!target || fixture !== definition.fixture || !Object.hasOwn(feature.fixtures, fixture)) {
    throw new Error('定義済みのシナリオと開始状態を指定してください。');
  }
  const context = structuredClone({ ...feature.fixtures[fixture], ...target.context });
  if (context.principal !== target.principal || (target.guard && target.guard(context) !== true)) {
    throw new Error('この開始状態の権限または文脈が一致しません。');
  }
  return {
    features, feature, platform, scenario, fixture, checkpoint, ...position(target.at), context,
    origin: { platform, scenario, fixture, checkpoint }, entry: checkpoint === 'start' ? 'start' : 'direct', history: [], pending: null, notice: '',
    sequence: [...(definition.responses ?? [])],
  };
}

function record(state, event, edge, response, outcome, message, at, context, consume) {
  const next = {
    ...state, ...position(at), context, notice: message ?? '',
    pending: consume ? null : state.pending,
    sequence: consume && !state.pending ? state.sequence.slice(1) : state.sequence,
  };
  next.history = state.history.concat({
    event, transition: edge?.id ?? null, from: state.at, to: next.at, response, outcome,
    source: edge?.source ?? null, guard: edge?.guardDescription ?? null,
  });
  return next;
}

export function dispatch(state, event, input) {
  const next = runEvent(state, event, input);
  if (input === undefined) return next;
  const last = next.history.at(-1);
  const edge = state.feature.edges.find(({ id }) => id === last.transition);
  const replayInput = edge?.replayInputs?.find((candidate) => typeof input === 'string' && candidate === input);
  return {
    ...next,
    history: next.history.slice(0, -1).concat({ ...last, input: replayInput ?? 'redacted', inputRedacted: replayInput === undefined }),
  };
}

function runEvent(state, event, input) {
  const candidates = state.feature.edges.filter((edge) => edge.from === state.at && edge.event === event);
  let reason = 'この状態で使える操作ではありません。';
  for (const edge of candidates) {
    const result = edge.guard ? edge.guard(state.context, input) : true;
    if (result === true) return apply(state, event, input, edge);
    if (typeof result === 'string') reason = result;
    if (edge.onRefused) {
      const rejected = edge.onRefused(state.context, input, reason);
      return record(state, event, edge, null, 'refused', reason, edge.failure ?? state.at, rejected, false);
    }
  }
  return record(state, candidates.length ? event : 'unknown', candidates[0], null, 'refused',
    reason, state.at, state.context, false);
}

function apply(state, event, input, edge) {
  const response = edge.effect ? state.pending ?? state.sequence[0] ?? 'ok' : null;
  const failed = response !== null && response !== 'ok';
  if (failed) {
    const result = edge.onFailure?.(state.context, response, input) ?? {};
    return record(state, event, edge, response, 'refused',
      result.message ?? '合成応答: ' + response, edge.failure ?? state.at, result.context ?? state.context, true);
  }
  const result = edge.reduce?.(state.context, input) ?? {};
  if (edge.handoff) {
    const { platform, scenario, checkpoint } = edge.handoff;
    const { definition } = findScenario(state.features, platform, scenario);
    if (!definition) return record(state, event, edge, response, 'refused',
      'この境界の遷移先は生成物に含まれていません。', state.at, state.context, Boolean(edge.effect));
    const target = start(state.features, platform, scenario, definition.fixture, checkpoint);
    const carried = edge.carry?.(result.context ?? state.context) ?? {};
    const context = { ...target.context, ...carried, principal: target.context.principal };
    const next = record(state, event, edge, response, 'accepted', result.message, target.at, context, Boolean(edge.effect));
    return { ...next, feature: target.feature, platform: target.platform, sequence: target.sequence };
  }
  return record(state, event, edge, response, 'accepted', result.message, edge.to, result.context ?? state.context, Boolean(edge.effect));
}

export function inject(state, response) {
  if (!responses.includes(response)) throw new Error('未定義の合成応答です。');
  return { ...state, pending: response };
}

export function share(state, sha) {
  const { platform, scenario, fixture, checkpoint } = state.origin;
  return '?' + new URLSearchParams({ sha, platform, scenario, fixture, checkpoint }).toString();
}

export function replay(search, sha, features) {
  const params = new URLSearchParams(search);
  if (params.size !== keys.length || keys.some((key) => params.getAll(key).length !== 1)) {
    throw new Error('再現リンクの識別子が不正です。');
  }
  if (params.get('sha') !== sha) throw new Error('この再現リンクは現在の版と一致しません。');
  return start(features, ...keys.slice(1).map((key) => params.get(key)));
}

export function trace(state, sha) {
  return {
    schemaVersion: 1, sourceSha: sha, ...state.origin, entry: state.entry, replayable: !state.history.some(({ inputRedacted }) => inputRedacted), history: state.history,
  };
}
