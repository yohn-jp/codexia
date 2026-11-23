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
    { id: 'a-symbol', label: 'alpha', source_file: 'src/a.ts', source_location: 'L4' },
    { id: 'a-symbol-2', label: 'alpha', source_file: 'src/a.ts', source_location: 'unknown' },
    { id: 'b', label: 'beta', source_file: 'src/b.ts', source_location: 'L5' },
    { id: 'c', label: 'gamma', source_file: 'src/c.ts', source_location: 'L8' },
    { id: 'd', label: 'delta', source_file: 'src/d.ts', source_location: 'L1' },
    { id: 'excluded', label: 'test', source_file: 'tests/a.test.ts' },
    { id: 'external', label: 'external' },
  ],
  links: [
    { source: 'a-symbol', target: 'b', relation: 'imports', source_file: 'src/a.ts', source_location: 'L7' },
    { source: 'a-symbol', target: 'b', relation: 'calls', source_file: 'src/a.ts', source_location: 'L9' },
    { source: 'b', target: 'c', relation: 'calls' },
    { source: 'c', target: 'a-symbol', relation: 'imports_from', source_file: 'src/c.ts', source_location: 'L12' },
    { source: 'c', target: 'd', relation: 'uses' },
    { source: 'a-symbol', target: 'a-symbol-2', relation: 'calls', source_file: 'src/a.ts', source_location: 'L11' }, // same file
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
    unavailableFiles: null, otherTrackedFiles: null, scopeStatus: 'candidate-inventory-not-reported',
    unavailableMeaning: 'candidate-without-graph-node; cause-not-reported',
    excludedFiles: ['.agents/notes.md', 'docs/readme.md', 'evidence/report.json', 'src/old.spec.ts', 'src/old.test.ts', 'tests/a.test.ts'],
    excluded: { tests: 1, docs: 1, evidence: 1, agents: 1, testFiles: 1, specFiles: 1 },
  });
  assert.deepEqual(index.relations, ['imports', 'imports_from', 're_exports', 'calls', 'references', 'depends_on', 'instantiates', 'inherits', 'implements', 'extends', 'uses']);
  assert.equal(index.stats.crossFileLinks, 5);
  assert.equal(index.stats.symbolEdges, 6);
  const a = index.files.find(file => file.path === 'src/a.ts');
  assert.equal(a.symbols.filter(symbol => symbol.label === 'alpha').length, 2);
  const alpha = a.symbols.find(symbol => symbol.id === 'src/a.ts::a-symbol');
  assert.equal(alpha.line, 4);
  assert.deepEqual(alpha.outgoing.map(edge => edge.relation).sort(), ['calls', 'calls', 'imports']);
  assert.deepEqual(alpha.outgoing.find(edge => edge.relation === 'imports').evidence, [{ path: 'src/a.ts', line: 7, relation: 'imports' }]);
  assert.deepEqual(alpha.outgoing.find(edge => edge.relation === 'calls' && edge.id === 'src/a.ts::a-symbol-2').evidence, [{ path: 'src/a.ts', line: 11, relation: 'calls' }]);
  assert.deepEqual(a.outgoing, [{
    path: 'src/b.ts', count: 2, relations: ['calls', 'imports'], relationCounts: { calls: 1, imports: 1 },
    evidence: [{ path: 'src/a.ts', line: 7, relation: 'imports' }, { path: 'src/a.ts', line: 9, relation: 'calls' }],
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
  const calls = expandGraph(index, 'src/a.ts', { direction: 'outgoing', relations: ['calls'] });
  assert.deepEqual(calls.edges[0].relations, ['calls']);
  assert.deepEqual(calls.edges[0].evidence, [{ path: 'src/a.ts', line: 9, relation: 'calls' }]);
  const capped = expandGraph(index, 'src/a.ts', { direction: 'outgoing', maxNodes: 1 });
  assert.equal(capped.truncated, true);
  assert.deepEqual(capped.edges, []);
  const incoming = expandGraph(index, 'src/d.ts', { direction: 'incoming' });
  assert.deepEqual(incoming.nodes.map(node => node.path), ['src/d.ts', 'src/c.ts', 'src/b.ts', 'src/a.ts']);
  const limited = expandGraph(index, 'src/a.ts', { maxDepth: 1, maxNodes: 2 });
  assert.equal(limited.truncated, true);
  assert.equal(limited.nodes.length, 2);
  assert.deepEqual(expandGraph(index, 'missing.ts'), { nodes: [], edges: [], truncated: false });
});

test('expands symbol references with direction, relation filters, evidence, and duplicate labels', () => {
  const index = summarizeGraph(fixture, sha, tracked);
  const alpha = index.files.find(file => file.path === 'src/a.ts').symbols.find(symbol => symbol.id === 'src/a.ts::a-symbol');
  const expanded = expandGraph(index, 'src/a.ts', { startId: alpha.id, direction: 'both', maxDepth: 6 });
  assert.deepEqual(expanded.nodes.map(node => node.path), ['src/a.ts', 'src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts']);
  assert.equal(new Set(expanded.nodes.map(node => node.id)).size, expanded.nodes.length);
  assert.ok(expanded.edges.some(edge => edge.from === 'src/c.ts::c' && edge.to === alpha.id && edge.relation === 'imports_from'));
  assert.ok(expanded.edges.some(edge => edge.from === alpha.id && edge.to === 'src/a.ts::a-symbol-2' && edge.relation === 'calls'));
  const calls = expandGraph(index, 'src/a.ts', { startId: alpha.id, direction: 'outgoing', relations: ['calls'], maxDepth: 1 });
  assert.deepEqual(calls.nodes.map(node => node.label), ['alpha', 'alpha', 'beta']);
  assert.deepEqual(calls.edges.map(edge => edge.relation), ['calls', 'calls']);
  assert.ok(calls.edges.every(edge => edge.evidence.every(item => item.relation === edge.relation)));
  const capped = expandGraph(index, 'src/a.ts', { startId: alpha.id, maxNodes: 1 });
  assert.equal(capped.truncated, true);
  assert.deepEqual(capped.edges, []);
});

test('candidate inventory measures eligible, extracted, unavailable, and other tracked files', () => {
  const index = summarizeGraph(fixture, sha, tracked, new Set(['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts', 'src/missing.ts']));
  assert.equal(index.coverage.scopeStatus, 'measured');
  assert.equal(index.coverage.eligibleFiles, 5);
  assert.equal(index.coverage.extractedFiles, 4);
  assert.deepEqual(index.coverage.unavailableFiles, ['src/missing.ts']);
  assert.equal(index.coverage.otherTrackedFiles, 0);
});

test('ambiguous duplicate Graphify node IDs keep symbols distinct and suppress unverifiable edges', () => {
  const collisionGraph = {
    nodes: [
      { id: 'same', label: 'overload', source_file: 'src/a.ts' },
      { id: 'same', label: 'overload', source_file: 'src/b.ts' },
    ],
    links: [{ source: 'same', target: 'same', relation: 'calls' }],
  };
  const index = summarizeGraph(collisionGraph, sha, tracked);
  const symbols = index.files.flatMap(file => file.symbols);
  assert.equal(symbols.length, 2);
  assert.equal(new Set(symbols.map(symbol => symbol.id)).size, 2);
  assert.deepEqual(symbols.map(symbol => symbol.outgoing), [[], []]);
  assert.equal(index.stats.crossFileLinks, 0);
  assert.equal(index.stats.symbolEdges, 0);
});

test('accepts a structurally valid empty extraction as an explicit empty state', () => {
  const index = summarizeGraph({ nodes: [], links: [] }, sha, new Set(['src/no-symbol.ts', 'tests/ignored.ts']));
  assert.equal(index.stats.files, 0);
  assert.deepEqual(index.files, []);
  assert.equal(index.coverage.unavailableFiles, null);
});
