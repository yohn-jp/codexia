import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifySchema } from 'fastify';
import { parse } from 'yaml';
import { toFastifyRoutes } from '../src/fastify-schema.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const openapi = parse(readFileSync(path.join(packageRoot, 'openapi', 'codexia.openapi.yaml'), 'utf8'));
const { routes, schemas } = toFastifyRoutes(openapi);

test('generated Fastify schemas validate project creation and preserve actual persistence errors and headers', async t => {
  const app = Fastify();
  t.after(() => app.close());
  for (const schema of schemas) app.addSchema(schema);

  let createHandlerCalls = 0;
  let importHandlerCalls = 0;
  const project = {
    id: '00000000-0000-4000-8000-000000000001',
    title: 'A title',
    settings: {},
    version: 1,
    createdAt: '2026-11-23T00:00:00Z',
    updatedAt: '2026-11-23T00:00:00Z',
  };
  const importResult = { project, replayed: false, unresolvedAnchors: 0, omittedRecords: 0 };
  const createProject = routes.find(({ method, url }) => method === 'POST' && url === '/api/v1/persistence/projects');
  const persistenceStatus = routes.find(({ method, url }) => method === 'GET' && url === '/api/v1/persistence/status');
  const importRoute = routes.find(({ method, url }) => method === 'POST' && url === '/api/v1/persistence/import');
  assert.ok(createProject);
  assert.ok(persistenceStatus);
  assert.ok(importRoute);

  // Register all routes before the first inject; Fastify freezes route setup
  // once the instance starts processing requests.
  app.route({
    method: createProject.method,
    url: createProject.url,
    schema: createProject.schema as FastifySchema,
    handler: async (_request, reply) => {
      createHandlerCalls++;
      return reply.code(201).send({ project });
    },
  });
  app.route({
    method: persistenceStatus.method,
    url: persistenceStatus.url,
    schema: persistenceStatus.schema as FastifySchema,
    handler: async (_request, reply) =>
      reply.code(503).send({
        error: 'PostgreSQL persistence is not ready',
        code: 'PERSISTENCE_UNAVAILABLE',
      }),
  });
  app.route({
    method: importRoute.method,
    url: importRoute.url,
    schema: importRoute.schema as FastifySchema,
    handler: async (request, reply) => {
      importHandlerCalls++;
      assert.equal(request.headers.authorization, 'Bearer owner-token');
      assert.equal(request.headers['content-type'], 'application/json');
      assert.ok(request.headers['idempotency-key'] === undefined || request.headers['idempotency-key'] === 'import-1');
      return reply.code(201).send(importResult);
    },
  });

  const missingTitle = await app.inject({ method: 'POST', url: '/api/v1/persistence/projects', payload: {} });
  assert.equal(missingTitle.statusCode, 400);
  assert.equal(createHandlerCalls, 0, 'the generated schema must reject a missing title before dispatch');
  for (const title of ['   ', 'x'.repeat(257)]) {
    const invalidTitle = await app.inject({ method: 'POST', url: '/api/v1/persistence/projects', payload: { title } });
    assert.equal(invalidTitle.statusCode, 400, invalidTitle.payload);
    assert.equal(createHandlerCalls, 0, 'the generated schema must reject titles outside the runtime constraints');
  }

  const validProject = await app.inject({
    method: 'POST',
    url: '/api/v1/persistence/projects',
    payload: { title: 'A title' },
  });
  assert.equal(validProject.statusCode, 201, validProject.payload);
  assert.equal(validProject.json().project.title, 'A title');

  const unavailable = await app.inject({ method: 'GET', url: '/api/v1/persistence/status' });
  assert.equal(unavailable.statusCode, 503, unavailable.payload);
  assert.deepEqual(unavailable.json(), {
    error: 'PostgreSQL persistence is not ready',
    code: 'PERSISTENCE_UNAVAILABLE',
  });

  const importPayload = {
    format: 'codexia-work/v1', project: { title: project.title, settings: {} },
    documents: [], knowledge: { nodes: [], aliases: [], relations: [] },
    evidence: { anchors: [], mentions: [], assertions: [], assertionEvidence: [], unresolved: { anchors: [], mentions: [], assertionEvidence: [] } },
    moduleRecords: [], omittedRecords: [],
  };
  const missingImportKey = await app.inject({
    method: 'POST',
    url: '/api/v1/persistence/import',
    headers: { authorization: 'Bearer owner-token' },
    payload: importPayload,
  });
  assert.equal(missingImportKey.statusCode, 201, missingImportKey.payload);

  const imported = await app.inject({
    method: 'POST',
    url: '/api/v1/persistence/import',
    headers: {
      authorization: 'Bearer owner-token',
      'idempotency-key': 'import-1',
      'content-type': 'application/json',
    },
    payload: importPayload,
  });
  assert.equal(imported.statusCode, 201, imported.payload);
  assert.equal(importHandlerCalls, 2);
  assert.deepEqual(imported.json(), importResult);
});

test('generated Fastify document response schema preserves PostgreSQL DTOs and additive fields', async t => {
  const app = Fastify();
  t.after(() => app.close());
  for (const schema of schemas) app.addSchema(schema);

  const documentRoute = routes.find(
    ({ method, url }) => method === 'GET' && url === '/api/v1/persistence/projects/:projectId/documents/:documentId',
  );
  assert.ok(documentRoute);
  app.route({
    method: documentRoute.method,
    url: documentRoute.url,
    schema: documentRoute.schema as FastifySchema,
    handler: async () => ({
      document: {
        id: '00000000-0000-4000-8000-000000000002',
        projectId: '00000000-0000-4000-8000-000000000001',
        parentId: null,
        kind: 'chapter',
        title: 'Opening',
        orderKey: '0001',
        headRevisionId: '00000000-0000-4000-8000-000000000003',
        version: 1,
        createdAt: '2026-11-23T00:00:00Z',
        updatedAt: '2026-11-23T00:00:00Z',
        projectionMetadata: { generation: 1 },
      },
      revision: {
        id: '00000000-0000-4000-8000-000000000003',
        projectId: '00000000-0000-4000-8000-000000000001',
        documentId: '00000000-0000-4000-8000-000000000002',
        parentRevisionId: null,
        markdown: 'First page',
        sha256: 'a'.repeat(64),
        authorId: 'owner-1',
        createdAt: '2026-11-23T00:00:00Z',
        projectionMetadata: { source: 'postgres' },
      },
    }),
  });

  const response = await app.inject({ method: 'GET', url: '/api/v1/persistence/projects/00000000-0000-4000-8000-000000000001/documents/00000000-0000-4000-8000-000000000002' });
  assert.equal(response.statusCode, 200, response.payload);
  assert.equal(response.json().document.title, 'Opening');
  assert.deepEqual(response.json().document.projectionMetadata, { generation: 1 });
  assert.deepEqual(response.json().revision.projectionMetadata, { source: 'postgres' });
});

test('generated document listing validates limit and passes the persistence default and boundaries', async t => {
  const app = Fastify();
  t.after(() => app.close());
  for (const schema of schemas) app.addSchema(schema);

  const documentList = routes.find(({ method, url }) => method === 'GET' && url === '/api/v1/persistence/projects/:projectId/documents');
  assert.ok(documentList);
  assert.deepEqual(documentList.contentTypes['400'], ['application/json']);

  const acceptedLimits: number[] = [];
  app.route<{ Querystring: { limit: number } }>({
    method: documentList.method,
    url: documentList.url,
    schema: documentList.schema as FastifySchema,
    handler: async request => {
      acceptedLimits.push(request.query.limit);
      return { documents: [] };
    },
  });

  const url = '/api/v1/persistence/projects/00000000-0000-4000-8000-000000000001/documents';
  for (const query of ['', '?limit=1', '?limit=1000']) {
    const response = await app.inject({ method: 'GET', url: url + query });
    assert.equal(response.statusCode, 200, response.payload);
  }
  assert.deepEqual(acceptedLimits, [500, 1, 1000]);

  for (const limit of ['0', '1001', '1.5', 'invalid']) {
    const response = await app.inject({ method: 'GET', url: `${url}?limit=${limit}` });
    assert.equal(response.statusCode, 400, response.payload);
  }
  assert.deepEqual(acceptedLimits, [500, 1, 1000]);
});

test('generated anchor write responses preserve persisted evidence and reject incomplete output', async t => {
  const app = Fastify();
  t.after(() => app.close());
  for (const schema of schemas) app.addSchema(schema);

  const basePath = '/api/v1/persistence/projects/:projectId/documents/:documentId/anchors';
  const createAnchor = routes.find(({ method, url }) => method === 'POST' && url === basePath);
  const updateAnchor = routes.find(({ method, url }) => method === 'PATCH' && url === `${basePath}/:anchorId`);
  assert.ok(createAnchor);
  assert.ok(updateAnchor);

  const anchor = {
    id: '00000000-0000-4000-8000-000000000005',
    projectId: '00000000-0000-4000-8000-000000000001',
    documentId: '00000000-0000-4000-8000-000000000002',
    revisionId: '00000000-0000-4000-8000-000000000003',
    fromUtf16: 0,
    toUtf16: 2,
    quoteSha256: 'a'.repeat(64),
    status: 'confirmed',
    version: 1,
    createdAt: '2026-11-23T00:00:00Z',
    updatedAt: '2026-11-23T00:00:00Z',
    projectionMetadata: { generation: 1 },
  };
  const created = { anchor, quote: '引用', nodeId: null, authorId: 'owner-1' };
  app.route<{ Params: { documentId: string } }>({
    method: createAnchor.method,
    url: createAnchor.url,
    schema: createAnchor.schema as FastifySchema,
    handler: async (request, reply) =>
      reply
        .code(201)
        .send(request.params.documentId === '00000000-0000-4000-8000-000000000009' ? { ...created, anchor: { ...anchor, quoteSha256: undefined } } : created),
  });
  app.route({
    method: updateAnchor.method,
    url: updateAnchor.url,
    schema: updateAnchor.schema as FastifySchema,
    handler: async () => ({ ...anchor, version: 2 }),
  });

  const url = '/api/v1/persistence/projects/00000000-0000-4000-8000-000000000001/documents/00000000-0000-4000-8000-000000000002/anchors';
  const input = { revisionId: anchor.revisionId, fromUtf16: 0, toUtf16: 2, status: 'confirmed' };
  const creation = await app.inject({ method: 'POST', url, payload: input });
  assert.equal(creation.statusCode, 201, creation.payload);
  assert.deepEqual(creation.json(), created);

  const update = await app.inject({ method: 'PATCH', url: `${url}/00000000-0000-4000-8000-000000000005`, payload: { ...input, expectedVersion: 1 } });
  assert.equal(update.statusCode, 200, update.payload);
  assert.deepEqual(update.json(), { ...anchor, version: 2 });

  const incomplete = await app.inject({ method: 'POST', url: url.replace('00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000009'), payload: input });
  assert.equal(incomplete.statusCode, 500, incomplete.payload);
  assert.match(incomplete.json().message, /quoteSha256.*required/u);
});

test('generated readiness 503 schema accepts both runtime modes and rejects unrelated setup codes', async t => {
  const route = routes.find(({ method, url }) => method === 'GET' && url === '/health/ready');
  const liveRoute = routes.find(({ method, url }) => method === 'GET' && url === '/health/live');
  assert.ok(route);
  assert.ok(liveRoute);
  assert.deepEqual(liveRoute.responseHeaders['200']['cache-control'].schema.enum, ['no-store']);
  assert.equal(route.responseHeaders['503']['cache-control'].required, true);
  assert.deepEqual(route.responseHeaders['503']['cache-control'].schema.enum, ['no-store']);

  let body: Record<string, unknown> = { ok: false, persistenceReady: false, pendingRequests: 0 };
  const app = Fastify();
  t.after(() => app.close());
  for (const schema of schemas) app.addSchema(schema);
  app.route({
    method: route.method,
    url: route.url,
    schema: route.schema as FastifySchema,
    handler: async (_request, reply) => reply.code(503).header('Cache-Control', 'no-store').send(body),
  });

  const inheritedMode = await app.inject({ method: 'GET', url: route.url });
  assert.equal(inheritedMode.statusCode, 503, inheritedMode.payload);
  assert.deepEqual(inheritedMode.json(), { ok: false, persistenceReady: false, pendingRequests: 0 });

  body = { code: 'SETUP_UNAVAILABLE' };
  const setupMode = await app.inject({ method: 'GET', url: route.url });
  assert.equal(setupMode.statusCode, 503, setupMode.payload);
  assert.deepEqual(setupMode.json(), { code: 'SETUP_UNAVAILABLE' });

  body = { code: 'SETUP_ONLY' };
  const unrelatedSetupCode = await app.inject({ method: 'GET', url: route.url });
  assert.equal(unrelatedSetupCode.statusCode, 500, unrelatedSetupCode.payload);
});
