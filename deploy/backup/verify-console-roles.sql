-- psql -v backup_api_login=... -v backup_executor_login=... -f deploy/backup/verify-console-roles.sql
\set ON_ERROR_STOP on
SELECT set_config('codexia.backup_api_login', :'backup_api_login', false),
       set_config('codexia.backup_executor_login', :'backup_executor_login', false);

DO $$
DECLARE
  api name := current_setting('codexia.backup_api_login');
  executor name := current_setting('codexia.backup_executor_login');
BEGIN
  IF api = executor OR EXISTS (
    SELECT FROM pg_roles WHERE rolname IN (api, executor)
      AND (NOT rolcanlogin OR rolsuper OR rolcreaterole OR rolcreatedb OR rolreplication OR rolbypassrls)
  ) OR NOT pg_has_role(api, 'codexia_backup_api', 'USAGE')
    OR NOT pg_has_role(executor, 'codexia_backup_executor', 'USAGE')
    OR pg_has_role(api, 'codexia_backup_executor', 'MEMBER')
    OR pg_has_role(executor, 'codexia_backup_api', 'MEMBER')
    OR has_column_privilege(api, 'codexia_backup.credentials', 'envelope', 'SELECT')
    OR has_column_privilege(api, 'codexia_backup.state', 'active_revision', 'UPDATE')
    OR has_column_privilege(api, 'codexia_backup.operations', 'state', 'UPDATE')
    OR has_any_column_privilege(api, 'codexia_backup.runs', 'UPDATE,REFERENCES')
    OR has_table_privilege(api, 'codexia_backup.runs', 'DELETE,TRUNCATE')
    OR EXISTS (
      SELECT FROM unnest(ARRAY['source_sha', 'image_digest', 'candidate_source_sha', 'candidate_image_digest',
                              'state', 'phase', 'reason_code', 'manifest_sha256', 'evidence']) AS column_name
      WHERE has_column_privilege(api, 'codexia_backup.runs', column_name, 'INSERT')
    )
    OR has_any_column_privilege(api, 'codexia_backup.restore_drills', 'INSERT,UPDATE,REFERENCES')
    OR has_table_privilege(api, 'codexia_backup.restore_drills', 'DELETE,TRUNCATE')
    OR NOT has_column_privilege(api, 'codexia_backup.runs', 'request_id', 'INSERT')
    OR NOT has_column_privilege(executor, 'codexia_backup.runs', 'evidence', 'UPDATE')
    OR NOT has_column_privilege(executor, 'codexia_backup.restore_drills', 'receipt_sha256', 'INSERT')
    OR has_column_privilege(executor, 'codexia_backup.state', 'draft_revision', 'UPDATE')
    OR has_any_column_privilege(executor, 'codexia_backup.credentials', 'INSERT,UPDATE,REFERENCES')
    OR EXISTS (
      SELECT FROM pg_class AS c
      JOIN pg_namespace AS n ON c.relnamespace = n.oid
      WHERE n.nspname NOT IN ('codexia_backup', 'pg_catalog', 'information_schema')
        AND n.nspname NOT LIKE 'pg_%' AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
        AND (has_table_privilege(api, c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE')
           OR has_table_privilege(executor, c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE')
          OR has_any_column_privilege(api, c.oid, 'SELECT,INSERT,UPDATE,REFERENCES')
          OR has_any_column_privilege(executor, c.oid, 'SELECT,INSERT,UPDATE,REFERENCES'))
    ) THEN
    RAISE EXCEPTION 'Backup logins are not isolated';
  END IF;
END $$;
