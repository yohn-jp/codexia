import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { readAuthority, reconcile } from './authority.mjs';
import { start, dispatch, inject, replay, share, trace, validate } from './model.mjs';
import { demo } from './features/reference.mjs';

const sha = 'a'.repeat(40);
const read = (name) => readFileSync(new URL('../../' + name, import.meta.url), 'utf8');
const initial = () => start([demo], 'desktop', 'reference-authoring', 'sample-library', 'start');

test('inventory keeps adopted, proposal, conceptual and operator records separate', () => {
  const authority = readAuthority(read);
  assert.equal(authority.screens.find(({ id }) => id === 'KNO-03').adoption, 'proposal');
  assert.equal(authority.screens.find(({ id }) => id === 'OPS-01').adoption, 'external');
  assert.equal(authority.screens.find(({ id }) => id === 'CFG-01').adoption, 'conceptual');
  assert.deepEqual(authority.screens.find(({ id }) => id === 'WRT-01').platforms, ['desktop', 'ios']);
  assert.ok(authority.controls.some(({ id }) => id === 'CON-32.B'));
  const coverage = reconcile(authority, [demo]);
  assert.equal(coverage.status, 'partial');
  assert.ok(coverage.records.some(({ id, status }) => id === 'PUB-01' && status === 'missing'));
  assert.throws(() => reconcile(authority, [demo, demo]), /duplicate/i);
  assert.throws(() => reconcile(authority, [{ ...demo, screens: ['KNO-03'] }]), /coverage/i);
});

test('normal, cancelled and injected paths carry context and differ from a direct start', () => {
  const initialState = initial();
  const entered = dispatch(initialState, 'open');
  assert.equal(entered.screen, 'OUT-01');
  assert.equal(entered.context.project, 'synthetic-lighthouse');
  assert.equal(dispatch(entered, 'back').screen, 'LIB-01');
  const direct = start([demo], 'desktop', 'reference-authoring', 'sample-library', 'outline');
  assert.equal(direct.entry, 'direct');
  assert.equal(direct.history.length, 0);
  const refused = dispatch(inject(initialState, 'forbidden'), 'open');
  assert.equal(refused.screen, 'LIB-01');
  assert.equal(refused.history.at(-1).outcome, 'refused');
  assert.equal(dispatch(refused, 'open').screen, 'OUT-01');
  assert.equal(dispatch(entered, 'unknown-event').history.at(-1).outcome, 'refused');
});

test('reproduction requires an exact artifact and approved identifiers; trace excludes input', () => {
  const state = dispatch(dispatch(initial(), 'create'), 'name', 'a private draft');
  assert.equal(state.context.name, 'a private draft');
  assert.ok(!JSON.stringify(trace(state, sha)).includes('a private draft'));
  assert.equal(replay(share(state, sha), sha, [demo]).screen, 'LIB-01');
  assert.throws(() => replay(share(state, sha), 'b'.repeat(40), [demo]), /版/);
  assert.throws(() => replay(share(state, sha) + '&x=1', sha, [demo]), /識別子/);
});

test('malformed edges, unapproved responses, and setup-only author fixtures fail validation', () => {
  const first = demo.edges[0];
  assert.throws(() => validate([{ ...demo, edges: [{ ...first, to: 'OUT-01' }, ...demo.edges.slice(1)] }]), /transition/);
  const [scenario] = demo.scenarios;
  assert.throws(() => validate([{ ...demo, scenarios: [{ ...scenario, responses: ['arbitrary'] }] }]), /scenario/);
  const invalid = { ...demo, scenarios: [{ ...scenario, checkpoints: {
    ...scenario.checkpoints, start: { ...scenario.checkpoints.start, principal: 'SETUP', context: { principal: 'SETUP' } },
  } }] };
  assert.throws(() => reconcile(readAuthority(read), [invalid]), /principal/);
});

test('a guarded handoff uses the destination fixture authority and preserves the original replay', () => {
  const login = {
    id: 'auth', platform: 'auth', screens: ['AUTH-01'],
    fixtures: { 'signed-request': { principal: 'ANON' } },
    scenarios: [{ id: 'signed-login', label: 'ログイン', kind: 'normal', fixture: 'signed-request',
      checkpoints: { start: { at: 'AUTH-01/ready', principal: 'ANON' } } }],
    edges: [{ id: 'login-handoff', from: 'AUTH-01/ready', event: 'login', to: 'LIB-01/ready',
      source: 'docs/design/SCREEN-STATE-ATLAS.md', effect: true, guardDescription: '有効な同意',
      guard: (_context, consent) => consent === 'allow', replayInputs: ['allow'],
      handoff: { platform: 'desktop', scenario: 'reference-authoring', checkpoint: 'start' },
      carry: () => ({ principal: 'SETUP', document: 'synthetic-continuation' }),
    }],
  };
  const features = validate([demo, login]);
  const state = start(features, 'auth', 'signed-login', 'signed-request', 'start');
  assert.equal(dispatch(state, 'login').screen, 'AUTH-01');
  assert.equal(dispatch(inject(state, 'forbidden'), 'login', 'allow').screen, 'AUTH-01');
  const result = dispatch(state, 'login', 'allow');
  assert.equal(result.screen, 'LIB-01');
  assert.equal(result.context.principal, 'OWNER-API');
  assert.equal(result.context.document, 'synthetic-continuation');
  assert.equal(result.entry, 'start');
  assert.equal(replay(share(result, sha), sha, features).screen, 'AUTH-01');
  assert.equal(trace(result, sha).history[0].input, 'allow');
});

test('an edge reachable only by direct entry does not establish control coverage', () => {
  const [scenario] = demo.scenarios;
  const onlyDirect = {
    ...demo, scenarios: [{ ...scenario, checkpoints: {
      ...scenario.checkpoints, isolated: { at: 'LIB-01/isolated', principal: 'OWNER-API' },
    } }],
    edges: [...demo.edges, {
      ...demo.edges[0], id: 'isolated-import', from: 'LIB-01/isolated', control: 'LIB-01.C',
    }],
  };
  const coverage = reconcile(readAuthority(read), validate([onlyDirect]));
  assert.equal(coverage.records.find(({ id, platform }) => id === 'LIB-01.C' && platform === 'desktop').status, 'missing');
});
