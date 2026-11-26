import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { type TestContext, test } from 'node:test';
import Fastify, { type RouteHandlerMethod } from 'fastify';
import { parse } from 'yaml';
import { toFastifyRoutes } from '../src/fastify-schema.mjs';

const { routes, schemas } = toFastifyRoutes(parse(readFileSync(new URL('../openapi/codexia.openapi.yaml', import.meta.url), 'utf8')));
const inventory = JSON.parse(readFileSync(new URL('./fixtures/admitted-routes.json', import.meta.url), 'utf8')) as { current: string[] };
const persistenceRoutes = routes.filter(({ url }) => url.startsWith('/api/v1/persistence/'));
const projectsUrl = '/api/v1/persistence/projects';
const documentUrl = `${projectsUrl}/00000000-0000-4000-8000-000000000001/documents/00000000-0000-4000-8000-000000000002`;
const saveOperation = 'persistence_document_patch';

function createPersistenceFixture(t: TestContext, saveDocument?: RouteHandlerMethod) {
  // This isolated fixture exercises generated route schemas without the live dispatcher.
  const app = Fastify({
    exposeHeadRoutes: false,
    ajv: { customOptions: { coerceTypes: false, removeAdditional: false } },
  });
  t.after(() => app.close());
  for (const schema of schemas) app.addSchema(schema);
  for (const { method, url, operationId, schema } of persistenceRoutes) {
    app.route({
      method,
      url,
      schema,
      handler: operationId === saveOperation && saveDocument ? saveDocument : async (_request, reply) => reply.code(204).send(),
    });
  }
  return app;
}

test('generated persistence method/path pairs register as explicit Fastify routes', async t => {
  const app = createPersistenceFixture(t);
  await app.ready();

  const admitted = inventory.current.filter(operation => operation.includes(' /api/v1/persistence/'));
  const registered = persistenceRoutes.filter(({ method, url }) => app.hasRoute({ method, url }));
  assert.deepEqual(
    registered.map(({ method, url }) => `${method} ${url}`).sort(),
    admitted.map(operation => operation.replace(/\{([^{}]+)\}/gu, ':$1')).sort(),
  );

  for (const [method, url] of [
    ['HEAD', projectsUrl],
    ['PUT', documentUrl],
    ['GET', `${documentUrl}/unknown`],
  ] as const) {
    const response = await app.inject({ method, url });
    assert.equal(response.statusCode, 404, `${method} ${url}: ${response.payload}`);
  }
});

const saveBody = {
  baseRevisionId: '00000000-0000-4000-8000-000000000003',
  changes: [{ fromUtf16: 0, toUtf16: 0, insert: 'New draft' }],
  resultingSha256: 'a'.repeat(64),
};
const saveHeaders = { 'Idempotency-Key': 'save-1', 'X-Client-Id': 'editor-1' };

test('generated save schema rejects malformed input before invoking the handler', async t => {
  let calls = 0;
  const app = createPersistenceFixture(t, async (_request, reply) => {
    calls++;
    return reply.code(204).send();
  });

  for (const { reason, headers, payload } of [
    { reason: 'missing idempotency key', headers: { 'X-Client-Id': 'editor-1' }, payload: saveBody },
    { reason: 'string offset', headers: saveHeaders, payload: { ...saveBody, changes: [{ fromUtf16: '0', toUtf16: 0, insert: 'Draft' }] } },
    {
      reason: 'extra change property',
      headers: saveHeaders,
      payload: { ...saveBody, changes: [{ ...saveBody.changes[0], unexpected: true }] },
    },
  ]) {
    const response = await app.inject({ method: 'PATCH', url: documentUrl, headers, payload });
    assert.equal(response.statusCode, 400, `${reason}: ${response.payload}`);
    assert.equal(response.json().code, 'FST_ERR_VALIDATION', reason);
  }
  assert.equal(calls, 0);
});

test('generated save responses serialize the receipt and both conflict variants by status', async t => {
  const createdAt = '2026-11-23T00:00:00.000Z';
  const document = {
    id: '00000000-0000-4000-8000-000000000002',
    projectId: '00000000-0000-4000-8000-000000000001',
    parentId: null,
    kind: 'chapter',
    title: 'Opening',
    orderKey: '0001',
    headRevisionId: '00000000-0000-4000-8000-000000000004',
    version: 2,
    createdAt,
    updatedAt: createdAt,
    projectionMetadata: { generation: 2 },
  };
  const revision = {
    id: '00000000-0000-4000-8000-000000000004',
    projectId: '00000000-0000-4000-8000-000000000001',
    documentId: '00000000-0000-4000-8000-000000000002',
    parentRevisionId: '00000000-0000-4000-8000-000000000003',
    markdown: 'New draft',
    sha256: saveBody.resultingSha256,
    authorId: 'owner-1',
    createdAt,
  };
  const receipt = { document, revision, replayed: false };
  const conflict = {
    error: 'The document revision changed',
    code: 'PERSISTENCE_CONFLICT',
    details: { currentRevisionId: document.headRevisionId },
    current: { document, revision },
  };
  const idempotencyConflict = {
    error: 'The save key identifies another operation',
    code: 'IDEMPOTENCY_CONFLICT',
  };
  const app = createPersistenceFixture(t, async (request, reply) => {
    assert.deepEqual({ ...(request.params as Record<string, string>) }, { projectId: document.projectId, documentId: document.id });
    assert.equal(request.headers['idempotency-key'], saveHeaders['Idempotency-Key']);
    assert.equal(request.headers['x-client-id'], saveHeaders['X-Client-Id']);
    const { baseRevisionId } = request.body as typeof saveBody;
    if (baseRevisionId === '00000000-0000-4000-8000-000000000006') return reply.code(409).send(conflict);
    if (baseRevisionId === '00000000-0000-4000-8000-000000000007') return reply.code(409).send(idempotencyConflict);
    if (baseRevisionId === '00000000-0000-4000-8000-000000000008') return reply.code(409).send({ ...conflict, fixtureOnly: true });
    return reply.code(200).send({ ...receipt, fixtureOnly: true });
  });

  const saved = await app.inject({ method: 'PATCH', url: documentUrl, headers: saveHeaders, payload: saveBody });
  assert.equal(saved.statusCode, 200, saved.payload);
  assert.deepEqual(saved.json(), receipt);

  const stale = await app.inject({
    method: 'PATCH',
    url: documentUrl,
    headers: saveHeaders,
    payload: { ...saveBody, baseRevisionId: '00000000-0000-4000-8000-000000000006' },
  });
  assert.equal(stale.statusCode, 409, stale.payload);
  assert.deepEqual(stale.json(), conflict);

  const reusedKey = await app.inject({
    method: 'PATCH',
    url: documentUrl,
    headers: saveHeaders,
    payload: { ...saveBody, baseRevisionId: '00000000-0000-4000-8000-000000000007' },
  });
  assert.equal(reusedKey.statusCode, 409, reusedKey.payload);
  assert.deepEqual(reusedKey.json(), idempotencyConflict);

  const unexpectedField = await app.inject({
    method: 'PATCH',
    url: documentUrl,
    headers: saveHeaders,
    payload: { ...saveBody, baseRevisionId: '00000000-0000-4000-8000-000000000008' },
  });
  assert.equal(unexpectedField.statusCode, 500);
});
