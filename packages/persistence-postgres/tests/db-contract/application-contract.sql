BEGIN;
SET search_path = pgtap, public;
SELECT no_plan();

INSERT INTO public.project (id, title) VALUES
  ('11111111-1111-4111-8111-111111111111', 'Contract project one'),
  ('22222222-2222-4222-8222-222222222222', 'Contract project two');

INSERT INTO public.document (project_id, id, kind, title, order_key) VALUES
  ('11111111-1111-4111-8111-111111111111', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'chapter', 'Document one', '0001'),
  ('22222222-2222-4222-8222-222222222222', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'chapter', 'Document two', '0001');

INSERT INTO public.document_revision (project_id, document_id, id, markdown, sha256, author_id) VALUES
  ('11111111-1111-4111-8111-111111111111', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'revision one', repeat('0', 64), 'contract-author'),
  ('22222222-2222-4222-8222-222222222222', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'revision two', repeat('1', 64), 'contract-author');

UPDATE public.document SET head_revision_id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
WHERE project_id = '11111111-1111-4111-8111-111111111111' AND id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
UPDATE public.document SET head_revision_id = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
WHERE project_id = '22222222-2222-4222-8222-222222222222' AND id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

INSERT INTO public.knowledge_node (project_id, id, type, name, status) VALUES
  ('11111111-1111-4111-8111-111111111111', 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 'person', 'One', 'confirmed'),
  ('11111111-1111-4111-8111-111111111111', 'ffffffff-ffff-4fff-8fff-ffffffffffff', 'person', 'Two', 'proposed'),
  ('22222222-2222-4222-8222-222222222222', '99999999-9999-4999-8999-999999999999', 'person', 'Other project', 'confirmed');

INSERT INTO public.knowledge_alias (project_id, id, node_id, surface, normalized, status)
VALUES ('11111111-1111-4111-8111-111111111111', 'abababab-abab-4bab-8bab-abababababab',
  'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 'One', 'one', 'confirmed');
INSERT INTO public.knowledge_relation (project_id, id, source_id, target_id, type, status)
VALUES ('11111111-1111-4111-8111-111111111111', 'acacacac-acac-4cac-8cac-acacacacacac',
  'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 'ffffffff-ffff-4fff-8fff-ffffffffffff', 'knows', 'confirmed');

INSERT INTO public.text_anchor (project_id, id, document_id, current_revision_id, from_utf16, to_utf16, quote_sha256, status)
VALUES
  ('11111111-1111-4111-8111-111111111111', 'adadadad-adad-4dad-8dad-adadadadadad',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', 0, 0, repeat('2', 64), 'confirmed'),
  ('22222222-2222-4222-8222-222222222222', 'aeaeaeae-aeae-4eae-8eae-aeaeaeaeaeae',
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', 0, 0, repeat('3', 64), 'confirmed');
INSERT INTO public.anchor_history (project_id, evidence_id, document_id, version, revision_id, from_utf16, to_utf16, status)
VALUES ('11111111-1111-4111-8111-111111111111', 'adadadad-adad-4dad-8dad-adadadadadad',
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 1, 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', 0, 0, 'confirmed');
INSERT INTO public.mention_link (project_id, evidence_id, node_id, status, source, confidence)
VALUES ('11111111-1111-4111-8111-111111111111', 'adadadad-adad-4dad-8dad-adadadadadad',
  'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 'confirmed', 'contract-fixture', 0.5);
INSERT INTO public.assertion (project_id, id, proposition, modality, perspective, status)
VALUES ('11111111-1111-4111-8111-111111111111', 'afafafaf-afaf-4faf-8faf-afafafafafaf',
  '{"fact":"fixture"}', 'actual', 'omniscient', 'confirmed');
INSERT INTO public.assertion_evidence (project_id, assertion_id, evidence_id, evidence_role)
VALUES ('11111111-1111-4111-8111-111111111111', 'afafafaf-afaf-4faf-8faf-afafafafafaf',
  'adadadad-adad-4dad-8dad-adadadadadad', 'supports');
INSERT INTO public.change_set (project_id, id, author_id, status, operations, idempotency_key, request_sha256)
VALUES ('11111111-1111-4111-8111-111111111111', 'b0b0b0b0-b0b0-40b0-80b0-b0b0b0b0b0b0',
  'contract-author', 'proposed', '[{"op":"fixture"}]', 'contract-change-1', repeat('4', 64));
INSERT INTO public.module_record (project_id, module_id, key, value)
VALUES ('11111111-1111-4111-8111-111111111111', 'contract-fixture', 'record', '{"ok":true}');
INSERT INTO public.edit_operation
  (project_id, idempotency_key, operation_type, document_id, new_revision_id, request_sha256, change_desc, client_id, response_document)
VALUES ('11111111-1111-4111-8111-111111111111', 'contract-save-1', 'document.save',
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', repeat('5', 64),
  '{"description":"fixture"}', 'contract-client', '{"id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"}');

SELECT tables_are('public', ARRAY[
  'anchor_history', 'assertion', 'assertion_evidence', 'change_set', 'codexia_schema_migrations',
  'document', 'document_revision', 'edit_operation', 'knowledge_alias', 'knowledge_node',
  'knowledge_relation', 'mention_link', 'module_record', 'project', 'text_anchor'
], 'application and migration ledger table set is exact');

SELECT columns_are('public', 'project', ARRAY['id', 'title', 'settings', 'version', 'created_at', 'updated_at']);
SELECT columns_are('public', 'document', ARRAY['project_id', 'id', 'parent_id', 'kind', 'title', 'order_key', 'head_revision_id', 'version', 'created_at', 'updated_at', 'deleted_at']);
SELECT columns_are('public', 'document_revision', ARRAY['project_id', 'document_id', 'id', 'parent_revision_id', 'markdown', 'sha256', 'author_id', 'created_at']);
SELECT columns_are('public', 'edit_operation', ARRAY['project_id', 'idempotency_key', 'operation_type', 'document_id', 'base_revision_id', 'new_revision_id', 'request_sha256', 'change_desc', 'client_id', 'response_document', 'created_at']);
SELECT columns_are('public', 'knowledge_node', ARRAY['project_id', 'id', 'type', 'name', 'attributes', 'status', 'version', 'deleted_at', 'created_at', 'updated_at']);
SELECT columns_are('public', 'knowledge_alias', ARRAY['project_id', 'id', 'node_id', 'surface', 'normalized', 'scope', 'status', 'created_at', 'updated_at']);
SELECT columns_are('public', 'knowledge_relation', ARRAY['project_id', 'id', 'source_id', 'target_id', 'type', 'attributes', 'validity', 'status', 'version', 'created_at', 'updated_at']);
SELECT columns_are('public', 'text_anchor', ARRAY['project_id', 'id', 'document_id', 'current_revision_id', 'from_utf16', 'to_utf16', 'quote_sha256', 'status', 'version', 'created_at', 'updated_at']);
SELECT columns_are('public', 'anchor_history', ARRAY['project_id', 'evidence_id', 'document_id', 'version', 'revision_id', 'from_utf16', 'to_utf16', 'status', 'recorded_at']);
SELECT columns_are('public', 'mention_link', ARRAY['project_id', 'evidence_id', 'node_id', 'status', 'source', 'confidence', 'extractor_version', 'created_at', 'updated_at']);
SELECT columns_are('public', 'assertion', ARRAY['project_id', 'id', 'proposition', 'modality', 'perspective', 'narrative_time', 'confidence', 'status', 'version', 'created_at', 'updated_at']);
SELECT columns_are('public', 'assertion_evidence', ARRAY['project_id', 'assertion_id', 'evidence_id', 'evidence_role', 'created_at']);
SELECT columns_are('public', 'change_set', ARRAY['project_id', 'id', 'author_id', 'status', 'operations', 'read_set', 'write_set', 'provenance', 'version', 'idempotency_key', 'request_sha256', 'created_at', 'approved_at', 'approved_by', 'applied_at', 'rejected_at', 'rejected_by', 'application_result']);
SELECT columns_are('public', 'module_record', ARRAY['project_id', 'module_id', 'key', 'value', 'version', 'created_at', 'updated_at']);
SELECT columns_are('public', 'codexia_schema_migrations', ARRAY['version', 'checksum', 'applied_at']);

SELECT has_pk('public'::name, 'project'::name, 'project has a primary key');
SELECT has_pk('public'::name, 'document'::name, 'document has a primary key');
SELECT has_pk('public'::name, 'document_revision'::name, 'document_revision has a primary key');
SELECT has_pk('public'::name, 'edit_operation'::name, 'edit_operation has a primary key');
SELECT has_pk('public'::name, 'knowledge_node'::name, 'knowledge_node has a primary key');
SELECT has_pk('public'::name, 'knowledge_alias'::name, 'knowledge_alias has a primary key');
SELECT has_pk('public'::name, 'knowledge_relation'::name, 'knowledge_relation has a primary key');
SELECT has_pk('public'::name, 'text_anchor'::name, 'text_anchor has a primary key');
SELECT has_pk('public'::name, 'anchor_history'::name, 'anchor_history has a primary key');
SELECT has_pk('public'::name, 'mention_link'::name, 'mention_link has a primary key');
SELECT has_pk('public'::name, 'assertion'::name, 'assertion has a primary key');
SELECT has_pk('public'::name, 'assertion_evidence'::name, 'assertion_evidence has a primary key');
SELECT has_pk('public'::name, 'change_set'::name, 'change_set has a primary key');
SELECT has_pk('public'::name, 'module_record'::name, 'module_record has a primary key');
SELECT has_pk('public'::name, 'codexia_schema_migrations'::name, 'migration ledger has a primary key');

SELECT has_fk('public'::name, 'document'::name, 'document is project scoped by foreign keys');
SELECT has_fk('public'::name, 'document_revision'::name, 'revisions are document and project scoped');
SELECT has_fk('public'::name, 'edit_operation'::name, 'edit receipts are document and project scoped');
SELECT has_fk('public'::name, 'knowledge_alias'::name, 'aliases are project scoped');
SELECT has_fk('public'::name, 'knowledge_relation'::name, 'relations are project scoped');
SELECT has_fk('public'::name, 'text_anchor'::name, 'anchors are document and revision scoped');
SELECT has_fk('public'::name, 'anchor_history'::name, 'anchor history is evidence and revision scoped');
SELECT has_fk('public'::name, 'mention_link'::name, 'mentions are evidence and node scoped');
SELECT has_fk('public'::name, 'assertion_evidence'::name, 'assertion evidence is project scoped');

SELECT col_has_check('public'::name, 'project'::name, 'title'::name, 'project title is non-empty');
SELECT col_has_check('public'::name, 'project'::name, 'settings'::name, 'project settings are JSON objects');
SELECT col_has_check('public'::name, 'document'::name, ARRAY['parent_id', 'id']::name[], 'document cannot be its own parent');
SELECT col_has_check('public'::name, 'document_revision'::name, 'sha256'::name, 'revision hash has SHA-256 shape');
SELECT col_has_check('public'::name, 'text_anchor'::name, ARRAY['to_utf16', 'from_utf16']::name[], 'anchor range is non-negative and ordered');
SELECT col_has_check('public'::name, 'anchor_history'::name, ARRAY['to_utf16', 'from_utf16']::name[], 'anchor history range is non-negative and ordered');
SELECT col_has_check('public'::name, 'mention_link'::name, 'confidence'::name, 'mention confidence stays in the unit interval');
SELECT col_has_check('public'::name, 'change_set'::name, 'status'::name, 'ChangeSet state and receipt fields are consistent');

SELECT has_index('public'::name, 'document'::name, 'document_parent_order_idx'::name, 'document parent ordering index exists');
SELECT has_index('public'::name, 'document_revision'::name, 'document_revision_history_idx'::name, 'revision history index exists');
SELECT has_index('public'::name, 'edit_operation'::name, 'edit_operation_document_idx'::name, 'edit receipt lookup index exists');
SELECT has_index('public'::name, 'knowledge_node'::name, 'knowledge_node_name_idx'::name, 'knowledge name lookup index exists');
SELECT has_index('public'::name, 'knowledge_alias'::name, 'knowledge_alias_same_node_idx'::name, 'same-node alias uniqueness index exists');
SELECT has_index('public'::name, 'knowledge_alias'::name, 'knowledge_alias_lookup_idx'::name, 'alias lookup index exists');
SELECT has_index('public'::name, 'knowledge_relation'::name, 'knowledge_relation_source_type_target_idx'::name, 'outgoing relation index exists');
SELECT has_index('public'::name, 'knowledge_relation'::name, 'knowledge_relation_target_type_source_idx'::name, 'incoming relation index exists');
SELECT has_index('public'::name, 'text_anchor'::name, 'text_anchor_document_revision_position_idx'::name, 'anchor position index exists');
SELECT has_index('public'::name, 'mention_link'::name, 'mention_link_node_evidence_idx'::name, 'mention lookup index exists');
SELECT has_index('public'::name, 'change_set'::name, 'change_set_project_status_created_idx'::name, 'ChangeSet status index exists');
SELECT has_trigger('public'::name, 'document_revision'::name, 'document_revision_immutable'::name);
SELECT has_function('public'::name, 'reject_document_revision_mutation'::name);

SELECT col_type_is('public'::name, 'project'::name, 'id'::name, 'uuid', 'project identifier uses UUID');
SELECT col_type_is('public'::name, 'document_revision'::name, 'sha256'::name, 'character(64)', 'revision digest uses fixed length storage');
SELECT col_type_is('public'::name, 'text_anchor'::name, 'from_utf16'::name, 'integer', 'anchor offsets are integer UTF-16 units');
SELECT col_type_is('public'::name, 'text_anchor'::name, 'to_utf16'::name, 'integer', 'anchor end offsets are integer UTF-16 units');
SELECT col_not_null('public'::name, 'project'::name, 'title'::name, 'project title is required');
SELECT col_not_null('public'::name, 'edit_operation'::name, 'request_sha256'::name, 'idempotency request hash is required');
SELECT col_is_null('public'::name, 'document'::name, 'deleted_at'::name, 'soft-delete timestamp is optional');
SELECT col_default_is('public'::name, 'project'::name, 'settings'::name, '{}'::jsonb, 'project settings default to an empty object');
SELECT col_default_is('public'::name, 'document'::name, 'version'::name, 0::integer, 'document version starts at zero');
SELECT col_default_is('public'::name, 'codexia_schema_migrations'::name, 'applied_at'::name, 'clock_timestamp()', 'migration ledger timestamps application');

SELECT throws_ok(
  $$UPDATE public.document_revision SET markdown = 'mutated' WHERE project_id = '11111111-1111-4111-8111-111111111111' AND document_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' AND id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'$$,
  '55000', 'document revisions are immutable', 'DBV-001 rejects revision UPDATE');
SELECT throws_ok(
  $$DELETE FROM public.document_revision WHERE project_id = '11111111-1111-4111-8111-111111111111' AND document_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' AND id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'$$,
  '55000', 'document revisions are immutable', 'DBV-001 rejects revision DELETE');
SELECT throws_ok(
  $$INSERT INTO public.document (project_id, id, parent_id, kind, title, order_key) VALUES ('11111111-1111-4111-8111-111111111111', 'b1b1b1b1-b1b1-41b1-81b1-b1b1b1b1b1b1', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'chapter', 'Cross-project parent', '0002')$$,
  '23503', NULL, 'DBV-002 rejects a parent from another project');
SELECT throws_ok(
  $$INSERT INTO public.document_revision (project_id, document_id, id, markdown, sha256, author_id) VALUES ('11111111-1111-4111-8111-111111111111', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'b2b2b2b2-b2b2-42b2-82b2-b2b2b2b2b2b2', 'cross project', repeat('6', 64), 'contract-author')$$,
  '23503', NULL, 'DBV-002 rejects a revision from another project');
SELECT throws_ok(
  $$INSERT INTO public.knowledge_relation (project_id, id, source_id, target_id, type, status) VALUES ('11111111-1111-4111-8111-111111111111', 'b3b3b3b3-b3b3-43b3-83b3-b3b3b3b3b3b3', 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', '99999999-9999-4999-8999-999999999999', 'cross-project', 'proposed')$$,
  '23503', NULL, 'DBV-002 rejects a Knowledge relation across projects');
SELECT throws_ok(
  $$INSERT INTO public.assertion_evidence (project_id, assertion_id, evidence_id, evidence_role) VALUES ('11111111-1111-4111-8111-111111111111', 'afafafaf-afaf-4faf-8faf-afafafafafaf', 'aeaeaeae-aeae-4eae-8eae-aeaeaeaeaeae', 'supports')$$,
  '23503', NULL, 'DBV-002 rejects evidence from another project');

SELECT lives_ok(
  $$INSERT INTO public.text_anchor (project_id, id, document_id, current_revision_id, from_utf16, to_utf16, quote_sha256, status) VALUES ('11111111-1111-4111-8111-111111111111', 'b4b4b4b4-b4b4-44b4-84b4-b4b4b4b4b4b4', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', 2, 2, repeat('7', 64), 'needs_review')$$,
  '0002 permits an empty UTF-16 range after the range migration');
SELECT throws_ok(
  $$INSERT INTO public.text_anchor (project_id, id, document_id, current_revision_id, from_utf16, to_utf16, quote_sha256, status) VALUES ('11111111-1111-4111-8111-111111111111', 'b5b5b5b5-b5b5-45b5-85b5-b5b5b5b5b5b5', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', 2, 1, repeat('8', 64), 'needs_review')$$,
  '23514', NULL, 'DBV-003 rejects a reversed UTF-16 range');
SELECT throws_ok(
  $$INSERT INTO public.mention_link (project_id, evidence_id, node_id, status, source, confidence) VALUES ('11111111-1111-4111-8111-111111111111', 'adadadad-adad-4dad-8dad-adadadadadad', 'ffffffff-ffff-4fff-8fff-ffffffffffff', 'proposed', 'contract-fixture', 1.5)$$,
  '23514', NULL, 'DBV-003 rejects confidence above one');
SELECT throws_ok(
  $$INSERT INTO public.change_set (project_id, id, author_id, status, operations, idempotency_key, request_sha256) VALUES ('11111111-1111-4111-8111-111111111111', 'b6b6b6b6-b6b6-46b6-86b6-b6b6b6b6b6b6', 'contract-author', 'applied', '[{"op":"fixture"}]', 'invalid-applied-change', repeat('9', 64))$$,
  '23514', NULL, 'DBV-003 rejects an applied ChangeSet without approval and application receipt');
SELECT throws_ok(
  $$INSERT INTO public.edit_operation (project_id, idempotency_key, operation_type, document_id, new_revision_id, request_sha256, change_desc, client_id, response_document) VALUES ('11111111-1111-4111-8111-111111111111', 'contract-save-1', 'document.save', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', repeat('5', 64), '{"description":"fixture"}', 'contract-client', '{"id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"}')$$,
  '23505', NULL, 'DBV-004 prevents duplicate edit receipt keys');
SELECT is(
  (SELECT count(*)::integer FROM public.edit_operation WHERE project_id = '11111111-1111-4111-8111-111111111111' AND idempotency_key = 'contract-save-1'),
  1, 'DBV-004 keeps exactly one receipt after duplicate key rejection');

SELECT ok((SELECT rolsuper AND rolcanlogin FROM pg_catalog.pg_roles WHERE rolname = 'codexia_admin'),
  'DBV-006 private database administrator retains its distinct superuser identity');
SELECT ok((SELECT rolcanlogin AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls
  FROM pg_catalog.pg_roles WHERE rolname = 'codexia'),
  'DBV-006 application login has no cluster privilege escalation');
SELECT ok((SELECT rolcanlogin AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls
  FROM pg_catalog.pg_roles WHERE rolname = 'codexia_auth_runtime'),
  'DBV-006 authentication runtime has no cluster privilege escalation');
SELECT is((SELECT count(*)::integer FROM pg_catalog.pg_auth_members m
  JOIN pg_catalog.pg_roles r ON r.oid IN (m.roleid, m.member)
  WHERE r.rolname IN ('codexia', 'codexia_auth_runtime')), 0,
  'DBV-006 application and authentication logins have no inherited role memberships');
SELECT is((SELECT pg_catalog.pg_get_userbyid(datdba) FROM pg_catalog.pg_database WHERE datname = current_database()),
  'codexia', 'DBV-006 application role owns the application database');
SELECT ok(has_schema_privilege('codexia_auth_runtime', 'codexia_auth', 'USAGE'),
  'DBV-006 authentication runtime can use its isolated schema');
SELECT ok(NOT has_schema_privilege('codexia_auth_runtime', 'public', 'CREATE'),
  'DBV-006 authentication runtime cannot create application objects');
SELECT ok(NOT has_table_privilege('codexia', 'codexia_auth.user', 'SELECT'),
  'DBV-006 application login cannot read Better Auth owner credentials');
SELECT ok(NOT has_table_privilege('codexia_auth_runtime', 'public.project', 'SELECT'),
  'DBV-006 authentication runtime cannot read manuscripts');

SELECT * FROM finish();
ROLLBACK;
