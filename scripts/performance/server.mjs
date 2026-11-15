import { counts, gitCommands, startLockSampler } from './instrument-node.mjs';
import { io } from './common.mjs';
import { postgresFixture } from './postgres-fixture.mjs';
import { readFile } from 'node:fs/promises';
import { createServer } from '../../packages/api/dist/server.js';
import { performance } from 'node:perf_hooks';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';

const token = 'synthetic-benchmark-local-token-000000';
const datasetPath = resolve(process.argv[2]);
const dataset = JSON.parse(await readFile(join(datasetPath, 'dataset.json'), 'utf8'));
const fixture = await postgresFixture(datasetPath);
const lockSampler = await startLockSampler(process.env.CODEXIA_TEST_DATABASE_URL,
  Number(process.env.CODEXIA_PERF_LOCK_POLL_MS ?? 25));
const requests = [];
const serverStart = performance.now();
const server = createServer({ store: fixture.store, persistence: fixture.persistence, authToken: token,
  profile: 'core', staticDir: resolve('app/dist'), usageDirectory: join(resolve(process.argv[2]), `browser-usage-${randomUUID()}`) });
let stopped = false;

server.prependListener('request', (request, response) => {
  const at = performance.now();
  let responseBytes = 0;
  const addBytes = chunk => {
    if (chunk === undefined || chunk === null) return;
    responseBytes += typeof chunk === 'string' ? Buffer.byteLength(chunk) : Buffer.byteLength(chunk);
  };
  const write = response.write;
  const end = response.end;
  response.write = function(chunk, ...args) { addBytes(chunk); return Reflect.apply(write, this, [chunk, ...args]); };
  response.end = function(chunk, ...args) { addBytes(chunk); return Reflect.apply(end, this, [chunk, ...args]); };
  response.once('finish', () => requests.push({ method: request.method, path: request.url.split('?')[0],
    startMs: at, ms: performance.now() - at, status: response.statusCode,
    responseBytes }));
});

function snapshot() {
  return { requests: [...requests], counts: { ...counts }, gitCommands: [...gitCommands],
    cpu: process.cpuUsage(), memory: process.memoryUsage(), usage: process.resourceUsage(), io: null };
}

async function shutdown() {
  if (stopped) return;
  stopped = true;
  await new Promise((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()));
  await lockSampler.stop();
  await fixture.persistence.close();
}

try {
  server.listen(0, '127.0.0.1', () => {
    const sceneSummaries = fixture.sceneRecords.map(row => ({ id: row.document.id, title: row.title,
      revisionId: row.revision.id, bytes: Buffer.byteLength(row.revision.markdown) }));
    process.send({ ready: true, port: server.address().port, startupMs: performance.now() - serverStart,
      fixtureSetupMs: fixture.setupMs, profile: dataset.datasetId,
      fixture: { project: { id: fixture.project.id, title: fixture.project.title }, scenes: sceneSummaries,
        persisted: fixture.inventory, database: fixture.database, knowledgeSeed: fixture.knowledgeSeed ?? null } });
  });
} catch (error) {
  process.send({ ready: false, error: error.stack ?? error.message });
  await shutdown().catch(() => undefined);
  process.exitCode = 1;
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
