-- Add the BKC-03 run journal to an installation already provisioned by #897.
-- Apply explicitly as the database administrator; this migration never resets config.
BEGIN;

ALTER TABLE codexia_backup.state ADD COLUMN IF NOT EXISTS run_executor_enabled boolean NOT NULL DEFAULT false;
GRANT UPDATE (run_executor_enabled) ON codexia_backup.state TO codexia_backup_executor;

CREATE TABLE IF NOT EXISTS codexia_backup.runs (
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
CREATE INDEX IF NOT EXISTS backup_runs_queue ON codexia_backup.runs (created_at, id) WHERE state = 'QUEUED';
CREATE UNIQUE INDEX IF NOT EXISTS backup_runs_in_flight
  ON codexia_backup.runs ((true)) WHERE state IN ('QUEUED', 'RUNNING');
CREATE TABLE IF NOT EXISTS codexia_backup.restore_drills (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES codexia_backup.runs,
  source_sha text NOT NULL CHECK (source_sha ~ '^[0-9a-f]{40}$'),
  manifest_sha256 text NOT NULL CHECK (manifest_sha256 ~ '^[0-9a-f]{64}$'),
  receipt_sha256 text NOT NULL CHECK (receipt_sha256 ~ '^[0-9a-f]{64}$'),
  observed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (run_id, receipt_sha256)
);
ALTER TABLE codexia_backup.restore_drills ADD COLUMN IF NOT EXISTS api_ready boolean NOT NULL DEFAULT false;
REVOKE ALL ON codexia_backup.restore_drills FROM PUBLIC;
GRANT SELECT ON codexia_backup.restore_drills TO codexia_backup_api, codexia_backup_executor;
GRANT INSERT (id, run_id, source_sha, manifest_sha256, receipt_sha256, api_ready) ON codexia_backup.restore_drills TO codexia_backup_executor;
REVOKE ALL ON codexia_backup.runs FROM PUBLIC;
GRANT SELECT ON codexia_backup.runs TO codexia_backup_api, codexia_backup_executor;
GRANT INSERT (id, request_id, kind, revision, maintenance_window_id) ON codexia_backup.runs TO codexia_backup_api;
GRANT INSERT (id, request_id, kind, revision, maintenance_window_id, schedule_slot_key, state, phase, reason_code, source_sha, image_digest, candidate_source_sha, candidate_image_digest)
  ON codexia_backup.runs TO codexia_backup_executor;
GRANT UPDATE (state, phase, reason_code, source_sha, image_digest, candidate_source_sha, candidate_image_digest, manifest_sha256, evidence, observed_at)
  ON codexia_backup.runs TO codexia_backup_executor;

COMMIT;
