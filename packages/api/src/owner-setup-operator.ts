import { writeFileSync } from "node:fs";
import { Pool } from "pg";
import { CODEXIA_AUTH_SCHEMA, verifyAuthSchema } from "./auth-schema.js";
import { assertAuthMigrationDatabaseIdentity } from "./migrate-auth.js";
import { createOwnerSetupApp, readOwnerSetupConfig } from "./owner-setup.js";
import { issueOwnerSetupGrant, readOwnerSetup } from "./owner-setup-store.js";

async function main(): Promise<void> {
  const [operation, replacement, ...rest] = process.argv.slice(2);
  if (rest.length || !(["--issue-new-approved", "--describe", "--prepare-activation"].includes(operation ?? "") && replacement === undefined ||
      operation === "--replace-explicitly-approved" && replacement && /^[a-f0-9-]{36}$/u.test(replacement))) {
    throw new Error("An explicit operator setup operation is required");
  }
  const { config, redirects } = readOwnerSetupConfig();
  if (operation === "--prepare-activation") {
    const app = createOwnerSetupApp(config, redirects);
    try {
      await app.verifySchema();
      process.stdout.write(await app.prepareActivation() + "\n");
    } finally {
      await app.close();
    }
    return;
  }
  const pool = new Pool({ connectionString: config.databaseUrl, options: `-c search_path=${CODEXIA_AUTH_SCHEMA}` });
  try {
    await assertAuthMigrationDatabaseIdentity(pool);
    await verifyAuthSchema(pool, true);
    if (operation === "--describe") {
      const setup = await readOwnerSetup(pool);
      process.stdout.write(JSON.stringify({
        state: setup?.consumed_at ? "OWNER_ENROLLED" : setup?.grant_id ? "SETUP_PENDING" : "BLOCKED",
        grantId: setup?.grant_id,
      }) + "\n");
      return;
    }
    // The caller owns the reviewed out-of-band pipe. Refuse terminal output.
    if (process.stdout.isTTY) throw new Error("A protected encrypted handoff pipe is required");
    const issued = await issueOwnerSetupGrant(pool, replacement ? { replaceGrantId: replacement } : { freshInstall: true }, async (grant) => {
      writeFileSync(1, JSON.stringify({
        setupUrl: new URL("/console/setup", config.publicOrigin).toString(),
        key: grant.key,
        expiresAt: grant.expiresAt,
      }) + "\n");
    });
    if (!issued) throw new Error("The approved operation could not issue a grant");
  } finally {
    await pool.end();
  }
}

void main().catch(() => {
  process.stderr.write("Owner setup operator operation failed; details are redacted.\n");
  process.exitCode = 1;
});
