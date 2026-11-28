import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertNoPublicSecrets,
  LIKEC4_OPERATIONS_VIEW_ID,
  LIKEC4_OPERATIONS_VIEW_TITLE,
  LIKEC4_SOURCE_PATH,
  LIKEC4_VIEW_ID,
  LIKEC4_VIEW_TITLE,
} from '../architecture/contract.mjs';
import { generateLikeC4Webcomponent, LIKEC4_PUBLIC_BUNDLE } from '../architecture/webcomponent.mjs';

export const DIAGRAM_CATALOG_PATH = 'docs/architecture/diagrams/catalog.json';
export const SCREEN_CONTROL_PATH = 'docs/design/screen-catalog.json';
export const SYSTEM_DESIGN_PATH = 'docs/architecture/SYSTEM-DESIGN.sdoc';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const DIAGRAM_DIRECTORY = dirname(DIAGRAM_CATALOG_PATH);
const DIAGRAM_ID = /^([a-z]+)-[1-9]\d*$/u;
const DESIGN_PATH = /^docs\/(?:architecture|design|deployment)\/[A-Z0-9-]+\.sdoc$/u;
const ALLOWED = /^(flowchart|stateDiagram-v2|erDiagram)(?:\s|$)/u;
const MAX_SOURCE_BYTES = 24 * 1024;
const MAX_SVG_BYTES = 4 * 1024 * 1024;
const LIKEC4_DIAGRAMS = [
  { id: 'system-1', viewId: LIKEC4_VIEW_ID, title: LIKEC4_VIEW_TITLE, groupLabel: 'システム全体' },
  { id: 'system-3', viewId: LIKEC4_OPERATIONS_VIEW_ID, title: LIKEC4_OPERATIONS_VIEW_TITLE, groupLabel: '運用プレーン' },
];

// Curated links to code that directly owns the matching route or screen surface.
// These are related-source pointers, not proof that the design contract is accepted.
const SCREEN_IMPLEMENTATION_PATHS = {
  'ENTRY-01': ['app/src/launcher.tsx'],
  'AUTH-01': ['app/src/OAuthLoginPage.tsx', 'app/src/oauth-login.ts'],
  'AUTH-02': ['app/src/OAuthConsentPage.tsx', 'app/src/oauth-consent.ts'],
  'LIB-01': ['app/src/persistence/PersistenceEntry.tsx', 'app/src/persistence/PersistenceWorkspace.tsx'],
  'WRT-01': ['app/src/persistence/PersistenceWorkspace.tsx'],
  'READ-01': ['app/src/editor/MobileReadingPager.tsx'],
};

function screenContracts(catalog) {
  const { screens } = JSON.parse(catalog);
  const entries = new Map();
  for (const { id, kind } of screens) {
    assert.match(id, /^[A-Z]+-\d{2}$/u, 'Invalid screen ID');
    assert.ok(!entries.has(id), 'Duplicate screen declaration: ' + id);
    // JSON owns the screen and its status. The text supplies only clickable source coordinates.
    const offset = catalog.search(new RegExp('"id"\\s*:\\s*' + JSON.stringify(id), 'u'));
    const line = catalog.slice(0, Math.max(0, offset)).split('\n').length;
    entries.set(id, { id, path: SCREEN_CONTROL_PATH, line, status: kind ?? '記載なし' });
  }
  return entries;
}

function likeC4Diagrams(modelSource) {
  const lines = modelSource.split(/\r?\n/u);
  const sourceModelSha256 = createHash('sha256').update(modelSource, 'utf8').digest('hex');
  return LIKEC4_DIAGRAMS.map(({ id, viewId, title, groupLabel }) => {
    const line = lines.findIndex(item => item.trim().startsWith('view ' + viewId + ' {')) + 1;
    assert.ok(line > 0, 'Missing canonical LikeC4 view: ' + viewId);
    return {
      id, group: 'system', groupLabel, title,
      designPath: SYSTEM_DESIGN_PATH, designUid: 'ATLAS-DIAGRAM-' + id,
      sourcePath: LIKEC4_SOURCE_PATH, line, kind: 'LikeC4',
      screenIds: [], designStatus: null, implementationPaths: [], screenContracts: [],
      renderer: 'likec4', viewId, artifact: LIKEC4_PUBLIC_BUNDLE,
      sourceModel: LIKEC4_SOURCE_PATH, sourceModelSha256,
    };
  });
}

async function mermaidDiagram(root, { id, title, screenIds = [], designStatus = null }, groups, contracts) {
  const group = DIAGRAM_ID.exec(id)?.[1];
  const section = groups[group];
  assert.ok(section && DESIGN_PATH.test(section.designPath) && typeof section.label === 'string' &&
    typeof title === 'string' && title.length > 0, 'Invalid architecture diagram entry: ' + id);
  const sourcePath = DIAGRAM_DIRECTORY + '/' + id + '.mmd';
  const source = await readFile(join(root, sourcePath), 'utf8');
  assert.ok(Buffer.byteLength(source, 'utf8') <= MAX_SOURCE_BYTES,
    'Oversized diagram: ' + sourcePath);
  assert.match(source, ALLOWED, 'Unexpected diagram type: ' + sourcePath);
  assertNoPublicSecrets([source]);
  return {
    id, group, groupLabel: section.label, title,
    designPath: section.designPath, designUid: 'ATLAS-DIAGRAM-' + id,
    sourcePath, line: 1, kind: source.split(/\s/u, 1)[0], renderer: 'mermaid',
    screenIds, designStatus,
    implementationPaths: [...new Set(screenIds.flatMap(screenId => SCREEN_IMPLEMENTATION_PATHS[screenId] ?? []))],
    screenContracts: screenIds.flatMap(screenId => contracts.get(screenId) ?? []),
    image: 'svg/' + id + '.svg',
  };
}

export async function createManifest(sha, root = ROOT) {
  assert.match(sha, /^[a-f0-9]{40}$/u, 'Expected a source commit SHA');
  const [catalog, screenCatalog, modelSource] = await Promise.all([
    readFile(join(root, DIAGRAM_CATALOG_PATH), 'utf8'),
    readFile(join(root, SCREEN_CONTROL_PATH), 'utf8'),
    readFile(join(root, LIKEC4_SOURCE_PATH), 'utf8'),
  ]);
  const { groups, diagrams } = JSON.parse(catalog);
  const contracts = screenContracts(screenCatalog);
  assertNoPublicSecrets([catalog, screenCatalog, modelSource]);
  const mermaid = await Promise.all(diagrams.map(diagram => mermaidDiagram(root, diagram, groups, contracts)));
  const allDiagrams = [...likeC4Diagrams(modelSource), ...mermaid];
  assert.equal(new Set(allDiagrams.map(({ id }) => id)).size, allDiagrams.length, 'Duplicate architecture diagram ID');
  assert.ok(allDiagrams.length >= 40 && allDiagrams.length <= 64, 'Incomplete or excessive architecture diagram catalog');
  assert.ok(mermaid.some(({ id }) => id === 'system-2'),
    'Incomplete architecture atlas: system operations Mermaid must remain registered');
  assert.ok(mermaid.filter(({ group }) => group === 'screen').length >= 23,
    'Accepted logical screens require their individual state diagrams');
  for (const group of ['system', 'data', 'user', 'admin', 'screen', 'first', 'update', 'lifecycle']) {
    assert.ok(allDiagrams.some(diagram => diagram.group === group), 'Missing required diagram group: ' + group);
  }
  for (const { id } of contracts.values()) {
    if (id === 'OPS-01' || id === 'CFG-01') continue;
    assert.ok(mermaid.some(({ group, screenIds }) => group === 'screen' && screenIds.includes(id)),
      'Missing transition diagram for cataloged screen: ' + id);
  }

  const designFiles = new Map(await Promise.all([...new Set(allDiagrams.map(({ designPath }) => designPath))]
    .map(async path => [path, await readFile(join(root, path), 'utf8')])));
  assertNoPublicSecrets([designFiles.get(SYSTEM_DESIGN_PATH)]);
  for (const { designPath, designUid } of allDiagrams) {
    assert.ok(designFiles.get(designPath).includes('[ANCHOR: ' + designUid + ']'),
      'Missing StrictDoc design anchor: ' + designPath + '#' + designUid);
  }
  return { format: 'codexia-architecture-atlas/v1', sourceSha: sha, diagrams: allDiagrams };
}

export async function buildAtlas(siteDir, sha, rendererPath, root = ROOT) {
  assert.ok(typeof rendererPath === 'string' && rendererPath.length, 'A pinned Mermaid CLI is required');
  const manifest = await createManifest(sha, root);
  const output = join(resolve(siteDir), 'architecture');
  const stage = await mkdtemp(join(tmpdir(), 'codexia-mermaid-'));
  try {
    await mkdir(join(output, 'svg'), { recursive: true });
    const likec4Dir = join(output, 'likec4');
    await mkdir(likec4Dir, { recursive: true });
    generateLikeC4Webcomponent(join(root, 'docs/architecture/likec4'), join(output, LIKEC4_PUBLIC_BUNDLE));
    const themeConfig = join(stage, 'mermaid-theme.json');
    await writeFile(themeConfig, JSON.stringify({
      theme: 'base',
      themeVariables: {
        background: '#ffffff',
        primaryColor: '#dbeafe',
        primaryTextColor: '#10213e',
        primaryBorderColor: '#5172a4',
        secondaryColor: '#e9f2ff',
        tertiaryColor: '#f1f5f9',
        lineColor: '#475569',
        textColor: '#172033',
        edgeLabelBackground: '#ffffff',
        clusterBkg: '#f8fafc',
        clusterBorder: '#71839c',
        fontFamily: 'system-ui, sans-serif',
        fontSize: '16px',
      },
    }));
    for (const diagram of manifest.diagrams) {
      if (diagram.renderer === 'likec4') continue;
      const input = join(root, diagram.sourcePath);
      const dest = join(output, diagram.image);
      const rendererArgs = ['-i', input, '-o', dest, '-c', themeConfig, '-t', 'base', '-b', 'white'];
      execFileSync(rendererPath.endsWith('.mjs') ? process.execPath : rendererPath,
        rendererPath.endsWith('.mjs') ? [rendererPath, ...rendererArgs] : rendererArgs, {
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
  return { output, count: manifest.diagrams.length, sourceSha: sha };
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
