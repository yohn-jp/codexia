import { readCodexiaEnvironment } from "./environment.js";
import { CODEXIA_AUTH_SCHEMA, createBetterAuthRuntime, type BetterAuthRuntimeConfig } from "./better-auth.js";
import { migrateJwtAccessTokenRevocationSchema } from "./jwt-access-token-revocation.js";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const CODEXIA_AUTH_RUNTIME_ROLE = "codexia_auth_runtime";

function requiredSetting(suffix: string): string {
  const value = readCodexiaEnvironment(suffix)?.trim();
  if (!value) throw new Error(`CODEXIA_${suffix} is required for Better Auth migrations`);
  return value;
}

function csvSetting(suffix: string): string[] {
  return [...new Set(requiredSetting(suffix).split(",").map((value) => value.trim()).filter(Boolean))];
}

export function readBetterAuthMigrationConfig(): BetterAuthRuntimeConfig {
  requiredSetting("OAUTH_OWNER_SUBJECT");
  return {
    databaseUrl: requiredSetting("AUTH_DATABASE_URL"),
    publicOrigin: requiredSetting("PUBLIC_ORIGIN"),
    oidcIssuer: requiredSetting("OIDC_ISSUER"),
    oidcClientId: requiredSetting("OIDC_CLIENT_ID"),
    oidcClientSecret: requiredSetting("OIDC_CLIENT_SECRET"),
    authSecret: requiredSetting("AUTH_SECRET"),
    oauthIntrospectionClientId: requiredSetting("OAUTH_INTROSPECTION_CLIENT_ID"),
    oauthIntrospectionClientSecret: requiredSetting("OAUTH_INTROSPECTION_CLIENT_SECRET"),
    ownerClientIds: csvSetting("OAUTH_OWNER_CLIENT_IDS"),
    mcpClientIds: (readCodexiaEnvironment("OAUTH_MCP_CLIENT_IDS") ?? "").split(",").map((value) => value.trim()).filter(Boolean),
    ...(readCodexiaEnvironment("API_AUDIENCE") ? { apiAudience: readCodexiaEnvironment("API_AUDIENCE")! } : {}),
  };
}

export function requireExplicitApply(args: readonly string[]): void {
  if (args.length !== 1 || args[0] !== "--apply") {
    throw new Error("Refusing to change the auth schema without the explicit --apply flag");
  }
}

export async function migrateBetterAuth(): Promise<void> {
  const config = readBetterAuthMigrationConfig();
  const runtime = createBetterAuthRuntime(config);
  try {
    const result = await runtime.pool.query<{ schema_name: string | null; role_name: string; owns_schema: boolean }>(
      "SELECT current_schema() AS schema_name, current_user AS role_name, " +
        "(SELECT pg_get_userbyid(nspowner) = current_user FROM pg_namespace WHERE nspname = $1) AS owns_schema",
      [CODEXIA_AUTH_SCHEMA],
    );
    const identity = result.rows[0];
    if (identity?.schema_name !== CODEXIA_AUTH_SCHEMA || identity.role_name !== CODEXIA_AUTH_RUNTIME_ROLE || !identity.owns_schema) {
      throw new Error(`Auth migration requires role ${CODEXIA_AUTH_RUNTIME_ROLE} to own ${CODEXIA_AUTH_SCHEMA} and use it as current_schema()`);
    }
    await (await runtime.auth.$context).runMigrations();
    await migrateJwtAccessTokenRevocationSchema(runtime.pool);
    process.stdout.write(`Better Auth PostgreSQL migrations completed for schema ${CODEXIA_AUTH_SCHEMA}.\n`);
  } finally {
    await runtime.pool.end();
  }
}

async function main(): Promise<void> {
  requireExplicitApply(process.argv.slice(2));
  await migrateBetterAuth();
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch(() => {
    process.stderr.write("Better Auth migration failed; configuration or database details are redacted.\n");
    process.exitCode = 1;
  });
}
