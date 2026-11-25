import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readActionChangeSet } from './api-knowledge.js';
import { PersistenceChangeSetDesktopBody } from './generated/http/schemas/persistenceChangeSetDesktopBody.zod.js';

const projectId = 'project-1';
const changeSet = {
  id: 'change-1',
  projectId,
  authorId: 'author-1',
  status: 'proposed',
  version: 1,
  idempotencyKey: 'request-1',
  operations: [
    { type: 'document.create', command: { projectId, documentId: 'doc-2', parentId: 'chapter-1', kind: 'scene', title: 'Opening', orderKey: '0001', appendToEnd: true, markdown: 'Opening body', authorId: 'author-1', idempotencyKey: 'create-opening' }, hierarchy: { kind: 'scene', logicalId: 'opening', volume: { documentId: 'volume-1', lookupId: 'volume-one' }, chapter: { documentId: 'chapter-1', lookupId: 'chapter-one' } } },
    { type: 'document.update', command: { projectId, documentId: 'doc-1', expectedVersion: 4, orderKey: '2000' } },
    { type: 'document.delete', command: { projectId, documentId: 'doc-1', expectedVersion: 4 } },
    { type: 'document.save', command: { projectId, documentId: 'doc-1', baseRevisionId: 'revision-4', changes: [{ fromUtf16: 0, toUtf16: 5, insert: 'New' }], resultingSha256: 'c'.repeat(64), authorId: 'author-1', clientId: 'editor', idempotencyKey: 'update-opening' } },
    { type: 'document.restore', command: { projectId, documentId: 'doc-1', baseRevisionId: 'revision-4', sourceRevisionId: 'revision-1', authorId: 'author-1', idempotencyKey: 'restore-opening' } },
    { type: 'module.record.save', command: { projectId, moduleId: 'publishing', key: 'share-grants', value: { version: 1, grants: [] }, expectedVersion: null } },
    { type: 'knowledge.node.save', command: { projectId, id: 'node-1', type: 'person', name: '人物', attributes: {}, status: 'proposed', expectedVersion: null } },
    { type: 'knowledge.alias.save', command: { projectId, id: 'alias-1', nodeId: 'node-1', surface: '主人公', normalized: '主人公', scope: null, status: 'proposed' } },
    { type: 'knowledge.relation.save', command: { projectId, id: 'relation-1', sourceId: 'node-1', targetId: 'node-2', type: 'knows', attributes: {}, validity: {}, status: 'proposed', expectedVersion: null } },
    { type: 'evidence.anchor.save', command: { projectId, id: 'evidence-1', documentId: 'doc-1', revisionId: 'rev-1', fromUtf16: 2, toUtf16: 4, quoteSha256: 'a'.repeat(64), status: 'proposed', expectedVersion: null } },
    { type: 'evidence.mention.save', command: { projectId, evidenceId: 'evidence-1', nodeId: 'node-1', source: 'manual', confidence: null, extractorVersion: null, status: 'proposed' } },
    { type: 'evidence.assertion.save', command: { projectId, id: 'assertion-1', proposition: { statement: '人物' }, modality: 'fact', perspective: 'narrator', narrativeTime: {}, confidence: null, status: 'proposed', expectedVersion: null } },
    { type: 'evidence.assertion.link', command: { projectId, assertionId: 'assertion-1', evidenceId: 'evidence-1', role: 'supports' } },
    { type: 'knowledge.merge', command: { projectId, sourceId: 'source-1', targetId: 'target-1', projectVersion: 4, previewDigest: 'b'.repeat(64), actorId: 'author-1', origin: 'author', auditId: 'audit-1', generatedAliasId: 'alias-generated', plan: { conflicts: [] } } },
  ],
  readSet: [{ resource: 'knowledge_node', id: 'node-1', expectedVersion: null }],
  writeSet: [{ resource: 'knowledge_node', id: 'node-1' }],
  provenance: { source: 'native-knowledge-service', actorId: 'author-1', details: { projectVersion: 4 } },
  createdAt: '2026-01-01T00:00:00.000Z',
  approvedAt: null,
  approvedBy: null,
  appliedAt: null,
  rejectedAt: null,
  rejectedBy: null,
};

test('generated ChangeSet schema covers persisted native operation variants', () => {
  assert.equal(PersistenceChangeSetDesktopBody.safeParse(changeSet).success, true);
  assert.deepEqual(readActionChangeSet({ changeSet }, false), { id: 'change-1', projectId });
  assert.equal(PersistenceChangeSetDesktopBody.safeParse({ ...changeSet, operations: [{ type: 'knowledge.future', command: {} }] }).success, false);
  assert.equal(
    PersistenceChangeSetDesktopBody.safeParse({
      ...changeSet,
      operations: [{ type: 'document.restore', command: { projectId, documentId: 'doc-1', baseRevisionId: 'revision-4', authorId: 'author-1', idempotencyKey: 'restore-opening' } }],
    }).success,
    false,
  );
  assert.equal(
    PersistenceChangeSetDesktopBody.safeParse({
      ...changeSet,
      operations: [{ type: 'knowledge.merge', command: { ...changeSet.operations.at(-1)!.command, previewDigest: 'stale' } }],
    }).success,
    false,
  );
});

test('action ChangeSet decoding checks hierarchy project binding and reference identity', () => {
  assert.throws(
    () => readActionChangeSet({ changeSet: { ...changeSet, operations: [{ ...changeSet.operations[0], command: { ...changeSet.operations[0].command, projectId: 'other-project' } }] } }, false),
    { code: 'INVALID_RESPONSE' },
  );
  const referenceId = 'bbfbf4c6-ea5e-4d97-a43a-b5bf0d1f6880';
  assert.deepEqual(readActionChangeSet({ changeSet: { id: referenceId, projectId } }, true), { id: referenceId, projectId });
  assert.throws(() => readActionChangeSet({ changeSet: { id: 'proposal-1', projectId } }, true), { code: 'INVALID_RESPONSE' });
});
