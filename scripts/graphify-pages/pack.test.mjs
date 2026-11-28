import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { packGraph, summarizeGraph } from './pack.mjs';
import { EXCLUSION_PATTERNS } from './analysis.mjs';
import { projectCommunities } from './community-data.mjs';

const sha = 'a'.repeat(40);
const trackedFiles = new Set(['packages/api/server.ts', 'packages/core/db.ts', 'modules/story/scene.ts']);
const graph = {
  nodes: [
    { id: 'a', label: 'server.ts', source_file: 'packages/api/server.ts', file_type: 'code', community: 0, community_name: 'startServer' },
    { id: 'a2', label: 'startServer', source_file: 'packages/api/server.ts', file_type: 'code', community: 0, community_name: 'startServer' },
    { id: 'b', label: 'loadFromDb', source_file: 'packages/core/db.ts', file_type: 'code', community: 1, community_name: 'loadFromDb' },
    { id: 'c', label: '</script><script>alert(1)</script>$& $$ $` __GRAPHIFY_SOURCE_LINKS__', source_file: 'modules/story/scene.ts', file_type: 'code', community: 0, community_name: 'startServer' },
    { id: 'external', label: 'pkg', file_type: 'concept', external: true },
    { id: 'bad', label: 'secret', source_file: '/private/home/secret.ts', community: 0, community_name: 'startServer' },
    { id: 'artifact', label: 'dist file', source_file: 'packages/core/dist/index.js' },
    { id: 'dependency', label: 'node:fs', source_file: 'node:fs' },
  ],
  links: [
    { source: 'a', target: 'b', relation: 'imports', source_file: 'packages/api/server.ts', source_location: 'L3' },
    { source: 'a2', target: 'b', relation: 'calls', confidence: 'INFERRED' },
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
  assert.deepEqual(result.stats, { files: 3, nodes: 8, links: 9, crossFileLinks: 3, symbolEdges: 1 });
  const api = result.files.find(f => f.path === 'packages/api/server.ts');
  const core = result.files.find(f => f.path === 'packages/core/db.ts');
  assert.deepEqual(api.symbols.map(symbol => symbol.label), ['startServer']);
  assert.deepEqual(api.incoming.map(x => x.path), ['modules/story/scene.ts']);
  assert.deepEqual(api.outgoing, [{
    path: 'packages/core/db.ts', count: 2, relations: ['calls', 'imports'],
    relationCounts: { calls: 1, imports: 1 }, evidence: [{ path: 'packages/api/server.ts', line: 3, relation: 'imports' }],
  }]);
  assert.deepEqual(core.incoming.map(x => x.path), ['packages/api/server.ts']);
  assert.ok(!result.files.some(f => f.path.includes('private') || f.path.includes('/dist/') || f.path.startsWith('node:')));
});

test('publishes a searchable file explorer and augments the native community graph', async t => {
  const root = await mkdtemp(join(tmpdir(), 'graphify-pages-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'source');
  await mkdir(source);
  const generatedHtml = Buffer.from('<!doctype html><html><body>' + 'original Graphify native '.repeat(20) + '</body></html>\r\n');
  await writeFile(join(source, 'graph.html'), generatedHtml);
  await writeFile(join(source, 'graph.json'), JSON.stringify(graph));
  const result = await packGraph(source, join(root, 'site'), sha, trackedFiles);
  const published = join(root, 'site', 'graph');
  assert.deepEqual((await readdir(published)).sort(), ['analysis.mjs', 'communities.html', 'index.html', 'source.json']);
  assert.equal(result.path, join(published, 'index.html'));
  const community = await readFile(join(published, 'communities.html'), 'utf8');
  assert.ok(community.startsWith(generatedHtml.toString().split('</body>')[0]));
  assert.match(community, /id="cx-community-dialog"/);
  assert.match(community, /network\.on\('click'/);
  assert.doesNotMatch(community, /<script>alert\(1\)<\/script>/);
  const communityData = JSON.parse(community.match(/<script id="cx-community-data" type="application\/json">([\s\S]*?)<\/script>/)[1]);
  assert.deepEqual(communityData.groups.map(group => [group.name, group.total, group.members.length]), [['startServer', 4, 3], ['loadFromDb', 1, 1]]);
  assert.ok(!communityData.nodes.some(node => node.path.includes('private')));
  assert.equal(communityData.nodes.find(node => node.label === 'startServer').symbol, 'packages/api/server.ts::a2');
  assert.equal(communityData.nodes.find(node => node.label === 'server.ts').symbol, null);
  assert.ok(communityData.edges.some(([from, to, relation, confidence]) => communityData.nodes[from].community !== communityData.nodes[to].community && relation === 'calls' && confidence === 'INFERRED'));
  assert.ok(communityData.edges.some(edge => edge[3] === 'not reported'));
  assert.ok(communityData.edges.some(([from, to, relation]) => communityData.nodes[from].community === communityData.nodes[to].community && relation === 'calls'));
  assert.deepEqual(await readFile(join(published, 'analysis.mjs')), await readFile(new URL('./analysis.mjs', import.meta.url)));
  const explorer = await readFile(join(published, 'index.html'), 'utf8');
  assert.match(explorer, /Graphify File Explorer/);
  assert.match(explorer, /packages\/api\/server.ts/);
  assert.match(explorer, /参照元/);
  assert.ok(explorer.includes('https://github.com/yohn-jp/codexia/blob/' + sha + '/packages/api/server.ts'));
  assert.doesNotMatch(explorer, /<script>alert\(1\)<\/script>/);
  assert.match(explorer, /\\u003c\/script>/);
  const embedded = explorer.match(/<script id="graph-data" type="application\/json">([\s\S]*?)<\/script>/);
  assert.ok(embedded);
  const embeddedIndex = JSON.parse(embedded[1]);
  assert.equal(embeddedIndex.files.find(file => file.path === 'modules/story/scene.ts').symbols[0].label, graph.nodes[3].label);
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

test('validates a same-SHA Graphify candidate inventory and publishes measured coverage only', async t => {
  const root = await mkdtemp(join(tmpdir(), 'graphify-pages-candidates-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'source');
  await mkdir(source);
  await writeFile(join(source, 'graph.html'), '<html><body>' + 'Graphify native '.repeat(30) + '</body></html>');
  await writeFile(join(source, 'graph.json'), JSON.stringify({ ...graph, built_at_commit: sha }));
  const candidates = {
    schemaVersion: 1, sourceSha: sha, generator: 'graphify.detect', generatorVersion: '0.9.121',
    codeOnly: true, excludes: [...EXCLUSION_PATTERNS], files: [...trackedFiles],
  };
  const candidateFile = join(root, 'candidates.json');
  await writeFile(candidateFile, JSON.stringify(candidates));
  const result = await packGraph(source, join(root, 'site'), sha, trackedFiles, candidateFile);
  assert.equal(result.stats.files, 3);
  const sourceRecord = JSON.parse(await readFile(join(root, 'site', 'graph', 'source.json'), 'utf8'));
  assert.equal(sourceRecord.coverage.scopeStatus, 'measured');
  assert.equal(sourceRecord.coverage.eligibleFiles, 3);
  assert.equal(sourceRecord.coverage.extractedFiles, 3);
  assert.deepEqual(sourceRecord.coverage.unavailableFiles, []);
  assert.equal(sourceRecord.coverage.otherTrackedFiles, 0);
  await assert.rejects(packGraph(source, join(root, 'invalid-site'), sha, trackedFiles, { ...candidates, sourceSha: 'c'.repeat(40) }), /source SHA/);
  await assert.rejects(packGraph(source, join(root, 'invalid-site'), sha, trackedFiles, { ...candidates, excludes: [] }), /exclusions/);
  await assert.rejects(packGraph(source, join(root, 'invalid-site'), sha, trackedFiles, { ...candidates, files: [...trackedFiles, '../private'] }), /invalid or excluded/);
});

test('qualifies repeated hubs using observed same-file containment and distinguishes remaining collisions', () => {
  const path = 'ios/CodexiaTransport/Types.swift';
  const tracked = new Set([path, 'scripts/verify.yml']);
  const entries = [
    ['owner-a', 'Alpha', 0, 'Alpha'], ['owner-b', 'Beta', 0, 'Alpha'],
    ['key-a', 'CodingKeys', 1, 'CodingKeys'], ['key-b', 'CodingKeys', 2, 'CodingKeys'],
    ['key-c', 'CodingKeys', 3, 'CodingKeys'], ['key-d', 'CodingKeys', 4, 'CodingKeys'],
    ['key-e', 'CodingKeys', 5, 'CodingKeys'],
  ];
  const source = {
    nodes: entries.map(([id, label, community, community_name]) => ({ id, label, community, community_name, source_file: path })).concat(
      [{ id: 'steps', label: 'steps', community: 6, community_name: 'steps', source_file: 'scripts/verify.yml' }],
    ),
    links: [
      { source: 'owner-a', target: 'key-a', relation: 'contains', confidence: 'EXTRACTED' },
      { source: 'owner-b', target: 'key-b', relation: 'contains', confidence: 'INFERRED' },
      { source: 'owner-b', target: 'key-e', relation: 'references', confidence: 'AMBIGUOUS' },
    ],
  };
  const result = projectCommunities(source, summarizeGraph(source, sha, tracked));
  const byId = new Map(result.groups.map(group => [group.id, group]));
  assert.equal(byId.get(1).displayName, 'Types.swift · Alpha › CodingKeys');
  assert.equal(byId.get(2).displayName, 'Types.swift · Beta › CodingKeys');
  assert.equal(byId.get(3).displayName, 'Types.swift · CodingKeys (#3)');
  assert.equal(byId.get(4).displayName, 'Types.swift · CodingKeys (#4)');
  assert.equal(byId.get(5).displayName, 'Types.swift · CodingKeys (#5)');
  assert.equal(byId.get(6).displayName, 'verify.yml · steps');
  assert.equal(byId.get(1).context, path);
  assert.equal(byId.get(1).name, 'CodingKeys');
  assert.equal(new Set(result.groups.map(group => group.displayName)).size, result.groups.length);
  assert.deepEqual(result.edges.map(edge => edge[3]), ['EXTRACTED', 'INFERRED', 'AMBIGUOUS']);
});
