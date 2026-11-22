#!/usr/bin/env node
// A disposable per-shard database, matching the existing CI fixture naming contract.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";

const adminURL = new URL(process.env.CODEXIA_E2E_DATABASE_URL);
assert.equal(process.env.CI, "true");
assert.equal(adminURL.protocol, "postgres:");
assert.equal(adminURL.hostname, "postgres");
assert.equal(adminURL.pathname, "/codexia_test");
assert.ok(!adminURL.search && !adminURL.hash);
const dbName = "codexia_ci_" + randomUUID().replaceAll("-", "");
const require = createRequire(new URL("../packages/persistence-postgres/package.json", import.meta.url));
const { Client } = require("pg");
const client = new Client({ connectionString: adminURL.toString() });
try {
  await client.connect();
  await client.query(`CREATE DATABASE "${dbName}"`);
} finally {
  await client.end();
}
process.stdout.write(dbName);
