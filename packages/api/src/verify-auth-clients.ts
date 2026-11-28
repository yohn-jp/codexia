import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { verifyAuthSchema } from './auth-schema.js';
import { CODEXIA_IOS_REDIRECT_URI, createBetterAuthRuntime } from './better-auth.js';
import { assertAuthMigrationDatabaseIdentity, readBetterAuthMigrationConfig } from './migrate-auth.js';
import { installedSetupOwner } from './owner-setup-store.js';

export async function verifyBetterAuthClientRegistrations(): Promise<void> {
  const config = readBetterAuthMigrationConfig();
  const runtime = createBetterAuthRuntime({ ...config, readOnlyDatabase: true });
  try {
    await assertAuthMigrationDatabaseIdentity(runtime.pool);
    await verifyAuthSchema(runtime.pool);
    await installedSetupOwner(runtime.pool, config.ownerSubject);
    const [webClientId, iosClientId] = config.ownerClientIds;
    if (!webClientId || !iosClientId || config.ownerClientIds.length !== 2) {
      throw new Error('The reviewed owner client pair is missing');
    }
    const redirects = {
      [webClientId]: [new URL('/desktop', config.publicOrigin).href],
      [iosClientId]: [CODEXIA_IOS_REDIRECT_URI],
      [config.oauthIntrospectionClientId]: [new URL('/oauth/introspection', runtime.audience).href],
    };
    await runtime.assertRegisteredClients(config.ownerSubject, redirects);
    await runtime.verifyIntrospectionCredentials();
    process.stdout.write('Better Auth schema, public clients and introspection client verified.\n');
  } finally {
    await runtime.pool.end();
  }
}

async function main(): Promise<void> {
  await verifyBetterAuthClientRegistrations();
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  main().catch(() => {
    process.stderr.write('Better Auth client verification failed; configuration and database details are redacted.\n');
    process.exitCode = 1;
  });
}
