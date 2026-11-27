import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import type { Persistence, ProjectId } from '@codexia/persistence-contracts';
import { handlePersistenceOperation } from './persistence-routes.js';

test('persistence status reports database health and knowledge lists are bounded', async () => {
  const projectId = 'knowledge-project' as ProjectId;
  let requestedLimit = 0;
  const persistence = {
    async checkHealth() {
      throw new Error('database unavailable');
    },
    async read<T>(work: (reader: unknown) => Promise<T>) {
      return work({
        async getProject(selectedProjectId: ProjectId) {
          assert.equal(selectedProjectId, projectId);
          return { id: projectId, version: 1 };
        },
        async listKnowledgeNodes(selectedProjectId: ProjectId, limit: number) {
          assert.equal(selectedProjectId, projectId);
          requestedLimit = limit;
          return [];
        },
      });
    },
  } as unknown as Persistence;
  const base = {
    persistence,
    body: null,
    requestHeaders: {},
    async requireAuthor() {
      return 'author';
    },
  };

  const status = await handlePersistenceOperation('persistence_status_get', { ...base, params: {}, query: new URLSearchParams() });
  assert.equal(status?.status, 503);

  const nodes = await handlePersistenceOperation('persistence_nodes_get', {
    ...base,
    params: { projectId },
    query: new URLSearchParams(`limit=500`),
  });
  assert.equal(nodes?.status, 200);
  assert.deepEqual(nodes?.body, { nodes: [] });
  assert.equal(requestedLimit, 500);
  const overLimit = await handlePersistenceOperation('persistence_nodes_get', {
    ...base,
    params: { projectId },
    query: new URLSearchParams(`limit=501`),
  });
  assert.equal(overLimit?.status, 400);
});

test('[TEST-API-001-001] Knowledge browse returns a filter-bound page cursor and rejects stale project snapshots', async () => {
  const projectId = randomUUID() as ProjectId;
  const ids = [randomUUID(), randomUUID(), randomUUID()];
  let projectVersion = 7;
  const requested: Array<{ limit: number; after?: { name: string; id: string } }> = [];
  const requestedTypes: Array<string | undefined> = [];
  const persistence = {
    async read<T>(work: (reader: unknown) => Promise<T>) {
      return work({
        async getProject(selectedProjectId: ProjectId) {
          assert.equal(selectedProjectId, projectId);
          return { id: projectId, version: projectVersion };
        },
        async searchKnowledgeNodes(_selectedProjectId: ProjectId, search: { limit: number; after?: { name: string; id: string } }) {
          requested.push(search);
          requestedTypes.push((search as { type?: string }).type);
          const nodes = ids.map((id, index) => ({
            id,
            projectId,
            type: 'person',
            name: `Node ${index}`,
            attributes: {},
            status: 'confirmed',
            version: 1,
            deletedAt: null,
            createdAt: 'now',
            updatedAt: 'now',
          }));
          return nodes.slice(search.after ? 1 : 0, search.after ? 2 : 2);
        },
      });
    },
  } as unknown as Persistence;
  const base = {
    persistence,
    body: null,
    requestHeaders: {},
    async requireAuthor() {
      return 'author';
    },
  };
  const first = await handlePersistenceOperation('persistence_nodes_get', {
    ...base,
    params: { projectId },
    query: new URLSearchParams(`q=deep&limit=1`),
  });
  assert.equal(first?.status, 200);
  const firstBody = first?.body as { nodes: Array<{ id: string }>; nextCursor: string | null; projectVersion: number };
  assert.equal(firstBody.nodes.length, 1);
  assert.ok(firstBody.nextCursor);
  assert.equal(firstBody.projectVersion, 7);
  const second = await handlePersistenceOperation('persistence_nodes_get', {
    ...base,
    params: { projectId },
    query: new URLSearchParams(`q=deep&limit=1&cursor=${firstBody.nextCursor}`),
  });
  assert.equal(second?.status, 200);
  assert.deepEqual(requested[1]?.after, { name: 'Node 0', id: ids[0] });
  assert.equal((second.body as { nodes: Array<{ id: string }> }).nodes[0]?.id, ids[1]);
  const customType = await handlePersistenceOperation('persistence_nodes_get', {
    ...base,
    params: { projectId },
    query: new URLSearchParams(`type=creature%20kind`),
  });
  assert.equal(customType?.status, 200);
  assert.equal(requestedTypes.at(-1), 'creature kind');
  const mismatched = await handlePersistenceOperation('persistence_nodes_get', {
    ...base,
    params: { projectId },
    query: new URLSearchParams(`q=other&cursor=${firstBody.nextCursor}`),
  });
  assert.equal(mismatched?.status, 400);
  const mismatchedVersion = await handlePersistenceOperation('persistence_nodes_get', {
    ...base,
    params: { projectId },
    query: new URLSearchParams(`q=deep&projectVersion=6&cursor=${firstBody.nextCursor}`),
  });
  assert.equal(mismatchedVersion?.status, 400);
  const malformedCursor = Buffer.from(
    JSON.stringify({ projectId, version: 7, query: 'deep', type: '', status: '', name: 'Node', id: '00000000-0000--0000-000000000001' }),
  ).toString('base64url');
  const invalidId = await handlePersistenceOperation('persistence_nodes_get', {
    ...base,
    params: { projectId },
    query: new URLSearchParams(`q=deep&cursor=${malformedCursor}`),
  });
  assert.equal(invalidId?.status, 400);
  const tooLong = await handlePersistenceOperation('persistence_nodes_get', {
    ...base,
    params: { projectId },
    query: new URLSearchParams(`q=${'x'.repeat(129)}`),
  });
  assert.equal(tooLong?.status, 400);
  projectVersion += 1;
  const stale = await handlePersistenceOperation('persistence_nodes_get', {
    ...base,
    params: { projectId },
    query: new URLSearchParams(`q=deep&cursor=${firstBody.nextCursor}`),
  });
  assert.equal(stale?.status, 409);
});

test('persistence project page uses the bounded keyset reader and encodes continuation', async () => {
  const projects = [
    { id: '00000000-0000-4000-8000-000000000001' as ProjectId, title: 'One', updatedAt: '2026-01-01T00:00:00.000Z' },
    { id: '00000000-0000-4000-8000-000000000002' as ProjectId, title: 'Two', updatedAt: '2026-01-01T00:00:00.000Z' },
  ];
  const calls: unknown[] = [];
  const persistence = {
    async read<T>(work: (reader: unknown) => Promise<T>) {
      return work({
        async listProjectPage(limit: number, after?: unknown) {
          calls.push([limit, after]);
          return after ? [projects[1]] : projects;
        },
      });
    },
  } as unknown as Persistence;
  const result = await handlePersistenceOperation('persistence_projects_get', {
    persistence,
    params: {},
    query: new URLSearchParams(`limit=1`),
    body: null,
    requestHeaders: {},
    async requireAuthor() {
      return 'author';
    },
  });
  assert.equal(result?.status, 200);
  const { projects: firstPage, nextCursor: cursor } = result.body as { projects: unknown[]; nextCursor: string | null };
  assert.deepEqual(firstPage, [projects[0]]);
  assert.ok(cursor, 'lookahead must provide an opaque continuation');
  const next = await handlePersistenceOperation('persistence_projects_get', {
    persistence,
    params: {},
    query: new URLSearchParams(`limit=1&cursor=${encodeURIComponent(cursor)}`),
    body: null,
    requestHeaders: {},
    async requireAuthor() {
      return 'author';
    },
  });
  assert.deepEqual(next?.body, { projects: [projects[1]], nextCursor: null });
  assert.deepEqual(calls, [
    [2, undefined],
    [2, { updatedAt: projects[0]!.updatedAt, id: projects[0]!.id }],
  ]);
});

test('mention confirmation observes an overlapping edit that holds the project lock', async () => {
  const projectId = randomUUID() as ProjectId;
  const documentId = randomUUID();
  const anchorId = randomUUID();
  let anchorStatus = 'confirmed';
  let linkStatus = 'proposed';
  // A pending manuscript edit commits as soon as the confirming writer can
  // acquire the project lock. Reads before that point see the old revision.
  function acquireProjectLock() {
    anchorStatus = 'needs_review';
  }
  const persistence = {
    async transaction<T>(work: (tx: unknown) => Promise<T>) {
      return work({
        async assertProjectVersion(project: ProjectId) {
          assert.equal(project, projectId);
          acquireProjectLock();
        },
        async getEvidenceAnchor() {
          return { documentId, fromUtf16: 0, toUtf16: 3, status: anchorStatus };
        },
        async saveMentionLink(command: { status: string }) {
          acquireProjectLock();
          linkStatus = command.status;
          return { status: linkStatus };
        },
      });
    },
  } as unknown as Persistence;
  const result = await handlePersistenceOperation('persistence_anchor_mentions_post', {
    persistence,
    params: { projectId, documentId, anchorId },
    query: new URLSearchParams(),
    body: { nodeId: randomUUID(), status: 'confirmed' },
    requestHeaders: {},
    async requireAuthor() {
      return 'author';
    },
  });
  assert.equal(result?.status, 409);
  assert.equal((result.body as { code: string }).code, 'ANCHOR_REQUIRES_AUTHOR_CONFIRMATION');
  assert.equal(linkStatus, 'proposed');
});
