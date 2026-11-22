import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { assertAuthMigrationDatabaseIdentity, readBetterAuthMigrationConfig, requireExplicitApply } from "./migrate-auth.js";
import { createBetterAuthRuntime } from "./better-auth.js";

async function main(): Promise<void> {
  requireExplicitApply(process.argv.slice(2));
  const config = readBetterAuthMigrationConfig(false);
  if (!config.passkeyBootstrap) {
    throw new Error("AUTH_PASSKEY_BOOTSTRAP_OWNER_ID, _OWNER_EMAIL, and _OWNER_NAME are required");
  }
  const runtime = createBetterAuthRuntime(config);
  try {
    await assertAuthMigrationDatabaseIdentity(runtime.pool);
    const token = await runtime.createPasskeyBootstrapGrant();
    process.stdout.write(JSON.stringify({
      enrollmentToken: token,
      expiresInSeconds: 600,
      ownerId: config.passkeyBootstrap.ownerId,
      setupPath: "/passkey",
    }) + "\n");
  } finally {
    await runtime.pool.end();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  main().catch(() => {
    process.stderr.write("Better Auth owner enrollment grant was not created. Check the operator settings, explicit --apply flag, and auth database state.\n");
    process.exitCode = 1;
  });
}
