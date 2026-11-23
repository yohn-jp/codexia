import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const compiler = path.join(packageRoot, "node_modules", ".bin", process.platform === "win32" ? "tsp.cmd" : "tsp");
const tempRoot = mkdtempSync(path.join(os.tmpdir(), "codexia-http-contract-generated-"));

try {
  const compilerOutput = path.join(tempRoot, "compiler");
  const emitterOutput = path.join(tempRoot, "openapi");
  execFileSync(compiler, [
    "compile",
    path.join(packageRoot, "src", "main.tsp"),
    "--output-dir",
    compilerOutput,
    "--options",
    `@typespec/openapi3.emitter-output-dir=${emitterOutput}`,
  ], { cwd: packageRoot, stdio: "inherit" });

  const generated = readFileSync(path.join(emitterOutput, "codexia.openapi.yaml"));
  const checkedIn = readFileSync(path.join(packageRoot, "openapi", "codexia.openapi.yaml"));
  assert.deepEqual(checkedIn, generated, "generated OpenAPI differs from the checked-in artifact; run the package generate script and review the diff");
  console.log("TypeSpec OpenAPI matches the checked-in deterministic artifact.");
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}
