#!/usr/bin/env node
// Publish a file-level explorer derived from Graphify's AST graph and preserve its native overview.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXCLUSION_PATTERNS, exclusionCategory, repositoryPath, summarizeGraph } from './analysis.mjs';

import { projectCommunities } from './community-data.mjs';

const MAX_HTML_BYTES = 20 * 1024 * 1024;
const MAX_GRAPH_BYTES = 80 * 1024 * 1024;
const MAX_CANDIDATE_BYTES = 16 * 1024 * 1024;
const MAX_INDEX_BYTES = 16 * 1024 * 1024;
const MAX_SOURCE_BYTES = 16 * 1024 * 1024;
const DATA_SLOT = '__GRAPHIFY_INDEX_JSON__';
const LINKS_SLOT = '__GRAPHIFY_SOURCE_LINKS__';
export { summarizeGraph } from './analysis.mjs';

export function trackedPathsFromGit(repoRoot = process.cwd()) {
  const inventory = execFileSync('git', ['ls-files', '--cached', '-z'], { cwd: repoRoot, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  const paths = new Set(inventory.split('\0').filter(Boolean));
  if (paths.size === 0) throw new Error('Git returned no tracked files');
  return paths;
}

function validateCandidateInventory(inventory, sha, trackedFiles) {
  if (!inventory || typeof inventory !== 'object' || inventory.schemaVersion !== 1 || inventory.codeOnly !== true || inventory.generator !== 'graphify.detect' || inventory.generatorVersion !== '0.9.121') {
    throw new Error('Graphify candidate inventory has an unsupported schema or generator');
  }
  if (inventory.sourceSha !== sha) throw new Error('Graphify candidate inventory source SHA does not match the graph');
  if (!Array.isArray(inventory.excludes) || inventory.excludes.length !== EXCLUSION_PATTERNS.length || inventory.excludes.some((pattern, index) => pattern !== EXCLUSION_PATTERNS[index])) {
    throw new Error('Graphify candidate inventory exclusions do not match the Pages recipe');
  }
  if (!Array.isArray(inventory.files)) throw new Error('Graphify candidate inventory requires a files array');
  const paths = new Set();
  for (const value of inventory.files) {
    const path = repositoryPath(value);
    if (!path || exclusionCategory(path)) throw new Error('Graphify candidate inventory contains an invalid or excluded path');
    if (paths.has(path)) throw new Error('Graphify candidate inventory contains duplicate paths');
    paths.add(path);
  }
  return new Set([...paths].filter(path => trackedFiles.has(path)));
}

export async function packGraph(sourceDir, pagesDir, sha, trackedFiles = trackedPathsFromGit(), candidateInventoryPath = null) {
  if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error('Graph source must be a full commit SHA');
  const source = resolve(sourceDir);
  // Keep the upstream graph and append a source-bound community inspector.
  const htmlBytes = await readFile(join(source, 'graph.html'));
  if (htmlBytes.byteLength < 100 || htmlBytes.byteLength > MAX_HTML_BYTES) throw new Error('Graph HTML empty or over 20 MiB limit');
  const html = htmlBytes.toString('utf8');
  if (!/<html\b/i.test(html) || !/<\/html\s*>/i.test(html)) throw new Error('Graphify did not generate a complete HTML document');

  const graphBytes = await readFile(join(source, 'graph.json'));
  if (graphBytes.byteLength < 2 || graphBytes.byteLength > MAX_GRAPH_BYTES) throw new Error('Graph JSON empty or over 80 MiB limit');
  const graph = JSON.parse(graphBytes.toString('utf8'));
  if (graph && typeof graph.built_at_commit === 'string' && graph.built_at_commit !== sha) {
    throw new Error(`Graphify graph was built for ${graph.built_at_commit}, expected ${sha}`);
  }
  let candidates = null;
  if (candidateInventoryPath) {
    let inventory = candidateInventoryPath;
    if (typeof candidateInventoryPath === 'string') {
      const candidateBytes = await readFile(resolve(candidateInventoryPath));
      if (candidateBytes.byteLength < 2 || candidateBytes.byteLength > MAX_CANDIDATE_BYTES) throw new Error('Graphify candidate inventory empty or over 16 MiB limit');
      inventory = JSON.parse(candidateBytes.toString('utf8'));
    }
    candidates = validateCandidateInventory(inventory, sha, trackedFiles);
  }
  const index = summarizeGraph(graph, sha, trackedFiles, candidates);
  const communities = projectCommunities(graph, index);
  if (candidates && graph.nodes.length && !communities.groups.length) throw new Error('Clustered Graphify graph has no community assignments');
  const communityTemplate = await readFile(new URL('./community-panel.html', import.meta.url), 'utf8');
  const communityPayload = JSON.stringify(communities).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  const communitySlot = '__GRAPHIFY_COMMUNITY_JSON__';
  if (communityTemplate.split(communitySlot).length !== 2) throw new Error('Community panel requires one data slot');
  const closing = /<\/body\s*>\s*<\/html\s*>\s*$/i;
  if (!closing.test(html)) throw new Error('Graphify HTML requires a closing body');
  const communityHtml = html.replace(closing, tail => communityTemplate.replace(communitySlot, () => communityPayload) + tail);
  const communityBytes = Buffer.from(communityHtml, 'utf8');
  if (communityBytes.byteLength > MAX_HTML_BYTES) throw new Error('Graph community explorer exceeds 20 MiB limit');
  // The JSON is part of the HTML, but source snippets, graph.json and raw graph edges aren't published separately.
  const payload = JSON.stringify(index).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  const template = await readFile(new URL('./explorer.html', import.meta.url), 'utf8');
  if (template.split(DATA_SLOT).length !== 2 || template.split(LINKS_SLOT).length !== 2) throw new Error('Explorer template requires one data and source-links slot');
  // Pre-render fixed-origin, SHA-pinned source anchors rather than deriving HTML URLs from DOM text.
  const sourceLinks = index.files.map(f => '<a hidden target="_blank" rel="noopener noreferrer" href="https://github.com/yohn-jp/codexia/blob/' + sha + '/' + f.path.split('/').map(encodeURIComponent).join('/') + '">GitHubでソースを開く</a>').join('');
  const replacements = new Map([[DATA_SLOT, payload], [LINKS_SLOT, sourceLinks]]);
  const explorer = template.replace(/__GRAPHIFY_(?:INDEX_JSON|SOURCE_LINKS)__/gu, slot => replacements.get(slot));
  const explorerBytes = Buffer.from(explorer, 'utf8');
  if (explorerBytes.byteLength > MAX_INDEX_BYTES) throw new Error('Graph explorer exceeds 16 MiB limit');
  const sourceBytes = Buffer.from(JSON.stringify({
    schemaVersion: 1,
    sourceSha: sha,
    generator: 'graphifyy',
    mode: index.coverage.mode,
    stats: index.stats,
    coverage: index.coverage,
    relations: index.relations,
    // Atlas may resolve only paths actually present in this same-SHA graph index.
    files: index.files.map(file => ({ path: file.path })),
  }) + '\n', 'utf8');
  if (sourceBytes.byteLength > MAX_SOURCE_BYTES) throw new Error('Graph source manifest exceeds 16 MiB limit');

  const target = join(resolve(pagesDir), 'graph');
  await mkdir(target, { recursive: true });
  await writeFile(join(target, 'index.html'), explorerBytes);
  await writeFile(join(target, 'communities.html'), communityBytes);
  await writeFile(join(target, 'analysis.mjs'), await readFile(new URL('./analysis.mjs', import.meta.url)));
  await writeFile(join(target, 'source.json'), sourceBytes);
  return { bytes: explorerBytes.byteLength, path: join(target, 'index.html'), stats: index.stats };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 5 && process.argv.length !== 6) {
    console.error('Usage: pack.mjs GRAPHIFY_OUT PAGES_DIR FULL_SOURCE_SHA [CANDIDATES_JSON]');
    process.exitCode = 2;
  } else {
    packGraph(process.argv[2], process.argv[3], process.argv[4], undefined, process.argv[5] || null)
      .then(result => console.log('Graphify Pages bundle:', result))
      .catch(error => { console.error(error); process.exitCode = 1; });
  }
}
