import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { assertMigrationSet, migrationSetFingerprint, readMigrationSet } from "./migration-set.js";

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

test("packaged migration checksums preserve the exact UTF-8 bytes", async (t) => {
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
  // SHA-256 of the fixture bytes, including the CRLF and final LF.
  assert.equal(rows[0]?.checksum, "52ba760cf421bf5f9435bd1a6e049bc50f14ba9a0194966dc3a517f0c4b49b12");
});

test("migration fingerprint is a stable ordered JSON identity", () => {
  // Fixed release identity generated independently for the two ledger rows above.
  const fingerprint = "sha256:3da861b6d9aeb3eae8a847b5edcd96231a872d3bfee4a1ef80822a5a79653d82";
  assert.equal(migrationSetFingerprint(expected), fingerprint);
  assert.equal(migrationSetFingerprint([second, first]), fingerprint);
  assert.notEqual(migrationSetFingerprint([first]), fingerprint);
  assert.notEqual(migrationSetFingerprint([first, { ...second, version: "0003-next.sql" }]), fingerprint);
  assert.notEqual(migrationSetFingerprint([first, { ...second, checksum: "c".repeat(64) }]), fingerprint);
  assert.throws(() => migrationSetFingerprint([]), /Empty migration set/);
  assert.throws(() => migrationSetFingerprint([first, first]), /Duplicate migration identity/);
  assert.throws(() => migrationSetFingerprint([{ ...first, version: "../0001.sql" }]), /Invalid migration identity/);
  assert.throws(() => migrationSetFingerprint([{ ...first, checksum: "a" }]), /Invalid migration identity/);
});
