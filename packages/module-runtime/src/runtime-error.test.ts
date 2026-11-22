import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { isModuleId, MODULE_IDS } from "./runtime-error.js";

test("runtime module membership matches the Full profile and rejects foreign IDs", async () => {
  const { modules } = JSON.parse(await readFile(new URL("../../../profiles/full.json", import.meta.url), "utf8")) as { modules: string[] };
  assert.deepEqual([...MODULE_IDS].sort(), [...modules].sort());
  for (const id of modules) assert.equal(isModuleId(id), true, `Full must accept ${id}`);
  for (const id of ["", "core", "unknown", "experimental", "STORY", null, 1, { id: "story" }]) {
    assert.equal(isModuleId(id), false);
  }
});
