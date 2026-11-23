import { counts, gitCommands, startLockSampler } from './instrument-node.mjs';
import { hashTree, io } from './common.mjs';
import { postgresFixture } from './postgres-fixture.mjs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from '../../packages/api/dist/server.js';
import { assertDisposableAuthFixtureDatabaseUrl, startBetterAuthFixture } from '../../packages/api/test/fixtures/better-auth-server.ts';
import { buildAuthorBrowserAssets } from '../../tests/e2e/author-oauth-server.ts';
import { tmpdir } from 'node:os';
import { performance } from 'node:perf_hooks';
import { resolve, join } from 'node:path';

const requests = [];
let fixture, lockSampler, author, assets;
let stopped = false;

function observeRequests(server) {
  server.prependListener('request', (request, response) => {
    const at = performance.now();
    let responseBytes = 0;
    const addBytes = chunk => {
      if (chunk !== undefined && chunk !== null && typeof chunk !== 'function') responseBytes += Buffer.byteLength(chunk);
    };
    const write = response.write;
    const end = response.end;
    response.write = function(chunk, ...args) { addBytes(chunk); return Reflect.apply(write, this, [chunk, ...args]); };
    response.end = function(chunk, ...args) { addBytes(chunk); return Reflect.apply(end, this, [chunk, ...args]); };
    response.once('finish', () => requests.push({ method: request.method, path: request.url.split('?')[0],
      startMs: at, ms: performance.now() - at, status: response.statusCode, responseBytes }));
  });
}

function snapshot() {
  return { requests: [...requests], counts: { ...counts }, gitCommands: [...gitCommands],
    cpu: process.cpuUsage(), memory: process.memoryUsage(), usage: process.resourceUsage(), io: null };
}

async function shutdown() {
  if (stopped) return;
  stopped = true;
  try {
    await author?.close();
  } finally {
    const results = await Promise.allSettled([
      lockSampler?.stop(), fixture?.persistence.close(), assets && rm(assets, { recursive: true, force: true }),
    ]);
    const failure = results.find(result => result.status === 'rejected');
    if (failure) throw failure.reason;
  }
}

try {
  const datasetPath = resolve(process.argv[2]);
  const dataset = JSON.parse(await readFile(join(datasetPath, 'dataset.json'), 'utf8'));
  const databaseUrl = process.env.CODEXIA_TEST_DATABASE_URL;
  assertDisposableAuthFixtureDatabaseUrl(databaseUrl);
  fixture = await postgresFixture(datasetPath);
  lockSampler = await startLockSampler(databaseUrl, Number(process.env.CODEXIA_PERF_LOCK_POLL_MS ?? 25));
  assets = await mkdtemp(join(tmpdir(), 'codexia-perf-browser-'));
  const authStart = performance.now();
  let serverStart;
  author = await startBetterAuthFixture({
    databaseUrl,
    domain: fixture,
    staticDirectory: assets,
    createApiServer(options) {
      serverStart = performance.now();
      return createServer(options);
    },
    observeApiServer: observeRequests,
  });
  const buildStart = performance.now();
  buildAuthorBrowserAssets(author, 'core', assets);
  const browserAssetBuildMs = performance.now() - buildStart;
  const { files, sha256 } = await hashTree(assets);
  const sceneSummaries = fixture.sceneRecords.map(row => ({ id: row.document.id, title: row.title,
    revisionId: row.revision.id, bytes: Buffer.byteLength(row.revision.markdown) }));
  process.send({ ready: true, origin: author.apiOrigin, startupMs: buildStart - serverStart,
    authFixtureSetupMs: serverStart - authStart, browserAssetBuildMs, browserAssets: { files, sha256 },
    fixtureSetupMs: fixture.setupMs, profile: dataset.datasetId,
    fixture: { project: { id: fixture.project.id, title: fixture.project.title }, scenes: sceneSummaries,
      persisted: fixture.inventory, database: fixture.database, knowledgeSeed: fixture.knowledgeSeed ?? null } });
} catch (error) {
  process.send({ ready: false, error: error.stack ?? error.message });
  await shutdown().catch(() => undefined);
  process.exitCode = 1;
  process.disconnect();
}

process.on('message', async message => {
  if (message === 'stats') {
    process.send({ ...snapshot(), io: await io(), lockWaitSamplingIntervalMs: lockSampler.intervalMs });
  }
  if (message === 'stop') {
    try { await shutdown(); process.exit(0); }
    catch (error) { process.send({ stopped: false, error: error.message }); process.exitCode = 1; }
  }
});
process.on('disconnect', () => { void shutdown().catch(() => undefined); });
