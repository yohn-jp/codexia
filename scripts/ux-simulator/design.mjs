import { readAuthority } from './authority.mjs';

export const atlasPath = 'docs/design/SCREEN-STATE-ATLAS.md';
const contractPath = 'docs/design/UX-SIMULATOR-CONTRACT.md';
const idPattern = /[A-Z]+-\d{2}/g;
const cleanLabel = (label) => label.replace(/<br\s*\/?\s*>/gi, ' / ').trim();
const slug = (value) => value.toLowerCase().replace(/[^\p{L}\p{N}\p{M} _-]/gu, '').replaceAll(' ', '-');
const nodePattern = String.raw`([A-Za-z0-9_]+|\[\*\])(?:\["([^"]+)"\]|\{"([^"]+)"\})?`;
const edgePattern = new RegExp('^\\s*' + nodePattern + '\\s*-->\\s*(?:\\|([^|]+)\\|\\s*)?' + nodePattern + '\\s*(?::\\s*(.+))?\\s*$');

function sections(text) {
  const entries = [];
  let entry;
  let diagram = false;
  for (const [index, line] of text.split('\n').entries()) {
    if (line.startsWith('## ')) {
      entry = { heading: line.slice(3), lines: [], line: index + 1 };
      entries.push(entry);
    } else if (line === '```mermaid') diagram = true;
    else if (line === '```') diagram = false;
    else if (diagram && entry) entry.lines.push({ line, index: index + 1 });
  }
  return entries;
}

function parseGraph(section, scenario) {
  const states = new Map();
  const transitions = [];
  const counts = new Map();
  const endpoint = (name, label, decision, index, direction) => {
    const symbol = name === '[*]' ? direction === 'from' ? 'start' : 'end' : name;
    const id = scenario.id + '/' + symbol;
    if (!states.has(id) || label) {
      const display = cleanLabel(label || symbol);
      const relatedScreen = display.match(idPattern)?.[0];
      states.set(id, { id, label: display, kind: decision ? 'decision' : 'state',
        screen: scenario.screens.includes(relatedScreen) ? relatedScreen : scenario.screens[0],
        linkedScreen: relatedScreen, source: { path: atlasPath, line: index } });
    }
    return id;
  };
  for (const { line, index } of section.lines) {
    if (!line.includes('-->')) continue;
    const parsed = line.match(edgePattern);
    if (!parsed) throw new Error('Unsupported State Atlas edge at ' + atlasPath + ':' + index);
    const [, fromName, fromLabel, fromDecision, branch, toName, toLabel, toDecision, stateEvent] = parsed;
    const from = endpoint(fromName, fromLabel ?? fromDecision, fromDecision, index, 'from');
    const to = endpoint(toName, toLabel ?? toDecision, toDecision, index, 'to');
    const key = scenario.id + '.' + from.split('/')[1] + '.' + to.split('/')[1];
    const ordinal = (counts.get(key) ?? 0) + 1;
    counts.set(key, ordinal);
    transitions.push({ id: key + '.' + ordinal,
      scenario: scenario.id, from, to, event: cleanLabel(branch ?? stateEvent ?? toLabel ?? toDecision ?? toName),
      condition: branch ?? stateEvent ?? null, source: { path: atlasPath, line: index } });
  }
  return { states: [...states.values()], transitions, initial: transitions[0]?.from };
}

export function designProjection(source) {
  const { screens, controls } = readAuthority(source);
  const design = { screens, controls, states: [], transitions: [], scenarios: [], journeys: [] };
  for (const section of sections(source.read(atlasPath))) {
    const ids = section.heading.split(' — ')[0].match(idPattern) ?? [];
    const adopted = screens.filter(({ id, adoption }) => ids.includes(id) && adoption === 'adopted');
    const cross = section.heading.startsWith('Cross-shell');
    if (!adopted.length && !cross) continue;
    const scenario = {
      id: cross ? 'cross-shell' : 'atlas-' + ids.join('-').toLowerCase(),
      label: section.heading, screens: adopted.map(({ id }) => id),
      platforms: cross ? ['desktop', 'ios'] : [...new Set(adopted.flatMap(({ platforms }) => platforms))],
      source: { path: atlasPath, line: section.line, anchor: slug(section.heading) },
    };
    const graph = parseGraph(section, scenario);
    if (!graph.initial) throw new Error('Missing diagram edges for ' + scenario.id);
    const iosEntry = scenario.screens.includes('ENTRY-01') && graph.states.find(({ id }) => id === scenario.id + '/IOS');
    const initialByPlatform = iosEntry ? { ios: iosEntry.id, desktop: graph.initial } : undefined;
    if (initialByPlatform) {
      const scoped = Object.fromEntries(Object.entries(initialByPlatform).map(([platform, initial]) => {
        const reached = new Set([initial]);
        const work = [initial];
        for (const node of work) {
          for (const { from, to } of graph.transitions) {
            if (from === node && !reached.has(to)) {
              work.push(to);
              reached.add(to);
            }
          }
        }
        return [platform, reached];
      }));
      for (const state of graph.states) state.platforms = Object.keys(scoped).filter((key) => scoped[key].has(state.id));
    }
    design.scenarios.push({ ...scenario, initial: graph.initial, initialByPlatform });
    design.states.push(...graph.states);
    design.transitions.push(...graph.transitions);
  }
  for (const screen of screens.filter(({ adoption }) => adoption === 'adopted')) {
    if (!design.scenarios.some(({ screens }) => screens.includes(screen.id))) throw new Error('Missing Atlas graph: ' + screen.id);
  }
  let inside = false;
  for (const [index, line] of source.read(contractPath).split('\n').entries()) {
    if (line.startsWith('## ')) inside = line.startsWith('## 5.');
    if (!inside || !line.startsWith('| ') || line.startsWith('| ---')) continue;
    const [, area, summary] = line.split('|').map((part) => part.trim());
    if (area === '領域') continue;
    const [rangeStart, rangeEnd] = area.match(/\d{2}/g) ?? [];
    const members = screens.filter(({ id, adoption }) =>
      adoption === 'adopted' && (rangeStart
        ? id.startsWith(area.split('-')[0] + '-') && id.slice(-2) >= rangeStart && id.slice(-2) <= rangeEnd
        : area.split('/').includes(id.split('-')[0])));
    design.journeys.push({ id: 'journey-' + index, label: area, summary, screens: members.map(({ id }) => id),
      source: { path: contractPath, line: index + 1 } });
  }
  return design;
}
