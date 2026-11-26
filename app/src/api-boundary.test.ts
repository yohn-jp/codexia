import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import type { ChangeOperation } from '@codexia/contracts';
import { ApiError, api } from './api.js';

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});
const invalid = (error: unknown) => error instanceof ApiError && error.code === 'INVALID_RESPONSE';

test('audit browser API rejects malformed, empty and incorrectly shaped successful session responses', async () => {
  for (const response of [
    new Response('not json'),
    Response.json(null),
    Response.json({}),
    new Response(null, { status: 204 }),
    Response.json({ authenticated: true, authorScope: 5 }),
  ]) {
    globalThis.fetch = async () => response;
    await assert.rejects(api.session(), invalid);
  }
  globalThis.fetch = async () => Response.json({ authenticated: true, authorScope: 'owner', futureField: true });
  assert.equal((await api.session()).authorScope, 'owner');
});

test('audit browser API rejects an invalid runtime profile in the version response', async () => {
  globalThis.fetch = async () =>
    Response.json({ name: 'codexia', version: '0.1.0', contractVersion: 2, profile: null, auth: [], runtime: {}, modules: [] });
  await assert.rejects(api.version(), invalid);
});

test('audit browser API validates PostgreSQL apply receipts before recovery accepts them', async () => {
  const operation: ChangeOperation = {
    id: 'op-1',
    generation: 0,
    effect: 'manuscript',
    message: 'save',
    projectId: 'project-1',
    baseProjectVersion: 1,
    reads: [],
    writes: [{ path: 'documents/a.md', revision: null, content: 'text' }],
  };
  for (const receipt of [
    { operationId: 'op-1', generation: '0', projectVersion: 2, revisions: [] },
    { operationId: 'op-1', generation: 0, projectVersion: 0, revisions: [] },
    { operationId: 'op-1', generation: 0, localCommit: 'b'.repeat(40), revisions: [] },
  ]) {
    globalThis.fetch = async () => Response.json(receipt);
    await assert.rejects(api.apply('project-1', operation), invalid);
  }
  globalThis.fetch = async () => Response.json({ operationId: 'op-1', generation: 0, projectVersion: 2, revisions: [] });
  assert.equal((await api.apply('project-1', operation)).projectVersion, 2);
});

test('audit browser API preserves service errors and permits 204 only for no-content endpoints', async () => {
  globalThis.fetch = async () => new Response('temporarily unavailable', { status: 503 });
  await assert.rejects(api.session(), (error: unknown) => error instanceof ApiError && error.status === 503);
  globalThis.fetch = async () => new Response(null, { status: 204 });
  assert.equal(
    await api.approve('project-1', {
      proposalId: 'proposal-1',
      operationIds: ['operation-1'],
      authorScope: 'owner',
    }),
    undefined,
  );
  await assert.rejects(api.deletePersistenceDocument('project-1', 'document-1', 1), invalid);
  await assert.rejects(api.persistenceProjectPage(100), invalid);
  globalThis.fetch = async () => Response.json([]);
  await assert.rejects(api.persistenceProjectPage(100), invalid);
});

test('audit browser API rejects successful actions missing their required opaque payload', async () => {
  const snapshot = { projectId: 'project-1', projectVersion: 1 };
  globalThis.fetch = async () => Response.json({ ok: true, snapshot });
  await assert.rejects(api.action('project-1', 'core.document.resolve', {}), invalid);
  globalThis.fetch = async () => Response.json({ ok: true, snapshot, data: null });
  const result = await api.action('project-1', 'core.document.resolve', {});
  assert.equal(result.ok && result.data, null);
});

test('mapped manuscript references use the canonical document ID from the selected project snapshot', async () => {
  const snapshot = { projectId: 'project-1', projectVersion: 23 };
  const path = 'manuscript/vol-story/ch-story/sc-story.md';
  const documentId = '00000000-0000-4000-8000-000000000002';
  let result: unknown = { ok: true, snapshot, data: { documentId } };
  globalThis.fetch = async (input, init) => {
    assert.equal(String(input), '/api/projects/project-1/actions/core.document.resolve');
    assert.equal(init?.method, 'POST');
    assert.deepEqual(JSON.parse(String(init?.body)), { input: { path }, snapshot });
    return Response.json(result);
  };

  assert.equal(await api.resolveDocumentReference(snapshot.projectId, path, snapshot), documentId);
  result = { ok: true, snapshot, data: { documentId: null, document: null } };
  assert.equal(await api.resolveDocumentReference(snapshot.projectId, path, snapshot), null);
  for (const response of [
    { ok: true, snapshot, data: { sceneId: 'sc-story' } },
    { ok: true, snapshot, data: { documentId: '' } },
    { ok: true, snapshot: { ...snapshot, projectId: 'another-project' }, data: { documentId } },
    { ok: true, snapshot: { ...snapshot, projectVersion: 24 }, data: { documentId } },
  ]) {
    result = response;
    await assert.rejects(api.resolveDocumentReference(snapshot.projectId, path, snapshot), invalid);
  }
});

test('audit browser API rejects jobs missing their required opaque result', async () => {
  const job = {
    id: 'job-1',
    type: 'fixture',
    status: 'done',
    progress: 1,
    error: null,
    createdAt: '2026-10-23T00:00:00Z',
    updatedAt: '2026-10-23T00:00:00Z',
    finishedAt: null,
  };
  globalThis.fetch = async () => Response.json([job]);
  await assert.rejects(api.jobs(), invalid);
  globalThis.fetch = async () => Response.json([{ ...job, result: null }]);
  assert.equal((await api.jobs())[0]?.result, null);
});

test('Knowledge browse carries server-selected filters into the opaque cursor continuation', async () => {
  const filters = { q: 'literal%_! alias', type: 'person', status: 'confirmed' };
  const cursor = 'opaque+next/page=';
  const nodes = ['Aoi', 'Mio'].map((name, index) => ({
    id: `node-${index}`,
    projectId: 'project-1',
    name,
    type: 'person',
    status: 'confirmed',
    attributes: {},
    version: 1,
    deletedAt: null,
    createdAt: '2026-11-23T00:00:00.000Z',
    updatedAt: '2026-11-23T00:00:00.000Z',
  }));
  const received: Array<Record<string, string>> = [];
  globalThis.fetch = async input => {
    const url = new URL(String(input), 'https://codexia.test');
    assert.equal(url.pathname, '/api/v1/persistence/projects/project-1/nodes');
    received.push(Object.fromEntries(url.searchParams));
    return url.searchParams.has('cursor')
      ? Response.json({ nodes: [nodes[1]], nextCursor: null, projectVersion: 18 })
      : Response.json({ nodes: [nodes[0]], nextCursor: cursor, projectVersion: 18 });
  };

  const first = await api.persistenceKnowledgePage('project-1', filters);
  assert.deepEqual(first, { nodes: [nodes[0]], nextCursor: cursor, projectVersion: 18 });
  assert.equal(first.nextCursor, cursor);
  const last = await api.persistenceKnowledgePage('project-1', { ...filters, cursor: first.nextCursor });
  assert.deepEqual(last, { nodes: [nodes[1]], nextCursor: null, projectVersion: 18 });
  assert.deepEqual(received, [
    { limit: '50', ...filters },
    { limit: '50', ...filters, cursor },
  ]);
});

test('Knowledge browse rejects responses without an explicit cursor and project version', async () => {
  const filters = { q: '', type: '', status: '' };
  for (const payload of [{ nodes: [] }, { nodes: [], nextCursor: null }, { nodes: [], projectVersion: 18 }]) {
    globalThis.fetch = async () => Response.json(payload);
    await assert.rejects(api.persistenceKnowledgePage('project-1', filters), invalid);
  }
});

test('complete workspace document reads cover 999 records and reject an ambiguous full page', async () => {
  const documents = Array.from({ length: 1000 }, (_, index) => ({
    id: `doc-${index}`,
    projectId: 'project-1',
    parentId: null,
    kind: 'scene',
    title: `Scene ${index}`,
    orderKey: String(index),
    headRevisionId: null,
    version: 1,
    createdAt: '2026-11-23T00:00:00.000Z',
    updatedAt: '2026-11-23T00:00:00.000Z',
  }));
  let count = 999;
  globalThis.fetch = async input => {
    assert.equal(String(input), '/api/v1/persistence/projects/project-1/documents?limit=1000');
    return Response.json({ documents: documents.slice(0, count) });
  };
  assert.equal((await api.persistenceDocuments('project-1')).documents.length, 999);
  count = 1000;
  await assert.rejects(
    api.persistenceDocuments('project-1'),
    (error: unknown) => error instanceof ApiError && error.code === 'SNAPSHOT_TOO_LARGE',
  );
});

test('Web append requests leave sibling order selection to the canonical persistence transaction', async () => {
  const document = {
    id: 'document-1',
    projectId: 'project-1',
    parentId: 'chapter-1',
    kind: 'scene',
    title: 'New scene',
    orderKey: '0000000011',
    headRevisionId: 'revision-1',
    version: 1,
    createdAt: '2026-11-20T00:00:00.000Z',
    updatedAt: '2026-11-20T00:00:00.000Z',
  };
  const revision = {
    id: 'revision-1',
    projectId: 'project-1',
    documentId: 'document-1',
    parentRevisionId: null,
    markdown: '',
    sha256: 'a'.repeat(64),
    authorId: 'author',
    createdAt: '2026-11-20T00:00:00.000Z',
  };
  globalThis.fetch = async (input, init) => {
    assert.equal(String(input), '/api/v1/persistence/projects/project-1/documents');
    assert.deepEqual(JSON.parse(String(init?.body)), {
      kind: 'scene',
      title: 'New scene',
      parentId: 'chapter-1',
      markdown: '',
      orderKey: '0000000005',
      appendToEnd: true,
    });
    assert.equal(new Headers(init?.headers).get('Idempotency-Key'), 'append-idempotency-key');
    return Response.json({ document, revision, replayed: false });
  };
  const created = await api.createPersistenceDocument('project-1', {
    kind: 'scene',
    title: 'New scene',
    parentId: 'chapter-1' as import('@codexia/persistence-contracts').DocumentId,
    markdown: '',
    orderKey: '0000000005',
    appendToEnd: true,
    idempotencyKey: 'append-idempotency-key',
  });
  assert.equal(created.document.orderKey, '0000000011');
});
