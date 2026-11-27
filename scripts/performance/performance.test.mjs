import { test } from 'node:test';
import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import { mkdtemp, rm, open, readFile, readdir, writeFile, symlink, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { distribution, readRegularFile, save, writeNewJsonResult } from './common.mjs';
import { generate, git, verifyFixture } from './dataset.mjs';
import { runWorker, selectCoreDatasets } from './run.mjs';

test('Core measurement defaults exclude fixtures that cannot be seeded', () => {
  assert.deepEqual(selectCoreDatasets(), ['small', 'long-form', 'knowledge-dense', 'limit-999']);
});

test('an explicit dataset list can request seeding-rejection fixtures', () => {
  assert.deepEqual(selectCoreDatasets('limit-1001,limit-1000,small'), ['limit-1001', 'limit-1000', 'small']);
  assert.deepEqual(selectCoreDatasets(''), []);
  assert.throws(() => selectCoreDatasets('unknown'), /Unknown dataset: unknown/u);
});

test('nearest-rank quantiles retain missing observations and sample count', () => {
  assert.deepEqual(distribution([]), { n: 0, p50: null, p95: null, p99: null });
  const result = distribution(Array.from({ length: 100 }, (_, i) => 100 - i));
  assert.deepEqual(result, { n: 100, p50: 50, p95: 95, p99: 99, max: 100 });
});
test('verified artifact reads use a regular file descriptor and reject symlink paths', async () => {
  const root = await mkdtemp(join(tmpdir(), 'performance-artifact-read-'));
  try {
    const file = join(root, 'artifact.js'), link = join(root, 'artifact-link.js');
    await writeFile(file, 'verified artifact');
    const bytes = await readRegularFile(file);
    assert.ok(Buffer.isBuffer(bytes));
    assert.equal(bytes.toString(), 'verified artifact');
    await symlink(file, link);
    await assert.rejects(readRegularFile(link));
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('result writers claim new files exclusively and save uses private collision-safe temporary files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'performance-safe-output-'));
  async function readPrivateResult(file) {
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const attributes = await handle.stat();
      assert.ok(attributes.isFile());
      assert.equal(attributes.mode & 0o777, 0o600);
      return JSON.parse(await handle.readFile('utf8'));
    } finally { await handle.close(); }
  }
  try {
    const result = join(root, 'result.json');
    const attempts = [{ status: 'first' }, { status: 'second' }];
    const outcomes = await Promise.allSettled(attempts.map(value => writeNewJsonResult(result, value)));
    const winners = outcomes.flatMap((outcome, index) => outcome.status === 'fulfilled' ? [attempts[index]] : []);
    const losers = outcomes.filter(outcome => outcome.status === 'rejected');
    assert.equal(winners.length, 1);
    assert.equal(losers.length, 1);
    assert.equal(losers[0].reason.code, 'EEXIST');
    assert.deepEqual(await readPrivateResult(result), winners[0]);
    await assert.rejects(writeNewJsonResult(result, { status: 'overwritten' }), { code: 'EEXIST' });
    assert.deepEqual(await readPrivateResult(result), winners[0]);

    const updated = join(root, 'progress.json');
    await save(updated, { status: 'running' });
    assert.deepEqual(await readPrivateResult(updated), { status: 'running' });
    await save(updated, { status: 'complete' });
    assert.deepEqual(await readPrivateResult(updated), { status: 'complete' });
    assert.deepEqual((await readdir(root)).sort(), ['progress.json', 'result.json']);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('summaries exclude failed and timed-out workload latency while preserving completed observations and rejections', async () => {
  const { summarizeCore } = await import('./summarize.mjs');
  const result = summarizeCore({ status: 'NOT_CHECKED', workerStatus: 'failed', samples: [
    { name: 'read', status: 'complete', appWallMs: 12, counters: { pgQueries: 3 } },
    { name: 'read', status: 'failed', appWallMs: 900, counters: { pgQueries: 50 } },
  ], rejections: [{ name: 'snapshot.materialize.boundary', status: 'rejected', rejectionWallMs: 44 }],
  failures: [{ name: 'read', status: 'failed' }, { name: 'write', status: 'failed' }] });
  assert.equal(result.operations.read.status, 'partial');
  assert.equal(result.operations.read.appWallMs.n, 1);
  assert.equal(result.operations.read.appWallMs.p50, 12);
  assert.equal(result.operations.read.sqlQueries.p50, 3);
  assert.equal(result.rejections[0].rejectionWallMs, 44);
});
test('synthetic fixture has exact tracked count, document sizes and reproducible Git identity', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wave0-test-'));
  try {
    const previousUmask = process.umask(0);
    let a, b;
    try { a = await generate(join(root, 'a'), 'small'); b = await generate(join(root, 'b'), 'small'); }
    finally { process.umask(previousUmask); }
    assert.equal(a.documentCount, 8); assert.equal(a.transport.commit, b.transport.commit);
    assert.equal((await lstat(join(root, 'a'))).mode & 0o777, 0o700);
    assert.equal((await lstat(join(root, 'a/seed'))).mode & 0o777, 0o700);
    assert.equal((await lstat(join(root, 'a/seed', a.scenes[0].name))).mode & 0o777, 0o600);
    assert.equal(a.fixtureId, b.fixtureId); assert.equal(a.fixtureSha256, b.fixtureSha256);
    assert.equal(a.sceneCount, 6); assert.deepEqual(a.scenes.slice(0, 3).map(scene => scene.bodyBytes), [1024, 102400, 1048576]);
    for (const scene of a.scenes) assert.equal(Buffer.byteLength(await readFile(join(root, 'a/seed', scene.name))), scene.bodyBytes);
    assert.equal(git(join(root, 'a/seed'), 'ls-files').split('\n').length, 7);
    await assert.rejects(generate(join(root, 'a'), 'small'), { code: 'EEXIST' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('fixture import rejects same-size content changes and manifest plan drift', async () => {
  const root = await mkdtemp(join(tmpdir(), 'postgres-fixture-identity-'));
  try {
    const path = join(root, 'fixture');
    const manifest = await generate(path, 'small');
    assert.equal((await verifyFixture(path)).manifest.fixtureId, manifest.fixtureId);
    const scenePath = join(path, 'seed', manifest.scenes[0].name);
    const body = await readFile(scenePath);
    const changed = Buffer.from(body); changed[0] = changed[0] === 65 ? 66 : 65;
    await writeFile(scenePath, changed);
    await assert.rejects(verifyFixture(path), /Fixture content identity mismatch/u);
    await writeFile(scenePath, body);
    const manifestPath = join(path, 'dataset.json');
    await writeFile(manifestPath, JSON.stringify({ ...manifest, chapterCount: manifest.chapterCount + 1 }));
    await assert.rejects(verifyFixture(path), /Fixture manifest and transport plan mismatch/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('performance database safety accepts disposable loopback targets and rejects remote or unrelated databases', async () => {
  const { databaseTarget } = await import('./postgres-fixture.mjs');
  assert.equal(databaseTarget('postgres://codexia:synthetic@127.0.0.1:55440/codexia_perf_baseline').database, 'codexia_perf_baseline');
  assert.deepEqual(databaseTarget('postgres://codexia:synthetic@127.0.0.1/codexia_perf_baseline?host=localhost&port=55440&user=codexia_perf_user'),
    { host: 'localhost', hostaddr: null, port: 55440, database: 'codexia_perf_baseline', user: 'codexia_perf_user', sslMode: 'default' });
  assert.throws(() => databaseTarget('postgres://codexia:synthetic@db.example.test/codexia_perf_baseline'), /loopback/u);
  assert.throws(() => databaseTarget('postgres://codexia:synthetic@localhost/codexia_perf_baseline?hostaddr=8.8.8.8'), /loopback/u);
  assert.throws(() => databaseTarget('postgres://codexia:synthetic@localhost/codexia_perf_baseline?host=db.example.test'), /loopback/u);
  assert.throws(() => databaseTarget('postgres://codexia:synthetic@localhost/codexia_perf_baseline?service=remote'), /loopback/u);
  assert.throws(() => databaseTarget('postgres://codexia:synthetic@localhost/codexia_perf_baseline?dbname=codexia'), /override/u);
  assert.throws(() => databaseTarget('postgres://codexia:synthetic@localhost/codexia_perf_baseline?port=70000'), /valid PostgreSQL port/u);
  assert.throws(() => databaseTarget('postgres://codexia:synthetic@127.0.0.1/codexia'), /Disposable performance database/u);
});
test('node interception counts Git through sync and async process APIs while preserving promisified execFile errors', async () => {
  const { counts } = await import('./instrument-node.mjs');
  const cp = await import('node:child_process');
  const run = promisify(cp.execFile), before = counts.gitProcesses;
  assert.match((await run('git', ['--version'])).stdout, /^git version/);
  assert.equal(counts.gitProcesses, before + 1);
  assert.match(cp.execFileSync('git', ['--version'], { encoding: 'utf8' }), /^git version/);
  assert.match(cp.spawnSync('git', ['--version'], { encoding: 'utf8' }).stdout, /^git version/);
  assert.match(cp.execSync('git --version', { encoding: 'utf8' }), /^git version/);
  assert.equal(counts.gitProcesses, before + 4);
  await assert.rejects(run('git', ['--invalid-benchmark-argument']), error => error.code !== 0 && typeof error.stderr === 'string');
  assert.equal(counts.gitProcesses, before + 5);
});
const realDelay = promisify(setTimeout);

async function runUntilWorkerReports(testContext, worker, output) {
  const timeoutMs = 500;
  testContext.mock.timers.enable({ apis: ['setTimeout'] });
  const running = runWorker(worker, [output], output, timeoutMs);
  try {
    const deadline = performance.now() + 10_000;
    for (;;) {
      try {
        await lstat(output);
        break;
      } catch (error) {
        if (error.code !== 'ENOENT' || performance.now() >= deadline) throw error;
      }
      await realDelay(20);
    }
  } finally {
    testContext.mock.timers.tick(timeoutMs);
    testContext.mock.timers.reset();
    await running;
  }
  return running;
}

test('worker timeout retains completed evidence without claiming completion', async (testContext) => {
  const root = await mkdtemp(join(tmpdir(), 'wave0-worker-'));
  try {
    const worker = join(root, 'hang.mjs'), output = join(root, 'result.json');
    await writeFile(worker, `import { renameSync, writeFileSync } from 'node:fs'; const output=process.argv[2]; writeFileSync(output+'.tmp', JSON.stringify({status:'running',samples:[{name:'completed',status:'complete',ms:12,appWallMs:12}]})); renameSync(output+'.tmp', output); setInterval(()=>{},1000);`);
    const result = await runUntilWorkerReports(testContext, worker, output);
    assert.equal(result.status, 'NOT_CHECKED'); assert.equal(result.execution.timeout, true);
    assert.equal(result.samples[0].ms, 12);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('browser API latency separates successful responses from rejection and failure responses', async () => {
  const { summarizeBrowser } = await import('./summarize.mjs');
  const save = '/api/v1/persistence/projects/fixture/documents/scene';
  const absent = '/api/v1/persistence/projects/absent';
  const result = summarizeBrowser({
    server: { requests: [
      { method: 'PUT', path: save, status: 200, ms: 16, responseBytes: 500 },
      { method: 'PUT', path: save, status: 409, ms: 4, responseBytes: 200 },
      { method: 'PUT', path: save, status: 500, ms: 91, responseBytes: 48 },
      { method: 'GET', path: absent, status: 404, ms: 2, responseBytes: 30 },
    ] },
  });
  assert.deepEqual(result.api['PUT ' + save].ms, { n: 1, p50: 16, p95: 16, p99: 16, max: 16 });
  assert.deepEqual(result.api['PUT ' + save].statusCounts, { 200: 1, 409: 1, 500: 1 });
  assert.equal(result.api['PUT ' + save].nonSuccessMsByStatus[409].p95, 4);
  assert.equal(result.api['PUT ' + save].nonSuccessMsByStatus[500].p95, 91);
  assert.equal(result.api['GET ' + absent].ms.n, 0);
  assert.equal(result.api['GET ' + absent].nonSuccessMsByStatus[404].p95, 2);
});

test('browser summaries distinguish completed strict writes from pending or aborted transactions', async () => {
  const { summarizeBrowser } = await import('./summarize.mjs');
  const browser = { inputs: [{ type: 'keydown', key: 'a', start: 2, frameMs: 12 }], reactCommits: [], longTasks: [],
    reads: [{ start: 2, method: 'getAll', records: 3 }], transactions: [
      { start: 2, mode: 'readwrite', durability: 'strict', status: 'complete', ms: 5 },
      { start: 2, mode: 'readwrite', durability: 'strict', status: 'pending' },
      { start: 2, mode: 'readwrite', durability: 'strict', status: 'aborted', ms: 8 },
    ] };
  const result = summarizeBrowser({ status: 'NOT_CHECKED', phases: [{ name: 'browser.authoring.1024', start: 1, end: 3, browser }], samples: [], requests: [] });
  assert.equal(result.status, 'NOT_CHECKED');
  assert.equal(result.inputs[0].strictWriteMs.n, 1);
  assert.equal(result.inputs[0].strictWriteMs.p95, 5);
  assert.deepEqual(result.inputs[0].transactions, { total: 3, pending: 1, aborted: 1 });
  assert.equal(result.inputs[0].reads.returnedRecords, 3);
});

test('worker timeout also terminates a detached descendant', { skip: process.platform !== 'linux' }, async (testContext) => {
  const root = await mkdtemp(join(tmpdir(), 'wave0-detached-'));
  try {
    const worker = join(root, 'worker.mjs'), output = join(root, 'result.json');
    await writeFile(worker, `import { spawn } from 'node:child_process'; import { renameSync, writeFileSync } from 'node:fs'; const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'}); const output=process.argv[2]; writeFileSync(output+'.tmp',JSON.stringify({status:'running',samples:[],descendantPid:child.pid})); renameSync(output+'.tmp', output); setInterval(()=>{},1000);`);
    const result = await runUntilWorkerReports(testContext, worker, output);
    assert.equal(result.status, 'NOT_CHECKED');
    assert.equal(result.execution.timeout, true);
    assert.equal(result.execution.cleanupError, undefined, 'cleanup must be confirmed before returning');
    assert.ok(Number.isInteger(result.descendantPid) && result.descendantPid > 0, 'fixture must record a real detached child');
    // An exited descendant can remain a zombie briefly until the host reaps it.
    let state = 'missing';
    try { state = (await readFile(`/proc/${result.descendantPid}/stat`, 'utf8')).split(') ')[1].split(' ')[0]; }
    catch (error) {
      // proc_single_show can return ESRCH if the PID exits after the proc inode opens.
      assert.ok(['ENOENT', 'ESRCH'].includes(error.code), `Unexpected procfs read error: ${error.code}`);
    }
    assert.ok(['missing', 'Z'].includes(state), `Detached child remained live: ${state}`);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('PostgreSQL author pipeline records receipts without manuscript Git processes and leaves the import source immutable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wave0-pipeline-'));
  try {
    const datasetPath = join(root, 'fixture'), output = join(root, 'result.json');
    const fixture = await generate(datasetPath, 'small');
    const result = await runWorker(new URL('./core.mjs', import.meta.url).pathname,
      [datasetPath, output, '1', 'mutation'], output, 30000);
    assert.equal(result.status, 'complete', JSON.stringify(result.error));
    assert.equal(result.execution.code, 0);
    for (const name of ['document.save', 'proposal.create', 'proposal.approval', 'operation.apply.receipt', 'application.receipt.replay']) {
      const sample = result.samples.find(row => row.name === name);
      assert.ok(sample && sample.status === 'complete' && sample.ms > 0 && sample.counters.gitProcesses === 0, name);
    }
    assert.equal(git(join(datasetPath, 'seed'), 'rev-parse', 'HEAD'), fixture.transport.commit);
    const { manifest: verified } = await verifyFixture(datasetPath);
    assert.equal(verified.fixtureSha256, fixture.fixtureSha256, 'post-workload fixture must match its original content identity');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Knowledge-dense PostgreSQL fixture persists exact Knowledge and Evidence counts and a readable projection', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wave0-knowledge-fixture-'));
  try {
    const datasetPath = join(root, 'fixture'), output = join(root, 'result.json');
    await generate(datasetPath, 'knowledge-dense');
    const result = await runWorker(new URL('./core.mjs', import.meta.url).pathname,
      [datasetPath, output, '1', 'projection'], output, 120000);
    assert.equal(result.status, 'complete', JSON.stringify(result.error));
    assert.deepEqual(result.fixture.knowledgeSeed, { nodes: 100, aliases: 200, anchors: 400, assertions: 100 });
    assert.deepEqual({ nodes: result.fixture.persisted.knowledge.nodes, aliases: result.fixture.persisted.knowledge.aliases,
      relations: result.fixture.persisted.knowledge.relations }, { nodes: 100, aliases: 200, relations: 0 });
    assert.ok(result.fixture.persisted.knowledge.tupleBytes > 0);
    assert.equal(result.fixture.persisted.evidence.anchors, 400);
    assert.equal(result.fixture.persisted.evidence.mentions, 400);
    assert.equal(result.fixture.persisted.evidence.assertions, 100);
    assert.equal(result.fixture.persisted.evidence.assertionLinks, 100);
    assert.equal(result.projection.kind, 'knowledge-projection');
    assert.match(result.projection.revision, /^[a-f0-9]{64}$/u);
    assert.ok(result.projection.bytes > 0);
    const projection = result.samples.find(row => row.name === 'knowledge.evidence.projection');
    assert.ok(projection?.status === 'complete' && projection.counters.gitProcesses === 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('PostgreSQL browser benchmark exercises the current UI and save/receipt path', { skip: !process.env.CODEXIA_E2E_CHROMIUM && process.env.CODEXIA_PERF_BROWSER_SMOKE !== '1' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'postgres-browser-benchmark-'));
  try {
    const datasetPath = join(root, 'fixture'), output = join(root, 'browser.json');
    await generate(datasetPath, 'small');
    const result = await runWorker(new URL('./browser.mjs', import.meta.url).pathname,
      [datasetPath, output, '1'], output, 180000, { CODEXIA_PROFILE: 'core', BENCH_BROWSER_SAVE_REPEATS: '1' });
    assert.equal(result.status, 'complete', JSON.stringify(result.error));
    assert.equal(result.samples.filter(row => row.name === 'browser.navigation.repeat').length, 1);
    assert.equal(result.samples.filter(row => row.name === 'browser.authoring.save-and-receipt').length, 3);
    assert.match(result.harness.browserAssets.sha256, /^[a-f0-9]{64}$/u);
    assert.ok(result.server.requests.some(row => row.method === 'POST' &&
      row.path === '/api/auth/oauth2/token' && row.status === 200));
    assert.equal(result.server.counts.gitProcesses, 0);
    assert.equal(result.network.failed, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('browser probes retain strict IDB semantics and count document index reads', { skip: !process.env.CODEXIA_E2E_CHROMIUM }, async () => {
  const { chromium } = await import('@playwright/test');
  const { installBrowserProbes } = await import('./browser-probes.mjs');
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CODEXIA_E2E_CHROMIUM });
  try {
    const context = await browser.newContext();
    await context.addInitScript(installBrowserProbes);
    const page = await context.newPage();
    await page.route('http://127.0.0.1/benchmark', route => route.fulfill({ contentType: 'text/html', body: '<p>Synthetic probe test</p>' }));
    await page.goto('http://127.0.0.1/benchmark');
    const result = await page.evaluate(async () => {
      const database = await new Promise((resolve, reject) => {
        const request = indexedDB.open('synthetic-probe', 1);
        request.onupgradeneeded = () => request.result.createObjectStore('operations', { keyPath: 'id' }).createIndex('documentKey', 'documentKey');
        request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
      });
      const tx = database.transaction('operations', 'readwrite', { durability: 'strict' });
      const complete = new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onabort = () => reject(tx.error); });
      tx.objectStore('operations').put({ id: 'a', documentKey: 'synthetic' });
      const request = tx.objectStore('operations').index('documentKey').getAll('synthetic');
      const rows = await new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
      await complete; database.close();
      return { rows, metrics: structuredClone(window.__wave0) };
    });
    assert.equal(result.rows.length, 1);
    assert.ok(result.metrics.transactions.some(tx => tx.durability === 'strict' && tx.status === 'complete'));
    assert.ok(result.metrics.reads.some(read => read.source === 'index' && read.index === 'documentKey' && read.records === 1 && read.status === 'complete'));
  } finally { await browser.close(); }
});
