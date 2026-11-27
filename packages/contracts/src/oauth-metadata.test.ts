import assert from 'node:assert/strict';
import test from 'node:test';
import { buildMcpProtectedResourceMetadata, createMcpProtectedResourceMetadataResponse, protectedResourceMetadataUrl } from './index.js';

test('protected-resource metadata URL follows RFC 9728 path construction for an API audience', () => {
  assert.equal(
    protectedResourceMetadataUrl('https://api.codexia.example/api'),
    'https://api.codexia.example/.well-known/oauth-protected-resource/api',
  );
  assert.equal(
    protectedResourceMetadataUrl('https://api.codexia.example/'),
    'https://api.codexia.example/.well-known/oauth-protected-resource',
  );
});

test('[TEST-EXT-002-001] public metadata publishes only the standalone MCP scope ceiling', async () => {
  const response = createMcpProtectedResourceMetadataResponse({
    resource: 'https://api.codexia.example/api',
    authorizationServer: 'https://identity.codexia.example/auth',
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /application\/json/u);
  assert.deepEqual(await response.json(), {
    resource: 'https://api.codexia.example/api',
    authorization_servers: ['https://identity.codexia.example/auth'],
    scopes_supported: ['mcp:read', 'mcp:compute', 'mcp:propose'],
    bearer_methods_supported: ['header'],
  });
});

test('metadata rejects insecure and ambiguous identifiers', () => {
  assert.throws(() => protectedResourceMetadataUrl('http://api.codexia.example/api'), /HTTPS/u);
  assert.throws(() => protectedResourceMetadataUrl('https://api.codexia.example/api?tenant=x'), /query/u);
  assert.throws(
    () =>
      buildMcpProtectedResourceMetadata({
        resource: 'https://api.codexia.example/api',
        authorizationServer: 'https://user:pass@api.codexia.example/api/auth',
      }),
    /credentials/u,
  );
});
