import { readAuthority } from './authority.mjs';
import { jsonRecordLocator } from './source.mjs';

const diagramRoot = 'docs/architecture/diagrams';
const journeyPath = 'docs/design/screen-journeys.json';
const idPattern = /[A-Z]+-\d{2}/g;
const cleanLabel = (label) => label.replace(/<br\s*\/?\s*>/gi, ' / ').trim();
const nodePattern = String.raw`([A-Za-z0-9_]+|\[\*\])(?:\["([^"]+)"\]|\{"([^"]+)"\})?`;
const edgePattern = new RegExp('^\\s*' + nodePattern + '\\s*-->\\s*(?:\\|([^|]+)\\|\\s*)?' + nodePattern + '\\s*(?::\\s*(.+))?\\s*$');

function parseGraph(text, path, scenario) {
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
        linkedScreen: relatedScreen, source: { path, line: index } });
    }
    return id;
  };
  for (const [index, line] of text.split('\n').entries()) {
    if (!line.includes('-->')) continue;
    const parsed = line.match(edgePattern);
    const lineNumber = index + 1;
    if (!parsed) throw new Error('Unsupported State Atlas edge at ' + path + ':' + lineNumber);
    const [, fromName, fromLabel, fromDecision, branch, toName, toLabel, toDecision, stateEvent] = parsed;
    const from = endpoint(fromName, fromLabel ?? fromDecision, fromDecision, lineNumber, 'from');
    const to = endpoint(toName, toLabel ?? toDecision, toDecision, lineNumber, 'to');
    const key = scenario.id + '.' + from.split('/')[1] + '.' + to.split('/')[1];
    const ordinal = (counts.get(key) ?? 0) + 1;
    counts.set(key, ordinal);
    transitions.push({ id: key + '.' + ordinal,
      scenario: scenario.id, from, to, event: cleanLabel(branch ?? stateEvent ?? toLabel ?? toDecision ?? toName),
      condition: branch ?? stateEvent ?? null, source: { path, line: lineNumber } });
  }
  return { states: [...states.values()], transitions, initial: transitions[0]?.from };
}

export function designProjection(source) {
  const { screens, controls } = readAuthority(source);
  const design = { screens, controls, states: [], transitions: [], scenarios: [], journeys: [] };
  const { diagrams } = JSON.parse(source.read(diagramRoot + '/catalog.json'));
  const diagramIds = new Set();
  for (const { id, title, screenIds: ids = [] } of diagrams) {
    if (!id.startsWith('screen-')) continue;
    if (!/^screen-\d+$/u.test(id) || diagramIds.has(id) || !title || !Array.isArray(ids) ||
        new Set(ids).size !== ids.length || ids.some(candidate => !screens.some(screen => screen.id === candidate))) {
      throw new Error('Invalid State Atlas diagram: ' + id);
    }
    diagramIds.add(id);
    const adopted = screens.filter(({ id, adoption }) => ids.includes(id) && adoption === 'adopted');
    const cross = id === 'screen-26';
    if (!adopted.length && !cross) continue;
    const path = diagramRoot + '/' + id + '.mmd';
    const scenario = {
      id: cross ? 'cross-shell' : 'atlas-' + ids.join('-').toLowerCase(),
      label: title, screens: adopted.map(({ id }) => id),
      platforms: cross ? ['desktop', 'ios'] : [...new Set(adopted.flatMap(({ platforms }) => platforms))],
      source: { path, line: 1 },
    };
    const graph = parseGraph(source.read(path), path, scenario);
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
  const text = source.read(journeyPath);
  const journeys = JSON.parse(text);
  if (!Array.isArray(journeys) || !journeys.length) throw new Error('Missing design journeys');
  const locateJourney = jsonRecordLocator(journeyPath, text);
  const journeyIds = new Set();
  const adoptedIds = new Set(screens.filter(({ adoption }) => adoption === 'adopted').map(({ id }) => id));
  for (const { id, label, summary, screens: members } of journeys) {
    if (!/^journey-\d+$/u.test(id) || journeyIds.has(id) || !label || !summary ||
        !Array.isArray(members) || !members.length || new Set(members).size !== members.length ||
        members.some(id => !adoptedIds.has(id))) throw new Error('Invalid design journey: ' + id);
    journeyIds.add(id);
    design.journeys.push({ id, label, summary, screens: members, source: locateJourney(id) });
  }
  return design;
}
