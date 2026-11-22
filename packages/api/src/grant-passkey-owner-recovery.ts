import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { assertAuthMigrationDatabaseIdentity, readBetterAuthMigrationConfig, requireExplicitApply } from "./migrate-auth.js";
import { createBetterAuthRuntime } from "./better-auth.js";

async function main(): Promise<void> {
  requireExplicitApply(process.argv.slice(2));
  const config = readBetterAuthMigrationConfig();
  if (config.passkeyBootstrap || !config.ownerSubject) {
    throw new Error("Passkey recovery requires the configured existing owner and no first-owner bootstrap mode");
  }
  const runtime = createBetterAuthRuntime(config);
  try {
    await assertAuthMigrationDatabaseIdentity(runtime.pool);
    const result = await runtime.createPasskeyOwnerRecoveryGrant();
    process.stdout.write(JSON.stringify({
      recoveryToken: result.token,
      expiresInSeconds: result.expiresInSeconds,
      ownerId: result.ownerId,
      recordedAt: result.recordedAt.toISOString(),
      sessionsRevoked: result.sessionsRevoked,
      accessGrantsRevoked: result.accessGrantsRevoked,
      refreshGrantsRevoked: result.refreshGrantsRevoked,
      setupPath: "/passkey",
    }) + "\n");
  } finally {
    await runtime.pool.end();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  main().catch(() => {
    process.stderr.write("Passkey owner recovery was not started. Check the configured owner, explicit --apply flag, and auth database state.\n");
    process.exitCode = 1;
  });
}
