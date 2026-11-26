// Projection of upstream community membership, not a second clustering algorithm.
import { repositoryPath } from './analysis.mjs';

const label = value => typeof value === 'string' ? value.slice(0, 240) : '';
const identity = value => typeof value === 'string' || Number.isFinite(value) ? String(value) : null;

export function projectCommunities(graph, index) {
  const indexed = new Map(index.files.map(file => [file.path, new Set(file.symbols.map(symbol => symbol.id))]));
  const groups = new Map();
  const nodes = [];
  const occurrences = new Map();
  const byRawId = new Map();
  for (const node of graph.nodes) {
    const id = identity(node?.id);
    if (id !== null) occurrences.set(id, (occurrences.get(id) || 0) + 1);
  }
  for (const node of graph.nodes) {
    const cid = node?.community;
    if (!Number.isSafeInteger(cid) || cid < 0) continue;
    const name = label(node.community_name);
    if (!groups.has(cid)) groups.set(cid, { id: cid, name: name || 'Community ' + cid, total: 0, members: [] });
    const group = groups.get(cid);
    group.total++;
    const path = repositoryPath(node.source_file);
    const raw = identity(node.id);
    if (!indexed.has(path) || raw === null) continue;
    const id = nodes.length;
    const candidate = path + '::' + raw;
    const unique = occurrences.get(raw) === 1;
    const symbol = unique && indexed.get(path).has(candidate) ? candidate : null;
    nodes.push({ id, community: cid, label: label(node.label) || path.split('/').at(-1), path, symbol });
    group.members.push(id);
    if (unique) byRawId.set(raw, id);
  }
  const edges = [];
  for (const edge of graph.links) {
    const from = byRawId.get(identity(edge?.source));
    const to = byRawId.get(identity(edge?.target));
    if (from === undefined || to === undefined) continue;
    edges.push([from, to, label(edge.relation) || 'unspecified', label(edge.confidence) || 'not reported']);
  }
  const ordered = [...groups.values()].sort((a, b) => a.id - b.id);
  const parents = new Map();
  for (const [from, to, relation] of edges) {
    if (relation !== 'contains' || from === to || nodes[from].path !== nodes[to].path) continue;
    if (!parents.has(to)) parents.set(to, new Set());
    parents.get(to).add(from);
  }
  const nameCounts = new Map();
  for (const group of ordered) nameCounts.set(group.name, (nameCounts.get(group.name) || 0) + 1);
  const top = counts => [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
  const hubLabel = value => value.trim().replace(/\(\)$/, '');
  for (const group of ordered) {
    const scopes = new Map();
    const paths = new Map();
    for (const id of group.members) {
      const path = nodes[id].path;
      paths.set(path, (paths.get(path) || 0) + 1);
      const parts = path.split('/');
      const scope = parts.slice(0, Math.min(2, Math.max(1, parts.length - 1))).join('/');
      scopes.set(scope, (scopes.get(scope) || 0) + 1);
    }
    group.scope = top(scopes)?.[0] || '';
    const dominant = top(paths);
    // Use observed file context when a single file contains a majority of members.
    // Otherwise use the dominant source scope; never imply an inferred subsystem.
    group.context = dominant && dominant[1] > group.members.length / 2
      ? dominant[0] : group.scope;
    let qualified = group.name;
    if (nameCounts.get(group.name) > 1) {
      // Only qualify a repeated hub by a uniquely observed containment chain.
      // Do not invent parent names from opaque Graphify node IDs.
      const hubs = group.members.filter(id => hubLabel(nodes[id].label) === group.name);
      if (hubs.length === 1) {
        const seen = new Set(hubs);
        let current = hubs[0];
        const chain = [];
        while (chain.length < 3 && parents.get(current)?.size === 1) {
          const parent = parents.get(current).values().next().value;
          if (seen.has(parent)) break;
          seen.add(parent);
          const owner = nodes[parent];
          if (owner.label === owner.path || owner.label === owner.path.split('/').at(-1)) break;
          chain.unshift(owner.label);
          current = parent;
        }
        if (chain.length) qualified = [...chain, group.name].join(' › ');
      }
    }
    // Keep full path for the detail, but use a concise, source-derived map label.
    const context = group.context && group.context !== group.scope ? group.context.split('/').at(-1) : group.context;
    group.displayName = context ? context + ' · ' + qualified : qualified;
    group.members.sort((a, b) => nodes[a].path.localeCompare(nodes[b].path) || nodes[a].label.localeCompare(nodes[b].label) || a - b);
  }
  // A repeated basename/owner can still occur. Add snapshot-local IDs only
  // to unresolved collisions, after the source context and owner.
  const displayCounts = new Map();
  for (const group of ordered) displayCounts.set(group.displayName, (displayCounts.get(group.displayName) || 0) + 1);
  for (const group of ordered) {
    if (displayCounts.get(group.displayName) > 1) group.displayName += ' (#' + group.id + ')';
  }
  return { sourceSha: index.sourceSha, groups: ordered, nodes, edges };
}
