#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readApprovedOpenapi } from '../../packages/http-contract/scripts/approved-openapi.mjs';
import { containsCredentialPattern } from '../audit/publication-policy.mjs';
import { apiReferencePage, decoratePage } from '../pages-ui/navigation.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const self = fileURLToPath(import.meta.url);
const contractRequire = createRequire(join(root, 'packages/http-contract/package.json'));
const YAML = contractRequire('yaml');
const contractRelative = 'packages/http-contract/openapi/codexia.openapi.yaml';
const routesRelative = 'packages/http-contract/test/fixtures/admitted-routes.json';
const contractPackageRelative = 'packages/http-contract/package.json';
const lockRelative = 'pnpm-lock.yaml';
const scalarVersion = '1.83.0';
const scalarPackagePath = join(root, 'scripts/pages-api/node_modules/@scalar/api-reference/package.json');
const lockPath = join(root, 'scripts/pages-api/package-lock.json');
const lock = readFileSync(lockPath);
const lockData = JSON.parse(lock.toString('utf8'));
const scalarLock = lockData.packages?.['node_modules/@scalar/api-reference'];
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const json = (value) => JSON.stringify(value, null, 2) + '\n';
const esc = (value) => String(value).replace(/[&<>"']/gu, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[c]);

export function renderSecuritySchemes(schemes) {
  assert.ok(schemes && typeof schemes === 'object' && Object.keys(schemes).length > 0, 'Public authentication scheme documentation is missing');
  const rows = Object.entries(schemes).map(([name, scheme]) => {
    assert.ok(scheme && typeof scheme.type === 'string', `Invalid public authentication scheme: ${name}`);
    let description = `${esc(scheme.type)} authentication`;
    if (scheme.type === 'http' && typeof scheme.scheme === 'string') description = `HTTP ${esc(scheme.scheme)}`;
    if (scheme.type === 'apiKey' && typeof scheme.in === 'string' && typeof scheme.name === 'string') {
      description = `API key in ${esc(scheme.in)}; name: <code class="cx-pages-code">${esc(scheme.name)}</code>`;
    }
    return `<li><strong>${esc(name)}</strong>: ${description}</li>`;
  }).join('\n');
  return `<section aria-labelledby="security-schemes"><h2 id="security-schemes">Authentication scheme definitions</h2><p>Read-only contract details. This page does not accept credential values.</p><ul>${rows}</ul></section>`;
}

function removeAuthExamples(value) {
  if (!value || typeof value !== 'object') return;
  if (!Array.isArray(value)) {
    delete value.example;
    delete value.examples;
  }
  for (const child of Object.values(value)) removeAuthExamples(child);
}

function committedFile(sourceSha, path) {
  return execFileSync('git', ['show', `${sourceSha}:${path}`]);
}

function operationStates(document, admitted) {
  const states = new Map();
  for (const [state, routes] of [['current', admitted.current], ['target', admitted.target]]) {
    assert.ok(Array.isArray(routes), `Admitted ${state} route list is missing`);
    for (const entry of routes) {
      const split = entry.indexOf(' ');
      assert.ok(split > 0, `Invalid admitted route identity: ${entry}`);
      const method = entry.slice(0, split).toLowerCase();
      const path = entry.slice(split + 1);
      assert.ok(['get','put','post','delete','options','head','patch','trace'].includes(method), `Unsupported admitted HTTP method: ${method}`);
      assert.ok(!states.has(`${method} ${path}`), `Duplicate admitted route identity: ${entry}`);
      states.set(`${method} ${path}`, state);
    }
  }
  const actual = [];
  for (const [path, pathItem] of Object.entries(document.paths)) {
    for (const method of ['get','put','post','delete','options','head','patch','trace']) {
      if (pathItem?.[method]) actual.push(`${method} ${path}`);
    }
  }
  actual.sort();
  assert.deepEqual(actual, [...states.keys()].sort(), 'OpenAPI methods/paths differ from the source-bound admitted route inventory');
  return states;
}

function validateLocalRefs(value, at = '$') {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (key === '$ref') assert.ok(typeof child === 'string' && child.startsWith('#/'), `Non-local OpenAPI reference at ${at}`);
    validateLocalRefs(child, `${at}.${key}`);
  }
}

function removeServerDeclarations(document) {
  delete document.servers;
  for (const pathItem of Object.values(document.paths)) {
    delete pathItem.servers;
    for (const method of ['get','put','post','delete','options','head','patch','trace']) {
      if (pathItem[method]) delete pathItem[method].servers;
    }
  }
}

function visibleText(value) {
  return String(value).replace(/[&<>]/gu, character => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;' })[character]);
}

export function prepareOpenApi(sourceText, admitted) {
  const document = YAML.parse(sourceText, { uniqueKeys: true });
  assert.equal(document.openapi, '3.1.0', 'API reference requires the generated OpenAPI 3.1 artifact');
  assert.ok(document.paths && typeof document.paths === 'object' && Object.keys(document.paths).length > 0, 'Generated OpenAPI has no paths');
  const admittedStates = operationStates(document, admitted);
  removeServerDeclarations(document);
  for (const [path, pathItem] of Object.entries(document.paths)) {
    const allowedPathFields = new Set(['$ref','summary','description','parameters','get','put','post','delete','options','head','patch','trace']);
    for (const key of Object.keys(pathItem)) assert.ok(allowedPathFields.has(key) || key.startsWith('x-'), `Unexpected OpenAPI path field ${key} at ${path}`);
    assert.ok(path.startsWith('/api/') || /^\/health\/(?:live|ready|startup)$/u.test(path) || path === '/mcp',
      `Unexpected route in OpenAPI contract: ${path}`);
    for (const method of ['get','put','post','delete','options','head','patch','trace']) {
      const operation = pathItem?.[method];
      if (!operation) continue;
      assert.ok(operation.responses && Object.keys(operation.responses).length > 0, `OpenAPI operation has no response/error contract: ${method.toUpperCase()} ${path}`);
      const identity = `${method} ${path}`;
      const routeState = admittedStates.get(identity);
      assert.ok(routeState, `OpenAPI operation has no admitted source state: ${identity}`);
      const pageStatus = routeState === 'current'
        ? 'Current admitted route; Fastify registration uses the generated route and schema inventory. This does not establish full contract conformance.'
        : 'Target operation; no current runtime implementation is claimed.';
      const verificationStatus = 'Pages does not assert behavioral verification for this operation.';
      const details = [
        operation['x-codexia-principal'] && `**Declared principal:** <code>${visibleText(operation['x-codexia-principal'])}</code>`,
        operation['x-codexia-contract-status'] && `**Contract status:** <code>${visibleText(operation['x-codexia-contract-status'])}</code>`,
        operation['x-codexia-security-deviation'] && `**Security deviation:** ${visibleText(operation['x-codexia-security-deviation'])}. This records a contract deviation; it does not prove the current runtime matches the declared principal.`,
        operation['x-codexia-validation-status'] && `**Runtime validation evidence:** ${visibleText(operation['x-codexia-validation-status'])}. This evidence is incomplete and is not an implementation claim.`,
        operation['x-codexia-runtime-response-deviation'] && `**Runtime response deviation:** ${visibleText(operation['x-codexia-runtime-response-deviation'])}`,
      ].filter(Boolean);
      operation['x-codexia-pages-status'] = { routeState, verification: 'not-asserted-by-pages' };
      operation.description = [operation.description, `**Route state:** ${pageStatus} **Verification:** ${verificationStatus}`, ...details].filter(Boolean).join('\n\n');
      if (path.startsWith('/api/auth/')) removeAuthExamples(operation);
    }
  }
  const annotateModelValidation = value => {
    if (!value || typeof value !== 'object') return;
    if (value['x-codexia-validation-status']) {
      assert.equal(typeof value['x-codexia-validation-status'], 'string', 'Model validation status must be text');
      value.description = [value.description, `**Runtime validation evidence:** ${visibleText(value['x-codexia-validation-status'])}. This evidence is incomplete and the published schema is not a complete runtime-validation claim.`].filter(Boolean).join('\n\n');
    }
    for (const child of Object.values(value)) annotateModelValidation(child);
  };
  annotateModelValidation(document.components?.schemas);
  validateLocalRefs(document);
  assert.ok(!document.servers?.length, 'OpenAPI output contains an API server');
  for (const pathItem of Object.values(document.paths)) {
    assert.ok(!pathItem.servers?.length, 'OpenAPI output contains a path-level server');
    for (const method of ['get','put','post','delete','options','head','patch','trace']) assert.ok(!pathItem[method]?.servers?.length, 'OpenAPI output contains an operation-level server');
  }
  assert.ok(document.components?.securitySchemes && Object.keys(document.components.securitySchemes).length > 0,
    'Public authentication scheme documentation is missing');
  const sanitizedContract = Buffer.from(YAML.stringify(document, { lineWidth: 0 }));
  assert.ok(!containsCredentialPattern(sanitizedContract.toString('utf8')), 'Credential-like value in public OpenAPI contract');
  return { document, admittedStates, sanitizedContract };
}

function scalarFontUrls(text) {
  const urls = text.match(/(?:https?:)?\/\/[^\s"'()`<>\\]+/gu) ?? [];
  return urls.filter(url => {
    try {
      return new URL(url, 'https://example.invalid').hostname === 'fonts.scalar.com';
    } catch {
      return false;
    }
  });
}

export function removeRemoteScalarFontFaces(bundle) {
  assert.equal(typeof bundle, 'string', 'Expected Scalar JavaScript bundle text');
  const references = scalarFontUrls(bundle);
  assert.ok(references.length > 0, 'Scalar font asset structure changed; review external font handling');
  const output = bundle.replace(/@font-face\s*\{[^{}]*url\(https:\/\/fonts\.scalar\.com\/[^)]+\)[^{}]*\}/giu, '');
  assert.equal(scalarFontUrls(output).length, 0, 'Scalar bundle still references an external font host');
  return { output, removedFaces: references.length };
}

function readOutputFile(path) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    assert.ok(fstatSync(fd).isFile(), 'API reference output must be a regular file');
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}

function outputFiles(directory) {
  return readdirSync(directory).sort().map(name => {
    const bytes = readOutputFile(join(directory, name));
    return { name, bytes: bytes.length, sha256: sha256(bytes) };
  });
}

export async function pack(sitePath, sourceSha) {
  const { build } = await import('esbuild');
  const packageInfo = JSON.parse(readFileSync(scalarPackagePath, 'utf8'));
  assert.match(sourceSha, /^[a-f0-9]{40}$/u, 'Expected exact 40-character source SHA');
  assert.equal(packageInfo.version, scalarVersion, 'Unexpected Scalar version');
  assert.equal(packageInfo.name, '@scalar/api-reference', 'Unexpected Scalar package identity');
  const source = readApprovedOpenapi(root, sourceSha);
  assert.deepEqual(lock, committedFile(sourceSha, 'scripts/pages-api/package-lock.json'), 'Scalar npm lock bytes do not match the exact source SHA');
  const admittedBytes = committedFile(sourceSha, routesRelative);
  const typespecPackageBytes = committedFile(sourceSha, contractPackageRelative);
  const pnpmLockBytes = committedFile(sourceSha, lockRelative);
  const admitted = JSON.parse(admittedBytes.toString('utf8'));
  const { admittedStates, sanitizedContract, document } = prepareOpenApi(source.toString('utf8'), admitted);
  const site = resolve(sitePath), directory = join(site, 'api');
  rmSync(directory, { recursive: true, force: true });
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'codexia.openapi.yaml'), sanitizedContract);
  await build({
    absWorkingDir: root,
    entryPoints: [join(root, 'scripts/pages-api/reference-entry.js')],
    outfile: join(directory, 'scalar-reference.js'),
    bundle: true,
    minify: true,
    format: 'iife',
    platform: 'browser',
    target: ['chrome120', 'firefox120', 'safari17'],
    legalComments: 'eof',
  });
  const bundledJsPath = join(directory, 'scalar-reference.js');
  const builtJavaScript = readOutputFile(bundledJsPath).toString('utf8');
  assert.match(builtJavaScript, /@license\s+MIT/u, 'Scalar bundle must retain upstream legal comments');
  const fontSanitization = removeRemoteScalarFontFaces(builtJavaScript);
  writeFileSync(bundledJsPath, fontSanitization.output);
  const stylesheet = join(directory, 'scalar-reference.css');
  assert.equal(scalarFontUrls(readOutputFile(stylesheet).toString('utf8')).length, 0, 'Scalar stylesheet references an external font host');
  const index = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self' 'unsafe-inline' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; worker-src 'self' blob:; object-src 'none'; base-uri 'self'; form-action 'none'">
  <title>Codexia API Reference</title>
  <link rel="icon" href="data:,">
  <link rel="stylesheet" href="./scalar-reference.css">
</head>
<body>
  <main id="main" tabindex="-1" class="cx-pages-container cx-pages-main">
    <h1>Codexia API Reference</h1>
    <p class="cx-pages-lede">A read-only view of the OpenAPI 3.1 contract generated from TypeSpec. Each operation identifies its current or target state; this reference does not claim runtime behavior or verification.</p>
    <section class="cx-pages-empty" aria-labelledby="implementation-status">
      <h2 id="implementation-status">Implementation and verification status</h2>
      <p><strong>Contract:</strong> OpenAPI 3.1 generated from TypeSpec and pinned to this Pages build source SHA.</p>
      <p><strong>Runtime:</strong> current admitted operations register in Fastify from the generated route and schema inventory. Target operations are not registered as implemented routes.</p>
      <p><strong>Verification:</strong> this static reference is not a runtime inventory, CI result, or production API acceptance report.</p>
      <p>Authentication schemes and error response shapes are documentation only. Authentication examples are removed. No API server, credential entry, or Try It request is available here.</p>
      <p><a href="./codexia.openapi.yaml">Open the static OpenAPI contract</a> · <a href="./THIRD_PARTY_NOTICES.txt">Third-party notices</a></p>
    </section>
    ${renderSecuritySchemes(document.components.securitySchemes)}
    <div id="scalar-api-reference" aria-label="OpenAPI endpoint reference"></div>
  </main>
  <script src="./scalar-reference.js" defer></script>
</body>
</html>
`;
  const decoratedIndex = decoratePage(index, {
    pagePath: 'api/index.html',
    page: { ...apiReferencePage, sha: sourceSha },
  });
  writeFileSync(join(directory, 'index.html'), decoratedIndex);
  const scalarNotice = `@scalar/api-reference ${packageInfo.version}\nCopyright Scalar\nLicense: MIT\n\nMIT License\n\nPermission is hereby granted, free of charge, to any person obtaining a copy\nof this software and associated documentation files (the \"Software\"), to deal\nin the Software without restriction, including without limitation the rights\nto use, copy, modify, merge, publish, distribute, sublicense, and/or sell\ncopies of the Software, and to permit persons to whom the Software is\nfurnished to do so, subject to the following conditions:\n\nThe above copyright notice and this permission notice shall be included in all\ncopies or substantial portions of the Software.\n\nTHE SOFTWARE IS PROVIDED \"AS IS\", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR\nIMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,\nFITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE\nAUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER\nLIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,\nOUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE\nSOFTWARE.\n`;
  writeFileSync(join(directory, 'THIRD_PARTY_NOTICES.txt'), scalarNotice);
  const scalarIntegrity = scalarLock?.integrity;
  assert.match(scalarIntegrity ?? '', /^sha512-[A-Za-z0-9+/]+=*$/u, 'Scalar npm integrity is missing from its package metadata');
  const typespecPackage = JSON.parse(typespecPackageBytes.toString('utf8'));
  const typespecDependencies = ['@typespec/compiler','@typespec/http','@typespec/openapi','@typespec/openapi3'];
  const versions = Object.fromEntries(typespecDependencies.map(name => {
    const declared = typespecPackage.devDependencies?.[name];
    assert.match(declared ?? '', /^\d+\.\d+\.\d+$/u, `TypeSpec dependency is not exactly pinned: ${name}`);
    assert.ok(pnpmLockBytes.toString('utf8').includes(`'${name}@${declared}'`), `TypeSpec lock does not contain ${name}@${declared}`);
    return [name, declared];
  }));
  const states = Object.fromEntries(admittedStates);
  const manifest = {
    schemaVersion: 1,
    sourceSha,
    generatedAt: new Date().toISOString(),
    publication: 'public-static-contract',
    targetState: { contract: 'generated-target', runtime: 'partial-generated-route-registration', verification: 'not-asserted-by-this-page' },
    input: { path: contractRelative, sha256: sha256(source), outputSha256: sha256(sanitizedContract) },
    routeInventory: { path: routesRelative, sha256: sha256(admittedBytes), currentCount: admitted.current.length, targetCount: admitted.target.length, operationStates: states },
    typeSpec: { packagePath: contractPackageRelative, packageSha256: sha256(typespecPackageBytes), lockPath: lockRelative, lockSha256: sha256(pnpmLockBytes), versions },
    generator: { name: '@scalar/api-reference', version: packageInfo.version, npmIntegrity: scalarIntegrity, lockPath: 'scripts/pages-api/package-lock.json', lockSha256: sha256(lock) },
    buildTool: { name: 'esbuild', version: JSON.parse(readFileSync(join(root, 'scripts/pages-api/node_modules/esbuild/package.json'), 'utf8')).version },
    vendorAssetPolicy: { externalFontFacesRemoved: fontSanitization.removedFaces, runtimeExternalFetch: 'CSP connect-src self; no external assets' },
    outputs: outputFiles(directory),
  };
  writeFileSync(join(directory, 'manifest.json'), json(manifest));
  return manifest;
}

if (process.argv[1] && resolve(process.argv[1]) === self) {
  const args = process.argv.slice(2);
  if (args.length !== 2) throw new Error('Usage: node scripts/pages-api/pack.mjs SITE SOURCE_SHA');
  pack(args[0], args[1]).then(result => console.log(json({ sourceSha: result.sourceSha, inputSha256: result.input.sha256, files: result.outputs.length })));
}
