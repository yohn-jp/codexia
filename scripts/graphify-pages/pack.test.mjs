import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { packGraph, summarizeGraph } from './pack.mjs';

const sha = 'a'.repeat(40);
const trackedFiles = new Set(['packages/api/server.ts', 'packages/core/db.ts', 'modules/story/scene.ts']);
const graph = {
  nodes: [
    { id: 'a', label: 'server.ts', source_file: 'packages/api/server.ts', file_type: 'code' },
    { id: 'a2', label: 'startServer', source_file: 'packages/api/server.ts', file_type: 'code' },
    { id: 'b', label: 'loadFromDb', source_file: 'packages/core/db.ts', file_type: 'code' },
    { id: 'c', label: '</script><script>alert(1)</script>', source_file: 'modules/story/scene.ts', file_type: 'code' },
    { id: 'external', label: 'pkg', file_type: 'concept', external: true },
    { id: 'bad', label: 'secret', source_file: '/private/home/secret.ts' },
    { id: 'artifact', label: 'dist file', source_file: 'packages/core/dist/index.js' },
    { id: 'dependency', label: 'node:fs', source_file: 'node:fs' },
  ],
  links: [
    { source: 'a', target: 'b', relation: 'imports' },
    { source: 'a2', target: 'b', relation: 'calls' },
    { source: 'c', target: 'a', relation: 'imports' },
    { source: 'a', target: 'a2', relation: 'calls' },
    { source: 'external', target: 'a', relation: 'imports' },
    { source: 'missing', target: 'a', relation: 'calls' },
    { source: 'b', target: 'c', relation: 'related_to' },
    { source: 'a', target: 'artifact', relation: 'imports' },
    { source: 'dependency', target: 'a', relation: 'imports' },
  ],
};

test('indexes source files, symbols and directed cross-file references without claiming unused', () => {
  const result = summarizeGraph(graph, sha, trackedFiles);
  assert.deepEqual(result.stats, { files: 3, nodes: 8, links: 9, crossFileLinks: 3 });
  const api = result.files.find(f => f.path === 'packages/api/server.ts');
  const core = result.files.find(f => f.path === 'packages/core/db.ts');
  assert.deepEqual(api.symbols, ['startServer']);
  assert.deepEqual(api.incoming.map(x => x.path), ['modules/story/scene.ts']);
  assert.deepEqual(api.outgoing, [{
    path: 'packages/core/db.ts', count: 2, relations: ['calls', 'imports'],
    relationCounts: { calls: 1, imports: 1 }, evidence: [],
  }]);
  assert.deepEqual(core.incoming.map(x => x.path), ['packages/api/server.ts']);
  assert.ok(!result.files.some(f => f.path.includes('private') || f.path.includes('/dist/') || f.path.startsWith('node:')));
});

test('publishes a searchable file explorer and keeps native community graph intact', async t => {
  const root = await mkdtemp(join(tmpdir(), 'graphify-pages-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'source');
  await mkdir(source);
  const generatedHtml = Buffer.from('<!doctype html><html><body>' + 'original Graphify native '.repeat(20) + '</body></html>\r\n');
  await writeFile(join(source, 'graph.html'), generatedHtml);
  await writeFile(join(source, 'graph.json'), JSON.stringify(graph));
  const result = await packGraph(source, join(root, 'site'), sha, trackedFiles);
  const published = join(root, 'site', 'graph');
  assert.deepEqual((await readdir(published)).sort(), ['communities.html', 'index.html', 'source.json']);
  assert.equal(result.path, join(published, 'index.html'));
  assert.deepEqual(await readFile(join(published, 'communities.html')), generatedHtml);
  const explorer = await readFile(join(published, 'index.html'), 'utf8');
  assert.match(explorer, /Graphify File Explorer/);
  assert.match(explorer, /packages\/api\/server.ts/);
  assert.match(explorer, /参照元/);
  assert.ok(explorer.includes('https://github.com/yohn-jp/codexia/blob/' + sha + '/packages/api/server.ts'));
  assert.doesNotMatch(explorer, /<script>alert\(1\)<\/script>/);
  assert.match(explorer, /\\u003c\/script>/);
  const sourceRecord = JSON.parse(await readFile(join(published, 'source.json'), 'utf8'));
  const expected = summarizeGraph(graph, sha, trackedFiles);
  assert.deepEqual(sourceRecord, {
    schemaVersion: 1, sourceSha: sha, generator: 'graphifyy', mode: 'code-only', stats: result.stats,
    coverage: expected.coverage, relations: expected.relations,
    files: expected.files.map(file => ({ path: file.path })),
  });
});

test('rejects invalid or incomplete inputs without publishing output', async t => {
  const root = await mkdtemp(join(tmpdir(), 'graphify-pages-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'graph.html'), 'not HTML'.repeat(30));
  await assert.rejects(packGraph(root, join(root, 'site'), 'main', trackedFiles), /full commit SHA/);
  await assert.rejects(packGraph(root, join(root, 'site'), sha, trackedFiles), /complete HTML/);
  await writeFile(join(root, 'graph.html'), '<html>' + 'ok '.repeat(40) + '</html>');
  await assert.rejects(packGraph(root, join(root, 'site'), sha, trackedFiles), /ENOENT/);
  await writeFile(join(root, 'graph.json'), '{}');
  await assert.rejects(packGraph(root, join(root, 'site'), sha, trackedFiles), /nodes and links arrays/);
  await writeFile(join(root, 'graph.json'), JSON.stringify({ ...graph, built_at_commit: 'c'.repeat(40) }));
  await assert.rejects(packGraph(root, join(root, 'site'), sha, trackedFiles), /expected/);
  assert.deepEqual(await readdir(root), ['graph.html', 'graph.json']);
});
