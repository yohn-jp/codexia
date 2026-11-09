ALTER TABLE document ADD COLUMN deleted_at timestamptz;
CREATE TABLE module_record (
  project_id uuid NOT NULL REFERENCES project(id) ON DELETE RESTRICT,
  module_id text NOT NULL CHECK (length(btrim(module_id)) > 0),
  key text NOT NULL CHECK (length(btrim(key)) > 0),
  value jsonb NOT NULL CHECK (jsonb_typeof(value) = 'object'),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (project_id, module_id, key)
);
