import { platforms } from './authority.mjs';
import { isPath } from './source.mjs';

const domains = [
  ['desktop', ['desktop']], ['owner', ['auth', 'console', 'reader']], ['ios', ['ios']],
];
const idPattern = /^[a-zA-Z0-9][a-zA-Z0-9_.:/-]{0,180}$/;
const codeRoots = ['app/', 'ios/', 'modules/', 'edge/', 'packages/', 'tests/', 'scripts/verification/'];

function identifier(value, field) {
  if (typeof value !== 'string' || !idPattern.test(value)) throw new Error('Invalid projection ' + field + ': ' + value);
  return value;
}

function text(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || value.length > 1024) throw new Error('Invalid projection label');
  return value;
}

function location(source, ref, gap) {
  const roots = gap ? [...codeRoots, 'docs/'] : codeRoots;
  if (!isPath(ref?.path) || !roots.some((prefix) => ref.path.startsWith(prefix)) || !Number.isSafeInteger(ref.line) || ref.line < 1) {
    throw new Error('Invalid canonical source location: ' + ref?.path);
  }
  const lines = source.read(ref.path).split('\n');
  if (ref.line > lines.length) throw new Error('Missing canonical source line: ' + ref.path + ':' + ref.line);
  const symbol = text(ref.symbol);
  if (symbol && (!symbol.includes('\n') ? !lines[ref.line - 1].includes(symbol) : !lines.slice(ref.line - 1).join('\n').includes(symbol))) {
    throw new Error('Missing canonical source symbol: ' + ref.path + ':' + ref.line + ' ' + symbol);
  }
  return { path: ref.path, line: ref.line, symbol };
}

function statesFrom(implementation) {
  const entries = new Map();
  const track = (platform, id, location, screen, label) => {
    const key = platform + '/' + id;
    if (!entries.has(key)) entries.set(key, { id, platform, source: location, screen, label: label ?? id.split('/').at(-1) });
  };
  for (const screen of implementation.screens) {
    const { id, platform, source, title } = screen;
    track(platform, id, source, id, title);
  }
  for (const { platform, from, to, source, screen } of implementation.transitions) {
    track(platform, from, source, screen);
    track(platform, to, source, screen);
  }
  return [...entries.values()];
}

export async function observedProjection(source, sourceSha, loadAdapter) {
  const result = { screens: [], controls: [], transitions: [], gaps: [], states: [], scenarios: [] };
  for (const [domain, allowed] of domains) {
    const adapter = await loadAdapter(domain);
    if (!adapter) continue;
    const projection = adapter.project(source);
    for (const type of ['screens', 'controls', 'transitions', 'gaps']) {
      const values = projection[type] ?? [];
      if (!Array.isArray(values)) throw new Error('Invalid ' + domain + ' projection ' + type);
      for (const record of values) {
        const { platform, id, source: ref } = record;
        const base = { id: identifier(id, 'id'), platform, source: location(source, ref, type === 'gaps') };
        if (!platforms.includes(platform) || !allowed.includes(platform)) throw new Error('Invalid platform for ' + domain + ': ' + platform);
        if (type === 'screens') {
          result.screens.push({ ...base, title: text(record.title ?? record.label), route: text(record.route), form: text(record.form),
            regions: (record.regions ?? []).map(({ id, role, label }) => ({ id: identifier(id, 'region'), role: text(role), label: text(label) })) });
        } else if (type === 'controls') {
          result.controls.push({ ...base, label: text(record.label), role: text(record.role), handler: text(record.handler), region: text(record.region) });
        } else if (type === 'gaps') {
          if (!['unimplemented', 'unextracted'].includes(record.status) || !record.reason) throw new Error('Invalid implementation gap: ' + id);
          result.gaps.push({ ...base, status: record.status, reason: text(record.reason) });
        } else {
          if (record.method !== 'static') throw new Error('No independently verified execution evidence for transition: ' + id);
          result.transitions.push({ ...base, from: identifier(record.from, 'from'), to: identifier(record.to, 'to'),
            event: text(record.event), screen: text(record.screen), control: text(record.control),
            condition: text(record.condition), method: record.method });
        }
      }
    }
  }
  const keys = new Set(result.transitions.map(({ platform, id }) => platform + '/' + id));
  if (keys.size !== result.transitions.length) throw new Error('Duplicate implementation transition');
  result.states = statesFrom(result);
  result.scenarios = result.screens.filter(({ id }) => !id.startsWith('impl:')).map((screen) => {
    const initial = result.transitions.find((edge) => edge.platform === screen.platform
      && (edge.from === screen.id || edge.screen === screen.id || edge.from.startsWith(screen.id + '/')))?.from ?? screen.id;
    return { id: 'source-' + screen.id.toLowerCase(), label: screen.title ?? screen.id, platforms: [screen.platform],
      screens: [screen.id], initial, source: screen.source };
  });
  return result;
}
