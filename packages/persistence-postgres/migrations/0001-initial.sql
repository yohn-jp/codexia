CREATE TABLE project (
  id uuid PRIMARY KEY,
  title text NOT NULL CHECK (length(btrim(title)) > 0),
  settings jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(settings) = 'object'),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE document (
  project_id uuid NOT NULL REFERENCES project(id) ON DELETE RESTRICT,
  id uuid NOT NULL,
  parent_id uuid,
  kind text NOT NULL CHECK (length(btrim(kind)) > 0),
  title text NOT NULL CHECK (length(btrim(title)) > 0),
  order_key text NOT NULL,
  head_revision_id uuid,
  version integer NOT NULL DEFAULT 0 CHECK (version >= 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (project_id, id),
  UNIQUE (project_id, id, head_revision_id),
  FOREIGN KEY (project_id, parent_id) REFERENCES document(project_id, id) ON DELETE RESTRICT,
  CHECK (parent_id IS NULL OR parent_id <> id)
);

CREATE INDEX document_parent_order_idx ON document(project_id, parent_id, order_key, id);

CREATE TABLE document_revision (
  project_id uuid NOT NULL,
  document_id uuid NOT NULL,
  id uuid NOT NULL,
  parent_revision_id uuid,
  markdown text NOT NULL,
  sha256 char(64) NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  author_id text NOT NULL CHECK (length(btrim(author_id)) > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (project_id, document_id, id),
  FOREIGN KEY (project_id, document_id) REFERENCES document(project_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (project_id, document_id, parent_revision_id)
    REFERENCES document_revision(project_id, document_id, id) ON DELETE RESTRICT
);

ALTER TABLE document
  ADD CONSTRAINT document_head_revision_fk
  FOREIGN KEY (project_id, id, head_revision_id)
  REFERENCES document_revision(project_id, document_id, id)
  DEFERRABLE INITIALLY DEFERRED;

CREATE INDEX document_revision_history_idx
  ON document_revision(project_id, document_id, created_at DESC, id DESC);

CREATE FUNCTION reject_document_revision_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'document revisions are immutable' USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER document_revision_immutable
  BEFORE UPDATE OR DELETE ON document_revision
  FOR EACH ROW EXECUTE FUNCTION reject_document_revision_mutation();

CREATE TABLE edit_operation (
  project_id uuid NOT NULL,
  idempotency_key text NOT NULL CHECK (length(btrim(idempotency_key)) > 0),
  operation_type text NOT NULL CHECK (operation_type IN ('document.create', 'document.save', 'document.restore')),
  document_id uuid NOT NULL,
  base_revision_id uuid,
  new_revision_id uuid NOT NULL,
  request_sha256 char(64) NOT NULL CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),
  change_desc jsonb NOT NULL,
  client_id text NOT NULL,
  response_document jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (project_id, idempotency_key),
  FOREIGN KEY (project_id, document_id) REFERENCES document(project_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (project_id, document_id, base_revision_id)
    REFERENCES document_revision(project_id, document_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (project_id, document_id, new_revision_id)
    REFERENCES document_revision(project_id, document_id, id) ON DELETE RESTRICT
);

CREATE INDEX edit_operation_document_idx ON edit_operation(project_id, document_id, created_at DESC);

CREATE TABLE knowledge_node (
  project_id uuid NOT NULL REFERENCES project(id) ON DELETE RESTRICT,
  id uuid NOT NULL,
  type text NOT NULL CHECK (length(btrim(type)) > 0),
  name text NOT NULL CHECK (length(btrim(name)) > 0),
  attributes jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(attributes) = 'object'),
  status text NOT NULL CHECK (status IN ('proposed', 'confirmed', 'retired')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (project_id, id)
);

CREATE INDEX knowledge_node_name_idx ON knowledge_node(project_id, lower(name)) WHERE deleted_at IS NULL;

CREATE TABLE knowledge_alias (
  project_id uuid NOT NULL,
  id uuid NOT NULL,
  node_id uuid NOT NULL,
  surface text NOT NULL CHECK (length(btrim(surface)) > 0),
  normalized text NOT NULL CHECK (length(btrim(normalized)) > 0),
  scope text,
  status text NOT NULL CHECK (status IN ('proposed', 'confirmed', 'ambiguous', 'retired')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (project_id, id),
  FOREIGN KEY (project_id, node_id) REFERENCES knowledge_node(project_id, id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX knowledge_alias_same_node_idx
  ON knowledge_alias(project_id, node_id, normalized, coalesce(scope, ''));
CREATE INDEX knowledge_alias_lookup_idx ON knowledge_alias(project_id, normalized, scope, status);

CREATE TABLE knowledge_relation (
  project_id uuid NOT NULL,
  id uuid NOT NULL,
  source_id uuid NOT NULL,
  target_id uuid NOT NULL,
  type text NOT NULL CHECK (length(btrim(type)) > 0),
  attributes jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(attributes) = 'object'),
  validity jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(validity) = 'object'),
  status text NOT NULL CHECK (status IN ('proposed', 'confirmed', 'rejected', 'retired')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (project_id, id),
  FOREIGN KEY (project_id, source_id) REFERENCES knowledge_node(project_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (project_id, target_id) REFERENCES knowledge_node(project_id, id) ON DELETE RESTRICT
);

CREATE INDEX knowledge_relation_source_type_target_idx
  ON knowledge_relation(project_id, source_id, type, target_id);
CREATE INDEX knowledge_relation_target_type_source_idx
  ON knowledge_relation(project_id, target_id, type, source_id);

CREATE TABLE text_anchor (
  project_id uuid NOT NULL,
  id uuid NOT NULL,
  document_id uuid NOT NULL,
  current_revision_id uuid NOT NULL,
  from_utf16 integer NOT NULL CHECK (from_utf16 >= 0),
  to_utf16 integer NOT NULL CHECK (to_utf16 > from_utf16),
  quote_sha256 char(64) NOT NULL CHECK (quote_sha256 ~ '^[0-9a-f]{64}$'),
  status text NOT NULL CHECK (status IN ('proposed', 'confirmed', 'needs_review', 'orphaned')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (project_id, id),
  UNIQUE (project_id, id, document_id),
  FOREIGN KEY (project_id, document_id) REFERENCES document(project_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (project_id, document_id, current_revision_id)
    REFERENCES document_revision(project_id, document_id, id) ON DELETE RESTRICT
);

CREATE INDEX text_anchor_document_revision_position_idx
  ON text_anchor(project_id, document_id, current_revision_id, from_utf16);

CREATE TABLE anchor_history (
  project_id uuid NOT NULL,
  evidence_id uuid NOT NULL,
  document_id uuid NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  revision_id uuid NOT NULL,
  from_utf16 integer NOT NULL CHECK (from_utf16 >= 0),
  to_utf16 integer NOT NULL CHECK (to_utf16 > from_utf16),
  status text NOT NULL CHECK (status IN ('proposed', 'confirmed', 'needs_review', 'orphaned')),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (project_id, evidence_id, version),
  FOREIGN KEY (project_id, evidence_id, document_id) REFERENCES text_anchor(project_id, id, document_id) ON DELETE RESTRICT,
  FOREIGN KEY (project_id, document_id, revision_id)
    REFERENCES document_revision(project_id, document_id, id) ON DELETE RESTRICT
);

CREATE TABLE mention_link (
  project_id uuid NOT NULL,
  evidence_id uuid NOT NULL,
  node_id uuid NOT NULL,
  status text NOT NULL CHECK (status IN ('proposed', 'confirmed', 'ambiguous', 'rejected')),
  source text NOT NULL CHECK (length(btrim(source)) > 0),
  confidence double precision CHECK (confidence >= 0 AND confidence <= 1),
  extractor_version text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (project_id, evidence_id, node_id),
  FOREIGN KEY (project_id, evidence_id) REFERENCES text_anchor(project_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (project_id, node_id) REFERENCES knowledge_node(project_id, id) ON DELETE RESTRICT
);

CREATE INDEX mention_link_node_evidence_idx ON mention_link(project_id, node_id, evidence_id);

CREATE TABLE assertion (
  project_id uuid NOT NULL REFERENCES project(id) ON DELETE RESTRICT,
  id uuid NOT NULL,
  proposition jsonb NOT NULL CHECK (jsonb_typeof(proposition) = 'object'),
  modality text NOT NULL,
  perspective text NOT NULL,
  narrative_time jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(narrative_time) = 'object'),
  confidence double precision CHECK (confidence >= 0 AND confidence <= 1),
  status text NOT NULL CHECK (status IN ('proposed', 'confirmed', 'rejected', 'retired')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (project_id, id)
);

CREATE TABLE assertion_evidence (
  project_id uuid NOT NULL,
  assertion_id uuid NOT NULL,
  evidence_id uuid NOT NULL,
  evidence_role text NOT NULL CHECK (evidence_role IN ('supports', 'contradicts', 'quotes', 'context')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (project_id, assertion_id, evidence_id),
  FOREIGN KEY (project_id, assertion_id) REFERENCES assertion(project_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (project_id, evidence_id) REFERENCES text_anchor(project_id, id) ON DELETE RESTRICT
);

CREATE TABLE change_set (
  project_id uuid NOT NULL REFERENCES project(id) ON DELETE RESTRICT,
  id uuid NOT NULL,
  author_id text NOT NULL CHECK (length(btrim(author_id)) > 0),
  status text NOT NULL CHECK (status IN ('proposed', 'approved', 'applied', 'rejected')),
  operations jsonb NOT NULL CHECK (jsonb_typeof(operations) = 'array' AND jsonb_array_length(operations) > 0),
  read_set jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(read_set) = 'array'),
  write_set jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(write_set) = 'array'),
  provenance jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(provenance) = 'object'),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  idempotency_key text NOT NULL CHECK (length(btrim(idempotency_key)) > 0),
  request_sha256 char(64) NOT NULL CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  approved_at timestamptz,
  approved_by text,
  applied_at timestamptz,
  rejected_at timestamptz,
  rejected_by text,
  application_result jsonb,
  PRIMARY KEY (project_id, id),
  UNIQUE (project_id, idempotency_key),
  CHECK ((status IN ('approved', 'applied')) = (approved_at IS NOT NULL AND approved_by IS NOT NULL)),
  CHECK ((status = 'applied') = (applied_at IS NOT NULL AND application_result IS NOT NULL)),
  CHECK ((status = 'rejected') = (rejected_at IS NOT NULL AND rejected_by IS NOT NULL))
);

CREATE INDEX change_set_project_status_created_idx ON change_set(project_id, status, created_at DESC);
