// Bounded, deterministic transforms over Graphify's source graph.
const MAX_DEPTH = 8;
const MAX_NODES = 500;

export const REFERENCE_RELATIONS = Object.freeze([
  'imports', 'imports_from', 're_exports', 'calls', 'references', 'depends_on',
  'instantiates', 'inherits', 'implements', 'extends', 'uses',
]);
export const EXCLUSION_PATTERNS = Object.freeze([
  'tests/**', 'evidence/**', '.agents/**', 'docs/**', '**/*.test.*', '**/*.spec.*',
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

export function summarizeGraph(graph, sha, trackedFiles, candidateFiles = null) {
  if (!(trackedFiles instanceof Set) || trackedFiles.size === 0) throw new Error('Git-tracked file inventory is required');
  if (!graph || !Array.isArray(graph.nodes) || !Array.isArray(graph.links)) throw new Error('Graphify graph.json requires nodes and links arrays');
  if (candidateFiles !== null && !(candidateFiles instanceof Set)) throw new Error('Candidate source inventory must be a Set');
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
  const nodeSymbols = new Map();
  const usedSymbolIds = new Set();
  for (const node of graph.nodes) {
    if (!node || typeof node !== 'object') continue;
    const path = repositoryPath(node.source_file);
    if (!path || !trackedPaths.has(path) || exclusionCategory(path) || (candidateFiles && !candidateFiles.has(path))) continue;
    if (!files.has(path)) files.set(path, { path, symbols: [], outgoing: new Map(), incoming: new Map() });
    const file = files.get(path);
    const label = safeLabel(node.label);
    const id = endpoint(node.id);
    if (id === null) continue;
    if (!nodePaths.has(id)) nodePaths.set(id, new Set());
    nodePaths.get(id).add(path);
    if (!nodeSymbols.has(id)) nodeSymbols.set(id, []);
    if (!label || label === path.split('/').at(-1) || label === path) continue;
    const baseId = `${path}::${id}`;
    let symbolId = baseId;
    let suffix = 2;
    while (usedSymbolIds.has(symbolId)) symbolId = `${baseId}::duplicate:${suffix++}`;
    usedSymbolIds.add(symbolId);
    const symbol = { id: symbolId, path, label, line: locationLine(node.source_location), incoming: [], outgoing: [] };
    file.symbols.push(symbol);
    nodeSymbols.get(id).push(symbol);
  }
  const extractedPaths = new Set(files.keys());

  let crossFileLinks = 0;
  let symbolEdges = 0;
  for (const link of graph.links) {
    if (!link || typeof link !== 'object') continue;
    const rawSource = endpoint(link.source);
    const rawTarget = endpoint(link.target);
    const sourcePaths = nodePaths.get(rawSource);
    const targetPaths = nodePaths.get(rawTarget);
    const from = sourcePaths?.size === 1 ? sourcePaths.values().next().value : null;
    const to = targetPaths?.size === 1 ? targetPaths.values().next().value : null;
    if (!from || !to) continue;
    const relation = safeLabel(link.relation).toLowerCase();
    if (!REFERENCE_SET.has(relation)) continue;
    if (from !== to) crossFileLinks++;
    const sourceSymbols = nodeSymbols.get(rawSource);
    const targetSymbols = nodeSymbols.get(rawTarget);
    const sourceSymbol = sourceSymbols?.length === 1 ? sourceSymbols[0] : null;
    const targetSymbol = targetSymbols?.length === 1 ? targetSymbols[0] : null;
    const evidencePath = repositoryPath(link.source_file);
    const evidenceLine = locationLine(link.source_location);
    const evidence = evidenceLine && evidencePath === from ? [{ path: from, line: evidenceLine, relation }] : [];
    if (sourceSymbol && targetSymbol) {
      sourceSymbol.outgoing.push({ id: targetSymbol.id, path: targetSymbol.path, label: targetSymbol.label, relation, evidence });
      targetSymbol.incoming.push({ id: sourceSymbol.id, path: sourceSymbol.path, label: sourceSymbol.label, relation, evidence });
      symbolEdges++;
    }
    if (from === to) continue;
    for (const [owner, direction, neighbor] of [[from, 'outgoing', to], [to, 'incoming', from]]) {
      const map = files.get(owner)[direction];
      if (!map.has(neighbor)) map.set(neighbor, { path: neighbor, count: 0, relations: new Set(), relationCounts: Object.create(null), evidence: new Set() });
      const entry = map.get(neighbor);
      entry.count++;
      entry.relations.add(relation);
      entry.relationCounts[relation] = (entry.relationCounts[relation] || 0) + 1;
      // Graphify exposes source_location on some edges (notably imports).
      // Only preserve a line when its observed source_file agrees with the edge origin.
      if (evidence.length) entry.evidence.add([evidence[0].path, evidence[0].line, relation].join('\0'));
    }
  }
  const toRelations = map => [...map.values()].map(x => ({
    path: x.path,
    count: x.count,
    relations: [...x.relations].sort(),
    relationCounts: Object.fromEntries(Object.entries(x.relationCounts).sort(([a], [b]) => a.localeCompare(b))),
    evidence: [...x.evidence].sort().map(value => {
      const [path, line, relation] = value.split('\0');
      return { path, line: Number(line), relation };
    }),
  })).sort((a, b) => b.count - a.count || a.path.localeCompare(b.path));
  const groupSymbolEdges = rows => {
    const groups = new Map();
    for (const edge of rows) {
      const key = `${edge.id}\0${edge.relation}`;
      if (!groups.has(key)) groups.set(key, { ...edge, count: 0, evidence: new Set() });
      const group = groups.get(key);
      group.count++;
      for (const item of edge.evidence) group.evidence.add([item.path, item.line, item.relation].join('\0'));
    }
    return [...groups.values()].map(edge => ({
      id: edge.id, path: edge.path, label: edge.label, relation: edge.relation, count: edge.count,
      evidence: [...edge.evidence].sort().map(value => {
        const [path, line, relation] = value.split('\0');
        return { path, line: Number(line), relation };
      }),
    })).sort((a, b) => a.path.localeCompare(b.path) || a.label.localeCompare(b.label) || a.id.localeCompare(b.id) || a.relation.localeCompare(b.relation));
  };
  const excludedFiles = [...trackedPaths].filter(exclusionCategory).sort();
  const eligible = candidateFiles === null ? null : [...candidateFiles].filter(path => trackedPaths.has(path) && !exclusionCategory(path)).sort();
  const unavailableFiles = eligible === null ? null : eligible.filter(path => !extractedPaths.has(path));
  const otherTrackedFiles = eligible === null ? null : Math.max(0, trackedPaths.size - excludedFiles.length - eligible.length);
  return {
    schemaVersion: 1,
    sourceSha: sha,
    stats: { files: files.size, nodes: graph.nodes.length, links: graph.links.length, crossFileLinks, symbolEdges },
    coverage: {
      mode: 'code-only', trackedFiles: trackedPaths.size, eligibleFiles: eligible?.length ?? null,
      extractedFiles: extractedPaths.size, unavailableFiles, otherTrackedFiles,
      unavailableMeaning: 'candidate-without-graph-node; cause-not-reported',
      scopeStatus: eligible === null ? 'candidate-inventory-not-reported' : 'measured', excludedFiles,
      excluded,
    },
    relations: [...REFERENCE_RELATIONS],
    files: [...files.values()].sort((a, b) => a.path.localeCompare(b.path)).map(f => ({
      path: f.path,
      symbols: f.symbols.sort((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id)).map(symbol => ({
        ...symbol,
        incoming: groupSymbolEdges(symbol.incoming),
        outgoing: groupSymbolEdges(symbol.outgoing),
      })),
      incoming: toRelations(f.incoming), outgoing: toRelations(f.outgoing),
    })),
  };
}

/** Breadth-first expansion, capped to keep browser work bounded. */
export function expandGraph(index, startPath, { startId = null, direction = 'both', relations = [], maxDepth = 3, maxNodes = 100 } = {}) {
  if (!index || !Array.isArray(index.files)) throw new Error('Graph index requires files');
  if (!['incoming', 'outgoing', 'both'].includes(direction)) throw new Error('Invalid traversal direction');
  const depthLimit = Math.max(0, Math.min(MAX_DEPTH, Number.isInteger(maxDepth) ? maxDepth : 3));
  const nodeLimit = Math.max(1, Math.min(MAX_NODES, Number.isInteger(maxNodes) ? maxNodes : 100));
  const relationFilter = new Set((Array.isArray(relations) ? relations : []).filter(x => REFERENCE_SET.has(x)));
  const byPath = new Map(index.files.map(file => [file.path, file]));
  if (startId !== null) {
    const symbols = new Map(index.files.flatMap(file => (file.symbols || []).map(symbol => [symbol.id, symbol])));
    if (!symbols.has(startId) || symbols.get(startId).path !== startPath) return { nodes: [], edges: [], truncated: false };
    const start = symbols.get(startId);
    const nodes = [{ id: start.id, path: start.path, label: start.label, depth: 0 }];
    const depths = new Map([[start.id, 0]]);
    const edges = new Map();
    let truncated = false;
    for (let cursor = 0; cursor < nodes.length; cursor++) {
      const { id, depth } = nodes[cursor];
      const symbol = symbols.get(id);
      const candidates = [];
      if (direction !== 'incoming') for (const edge of symbol.outgoing || []) candidates.push({ from: id, to: edge.id, next: edge.id, edge });
      if (direction !== 'outgoing') for (const edge of symbol.incoming || []) candidates.push({ from: edge.id, to: id, next: edge.id, edge });
      candidates.sort((a, b) => a.next.localeCompare(b.next));
      for (const candidate of candidates) {
        if (relationFilter.size && !relationFilter.has(candidate.edge.relation)) continue;
        if (!symbols.has(candidate.next)) continue;
        if (depth >= depthLimit && !depths.has(candidate.next)) { truncated = true; continue; }
        if (!depths.has(candidate.next) && nodes.length >= nodeLimit) { truncated = true; continue; }
        const key = `${candidate.from}\0${candidate.to}\0${candidate.edge.relation}`;
        const current = edges.get(key) || { from: candidate.from, to: candidate.to, relation: candidate.edge.relation, count: 0, evidence: new Set() };
        current.count = Math.max(current.count, candidate.edge.count || 1);
        for (const item of candidate.edge.evidence || []) if (item.relation === candidate.edge.relation) current.evidence.add([item.path, item.line, item.relation].join('\0'));
        edges.set(key, current);
        if (!depths.has(candidate.next)) {
          const next = symbols.get(candidate.next);
          const nextDepth = depth + 1;
          depths.set(next.id, nextDepth);
          nodes.push({ id: next.id, path: next.path, label: next.label, depth: nextDepth });
        }
      }
    }
    return {
      nodes,
      edges: [...edges.values()].map(edge => ({
        from: edge.from, to: edge.to, relation: edge.relation, count: edge.count,
        evidence: [...edge.evidence].sort().map(value => {
          const [path, line, relation] = value.split('\0');
          return { path, line: Number(line), relation };
        }),
      })),
      truncated,
    };
  }
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
      if (!depths.has(candidate.next) && nodes.length >= nodeLimit) { truncated = true; continue; }
      const key = `${candidate.from}\0${candidate.to}`;
      const currentEdge = edges.get(key) || { from: candidate.from, to: candidate.to, relations: new Set(), count: 0, evidence: new Set() };
      for (const relation of selected) currentEdge.relations.add(relation);
      currentEdge.count = Math.max(currentEdge.count, count);
      for (const item of candidate.edge.evidence || []) if (selected.includes(item.relation)) currentEdge.evidence.add(JSON.stringify(item));
      edges.set(key, currentEdge);
      if (!depths.has(candidate.next)) {
        const nextDepth = depth + 1;
        depths.set(candidate.next, nextDepth);
        nodes.push({ path: candidate.next, depth: nextDepth });
      }
    }
  }
  return {
    nodes,
    edges: [...edges.values()].map(edge => ({
      from: edge.from, to: edge.to, relations: [...edge.relations].sort(), count: edge.count,
      evidence: [...edge.evidence].map(value => JSON.parse(value)).sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line || a.relation.localeCompare(b.relation)),
    })),
    truncated,
  };
}
