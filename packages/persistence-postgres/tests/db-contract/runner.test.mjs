import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { assertCatalogMatches, buildSourceIdentity, parseTapOutput } from "../../../../scripts/postgres-contract/contract-runner.mjs";

test("pgTAP output requires a complete passing plan", () => {
  assert.deepEqual(parseTapOutput("1..2\nok 1 - project exists\nok 2 - revision is immutable\n"), {
    planned: 2,
    executed: 2,
    failed: [],
  });
});

test("pgTAP failures cannot be hidden behind a successful psql exit", () => {
  assert.throws(
    () => parseTapOutput("1..2\nok 1 - project exists\nnot ok 2 - revision is immutable\n"),
    /pgTAP reported 1 failed assertion/u,
  );
});

test("pgTAP output fails when assertions do not match the declared plan", () => {
  assert.throws(
    () => parseTapOutput("1..2\nok 1 - project exists\n"),
    /planned 2 assertions but executed 1/u,
  );
});

test("source identity binds sorted files, exact contents, and the checked out revision", () => {
  const identity = buildSourceIdentity({
    sourceSha: "a".repeat(40),
    files: [
      { path: "tests/schema.sql", contents: "SELECT 1;\n" },
      { path: "migrations/0001-initial.sql", contents: "CREATE TABLE project(id uuid);\n" },
    ],
  });
  const expectedFiles = [
    { path: "migrations/0001-initial.sql", sha256: createHash("sha256").update("CREATE TABLE project(id uuid);\n").digest("hex") },
    { path: "tests/schema.sql", sha256: createHash("sha256").update("SELECT 1;\n").digest("hex") },
  ];
  assert.equal(identity.sourceSha, "a".repeat(40));
  assert.deepEqual(identity.files, expectedFiles);
  assert.equal(identity.filesSha256, createHash("sha256").update(JSON.stringify(expectedFiles)).digest("hex"));
});

test("source identity changes when an input changes and contains no connection details", () => {
  const common = { sourceSha: "b".repeat(40), files: [{ path: "schema.sql", contents: "SELECT 1;" }] };
  const original = buildSourceIdentity(common);
  const changed = buildSourceIdentity({ ...common, files: [{ path: "schema.sql", contents: "SELECT 2;" }] });
  assert.notEqual(original.filesSha256, changed.filesSha256);
  assert.doesNotMatch(JSON.stringify(original), /password|secret|databaseUrl|connectionString/iu);
});

test("pg_catalog output must match the reviewed physical contract", () => {
  const expected = {
    relations: [{ schema: "public", name: "project", columns: [{ name: "id", type: "uuid", notNull: true }] }],
    indexes: [{ schema: "public", table: "project", name: "project_pkey", unique: true }],
  };
  assert.doesNotThrow(() => assertCatalogMatches(expected, structuredClone(expected)));
  const drifted = structuredClone(expected);
  drifted.relations[0].columns[0].type = "text";
  assert.throws(() => assertCatalogMatches(expected, drifted), /pg_catalog differs from reviewed physical contract/u);
});

test("pg_catalog contract detects unreviewed objects and grants", () => {
  const expected = { objects: [{ schema: "codexia_auth", name: "user", kind: "table" }], grants: [] };
  assert.throws(() => assertCatalogMatches(expected, {
    objects: [...expected.objects, { schema: "public", name: "unauthorized", kind: "table" }], grants: [],
  }), /pg_catalog differs from reviewed physical contract/u);
  assert.throws(() => assertCatalogMatches(expected, {
    objects: expected.objects, grants: [{ grantee: "codexia", privilege: "SELECT", object: "codexia_auth.user" }],
  }), /pg_catalog differs from reviewed physical contract/u);
});
