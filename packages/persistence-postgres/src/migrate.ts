import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Pool, type PoolConfig } from "pg";

const defaultMigrationDirectory = fileURLToPath(new URL("../migrations/", import.meta.url));

export async function runPostgresMigrations(
  pool: Pool,
  migrationDirectory = defaultMigrationDirectory,
): Promise<readonly string[]> {
  const filenames = (await readdir(migrationDirectory))
    .filter((filename) => /^\d+[-\w]*\.sql$/u.test(filename))
    .sort();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('codexia.persistence.migrations'))");
    await client.query(`
      CREATE TABLE IF NOT EXISTS codexia_schema_migrations (
        version text PRIMARY KEY,
        checksum char(64) NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$'),
        applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
      )
    `);

    const recorded = await client.query<{ version: string; checksum: string }>(
      "SELECT version, checksum FROM codexia_schema_migrations",
    );
    const applied = new Map(recorded.rows.map((row) => [row.version, row.checksum.trim()]));
    const newlyApplied: string[] = [];

    for (const filename of filenames) {
      const sql = await readFile(path.join(migrationDirectory, filename), "utf8");
      const checksum = createHash("sha256").update(sql, "utf8").digest("hex");
      const existingChecksum = applied.get(filename);
      if (existingChecksum !== undefined) {
        if (existingChecksum !== checksum) throw new Error(`Applied migration ${filename} has changed`);
        continue;
      }

      await client.query(sql);
      await client.query(
        "INSERT INTO codexia_schema_migrations(version, checksum) VALUES ($1, $2)",
        [filename, checksum],
      );
      newlyApplied.push(filename);
    }

    await client.query("COMMIT");
    return newlyApplied;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function migratePostgresDatabase(config: PoolConfig | string): Promise<readonly string[]> {
  const pool = new Pool(typeof config === "string" ? { connectionString: config } : config);
  try {
    return await runPostgresMigrations(pool);
  } finally {
    await pool.end();
  }
}

async function runCli(): Promise<void> {
  const connectionString = process.env.CODEXIA_DATABASE_URL;
  if (!connectionString) throw new Error("CODEXIA_DATABASE_URL is required");
  const applied = await migratePostgresDatabase(connectionString);
  console.log(applied.length === 0 ? "Database schema is current" : `Applied: ${applied.join(", ")}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runCli().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "PostgreSQL migration failed");
    process.exitCode = 1;
  });
}
