\set ON_ERROR_STOP on
BEGIN TRANSACTION READ ONLY;
DO $$
DECLARE
  administrator pg_roles%ROWTYPE;
  application pg_roles%ROWTYPE;
  application_database_owner oid;
BEGIN
  SELECT * INTO STRICT administrator
  FROM pg_roles
  WHERE rolname = 'codexia_admin';

  IF NOT administrator.rolcanlogin OR NOT administrator.rolsuper THEN
    RAISE EXCEPTION 'codexia_admin must remain the private login superuser';
  END IF;

  SELECT * INTO STRICT application
  FROM pg_roles
  WHERE rolname = 'codexia';

  IF NOT application.rolcanlogin
     OR application.rolsuper
     OR application.rolcreatedb
     OR application.rolcreaterole
     OR application.rolreplication
     OR application.rolbypassrls
     OR EXISTS (
       SELECT FROM pg_auth_members
       WHERE roleid = application.oid OR member = application.oid
     ) THEN
    RAISE EXCEPTION 'codexia must remain an unprivileged application login';
  END IF;

  SELECT datdba INTO STRICT application_database_owner
  FROM pg_database
  WHERE datname = 'codexia';

  IF application_database_owner <> application.oid THEN
    RAISE EXCEPTION 'codexia must own the existing codexia database';
  END IF;

  IF administrator.oid = application.oid THEN
    RAISE EXCEPTION 'database administrator and application roles must remain distinct';
  END IF;
END
$$;
COMMIT;
