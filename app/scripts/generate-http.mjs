import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { generate } from "orval";
import { parse } from "yaml";
import { httpClientConfig, operationIds } from "../orval.config.mjs";

const appRoot = fileURLToPath(new URL("../", import.meta.url));
const input = fileURLToPath(new URL("../../packages/http-contract/openapi/codexia.openapi.yaml", import.meta.url));
const generatedRoot = path.join(appRoot, "src", "generated");
const target = path.join(generatedRoot, "http");
const methods = new Set(["get", "head", "post", "put", "patch", "delete", "options", "trace"]);
const operations = new Map();

for (const [route, pathItem] of Object.entries(parse(readFileSync(input, "utf8")).paths)) {
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
  assert.equal(operation.operation["x-codexia-contract-status"], undefined, `Desktop client operation ${id} is provisional`);
}

function generatedFiles(directory) {
  return readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(directory, path.join(entry.parentPath, entry.name)))
    .sort();
}

const staging = mkdtempSync(path.join(generatedRoot, ".http-"));
try {
  await generate(httpClientConfig(input, staging), appRoot);
  const { operations: generatedOperations } = await import(pathToFileURL(path.join(staging, "client.operations.ts")));
  const generatedRoutes = Object.values(generatedOperations).map(({ operationId, method, path: route }) => [operationId, method, route]);
  const expectedRoutes = operationIds.map((id) => {
    const { method, route } = operations.get(id);
    return [id, method, route];
  });
  assert.deepEqual(generatedRoutes.sort(), expectedRoutes.sort(), "Orval did not emit the selected OpenAPI operations");
  const files = generatedFiles(staging);
  assert.ok(files.length > 0, "Orval produced no files");
  if (process.argv.includes("--check")) {
    const instruction = "Run pnpm --filter @codexia/app generate:http and review the generated diff";
    assert.deepEqual(generatedFiles(target), files, instruction);
    for (const file of files) {
      assert.deepEqual(readFileSync(path.join(target, file)), readFileSync(path.join(staging, file)), `${file} differs. ${instruction}`);
    }
    console.log("Orval client matches the checked-in generated artifacts.");
  } else {
    // Only this dedicated Orval output directory is replaced.
    rmSync(target, { recursive: true, force: true });
    cpSync(staging, target, { recursive: true });
  }
} finally {
  rmSync(staging, { recursive: true, force: true });
}
