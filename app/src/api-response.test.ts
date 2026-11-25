import assert from 'node:assert/strict';
import { type TestContext, test } from 'node:test';
import { BUILTIN_MODULE_IDS } from '@codexia/contracts';
import { api } from './api.js';
import { readActionChangeSet } from './api-knowledge.js';

const snapshot = { projectId: 'fixture', projectVersion: 1 };

function respondWith(t: TestContext) {
  let payload: unknown;
  t.mock.method(globalThis, 'fetch', async () => Response.json(payload));
  return (value: unknown) => {
    payload = value;
  };
}

const invalidResponse = { status: 502, code: 'INVALID_RESPONSE' };

test('generated browser responses accept exactly the canonical built-in module IDs', async t => {
  const respond = respondWith(t);
  const projectId = snapshot.projectId;
  const proposal = (module: string) => ({
    id: 'proposal-1',
    snapshot,
    source: 'module',
    operations: [],
    evidence: [{ id: 'evidence-1', snapshot, module, kind: 'test', paths: [], details: {} }],
  });
  const modules = (id: string) => [{ id, availability: 'disabled', activeJobs: 0 }];
  const contributions = (id: string) => [{ id: 'test.contribution', module: id, slot: 'dock', title: 'Test', action: 'test.run' }];
  for (const id of BUILTIN_MODULE_IDS) {
    respond(modules(id));
    assert.deepEqual(await api.modules(projectId), modules(id));
    respond(contributions(id));
    assert.deepEqual(await api.contributions(projectId), contributions(id));
    const result = { ok: true, snapshot, data: {}, proposals: [proposal(id)] };
    respond(result);
    assert.deepEqual(await api.action(projectId, 'fixture.action', {}), result);
  }

  respond(modules('experimental'));
  await assert.rejects(api.modules(projectId), invalidResponse);
  respond(contributions('experimental'));
  await assert.rejects(api.contributions(projectId), invalidResponse);
  respond({ ok: true, snapshot, data: {}, proposals: [proposal('experimental')] });
  await assert.rejects(api.action(projectId, 'fixture.action', {}), invalidResponse);
});

test('Publishing actions can return a thin native ChangeSet reference for author review', () => {
  const id = 'bbfbf4c6-ea5e-4d97-a43a-b5bf0d1f6880';
  const changeSet = { id, projectId: 'project-1' };
  const actionData = { changeSet, proposalId: id, token: 'copy-once-link' };
  assert.deepEqual(readActionChangeSet(actionData, true), changeSet);
  assert.throws(() => readActionChangeSet({ proposalId: id }, true), invalidResponse);
  assert.throws(() => readActionChangeSet({ changeSet: { ...changeSet, id: 'proposal-1' } }, true), invalidResponse);
});

test('native ChangeSet responses preserve wire operation variants and reject inconsistent payloads', async t => {
  const respond = respondWith(t);
  const projectId = 'project-1';
  const operations = [
    {
      type: 'module.record.save',
      command: { projectId, moduleId: 'publishing', key: 'share-grants', value: { version: 1, grants: [] }, expectedVersion: null },
    },
    {
      type: 'knowledge.node.save',
      command: { projectId, id: 'node-1', type: 'person', name: '人物', attributes: {}, status: 'proposed', expectedVersion: null },
    },
    {
      type: 'knowledge.alias.save',
      command: { projectId, id: 'alias-1', nodeId: 'node-1', surface: '主人公', normalized: '主人公', scope: null, status: 'proposed' },
    },
    {
      type: 'knowledge.relation.save',
      command: {
        projectId,
        id: 'relation-1',
        sourceId: 'node-1',
        targetId: 'node-2',
        type: 'knows',
        attributes: {},
        validity: {},
        status: 'proposed',
        expectedVersion: null,
      },
    },
    {
      type: 'evidence.anchor.save',
      command: {
        projectId,
        id: 'evidence-1',
        documentId: 'doc-1',
        revisionId: 'rev-1',
        fromUtf16: 2,
        toUtf16: 4,
        quoteSha256: 'a'.repeat(64),
        status: 'proposed',
        expectedVersion: null,
      },
    },
    {
      type: 'evidence.mention.save',
      command: {
        projectId,
        evidenceId: 'evidence-1',
        nodeId: 'node-1',
        source: 'manual',
        confidence: null,
        extractorVersion: null,
        status: 'proposed',
      },
    },
    {
      type: 'evidence.assertion.save',
      command: {
        projectId,
        id: 'assertion-1',
        proposition: { statement: '人物' },
        modality: 'fact',
        perspective: 'narrator',
        narrativeTime: {},
        confidence: null,
        status: 'proposed',
        expectedVersion: null,
      },
    },
    { type: 'evidence.assertion.link', command: { projectId, assertionId: 'assertion-1', evidenceId: 'evidence-1', role: 'supports' } },
  ];
  const changeSet = {
    id: 'change-1',
    projectId,
    authorId: 'actor-1',
    status: 'proposed',
    version: 1,
    idempotencyKey: 'request-1',
    operations,
    readSet: [{ resource: 'knowledge_node', id: 'node-1', expectedVersion: null }],
    writeSet: [{ resource: 'knowledge_node', id: 'node-1' }],
    provenance: { source: 'native-knowledge-service', actorId: 'actor-1', details: { projectVersion: 4 } },
    createdAt: '2026-01-01T00:00:00.000Z',
    approvedAt: null,
    approvedBy: null,
    appliedAt: null,
    rejectedAt: null,
    rejectedBy: null,
  };
  respond({ changeSets: [changeSet] });
  assert.deepEqual(await api.nativeChangeSets(projectId), { changeSets: [changeSet] });
  respond({ changeSet });
  assert.deepEqual(await api.nativeChangeSet(projectId, changeSet.id), { changeSet });
  const merge = {
    type: 'knowledge.merge',
    command: {
      projectId: 'project-1',
      sourceId: 'source-1',
      targetId: 'target-1',
      projectVersion: 4,
      previewDigest: 'a'.repeat(64),
      actorId: 'external-actor',
      origin: 'external-agent',
      auditId: 'audit-1',
      generatedAliasId: 'alias-1',
      plan: {
        source: { id: 'source-1', name: 'Source' },
        target: { id: 'target-1', name: 'Target' },
        sourceAliases: [],
        targetAliases: [],
        sourceRelations: [],
        targetRelations: [],
        sourceMentions: [],
        targetMentions: [],
        assertions: [],
        conflicts: [],
      },
    },
  };
  const mergedChangeSet = { ...changeSet, operations: [merge] };
  respond({ changeSets: [mergedChangeSet] });
  assert.deepEqual(await api.nativeChangeSets(projectId), { changeSets: [mergedChangeSet] });
  const foreignMerge = { ...merge, command: { ...merge.command, projectId: 'different-project' } };
  respond({ changeSet: { ...changeSet, operations: [foreignMerge] } });
  await assert.rejects(api.nativeChangeSet(projectId, changeSet.id), invalidResponse);
  for (const invalidChangeSet of [
    { ...changeSet, operations: [{ type: 'knowledge.merge', command: { ...merge.command, previewDigest: 'stale' } }] },
    { ...changeSet, operations: [{ type: 'knowledge.future', command: {} }] },
    { ...changeSet, readSet: [{ resource: 'knowledge_node', id: 'node-1', expectedVersion: '1' }] },
  ]) {
    respond({ changeSets: [invalidChangeSet] });
    await assert.rejects(api.nativeChangeSets(projectId), invalidResponse);
  }
});

test('unified author review responses preserve the two receipt and approval models', async t => {
  const respond = respondWith(t);
  const reviewSnapshot = { projectId: 'project-1', projectVersion: 1 };
  const status = {
    proposal: { id: 'legacy-1', snapshot: reviewSnapshot, source: 'module', operations: [] },
    state: 'partially_approved',
    approvedOperationIds: ['op-1'],
    applications: [],
    appliedOperationIds: [],
    stale: false,
  };
  const native = {
    kind: 'native-change-set',
    id: 'change-1',
    projectId: 'project-1',
    createdAt: '2026-01-01T00:00:00.000Z',
    state: 'proposed',
    approvalModel: 'whole-change-set',
    applicationModel: 'transaction',
    changeSet: {
      id: 'change-1',
      projectId: 'project-1',
      authorId: 'author-1',
      status: 'proposed',
      version: 1,
      idempotencyKey: 'request-1',
      operations: [],
      readSet: [],
      writeSet: [],
      provenance: { source: 'native-knowledge-service', actorId: 'author-1', details: {} },
      createdAt: '2026-01-01T00:00:00.000Z',
      approvedAt: null,
      approvedBy: null,
      appliedAt: null,
      rejectedAt: null,
      rejectedBy: null,
    },
    receipt: null,
  };
  const core = {
    kind: 'core-proposal',
    id: 'legacy-1',
    projectId: 'project-1',
    createdAt: '2026-01-01T00:00:00.000Z',
    state: 'partially_approved',
    approvalModel: 'per-operation',
    applicationModel: 'per-operation',
    status,
    receipts: [],
    stale: false,
  };
  const projectId = reviewSnapshot.projectId;
  respond({ items: [core, native] });
  assert.deepEqual(await api.authorReviewFeed(projectId), { items: [core, native] });
  const operations = [
    { type: 'document.update', command: { projectId, documentId: 'doc-1', expectedVersion: 4, orderKey: '2000' } },
    { type: 'document.delete', command: { projectId, documentId: 'doc-1', expectedVersion: 4 } },
    {
      type: 'document.create',
      command: {
        projectId,
        documentId: 'doc-2',
        parentId: 'chapter-1',
        kind: 'scene',
        title: 'Opening',
        orderKey: '0001',
        appendToEnd: true,
        markdown: 'Opening body',
        authorId: 'author-1',
        idempotencyKey: 'create-opening',
      },
      hierarchy: {
        kind: 'scene',
        logicalId: 'opening',
        volume: { documentId: 'volume-1', lookupId: 'volume-one' },
        chapter: { documentId: 'chapter-1', lookupId: 'chapter-one' },
      },
    },
    {
      type: 'document.save',
      command: {
        projectId,
        documentId: 'doc-1',
        baseRevisionId: 'revision-4',
        changes: [{ fromUtf16: 0, toUtf16: 5, insert: 'New' }],
        resultingSha256: 'a'.repeat(64),
        authorId: 'author-1',
        clientId: 'editor',
        idempotencyKey: 'update-opening',
      },
    },
    {
      type: 'document.restore',
      command: {
        projectId,
        documentId: 'doc-1',
        baseRevisionId: 'revision-4',
        sourceRevisionId: 'revision-1',
        authorId: 'author-1',
        idempotencyKey: 'restore-opening',
      },
    },
  ];
  const documentReviews = operations.map((operation, index) => ({
    ...native,
    id: `document-change-${index}`,
    changeSet: { ...native.changeSet, id: `document-change-${index}`, operations: [operation] },
  }));
  respond({ items: [core, native, ...documentReviews] });
  assert.deepEqual(await api.authorReviewFeed(projectId), { items: [core, native, ...documentReviews] });
  const malformedRestore = {
    type: 'document.restore',
    command: {
      projectId,
      documentId: 'doc-1',
      baseRevisionId: 'revision-4',
      authorId: 'author-1',
      idempotencyKey: 'restore-opening',
    },
  };
  const foreignDelete = { type: 'document.delete', command: { projectId: 'other-project', documentId: 'doc-1', expectedVersion: 4 } };
  for (const item of [
    { ...native, changeSet: { ...native.changeSet, operations: [malformedRestore] } },
    { ...native, changeSet: { ...native.changeSet, operations: [foreignDelete] } },
    { ...native, changeSet: { ...native.changeSet, operations: [{ type: 'knowledge.future', command: {} }] } },
    { ...native, approvalModel: 'per-operation' },
    { ...core, status: { ...status, proposal: { ...status.proposal, source: 'future' } } },
  ]) {
    respond({ items: [item] });
    await assert.rejects(api.authorReviewFeed(projectId), invalidResponse);
  }
});
