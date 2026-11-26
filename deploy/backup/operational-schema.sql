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
  run_executor_enabled boolean NOT NULL DEFAULT false,
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

-- Owner-requested host backups are distinct from configuration probes and apply operations.
CREATE TABLE codexia_backup.runs (
  id uuid PRIMARY KEY,
  request_id text NOT NULL UNIQUE,
  kind text NOT NULL CHECK (kind IN ('manual', 'scheduled', 'deploy')),
  revision integer REFERENCES codexia_backup.revisions,
  maintenance_window_id text,
  schedule_slot_key text UNIQUE,
  state text NOT NULL DEFAULT 'QUEUED' CHECK (state IN ('QUEUED', 'RUNNING', 'UNKNOWN', 'FAILED', 'BLOCKED', 'REMOTE_VERIFIED')),
  phase text NOT NULL DEFAULT 'queued',
  reason_code text,
  source_sha text CHECK (source_sha IS NULL OR source_sha ~ '^[0-9a-f]{40}$'),
  image_digest text CHECK (image_digest IS NULL OR image_digest ~ '^sha256:[0-9a-f]{64}$'),
  candidate_source_sha text CHECK (candidate_source_sha IS NULL OR candidate_source_sha ~ '^[0-9a-f]{40}$'),
  candidate_image_digest text CHECK (candidate_image_digest IS NULL OR candidate_image_digest ~ '^sha256:[0-9a-f]{64}$'),
  manifest_sha256 text CHECK (manifest_sha256 IS NULL OR manifest_sha256 ~ '^[0-9a-f]{64}$'),
  evidence jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  observed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (image_digest IS NULL OR source_sha IS NOT NULL),
  CHECK ((kind IN ('manual', 'scheduled')) = (maintenance_window_id IS NOT NULL)),
  CHECK ((kind = 'scheduled') = (schedule_slot_key IS NOT NULL)),
  CHECK (kind <> 'deploy' OR (candidate_source_sha IS NOT NULL AND candidate_image_digest IS NOT NULL))
);
CREATE INDEX backup_runs_queue ON codexia_backup.runs (created_at, id) WHERE state = 'QUEUED';
CREATE UNIQUE INDEX backup_runs_in_flight ON codexia_backup.runs ((true)) WHERE state IN ('QUEUED', 'RUNNING');

CREATE TABLE codexia_backup.restore_drills (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES codexia_backup.runs,
  source_sha text NOT NULL CHECK (source_sha ~ '^[0-9a-f]{40}$'),
  manifest_sha256 text NOT NULL CHECK (manifest_sha256 ~ '^[0-9a-f]{64}$'),
  receipt_sha256 text NOT NULL CHECK (receipt_sha256 ~ '^[0-9a-f]{64}$'),
  api_ready boolean NOT NULL DEFAULT false,
  observed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (run_id, receipt_sha256)
);

CREATE INDEX backup_operations_queue ON codexia_backup.operations (created_at, id) WHERE state = 'QUEUED';
CREATE UNIQUE INDEX backup_operations_in_flight
  ON codexia_backup.operations ((true)) WHERE state IN ('QUEUED', 'RUNNING');

REVOKE ALL ON ALL TABLES IN SCHEMA codexia_backup FROM PUBLIC;
GRANT INSERT (id, envelope) ON codexia_backup.credentials TO codexia_backup_api;
GRANT SELECT ON codexia_backup.credentials TO codexia_backup_executor;
GRANT SELECT ON codexia_backup.revisions, codexia_backup.state, codexia_backup.operations
  TO codexia_backup_api, codexia_backup_executor;
GRANT SELECT ON codexia_backup.runs TO codexia_backup_api, codexia_backup_executor;
GRANT SELECT ON codexia_backup.restore_drills TO codexia_backup_api, codexia_backup_executor;
GRANT INSERT ON codexia_backup.revisions TO codexia_backup_api;
GRANT UPDATE (draft_revision) ON codexia_backup.state TO codexia_backup_api;
GRANT INSERT (id, request_id, kind, revision, probe_id) ON codexia_backup.operations TO codexia_backup_api;
GRANT INSERT (id, request_id, kind, revision, maintenance_window_id) ON codexia_backup.runs TO codexia_backup_api;
GRANT INSERT (id, run_id, source_sha, manifest_sha256, receipt_sha256, api_ready) ON codexia_backup.restore_drills TO codexia_backup_executor;
GRANT INSERT (id, request_id, kind, revision, maintenance_window_id, schedule_slot_key, state, phase, reason_code, source_sha, image_digest, candidate_source_sha, candidate_image_digest)
  ON codexia_backup.runs TO codexia_backup_executor;
GRANT UPDATE (active_revision, applied_at, executor_seen_at, executor_key_ids, executor_operator_origin, active_health, active_usable, run_executor_enabled)
  ON codexia_backup.state TO codexia_backup_executor;
GRANT UPDATE (state, reason_code, evidence, observed_at) ON codexia_backup.operations TO codexia_backup_executor;
GRANT UPDATE (state, phase, reason_code, source_sha, image_digest, candidate_source_sha, candidate_image_digest, manifest_sha256, evidence, observed_at)
  ON codexia_backup.runs TO codexia_backup_executor;

COMMIT;
