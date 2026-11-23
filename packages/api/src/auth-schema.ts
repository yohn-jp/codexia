import { createHash } from "node:crypto";
import type { Pool } from "pg";

export const CODEXIA_AUTH_SCHEMA = "codexia_auth";

// This is the catalog after the official Better Auth migrations and Codexia's
// revocation migration on PostgreSQL 17. The database acceptance test rebuilds it.
const EXPECTED_AUTH_SCHEMA = "sha256:4f186ac756d8300d8b62e192fd8d8962ebcb5a6b4b277e24f48205b08607df95";

export async function authSchemaFingerprint(pool: Pool): Promise<string> {
  // One catalog snapshot. Compare logical definitions, independent of creation
  // order, relation OIDs, generated constraint/index names, and application data.
  const result = await pool.query<{ definition: string }>(`
    WITH tables AS (
      SELECT c.oid, c.relname, c.relkind, c.relpersistence, c.relrowsecurity,
             c.relforcerowsecurity, c.relowner = n.nspowner AS schema_owned
      FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
    ), definitions AS (
      SELECT jsonb_build_array('relation', relname, relkind, relpersistence,
               relrowsecurity, relforcerowsecurity, schema_owned) AS value
      FROM tables
      UNION ALL
      SELECT jsonb_build_array('column', t.relname, a.attname,
               format_type(a.atttypid, a.atttypmod), a.attnotnull, a.attidentity, a.attgenerated,
               a.attcollation::regcollation::text, pg_get_expr(d.adbin, d.adrelid))
      FROM tables t JOIN pg_catalog.pg_attribute a ON a.attrelid = t.oid
      LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid = t.oid AND d.adnum = a.attnum
      WHERE a.attnum > 0 AND NOT a.attisdropped
      UNION ALL
      SELECT jsonb_build_array('constraint', t.relname, k.contype, k.convalidated,
               pg_get_constraintdef(k.oid, false))
      FROM tables t JOIN pg_catalog.pg_constraint k ON k.conrelid = t.oid
      UNION ALL
      SELECT jsonb_build_array('index', t.relname, i.indisunique, i.indisvalid, i.indisready,
               substring(pg_get_indexdef(i.indexrelid) FROM ' USING (.*)$'))
      FROM tables t JOIN pg_catalog.pg_index i ON i.indrelid = t.oid
    )
    SELECT value::text AS definition FROM definitions ORDER BY value::text COLLATE "C"
  `, [CODEXIA_AUTH_SCHEMA]);
  return `sha256:${createHash("sha256").update(JSON.stringify(result.rows.map(row => row.definition))).digest("hex")}`;
}

export async function verifyAuthSchema(pool: Pool): Promise<void> {
  const installed = await authSchemaFingerprint(pool);
  if (installed !== EXPECTED_AUTH_SCHEMA) {
    throw new Error(`Better Auth schema requires explicit maintenance (expected ${EXPECTED_AUTH_SCHEMA}, observed ${installed})`);
  }
}
