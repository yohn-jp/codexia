import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { runBounded, runDependencyBuilds } from './ci-parallel.mjs';
import { browserFixtureSettings } from './ci-browser-fixture.mjs';

test('bounded execution preserves input order, failure evidence and exclusive barriers', async () => {
  const started = [];
  const tasks = ['a', 'b', 'exclusive', 'c', 'd'];
  const gates = new Map(tasks.map(task => [task, Promise.withResolvers()]));
  const running = runBounded(tasks, item => {
    started.push(item);
    return gates.get(item).promise;
  }, { limit: 2, exclusive: item => item === 'exclusive' });
  try {
    await nextTurn();
    assert.deepEqual(new Set(started), new Set(['a', 'b']));
    assert.equal(started.length, 2);
    gates.get('b').reject(new Error('injected failure'));
    await nextTurn();
    assert.equal(started.length, 2);
    gates.get('a').resolve('first');
    await nextTurn();
    assert.deepEqual(started.slice(2), ['exclusive']);
    gates.get('exclusive').resolve('barrier');
    await nextTurn();
    assert.deepEqual(new Set(started.slice(3)), new Set(['c', 'd']));
    assert.equal(started.length, tasks.length);
    gates.get('d').resolve('last');
    gates.get('c').resolve('third');

    const results = await running;
    assert.deepEqual(results.map(result => result.value), ['first', undefined, 'barrier', 'third', 'last']);
    assert.equal(results[1].status, 'rejected');
    assert.match(String(results[1].reason), /injected failure/);
  } finally {
    for (const gate of gates.values()) gate.resolve();
    await running;
  }
});

test('serial limit runs every task without overlap', async () => {
  let active = 0;
  const results = await runBounded([1,2,3], async item => {
    assert.equal(active++, 0);
    await nextTurn();
    active--;
    return item;
  }, { limit: 1 });
  assert.deepEqual(results.map(result => result.value), [1,2,3]);
  await assert.rejects(runBounded([], () => {}, { limit: 0 }), /concurrency/);
});

test('dependency builds are deduplicated and failures block only their dependants', async () => {
  const edges = { foundation: [], independent: [], left: ['foundation'], right: ['foundation'], downstream: ['left','right'], unrelated: ['independent'] };
  const calls = [];
  const passed = new Set();
  const result = await runDependencyBuilds(Object.keys(edges), id => edges[id], async id => {
    calls.push(id);
    for (const dependency of edges[id]) assert.ok(passed.has(dependency));
    if (id === 'left') throw new Error('injected build failure');
    passed.add(id);
  });
  assert.equal(calls.filter(id => id === 'foundation').length, 1);
  assert.ok(!calls.includes('downstream'));
  assert.equal(result.get('left').status, 'failed');
  assert.equal(result.get('downstream').status, 'blocked');
  assert.equal(result.get('right').status, 'passed');
  assert.equal(result.get('unrelated').status, 'passed');
  await assert.rejects(runDependencyBuilds(['x'], () => ['missing'], () => {}), /Unresolved/);
});

test('browser shards use different database, port pairs, state and trace output', () => {
  const service = 'postgres://codexia:synthetic@postgres:5432/codexia_test';
  const a = browserFixtureSettings('browser-core-ui-v1', 0, service, 'codexia_ci_' + 'a'.repeat(32), '/tmp/state-a');
  const b = browserFixtureSettings('browser-core-webkit', 1, service, 'codexia_ci_' + 'b'.repeat(32), '/tmp/state-b');
  assert.equal(a.CODEXIA_E2E_ADMIN_DATABASE_URL, b.CODEXIA_E2E_ADMIN_DATABASE_URL);
  for (const key of ['CODEXIA_E2E_DATABASE_URL','CODEXIA_E2E_PORT','CODEXIA_E2E_STATE_DIR','CODEXIA_E2E_OUTPUT_DIR','CODEXIA_E2E_PROJECT_TITLE']) assert.notEqual(a[key], b[key]);
  assert.ok(Number(b.CODEXIA_E2E_PORT) > Number(a.CODEXIA_E2E_PORT) + 1);
  assert.match(a.CODEXIA_E2E_OUTPUT_DIR, /test-results[/\\]browser-core-ui-v1$/);
  for (const unsafe of ['postgres://postgres/production','postgres://example.com/codexia_test','postgres://postgres/codexia_test?sslmode=require']) {
    assert.throws(() => browserFixtureSettings('browser-core-ui-v1', 0, unsafe, 'codexia_ci_' + 'a'.repeat(32), '/tmp/state-a'), /canonical disposable/);
  }
});
