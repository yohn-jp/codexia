import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSource } from './source.mjs';
import { designProjection } from './design.mjs';
import { reconcile } from './authority.mjs';
import { step, begin, replay, share, back, trace } from './model.mjs';

const source = createSource(new URL('../../', import.meta.url));
const design = () => designProjection(source);
const sha = 'a'.repeat(40);
const snapshot = () => ({ sourceSha: sha, expected: design(), observed: { screens: [], controls: [], transitions: [] } });

test('the design projection covers adopted IDs without enacting proposal or external screens', () => {
  const { screens, controls, scenarios, transitions } = design();
  assert.equal(screens.find(({ id }) => id === 'KNO-03').adoption, 'proposal');
  assert.equal(screens.find(({ id }) => id === 'CFG-01').adoption, 'conceptual');
  assert.equal(screens.find(({ id }) => id === 'OPS-01').adoption, 'external');
  assert.ok(controls.some(({ id }) => id === 'CON-32.B'));
  assert.ok(!scenarios.some(({ screens }) => screens.includes('KNO-03')));
  assert.ok(transitions.some(({ event }) => event === '応答不明/競合'));
});

test('implementation absence and observation absence are distinct', () => {
  const expected = design();
  const location = source.location('app/src/application/persistence-save-machine.ts', 'createMachine');
  assert.ok(location);
  const declared = { id: 'WRT-01', platform: 'desktop', source: location };
  const coverage = reconcile(expected, { screens: [declared], controls: [], transitions: [], gaps: [] });
  assert.equal(coverage.find(({ id, platform }) => id === 'WRT-01' && platform === 'desktop').status, 'unobserved');
  assert.equal(coverage.find(({ id, platform }) => id === 'WRT-01.A' && platform === 'desktop').status, 'unextracted');
  assert.throws(() => reconcile(expected, { screens: [declared, declared], controls: [], transitions: [] }), /Duplicate/);
});

test('design navigation walks only projected edges, tracks history and replays exact source', () => {
  const data = snapshot();
  const flow = data.expected.scenarios.find(({ screens }) => screens.includes('REC-01'));
  const initial = begin(data, 'expected', flow.platforms[0], flow.id, 'start');
  const edge = data.expected.transitions.find(({ from }) => from === initial.at);
  const next = step(initial, edge.id);
  assert.equal(next.at, edge.to);
  assert.equal(step(next, 'foreign').at, next.at);
  assert.equal(back(next).at, initial.at);
  assert.equal(replay(data, share(next)).at, initial.at);
  assert.equal(trace(next).history[0].edge, edge.id);
  assert.throws(() => replay({ ...data, sourceSha: 'b'.repeat(40) }, share(next)), /版/);
  assert.throws(() => replay(data, share(next) + '&extra=1'), /識別子/);
});

test('editing an Atlas branch changes only the independent design projection', () => {
  const changed = {
    ...source, read(path) {
      const value = source.read(path);
      return path === 'docs/architecture/diagrams/screen-6.mmd' ? value.replace('応答不明/競合', '応答遅延/競合') : value;
    },
  };
  const before = design();
  const after = designProjection(changed);
  assert.ok(before.transitions.some(({ event }) => event === '応答不明/競合'));
  assert.ok(after.transitions.some(({ event }) => event === '応答遅延/競合'));
  assert.deepEqual(before.controls, after.controls);
});

test('a Desktop-only entry cannot be opened through a native reproduction link', () => {
  assert.throws(() => begin(snapshot(), 'expected', 'ios', 'atlas-entry-01', 'atlas-entry-01/WEB'), /開始位置/);
});

test('deleting control authority cannot produce a mapped design', () => {
  const changed = {
    ...source, read(path) {
      const value = source.read(path);
      return path === 'docs/design/screen-catalog.json' ? JSON.stringify({ ...JSON.parse(value), controls: [] }) : value;
    },
  };
  assert.throws(() => designProjection(changed), /Missing controls/);
});

test('design projection resolves screen, transition and journey evidence without reading the old Markdown', () => {
  const legacyFiles = new Set(['SCREEN-CONTROL-CATALOG.md', 'SCREEN-STATE-ATLAS.md', 'UX-SIMULATOR-CONTRACT.md']);
  const current = designProjection({
    ...source,
    read(path) {
      assert.ok(!legacyFiles.has(path.split('/').at(-1)), 'Legacy design source read: ' + path);
      return source.read(path);
    },
  });
  assert.equal(current.controls.find(({ id }) => id === 'WRT-01.A').source.path, 'docs/design/screen-catalog.json');
  assert.equal(current.transitions.find(({ event }) => event === '応答不明/競合').source.path, 'docs/architecture/diagrams/screen-6.mmd');
  assert.equal(current.journeys.find(({ id }) => id === 'journey-102').source.path, 'docs/design/screen-journeys.json');
  assert.deepEqual(current.journeys.find(({ id }) => id === 'journey-107').screens,
    ['CON-10', 'CON-11', 'CON-20', 'CON-21']);
});

test('an adapter cannot promote source declarations to execution evidence or use a design document as binding', async () => {
  const { observedProjection } = await import('./observed.mjs');
  const origin = source.location('app/src/application/persistence-save-machine.ts', 'createMachine');
  const forged = () => ({
    transitions: [{ id: 'forged', platform: 'desktop', from: 'opening', to: 'saved', event: 'save',
      source: origin, method: 'trace', trace: { sourceSha: sha, outcome: 'passed', source: origin } }],
  });
  await assert.rejects(observedProjection(source, sha, (domain) => domain === 'desktop' ? { project: forged } : null),
    /No independently verified execution evidence/);
  const docs = () => ({ screens: [{ id: 'WRT-01', platform: 'desktop',
    source: { path: 'docs/architecture/diagrams/screen-6.mmd', line: 1 } }] });
  await assert.rejects(observedProjection(source, sha, (domain) => domain === 'desktop' ? { project: docs } : null),
    /Invalid canonical source location/);
});
