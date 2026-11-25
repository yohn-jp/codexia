import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
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

export const DIAGRAM_DOCUMENTS = Object.freeze([
  { id: 'system', label: 'システム全体', path: 'docs/architecture/SYSTEM-DESIGN.md' },
  { id: 'data', label: 'データモデル', path: 'docs/architecture/DATA-MODEL.md' },
  { id: 'user', label: '利用画面', path: 'docs/design/USER-SCREEN-FLOW.md' },
  { id: 'admin', label: '管理・認証画面', path: 'docs/design/ADMIN-SCREEN-FLOW.md' },
  { id: 'screen', label: '全画面の状態遷移', path: 'docs/design/SCREEN-STATE-ATLAS.md' },
  { id: 'first', label: '初期デプロイ', path: 'docs/deployment/INITIAL-DEPLOYMENT-FLOW.md' },
  { id: 'update', label: 'アップデートと復旧', path: 'docs/deployment/UPDATE-FLOW.md' },
  { id: 'lifecycle', label: '本番Deploymentライフサイクル', path: 'docs/deployment/DEPLOYMENT-LIFECYCLE.md' },
]);

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const ALLOWED = /^(flowchart|stateDiagram-v2|erDiagram)(?:\s|$)/u;
const MAX_SOURCE_BYTES = 24 * 1024;
const MAX_SVG_BYTES = 4 * 1024 * 1024;
export const LIKEC4_DERIVATIVE_PATH = 'docs/architecture/likec4/generated/system-overview.mmd';
export const SYSTEM_DESIGN_PATH = 'docs/architecture/SYSTEM-DESIGN.md';
// Curated links to code that directly owns the matching route or screen surface.
// These are related-source pointers, not proof that the design contract is accepted.
export const SCREEN_IMPLEMENTATION_PATHS = Object.freeze({
  'ENTRY-01': ['app/src/launcher.tsx'],
  'AUTH-01': ['app/src/OAuthLoginPage.tsx', 'app/src/oauth-login.ts'],
  'AUTH-02': ['app/src/OAuthConsentPage.tsx', 'app/src/oauth-consent.ts'],
  'LIB-01': ['app/src/persistence/PersistenceEntry.tsx', 'app/src/application/LibraryOutline.tsx'],
  'WRT-01': ['app/src/persistence/PersistenceWorkspace.tsx'],
  'READ-01': ['app/src/editor/MobileReadingPager.tsx'],
});
export const SCREEN_CONTROL_PATH = 'docs/design/SCREEN-CONTROL-CATALOG.md';

export function parseScreenContracts(markdown, screenIds) {
  const lines = markdown.split(/\r?\n/u);
  return screenIds.flatMap(id => {
    const index = lines.findIndex(line => new RegExp('^\\|\\s*' + id + '\\s*\\|', 'u').test(line));
    if (index < 0) return [];
    const cells = lines[index].split('|').slice(1, -1).map(cell => cell.trim());
    return [{ id, line: index + 1, status: cells.at(-1)?.replaceAll('*', '') ?? '記載なし' }];
  });
}

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
    const start = i + 2;
    const code = [];
    while (++i < lines.length && lines[i].trim() !== '```') code.push(lines[i]);
    assert.ok(i < lines.length, `Missing Mermaid closing fence in ` + section.path);
    const source = code.join('\n').trim();
    assert.ok(source.length > 0 && Buffer.byteLength(source, 'utf8') <= MAX_SOURCE_BYTES,
      'Missing or oversized diagram in ' + section.path);
    assert.match(source, ALLOWED, 'Unexpected diagram type in ' + section.path);
    const index = diagrams.length + 1;
    const screenIds = [...new Set([...heading.matchAll(/\b(?:ENTRY|AUTH|LIB|OUT|WRT|READ|REC|KNO|REV|TOOL|JOB|DISPLAY|PREF|PUB|CON|OPS)-\d{2}\b/gu)].map(match => match[0]))];
    const implementationPaths = [...new Set(screenIds.flatMap(id => SCREEN_IMPLEMENTATION_PATHS[id] ?? []))];
    diagrams.push({
      id: section.id + '-' + index,
      group: section.id,
      groupLabel: section.label,
      title: heading,
      markdown: section.path,
      line: start,
      kind: source.split(/\s/u, 1)[0],
      renderer: 'mermaid',
      screenIds,
      designStatus: /【([^】]+)】/u.exec(heading)?.[1] ?? null,
      implementationPaths,
      image: 'svg/' + section.id + '-' + index + '.svg',
      source,
    });
  }
  return diagrams;
}

/** @param {string} modelSource @param {string} derivative @param {string} systemDesign */
export function parseLikeC4Diagram(modelSource, systemDesign, { id, viewId, title: viewTitle, heading }) {
  assert.equal(typeof modelSource, 'string', 'LikeC4 model source must be text');
  assert.equal(typeof systemDesign, 'string', 'System design must be text');
  const sourceSha256 = createHash('sha256').update(modelSource, 'utf8').digest('hex');
  const lines = systemDesign.split(/\r?\n/u);
  const pointerLines = heading
    ? lines.flatMap((line, index) => line.trim() === heading ? [index + 1] : [])
    : lines.flatMap((line, index) =>
      line.includes(`[LikeC4 system model](./likec4/model.likec4)`) ? [index + 1] : []);
  assert.equal(pointerLines.length, 1, 'System design must contain one canonical LikeC4 provenance line');
  assertNoPublicSecrets([modelSource, systemDesign]);
  return {
    id,
    group: 'system',
    groupLabel: viewId === LIKEC4_OPERATIONS_VIEW_ID ? '運用プレーン' : 'システム全体',
    title: viewTitle,
    markdown: SYSTEM_DESIGN_PATH,
    line: pointerLines[0],
    kind: 'LikeC4',
    screenIds: [],
    designStatus: null,
    implementationPaths: [],
    renderer: 'likec4',
    viewId,
    artifact: LIKEC4_PUBLIC_BUNDLE,
    sourceModel: LIKEC4_SOURCE_PATH,
    sourceModelSha256: sourceSha256,
  };
}

function createAtlas(sha, sources, screenCatalog, nativeDiagrams) {
  assert.match(sha, /^[a-f0-9]{40}$/u, 'Expected a source commit SHA');
  assert.ok(nativeDiagrams.length >= 2, 'Incomplete architecture atlas: native LikeC4 views are required');
  const diagrams = sources.flatMap(({ section, markdown }) => parseMermaidDiagrams(markdown, section));
  const systemDiagrams = diagrams.filter(d => d.group === 'system');
  assert.ok(systemDiagrams.length > 0, 'Incomplete architecture atlas: system operations Mermaid must remain registered');
  let systemIndex = 2;
  const shiftedDiagrams = diagrams.map(diagram => {
    if (diagram.group !== 'system') return diagram;
    if (systemIndex === 3) systemIndex++;
    const shifted = { ...diagram, id: 'system-' + systemIndex };
    shifted.image = 'svg/' + shifted.id + '.svg';
    systemIndex++;
    return shifted;
  });
  const catalog = [...nativeDiagrams, ...shiftedDiagrams];
  assert.ok(catalog.length >= 40 && catalog.length <= 64, 'Incomplete or excessive architecture diagram catalog');
  assert.ok(catalog.filter(d => d.group === 'screen').length >= 23,
    'Accepted logical screens require their individual state diagrams');
  for (const group of ['system', 'data', 'user', 'admin', 'screen', 'first', 'update', 'lifecycle']) {
    assert.ok(catalog.some(d => d.group === group), 'Missing required diagram group: ' + group);
  }
  assert.equal(nativeDiagrams.find(d => d.viewId === LIKEC4_VIEW_ID)?.id, 'system-1',
    'The LikeC4 context view owns the stable system-1 locator');
  assert.equal(nativeDiagrams.find(d => d.viewId === LIKEC4_OPERATIONS_VIEW_ID)?.id, 'system-3',
    'The LikeC4 operations topology owns the system-3 locator');
  const manifest = {
    format: 'codexia-architecture-atlas/v1',
    sourceSha: sha,
    diagrams: catalog.map(({ source, ...published }) => ({
      ...published,
      screenContracts: parseScreenContracts(screenCatalog, published.screenIds),
    })),
  };
  return { catalog, manifest };
}

export function createManifest(sha, sources, screenCatalog = '', nativeDiagrams = []) {
  return createAtlas(sha, sources, screenCatalog, nativeDiagrams).manifest;
}

export async function buildAtlas(siteDir, sha, rendererPath, root = ROOT) {
  assert.ok(typeof rendererPath === 'string' && rendererPath.length, 'A pinned Mermaid CLI is required');
  const sources = await Promise.all(DIAGRAM_DOCUMENTS.map(async section =>
    ({ section, markdown: await readFile(join(root, section.path), 'utf8') })));
  const screenCatalog = await readFile(join(root, SCREEN_CONTROL_PATH), 'utf8');
  const [modelSource, systemDesign] = await Promise.all([
    readFile(join(root, LIKEC4_SOURCE_PATH), 'utf8'),
    readFile(join(root, SYSTEM_DESIGN_PATH), 'utf8'),
  ]);
  const systemDiagram = parseLikeC4Diagram(modelSource, systemDesign, {
    id: 'system-1', viewId: LIKEC4_VIEW_ID, title: LIKEC4_VIEW_TITLE,
  });
  const operationsDiagram = parseLikeC4Diagram(modelSource, systemDesign, {
    id: 'system-3', viewId: LIKEC4_OPERATIONS_VIEW_ID, title: LIKEC4_OPERATIONS_VIEW_TITLE,
    heading: '## 運用プレーンと更新',
  });
  const { catalog, manifest } = createAtlas(sha, sources, screenCatalog, [systemDiagram, operationsDiagram]);
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
    for (const diagram of catalog) {
      if (diagram.renderer === 'likec4') continue;
      const input = join(stage, diagram.id + '.mmd');
      const dest = join(output, diagram.image);
      await writeFile(input, diagram.source + '\n');
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
  return { output, count: catalog.length, sourceSha: sha };
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
