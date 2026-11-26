import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { type TestContext, test } from 'node:test';
import type { KnowledgeNodeId, ProjectId } from '@codexia/persistence-contracts';
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

test('Knowledge merge reports missing entities and stale previews as declared client errors', async t => {
  const { base, ownerHeaders, persistence } = await startAuthorApi(t);
  const project = await persistence.transaction(tx => tx.createProject({ title: 'Merge rejection fixture' }));
  const sourceId = randomUUID() as KnowledgeNodeId;
  const targetId = randomUUID() as KnowledgeNodeId;
  const missingId = randomUUID();
  await persistence.transaction(async tx => {
    for (const [id, name] of [
      [sourceId, 'Source'],
      [targetId, 'Target'],
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
    [project.id, '0', targetId, 400, 'PERSISTENCE_VALIDATION'],
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
});
