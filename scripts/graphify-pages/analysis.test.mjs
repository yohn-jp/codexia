import assert from 'node:assert/strict';
import { test } from 'node:test';
import { expandGraph, summarizeGraph } from './analysis.mjs';

const sha = 'b'.repeat(40);
const tracked = new Set([
  'src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts',
  'tests/a.test.ts', 'docs/readme.md', 'evidence/report.json', '.agents/notes.md',
  'src/old.test.ts', 'src/old.spec.ts', 'src/missing.ts',
]);
const fixture = {
  nodes: [
    { id: 'a-file', label: 'a.ts', source_file: 'src/a.ts' },
    { id: 'a-symbol', label: 'alpha', source_file: 'src/a.ts' },
    { id: 'b', label: 'beta', source_file: 'src/b.ts' },
    { id: 'c', label: 'gamma', source_file: 'src/c.ts' },
    { id: 'd', label: 'delta', source_file: 'src/d.ts' },
    { id: 'excluded', label: 'test', source_file: 'tests/a.test.ts' },
    { id: 'external', label: 'external' },
  ],
  links: [
    { source: 'a-symbol', target: 'b', relation: 'imports', source_file: 'src/a.ts', source_location: 'L7' },
    { source: 'b', target: 'c', relation: 'calls' },
    { source: 'c', target: 'a-file', relation: 'imports_from' },
    { source: 'c', target: 'd', relation: 'uses' },
    { source: 'a-file', target: 'a-symbol', relation: 'calls' }, // same file
    { source: 'a-file', target: 'b', relation: 'related_to' }, // non-reference type
    { source: 'external', target: 'a-file', relation: 'calls' },
    { source: 'excluded', target: 'a-file', relation: 'calls' },
  ],
};

test('reports bounded extraction coverage and only observed relation evidence', () => {
  const index = summarizeGraph(fixture, sha, tracked);
  assert.equal(index.schemaVersion, 1);
  assert.equal(index.sourceSha, sha);
  assert.deepEqual(index.coverage, {
    mode: 'code-only', trackedFiles: 11, eligibleFiles: null, extractedFiles: 4,
    unavailableFiles: null, scopeStatus: 'candidate-inventory-not-reported',
    excludedFiles: ['.agents/notes.md', 'docs/readme.md', 'evidence/report.json', 'src/old.spec.ts', 'src/old.test.ts', 'tests/a.test.ts'],
    excluded: { tests: 1, docs: 1, evidence: 1, agents: 1, testFiles: 1, specFiles: 1 },
  });
  assert.deepEqual(index.relations, ['imports', 'imports_from', 're_exports', 'calls', 'references', 'depends_on', 'instantiates', 'inherits', 'implements', 'extends', 'uses']);
  assert.equal(index.stats.crossFileLinks, 4);
  const a = index.files.find(file => file.path === 'src/a.ts');
  assert.deepEqual(a.outgoing, [{
    path: 'src/b.ts', count: 1, relations: ['imports'], relationCounts: { imports: 1 },
    evidence: [{ path: 'src/a.ts', line: 7 }],
  }]);
  assert.deepEqual(a.incoming.map(edge => edge.path), ['src/c.ts']);
});

test('expands multiple levels, follows direction, filters relationships, and deduplicates cycles', () => {
  const index = summarizeGraph(fixture, sha, tracked);
  const outgoing = expandGraph(index, 'src/a.ts', { direction: 'outgoing', maxDepth: 6 });
  assert.deepEqual(outgoing.nodes, [
    { path: 'src/a.ts', depth: 0 }, { path: 'src/b.ts', depth: 1 },
    { path: 'src/c.ts', depth: 2 }, { path: 'src/d.ts', depth: 3 },
  ]);
  assert.equal(outgoing.nodes.filter(node => node.path === 'src/a.ts').length, 1);
  assert.ok(outgoing.edges.some(edge => edge.from === 'src/c.ts' && edge.to === 'src/a.ts'));
  const imports = expandGraph(index, 'src/a.ts', { direction: 'outgoing', relations: ['imports'] });
  assert.deepEqual(imports.nodes.map(node => node.path), ['src/a.ts', 'src/b.ts']);
  const incoming = expandGraph(index, 'src/d.ts', { direction: 'incoming' });
  assert.deepEqual(incoming.nodes.map(node => node.path), ['src/d.ts', 'src/c.ts', 'src/b.ts', 'src/a.ts']);
  const limited = expandGraph(index, 'src/a.ts', { maxDepth: 1, maxNodes: 2 });
  assert.equal(limited.truncated, true);
  assert.equal(limited.nodes.length, 2);
  assert.deepEqual(expandGraph(index, 'missing.ts'), { nodes: [], edges: [], truncated: false });
});

test('accepts a structurally valid empty extraction as an explicit empty state', () => {
  const index = summarizeGraph({ nodes: [], links: [] }, sha, new Set(['src/no-symbol.ts', 'tests/ignored.ts']));
  assert.equal(index.stats.files, 0);
  assert.deepEqual(index.files, []);
  assert.equal(index.coverage.unavailableFiles, null);
});
