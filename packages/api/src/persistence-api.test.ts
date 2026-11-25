import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { EvidenceId, KnowledgeNodeId } from '@codexia/persistence-contracts';
import { createPostgresPersistence, migratePostgresDatabase } from '@codexia/persistence-postgres';
import { handlePersistenceOperation } from './persistence-routes.js';

const connectionString = process.env.CODEXIA_TEST_DATABASE_URL;

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

test('assertion creation checks the selected mention beyond the first 500 links', { skip: !connectionString }, async t => {
  await migratePostgresDatabase(connectionString!);
  const persistence = createPostgresPersistence(connectionString!);
  t.after(() => persistence.close());
  const project = await persistence.transaction(tx => tx.createProject({ title: 'Mention membership' }));
  const { document, revision } = await persistence.transaction(tx =>
    tx.createDocument({
      projectId: project.id,
      kind: 'scene',
      title: 'Scene',
      orderKey: '1',
      markdown: 'text',
      authorId: 'author',
      idempotencyKey: randomUUID(),
    }),
  );
  const anchorId = randomUUID() as EvidenceId;
  // Fixed-width UUIDs make the primary key order match the fixture positions.
  const nodes = Array.from({ length: 502 }, (_, i) => `00000000-0000-4000-8000-${i.toString(16).padStart(12, '0')}` as KnowledgeNodeId);
  const anchor = await persistence.transaction(async tx => {
    const anchor = await tx.saveEvidenceAnchor({
      projectId: project.id,
      id: anchorId,
      documentId: document.id,
      revisionId: revision.id,
      fromUtf16: 0,
      toUtf16: 4,
      quoteSha256: sha256('text'),
      status: 'confirmed',
      expectedVersion: null,
    });
    for (const [i, nodeId] of nodes.entries()) {
      await tx.saveKnowledgeNode({
        projectId: project.id,
        id: nodeId,
        name: `Node ${i}`,
        type: 'person',
        attributes: {},
        status: 'confirmed',
        expectedVersion: null,
      });
      if (i < 501)
        await tx.saveMentionLink({
          projectId: project.id,
          evidenceId: anchorId,
          nodeId,
          status: i === 0 ? 'rejected' : 'proposed',
          source: 'author',
          confidence: null,
          extractorVersion: null,
        });
    }
    return anchor;
  });
  const propose = (nodeId: KnowledgeNodeId) =>
    handlePersistenceOperation('persistence_anchor_assertions_post', {
      persistence,
      requestHeaders: {},
      requireAuthor: async () => 'author',
      params: { projectId: project.id, documentId: document.id, anchorId },
      query: new URLSearchParams(),
      body: {
        id: randomUUID(),
        nodeId,
        statement: 'A supported claim',
        modality: 'fact',
        perspective: 'narrator',
        revisionId: revision.id,
        expectedAnchorVersion: anchor.version,
      },
    });
  assert.equal((await propose(nodes[500]!))?.status, 201);
  for (const nodeId of [nodes[0]!, nodes[501]!]) {
    const result = await propose(nodeId);
    assert.equal(result?.status, 409);
    assert.equal((result.body as { code: string }).code, 'KNOWLEDGE_LINK_REQUIRED');
  }
});
