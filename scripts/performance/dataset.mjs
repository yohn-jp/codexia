import { createHash } from 'node:crypto';
import { mkdir, writeFile, readFile, stat } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const scenarios = {
  small: { documentCount: 8, volumes: 1, chapters: 1, defaultBodyBytes: 4096, historyRevisions: 3 },
  'long-form': { documentCount: 400, volumes: 2, chapters: 20, defaultBodyBytes: 4096, historyRevisions: 10 },
  'knowledge-dense': { documentCount: 100, volumes: 1, chapters: 5, defaultBodyBytes: 2048, historyRevisions: 5,
    knowledge: { nodes: 100, aliasesPerNode: 2, evidencePerNode: 4, assertionsPerNode: 1 } },
  'limit-999': { documentCount: 999, volumes: 1, chapters: 1, defaultBodyBytes: 1024, historyRevisions: 1 },
  'limit-1000': { documentCount: 1000, volumes: 1, chapters: 1, defaultBodyBytes: 1024, historyRevisions: 1 },
  'limit-1001': { documentCount: 1001, volumes: 1, chapters: 1, defaultBodyBytes: 1024, historyRevisions: 1 },
};

export const sizes = Object.fromEntries(Object.entries(scenarios).map(([name, spec]) => [name, spec.documentCount]));

export function git(cwd, ...args) {
  return execFileSync('git', ['-c', 'gc.auto=0', '-c', 'maintenance.auto=false', ...args], { cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_AUTHOR_NAME: 'Synthetic Benchmark', GIT_AUTHOR_EMAIL: 'benchmark@example.invalid',
      GIT_COMMITTER_NAME: 'Synthetic Benchmark', GIT_COMMITTER_EMAIL: 'benchmark@example.invalid',
      GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z' } }).trim();
}

function sceneBody(index, bytes) {
  const header = `# Synthetic scene ${index}\n\nEvidence passage ${index}: benchmarkneedle supports a fixed synthetic narrative fact.\n`;
  if (Buffer.byteLength(header) > bytes) throw new Error(`Scene body target is too small: ${bytes}`);
  const prose = 'Synthetic prose for a fixed benchmark paragraph; literal search remains deterministic.\n';
  return (header + prose.repeat(Math.ceil((bytes - header.length) / prose.length))).slice(0, bytes);
}

function sha256(value) { return createHash('sha256').update(value).digest('hex'); }

function fixtureIdentity(plan, bodies, seedFiles) {
  return sha256(JSON.stringify({ plan, sceneHashes: plan.scenes.map(scene =>
    [scene.name, sha256(bodies.get(scene.name))]), seedFiles }));
}

/** Bind the actual input bytes and plan to the manifest before any database mutation. */
export async function verifyFixture(root) {
  const manifest = JSON.parse(await readFile(join(root, 'dataset.json'), 'utf8'));
  const plan = JSON.parse(await readFile(join(root, 'seed', 'fixture-plan.json'), 'utf8'));
  const { fixtureId, fixtureSha256, transport, documentBodyBytes, generatedBy, ...manifestPlan } = manifest;
  if (plan.schemaVersion !== 2 || !Array.isArray(plan.scenes) ||
      JSON.stringify(plan) !== JSON.stringify(manifestPlan) ||
      !/^[a-f0-9]{64}$/u.test(fixtureId) || fixtureId !== fixtureSha256) {
    throw new Error('Fixture manifest and transport plan mismatch');
  }
  const bodies = new Map();
  for (const [offset, scene] of plan.scenes.entries()) {
    if (scene.index !== offset + 1 || scene.name !== `scene-${String(offset + 1).padStart(4, '0')}.md`) {
      throw new Error('Invalid fixture scene path or order');
    }
    const bytes = await readFile(join(root, 'seed', scene.name));
    if (bytes.byteLength !== scene.bodyBytes || !Buffer.from(bytes.toString('utf8')).equals(bytes)) {
      throw new Error(`Fixture body byte mismatch: ${scene.name}`);
    }
    bodies.set(scene.name, bytes);
  }
  const seedFiles = [...bodies.keys(), 'fixture-plan.json'].sort();
  if (fixtureIdentity(plan, bodies, seedFiles) !== fixtureId ||
      [...bodies.values()].reduce((sum, body) => sum + body.byteLength, 0) !== documentBodyBytes) {
    throw new Error('Fixture content identity mismatch');
  }
  return { manifest, bodies };
}

export async function generate(root, scenario) {
  const spec = scenarios[scenario];
  if (!spec) throw new Error(`Unknown dataset: ${scenario}`);
  // Exclusive directory creation prevents overwriting an existing fixture or result set.
  await mkdir(root, { mode: 0o700 });
  const seed = join(root, 'seed');
  await mkdir(seed, { mode: 0o700 });
  const sceneCount = spec.documentCount - spec.volumes - spec.chapters;
  const scenes = [];
  let documentBytes = 0;
  for (let index = 1; index <= sceneCount; index++) {
    const bytes = [1024, 100 * 1024, 1024 * 1024][index - 1] ?? spec.defaultBodyBytes;
    const name = `scene-${String(index).padStart(4, '0')}.md`;
    const markdown = sceneBody(index, bytes);
    if (Buffer.byteLength(markdown) !== bytes) throw new Error(`Scene ${index} byte count changed during generation`);
    await writeFile(join(seed, name), markdown, { flag: 'wx', mode: 0o600 });
    documentBytes += bytes;
    scenes.push({ index, name, title: `Scene ${String(index).padStart(4, '0')}`, bodyBytes: bytes,
      historyRevisions: index === 1 ? spec.historyRevisions : 0 });
  }
  const plan = { schemaVersion: 2, datasetId: scenario, documentCount: spec.documentCount, volumeCount: spec.volumes,
    chapterCount: spec.chapters, sceneCount, defaultBodyBytes: spec.defaultBodyBytes,
    historyTarget: { sceneIndex: 1, additionalRevisions: spec.historyRevisions },
    knowledge: spec.knowledge ?? { nodes: 0, aliasesPerNode: 0, evidencePerNode: 0, assertionsPerNode: 0 }, scenes };
  await writeFile(join(seed, 'fixture-plan.json'), `${JSON.stringify(plan, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  const seedFiles = [...scenes.map(scene => scene.name), 'fixture-plan.json'].sort();
  git(seed, 'init', '--initial-branch=main');
  git(seed, 'add', '.');
  git(seed, 'commit', '--quiet', '-m', `Synthetic PostgreSQL fixture ${scenario}`);
  const actualFiles = git(seed, 'ls-files').split('\n').filter(Boolean);
  if (JSON.stringify(actualFiles) !== JSON.stringify(seedFiles)) throw new Error('Synthetic fixture transport inventory changed');
  const transportBytes = (await Promise.all(actualFiles.map(file => stat(join(seed, file))))).reduce((sum, row) => sum + row.size, 0);
  const commit = git(seed, 'rev-parse', 'HEAD');
  const bodies = new Map(await Promise.all(scenes.map(async scene => [scene.name, await readFile(join(seed, scene.name))])));
  const fixtureId = fixtureIdentity(plan, bodies, seedFiles);
  const manifest = { ...plan, fixtureId, fixtureSha256: fixtureId,
    transport: { kind: 'synthetic-git', commit, trackedFiles: actualFiles.length, bytes: transportBytes },
    documentBodyBytes: documentBytes, generatedBy: 'scripts/performance/dataset.mjs' };
  await writeFile(join(root, 'dataset.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  return manifest;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  console.log(JSON.stringify(await generate(resolve(process.argv[2]), process.argv[3]), null, 2));
}
