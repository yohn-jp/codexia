import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Pool, type PoolConfig, type PoolClient } from "pg";
import { assertMigrationSet, migrationSetFingerprint, readMigrationSet, type MigrationIdentity } from "./migration-set.js";

const defaultMigrationDirectory = fileURLToPath(new URL("../migrations/", import.meta.url));

async function inspectFreshSchema(client: PoolClient, migrations: readonly MigrationIdentity[]): Promise<"pristine" | "exact"> {
  const observed = await client.query<{ public_schema: boolean; ledger: boolean }>(
    "SELECT current_schema() = 'public' AS public_schema, to_regclass('public.codexia_schema_migrations') IS NOT NULL AS ledger",
  );
  if (observed.rows[0]?.public_schema !== true) throw new Error("Fresh initialization requires the public schema");
  if (observed.rows[0].ledger) {
    // An interrupted or repeated initialization may verify an exact ledger,
    // but must never migrate an existing, partial or newer installation.
    const recorded = await client.query<MigrationIdentity>("SELECT version, checksum FROM public.codexia_schema_migrations");
    assertMigrationSet(migrations, recorded.rows);
    return "exact";
  }
  const untracked = await client.query<{ present: boolean }>(`
    SELECT EXISTS (
      SELECT 1 FROM pg_namespace WHERE nspname NOT IN ('public', 'pg_catalog', 'information_schema')
        AND nspname NOT LIKE 'pg_toast%' AND nspname NOT LIKE 'pg_temp_%'
      UNION ALL SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public'
      UNION ALL SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public'
      UNION ALL SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = 'public'
      -- Namespace dependencies also cover collations, operators, operator
      -- classes/families, conversions and text-search objects.
      UNION ALL SELECT 1 FROM pg_depend d JOIN pg_namespace n ON n.oid = d.refobjid
        WHERE d.refclassid = 'pg_namespace'::regclass AND n.nspname = 'public'
      UNION ALL SELECT 1 FROM pg_event_trigger
      UNION ALL SELECT 1 FROM pg_publication
      UNION ALL SELECT 1 FROM pg_foreign_server
      UNION ALL SELECT 1 FROM pg_foreign_data_wrapper
      UNION ALL SELECT 1 FROM pg_extension WHERE extname <> 'plpgsql'
      UNION ALL SELECT 1 FROM pg_largeobject_metadata
    ) AS present
  `);
  if (untracked.rows[0]?.present !== false) throw new Error("Fresh initialization refuses untracked database objects");
  return "pristine";
}

/** Observe a pristine database or an exact ledger without changing either.
 * The caller must separately establish host provenance before treating an exact ledger as fresh. */
export async function inspectFreshPostgresSchema(config: PoolConfig | string): Promise<{ pristine: boolean; fingerprint: string }> {
  const migrations = await readMigrationSet(defaultMigrationDirectory);
  const pool = new Pool(typeof config === "string" ? { connectionString: config } : config);
  try {
    const client = await pool.connect();
    try {
      await client.query("BEGIN READ ONLY");
      await client.query("SELECT pg_advisory_xact_lock(hashtext('codexia.persistence.migrations'))");
      const state = await inspectFreshSchema(client, migrations);
      await client.query("COMMIT");
      return { pristine: state === "pristine", fingerprint: migrationSetFingerprint(migrations) };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}

export async function runPostgresMigrations(
  pool: Pool,
  migrationDirectory = defaultMigrationDirectory,
  { freshOnly = false }: { freshOnly?: boolean } = {},
): Promise<readonly string[]> {
  const migrations = await readMigrationSet(migrationDirectory);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('codexia.persistence.migrations'))");
    if (freshOnly && await inspectFreshSchema(client, migrations) === "exact") {
      await client.query("COMMIT");
      return [];
    }
    await client.query(`
      CREATE TABLE IF NOT EXISTS codexia_schema_migrations (
        version text PRIMARY KEY,
        checksum char(64) NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$'),
        applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
      )
    `);

    const recorded = await client.query<MigrationIdentity>(
      "SELECT version, checksum FROM codexia_schema_migrations",
    );
    const applied = new Set(recorded.rows.map((row) => row.version));
    // A downgrade or edited migration must fail before applying any pending SQL.
    assertMigrationSet(migrations.filter((migration) => applied.has(migration.version)), recorded.rows);
    const newlyApplied: string[] = [];

    for (const { version: filename, sql, checksum } of migrations) {
      if (applied.has(filename)) continue;
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

/**
 * Apply a reviewed, forward-only additive migration set to an initialized
 * database.  The caller supplies the authenticated fingerprints for the
 * installed prefix and the target release; neither is inferred from the
 * database.  This is deliberately separate from the ordinary application
 * startup migrator so a controller can establish its maintenance fence
 * before invoking it.
 */
export async function runPostgresAdditiveMigrations(
  pool: Pool,
  expectedPriorFingerprint: string,
  expectedTargetFingerprint: string,
  migrationDirectory = defaultMigrationDirectory,
): Promise<readonly string[]> {
  if (!/^sha256:[a-f0-9]{64}$/u.test(expectedPriorFingerprint) || !/^sha256:[a-f0-9]{64}$/u.test(expectedTargetFingerprint)) {
    throw new Error("Invalid certified migration fingerprint");
  }
  const migrations = await readMigrationSet(migrationDirectory);
  const targetFingerprint = migrationSetFingerprint(migrations);
  if (targetFingerprint !== expectedTargetFingerprint) {
    throw new Error("Packaged migration fingerprint differs from certified target");
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('codexia.persistence.migrations'))");
    const ledger = await client.query<{ relation: string | null }>(
      "SELECT to_regclass('public.codexia_schema_migrations')::text AS relation",
    );
    if (ledger.rows[0]?.relation === null) throw new Error("Additive migration requires an initialized migration ledger");
    const recorded = await client.query<MigrationIdentity>(
      "SELECT version, checksum FROM public.codexia_schema_migrations ORDER BY version",
    );
    if (recorded.rows.length === 0 || recorded.rows.length > migrations.length) {
      throw new Error("Migration ledger is not a forward prefix of the certified target");
    }
    // A prefix is stricter than set equality: it prevents applying a target
    // suffix to a database with a skipped, reordered, edited or future row.
    for (const [index, row] of recorded.rows.entries()) {
      const expected = migrations[index];
      if (!expected || row.version !== expected.version || row.checksum.trim() !== expected.checksum) {
        throw new Error("Migration ledger is not a forward prefix of the certified target");
      }
    }
    const priorFingerprint = migrationSetFingerprint(migrations.slice(0, recorded.rows.length));
    if (priorFingerprint !== expectedPriorFingerprint) {
      throw new Error("Current migration ledger differs from certified prior state");
    }
    if (priorFingerprint === expectedTargetFingerprint) {
      await client.query("COMMIT");
      return [];
    }

    const applied: string[] = [];
    for (const migration of migrations.slice(recorded.rows.length)) {
      await client.query(migration.sql);
      await client.query(
        "INSERT INTO public.codexia_schema_migrations(version, checksum) VALUES ($1, $2)",
        [migration.version, migration.checksum],
      );
      applied.push(migration.version);
    }
    const final = await client.query<MigrationIdentity>(
      "SELECT version, checksum FROM public.codexia_schema_migrations ORDER BY version",
    );
    assertMigrationSet(migrations, final.rows);
    await client.query("COMMIT");
    return applied;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** The packaged schema identity can be computed without connecting to PostgreSQL. */
export async function packagedMigrationFingerprint(): Promise<string> {
  return migrationSetFingerprint(await readMigrationSet(defaultMigrationDirectory));
}

/** Verify the exact packaged migration ledger without creating or updating any database object. */
export async function verifyPostgresSchema(config: PoolConfig | string): Promise<string> {
  const expected = await readMigrationSet(defaultMigrationDirectory);
  const pool = new Pool(typeof config === "string" ? { connectionString: config } : config);
  try {
    const recorded = await pool.query<MigrationIdentity>("SELECT version, checksum FROM codexia_schema_migrations");
    assertMigrationSet(expected, recorded.rows);
    return migrationSetFingerprint(expected);
  } finally {
    await pool.end();
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

/** Initialize only a pristine database or verify an already exact migration ledger.
 * The pristine check and migration run share the canonical transaction/advisory lock. */
export async function initializeFreshPostgresSchema(config: PoolConfig | string): Promise<readonly string[]> {
  const pool = new Pool(typeof config === "string" ? { connectionString: config } : config);
  try {
    return await runPostgresMigrations(pool, defaultMigrationDirectory, { freshOnly: true });
  } finally {
    await pool.end();
  }
}

async function runCli(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--fingerprint") {
    console.log(await packagedMigrationFingerprint());
    return;
  }
  if (args.length !== 0 && !(args.length === 1 && args[0] === "--verify-fingerprint")) {
    throw new Error("Usage: migrate [--fingerprint | --verify-fingerprint]");
  }
  const connectionString = process.env.CODEXIA_DATABASE_URL;
  if (!connectionString) throw new Error("CODEXIA_DATABASE_URL is required");
  if (args[0] === "--verify-fingerprint") {
    console.log(await verifyPostgresSchema(connectionString));
    return;
  }
  const applied = await migratePostgresDatabase(connectionString);
  console.log(applied.length === 0 ? "Database schema is current" : `Applied: ${applied.join(", ")}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runCli().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "PostgreSQL migration failed");
    process.exitCode = 1;
  });
}
