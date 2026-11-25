import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { generate } from 'orval';
import { parse } from 'yaml';
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
  return readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile())
    .map(entry => path.relative(directory, path.join(entry.parentPath, entry.name)))
    .sort();
}

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
    const instruction = 'Run pnpm --filter @codexia/app generate:http and review the generated diff';
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
    console.log(`Orval clients match the checked-in generated artifacts (${generatedRoutes.length} operations across both clients).`);
  } else {
    // Replace only the two dedicated Orval output directories.
    rmSync(target, { recursive: true, force: true });
    cpSync(staging, target, { recursive: true });
    rmSync(authTarget, { recursive: true, force: true });
    cpSync(authStaging, authTarget, { recursive: true });
  }
} finally {
  rmSync(staging, { recursive: true, force: true });
  rmSync(authStaging, { recursive: true, force: true });
}
