import assert from 'node:assert/strict';
import test from 'node:test';
import { expectedDomainRejection } from './semantic-preconditions.mjs';

const base = { params: {}, query: '', headers: {}, body: null };
test('cursor preflight does not classify valid input as a rejection', async () => {
  const operation = 'GET /api/v1/persistence/projects';
  assert.equal((await expectedDomainRejection({ ...base, operation, query: 'cursor=' })).code, 'INVALID_CURSOR');
  const cursor = Buffer.from(JSON.stringify({ updatedAt: '2026-11-20T00:00:00.000Z', id: '00000000-0000-4000-8000-000000000001' })).toString('base64url');
  assert.equal(await expectedDomainRejection({ ...base, operation, query: 'cursor=' + cursor }), null);
});
test('duplicate archive graph identity is semantic; malformed shape is not', async () => {
  const operation = 'POST /api/v1/persistence/import';
  const archive = {
    format: 'codexia-work/v1', project: { title: 'Fixture', settings: {} }, documents: [],
    knowledge: { nodes: [], aliases: [], relations: [] },
    evidence: { anchors: [], mentions: [], assertions: [], assertionEvidence: [], unresolved: { anchors: [], mentions: [], assertionEvidence: [] } },
    moduleRecords: [], omittedRecords: [],
  };
  const record = { moduleId: 'fixture', key: 'duplicate', value: {} };
  assert.equal(await expectedDomainRejection({ ...base, operation, body: archive }), null);
  assert.equal((await expectedDomainRejection({ ...base, operation, body: { ...archive, moduleRecords: [record, record] } })).error, 'Duplicate module record identity');
  assert.equal(await expectedDomainRejection({ ...base, operation, body: {} }), null);
});
test('conditional save identity is mandatory, but either valid source is sufficient', async () => {
  const operation = 'PATCH /api/v1/persistence/projects/{projectId}/documents/{documentId}';
  assert.equal((await expectedDomainRejection({ ...base, operation, body: {} })).code, 'INVALID_BODY');
  assert.equal(await expectedDomainRejection({ ...base, operation, body: { clientId: 'fixture' } }), null);
  assert.equal(await expectedDomainRejection({ ...base, operation, headers: { 'x-client-id': 'fixture' }, body: {} }), null);
  assert.equal(await expectedDomainRejection({ ...base, operation: 'GET /api/v1/persistence/status' }), null);
});
