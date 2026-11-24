import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, constants as fsConstants, fstatSync, lstatSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const REPOSITORY = 'yohn-jp/codexia';
const SHA = /^[a-f0-9]{40}$/u;
const DIGEST = /^[a-f0-9]{64}$/u;
const EXPECTED_COLLECTIONS = Object.freeze(['screens', 'controls', 'transitions', 'scenarios', 'states', 'journeys']);
const OBSERVED_COLLECTIONS = Object.freeze(['screens', 'controls', 'transitions', 'scenarios', 'states']);
const GAP_STATUSES = new Set(['unextracted', 'unimplemented', 'unobserved']);
const COVERAGE_STATUSES = new Set([
  'observed', 'unobserved', 'unextracted', 'unimplemented', 'implementation-only',
  'excluded', 'proposal', 'external', 'conceptual',
]);
const digest = value => createHash('sha256').update(value).digest('hex');
const json = value => JSON.stringify(value, null, 2) + '\n';
const safePath = value => typeof value === 'string' && /^[\w./@+-]+$/u.test(value) &&
  value.split('/').every(part => part && part !== '.' && part !== '..');

function readRegular(path, message) {
  let fd;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
    assert.ok(fstatSync(fd).isFile(), message);
    return readFileSync(fd);
  } catch (error) {
    if (['ENOENT', 'ELOOP', 'EMLINK'].includes(error.code)) throw new Error(message, { cause: error });
    throw error;
  } finally { if (fd !== undefined) closeSync(fd); }
}

function walk(directory, base = directory) {
  const files = [];
  for (const name of readdirSync(directory).sort()) {
    const absolute = join(directory, name);
    const stat = lstatSync(absolute);
    assert.ok(!stat.isSymbolicLink(), `UX artifact must not contain symlinks: ${relative(base, absolute)}`);
    if (stat.isDirectory()) files.push(...walk(absolute, base));
    else {
      assert.ok(stat.isFile(), `UX artifact contains a non-regular file: ${relative(base, absolute)}`);
      files.push(relative(base, absolute).split(sep).join('/'));
    }
  }
  return files;
}

function verifySourceInputs(manifest) {
  const inputs = manifest.inputs;
  assert.ok(inputs && typeof inputs === 'object' && !Array.isArray(inputs), 'UX input inventory is missing');
  const declared = new Map();
  for (const group of ['authority', 'source', 'generator', 'lock']) {
    assert.ok(inputs[group] && typeof inputs[group] === 'object' && !Array.isArray(inputs[group]), `UX ${group} input inventory is missing`);
    assert.ok(Object.keys(inputs[group]).length > 0, `UX ${group} input inventory is empty`);
    for (const [path, expected] of Object.entries(inputs[group])) {
      assert.ok(safePath(path), `Unsafe UX source input path: ${path}`);
      assert.ok(DIGEST.test(expected ?? ''), `Invalid UX input digest: ${group}/${path}`);
      let bytes;
      try {
        bytes = execFileSync('git', ['-c', `safe.directory=${process.cwd()}`, 'show', `${manifest.sourceSha}:${path}`], {
          cwd: process.cwd(), maxBuffer: 32 * 1024 * 1024,
        });
      } catch (error) { throw new Error(`UX source input is absent at its declared SHA: ${path}`, { cause: error }); }
      assert.equal(digest(bytes), expected, `UX input digest mismatch at ${manifest.sourceSha}:${path}`);
      declared.set(path, bytes.toString('utf8').split('\n'));
    }
  }
  assert.ok(DIGEST.test(inputs.projection ?? ''), 'UX projection input digest is invalid');
  assert.ok(DIGEST.test(inputs.asset ?? ''), 'UX asset declaration digest is invalid');
  return declared;
}

function itemKey(item, includePlatform = true) {
  assert.ok(item && typeof item === 'object' && !Array.isArray(item), 'Projection item must be an object');
  assert.ok(typeof item.id === 'string' && item.id.trim(), 'Projection item has no stable ID');
  assert.ok(item.platform === undefined || typeof item.platform === 'string', `Invalid platform on ${item.id}`);
  const scope = item.platform ?? (Array.isArray(item.platforms) ? item.platforms.join(',') : '');
  return includePlatform && scope ? `${scope}/${item.id}` : item.id;
}

function uniqueItems(items, label, includePlatform = true) {
  assert.ok(Array.isArray(items), `Projection collection is missing: ${label}`);
  const map = new Map();
  for (const item of items) {
    const key = itemKey(item, includePlatform);
    assert.ok(!map.has(key), `Duplicate ${label} ID: ${key}`);
    map.set(key, item);
  }
  return map;
}

function validateProjection(snapshot, manifest, inputLines) {
  assert.equal(snapshot.schemaVersion, 2, 'Unsupported UX projection schema');
  assert.equal(snapshot.repository, REPOSITORY, 'UX projection belongs to a foreign repository');
  assert.equal(snapshot.sourceSha, manifest.sourceSha, 'UX manifest and projection source SHA differ');
  assert.ok(snapshot.expected && typeof snapshot.expected === 'object', 'UX expected design projection is missing');
  assert.ok(snapshot.observed && typeof snapshot.observed === 'object', 'UX observed implementation projection is missing');
  assert.ok(!Object.hasOwn(snapshot.observed, 'journeys'), 'Implementation projection cannot claim design journeys');
  const validateLocation = (location, label) => {
    if (!location) return;
    assert.ok(typeof location.path === 'string' && Number.isSafeInteger(location.line) && location.line > 0,
      `Invalid projection source location: ${label}`);
    const lines = inputLines.get(location.path);
    assert.ok(lines && location.line <= lines.length, `Projection location is not source-bound: ${location.path}:${location.line}`);
    if (location.symbol) assert.ok(lines[location.line - 1].includes(location.symbol), `Projection symbol is not at its declared line: ${location.path}:${location.line}`);
  };
  for (const domain of ['expected', 'observed']) {
    for (const [name, records] of Object.entries(snapshot[domain])) {
      if (!Array.isArray(records)) continue;
      for (const record of records) {
        const primaryInputs = domain === 'expected' ? manifest.inputs.authority : manifest.inputs.source;
        if (record.source) assert.ok(primaryInputs[record.source.path], `${domain} ${name} source is outside its declared input authority: ${record.source.path}`);
        validateLocation(record.source, `${domain}.${name}.${record.id}`);
        if (domain === 'expected' && record.platformSource) {
          assert.ok(manifest.inputs.authority[record.platformSource.path], `Expected platform scope is outside declared authority: ${record.platformSource.path}`);
          validateLocation(record.platformSource, `${domain}.${name}.${record.id}.platformSource`);
        }
        validateLocation(record.evidence?.expectation, `${domain}.${name}.${record.id}.evidence.expectation`);
      }
    }
  }
  const expected = new Map();
  for (const name of EXPECTED_COLLECTIONS) {
    const expectItems = uniqueItems(snapshot.expected[name], `expected.${name}`, false);
    for (const [id, item] of expectItems) {
      assert.ok(!expected.has(id), `Duplicate expected projection ID across collections: ${id}`);
      expected.set(id, { collection: name, item });
    }
  }
  // State IDs intentionally refer to screens and transitions. Require uniqueness
  // within each collection while allowing those cross-collection relationships.
  for (const name of OBSERVED_COLLECTIONS) uniqueItems(snapshot.observed[name], `observed.${name}`);
  const expectedAuthority = new Map();
  const observedAuthority = new Map();
  for (const name of ['screens', 'controls']) {
    for (const [id, item] of uniqueItems(snapshot.expected[name], `expected.${name}`, false)) {
      assert.ok(!expectedAuthority.has(id), `Duplicate expected screen/control ID: ${id}`);
      expectedAuthority.set(id, item);
    }
    for (const [key, item] of uniqueItems(snapshot.observed[name], `observed.${name}`)) {
      assert.ok(!observedAuthority.has(key), `Duplicate observed screen/control ID: ${key}`);
      observedAuthority.set(key, item);
    }
  }
  uniqueItems(snapshot.observed.gaps, 'observed.gaps');
  assert.ok(Array.isArray(snapshot.coverage), 'UX coverage inventory is missing');
  const coverage = new Map();
  for (const row of snapshot.coverage) {
    const key = itemKey(row);
    assert.ok(!coverage.has(key), `Duplicate UX coverage key: ${key}`);
    assert.ok(COVERAGE_STATUSES.has(row.status), `Unknown UX coverage status: ${row.status}`);
    if (row.source) {
      assert.ok(typeof row.source.path === 'string' && Number.isSafeInteger(row.source.line), `Invalid coverage source: ${key}`);
      assert.ok(manifest.inputs.authority[row.source.path] || manifest.inputs.source[row.source.path], `Coverage source is not a declared input: ${row.source.path}`);
      validateLocation(row.source, `coverage.${key}`);
    }
    if (row.implementation) {
      assert.ok(safePath(row.implementation.path) && Number.isSafeInteger(row.implementation.line) && row.implementation.line > 0,
        `Invalid implementation source location: ${key}`);
      assert.ok(manifest.inputs.source[row.implementation.path], `Implementation source is not a declared input: ${row.implementation.path}`);
      validateLocation(row.implementation, `coverage.${key}.implementation`);
    }
    if (GAP_STATUSES.has(row.status)) assert.ok(typeof row.reason === 'string' && row.reason.trim(), `Gap reason is missing: ${key}`);
    if (row.status === 'observed') {
      const trace = snapshot.observed.transitions.some(item => item.platform === row.platform && item.method === 'trace' &&
        item.evidence?.sourceSha === manifest.sourceSha && item.evidence?.outcome === 'passed' &&
        (item.screen === row.id || item.control === row.id));
      assert.ok(row.implementation && trace, `Observed coverage must include an exact-source passing trace: ${key}`);
    }
    if (row.status === 'implementation-only') assert.ok(row.implementation, `Implementation-only row has no source: ${key}`);
    if (['excluded', 'proposal', 'external', 'conceptual'].includes(row.status)) {
      assert.ok(typeof row.reason === 'string' && row.reason.trim(), `Non-target reason is missing: ${key}`);
    }
    const designKey = row.platform ? `${row.platform}/${row.id}` : row.id;
    if (row.status === 'implementation-only') {
      assert.ok(!expectedAuthority.has(row.id), `Implementation-only item exists in expected projection: ${key}`);
      assert.ok(observedAuthority.has(designKey),
        `Implementation-only item is absent from observed projection: ${key}`);
    } else {
      const source = expectedAuthority.get(row.id);
      assert.ok(source, `Unknown UX coverage ID: ${key}`);
      if (source.adoption !== 'adopted') assert.equal(row.status, source.adoption, `Design adoption status drift: ${key}`);
      else if (!source.platforms.includes(row.platform)) assert.equal(row.status, 'excluded', `Out-of-scope platform status drift: ${key}`);
      else assert.ok(['observed', 'unobserved', 'unextracted', 'unimplemented'].includes(row.status), `Invalid adopted coverage status: ${key}`);
    }
    coverage.set(key, row);
  }
  for (const item of [...snapshot.expected.screens, ...snapshot.expected.controls]) {
    const ids = item.adoption !== 'adopted' ? [item.id] : [...item.platforms, 'legacy-mobile-web'].map(platform => `${platform}/${item.id}`);
    for (const id of ids) assert.ok(coverage.has(id), `Expected authority item is missing coverage: ${id}`);
  }
  assert.deepEqual(manifest.coverage, snapshot.coverage, 'UX manifest and projection coverage differ');
  assert.ok(['partial', 'complete'].includes(manifest.status), 'Invalid UX artifact status');
  const hasGaps = snapshot.coverage.some(({ status }) => GAP_STATUSES.has(status));
  const mapped = snapshot.coverage.some(({ status }) => ['unextracted', 'unimplemented'].includes(status)) ? 'partial' : 'mapped';
  const observed = snapshot.coverage.some(({ status }) => status === 'observed')
    ? hasGaps ? 'partial' : 'observed' : 'not-evaluated';
  assert.equal(manifest.evidence.implementationMapped, mapped, 'Implementation mapping evidence differs from its coverage');
  assert.equal(manifest.evidence.implementationObserved, observed, 'Implementation observation evidence differs from its coverage');
  assert.equal(manifest.status, hasGaps || observed !== 'observed' ? 'partial' : 'complete',
    'UX artifact status overstates or understates observed coverage');
}

function verifyBrowserProjection(root, snapshot, manifest) {
  const browser = readRegular(join(root, 'build.mjs'), 'UX browser projection is missing').toString('utf8');
  const compare = Object.hasOwn(manifest.outputs, 'compare/browser.mjs');
  const prefix = compare ? 'export { renderCompare as compare } from "./compare/browser.mjs";'
    : 'export const compare = null;';
  const compareBase = Object.hasOwn(manifest.outputs, 'compare/base.mjs')
    ? '\nexport { default as comparisonBase } from "./compare/base.mjs";'
    : '\nexport const comparisonBase = null;';
  const suffix = '\nexport const snapshot = ' + json(snapshot).trimEnd() + ';\n';
  const matchesLegacyV2 = !Object.hasOwn(manifest.outputs, 'compare/base.mjs') && browser === prefix + suffix;
  assert.ok(browser === prefix + compareBase + suffix || matchesLegacyV2, 'Rendered UX projection differs from the verified snapshot');
}

function verifyComparisonBase(root, manifest) {
  if (!Object.hasOwn(manifest.outputs, 'compare/base.mjs')) return;
  assert.ok(Object.hasOwn(manifest.outputs, 'compare/browser.mjs'), 'UX base exists without comparison renderer');
  const data = readRegular(join(root, 'compare/base.mjs'), 'UX comparison base is missing').toString('utf8');
  const serialized = /^export default (.+);\n$/u.exec(data)?.[1];
  assert.ok(serialized && serialized.length <= 4 * 1024 * 1024, 'Invalid UX comparison base module');
  const { manifest: base, raw } = JSON.parse(serialized);
  assert.equal(data, 'export default ' + JSON.stringify({ manifest: base, raw }) + ';\n');
  assert.equal(base.schemaVersion, 2);
  assert.equal(base.repository, REPOSITORY);
  assert.equal(base.route, '/ux/');
  assert.ok(SHA.test(base.sourceSha ?? '') && base.sourceSha !== manifest.sourceSha, 'Invalid UX comparator source SHA');
  assert.equal(digest(raw), base.inputs?.projection, 'UX comparison base projection digest mismatch');
  assert.equal(base.inputs.projection, base.outputs?.['snapshot.json'], 'UX comparison base projection is undeclared');
  assert.equal(digest(JSON.stringify(base.outputs)), base.inputs.asset, 'UX comparison base assets are inconsistent');
  validateEvidence(base);
  validateProjection(JSON.parse(raw), base, verifySourceInputs(base));
}

function verifyRegeneration(snapshotBytes, manifest, snapshot) {
  const root = process.cwd();
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  assert.equal(head, manifest.sourceSha, 'UX projection verification requires a checkout at the artifact SHA');
  const scratch = mkdtempSync(join(tmpdir(), 'codexia-ux-verify-'));
  try {
    const observed = snapshot.observed.transitions.some(({ method }) => method === 'trace');
    const command = ['scripts/ux-simulator/generate.mjs', '--output', scratch, '--source-sha', manifest.sourceSha];
    if (observed) command.push('--observe');
    execFileSync(process.execPath, command, { cwd: root, timeout: 90_000, stdio: ['ignore', 'pipe', 'pipe'] });
    assert.equal(digest(readFileSync(join(scratch, 'snapshot.json'))), digest(snapshotBytes),
      'Projection does not reproduce from its declared canonical sources and execution');
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function validateEvidence(manifest) {
  const evidence = manifest.evidence;
  assert.ok(evidence && typeof evidence === 'object', 'UX evidence inventory is missing');
  assert.equal(evidence.designMapped, 'mapped', 'Design mapping evidence is incomplete');
  assert.equal(evidence.designSimulated, 'not-evaluated', 'Design simulation must remain separate from generation');
  assert.ok(['partial', 'mapped'].includes(evidence.implementationMapped), 'Invalid implementation mapping evidence');
  assert.ok(['partial', 'not-evaluated', 'observed'].includes(evidence.implementationObserved), 'Invalid implementation observation evidence');
  assert.equal(evidence.productVerified, 'not-evaluated', 'UX Simulator cannot assert product acceptance');
}

function validatePageHtml(html, sourceSha) {
  assert.ok(/<html\b/iu.test(html) && /<main\b/iu.test(html), 'UX page must be a complete HTML document');
  assert.ok(/Content-Security-Policy[^>]*default-src\s+'none'/iu.test(html) &&
    /connect-src\s+'none'/iu.test(html), 'UX CSP must deny unlisted resources and external connections');
  assert.ok(/script-src\s+'self'/iu.test(html) && /style-src\s+'self'/iu.test(html), 'UX CSP must allow only same-origin scripts and styles');
  assert.ok(/form-action\s+'none'/iu.test(html) && /object-src\s+'none'/iu.test(html), 'UX CSP must deny form and object actions');
  assert.ok(!/\bon[a-z]+\s*=/iu.test(html), 'Inline event handlers are prohibited in UX HTML');
  assert.ok(!/<(?:form|iframe|object|embed)\b/iu.test(html), 'Forms and embedded active content are prohibited in UX HTML');
  for (const match of html.matchAll(/\b(?:href|src)\s*=\s*(["'])(.*?)\1/giu)) {
    const value = match[2];
    if (/^(?:https?:|\/\/)/iu.test(value)) {
      const url = new URL(value, 'https://yohn-jp.github.io/codexia/ux/');
      assert.ok(/^https:\/\/github\.com\/yohn-jp\/codexia\//u.test(value), `Unexpected external UX URL: ${value}`);
      assert.ok(url.pathname.includes('/' + sourceSha + '/'), 'UX source links must bind the exact artifact SHA');
      assert.ok(url.pathname.startsWith('/yohn-jp/codexia/blob/') || url.pathname.startsWith('/yohn-jp/codexia/tree/'),
        `Invalid UX source link: ${value}`);
    } else assert.ok(!/^[a-z][a-z0-9+.-]*:/iu.test(value), `Unexpected UX link scheme: ${value}`);
  }
}

export function inspectUxArtifact(uxDir, { expectedSourceSha } = {}) {
  const root = resolve(uxDir);
  assert.ok(lstatSync(root).isDirectory(), 'UX artifact root is not a regular directory');
  const manifest = JSON.parse(readRegular(join(root, 'manifest.json'), 'UX manifest is missing').toString('utf8'));
  assert.equal(manifest.schemaVersion, 2, 'Unsupported UX manifest schema');
  assert.equal(manifest.repository, REPOSITORY, 'UX artifact belongs to a foreign repository');
  assert.ok(SHA.test(manifest.sourceSha ?? ''), 'Invalid UX source SHA');
  if (expectedSourceSha) assert.equal(manifest.sourceSha, expectedSourceSha, 'UX source SHA differs from Pages build');
  assert.equal(manifest.route, '/ux/', 'UX artifact route is invalid');
  validateEvidence(manifest);
  const outputs = manifest.outputs;
  assert.ok(outputs && typeof outputs === 'object' && !Array.isArray(outputs), 'UX output declaration is missing');
  assert.ok(Object.hasOwn(outputs, 'index.html') && Object.hasOwn(outputs, 'snapshot.json'), 'UX output page or projection is missing');
  assert.ok(!Object.hasOwn(outputs, 'manifest.json'), 'Self-referential manifest output is prohibited');
  const inputLines = verifySourceInputs(manifest);
  for (const [name, expected] of Object.entries(outputs)) {
    assert.ok(safePath(name) && /\.(?:html|json|mjs|js|css|svg|png|webp|woff2)$/u.test(name), `Invalid UX output path: ${name}`);
    assert.ok(DIGEST.test(expected), `Invalid UX output digest: ${name}`);
  }
  assert.equal(manifest.inputs.projection, outputs['snapshot.json'], 'UX projection input digest differs from snapshot output');
  assert.equal(manifest.inputs.asset, digest(JSON.stringify(outputs)), 'UX asset declaration digest mismatch');
  const declaredFiles = Object.keys(outputs).sort();
  const diskFiles = walk(root).filter(name => name !== 'manifest.json').sort();
  assert.deepEqual(diskFiles, declaredFiles, 'UX files differ from the declared output inventory');
  for (const [name, expected] of Object.entries(outputs)) {
    assert.equal(digest(readRegular(join(root, name), `UX output is missing: ${name}`)), expected, `UX output digest mismatch: ${name}`);
  }
  const snapshotBytes = readRegular(join(root, 'snapshot.json'), 'UX projection is missing');
  assert.equal(digest(snapshotBytes), manifest.inputs.projection, 'UX projection digest mismatch');
  const snapshot = JSON.parse(snapshotBytes.toString('utf8'));
  assert.equal(snapshot.sourceSha, manifest.sourceSha, 'UX projection source SHA mismatch');
  validateProjection(snapshot, manifest, inputLines);
  verifyBrowserProjection(root, snapshot, manifest);
  verifyComparisonBase(root, manifest);
  verifyRegeneration(snapshotBytes, manifest, snapshot);
  const html = readRegular(join(root, 'index.html'), 'UX page is missing').toString('utf8');
  validatePageHtml(html, manifest.sourceSha);
  return { root, manifest, snapshot, html, outputs: declaredFiles };
}

function inspectBeforeShell(uxDir, expectedSourceSha) {
  const root = resolve(uxDir);
  const manifest = JSON.parse(readRegular(join(root, 'manifest.json'), 'UX manifest is missing').toString('utf8'));
  assert.equal(manifest.sourceSha, expectedSourceSha, 'UX source SHA differs before Pages shell integration');
  verifyEvidenceShapeForSeal(manifest);
  verifySourceInputs(manifest);
  const outputs = manifest.outputs;
  assert.ok(outputs && Object.hasOwn(outputs, 'index.html') && Object.hasOwn(outputs, 'snapshot.json'), 'UX output inventory is incomplete');
  assert.equal(manifest.inputs.projection, outputs['snapshot.json'], 'UX projection digest mismatch before shell integration');
  const files = Object.keys(outputs).sort();
  assert.deepEqual(walk(root).filter(name => name !== 'manifest.json').sort(), files, 'UX output inventory changed before shell integration');
  for (const [name, expected] of Object.entries(outputs)) {
    if (name === 'index.html') continue;
    assert.equal(digest(readRegular(join(root, name), `UX output is missing: ${name}`)), expected, `UX output changed before shell integration: ${name}`);
  }
  assert.equal(digest(readRegular(join(root, 'snapshot.json'), 'UX projection is missing')), outputs['snapshot.json'], 'UX projection changed before shell integration');
  assert.equal(manifest.inputs.asset, digest(JSON.stringify(outputs)), 'UX asset declaration digest mismatch before shell integration');
  return { root, manifest };
}

function verifyEvidenceShapeForSeal(manifest) {
  assert.equal(manifest.schemaVersion, 2, 'Unsupported UX manifest schema');
  assert.equal(manifest.repository, REPOSITORY, 'Foreign UX artifact');
  assert.equal(manifest.route, '/ux/', 'UX artifact route is invalid');
  validateEvidence(manifest);
}

export function sealUxArtifact(uxDir, expectedSourceSha) {
  const { root, manifest } = inspectBeforeShell(uxDir, expectedSourceSha);
  const html = readRegular(join(root, 'index.html'), 'UX page is missing').toString('utf8');
  assert.ok(html.includes('class="cx-pages-header"'), 'Canonical Pages navigation was not applied to UX');
  manifest.outputs['index.html'] = digest(Buffer.from(html));
  manifest.inputs.asset = digest(JSON.stringify(manifest.outputs));
  const fd = openSync(join(root, 'manifest.json'), fsConstants.O_WRONLY | fsConstants.O_TRUNC | fsConstants.O_NOFOLLOW);
  try { writeFileSync(fd, json(manifest)); } finally { closeSync(fd); }
  return inspectUxArtifact(uxDir, { expectedSourceSha });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [command, directory, sourceSha] = process.argv.slice(2);
    if (command === 'seal' && directory && SHA.test(sourceSha ?? '')) {
      const result = sealUxArtifact(directory, sourceSha);
      process.stdout.write(`Sealed UX Pages artifact for ${result.manifest.sourceSha} (${result.manifest.status}).\n`);
    } else if (command === 'verify' && directory) {
      const result = inspectUxArtifact(directory, sourceSha ? { expectedSourceSha: sourceSha } : {});
      process.stdout.write(`Verified UX artifact for ${result.manifest.sourceSha} (${result.manifest.status}).\n`);
    } else throw new Error('Usage: ux-artifact.mjs seal UX_DIR SOURCE_SHA | verify UX_DIR [SOURCE_SHA]');
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
