import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { catalogPath, readAuthority, reconcile } from './authority.mjs';
import { validate } from './model.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const here = fileURLToPath(new URL('./', import.meta.url));
const repository = 'yohn-jp/codexia';
const schemaVersion = 1;
const shaPattern = /^[0-9a-f]{40}$/;
const authorityPaths = [
  'docs/design/UX-SIMULATOR-CONTRACT.md', catalogPath, 'docs/design/SCREEN-STATE-ATLAS.md',
  'docs/design/USER-SCREEN-FLOW.md', 'docs/design/ADMIN-SCREEN-FLOW.md', 'docs/design/UX-CONTRACT.md',
  'docs/design/INTERACTION-CONTRACT.md', 'docs/design/XSTATE-STATE-MACHINE-CONTRACT.md',
  'docs/design/MOBILE-AUTHORING.md', 'app/DESIGN.md', 'docs/architecture/IOS-SWIFTUI-ARCHITECTURE.md',
  'docs/architecture/ROUTE-AUTHORIZATION-CONTRACT.md', 'docs/architecture/API-CONTRACT.md',
  'docs/architecture/BACKUP-CONSOLE-CONTRACT.md', 'docs/requirements/REQUIREMENT-REGISTER.md',
  'docs/requirements/STRICTDOC-TRACEABILITY.md',
];

const read = (path) => readFileSync(join(root, path));
const text = (path) => read(path).toString('utf8');
const hash = (value) => createHash('sha256').update(value).digest('hex');
const json = (value) => JSON.stringify(value, null, 2) + '\n';

async function files(dir, prefix) {
  const entries = await readdir(dir, { withFileTypes: true });
  const paths = [];
  for (const entry of entries) {
    if (entry.isSymbolicLink()) throw new Error('Unexpected symlink: ' + prefix + entry.name);
    if (entry.isDirectory()) paths.push(...await files(join(dir, entry.name), prefix + entry.name + '/'));
    else if (/\.(?:mjs|css)$/.test(entry.name) && !/\.(?:test|browser-test)\.mjs$/.test(entry.name)) paths.push(prefix + entry.name);
  }
  return paths.sort();
}

export async function generate({ output, sourceSha }) {
  if (!shaPattern.test(sourceSha ?? '') || !output) throw new Error('Expected --output and --source-sha (40 hex)');
  const authority = readAuthority(text);
  const featureAssets = await files(join(here, 'features'), 'features/');
  const modulePaths = featureAssets.filter((name) => /^features\/[\w-]+\/feature\.mjs$/.test(name));
  const registrations = [];
  for (const name of modulePaths) {
    const module = await import(pathToFileURL(join(here, name)));
    if (!Array.isArray(module.features) || module.features.length === 0) throw new Error('Missing features export: ' + name);
    registrations.push(...module.features);
  }
  const includeReference = !registrations.some(({ platform }) => platform === 'desktop');
  if (includeReference) registrations.push((await import('./features/reference.mjs')).demo);
  const features = validate(registrations);
  const coverage = reconcile(authority, features);
  const transitions = features.flatMap(({ id: feature, platform, edges }) => edges.map((edge) => ({
    id: edge.id, feature, platform, from: edge.from, event: edge.event, to: edge.to, control: edge.control,
    effect: Boolean(edge.effect), handoff: edge.handoff, failure: edge.failure, guard: edge.guardDescription, source: edge.source,
  })));
  const inputs = [...new Set([...authorityPaths, ...transitions.map(({ source }) => source.split('#')[0])])].sort();
  const scenarios = features.flatMap(({ id: feature, platform, scenarios: definitions }) => definitions.map(({
    checkpoints, id, label, kind, fixture, responses, journeys,
  }) => ({
    id, feature, platform, label, kind, fixture, responses, journeys,
    checkpoints: Object.fromEntries(Object.entries(checkpoints).map(([key, { at, principal }]) => [key, { at, principal }])),
  })));
  const snapshot = { schemaVersion, repository, sourceSha, ...authority, transitions, scenarios, coverage: coverage.records };
  const sourceFiles = await readdir(here, { withFileTypes: true });
  const compareAssets = sourceFiles.some(({ name }) => name === 'compare') ? await files(join(here, 'compare'), 'compare/') : [];
  const compare = compareAssets.includes('compare/browser.mjs');
  const browserFiles = [
    'model.mjs', 'dom.mjs', 'browser.mjs', 'style.css',
    ...featureAssets.filter((name) => includeReference || name !== 'features/reference.mjs'), ...compareAssets,
  ];
  const outputs = new Map(browserFiles.map((path) => [path, readFileSync(join(here, path))]));
  outputs.set('snapshot.json', json(snapshot));
  const imports = modulePaths.map((path, index) => 'import { features as feature' + index + ' } from "./' + path + '";');
  if (includeReference) imports.push('import { demo } from "./features/reference.mjs";');
  if (compare) imports.push('import { renderCompare } from "./compare/browser.mjs";');
  const featureRefs = modulePaths.map((_, index) => '...feature' + index);
  if (includeReference) featureRefs.push('demo');
  // Use a script module for the static inventory so connect-src can remain none.
  outputs.set('build.mjs', imports.join('\n') + '\nexport const features = [' + featureRefs.join(', ') + '];\n'
    + 'export const compare = ' + (compare ? 'renderCompare' : 'null') + ';\n'
    + 'export const snapshot = ' + json(snapshot).trimEnd() + ';\n');
  outputs.set('index.html', html(compareAssets.includes('compare/style.css')));
  const manifest = {
    schemaVersion, repository, sourceSha, route: '/ux/', status: 'partial',
    inputs: {
      authority: Object.fromEntries(inputs.map((path) => [path, hash(read(path))])),
      generator: Object.fromEntries(['generate.mjs', 'authority.mjs'].map((path) => [path, hash(readFileSync(join(here, path)))])),
      lock: { 'pnpm-lock.yaml': hash(read('pnpm-lock.yaml')) },
      model: hash(JSON.stringify(['model.mjs', ...featureAssets.filter((path) => path.endsWith('.mjs'))].map((path) =>
        [path, hash(readFileSync(join(here, path)))]))),
      fixture: hash(JSON.stringify(features.map(({ id, fixtures, scenarios }) => ({ id, fixtures, scenarios })))),
      asset: hash(JSON.stringify([...outputs].map(([path, value]) => [path, hash(value)]))),
    },
    outputs: Object.fromEntries([...outputs].map(([path, value]) => [path, hash(value)])),
    coverage: coverage.records,
    evidence: { designMapped: coverage.status, designSimulated: 'partial', productVerified: 'not-evaluated' },
  };
  outputs.set('manifest.json', json(manifest));
  for (const [path, value] of outputs) {
    const destination = join(output, path);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, value);
  }
  return manifest;
}

function html(compareStyle) {
  return '<!doctype html>\n<html lang="ja"><head><meta charset="utf-8">\n'
    + '<meta name="viewport" content="width=device-width, initial-scale=1">\n'
    + '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'self\'; style-src \'self\'; img-src \'self\'; connect-src \'none\'; form-action \'none\'; base-uri \'none\'; object-src \'none\'">\n'
    + '<title>UX Simulator · Codexia</title><link rel="stylesheet" href="./style.css">\n'
    + (compareStyle ? '<link rel="stylesheet" href="./compare/style.css">\n' : '')
    + '<script type="module" src="./browser.mjs"></script></head>\n<body class="ux-page">\n'
    + '<main id="main-content" tabindex="-1"><header class="ux-header"><h1>UX Simulator</h1><p>合成データで画面と操作を検証</p></header>\n'
    + '<div id="simulator"><noscript>操作には JavaScript が必要です。</noscript></div></main></body></html>\n';
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { output: { type: 'string' }, 'source-sha': { type: 'string' } } });
  await generate({ output: values.output, sourceSha: values['source-sha'] });
}
