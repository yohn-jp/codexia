import { readFileSync, readdirSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { reconcile } from './authority.mjs';
import { captureSaveEvidence } from './execution.mjs';
import { designProjection } from './design.mjs';
import { observedProjection } from './observed.mjs';
import { createSource, digest } from './source.mjs';

const repository = 'yohn-jp/codexia';
const schemaVersion = 2;
const root = fileURLToPath(new URL('../../', import.meta.url));
const here = dirname(fileURLToPath(import.meta.url));
const shaPattern = /^[0-9a-f]{40}$/;
const json = (value) => JSON.stringify(value, null, 2) + '\n';
const coreModules = ['authority.mjs', 'design.mjs', 'execution.mjs', 'generate.mjs', 'observed.mjs', 'source.mjs'];
const browserModules = ['browser.mjs', 'dom.mjs', 'model.mjs', 'style.css'];
const compareModules = ['compare/browser.mjs', 'compare/model.mjs', 'compare/style.css'];

export async function generate({ output, sourceSha, repositoryRoot = root, observe = false, comparisonBase }) {
  if (!shaPattern.test(sourceSha ?? '') || !output) throw new Error('Expected --output and --source-sha (40 hex)');
  const authority = createSource(repositoryRoot);
  const canonical = createSource(repositoryRoot);
  const generator = createSource(root);
  const expected = designProjection(authority);
  const designReferences = new Set([
    ...expected.screens.map(({ platformSource }) => platformSource?.path).filter(Boolean),
    ...expected.controls.flatMap(({ references = [] }) => references.map(({ path }) => path)),
  ]);
  for (const path of designReferences) authority.read(path);
  const observed = await observedProjection(canonical, sourceSha, (domain) => {
    const path = 'scripts/ux-simulator/adapters/' + domain + '.mjs';
    return generator.exists(path) ? import(pathToFileURL(join(root, path))) : null;
  });
  if (observe) await captureSaveEvidence(canonical, repositoryRoot, sourceSha, observed);
  const coverage = reconcile(expected, observed);
  const snapshot = { schemaVersion, repository, sourceSha, expected, observed, coverage };
  const outputs = new Map(browserModules.map((path) => [path, readFileSync(join(here, path))]));
  const compare = compareModules.every((path) => generator.exists('scripts/ux-simulator/' + path));
  if (compare) {
    for (const path of compareModules) outputs.set(path, readFileSync(join(here, path)));
  }
  if (compare && comparisonBase) {
    const manifest = JSON.parse(readFileSync(join(comparisonBase, 'manifest.json'), 'utf8'));
    const raw = readFileSync(join(comparisonBase, 'snapshot.json'), 'utf8');
    if (manifest.repository !== repository || manifest.schemaVersion !== schemaVersion || manifest.sourceSha === sourceSha
      || !shaPattern.test(manifest.sourceSha ?? '') || digest(raw) !== manifest.outputs?.['snapshot.json']) {
      throw new Error('Invalid verified comparison base');
    }
    outputs.set('compare/base.mjs', 'export default ' + JSON.stringify({ manifest, raw }) + ';\n');
  }
  outputs.set('snapshot.json', json(snapshot));
  outputs.set('build.mjs', (compare ? 'export { renderCompare as compare } from "./compare/browser.mjs";'
    : 'export const compare = null;')
    + (outputs.has('compare/base.mjs') ? '\nexport { default as comparisonBase } from "./compare/base.mjs";'
      : '\nexport const comparisonBase = null;')
    + '\nexport const snapshot = ' + json(snapshot).trimEnd() + ';\n');
  outputs.set('index.html', html(compare));
  for (const path of [...coreModules, ...browserModules, ...(compare ? compareModules : [])]) {
    generator.read('scripts/ux-simulator/' + path);
  }
  if (generator.exists('scripts/ux-simulator/adapters/desktop.mjs')
    || generator.exists('scripts/ux-simulator/adapters/owner.mjs')
    || generator.exists('scripts/ux-simulator/adapters/ios.mjs')) {
    for (const entry of readdirSync(join(here, 'adapters'), { withFileTypes: true })) {
      if (!entry.isFile() || !/^[\w-]+(?:\.test)?\.mjs$/.test(entry.name)) throw new Error('Invalid source adapter asset ' + entry.name);
      if (!entry.name.endsWith('.test.mjs')) generator.read('scripts/ux-simulator/adapters/' + entry.name);
    }
  }
  if (generator.list('scripts/ux-simulator').some((path) => path.startsWith('scripts/ux-simulator/features/'))) {
    throw new Error('Feature-specific runtime cannot be shipped by the projection generator');
  }
  const outputHashes = Object.fromEntries([...outputs].map(([path, bytes]) => [path, digest(bytes)]));
  const mapped = coverage.some(({ status }) => ['unextracted', 'unimplemented'].includes(status)) ? 'partial' : 'mapped';
  const observedStatus = coverage.some(({ status }) => status === 'observed')
    ? coverage.some(({ status }) => ['unobserved', 'unextracted', 'unimplemented'].includes(status)) ? 'partial' : 'observed'
    : 'not-evaluated';
  const lock = createSource(repositoryRoot);
  lock.read('pnpm-lock.yaml');
  const manifest = {
    schemaVersion, repository, sourceSha, route: '/ux/', status: observedStatus === 'observed' ? 'complete' : 'partial',
    inputs: {
      authority: authority.hashes(), source: canonical.hashes(), generator: generator.hashes(), lock: lock.hashes(),
      projection: outputHashes['snapshot.json'], asset: digest(JSON.stringify(outputHashes)),
    },
    outputs: outputHashes,
    coverage,
    evidence: { designMapped: 'mapped', designSimulated: 'not-evaluated', implementationMapped: mapped,
      implementationObserved: observedStatus, productVerified: 'not-evaluated' },
  };
  outputs.set('manifest.json', json(manifest));
  for (const [path, value] of outputs) {
    const destination = join(output, path);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, value);
  }
  return manifest;
}

function html(compare) {
  return '<!doctype html>\n<html lang="ja"><head><meta charset="utf-8">\n'
    + '<meta name="viewport" content="width=device-width, initial-scale=1">\n'
    + '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'self\'; style-src \'self\'; img-src \'self\'; connect-src \'none\'; form-action \'none\'; base-uri \'none\'; object-src \'none\'">\n'
    + '<title>UX Simulator · Codexia</title><link rel="stylesheet" href="./style.css">\n'
    + (compare ? '<link rel="stylesheet" href="./compare/style.css">\n' : '')
    + '<script type="module" src="./browser.mjs"></script></head>\n<body class="ux-page">\n'
    + '<main id="main-content" tabindex="-1"><header class="ux-header"><h1>UX Simulator</h1><p>シナリオを選び、次の操作と遷移先を確認しながら状態を辿ります。設計と実装の差分も確認できます。</p></header>\n'
    + '<div id="simulator"><noscript>操作には JavaScript が必要です。</noscript></div></main></body></html>\n';
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { output: { type: 'string' }, 'source-sha': { type: 'string' }, observe: { type: 'boolean' }, 'comparison-base': { type: 'string' } } });
  await generate({ output: values.output, sourceSha: values['source-sha'], observe: values.observe, comparisonBase: values['comparison-base'] });
}
