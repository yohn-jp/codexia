import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { resolveOasdiffBinary } from "../scripts/oasdiff.mjs";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("pinned oasdiff flags a deliberately breaking response schema", async () => {
  const binary = await resolveOasdiffBinary();
  const version = spawnSync(binary, ["--version"], { encoding: "utf8" });
  assert.equal(version.status, 0, version.stderr);
  assert.match(version.stdout, /1\.39\.0/u);

  const result = spawnSync(binary, [
    "breaking",
    path.join(packageRoot, "test", "fixtures", "oasdiff-base.openapi.yaml"),
    path.join(packageRoot, "test", "fixtures", "oasdiff-breaking.openapi.yaml"),
    "--allow-external-refs=false",
    "--fail-on",
    "ERR",
  ], { encoding: "utf8" });
  assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(`${result.stdout}\n${result.stderr}`, /breaking/u);
});
