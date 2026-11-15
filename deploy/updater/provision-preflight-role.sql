-- Run as database administrator; supply preflight_password through protected stdin.
-- Never rotate an existing role here: verify the supplied password by TCP login.
\set ON_ERROR_STOP on
\if :{?preflight_verify}
\else
\set preflight_verify false
\endif
BEGIN;
\if :preflight_verify
SET TRANSACTION READ ONLY;
\else
SELECT format('CREATE ROLE codexia_preflight LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD %L; SELECT %L', :'preflight_password', 'changed')
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'codexia_preflight') \gexec
\endif
DO $$
DECLARE r pg_roles%ROWTYPE;
BEGIN
  SELECT * INTO STRICT r FROM pg_roles WHERE rolname = 'codexia_preflight';
  IF NOT r.rolcanlogin OR r.rolinherit OR r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls
     OR EXISTS (SELECT FROM pg_auth_members WHERE member = r.oid)
     OR EXISTS (SELECT FROM pg_shdepend WHERE refclassid = 'pg_authid'::regclass AND refobjid = r.oid AND deptype = 'o')
     OR has_database_privilege(r.oid, current_database(), 'CREATE')
     OR EXISTS (SELECT FROM pg_namespace WHERE nspname NOT LIKE 'pg_temp_%' AND nspname NOT LIKE 'pg_toast_temp_%' AND has_schema_privilege(r.oid, oid, 'CREATE'))
     OR EXISTS (SELECT FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND
       ((c.relkind IN ('r','p','v','m','f') AND (has_table_privilege(r.oid,c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
         OR has_any_column_privilege(r.oid,c.oid,'INSERT,UPDATE,REFERENCES')))
       OR (c.relkind='S' AND has_sequence_privilege(r.oid,c.oid,'USAGE,UPDATE'))))
  THEN RAISE EXCEPTION 'Unsafe preflight role or inherited PUBLIC privileges; operator repair required'; END IF;
END $$;
\if :preflight_verify
\else
SELECT 'ALTER ROLE codexia_preflight SET default_transaction_read_only = on; SELECT ''changed'''
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname='codexia_preflight' AND 'default_transaction_read_only=on'=ANY(rolconfig)) \gexec
SELECT 'GRANT CONNECT ON DATABASE codexia TO codexia_preflight; SELECT ''changed'''
WHERE NOT has_database_privilege('codexia_preflight','codexia','CONNECT') \gexec
SELECT 'GRANT USAGE ON SCHEMA public TO codexia_preflight; SELECT ''changed'''
WHERE NOT has_schema_privilege('codexia_preflight','public','USAGE') \gexec
SELECT format('GRANT SELECT ON TABLE %I.%I TO codexia_preflight; SELECT %L', n.nspname, c.relname, 'changed')
FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','f')
  AND NOT has_table_privilege('codexia_preflight',c.oid,'SELECT') \gexec
\endif
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='codexia_preflight' AND 'default_transaction_read_only=on'=ANY(rolconfig))
    OR NOT has_database_privilege('codexia_preflight','codexia','CONNECT')
    OR NOT has_schema_privilege('codexia_preflight','public','USAGE')
    OR EXISTS (SELECT FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','f')
      AND NOT has_table_privilege('codexia_preflight',c.oid,'SELECT'))
  THEN RAISE EXCEPTION 'Preflight role configuration or required SELECT privileges drifted'; END IF;
END $$;
COMMIT;
