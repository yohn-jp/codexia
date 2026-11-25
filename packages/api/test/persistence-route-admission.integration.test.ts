import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { type TestContext, test } from 'node:test';
import type { ProjectId } from '@codexia/persistence-contracts';
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
