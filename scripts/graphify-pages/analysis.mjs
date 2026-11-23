// Bounded, deterministic transforms over Graphify's source graph.
const MAX_DEPTH = 8;
const MAX_NODES = 500;

export const REFERENCE_RELATIONS = Object.freeze([
  'imports', 'imports_from', 're_exports', 'calls', 'references', 'depends_on',
  'instantiates', 'inherits', 'implements', 'extends', 'uses',
]);
const REFERENCE_SET = new Set(REFERENCE_RELATIONS);

function safeLabel(value) {
  return typeof value === 'string' ? value.slice(0, 240) : '';
}

export function repositoryPath(value) {
  if (typeof value !== 'string') return null;
  const path = value.replaceAll('\\', '/').replace(/^\.\//, '');
  if (!path || path.startsWith('/') || path.includes('//') || path.split('/').some(p => !p || p === '.' || p === '..') || /[\x00-\x1f\x7f]/.test(path)) return null;
  return path;
}

export function exclusionCategory(path) {
  if (/^tests\//.test(path)) return 'tests';
  if (/^docs\//.test(path)) return 'docs';
  if (/^evidence\//.test(path)) return 'evidence';
  if (/^\.agents\//.test(path)) return 'agents';
  if (/\.test\.[^/]+$/.test(path)) return 'testFiles';
  if (/\.spec\.[^/]+$/.test(path)) return 'specFiles';
  return null;
}

function locationLine(value) {
  if (Number.isSafeInteger(value) && value > 0) return value;
  if (typeof value !== 'string') return null;
  const match = /^L([1-9]\d*)$/.exec(value);
  return match && Number.isSafeInteger(Number(match[1])) ? Number(match[1]) : null;
}

function endpoint(value) {
  if (typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value))) return String(value);
  return null;
}

export function summarizeGraph(graph, sha, trackedFiles) {
  if (!(trackedFiles instanceof Set) || trackedFiles.size === 0) throw new Error('Git-tracked file inventory is required');
  if (!graph || !Array.isArray(graph.nodes) || !Array.isArray(graph.links)) throw new Error('Graphify graph.json requires nodes and links arrays');
  const trackedPaths = new Set();
  const excluded = Object.fromEntries(['tests', 'docs', 'evidence', 'agents', 'testFiles', 'specFiles'].map(key => [key, 0]));
  for (const inputPath of trackedFiles) {
    const path = repositoryPath(inputPath);
    if (!path) continue;
    trackedPaths.add(path);
    const category = exclusionCategory(path);
    if (category) excluded[category]++;
  }
  const files = new Map();
  const nodePaths = new Map();
  for (const node of graph.nodes) {
    if (!node || typeof node !== 'object') continue;
    const path = repositoryPath(node.source_file);
    if (!path || !trackedPaths.has(path) || exclusionCategory(path)) continue;
    if (!files.has(path)) files.set(path, { path, symbols: new Set(), outgoing: new Map(), incoming: new Map() });
    const file = files.get(path);
    const label = safeLabel(node.label);
    if (label && label !== path.split('/').at(-1) && label !== path) file.symbols.add(label);
    const id = endpoint(node.id);
    if (id !== null) nodePaths.set(id, path);
  }
  const extractedPaths = new Set(files.keys());

  let crossFileLinks = 0;
  for (const link of graph.links) {
    if (!link || typeof link !== 'object') continue;
    const from = nodePaths.get(endpoint(link.source));
    const to = nodePaths.get(endpoint(link.target));
    if (!from || !to || from === to) continue;
    const relation = safeLabel(link.relation).toLowerCase();
    if (!REFERENCE_SET.has(relation)) continue;
    crossFileLinks++;
    const line = locationLine(link.source_location);
    const evidencePath = repositoryPath(link.source_file);
    for (const [owner, direction, neighbor] of [[from, 'outgoing', to], [to, 'incoming', from]]) {
      const map = files.get(owner)[direction];
      if (!map.has(neighbor)) map.set(neighbor, { path: neighbor, count: 0, relations: new Set(), relationCounts: Object.create(null), evidence: new Set() });
      const entry = map.get(neighbor);
      entry.count++;
      entry.relations.add(relation);
      entry.relationCounts[relation] = (entry.relationCounts[relation] || 0) + 1;
      // Graphify 0.9.115 exposes source_location on some edges (notably imports).
      // Only preserve a line when its observed source_file agrees with the edge origin.
      if (line && evidencePath === from) entry.evidence.add(`${evidencePath}:${line}`);
    }
  }
  const toRelations = map => [...map.values()].map(x => ({
    path: x.path,
    count: x.count,
    relations: [...x.relations].sort(),
    relationCounts: Object.fromEntries(Object.entries(x.relationCounts).sort(([a], [b]) => a.localeCompare(b))),
    evidence: [...x.evidence].sort().map(value => {
      const split = value.lastIndexOf(':');
      return { path: value.slice(0, split), line: Number(value.slice(split + 1)) };
    }),
  })).sort((a, b) => b.count - a.count || a.path.localeCompare(b.path));
  const excludedFiles = [...trackedFiles].map(repositoryPath).filter(path => path && exclusionCategory(path)).sort();
  // Graphify's manifest records stamped files but omits failed AST candidates;
  // it is not a complete candidate inventory, so never infer the denominator
  // or name every no-node tracked file as an extraction failure.
  return {
    schemaVersion: 1,
    sourceSha: sha,
    stats: { files: files.size, nodes: graph.nodes.length, links: graph.links.length, crossFileLinks },
    coverage: {
      mode: 'code-only', trackedFiles: trackedPaths.size, eligibleFiles: null,
      extractedFiles: extractedPaths.size, unavailableFiles: null,
      scopeStatus: 'candidate-inventory-not-reported', excludedFiles,
      excluded,
    },
    relations: [...REFERENCE_RELATIONS],
    files: [...files.values()].sort((a, b) => a.path.localeCompare(b.path)).map(f => ({
      path: f.path, symbols: [...f.symbols].sort(), incoming: toRelations(f.incoming), outgoing: toRelations(f.outgoing),
    })),
  };
}

/** Breadth-first expansion, capped to keep browser work bounded. */
export function expandGraph(index, startPath, { direction = 'both', relations = [], maxDepth = 3, maxNodes = 100 } = {}) {
  if (!index || !Array.isArray(index.files)) throw new Error('Graph index requires files');
  if (!['incoming', 'outgoing', 'both'].includes(direction)) throw new Error('Invalid traversal direction');
  const depthLimit = Math.max(0, Math.min(MAX_DEPTH, Number.isInteger(maxDepth) ? maxDepth : 3));
  const nodeLimit = Math.max(1, Math.min(MAX_NODES, Number.isInteger(maxNodes) ? maxNodes : 100));
  const relationFilter = new Set(relations.filter(x => REFERENCE_SET.has(x)));
  const byPath = new Map(index.files.map(file => [file.path, file]));
  if (!byPath.has(startPath)) return { nodes: [], edges: [], truncated: false };
  const nodes = [{ path: startPath, depth: 0 }];
  const depths = new Map([[startPath, 0]]);
  const edges = new Map();
  let truncated = false;
  for (let cursor = 0; cursor < nodes.length; cursor++) {
    const { path, depth } = nodes[cursor];
    const file = byPath.get(path);
    const candidates = [];
    if (direction !== 'incoming') for (const edge of file.outgoing || []) candidates.push({ from: path, to: edge.path, next: edge.path, edge });
    if (direction !== 'outgoing') for (const edge of file.incoming || []) candidates.push({ from: edge.path, to: path, next: edge.path, edge });
    candidates.sort((a, b) => a.next.localeCompare(b.next));
    for (const candidate of candidates) {
      const selected = relationFilter.size ? [...relationFilter].filter(r => candidate.edge.relations.includes(r)) : candidate.edge.relations;
      if (!selected.length) continue;
      if (depth >= depthLimit && !depths.has(candidate.next)) { truncated = true; continue; }
      const count = selected.reduce((sum, r) => sum + (candidate.edge.relationCounts?.[r] || (candidate.edge.relations.length === 1 ? candidate.edge.count : 0)), 0);
      const key = `${candidate.from}\0${candidate.to}`;
      const currentEdge = edges.get(key) || { from: candidate.from, to: candidate.to, relations: new Set(), count: 0 };
      for (const relation of selected) currentEdge.relations.add(relation);
      currentEdge.count = Math.max(currentEdge.count, count);
      edges.set(key, currentEdge);
      if (!depths.has(candidate.next)) {
        if (nodes.length >= nodeLimit) { truncated = true; continue; }
        const nextDepth = depth + 1;
        depths.set(candidate.next, nextDepth);
        nodes.push({ path: candidate.next, depth: nextDepth });
      }
    }
  }
  return {
    nodes,
    edges: [...edges.values()].map(edge => ({ ...edge, relations: [...edge.relations].sort() })),
    truncated,
  };
}
