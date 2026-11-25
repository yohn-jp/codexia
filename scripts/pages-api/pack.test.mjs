import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import { prepareOpenApi, removeRemoteScalarFontFaces, renderSecuritySchemes } from './pack.mjs';

const YAML = createRequire(new URL('../../packages/http-contract/package.json', import.meta.url))('yaml');
const admitted = {
  current: ['GET /health/live'],
  target: ['GET /api/console/backups/status', 'POST /api/auth/codexia/setup/authorize'],
};

function source(overrides = {}) {
  const document = {
    openapi: '3.1.0',
    servers: [{ url: 'https://api.codexia.example' }],
    paths: {
      '/api/console/backups/status': {
        get: {
          operationId: 'backup_status_get',
          'x-codexia-contract-status': 'target',
          'x-codexia-principal': 'OWNER-SESSION',
          'x-codexia-security-deviation': 'Bearer baseline differs from owner-session cookie authority',
          'x-codexia-validation-status': 'PENDING: no exact runtime-schema binding',
          responses: { '200': { description: 'Status' } },
        },
      },
      '/api/auth/codexia/setup/authorize': {
        post: {
          operationId: 'setup_authorize_post',
          security: [{ BearerAuth: [] }],
          requestBody: { content: { 'application/json': { schema: { type: 'object' }, example: { setupKey: 'private-example' } } } },
          responses: { '403': { description: 'Forbidden' }, '404': { description: 'Not found' }, '429': { description: 'Too many requests' } },
          'x-codexia-runtime-response-deviation': 'The runtime reader returns a reduced 404 error body.',
        },
      },
      '/health/live': { get: { operationId: 'live_health_get', responses: { '200': { description: 'Alive' } } } },
    },
    components: {
      securitySchemes: { BearerAuth: { type: 'http', scheme: 'bearer' } },
      schemas: { PersistenceAnchor: { type: 'object', 'x-codexia-validation-status': 'Runtime requires revisionId and UTF-16 offsets.' } },
    },
    ...overrides,
  };
  return YAML.stringify(document);
}

test('publishes auth schemes and errors with per-operation state and no server or auth examples', () => {
  const prepared = prepareOpenApi(source(), admitted);
  const output = prepared.document;
  assert.equal(output.servers, undefined);
  const auth = output.paths['/api/auth/codexia/setup/authorize'].post;
  assert.equal(auth.requestBody.content['application/json'].example, undefined);
  assert.deepEqual(auth.security, [{ BearerAuth: [] }]);
  assert.equal(auth.responses['403'].description, 'Forbidden');
  assert.equal(auth.responses['404'].description, 'Not found');
  assert.equal(auth.responses['429'].description, 'Too many requests');
  assert.equal(auth['x-codexia-pages-status'].routeState, 'target');
  assert.equal(output.paths['/api/console/backups/status'].get['x-codexia-pages-status'].routeState, 'target');
  assert.equal(output.paths['/health/live'].get['x-codexia-pages-status'].routeState, 'current');
  assert.match(output.paths['/health/live'].get.description, /Fastify registration uses the generated route and schema inventory/u);
  assert.match(output.paths['/health/live'].get.description, /does not establish full contract conformance/u);
  assert.match(auth.description, /no current runtime implementation is claimed/u);
  assert.match(auth.description, /does not assert behavioral verification/u);
  assert.match(auth.description, /Runtime response deviation:[\s\S]*reduced 404 error body/u);
  assert.match(output.components.schemas.PersistenceAnchor.description, /Runtime validation evidence:[\s\S]*incomplete/u);
  assert.ok(output.components.securitySchemes.BearerAuth);
  const targetDescription = output.paths['/api/console/backups/status'].get.description;
  assert.match(targetDescription, /Declared principal/u);
  assert.match(targetDescription, /Bearer baseline differs from owner-session cookie authority/u);
  assert.match(targetDescription, /evidence is incomplete and is not an implementation claim/u);
  assert.ok(!prepared.sanitizedContract.toString('utf8').includes('api.codexia.example'));
  assert.ok(!prepared.sanitizedContract.toString('utf8').includes('private-example'));
});

test('rejects any operation missing from the source-bound current and target inventory', () => {
  const openapi = YAML.parse(source());
  openapi.paths['/api/unadmitted'] = { get: { operationId: 'unadmitted', responses: { '200': { description: 'OK' } } } };
  assert.throws(() => prepareOpenApi(YAML.stringify(openapi), admitted), /admitted route inventory/u);
});

test('rejects unexpected endpoint families and nonstandard path item fields', () => {
  const openapi = YAML.parse(source());
  openapi.paths = { '/admin/private': { get: { operationId: 'unadmitted', responses: { '200': { description: 'OK' } } } } };
  assert.throws(() => prepareOpenApi(YAML.stringify(openapi), { current: ['GET /admin/private'], target: [] }), /Unexpected route/u);
  const withField = YAML.parse(source());
  withField.paths['/health/live'].connect = { operationId: 'connect', responses: { '200': { description: 'OK' } } };
  assert.throws(() => prepareOpenApi(YAML.stringify(withField), admitted), /Unexpected OpenAPI path field connect/u);
});

test('rejects remote refs and credential-like values in non-auth schemas', () => {
  const remoteRef = YAML.parse(source());
  remoteRef.components.schemas = { Remote: { $ref: 'https://contracts.example/schema.yaml#/Secret' } };
  assert.throws(() => prepareOpenApi(YAML.stringify(remoteRef), admitted), /Non-local OpenAPI reference/u);
  const secret = YAML.parse(source());
  secret.components.schemas = { AuthHeader: { type: 'string', default: 'Bearer ' + 'a'.repeat(48) } };
  assert.throws(() => prepareOpenApi(YAML.stringify(secret), admitted), /Credential-like value/u);
});

test('removes Scalar CDN font faces from the self-hosted bundle and rejects changed asset policy', () => {
  const bundle = '@font-face { font-family: Inter; src: url(https://fonts.scalar.com/inter.woff2) format("woff2"); }' +
    '@font-face { font-family: Mono; src: url(https://fonts.scalar.com/mono.woff2) format("woff2"); }';
  const result = removeRemoteScalarFontFaces(bundle);
  assert.equal(result.removedFaces, 2);
  assert.equal(result.output, '');
  const unrelatedUrl = 'https://assets.example.test/fonts.scalar.com/readme';
  assert.equal(removeRemoteScalarFontFaces(bundle + unrelatedUrl).output, unrelatedUrl);
  assert.throws(() => removeRemoteScalarFontFaces(bundle + '//fonts.scalar.com/other.woff2'), /still references an external font host/u);
  assert.throws(() => removeRemoteScalarFontFaces('no external fonts here'), /asset structure changed/u);
});

test('shows public auth schemes as read-only documentation without credential controls', () => {
  const html = renderSecuritySchemes({
    BearerAuth: { type: 'http', scheme: 'Bearer' },
    ApiKeyAuth: { type: 'apiKey', in: 'cookie', name: '__Secure-session' },
  });
  assert.match(html, /BearerAuth[\s\S]*HTTP Bearer/u);
  assert.match(html, /ApiKeyAuth[\s\S]*cookie[\s\S]*__Secure-session/u);
  assert.doesNotMatch(html, /<input|<button|<form|Authorize/u);
  assert.throws(() => renderSecuritySchemes({}), /documentation is missing/u);
});
