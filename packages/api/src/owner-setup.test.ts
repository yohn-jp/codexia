import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createOwnerSetupApp } from './owner-setup.js';

const origin = 'https://codexia.example.test';
const settings = {
  databaseUrl: 'postgres://fixture@localhost/codexia',
  publicOrigin: origin,
  authSecret: 'x'.repeat(32),
  oauthIntrospectionClientId: 'fixture-introspection',
  oauthIntrospectionClientSecret: 'y'.repeat(32),
  ownerClientIds: ['fixture-web', 'fixture-ios'],
};

test('setup-only Fastify admits only the narrow setup routes without leaking authentication or business data', async t => {
  const app = createOwnerSetupApp(settings, [origin + '/desktop/'], ['127.0.0.1']);
  t.after(() => app.close());
  for (const [method, url] of [
    ['GET', '/api/projects'],
    ['POST', '/mcp'],
    ['GET', '/api/auth/get-session'],
    ['POST', '/api/auth/sign-up/email'],
    ['POST', '/api/auth/codexia/owner-session'],
    ['POST', '/api/auth/oauth2/register'],
    ['GET', '/api/auth/passkey/list-user-passkeys'],
    ['OPTIONS', '/api/auth/codexia/setup/authorize'],
  ] as const) {
    const response = await app.inject({ method, url });
    assert.equal(response.statusCode, 403, url);
    assert.equal(response.headers['cache-control'], 'no-store');
  }
});

test('setup key admission rejects cross-origin, ambient API bearer, and non-JSON requests before connecting to PostgreSQL', async t => {
  const app = createOwnerSetupApp(settings, [origin + '/desktop/'], ['127.0.0.1']);
  t.after(() => app.close());
  for (const headers of [
    { 'content-type': 'application/json' },
    { origin: 'https://other.example.test', 'content-type': 'application/json' },
    { origin, 'content-type': 'application/json', authorization: 'Bearer ordinary-grant' },
    { origin, 'content-type': 'application/json', 'sec-fetch-site': 'same-site' },
    { origin, 'content-type': 'text/plain' },
  ]) {
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/codexia/setup/authorize',
      headers: { host: new URL(origin).host, 'x-forwarded-proto': 'https', ...headers },
      payload: '{"key":"fixture"}',
    });
    assert.equal(response.statusCode, 403);
  }
});

test('setup endpoints require TLS through the configured origin and reject query input', async t => {
  const app = createOwnerSetupApp(settings, [origin + '/desktop/'], ['10.89.0.1', '10.89.1.1']);
  t.after(() => app.close());
  const url = '/api/auth/codexia/setup/authorize';
  const headers = { host: new URL(origin).host, origin, 'content-type': 'application/json' };
  const payload = { key: '' };
  const insecure = await app.inject({ method: 'POST', url, headers, payload });
  assert.equal(insecure.statusCode, 403);
  const untrustedPeer = await app.inject({
    method: 'POST',
    url,
    remoteAddress: '192.0.2.10',
    headers: { ...headers, 'x-forwarded-proto': 'https' },
    payload,
  });
  assert.equal(untrustedPeer.statusCode, 403);
  const wrongHost = await app.inject({
    method: 'POST',
    url,
    remoteAddress: '10.89.0.1',
    headers: {
      ...headers,
      host: 'other.example.test',
      'x-forwarded-proto': 'https',
    },
    payload,
  });
  assert.equal(wrongHost.statusCode, 403);
  for (const remoteAddress of ['10.89.0.1', '::ffff:10.89.1.1']) {
    const invalid = await app.inject({
      method: 'POST',
      url,
      remoteAddress,
      headers: { ...headers, 'x-forwarded-proto': 'https' },
      payload,
    });
    assert.equal(invalid.statusCode, 400);
    assert.deepEqual(invalid.json(), { code: 'SETUP_KEY_INVALID' });
  }
  const query = await app.inject({
    method: 'POST',
    url: url + '?key=fixture',
    remoteAddress: '10.89.0.1',
    headers: { ...headers, 'x-forwarded-proto': 'https' },
    payload,
  });
  assert.equal(query.statusCode, 400);
  assert.deepEqual(query.json(), { code: 'SETUP_REQUEST_INVALID' });
});
