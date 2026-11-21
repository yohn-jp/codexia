import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { CODEXIA_AUTH_SCHEMA } from "./better-auth.js";
import { readCodexiaEnvironment } from "./environment.js";
import { pruneExpiredJwtAccessTokenRevocations } from "./jwt-access-token-revocation.js";
import { assertAuthMigrationDatabaseIdentity } from "./migrate-auth.js";

function requiredAuthDatabaseUrl(): string {
  const value = readCodexiaEnvironment("AUTH_DATABASE_URL")?.trim();
  if (!value) throw new Error("CODEXIA_AUTH_DATABASE_URL is required for auth revocation pruning");
  let parsed: URL;
  try { parsed = new URL(value); }
  catch { throw new Error("CODEXIA_AUTH_DATABASE_URL must be an absolute PostgreSQL URL without query or fragment"); }
  if (!new Set(["postgres:", "postgresql:"]).has(parsed.protocol) || !parsed.hostname || parsed.search || parsed.hash) {
    throw new Error("CODEXIA_AUTH_DATABASE_URL must be an absolute PostgreSQL URL without query or fragment");
  }
  return value;
}

export function requireExplicitPrune(args: readonly string[]): void {
  if (args.length !== 1 || args[0] !== "--apply") {
    throw new Error("Refusing to prune auth revocations without the explicit --apply flag");
  }
}

export async function pruneExpiredAuthRevocations(databaseUrl = requiredAuthDatabaseUrl()): Promise<number> {
  const parsed = new URL(databaseUrl);
  if (!new Set(["postgres:", "postgresql:"]).has(parsed.protocol) || !parsed.hostname || parsed.search || parsed.hash) {
    throw new Error("CODEXIA_AUTH_DATABASE_URL must be an absolute PostgreSQL URL without query or fragment");
  }
  const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${CODEXIA_AUTH_SCHEMA}` });
  try {
    await assertAuthMigrationDatabaseIdentity(pool);
    return await pruneExpiredJwtAccessTokenRevocations(pool);
  } finally {
    await pool.end();
  }
}

async function main(): Promise<void> {
  requireExplicitPrune(process.argv.slice(2));
  const deleted = await pruneExpiredAuthRevocations();
  process.stdout.write(`Pruned ${deleted} expired OAuth access-token revocation records.\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch(() => {
    process.stderr.write("Auth revocation pruning failed; configuration or database details are redacted.\n");
    process.exitCode = 1;
  });
}
