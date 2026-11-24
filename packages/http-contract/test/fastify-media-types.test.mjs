import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import test from 'node:test';
import Fastify from 'fastify';
import { parse } from 'yaml';
import { toFastifyRoutes } from '../src/fastify-schema.mjs';

test('Fastify conversion rejects media dispatch it cannot enforce', () => {
  const json = 'application/json';
  const media = { schema: { type: 'object' } };
  const operation = {
    operationId: 'exchange_media',
    requestBody: { content: { [json]: media, 'text/plain': { schema: { type: 'string' } } } },
    responses: { 200: { description: 'Result' } },
  };
  const openapi = {
    openapi: '3.1.0',
    info: { version: '2.0.0' },
    'x-codexia-contract-status': 'complete',
    paths: { '/media': { post: operation } },
  };
  assert.throws(() => toFastifyRoutes(openapi), /multiple request media types require explicit content-type admission/u);

  delete operation.requestBody;
  for (const unsupported of ['application/*', 'application/json; charset=utf-8', 'Application/JSON']) {
    operation.responses[200].content = { [json]: media, [unsupported]: media };
    assert.throws(() => toFastifyRoutes(openapi), /canonical concrete content type/u);
  }
});

test('generated MCP response uses media-specific schemas and preserves the raw SSE stream', async t => {
  const openapi = parse(readFileSync(new URL('../openapi/codexia.openapi.yaml', import.meta.url), 'utf8'));
  const { routes, schemas } = toFastifyRoutes(openapi);
  const route = routes.find(({ method, url }) => method === 'GET' && url === '/mcp');
  assert.ok(route);

  const app = Fastify();
  t.after(() => app.close());
  for (const schema of schemas) app.addSchema(schema);

  const event = 'data: {"jsonrpc":"2.0","method":"notifications/initialized"}\n\n';
  const message = { jsonrpc: '2.0', id: 1, result: {} };
  app.route({
    method: route.method,
    url: route.url,
    schema: route.schema,
    handler(request, reply) {
      for (const mediaType of ['application/json', 'text/event-stream']) {
        assert.equal(typeof reply.getSerializationFunction(200, mediaType), 'function');
      }
      if (request.headers.accept === 'text/event-stream') {
        return reply.type('text/event-stream').send(Readable.from([event]));
      }
      return reply.type('application/json').send(message);
    },
  });

  const json = await app.inject({ method: 'GET', url: '/mcp', headers: { accept: 'application/json' } });
  assert.equal(json.statusCode, 200, json.body);
  assert.match(json.headers['content-type'], /^application\/json\b/u);
  assert.deepEqual(json.json(), message);

  const sse = await app.inject({ method: 'GET', url: '/mcp', headers: { accept: 'text/event-stream' } });
  assert.equal(sse.statusCode, 200, sse.body);
  assert.equal(sse.headers['content-type'], 'text/event-stream');
  assert.equal(sse.body, event);
});
