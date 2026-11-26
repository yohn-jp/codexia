import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { generate } from 'orval';
import { parse } from 'yaml';
import { generateFastify } from '../../packages/http-contract/scripts/generate-fastify.mjs';
import {
  authMethodsClientConfig,
  authMethodsOperationIds,
  httpClientConfig,
  mainOperationIds,
  operationIds,
  provisionalOperationIds,
} from '../orval.config.mjs';

const appRoot = fileURLToPath(new URL('../', import.meta.url));
const input = fileURLToPath(new URL('../../packages/http-contract/openapi/codexia.openapi.yaml', import.meta.url));
const generatedRoot = path.join(appRoot, 'src', 'generated');
const target = path.join(generatedRoot, 'http');
const authTarget = path.join(generatedRoot, 'auth-methods');
const methods = new Set(['get', 'head', 'post', 'put', 'patch', 'delete', 'options', 'trace']);
const operations = new Map();

generateFastify({ check: process.argv.includes('--check') });

for (const [route, pathItem] of Object.entries(parse(readFileSync(input, 'utf8')).paths)) {
  for (const [method, operation] of Object.entries(pathItem)) {
    if (!methods.has(method)) continue;
    assert.ok(operation.operationId, `Missing operationId for ${method} ${route}`);
    assert.ok(!operations.has(operation.operationId), `Duplicate operationId ${operation.operationId}`);
    operations.set(operation.operationId, { method: method.toUpperCase(), route, operation });
  }
}

for (const id of operationIds) {
  const operation = operations.get(id);
  assert.ok(operation, `Desktop client operation ${id} is absent from OpenAPI`);
  const status = operation.operation['x-codexia-contract-status'];
  assert.notEqual(status, 'target', `Desktop client operation ${id} is target-only`);
  if (status !== undefined) {
    assert.equal(status, 'incomplete', `Desktop client operation ${id} has an unknown contract status`);
    assert.ok(provisionalOperationIds.includes(id), `Desktop client operation ${id} is incomplete without an explicit Desktop exception`);
  }
}

for (const id of provisionalOperationIds) {
  assert.ok(operationIds.includes(id), `Provisional Desktop allowlist ${id} is not selected`);
  assert.equal(
    operations.get(id)?.operation['x-codexia-contract-status'],
    'incomplete',
    `Provisional Desktop allowlist ${id} is not marked incomplete`,
  );
}

function generatedFiles(directory) {
  assert.ok(lstatSync(directory).isDirectory(), `Expected a real Orval output directory at ${directory}`);
  const entries = readdirSync(directory, { recursive: true, withFileTypes: true });
  assert.ok(!entries.some(entry => entry.isSymbolicLink()), `Unexpected symlink in Orval output ${directory}`);
  return entries
    .filter(entry => entry.isFile())
    .map(entry => path.relative(directory, path.join(entry.parentPath, entry.name)))
    .sort();
}

function publishClient(stagingDirectory, directory, files) {
  // Publish complete files before removing obsolete schemas. Parallel build and
  // test consumers must never see their existing client disappear mid-import.
  mkdirSync(directory, { recursive: true });
  const previous = generatedFiles(directory);
  for (const file of files) {
    const source = path.join(stagingDirectory, file);
    const destination = path.join(directory, file);
    if (existsSync(destination) && readFileSync(destination).equals(readFileSync(source))) continue;
    mkdirSync(path.dirname(destination), { recursive: true });
    renameSync(source, destination);
  }
  for (const file of previous) {
    if (!files.includes(file)) rmSync(path.join(directory, file), { force: true });
  }
}

mkdirSync(generatedRoot, { recursive: true });
assert.ok(lstatSync(generatedRoot).isDirectory(), `Expected a real generated source directory at ${generatedRoot}`);
const staging = mkdtempSync(path.join(generatedRoot, '.http-'));
const authStaging = mkdtempSync(path.join(generatedRoot, '.auth-'));

async function readOperationManifest(directory) {
  const loaded = await import(pathToFileURL(path.join(directory, 'client.operations.ts')));
  return loaded.operations;
}

try {
  await generate(httpClientConfig(input, staging), appRoot);
  await generate(authMethodsClientConfig(input, authStaging), appRoot);
  const mainOperations = await readOperationManifest(staging);
  const authOperations = await readOperationManifest(authStaging);
  assert.deepEqual(Object.keys(mainOperations).length, mainOperationIds.length, 'Main Orval client emitted an unexpected operation count');
  assert.deepEqual(
    Object.keys(authOperations).length,
    authMethodsOperationIds.length,
    'Auth methods Orval client emitted an unexpected operation count',
  );
  assert.ok(
    !Object.keys(mainOperations).some(id => authMethodsOperationIds.includes(mainOperations[id].operationId)),
    'Auth methods must not be duplicated in the main client',
  );
  const mergedOperations = Object.fromEntries(
    [...Object.entries(mainOperations), ...Object.entries(authOperations)].sort(([left], [right]) => left.localeCompare(right)),
  );
  assert.equal(
    Object.keys(mergedOperations).length,
    Object.keys(mainOperations).length + Object.keys(authOperations).length,
    'Generated clients contain duplicate operation names',
  );
  const generatedRoutes = Object.values(mergedOperations).map(({ operationId, method, path: route }) => [operationId, method, route]);
  const expectedRoutes = operationIds.map(id => {
    const { method, route } = operations.get(id);
    return [id, method, route];
  });
  assert.deepEqual(generatedRoutes.sort(), expectedRoutes.sort(), 'Orval did not emit the selected OpenAPI operations');
  const files = generatedFiles(staging);
  const authFiles = generatedFiles(authStaging);
  assert.ok(files.length > 0 && authFiles.length > 0, 'Orval produced no files');
  if (process.argv.includes('--check')) {
    const instruction = 'Fresh Orval generation differs from the materialized clients';
    assert.deepEqual(generatedFiles(target), files, instruction);
    assert.deepEqual(generatedFiles(authTarget), authFiles, instruction);
    for (const file of files) {
      assert.deepEqual(readFileSync(path.join(target, file)), readFileSync(path.join(staging, file)), `${file} differs. ${instruction}`);
    }
    for (const file of authFiles) {
      assert.deepEqual(
        readFileSync(path.join(authTarget, file)),
        readFileSync(path.join(authStaging, file)),
        `auth-methods/${file} differs. ${instruction}`,
      );
    }
    console.log(`Orval generation is reproducible (${generatedRoutes.length} operations across both clients).`);
  } else {
    publishClient(staging, target, files);
    publishClient(authStaging, authTarget, authFiles);
  }
} finally {
  rmSync(staging, { recursive: true, force: true });
  rmSync(authStaging, { recursive: true, force: true });
}
