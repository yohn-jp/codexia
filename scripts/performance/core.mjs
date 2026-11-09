import { counts, gitCommands } from './instrument-node.mjs';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { git } from './dataset.mjs';
import { measure, save, distribution } from './common.mjs';
import { postgresFixture } from './postgres-fixture.mjs';
const [datasetPath, output, repeatsArg = '20', workload = 'read'] = process.argv.slice(2);
const dataset = JSON.parse(await readFile(join(datasetPath, 'dataset.json'), 'utf8'));
const harness = { source: git(process.cwd(), 'rev-parse', 'HEAD'), scriptSha256: createHash('sha256').update(await readFile(new URL(import.meta.url))).digest('hex') };
const report = { harness, dataset, profile: 'core', node: process.version, workload, samples: [], summaries: {}, gitCommands, status: 'running' };
async function sample(name, action) {
  report.pending = { name, startedAt: new Date().toISOString() }; await save(output, report);
  const result = await measure(name, action, () => ({ ...counts }));
  delete report.pending;
  report.samples.push(result.sample);
  report.summaries[name] = distribution(report.samples.filter(s => s.name === name).map(s => s.ms));
  await save(output, report);
  return result.value;
}
try {
  const fixture = await sample('project.seed', () => postgresFixture(datasetPath));
  const { store, project, scenes, persistence } = fixture;
  try {
  if (workload === 'read') {
  await sample('tree.cold', () => store.readTreeSnapshot(project.id));
  const repeats = Number(repeatsArg);
  for (let i = 0; i < repeats; i++) {
    await sample('tree.warm', () => store.readTreeSnapshot(project.id));
    await sample('snapshot.scene', () => store.readSceneSnapshot(project.id, scenes[i % scenes.length]));
  }
  }
  if (workload === 'mutation') {
  const repeats = Number(repeatsArg);
  // Keep the author proposal/approval/checkpoint path distinct from legacy saveScene.
  for (let i = 0; i < Math.min(repeats, 5); i++) {
      const scene = await sample('mutation.prepare', () => store.readSceneSnapshot(project.id, scenes[0]));
      const operation = { id: randomUUID(), generation: 1, projectId: project.id,
        baseProjectVersion: scene.snapshot.projectVersion, effect: 'manuscript',
        reads: [{ path: scene.document.path, revision: scene.document.revision }],
        writes: [{ path: scene.document.path, revision: scene.document.revision, content: `${scene.document.content}\nSynthetic database revision ${i}.` }],
        message: `Synthetic database revision ${i}` };
      const proposal = await sample('proposal', () => store.propose(project.id, { id: `proposal_${operation.id}`, snapshot: scene.snapshot, operations: [operation], source: 'author' }));
      await sample('approval', () => store.approve(project.id, { proposalId: proposal.id, operationIds: [operation.id], authorScope: 'synthetic-benchmark-author' }));
      const receipt = await sample('apply', () => store.apply(project.id, operation));
      if (receipt.operationId !== operation.id) throw new Error('Application receipt operation mismatch');
  }
  }
  if (workload === 'search') await sample('search.scan', () => store.searchSnapshot(project.id, 'wave0-absent-needle-9f742e', 20));
  if (workload === 'stats') await sample('stats.scan', () => store.writingStatsSnapshot(project.id));
  if (workload === 'revisions') {
    const reader = await sample('reader.create', () => store.reader(project.id));
    await sample('reader.list', () => reader.list(''));
    await sample('reader.listRevisions.cold', () => reader.listRevisions(''));
    await sample('reader.listRevisions.warm', () => reader.listRevisions(''));
  }
  report.status = 'complete';
  } finally { await persistence.close(); }
} catch (error) { report.status = 'failed'; report.error = { message: error.message, code: error.code }; process.exitCode = 1; }
await save(resolve(output), report);
