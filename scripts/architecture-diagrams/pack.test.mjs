import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createManifest,
  DIAGRAM_DOCUMENTS,
  parseLikeC4Diagram,
  parseMermaidDiagrams,
  SYSTEM_DESIGN_PATH,
} from './pack.mjs';
import {
  LIKEC4_OPERATIONS_VIEW_ID,
  LIKEC4_OPERATIONS_VIEW_TITLE,
  LIKEC4_VIEW_ID,
  LIKEC4_VIEW_TITLE,
} from '../architecture/contract.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const sha = 'a'.repeat(40);

test('all canonical system, UI, administration and delivery diagrams have stable source identity', () => {
  const sources = DIAGRAM_DOCUMENTS.map(section => ({
    section,
    markdown: readFileSync(join(root, section.path), 'utf8'),
  }));
  const catalog = readFileSync(join(root, 'docs/design/SCREEN-CONTROL-CATALOG.md'), 'utf8');
  const modelSource = readFileSync(join(root, 'docs/architecture/likec4/model.likec4'), 'utf8');
  const systemDesign = readFileSync(join(root, SYSTEM_DESIGN_PATH), 'utf8');
  const modelDiagram = parseLikeC4Diagram(modelSource, systemDesign, {
    id: 'system-1', viewId: LIKEC4_VIEW_ID, title: LIKEC4_VIEW_TITLE,
  });
  const operationsDiagram = parseLikeC4Diagram(modelSource, systemDesign, {
    id: 'system-3', viewId: LIKEC4_OPERATIONS_VIEW_ID, title: LIKEC4_OPERATIONS_VIEW_TITLE,
    heading: '## 運用プレーンと更新',
  });
  const manifest = createManifest(sha, sources, catalog, [modelDiagram, operationsDiagram]);
  assert.equal(manifest.format, 'codexia-architecture-atlas/v1');
  assert.equal(manifest.sourceSha, sha);
  const sourceCount = sources.reduce((total, item) =>
    total + item.markdown.split('\n').filter(line => line.trim() === '```mermaid').length, 0);
  assert.ok(sourceCount >= 40, 'The full screen catalog must be rendered');
  assert.equal(manifest.diagrams.length, sourceCount + 2);
  assert.equal(new Set(manifest.diagrams.map(d => d.id)).size, sourceCount + 2);
  assert.deepEqual([...new Set(manifest.diagrams.map(d => d.group))],
    ['system', 'data', 'user', 'admin', 'screen', 'first', 'update', 'lifecycle']);
  assert.ok(manifest.diagrams.some(d => d.id === 'admin-4' && d.title.includes('管理コンソール')));
  assert.ok(manifest.diagrams.some(d => d.id === 'admin-5' && d.title.includes('初回所有者登録')));
  assert.ok(manifest.diagrams.some(d => d.id === 'first-3' && d.title.includes('VMの再構築')));
  assert.deepEqual(manifest.diagrams.filter(d => d.group === 'lifecycle').map(d => [d.id, d.markdown, d.kind]), [
    ['lifecycle-1', 'docs/deployment/DEPLOYMENT-LIFECYCLE.md', 'flowchart'],
  ]);
  const systemOverview = manifest.diagrams.find(d => d.id === 'system-1');
  assert.equal(systemOverview.title, 'Codexia system context, containers, and trust boundaries');
  assert.equal(systemOverview.markdown, SYSTEM_DESIGN_PATH);
  assert.equal(systemOverview.renderer, 'likec4');
  assert.equal(systemOverview.viewId, LIKEC4_VIEW_ID);
  assert.equal(systemOverview.artifact, 'likec4/codexia-architecture.mjs');
  assert.equal(systemOverview.sourceModel, 'docs/architecture/likec4/model.likec4');
  assert.equal(systemOverview.sourceModelSha256, createHash('sha256').update(modelSource).digest('hex'));
  assert.match(systemDesign.split(/\r?\n/u)[systemOverview.line - 1], /\[LikeC4 system model\]\(\.\/likec4\/model\.likec4\)/u);
  assert.ok(manifest.diagrams.some(d => d.id === 'system-2' && d.title === '運用プレーンと更新'),
    'The operations process remains at its stable Mermaid locator');
  const topology = manifest.diagrams.find(d => d.id === 'system-3');
  assert.equal(topology.renderer, 'likec4');
  assert.equal(topology.viewId, LIKEC4_OPERATIONS_VIEW_ID);
  assert.equal(topology.line, systemDesign.split(/\r?\n/u).findIndex(line => line.trim() === '## 運用プレーンと更新') + 1);
  const withAnotherSystemDiagram = sources.map(source => source.section.id === 'system'
    ? { ...source, markdown: source.markdown + '\n## Additional process\n\n```mermaid\nflowchart TD\n  A --> B\n```\n' }
    : source);
  const additional = createManifest(sha, withAnotherSystemDiagram, catalog, [modelDiagram, operationsDiagram])
    .diagrams.find(diagram => diagram.title === 'Additional process');
  assert.equal(additional?.id, 'system-4', 'Additional Mermaid entries must skip the native topology locator');
  assert.equal(additional?.image, 'svg/system-4.svg');
  assert.ok(manifest.diagrams.some(d => d.id === 'screen-1' && d.title.includes('ENTRY-01')));
  assert.ok(manifest.diagrams.some(d => d.id === 'screen-19' && d.title.includes('CON-01')));
  const screenSection = DIAGRAM_DOCUMENTS.find(section => section.id === 'screen');
  assert.ok(screenSection, 'The screen state atlas must remain registered');
  const screenSource = readFileSync(join(root, screenSection.path), 'utf8');
  const screenLines = screenSource.split(/\r?\n/u);
  const crossShellDiagrams = manifest.diagrams.filter(diagram =>
    diagram.group === 'screen' && diagram.title.includes('Cross-shell'));
  assert.equal(crossShellDiagrams.length, 1, 'The cross-shell contract must have one rendered diagram');
  const crossShell = crossShellDiagrams[0];
  assert.equal(crossShell.markdown, screenSection.path);
  assert.equal(screenLines[crossShell.line - 2], '```mermaid');
  assert.match(screenLines[crossShell.line - 1], /^flowchart\s/u);
  const crossHeading = screenLines.slice(0, crossShell.line - 2).findLast(line => /^#{1,4}\s/u.test(line));
  assert.equal(crossShell.title, crossHeading.replace(/^#{1,4}\s+/u, '').trim());
  assert.ok(manifest.diagrams.every(d => d.markdown.startsWith('docs/') &&
    (d.renderer === 'likec4' || /^svg\/[a-z]+-\d+\.svg$/u.test(d.image)) &&
    d.line > 0 && d.title.length > 0 && !('source' in d)));
  const entry = manifest.diagrams.find(d => d.screenIds.includes('ENTRY-01'));
  assert.ok(entry, 'ENTRY-01 must have a diagram');
  const entryDocument = readFileSync(join(root, 'app/index.html'), 'utf8');
  const moduleScripts = [...entryDocument.matchAll(/<script\b([^>]*)>/giu)]
    .map(([, attributes]) => attributes)
    .filter(attributes => /\btype\s*=\s*(["'])module\1/iu.test(attributes))
    .map(attributes => /\bsrc\s*=\s*(["'])([^"']+)\1/iu.exec(attributes)?.[2]);
  assert.equal(moduleScripts.length, 1, 'The web entry document must identify one module entry');
  const entryScript = moduleScripts[0];
  assert.equal(entryScript, '/src/launcher.tsx', 'The web entry document must load the launcher');
  assert.deepEqual(entry.implementationPaths, [`app${entryScript}`], 'ENTRY-01 must link to the actual web entry');
  assert.ok(statSync(join(root, entry.implementationPaths[0])).isFile(), 'The linked web entry must exist');
  assert.equal(entry.markdown, 'docs/design/SCREEN-STATE-ATLAS.md');
  assert.equal(screenLines[entry.line - 2], '```mermaid');
  assert.match(screenLines[entry.line - 1], /^flowchart\s/u);
  assert.match(screenLines.slice(0, entry.line - 2).findLast(line => /^#{1,4}\s/u.test(line)), /^## ENTRY-01\b/u);
  assert.equal(entry.screenContracts.length, 1);
  const entryContract = entry.screenContracts[0];
  assert.equal(entryContract.id, 'ENTRY-01');
  assert.equal(entryContract.status, '実装');
  assert.match(catalog.split(/\r?\n/u)[entryContract.line - 1], /^\| ENTRY-01 \|.*\| 実装 \|\s*$/u,
    'The contract link must identify the ENTRY-01 row and its published status');
  assert.ok(manifest.diagrams.filter(d => d.screenIds.includes('CON-01'))
    .every(d => d.implementationPaths.length === 0), 'goal screens without a direct implementation stay unmapped');
});

test('every cataloged product screen has an owned, rendered transition diagram', () => {
  const catalog = readFileSync(join(root, 'docs/design/SCREEN-CONTROL-CATALOG.md'), 'utf8');
  const section = DIAGRAM_DOCUMENTS.find(item => item.id === 'screen');
  assert.ok(section, 'Screen diagram authority must be registered');
  const markdown = readFileSync(join(root, section.path), 'utf8');
  const diagrams = parseMermaidDiagrams(markdown, section);
  const screens = [...catalog.matchAll(/^\|\s([A-Z]+-\d\d)\s\|/gmu)].map(match => match[1]);
  assert.ok(screens.length >= 28, 'Screen inventory must include product and security surfaces');
  const unmodeled = screens.filter(id => id !== 'OPS-01' &&
    !diagrams.some(diagram => diagram.title.includes(id)));
  assert.deepEqual(unmodeled, [],
    'All product screens require a transition graph; OPS-01 is a separate SSH/Ansible control plane');
  assert.ok(diagrams.some(d => d.title.includes('KNO-03') && d.title.includes('未実装')),
    'Unadopted knowledge graph screen must not be mistaken for a deployed feature');
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
