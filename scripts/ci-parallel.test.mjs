import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { runBounded, runDependencyBuilds } from './ci-parallel.mjs';
import { browserFixtureSettings } from './ci-browser-fixture.mjs';

test('bounded execution preserves input order, failure evidence and exclusive barriers', async () => {
  let active = 0, peak = 0;
  const completed = [];
  const tasks = ['a', 'b', 'exclusive', 'c', 'd'];
  const results = await runBounded(tasks, async item => {
    if (item === 'exclusive') {
      assert.equal(active, 0);
      assert.deepEqual(new Set(completed), new Set(['a','b']));
    }
    if (item === 'c' || item === 'd') assert.ok(completed.includes('exclusive'));
    active++;
    peak = Math.max(peak, active);
    try {
      await delay(item === 'a' ? 15 : 5);
      if (item === 'b') throw new Error('injected failure');
      return item;
    } finally { active--; completed.push(item); }
  }, { limit: 2, exclusive: item => item === 'exclusive' });
  assert.equal(peak, 2);
  assert.deepEqual(results.map(item => item.status), ['fulfilled','rejected','fulfilled','fulfilled','fulfilled']);
  assert.equal(results[4].value, 'd');
  assert.match(String(results[1].reason), /injected failure/);
  assert.equal(active, 0);
});

test('serial limit runs every task without overlap', async () => {
  let active = 0;
  const results = await runBounded([1,2,3], async item => {
    assert.equal(active++, 0);
    await delay(1);
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
