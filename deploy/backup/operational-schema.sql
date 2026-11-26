-- Apply explicitly as the database administrator before provisioning backup logins.
BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'codexia_backup_api') THEN
    CREATE ROLE codexia_backup_api NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'codexia_backup_executor') THEN
    CREATE ROLE codexia_backup_executor NOLOGIN;
  END IF;
  IF EXISTS (
    SELECT FROM pg_roles
    WHERE rolname IN ('codexia_backup_api', 'codexia_backup_executor')
      AND (rolcanlogin OR rolsuper OR rolcreaterole OR rolcreatedb OR rolreplication OR rolbypassrls)
  ) OR EXISTS (
    SELECT FROM pg_auth_members
    WHERE member IN ('codexia_backup_api'::regrole, 'codexia_backup_executor'::regrole)
  ) THEN
    RAISE EXCEPTION 'Backup roles must be unprivileged and independent';
  END IF;
END $$;

CREATE SCHEMA codexia_backup;
REVOKE ALL ON SCHEMA codexia_backup FROM PUBLIC;
GRANT USAGE ON SCHEMA codexia_backup TO codexia_backup_api, codexia_backup_executor;

CREATE TABLE codexia_backup.credentials (
  id uuid PRIMARY KEY,
  envelope jsonb NOT NULL
);

CREATE TABLE codexia_backup.revisions (
  revision integer PRIMARY KEY CHECK (revision > 0),
  destination jsonb NOT NULL,
  credential_id uuid REFERENCES codexia_backup.credentials,
  key_id text,
  CHECK ((credential_id IS NULL) = (key_id IS NULL))
);

CREATE TABLE codexia_backup.state (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  draft_revision integer REFERENCES codexia_backup.revisions,
  active_revision integer REFERENCES codexia_backup.revisions,
  applied_at timestamptz,
  executor_seen_at timestamptz,
  executor_key_ids text[] NOT NULL DEFAULT '{}',
  executor_operator_origin text,
  active_usable boolean NOT NULL DEFAULT false,
  active_health text NOT NULL DEFAULT 'unknown' CHECK (active_health IN ('unknown', 'ready', 'degraded'))
);

INSERT INTO codexia_backup.state DEFAULT VALUES;

CREATE TABLE codexia_backup.operations (
  id uuid PRIMARY KEY,
  request_id text NOT NULL UNIQUE,
  kind text NOT NULL CHECK (kind IN ('probe', 'activate', 'disable')),
  revision integer NOT NULL REFERENCES codexia_backup.revisions,
  probe_id uuid REFERENCES codexia_backup.operations,
  state text NOT NULL DEFAULT 'QUEUED' CHECK (state IN ('QUEUED', 'RUNNING', 'PASSED', 'FAILED', 'BLOCKED', 'APPLIED')),
  reason_code text,
  evidence jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  observed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((kind = 'activate') = (probe_id IS NOT NULL))
);

CREATE INDEX backup_operations_queue ON codexia_backup.operations (created_at, id) WHERE state = 'QUEUED';
CREATE UNIQUE INDEX backup_operations_in_flight
  ON codexia_backup.operations ((true)) WHERE state IN ('QUEUED', 'RUNNING');

REVOKE ALL ON ALL TABLES IN SCHEMA codexia_backup FROM PUBLIC;
GRANT INSERT (id, envelope) ON codexia_backup.credentials TO codexia_backup_api;
GRANT SELECT ON codexia_backup.credentials TO codexia_backup_executor;
GRANT SELECT ON codexia_backup.revisions, codexia_backup.state, codexia_backup.operations
  TO codexia_backup_api, codexia_backup_executor;
GRANT INSERT ON codexia_backup.revisions TO codexia_backup_api;
GRANT UPDATE (draft_revision) ON codexia_backup.state TO codexia_backup_api;
GRANT INSERT (id, request_id, kind, revision, probe_id) ON codexia_backup.operations TO codexia_backup_api;
GRANT UPDATE (active_revision, applied_at, executor_seen_at, executor_key_ids, executor_operator_origin, active_health, active_usable)
  ON codexia_backup.state TO codexia_backup_executor;
GRANT UPDATE (state, reason_code, evidence, observed_at) ON codexia_backup.operations TO codexia_backup_executor;

COMMIT;
