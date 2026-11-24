import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { type TestContext, test } from 'node:test';
import Fastify, { type RouteHandlerMethod } from 'fastify';
import { parse } from 'yaml';
import { toFastifyRoutes } from '../src/fastify-schema.mjs';

const { routes, schemas } = toFastifyRoutes(parse(readFileSync(new URL('../openapi/codexia.openapi.yaml', import.meta.url), 'utf8')));

function registerBackupFixture(t: TestContext, method: 'PUT' | 'POST', url: string, handler: RouteHandlerMethod) {
  const route = routes.find(candidate => candidate.method === method && candidate.url === url);
  assert.ok(route, `missing generated route ${method} ${url}`);

  // Exercise generated wire schemas for target routes in an isolated Fastify app.
  const app = Fastify({ ajv: { customOptions: { coerceTypes: false, removeAdditional: false } } });
  t.after(() => app.close());
  for (const schema of schemas) app.addSchema(schema);
  app.route({ method: route.method, url: route.url, schema: route.schema, handler });
  return app;
}

test('generated backup draft schema requires If-Match and serializes the stale revision error', async t => {
  const url = '/api/console/backups/config/draft';
  const payload = {
    provider: 'aws-s3',
    region: 'ap-northeast-1',
    bucket: 'backup-example',
    prefix: 'codexia',
    credentialMode: 'operator-role',
    offVmPolicy: 'required',
  };
  const config = {
    provider: 'aws-s3',
    endpoint: null,
    region: payload.region,
    bucket: payload.bucket,
    prefix: payload.prefix,
    credentialConfigured: true,
    revision: 3,
  };
  const staleRevision = { error: 'The backup configuration revision changed', code: 'STALE_REVISION', details: { revision: 2 } };
  let calls = 0;
  const app = registerBackupFixture(t, 'PUT', url, async (request, reply) => {
    calls++;
    if (request.headers['if-match'] === '"1"') {
      return reply.code(412).send({ ...staleRevision, fixtureOnly: true });
    }
    assert.equal(request.headers['if-match'], '"2"');
    return reply.code(200).send(config);
  });

  const missing = await app.inject({ method: 'PUT', url, payload });
  assert.equal(missing.statusCode, 400, missing.payload);
  assert.equal(missing.json().code, 'FST_ERR_VALIDATION');
  assert.equal(calls, 0);

  const stale = await app.inject({ method: 'PUT', url, headers: { 'If-Match': '"1"' }, payload });
  assert.equal(stale.statusCode, 412, stale.payload);
  assert.deepEqual(stale.json(), staleRevision);

  const current = await app.inject({ method: 'PUT', url, headers: { 'If-Match': '"2"' }, payload });
  assert.equal(current.statusCode, 200, current.payload);
  assert.deepEqual(current.json(), config);
});

test('generated backup run schema requires Idempotency-Key and serializes the queued receipt', async t => {
  const url = '/api/console/backups/runs';
  const receipt = { runId: 'run-1', state: 'queued', createdAt: '2026-11-23T00:00:00.000Z' };
  let calls = 0;
  const app = registerBackupFixture(t, 'POST', url, async (request, reply) => {
    calls++;
    assert.equal(request.headers['idempotency-key'], 'backup-run-1');
    return reply.code(202).send({ ...receipt, fixtureOnly: true });
  });

  const missing = await app.inject({ method: 'POST', url, payload: {} });
  assert.equal(missing.statusCode, 400, missing.payload);
  assert.equal(missing.json().code, 'FST_ERR_VALIDATION');
  assert.equal(calls, 0);

  const accepted = await app.inject({
    method: 'POST',
    url,
    headers: { 'Idempotency-Key': 'backup-run-1' },
    payload: {},
  });
  assert.equal(accepted.statusCode, 202, accepted.payload);
  assert.deepEqual(accepted.json(), receipt);
});
