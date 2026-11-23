import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { DBTransactionAdapter } from "@better-auth/core/db/adapter";
import type { Pool } from "pg";

const SETUP_ID = "first-owner";
const MODEL = "ownerSetup";

export const ownerSetupSchema = {
  modelName: "owner_setup",
  fields: {
    grantId: { type: "string", required: false, fieldName: "grant_id" },
    grantDigest: { type: "string", required: false, fieldName: "grant_digest" },
    issuedAt: { type: "date", required: false, fieldName: "issued_at" },
    expiresAt: { type: "date", required: false, fieldName: "expires_at" },
    revokedAt: { type: "date", required: false, fieldName: "revoked_at" },
    consumedAt: { type: "date", required: false, fieldName: "consumed_at" },
    ownerId: { type: "string", required: false, fieldName: "owner_id" },
  },
} as const;

export interface SetupRegistration {
  readonly grantId: string;
  readonly ownerId: string;
  readonly name: string;
  readonly email: string;
  readonly ceremonyContext: string;
}

interface SetupRow {
  readonly grant_id: string | null;
  readonly grant_digest: string | null;
  readonly expires_at: Date | null;
  readonly consumed_at: Date | null;
  readonly owner_id: string | null;
  readonly owner_count: number;
  readonly has_owner_passkey: boolean;
}

export async function migrateOwnerSetupConstraints(pool: Pool): Promise<void> {
  // Better Auth creates the model. PostgreSQL enforces the installation singleton and
  // exact enrollment/grant transitions even across replicas.
  await pool.query(`
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_constraint
        WHERE conrelid = 'codexia_auth.owner_setup'::regclass AND conname = 'owner_setup_installation'
      ) THEN
        ALTER TABLE codexia_auth.owner_setup ADD CONSTRAINT owner_setup_installation CHECK (
          id = 'first-owner' AND (
            (grant_id IS NULL AND grant_digest IS NULL AND issued_at IS NULL AND expires_at IS NULL)
            OR
            (grant_id IS NOT NULL AND grant_digest IS NOT NULL AND length(grant_digest) = 64
             AND issued_at IS NOT NULL AND expires_at IS NOT NULL AND expires_at > issued_at)
          ) AND ((consumed_at IS NULL AND owner_id IS NULL) OR
                 (consumed_at IS NOT NULL AND owner_id IS NOT NULL AND grant_id IS NOT NULL))
        );
      END IF;
    END $$;
  `);
}

export async function readOwnerSetup(pool: Pool): Promise<SetupRow | undefined> {
  const { rows } = await pool.query<SetupRow>(`
    SELECT setup.grant_id, setup.grant_digest, setup.expires_at, setup.consumed_at, setup.owner_id,
      (SELECT count(*)::int FROM "user") AS owner_count,
      EXISTS (SELECT 1 FROM "passkey" WHERE "userId" = setup.owner_id)
        AND EXISTS (SELECT 1 FROM "user" WHERE id = setup.owner_id) AS has_owner_passkey
    FROM owner_setup setup WHERE setup.id = $1
  `, [SETUP_ID]);
  return rows[0];
}

function digest(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

export function grantMatches(row: SetupRow | undefined, key: string): row is SetupRow & { grant_id: string; expires_at: Date } {
  if (!row?.grant_id || !row.grant_digest || !row.expires_at || row.expires_at.getTime() <= Date.now() ||
      row.consumed_at || row.owner_id || row.owner_count !== 0) return false;
  return timingSafeEqual(Buffer.from(row.grant_digest, "hex"), Buffer.from(digest(key), "hex"));
}

export function grantIsPending(row: SetupRow | undefined, grantId: string): boolean {
  return Boolean(row?.grant_id === grantId && row.expires_at && row.expires_at.getTime() > Date.now() &&
    !row.consumed_at && row.owner_count === 0 && !row.owner_id);
}

export async function consumeOwnerSetupGrant(adapter: DBTransactionAdapter, registration: SetupRegistration): Promise<void> {
  const now = new Date();
  const updated = await adapter.updateMany({
    model: MODEL,
    where: [
      { field: "id", value: SETUP_ID },
      { field: "grantId", value: registration.grantId },
      { field: "expiresAt", operator: "gt", value: now },
      { field: "consumedAt", value: null },
      { field: "ownerId", value: null },
    ],
    update: { consumedAt: now, ownerId: registration.ownerId },
  });
  if (updated !== 1 || await adapter.count({ model: "user" }) !== 0 ||
      await adapter.count({ model: "passkey" }) !== 0 || await adapter.count({ model: "account" }) !== 0) {
    throw new Error("Setup was closed, expired, or no longer has an empty identity database");
  }
}

interface IssuedGrant {
  readonly grantId: string;
  readonly key: string;
  readonly expiresAt: Date;
}

/** Run only through the protected fresh-install or independent reissue operation. */
export async function issueOwnerSetupGrant(
  pool: Pool,
  operation: { readonly freshInstall: true } | { readonly replaceGrantId: string },
  handoff: (grant: IssuedGrant) => Promise<void>,
): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // The grant row serializes issuance with the Better Auth enrollment transaction.
    // Identity writes from old operator registration are excluded by its host lock,
    // with the empty-user check in the ceremony retained as an independent guard.
    if ("freshInstall" in operation) {
      await client.query(`
        INSERT INTO owner_setup (id)
        SELECT $1
        WHERE NOT EXISTS (SELECT 1 FROM "user") AND NOT EXISTS (SELECT 1 FROM "account")
          AND NOT EXISTS (SELECT 1 FROM "passkey") AND NOT EXISTS (SELECT 1 FROM "session")
          AND NOT EXISTS (SELECT 1 FROM "verification") AND NOT EXISTS (SELECT 1 FROM "oauthClient")
          AND NOT EXISTS (SELECT 1 FROM "jwks")
        ON CONFLICT (id) DO NOTHING
      `, [SETUP_ID]);
    }
    const key = randomBytes(32).toString("base64url");
    const grantId = randomUUID();
    const previousGrantId = "replaceGrantId" in operation ? operation.replaceGrantId : null;
    const { rows } = await client.query<{ expires_at: Date }>(`
      UPDATE owner_setup
      SET grant_id = $2, grant_digest = $3, issued_at = statement_timestamp(),
          expires_at = statement_timestamp() + interval '24 hours',
          revoked_at = CASE WHEN grant_id IS NOT NULL THEN clock_timestamp() ELSE revoked_at END
      WHERE id = $1 AND grant_id IS NOT DISTINCT FROM $4::text AND consumed_at IS NULL AND owner_id IS NULL
        AND NOT EXISTS (SELECT 1 FROM "user") AND NOT EXISTS (SELECT 1 FROM "passkey")
        AND NOT EXISTS (SELECT 1 FROM "account") AND NOT EXISTS (SELECT 1 FROM "oauthClient")
      RETURNING expires_at
    `, [SETUP_ID, grantId, digest(key), previousGrantId]);
    const issued = rows[0];
    if (issued) await handoff({ grantId, key, expiresAt: issued.expires_at });
    await client.query("COMMIT");
    return Boolean(issued);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function ownerSetupTableExists(pool: Pool): Promise<boolean> {
  const { rows } = await pool.query<{ present: boolean }>("SELECT to_regclass('codexia_auth.owner_setup') IS NOT NULL AS present");
  return rows[0]?.present === true;
}

export async function installedSetupOwner(pool: Pool, configured: string | undefined): Promise<string> {
  const hasSetupTable = await ownerSetupTableExists(pool);
  if (hasSetupTable) {
    const setup = await readOwnerSetup(pool);
    if (!setup?.owner_id || !setup.consumed_at || !setup.has_owner_passkey || setup.owner_count !== 1 ||
        (configured && configured !== setup.owner_id)) {
      throw new Error("First-owner setup has not enrolled the single approved owner");
    }
    return setup.owner_id;
  }
  if (!configured) throw new Error("CODEXIA_OAUTH_OWNER_SUBJECT is required for an existing installation");
  return configured;
}
