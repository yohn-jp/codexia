SET search_path = codexia_auth;

WITH tables AS (
  SELECT c.oid, c.relname, c.relkind, c.relpersistence, c.relrowsecurity,
         c.relforcerowsecurity, c.relowner = n.nspowner AS schema_owned
  FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'codexia_auth' AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
), definitions AS (
  SELECT jsonb_build_array('relation', relname, relkind, relpersistence,
           relrowsecurity, relforcerowsecurity, schema_owned) AS value FROM tables
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
SELECT value::text AS definition FROM definitions ORDER BY value::text COLLATE "C";
