// CI-only adapter: the browser lane uses a PostgreSQL service on its private
// container network. Forward a fresh, dedicated database over loopback so the
// ordinary benchmark safety policy remains unchanged.
import { createRequire } from 'node:module';
import { createServer, connect } from 'node:net';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { realpath } from 'node:fs/promises';

if (process.env.CI !== 'true' || !process.env.CODEXIA_CI_REPORT_DIR || process.env.CODEXIA_PROFILE !== 'core') {
  throw new Error('Benchmark CI smoke requires the isolated Core browser lane');
}
// The container runs under a different UID than actions/checkout. Trust only
// the exact CI workspace and verify its HEAD before starting the benchmark.
const workspace = await realpath(process.cwd());
if (!process.env.GITHUB_WORKSPACE || workspace !== await realpath(process.env.GITHUB_WORKSPACE)) {
  throw new Error('Benchmark smoke must run from the checked-out GitHub workspace');
}
const configCount = Number(process.env.GIT_CONFIG_COUNT ?? 0);
if (!Number.isSafeInteger(configCount) || configCount < 0) throw new Error('Invalid inherited Git config count');
const gitEnv = { ...process.env, GIT_CONFIG_COUNT: String(configCount + 1),
  [`GIT_CONFIG_KEY_${configCount}`]: 'safe.directory',
  [`GIT_CONFIG_VALUE_${configCount}`]: workspace };
const { stdout: checkedHead } = await promisify(execFile)('git', ['rev-parse', 'HEAD'], { env: gitEnv });
if (!/^[a-f0-9]{40}$/u.test(process.env.CODEXIA_EXPECTED_SHA ?? '') ||
    checkedHead.trim() !== process.env.CODEXIA_EXPECTED_SHA) {
  throw new Error('Benchmark smoke source SHA differs from the selected CI source');
}
const service = new URL(process.env.CODEXIA_E2E_DATABASE_URL ?? '');
if (!['postgres:', 'postgresql:'].includes(service.protocol) || service.hostname !== 'postgres' ||
    service.pathname !== '/codexia_test' || service.search || service.hash ||
    (service.port && service.port !== '5432')) {
  throw new Error('Benchmark CI smoke requires the canonical disposable PostgreSQL service');
}
const requirePersistence = createRequire(new URL('../../packages/persistence-postgres/package.json', import.meta.url));
const { Client } = requirePersistence('pg');
const database = 'codexia_perf_smoke_' + randomUUID().replaceAll('-', '');
const control = new Client({ connectionString: service.toString() });
const sockets = new Set();
const proxy = createServer(incoming => {
  const upstream = connect({ host: 'postgres', port: 5432 });
  sockets.add(incoming); sockets.add(upstream);
  incoming.on('close', () => { sockets.delete(incoming); upstream.destroy(); });
  upstream.on('close', () => { sockets.delete(upstream); incoming.destroy(); });
  incoming.on('error', () => upstream.destroy());
  upstream.on('error', () => incoming.destroy());
  incoming.pipe(upstream).pipe(incoming);
});
let created = false;
await control.connect();
try {
  await control.query(`CREATE DATABASE "${database}"`);
  created = true;
  const listening = once(proxy, 'listening');
  proxy.listen(0, '127.0.0.1');
  await listening;
  const target = new URL(service);
  target.hostname = '127.0.0.1';
  target.port = String(proxy.address().port);
  target.pathname = '/' + database;
  const { stdout } = await promisify(execFile)(process.execPath, [
    '--test', '--test-reporter=tap', '--test-name-pattern=PostgreSQL browser benchmark exercises the current UI and save/receipt path',
    'scripts/performance/performance.test.mjs',
  ], { env: { ...gitEnv, CODEXIA_TEST_DATABASE_URL: target.toString(), CODEXIA_PERF_BROWSER_SMOKE: '1' },
    timeout: 200_000, maxBuffer: 4 * 1024 * 1024 });
  if (!stdout.includes('# pass 1') || !stdout.includes('# skipped 0')) {
    throw new Error('Benchmark smoke did not execute exactly one passing test');
  }
  process.stdout.write(stdout);
  process.stdout.write('PostgreSQL browser benchmark smoke passed\n');
} catch (error) {
  if (error.stdout) process.stderr.write(error.stdout);
  if (error.stderr) process.stderr.write(error.stderr);
  throw error;
} finally {
  for (const socket of sockets) socket.destroy();
  try {
    if (proxy.listening) await new Promise((resolve, reject) => proxy.close(error => error ? reject(error) : resolve()));
    if (created) await control.query(`DROP DATABASE "${database}" WITH (FORCE)`);
  } finally { await control.end(); }
}
