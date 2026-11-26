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
    edges.push([from, to, label(edge.relation) || 'unspecified']);
  }
  const ordered = [...groups.values()].sort((a, b) => a.id - b.id);
  for (const group of ordered) {
    const scopes = new Map();
    for (const id of group.members) {
      const parts = nodes[id].path.split('/');
      const scope = parts.slice(0, Math.min(2, Math.max(1, parts.length - 1))).join('/');
      scopes.set(scope, (scopes.get(scope) || 0) + 1);
    }
    group.scope = [...scopes].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] || '';
    group.members.sort((a, b) => nodes[a].path.localeCompare(nodes[b].path) || nodes[a].label.localeCompare(nodes[b].label) || a - b);
  }
  return { sourceSha: index.sourceSha, groups: ordered, nodes, edges };
}
