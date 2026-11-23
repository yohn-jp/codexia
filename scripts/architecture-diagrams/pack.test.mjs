import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createManifest, DIAGRAM_DOCUMENTS, parseMermaidDiagrams } from './pack.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const sha = 'a'.repeat(40);

test('all canonical system, UI, administration and delivery diagrams have stable source identity', () => {
  const sources = DIAGRAM_DOCUMENTS.map(section => ({
    section,
    markdown: readFileSync(join(root, section.path), 'utf8'),
  }));
  const manifest = createManifest(sha, sources);
  assert.equal(manifest.format, 'codexia-architecture-atlas/v1');
  assert.equal(manifest.sourceSha, sha);
  assert.equal(manifest.diagrams.length, 17);
  assert.equal(new Set(manifest.diagrams.map(d => d.id)).size, 17);
  assert.deepEqual([...new Set(manifest.diagrams.map(d => d.group))],
    ['system', 'data', 'user', 'admin', 'first', 'update']);
  assert.ok(manifest.diagrams.some(d => d.id === 'admin-4' && d.title.includes('管理コンソール')));
  assert.ok(manifest.diagrams.some(d => d.id === 'admin-5' && d.title.includes('初回所有者登録')));
  assert.ok(manifest.diagrams.some(d => d.id === 'first-3' && d.title.includes('VMの再構築')));
  assert.ok(manifest.diagrams.every(d => d.markdown.startsWith('docs/') &&
    /^svg\/[a-z]+-\d+\.svg$/u.test(d.image) &&
    d.line > 0 && d.title.length > 0 && !('source' in d)));
});

test('reject malformed Mermaid and unknown diagram types before publishing', () => {
  const section = DIAGRAM_DOCUMENTS[0];
  assert.throws(() => parseMermaidDiagrams('## Head\n```mermaid\nflowchart LR\nA --> B', section),
    /Missing Mermaid closing fence/u);
  assert.throws(() => parseMermaidDiagrams('## Head\n```mermaid\nsequenceDiagram\nA->>B: secret\n```', section),
    /Unexpected diagram type/u);
  assert.throws(() => createManifest('bad', []), /Expected a source commit SHA/u);
  assert.throws(() => createManifest(sha, []), /Incomplete/u);
});

test('source line and heading resolve to the correct Mermaid block', () => {
  const section = DIAGRAM_DOCUMENTS[0];
  const diagrams = parseMermaidDiagrams('# Doc\n## First\n```mermaid\nflowchart LR\nA --> B\n```\n## Second\n```mermaid\nstateDiagram-v2\n[*] --> Ready\n```\n', section);
  assert.deepEqual(diagrams.map(d => [d.id, d.title, d.line, d.kind]), [
    ['system-1', 'First', 4, 'flowchart'],
    ['system-2', 'Second', 9, 'stateDiagram-v2'],
  ]);
});