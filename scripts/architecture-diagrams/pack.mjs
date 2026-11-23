import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DIAGRAM_DOCUMENTS = Object.freeze([
  { id: 'system', label: 'システム全体', path: 'docs/architecture/SYSTEM-DESIGN.md' },
  { id: 'data', label: 'データモデル', path: 'docs/architecture/DATA-MODEL.md' },
  { id: 'user', label: '利用画面', path: 'docs/design/USER-SCREEN-FLOW.md' },
  { id: 'admin', label: '管理・認証画面', path: 'docs/design/ADMIN-SCREEN-FLOW.md' },
  { id: 'first', label: '初期デプロイ', path: 'docs/deployment/INITIAL-DEPLOYMENT-FLOW.md' },
  { id: 'update', label: 'アップデートと復旧', path: 'docs/deployment/UPDATE-FLOW.md' },
]);

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const ALLOWED = /^(flowchart|stateDiagram-v2|erDiagram)(?:\s|$)/u;
const MAX_SOURCE_BYTES = 24 * 1024;
const MAX_SVG_BYTES = 4 * 1024 * 1024;

export function parseMermaidDiagrams(markdown, section) {
  assert.ok(section && /^[a-z]+$/u.test(section.id), 'Invalid section identity');
  assert.ok(typeof markdown === 'string', 'Markdown source must be text');
  const lines = markdown.split(/\r?\n/u);
  const diagrams = [];
  let heading = basename(section.path, '.md');
  for (let i = 0; i < lines.length; i++) {
    const h = /^#{1,4}\s+(.+)$/u.exec(lines[i]);
    if (h) heading = h[1].replace(/[#\s]+$/gu, '').trim();
    if (lines[i].trim() !== '```mermaid') continue;
    const start = i + 1;
    const code = [];
    while (++i < lines.length && lines[i].trim() !== '```') code.push(lines[i]);
    assert.ok(i < lines.length, `Missing Mermaid closing fence in ` + section.path);
    const source = code.join('\n').trim();
    assert.ok(source.length > 0 && Buffer.byteLength(source, 'utf8') <= MAX_SOURCE_BYTES,
      'Missing or oversized diagram in ' + section.path);
    assert.match(source, ALLOWED, 'Unexpected diagram type in ' + section.path);
    const index = diagrams.length + 1;
    diagrams.push({
      id: section.id + '-' + index,
      group: section.id,
      groupLabel: section.label,
      title: heading,
      markdown: section.path,
      line: start,
      kind: source.split(/\s/u, 1)[0],
      image: 'svg/' + section.id + '-' + index + '.svg',
      source,
    });
  }
  return diagrams;
}

export function createManifest(sha, sources) {
  assert.match(sha, /^[a-f0-9]{40}$/u, 'Expected a source commit SHA');
  const diagrams = sources.flatMap(({ section, markdown }) => parseMermaidDiagrams(markdown, section));
  assert.ok(diagrams.length >= 14 && diagrams.length <= 32, 'Incomplete or excessive architecture diagram catalog');
  for (const group of ['system', 'data', 'user', 'admin', 'first', 'update']) {
    assert.ok(diagrams.some(d => d.group === group), 'Missing required diagram group: ' + group);
  }
  return {
    format: 'codexia-architecture-atlas/v1',
    sourceSha: sha,
    diagrams: diagrams.map(({ source, ...published }) => published),
  };
}

export async function buildAtlas(siteDir, sha, rendererPath, root = ROOT) {
  assert.ok(typeof rendererPath === 'string' && rendererPath.length, 'A pinned Mermaid CLI is required');
  const sources = await Promise.all(DIAGRAM_DOCUMENTS.map(async section =>
    ({ section, markdown: await readFile(join(root, section.path), 'utf8') })));
  const manifest = createManifest(sha, sources);
  const diagrams = sources.flatMap(({ section, markdown }) => parseMermaidDiagrams(markdown, section));
  const output = join(resolve(siteDir), 'architecture');
  const stage = await mkdtemp(join(tmpdir(), 'codexia-mermaid-'));
  try {
    await mkdir(join(output, 'svg'), { recursive: true });
    for (const diagram of diagrams) {
      const input = join(stage, diagram.id + '.mmd');
      const dest = join(output, diagram.image);
      await writeFile(input, diagram.source + '\n');
      execFileSync(rendererPath, ['-i', input, '-o', dest, '-t', 'neutral', '-b', 'white'], {
        stdio: 'pipe', timeout: 90000, maxBuffer: 2 * 1024 * 1024,
      });
      const rendered = await readFile(dest);
      assert.ok(rendered.length > 100 && rendered.length <= MAX_SVG_BYTES &&
        /<svg(?:\s|>)/u.test(rendered.toString('utf8', 0, 2048)) &&
        /<\/svg>/u.test(rendered.toString('utf8', Math.max(0, rendered.length - 2048))),
        'Mermaid CLI did not produce a valid SVG: ' + diagram.id);
    }
    for (const file of ['index.html', 'atlas.css', 'atlas.js']) {
      await cp(new URL('./' + file, import.meta.url), join(output, file));
    }
    await writeFile(join(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
  return { output, count: diagrams.length, sourceSha: sha };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 5) {
    console.error('Usage: node scripts/architecture-diagrams/pack.mjs <site-dir> <commit-sha> <pinned-mmdc-bin>');
    process.exitCode = 2;
  } else {
    buildAtlas(process.argv[2], process.argv[3], process.argv[4])
      .then(result => console.log(JSON.stringify(result)))
      .catch(error => { console.error(error); process.exitCode = 1; });
  }
}
