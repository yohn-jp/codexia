import { counts, gitCommands, resetMeasurements, startLockSampler } from './instrument-node.mjs';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { buildIdentity, measure, save, distribution, sourceIdentity } from './common.mjs';
import { postgresFixture } from './postgres-fixture.mjs';

const [datasetPath, output, repeatsArg = '20', workload = 'all'] = process.argv.slice(2);
const dataset = JSON.parse(await readFile(join(datasetPath, 'dataset.json'), 'utf8'));
const repeats = Number(repeatsArg);
if (!Number.isInteger(repeats) || repeats < 1) throw new Error('Repeat count must be a positive integer');
const harness = { source: sourceIdentity(), build: await buildIdentity(),
  scriptSha256: createHash('sha256').update(await readFile(new URL(import.meta.url))).digest('hex') };
resetMeasurements();
const report = { schemaVersion: 2, harness, dataset, profile: 'core', node: process.version, workload,
  runtimeAuthority: 'PostgreSQL', gitRole: 'synthetic-fixture-transport-only', samples: [], summaries: {},
  rejections: [], failures: [], gitCommands, status: 'running', conditions: { repeats,
    snapshotCache: 'fresh process; first current manifest materialization is cold at the Core layer; database OS/shared-buffer state is not flushed',
    pinnedSnapshot: 'first durable pinned read and repeated pinned reads are reported separately',
    lockWait: 'PostgreSQL pg_stat_activity Lock states sampled from a separate observer connection' } };

let fixture, lockSampler;
async function persist() { await save(resolve(output), report); }
async function sample(name, action) {
  report.pending = { name, startedAt: new Date().toISOString() };
  await persist();
  const before = { ...counts };
  try {
    const result = await measure(name, action, () => counts);
    await lockSampler?.flush();
    result.sample.counters = Object.fromEntries(Object.keys(counts).map(key => [key, counts[key] - (before[key] ?? 0)]));
    if (result.sample.counters.gitProcesses > 0) throw new Error('PostgreSQL Core workload invoked Git at runtime');
    result.sample.sqlRoundTripMs = result.sample.counters.pgQueryRoundTripMs;
    result.sample.poolAcquireMs = result.sample.counters.pgPoolAcquireMs;
    result.sample.transactionWallMs = result.sample.counters.pgTransactionWallMs;
    result.sample.lockBearingStatementWallMs = result.sample.counters.pgLockStatementRoundTripMs;
    result.sample.lockWaitObservedMs = result.sample.counters.pgLockWaitObservedMs;
    report.samples.push(result.sample);
    report.summaries[name] = distribution(report.samples.filter(row => row.name === name && row.status === 'complete').map(row => row.appWallMs));
    delete report.pending;
    await persist();
    return result.value;
  } catch (error) {
    delete report.pending;
    report.failures.push({ name, status: 'failed', code: error.code, message: error.message });
    await persist();
    throw error;
  }
}

async function readWorkloads(store, project, sceneRecords, repeats) {
  const cold = await sample('snapshot.materialize.cold', () => store.readTreeSnapshot(project.id));
  for (let index = 0; index < repeats; index++) {
    await sample('snapshot.current.warm', () => store.readTreeSnapshot(project.id));
    await sample('snapshot.scene.current', () => store.readSceneSnapshot(project.id, sceneRecords[index % sceneRecords.length].document.id));
  }
  await sample('snapshot.pinned.first', () => store.readTreeSnapshot(project.id, cold.snapshot));
  const pinnedReader = await sample('snapshot.reader.pinned.first', () => store.reader(project.id, cold.snapshot));
  for (let index = 0; index < repeats; index++) {
    await sample('snapshot.pinned.warm', () => store.readTreeSnapshot(project.id, cold.snapshot));
    await sample('snapshot.scene.pinned', () => store.readSceneSnapshot(project.id, sceneRecords[index % sceneRecords.length].document.id, cold.snapshot));
  }
  await measureKnowledgeProjection(pinnedReader);
  await sample('tree.retrieve', () => store.readTreeSnapshot(project.id, cold.snapshot));
}

async function measureKnowledgeProjection(reader) {
  const projection = await sample('knowledge.evidence.projection', () => reader.knowledge);
  if (!projection) throw new Error('PostgreSQL Knowledge/Evidence projection is missing from the pinned Core snapshot');
  const content = JSON.stringify(projection);
  report.projection = { kind: projection.source.kind, bytes: Buffer.byteLength(content), revision: projection.source.revision,
    sha256: createHash('sha256').update(content).digest('hex') };
}

async function historyWorkloads(persistence, project, target, repeats) {
  for (let index = 0; index < repeats; index++) {
    const page = await sample('history.list', () => persistence.read(reader => reader.listRevisions(project.id, target.document.id, 100)));
    await sample('history.revision.bodies', () => persistence.read(async reader => {
      const bodies = [];
      for (const revision of page.revisions) bodies.push(await reader.getRevision(project.id, target.document.id, revision.id));
      return bodies;
    }));
  }
}

async function mutationWorkloads(store, persistence, project, target, repeats) {
  for (let index = 0; index < repeats; index++) {
    const latest = await persistence.read(async reader => {
      const document = await reader.getDocument(project.id, target.document.id);
      return { document, revision: document && await reader.getRevision(project.id, target.document.id, document.headRevisionId) };
    });
    if (!latest.document || !latest.revision) throw new Error('Mutation target is missing its current revision');
    const savedMarkdown = `${latest.revision.markdown}\nSynthetic PostgreSQL save ${index}.`;
    await sample('document.save', () => persistence.transaction(transaction => transaction.saveDocument({
      projectId: project.id, documentId: latest.document.id, baseRevisionId: latest.revision.id,
      changes: [{ fromUtf16: 0, toUtf16: latest.revision.markdown.length, insert: savedMarkdown }],
      resultingSha256: createHash('sha256').update(savedMarkdown).digest('hex'), authorId: 'synthetic-benchmark-author',
      clientId: 'performance-harness', idempotencyKey: `benchmark-save:${randomUUID()}` })));
    const current = await sample('mutation.snapshot.prepare', () => store.readSceneSnapshot(project.id, target.document.id));
    const operation = { id: randomUUID(), generation: 1, projectId: project.id,
      baseProjectVersion: current.snapshot.projectVersion, effect: 'manuscript',
      reads: [{ path: current.document.path, revision: current.document.revision }],
      writes: [{ path: current.document.path, revision: current.document.revision,
        content: `${current.document.content}\nSynthetic approved operation ${index}.` }],
      message: `Synthetic benchmark operation ${index}` };
    const proposal = { id: `benchmark-proposal-${randomUUID()}`, snapshot: current.snapshot,
      operations: [operation], source: 'author' };
    await sample('proposal.create', () => store.propose(project.id, proposal));
    await sample('proposal.approval', () => store.approve(project.id, { proposalId: proposal.id,
      operationIds: [operation.id], authorScope: 'synthetic-benchmark-author' }));
    const receipt = await sample('operation.apply.receipt', () => store.apply(project.id, operation));
    if (receipt.operationId !== operation.id) throw new Error('Apply receipt operation mismatch');
    const replay = await sample('application.receipt.replay', () => store.apply(project.id, operation));
    if (replay.operationId !== operation.id) throw new Error('Persisted receipt replay mismatch');
  }
}

async function boundaryWorkload(store, project, manifest) {
  const startedAt = performance.now();
  const before = { ...counts };
  try {
    const measured = await measure('snapshot.materialize.boundary', () => store.readTreeSnapshot(project.id), () => counts);
    await lockSampler?.flush();
    measured.sample.counters = Object.fromEntries(Object.keys(counts).map(key => [key, counts[key] - (before[key] ?? 0)]));
    if (measured.sample.counters.gitProcesses > 0) throw new Error('PostgreSQL Core workload invoked Git at runtime');
    measured.sample.sqlRoundTripMs = measured.sample.counters.pgQueryRoundTripMs;
    measured.sample.poolAcquireMs = measured.sample.counters.pgPoolAcquireMs;
    measured.sample.transactionWallMs = measured.sample.counters.pgTransactionWallMs;
    measured.sample.lockBearingStatementWallMs = measured.sample.counters.pgLockStatementRoundTripMs;
    measured.sample.lockWaitObservedMs = measured.sample.counters.pgLockWaitObservedMs;
    report.samples.push(measured.sample);
    report.support = { status: 'supported', documentCount: manifest.documentCount,
      snapshot: measured.value.snapshot, treeBytes: measured.sample.resultBytes };
  } catch (error) {
    if (error.code !== 'snapshot_too_large') throw error;
    await lockSampler?.flush();
    const rejectionWallMs = performance.now() - startedAt;
    const counters = Object.fromEntries(Object.keys(counts).map(key => [key, counts[key] - (before[key] ?? 0)]));
    report.rejections.push({ name: 'snapshot.materialize.boundary', status: 'rejected', code: error.code,
      rejectionWallMs, documentCount: manifest.documentCount, counters });
    report.support = { status: 'rejected', documentCount: manifest.documentCount, code: error.code };
  }
}

try {
  fixture = await postgresFixture(datasetPath);
  report.fixture = { projectId: fixture.project.id, projectVersion: fixture.project.version,
    setupMs: fixture.setupMs, persisted: fixture.inventory, database: fixture.database,
    knowledgeSeed: fixture.knowledgeSeed ?? null, sceneCount: fixture.sceneRecords.length,
    historyTarget: { documentId: fixture.historyTarget.document.id, revisionId: fixture.historyTarget.revision.id } };
  await persist();
  lockSampler = await startLockSampler(process.env.CODEXIA_TEST_DATABASE_URL,
    Number(process.env.CODEXIA_PERF_LOCK_POLL_MS ?? 25));
  if (workload === 'boundary' || dataset.documentCount >= 999) {
    await boundaryWorkload(fixture.store, fixture.project, dataset);
  } else {
    const selected = workload === 'all' ? ['read', 'projection', 'search', 'stats', 'revisions', 'mutation'] : [workload];
    if (selected.includes('read')) await readWorkloads(fixture.store, fixture.project, fixture.sceneRecords, repeats);
    if (selected.includes('projection') && !selected.includes('read')) {
      const reader = await fixture.store.reader(fixture.project.id);
      await measureKnowledgeProjection(reader);
    }
    if (selected.includes('tree')) await sample('tree.retrieve', () => fixture.store.readTreeSnapshot(fixture.project.id));
    if (selected.includes('scene')) await sample('scene.retrieve', () => fixture.store.readSceneSnapshot(fixture.project.id, fixture.sceneRecords[0].document.id));
    if (selected.includes('search')) for (let index = 0; index < repeats; index++) {
      await sample('literal.search', () => fixture.store.searchSnapshot(fixture.project.id, 'benchmarkneedle', 20));
    }
    if (selected.includes('stats')) for (let index = 0; index < repeats; index++) {
      await sample('writing.statistics', () => fixture.store.writingStatsSnapshot(fixture.project.id));
    }
    if (selected.includes('revisions')) await historyWorkloads(fixture.persistence, fixture.project, fixture.historyTarget, repeats);
    if (selected.includes('mutation')) await mutationWorkloads(fixture.store, fixture.persistence, fixture.project, fixture.historyTarget, repeats);
  }
  report.status = 'complete';
} catch (error) {
  report.status = 'failed'; report.error = { message: error.message, code: error.code, stack: error.stack };
  process.exitCode = 1;
} finally {
  const cleanup = async (action) => {
    try { await action(); }
    catch (error) {
      (report.cleanupErrors ??= []).push(error.message);
      report.status = 'failed';
      process.exitCode = 1;
    }
  };
  if (lockSampler) await cleanup(() => lockSampler.stop());
  if (fixture?.persistence) await cleanup(() => fixture.persistence.close());
  if (lockSampler) report.conditions.lockWaitSamplingIntervalMs = lockSampler.intervalMs;
  await persist();
}
