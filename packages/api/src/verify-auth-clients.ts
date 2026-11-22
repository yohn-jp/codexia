import { realpathSync } from "node:fs";
import { createBetterAuthRuntime } from "./better-auth.js";
import { assertAuthMigrationDatabaseIdentity, readBetterAuthMigrationConfig } from "./migrate-auth.js";
import { fileURLToPath } from "node:url";

export async function verifyBetterAuthClientRegistrations(): Promise<void> {
  const runtime = createBetterAuthRuntime(readBetterAuthMigrationConfig());
  try {
    await assertAuthMigrationDatabaseIdentity(runtime.pool);
    await runtime.assertRegisteredClients();
    await runtime.verifyIntrospectionCredentials();
    process.stdout.write("Better Auth public and introspection client registrations verified.\n");
  } finally {
    await runtime.pool.end();
  }
}

async function main(): Promise<void> {
  await verifyBetterAuthClientRegistrations();
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  main().catch(() => {
    process.stderr.write("Better Auth client verification failed; configuration and database details are redacted.\n");
    process.exitCode = 1;
  });
}
