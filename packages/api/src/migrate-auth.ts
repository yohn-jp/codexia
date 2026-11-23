import { realpathSync } from "node:fs";
import { readCodexiaEnvironment } from "./environment.js";
import { CODEXIA_AUTH_SCHEMA } from "./auth-schema.js";
import { createBetterAuthRuntime, type BetterAuthRuntimeConfig } from "./better-auth.js";
import { migrateJwtAccessTokenRevocationSchema } from "./jwt-access-token-revocation.js";
import type { Pool } from "pg";
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

export function readBetterAuthMigrationConfig(requireOwner = true): BetterAuthRuntimeConfig {
  const oidcIssuer = readCodexiaEnvironment("OIDC_ISSUER")?.trim();
  const oidcClientId = readCodexiaEnvironment("OIDC_CLIENT_ID")?.trim();
  const oidcClientSecret = readCodexiaEnvironment("OIDC_CLIENT_SECRET");
  const oidcFields = [oidcIssuer, oidcClientId, oidcClientSecret];
  if (oidcFields.some(Boolean) && oidcFields.some((value) => !value)) {
    throw new Error("CODEXIA_OIDC_ISSUER, CODEXIA_OIDC_CLIENT_ID, and CODEXIA_OIDC_CLIENT_SECRET must be configured together");
  }
  const passkeyBootstrapOwnerId = readCodexiaEnvironment("AUTH_PASSKEY_BOOTSTRAP_OWNER_ID")?.trim();
  const passkeyBootstrapOwnerEmail = readCodexiaEnvironment("AUTH_PASSKEY_BOOTSTRAP_OWNER_EMAIL")?.trim();
  const passkeyBootstrapOwnerName = readCodexiaEnvironment("AUTH_PASSKEY_BOOTSTRAP_OWNER_NAME")?.trim();
  const bootstrapFields = [passkeyBootstrapOwnerId, passkeyBootstrapOwnerEmail, passkeyBootstrapOwnerName];
  if (bootstrapFields.some(Boolean) && bootstrapFields.some((value) => !value)) {
    throw new Error("Passkey bootstrap requires AUTH_PASSKEY_BOOTSTRAP_OWNER_ID, AUTH_PASSKEY_BOOTSTRAP_OWNER_EMAIL, and AUTH_PASSKEY_BOOTSTRAP_OWNER_NAME together");
  }
  const passkeyBootstrap = passkeyBootstrapOwnerId && passkeyBootstrapOwnerEmail && passkeyBootstrapOwnerName ? {
    ownerId: passkeyBootstrapOwnerId,
    ownerEmail: passkeyBootstrapOwnerEmail,
    ownerName: passkeyBootstrapOwnerName,
  } : undefined;
  const configuredOwner = readCodexiaEnvironment("OAUTH_OWNER_SUBJECT")?.trim();
  if (requireOwner && !passkeyBootstrap && !configuredOwner) requiredSetting("OAUTH_OWNER_SUBJECT");
  return {
    databaseUrl: requiredSetting("AUTH_DATABASE_URL"),
    publicOrigin: requiredSetting("PUBLIC_ORIGIN"),
    ...(oidcIssuer && oidcClientId && oidcClientSecret ? { oidcIssuer, oidcClientId, oidcClientSecret } : {}),
    authSecret: requiredSetting("AUTH_SECRET"),
    oauthIntrospectionClientId: requiredSetting("OAUTH_INTROSPECTION_CLIENT_ID"),
    oauthIntrospectionClientSecret: requiredSetting("OAUTH_INTROSPECTION_CLIENT_SECRET"),
    ...(configuredOwner ? { ownerSubject: configuredOwner } : {}),
    ownerClientIds: csvSetting("OAUTH_OWNER_CLIENT_IDS"),
    mcpClientIds: (readCodexiaEnvironment("OAUTH_MCP_CLIENT_IDS") ?? "").split(",").map((value) => value.trim()).filter(Boolean),
    ...(readCodexiaEnvironment("API_AUDIENCE") ? { apiAudience: readCodexiaEnvironment("API_AUDIENCE")! } : {}),
    ...(passkeyBootstrap ? { passkeyBootstrap } : {}),
  };
}

export function requireExplicitApply(args: readonly string[]): void {
  if (args.length !== 1 || args[0] !== "--apply") {
    throw new Error("Refusing to change the auth schema without the explicit --apply flag");
  }
}

export async function assertAuthMigrationDatabaseIdentity(pool: Pool): Promise<void> {
  const result = await pool.query<{ schema_name: string | null; role_name: string; owns_schema: boolean }>(
    "SELECT current_schema() AS schema_name, current_user AS role_name, " +
      "(SELECT pg_get_userbyid(nspowner) = current_user FROM pg_namespace WHERE nspname = $1) AS owns_schema",
    [CODEXIA_AUTH_SCHEMA],
  );
  const identity = result.rows[0];
  if (identity?.schema_name !== CODEXIA_AUTH_SCHEMA || identity.role_name !== CODEXIA_AUTH_RUNTIME_ROLE || !identity.owns_schema) {
    throw new Error(`Auth migration requires role ${CODEXIA_AUTH_RUNTIME_ROLE} to own ${CODEXIA_AUTH_SCHEMA} and use it as current_schema()`);
  }
}

export async function migrateBetterAuth(config = readBetterAuthMigrationConfig()): Promise<void> {
  const runtime = createBetterAuthRuntime(config);
  try {
    await assertAuthMigrationDatabaseIdentity(runtime.pool);
    await (await runtime.auth.$context).runMigrations();
    await migrateJwtAccessTokenRevocationSchema(runtime.pool);
  } finally {
    await runtime.pool.end();
  }
}

async function main(): Promise<void> {
  requireExplicitApply(process.argv.slice(2));
  await migrateBetterAuth();
  process.stdout.write(`Better Auth PostgreSQL migrations completed for schema ${CODEXIA_AUTH_SCHEMA}.\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  main().catch(() => {
    process.stderr.write("Better Auth migration failed; configuration or database details are redacted.\n");
    process.exitCode = 1;
  });
}
