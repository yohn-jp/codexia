import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { Pool } from "pg";
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
  // These fixture certificates were computed independently from the literal SQL bytes.
  const prior = "sha256:2a27ca9dc48901383ac73d831bde2bdf9f991f297743de101decc3769ff3d240";
  const target = "sha256:281f50d1b1e13116260944a63742dbf2748734ecb0293b0a831b5109b52de8fd";
  const baseChecksum = "c5caadc00ed27aa70e503345fa40ed903cb347e7a6423533a31247d3924f1a0e";
  await pool.query("CREATE TABLE public.codexia_schema_migrations (version text PRIMARY KEY, checksum char(64) NOT NULL, applied_at timestamptz NOT NULL DEFAULT clock_timestamp())");
  await pool.query("CREATE TABLE public.schema_maintenance_base (value text)");
  await pool.query("INSERT INTO public.schema_maintenance_base (value) VALUES ('preserved')");
  await pool.query("INSERT INTO public.codexia_schema_migrations(version, checksum) VALUES ('0001-base.sql', $1)",
    [baseChecksum]);

  await assert.rejects(runPostgresAdditiveMigrations(pool, prior, prior, directory), /differs from certified target/);
  await assert.rejects(runPostgresAdditiveMigrations(pool, target, target, directory), /differs from certified prior/);
  assert.deepEqual((await pool.query("SELECT * FROM public.schema_maintenance_base")).rows, [{ value: "preserved" }]);

  assert.deepEqual(await runPostgresAdditiveMigrations(pool, prior, target, directory), ["0002-additive.sql"]);
  assert.deepEqual(await runPostgresAdditiveMigrations(pool, target, target, directory), []);
  assert.deepEqual((await pool.query("SELECT * FROM public.schema_maintenance_base")).rows, [{ value: "preserved", added: null }]);

  await writeFile(path.join(directory, "0003-write.sql"), "UPDATE public.schema_maintenance_base SET value = 'rolled back';");
  await writeFile(path.join(directory, "0004-failing.sql"), "ALTER TABLE public.schema_maintenance_base ADD COLUMN value text;");
  const failingTarget = "sha256:0b4f1ae4e6874daec4330fa5f5c4468b457947d8dea4417863af158eaa24d94c";
  await assert.rejects(runPostgresAdditiveMigrations(pool, target, failingTarget, directory), { code: "42701" });
  assert.deepEqual((await pool.query("SELECT * FROM public.schema_maintenance_base")).rows, [{ value: "preserved", added: null }]);
  assert.deepEqual((await pool.query("SELECT version, checksum FROM public.codexia_schema_migrations ORDER BY version")).rows, [
    { version: "0001-base.sql", checksum: baseChecksum },
    { version: "0002-additive.sql", checksum: "649a5d514228281247e1532d8536b3918a5dba9363ba492701b4b6820953950f" },
  ]);

  await pool.query("UPDATE public.codexia_schema_migrations SET checksum = repeat('0', 64) WHERE version = '0001-base.sql'");
  await assert.rejects(runPostgresAdditiveMigrations(pool, target, failingTarget, directory), /forward prefix/);
});
