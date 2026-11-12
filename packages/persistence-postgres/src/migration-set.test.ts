import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { assertMigrationSet, readMigrationSet } from "./migration-set.js";

const first = { version: "0001-init.sql", checksum: "a".repeat(64) };
const second = { version: "0002-next.sql", checksum: "b".repeat(64) };
const expected = [first, second];

test("migration gate requires the exact applied set regardless of row order", () => {
  assert.doesNotThrow(() => assertMigrationSet(expected, [second, first]));
  assert.throws(() => assertMigrationSet(expected, [first]), /Missing applied migration/);
  assert.throws(() => assertMigrationSet([first], expected), /Unexpected applied migration/);
  assert.throws(() => assertMigrationSet(expected, [first, { ...second, checksum: first.checksum }]), /has changed/);
  assert.throws(() => assertMigrationSet(expected, [first, second, second]), /Duplicate applied migration/);
});

test("packaged migration checksums match the migration runner's UTF-8 input", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "codexia-migration-set-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await assert.rejects(readMigrationSet(directory), /No packaged PostgreSQL migrations/);
  const sql = "-- 日本語\r\nSELECT 1;\n";
  await writeFile(path.join(directory, second.version), "SELECT 2;");
  await writeFile(path.join(directory, first.version), sql);
  await writeFile(path.join(directory, "README.md"), "not a migration");
  const rows = await readMigrationSet(directory);
  assert.deepEqual(rows.map((row) => row.version), [first.version, second.version]);
  assert.equal(rows[0]?.sql, sql);
  assert.equal(rows[0]?.checksum, createHash("sha256").update(sql, "utf8").digest("hex"));
});
