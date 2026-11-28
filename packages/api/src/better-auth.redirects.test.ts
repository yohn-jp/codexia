import assert from 'node:assert/strict';
import test from 'node:test';
import { assertBetterAuthClientRegistrations, type BetterAuthClientRegistry } from './better-auth.js';

const audience = 'https://codexia.example.test/api';
const ownerSubject = 'registered-owner';
const webCallback = 'https://codexia.example.test/desktop';
const iosCallback = 'jp.yohn.codexia:/oauth2redirect';
const introspectionCallback = 'https://codexia.example.test/oauth/introspection';

test('deployed Better Auth client verification rejects changed or extra OAuth callbacks', async () => {
  const expectedRedirectUris: Record<string, readonly string[]> = {
    'codexia-web': [webCallback],
    'codexia-ios': [iosCallback],
    'codexia-introspector': [introspectionCallback],
  };
  const config = {
    audience,
    ownerSubject,
    ownerClientIds: ['codexia-web', 'codexia-ios'],
    introspectionClientId: 'codexia-introspector',
    expectedRedirectUris,
  };
  const ownerClient = (redirectUris: readonly string[]): Record<string, unknown> => ({
    disabled: false,
    tokenEndpointAuthMethod: 'none',
    grantTypes: ['authorization_code', 'refresh_token'],
    responseTypes: ['code'],
    requirePKCE: true,
    scopes: ['openid', 'codexia:api'],
    redirectUris,
  });
  const clients: Record<string, Record<string, unknown>> = {
    'codexia-web': ownerClient([webCallback]),
    'codexia-ios': ownerClient([iosCallback]),
    'codexia-introspector': {
      disabled: false,
      tokenEndpointAuthMethod: 'client_secret_post',
      clientSecret: 'stored-hash',
      redirectUris: [introspectionCallback],
    },
  };
  const registry: BetterAuthClientRegistry = {
    async getOwner() {
      return { id: ownerSubject };
    },
    async getClient(clientId) {
      return clients[clientId] ?? null;
    },
    async getClientResources() {
      return [{ resourceId: audience }];
    },
  };
  await assertBetterAuthClientRegistrations(config, registry);
  for (const clientId of Object.keys(expectedRedirectUris)) {
    const client = clients[clientId];
    const approved = expectedRedirectUris[clientId];
    assert.ok(client && approved);
    client.redirectUris = ['https://codexia.example.test/stale-callback'];
    await assert.rejects(assertBetterAuthClientRegistrations(config, registry), /unexpected OAuth redirect URIs/u);
    client.redirectUris = [...approved, 'https://codexia.example.test/unapproved'];
    await assert.rejects(assertBetterAuthClientRegistrations(config, registry), /unexpected OAuth redirect URIs/u);
    client.redirectUris = [...approved];
  }
});
