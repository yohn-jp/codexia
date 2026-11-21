import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { Pool } from "pg";
import { migrationSetFingerprint, readMigrationSet } from "./migration-set.js";
import { runPostgresAdditiveMigrations } from "./migrate.js";

const connectionString = process.env.CODEXIA_TEST_DATABASE_URL;
if (!connectionString) throw new Error("CODEXIA_TEST_DATABASE_URL is required for PostgreSQL integration tests");
const admin = new Pool({ connectionString });

after(async () => { await admin.end(); });

test("certified additive migration applies only a forward prefix and retries the target", async (t) => {
  const database = "codexia_schema_maintenance_" + randomUUID().replaceAll("-", "");
  await admin.query(`CREATE DATABASE "${database}"`);
  const targetUrl = new URL(connectionString);
  targetUrl.pathname = "/" + database;
  const pool = new Pool({ connectionString: targetUrl.toString() });
  const directory = await mkdtemp(path.join(tmpdir(), "codexia-schema-maintenance-"));
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP DATABASE "${database}"`);
    await rm(directory, { recursive: true, force: true });
  });

  await writeFile(path.join(directory, "0001-base.sql"), "CREATE TABLE public.schema_maintenance_base (value text);");
  await writeFile(path.join(directory, "0002-additive.sql"), "ALTER TABLE public.schema_maintenance_base ADD COLUMN added text;");
  const migrations = await readMigrationSet(directory);
  const prior = migrationSetFingerprint(migrations.slice(0, 1));
  const target = migrationSetFingerprint(migrations);
  await pool.query("CREATE TABLE public.codexia_schema_migrations (version text PRIMARY KEY, checksum char(64) NOT NULL, applied_at timestamptz NOT NULL DEFAULT clock_timestamp())");
  await pool.query("CREATE TABLE public.schema_maintenance_base (value text)");
  await pool.query("INSERT INTO public.codexia_schema_migrations(version, checksum) VALUES ($1, $2)", [migrations[0].version, migrations[0].checksum]);

  assert.deepEqual(await runPostgresAdditiveMigrations(pool, prior, target, directory), ["0002-additive.sql"]);
  assert.deepEqual(await runPostgresAdditiveMigrations(pool, target, target, directory), []);
  await writeFile(path.join(directory, "0003-failing.sql"), "ALTER TABLE public.schema_maintenance_base ADD COLUMN value text;");
  const failingMigrations = await readMigrationSet(directory);
  const failingTarget = migrationSetFingerprint(failingMigrations);
  await assert.rejects(runPostgresAdditiveMigrations(pool, target, failingTarget, directory), /already exists|duplicate/i);
  assert.equal(Number((await pool.query("SELECT count(*) FROM public.codexia_schema_migrations")).rows[0].count), 2);
  await pool.query("UPDATE public.codexia_schema_migrations SET checksum = repeat('0', 64) WHERE version = $1", [migrations[0].version]);
  await assert.rejects(runPostgresAdditiveMigrations(pool, target, failingTarget, directory), /forward prefix|certified prior/);
});
