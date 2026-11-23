#!/usr/bin/env node
// Publish a file-level explorer derived from Graphify's AST graph and preserve its native overview.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_HTML_BYTES = 20 * 1024 * 1024;
const MAX_GRAPH_BYTES = 80 * 1024 * 1024;
const MAX_INDEX_BYTES = 16 * 1024 * 1024;
const DATA_SLOT = '__GRAPHIFY_INDEX_JSON__';
const LINKS_SLOT = '__GRAPHIFY_SOURCE_LINKS__';
// Only directional source references; containment and similarity do not mean a file uses another.
const REFERENCE_RELATIONS = new Set(['imports', 'imports_from', 're_exports', 'calls', 'references', 'depends_on', 'instantiates', 'inherits', 'implements', 'extends', 'uses']);

function repoPath(value) {
  if (typeof value !== 'string') return null;
  const path = value.replaceAll('\\', '/').replace(/^\.\//, '');
  if (!path || path.startsWith('/') || path.includes('//') || path.split('/').some(p => !p || p === '.' || p === '..') || /[\x00-\x1f\x7f]/.test(path)) return null;
  return path;
}

function safeLabel(value) {
  return typeof value === 'string' ? value.slice(0, 240) : '';
}

export function summarizeGraph(graph, sha) {
  if (!graph || !Array.isArray(graph.nodes) || !Array.isArray(graph.links)) {
    throw new Error('Graphify graph.json requires nodes and links arrays');
  }
  const files = new Map();
  const nodePaths = new Map();
  for (const node of graph.nodes) {
    if (!node || typeof node !== 'object') continue;
    const path = repoPath(node.source_file);
    if (!path) continue;
    if (!files.has(path)) files.set(path, { path, symbols: new Set(), outgoing: new Map(), incoming: new Map() });
    const file = files.get(path);
    const label = safeLabel(node.label);
    if (label && label !== basename(path) && label !== path) file.symbols.add(label);
    if (typeof node.id === 'string' || typeof node.id === 'number') nodePaths.set(String(node.id), path);
  }
  if (files.size === 0) throw new Error('Graphify graph contains no repository-relative source files');

  let crossFileLinks = 0;
  for (const link of graph.links) {
    if (!link || typeof link !== 'object') continue;
    const from = nodePaths.get(String(link.source));
    const to = nodePaths.get(String(link.target));
    if (!from || !to || from === to) continue;
    const relation = safeLabel(link.relation).toLowerCase();
    if (!REFERENCE_RELATIONS.has(relation)) continue;
    crossFileLinks++;
    for (const [owner, direction, neighbor] of [[from, 'outgoing', to], [to, 'incoming', from]]) {
      const map = files.get(owner)[direction];
      if (!map.has(neighbor)) map.set(neighbor, { path: neighbor, count: 0, relations: new Set() });
      const entry = map.get(neighbor);
      entry.count++;
      entry.relations.add(relation);
    }
  }
  const toRelations = map => [...map.values()].map(x => ({ path: x.path, count: x.count, relations: [...x.relations].sort() }))
    .sort((a, b) => b.count - a.count || a.path.localeCompare(b.path));
  return {
    sourceSha: sha,
    stats: { files: files.size, nodes: graph.nodes.length, links: graph.links.length, crossFileLinks },
    files: [...files.values()].sort((a, b) => a.path.localeCompare(b.path)).map(f => ({
      path: f.path, symbols: [...f.symbols].sort(), incoming: toRelations(f.incoming), outgoing: toRelations(f.outgoing),
    })),
  };
}

export async function packGraph(sourceDir, pagesDir, sha) {
  if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error('Graph source must be a full commit SHA');
  const source = resolve(sourceDir);
  // Read once, validate, and publish the same native HTML bytes.
  const htmlBytes = await readFile(join(source, 'graph.html'));
  if (htmlBytes.byteLength < 100 || htmlBytes.byteLength > MAX_HTML_BYTES) throw new Error('Graph HTML empty or over 20 MiB limit');
  const html = htmlBytes.toString('utf8');
  if (!/<html\b/i.test(html) || !/<\/html\s*>/i.test(html)) throw new Error('Graphify did not generate a complete HTML document');

  const graphBytes = await readFile(join(source, 'graph.json'));
  if (graphBytes.byteLength < 2 || graphBytes.byteLength > MAX_GRAPH_BYTES) throw new Error('Graph JSON empty or over 80 MiB limit');
  const index = summarizeGraph(JSON.parse(graphBytes.toString('utf8')), sha);
  // The JSON is part of the HTML, but source snippets, graph.json and raw graph edges aren't published separately.
  const payload = JSON.stringify(index).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  const template = await readFile(new URL('./explorer.html', import.meta.url), 'utf8');
  if (template.split(DATA_SLOT).length !== 2 || template.split(LINKS_SLOT).length !== 2) throw new Error('Explorer template requires one data and source-links slot');
  // Pre-render fixed-origin, SHA-pinned source anchors rather than deriving HTML URLs from DOM text.
  const sourceLinks = index.files.map(f => '<a hidden target="_blank" rel="noopener noreferrer" href="https://github.com/yohn-jp/codexia/blob/' + sha + '/' + f.path.split('/').map(encodeURIComponent).join('/') + '">GitHubでソースを開く</a>').join('');
  const explorer = template.replace(DATA_SLOT, payload).replace(LINKS_SLOT, sourceLinks);
  const explorerBytes = Buffer.from(explorer, 'utf8');
  if (explorerBytes.byteLength > MAX_INDEX_BYTES) throw new Error('Graph explorer exceeds 16 MiB limit');

  const target = join(resolve(pagesDir), 'graph');
  await mkdir(target, { recursive: true });
  await writeFile(join(target, 'index.html'), explorerBytes);
  await writeFile(join(target, 'communities.html'), htmlBytes);
  await writeFile(join(target, 'source.json'), JSON.stringify({ sourceSha: sha, generator: 'graphifyy', mode: 'code-only', stats: index.stats }) + '\n');
  return { bytes: explorerBytes.byteLength, path: join(target, 'index.html'), stats: index.stats };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 5) {
    console.error('Usage: pack.mjs GRAPHIFY_OUT PAGES_DIR FULL_SOURCE_SHA');
    process.exitCode = 2;
  } else {
    packGraph(process.argv[2], process.argv[3], process.argv[4])
      .then(result => console.log('Graphify Pages bundle:', result))
      .catch(error => { console.error(error); process.exitCode = 1; });
  }
}
