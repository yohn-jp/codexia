import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createManifest,
  DIAGRAM_CATALOG_PATH,
  SCREEN_CONTROL_PATH,
  SYSTEM_DESIGN_PATH,
} from './pack.mjs';
import {
  LIKEC4_OPERATIONS_VIEW_ID,
  LIKEC4_SOURCE_PATH,
  LIKEC4_VIEW_ID,
} from '../architecture/contract.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const sha = 'a'.repeat(40);

test('all canonical system, UI, administration and delivery diagrams retain their stable identities', async () => {
  const manifest = await createManifest(sha, root);
  assert.equal(manifest.format, 'codexia-architecture-atlas/v1');
  assert.equal(manifest.sourceSha, sha);
  const diagramDirectory = dirname(DIAGRAM_CATALOG_PATH);
  const mermaidFiles = (await readdir(join(root, diagramDirectory))).filter(name => name.endsWith('.mmd'));
  assert.ok(mermaidFiles.length >= 40, 'The full screen catalog must be rendered');
  assert.equal(manifest.diagrams.length, mermaidFiles.length + 2);
  assert.deepEqual(manifest.diagrams.filter(d => d.renderer === 'mermaid').map(d => d.sourcePath).sort(),
    mermaidFiles.map(name => join(diagramDirectory, name)).sort());
  assert.equal(new Set(manifest.diagrams.map(d => d.id)).size, manifest.diagrams.length);
  assert.deepEqual([...new Set(manifest.diagrams.map(d => d.group))],
    ['system', 'data', 'user', 'admin', 'screen', 'first', 'update', 'lifecycle']);
  assert.ok(manifest.diagrams.some(d => d.id === 'admin-4' && d.title.includes('管理コンソール')));
  assert.ok(manifest.diagrams.some(d => d.id === 'admin-5' && d.title.includes('初回所有者登録')));
  assert.ok(manifest.diagrams.some(d => d.id === 'first-3' && d.title.includes('VMの再構築')));
  assert.deepEqual(manifest.diagrams.filter(d => d.group === 'lifecycle').map(d => [d.id, d.designPath, d.kind]), [
    ['lifecycle-1', 'docs/deployment/DEPLOYMENT-LIFECYCLE.sdoc', 'flowchart'],
  ]);
  const modelSource = await readFile(join(root, LIKEC4_SOURCE_PATH), 'utf8');
  const modelDigest = createHash('sha256').update(modelSource).digest('hex');
  for (const [id, viewId] of [['system-1', LIKEC4_VIEW_ID], ['system-3', LIKEC4_OPERATIONS_VIEW_ID]]) {
    const diagram = manifest.diagrams.find(d => d.id === id);
    assert.equal(diagram.renderer, 'likec4');
    assert.equal(diagram.viewId, viewId);
    assert.equal(diagram.designPath, SYSTEM_DESIGN_PATH);
    assert.equal(diagram.artifact, 'likec4/codexia-architecture.mjs');
    assert.equal(diagram.sourcePath, LIKEC4_SOURCE_PATH);
    assert.equal(diagram.sourceModel, LIKEC4_SOURCE_PATH);
    assert.equal(diagram.sourceModelSha256, modelDigest);
    assert.equal(modelSource.split(/\r?\n/u)[diagram.line - 1].trim(), 'view ' + viewId + ' {');
  }
  assert.ok(manifest.diagrams.some(d => d.id === 'system-2' && d.title === '運用プレーンと更新'),
    'The operations process remains at its stable Mermaid locator');
  assert.ok(manifest.diagrams.some(d => d.id === 'screen-19' && d.title.includes('CON-01')));
  assert.ok(manifest.diagrams.every(d => d.designPath.endsWith('.sdoc') && d.designUid === 'ATLAS-DIAGRAM-' + d.id &&
    (d.renderer === 'likec4' || (d.image === 'svg/' + d.id + '.svg' && d.line === 1)) &&
    d.title.length > 0 && !('source' in d)));
  const crossShell = manifest.diagrams.filter(d => d.group === 'screen' && d.title.includes('Cross-shell'));
  assert.equal(crossShell.length, 1, 'The cross-shell contract must have one rendered diagram');
  assert.match(await readFile(join(root, crossShell[0].sourcePath), 'utf8'), /^flowchart\s/u);
  assert.ok(manifest.diagrams.some(d => d.screenIds.includes('KNO-03') && d.designStatus === '未採用提案・未実装'),
    'Unadopted knowledge graph screen must preserve its diagram status');
});

test('screen diagrams link to their adopted inventory records and related implementation', async () => {
  const { diagrams } = await createManifest(sha, root);
  const entry = diagrams.find(d => d.id === 'screen-1');
  assert.ok(entry.screenIds.includes('ENTRY-01'), 'ENTRY-01 must have its original diagram ID');
  const entryDocument = await readFile(join(root, 'app/index.html'), 'utf8');
  const moduleScripts = [...entryDocument.matchAll(/<script\b([^>]*)>/giu)]
    .map(([, attributes]) => attributes)
    .filter(attributes => /\btype\s*=\s*(["'])module\1/iu.test(attributes))
    .map(attributes => /\bsrc\s*=\s*(["'])([^"']+)\1/iu.exec(attributes)?.[2]);
  assert.deepEqual(moduleScripts, ['/src/launcher.tsx'], 'The web entry document must load the launcher');
  assert.deepEqual(entry.implementationPaths, ['app/src/launcher.tsx']);
  assert.ok((await stat(join(root, entry.implementationPaths[0]))).isFile(), 'The linked web entry must exist');
  assert.equal(entry.designPath, 'docs/design/SCREEN-STATE-ATLAS.sdoc');
  assert.match(await readFile(join(root, entry.sourcePath), 'utf8'), /^flowchart\s/u);
  assert.equal(entry.screenContracts.length, 1);
  const entryContract = entry.screenContracts[0];
  const screenCatalog = await readFile(join(root, SCREEN_CONTROL_PATH), 'utf8');
  assert.equal(entryContract.id, 'ENTRY-01');
  assert.equal(entryContract.path, SCREEN_CONTROL_PATH);
  assert.equal(entryContract.status, '実装');
  assert.equal(screenCatalog.split(/\r?\n/u)[entryContract.line - 1].trim(), '"id": "ENTRY-01",');
  assert.ok(diagrams.filter(d => d.screenIds.includes('CON-01'))
    .every(d => d.implementationPaths.length === 0), 'Goal screens without a direct implementation stay unmapped');
});

test('reject a missing specialist source and unsupported Mermaid kinds', async t => {
  await assert.rejects(createManifest('bad', root), /Expected a source commit SHA/u);
  const fixture = await mkdtemp(join(tmpdir(), 'codexia-atlas-source-'));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const catalogDirectory = dirname(DIAGRAM_CATALOG_PATH);
  for (const input of [catalogDirectory, SCREEN_CONTROL_PATH, LIKEC4_SOURCE_PATH]) {
    await mkdir(dirname(join(fixture, input)), { recursive: true });
    await cp(join(root, input), join(fixture, input), { recursive: true });
  }
  const firstDiagram = join(fixture, catalogDirectory, 'system-2.mmd');
  await writeFile(firstDiagram, 'sequenceDiagram\nA->>B: message\n');
  await assert.rejects(createManifest(sha, fixture), /Unexpected diagram type: .*system-2\.mmd/u);
  await rm(firstDiagram);
  await assert.rejects(createManifest(sha, fixture), { code: 'ENOENT', path: firstDiagram });
});
