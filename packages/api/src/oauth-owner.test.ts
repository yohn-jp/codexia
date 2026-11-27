import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { CODEXIA_OWNER_SCOPE, createOAuthOwnerAuthenticator } from './oauth-owner.js';

test('owner OAuth distinguishes unavailable signing keys from unavailable token status', async () => {
  const issuer = 'https://codexia.example/api/auth';
  const audience = 'https://codexia.example/api';
  const ownerSubject = 'fixture-owner';
  const clientId = 'codexia-web';
  const { privateKey, publicKey } = await generateKeyPair('ES256');
  const keys = [await exportJWK(publicKey)];
  const token = await new SignJWT({ client_id: clientId, azp: clientId, scope: CODEXIA_OWNER_SCOPE })
    .setProtectedHeader({ alg: 'ES256', typ: 'at+jwt' })
    .setIssuer(issuer)
    .setAudience(audience)
    .setSubject(ownerSubject)
    .setIssuedAt()
    .setExpirationTime('5m')
    .setJti(randomUUID())
    .sign(privateKey);
  const options = {
    issuer,
    audience,
    jwksUrl: issuer + '/jwks',
    ownerSubject,
    requiredScopes: [CODEXIA_OWNER_SCOPE],
    allowedClientIds: [clientId],
    verifyActiveToken: async () => {
      throw new Error('Fixture introspection unavailable');
    },
  };

  const statusUnavailable = createOAuthOwnerAuthenticator({ ...options, fetch: async () => Response.json({ keys }) });
  await assert.rejects(statusUnavailable(token), { status: 503, code: 'OAUTH_TOKEN_STATUS_UNAVAILABLE' });

  const jwksUnavailable = createOAuthOwnerAuthenticator({ ...options, fetch: async () => new Response(null, { status: 503 }) });
  await assert.rejects(jwksUnavailable(token), { status: 503, code: 'OAUTH_JWKS_UNAVAILABLE' });
});
