import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { fixtureOrigin } from './k6-target.mjs';
import { startFixture } from './k6-fixture.mjs';

test('accepts only a numeric loopback HTTP origin with an explicit port', () => {
  assert.equal(fixtureOrigin('http://127.0.0.1:12345'), 'http://127.0.0.1:12345');
  for (const invalid of [
    undefined, 'http://localhost:12345', 'http://127.1:12345',
    'http://127.0.0.1:0', 'http://127.0.0.1:65536',
    'https://127.0.0.1:12345', 'http://127.0.0.1:12345/',
    'http://127.0.0.1:12345@host.invalid', 'http://127.0.0.1:12345?next=elsewhere',
  ]) assert.throws(() => fixtureOrigin(invalid), /loopback/);
});

test('only serves the synthetic workload with the per-run token', async () => {
  const fixture = await startFixture(async () => 'Synthetic body');
  try {
    const headers = { 'x-codexia-fixture': fixture.token };
    assert.equal((await fetch(fixture.origin + '/scene')).status, 404);
    assert.equal((await fetch(fixture.origin + '/other', { headers })).status, 404);
    assert.equal((await fetch(fixture.origin + '/ready', { headers })).headers.get('x-codexia-fixture'), fixture.token);
    const scene = await fetch(fixture.origin + '/scene', { headers });
    assert.equal(await scene.text(), 'Synthetic body');
    assert.match(scene.headers.get('server-timing'), /^pg;dur=\d+\.\d+$/u);
    const stream = await fetch(fixture.origin + '/stream', { headers });
    assert.equal(stream.headers.get('content-type'), 'text/event-stream');
    assert.equal(await stream.text(), 'data: ready\n\ndata: complete\n\n');
  } finally {
    const closed = once(fixture.server, 'close');
    fixture.server.close();
    await closed;
  }
});

const k6Binary = process.env.CODEXIA_K6_TEST_BINARY;
const exec = promisify(execFile);

test('real k6 fails the smoke when the fixture body does not match', { skip: !k6Binary }, async () => {
  const fixture = await startFixture(async () => 'Wrong synthetic body');
  try {
    await assert.rejects(exec(k6Binary, ['run', '--quiet', '--include-system-env-vars',
      fileURLToPath(new URL('./k6-scenarios.js', import.meta.url))], {
      timeout: 10_000,
      env: {
        PATH: process.env.PATH,
        K6_NO_USAGE_REPORT: 'true',
        CODEXIA_K6_ORIGIN: fixture.origin,
        CODEXIA_K6_TOKEN: fixture.token,
        CODEXIA_K6_PROFILE: 'smoke',
        CODEXIA_K6_SCENE_SHA256: createHash('sha256').update('Expected synthetic body').digest('hex'),
      },
    }), error => {
      assert.equal(error.code, 99, error.stderr);
      assert.match(error.stderr, /thresholds on metrics 'checks' have been crossed/u);
      assert.match(error.stdout, /finite event stream completes/u);
      assert.doesNotMatch(error.stdout, /fixture_scene_ms/u);
      return true;
    });
  } finally {
    const closed = once(fixture.server, 'close');
    fixture.server.close();
    await closed;
  }
});
