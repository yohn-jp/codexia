import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
const root = resolve(import.meta.dirname, "../../..");
const migration = resolve(root, "evidence/migration");
test("closed migration campaign retains every referenced acceptance record", async () => {
  const campaign = JSON.parse(await readFile(resolve(migration, "docs/migration/CAMPAIGN.json"), "utf8"));
  assert.equal(campaign.status, "complete");
  for (const task of campaign.tasks) {
    for (const proof of task.proofs ?? []) {
      assert.ok(proof.startsWith("docs/migration/") || proof.startsWith("docs/verification/"), proof);
      assert.ok(!proof.split("/").includes(".."));
      assert.equal((await stat(resolve(migration, proof))).isFile(), true, task.id + ": " + proof);
    }
  }
});
