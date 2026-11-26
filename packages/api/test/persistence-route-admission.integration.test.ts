import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { type TestContext, test } from 'node:test';
import type { KnowledgeNodeId, KnowledgeRelationId, ProjectId } from '@codexia/persistence-contracts';
import { createPostgresPersistence } from '@codexia/persistence-postgres';
import { startBetterAuthFixture } from './fixtures/better-auth-server.js';

async function startAuthorApi(t: TestContext) {
  const databaseUrl = process.env.CODEXIA_AUTH_TEST_DATABASE_URL;
  assert.ok(databaseUrl, 'CODEXIA_AUTH_TEST_DATABASE_URL must name an explicitly disposable PostgreSQL auth database');
  const fixture = await startBetterAuthFixture({ databaseUrl, usePostgresPersistence: true });
  t.after(() => fixture.close());
  const persistence = createPostgresPersistence(databaseUrl);
  t.after(() => persistence.close());
  const base = fixture.apiOrigin;
  const ownerHeaders = {
    Authorization: `Bearer ${await fixture.issueOwnerAccessToken()}`,
    'Content-Type': 'application/json',
  };
  return { base, ownerHeaders, persistence };
}

test('PostgreSQL API admits only authenticated declared persistence methods and paths', async t => {
  const { base, ownerHeaders, persistence } = await startAuthorApi(t);
  const candidateProjectId = randomUUID() as ProjectId;

  const unauthorizedUnknownPath = await fetch(`${base}/api/v1/persistence/not-a-route`);
  assert.equal(unauthorizedUnknownPath.status, 404, 'unknown paths are rejected before credential validation');
  assert.equal(((await unauthorizedUnknownPath.json()) as { code: string }).code, 'NOT_FOUND');

  const unauthorizedWrongMethod = await fetch(`${base}/api/v1/persistence/projects`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: candidateProjectId, title: 'must not be created' }),
  });
  assert.equal(unauthorizedWrongMethod.status, 405, 'the registered template rejects this method before processing credentials or body');
  assert.equal(((await unauthorizedWrongMethod.json()) as { code: string }).code, 'METHOD_NOT_ALLOWED');

  const wrongMethod = await fetch(`${base}/api/v1/persistence/projects`, {
    method: 'PUT',
    headers: ownerHeaders,
    body: JSON.stringify({ id: candidateProjectId, title: 'must not be created' }),
  });
  assert.equal(wrongMethod.status, 405);
  assert.equal(((await wrongMethod.json()) as { code: string }).code, 'METHOD_NOT_ALLOWED');
  assert.ok(
    !(await persistence.read(reader => reader.getProject(candidateProjectId))),
    'a rejected method must not persist the candidate project',
  );

  const unknownPath = await fetch(`${base}/api/v1/persistence/not-a-route`, { headers: ownerHeaders });
  assert.equal(unknownPath.status, 404);
  assert.equal(((await unknownPath.json()) as { code: string }).code, 'NOT_FOUND');
});

test('PostgreSQL document list honors the requested project version', async t => {
  const { base, ownerHeaders, persistence } = await startAuthorApi(t);
  const project = await persistence.transaction(tx => tx.createProject({ title: 'Versioned document list' }));
  const documentsUrl = `${base}/api/v1/persistence/projects/${project.id}/documents`;
  const pinnedUrl = `${documentsUrl}?parentId=root&limit=1&projectVersion=${project.version}`;
  const pinned = await fetch(pinnedUrl, { headers: ownerHeaders });
  assert.equal(pinned.status, 200);
  assert.deepEqual(await pinned.json(), { documents: [] });

  const created = await fetch(documentsUrl, {
    method: 'POST',
    headers: { ...ownerHeaders, 'Idempotency-Key': randomUUID() },
    body: JSON.stringify({ kind: 'scene', title: 'New scene', markdown: '' }),
  });
  assert.equal(created.status, 201);
  const { document } = (await created.json()) as { document: { id: string } };

  const stale = await fetch(pinnedUrl, { headers: ownerHeaders });
  assert.equal(stale.status, 409);
  assert.equal(((await stale.json()) as { code: string }).code, 'SNAPSHOT_UNAVAILABLE');

  const current = await fetch(documentsUrl, { headers: ownerHeaders });
  assert.equal(current.status, 200);
  assert.deepEqual(
    ((await current.json()) as { documents: { id: string }[] }).documents.map(row => row.id),
    [document.id],
  );

  const invalid = await fetch(`${documentsUrl}?projectVersion=0`, { headers: ownerHeaders });
  assert.equal(invalid.status, 400);
});

test('PostgreSQL project pagination accepts documented bounds and returned cursors', async t => {
  const { base, ownerHeaders, persistence } = await startAuthorApi(t);
  await persistence.transaction(async tx => {
    for (let index = 0; index < 201; index += 1) {
      await tx.createProject({ title: `Pagination ${index}` });
    }
  });
  const projectsUrl = `${base}/api/v1/persistence/projects`;
  const oneResponse = await fetch(`${projectsUrl}?limit=1`, { headers: ownerHeaders });
  assert.equal(oneResponse.status, 200);
  const onePage = (await oneResponse.json()) as { projects: { id: string }[]; nextCursor: string | null };
  assert.equal(onePage.projects.length, 1);

  const twoHundredResponse = await fetch(`${projectsUrl}?limit=200`, { headers: ownerHeaders });
  assert.equal(twoHundredResponse.status, 200);
  const twoHundredPage = (await twoHundredResponse.json()) as { projects: { id: string }[]; nextCursor: string | null };
  assert.equal(twoHundredPage.projects.length, 200);

  const defaultResponse = await fetch(projectsUrl, { headers: ownerHeaders });
  assert.equal(defaultResponse.status, 200);
  const defaultPage = (await defaultResponse.json()) as { projects: { id: string }[]; nextCursor: string | null };
  assert.equal(defaultPage.projects.length, 200, 'omitted limit uses the documented default of 200');
  assert.deepEqual(
    defaultPage.projects.map(project => project.id),
    twoHundredPage.projects.map(project => project.id),
  );

  assert.ok(onePage.nextCursor, 'two or more projects produce a continuation cursor');
  const nextPageResponse = await fetch(`${projectsUrl}?limit=1&cursor=${encodeURIComponent(onePage.nextCursor)}`, {
    headers: ownerHeaders,
  });
  assert.equal(nextPageResponse.status, 200);
  const nextPage = (await nextPageResponse.json()) as { projects: { id: string }[]; nextCursor: string | null };
  assert.equal(nextPage.projects.length, 1);
  assert.notEqual(nextPage.projects[0]?.id, onePage.projects[0]?.id, 'cursor advances without repeating the prior row');
  assert.ok(twoHundredPage.nextCursor);
  const remainderResponse = await fetch(`${projectsUrl}?limit=200&cursor=${encodeURIComponent(twoHundredPage.nextCursor)}`, {
    headers: ownerHeaders,
  });
  assert.equal(remainderResponse.status, 200);
  const remainder = (await remainderResponse.json()) as { projects: { id: string }[]; nextCursor: string | null };
  assert.ok(remainder.projects.length > 0, 'the next page contains rows beyond the 200-row boundary');
  const firstPageIds = new Set(twoHundredPage.projects.map(project => project.id));
  assert.ok(
    remainder.projects.every(project => !firstPageIds.has(project.id)),
    'continuation page does not repeat prior rows',
  );

  for (const query of ['limit=0', 'limit=201', 'cursor=']) {
    const response = await fetch(`${projectsUrl}?${query}`, { headers: ownerHeaders });
    assert.equal(response.status, 400, query);
    assert.equal(((await response.json()) as { code: string }).code, query.startsWith('cursor=') ? 'INVALID_CURSOR' : 'INVALID_QUERY');
  }
});

test('Knowledge merge reports missing entities and stale previews as declared client errors', async t => {
  const { base, ownerHeaders, persistence } = await startAuthorApi(t);
  const project = await persistence.transaction(tx => tx.createProject({ title: 'Merge rejection fixture' }));
  const sourceId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' as KnowledgeNodeId;
  const targetId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' as KnowledgeNodeId;
  const relatedId = randomUUID() as KnowledgeNodeId;
  const relationId = randomUUID() as KnowledgeRelationId;
  const missingId = randomUUID();
  await persistence.transaction(async tx => {
    for (const [id, name] of [
      [sourceId, 'Source'],
      [targetId, 'Target'],
      [relatedId, 'Related'],
    ] as const) {
      await tx.saveKnowledgeNode({
        projectId: project.id,
        id,
        name,
        type: 'lore',
        attributes: {},
        status: 'confirmed',
        expectedVersion: null,
      });
    }
    await tx.saveKnowledgeRelation({
      projectId: project.id,
      id: relationId,
      sourceId,
      targetId: relatedId,
      type: 'related',
      attributes: {},
      validity: {},
      status: 'confirmed',
      expectedVersion: null,
    });
  });
  const preview = (projectId: string, source: string, target: string) =>
    fetch(`${base}/api/v1/persistence/projects/${projectId}/nodes/${source}/merge-preview`, {
      method: 'POST',
      headers: ownerHeaders,
      body: JSON.stringify({ targetId: target }),
    });
  for (const [projectId, source, target, status, code] of [
    [randomUUID(), sourceId, targetId, 404, 'PERSISTENCE_NOT_FOUND'],
    [project.id, missingId, targetId, 404, 'PERSISTENCE_NOT_FOUND'],
    [project.id, sourceId, missingId, 404, 'PERSISTENCE_NOT_FOUND'],
    [project.id, sourceId, sourceId, 400, 'PERSISTENCE_VALIDATION'],
    [project.id, sourceId.toUpperCase(), sourceId, 400, 'PERSISTENCE_VALIDATION'],
    [project.id, '0', '0', 400, 'INVALID_ID'],
    [project.id, '0', targetId, 400, 'INVALID_ID'],
  ] as const) {
    const response = await preview(projectId, source, target);
    assert.equal(response.status, status);
    assert.equal(((await response.json()) as { code: string }).code, code);
  }
  const valid = await preview(project.id, sourceId, targetId);
  assert.equal(valid.status, 200);
  const { projectVersion, previewDigest } = (await valid.json()) as { projectVersion: number; previewDigest: string };
  const stale = await fetch(`${base}/api/v1/persistence/projects/${project.id}/nodes/${sourceId}/merge`, {
    method: 'POST',
    headers: ownerHeaders,
    body: JSON.stringify({
      targetId,
      confirm: true,
      projectVersion,
      previewDigest: previewDigest === '0'.repeat(64) ? '1'.repeat(64) : '0'.repeat(64),
    }),
  });
  assert.equal(stale.status, 409);
  assert.equal(((await stale.json()) as { code: string }).code, 'PERSISTENCE_CONFLICT');
  const source = await persistence.read(reader => reader.getKnowledgeNode(project.id, sourceId));
  assert.equal(source?.status, 'confirmed');

  const merged = await fetch(`${base}/api/v1/persistence/projects/${project.id}/nodes/${sourceId.toUpperCase()}/merge`, {
    method: 'POST',
    headers: ownerHeaders,
    body: JSON.stringify({ targetId: targetId.toUpperCase(), confirm: true, projectVersion, previewDigest }),
  });
  assert.equal(merged.status, 200);
  const targetRelations = await persistence.read(reader => reader.listKnowledgeRelations(project.id, targetId));
  assert.equal(targetRelations.find(relation => relation.id === relationId)?.sourceId, targetId);
});
