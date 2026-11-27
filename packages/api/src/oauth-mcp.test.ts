import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID, sign as signJwt } from 'node:crypto';
import { test } from 'node:test';
import { createOAuthMcpAuthenticator, parseOAuthMcpProjectAssignments } from './oauth-mcp.js';

const issuer = 'https://api.codexia.example/api/auth';
const audience = 'https://api.codexia.example/api';
const signingKey = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const jwk = { ...signingKey.publicKey.export({ format: 'jwk' }), kid: 'mcp-access-key', alg: 'ES256', use: 'sig' };
const now = Math.floor(Date.now() / 1000);

function token(overrides: Record<string, unknown> = {}, typ = 'at+jwt'): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
  const unsigned =
    encode({ alg: 'ES256', typ, kid: jwk.kid }) +
    '.' +
    encode({
      iss: issuer,
      sub: 'internal-user-17',
      aud: audience,
      client_id: 'codexia-mcp-client',
      azp: 'codexia-mcp-client',
      scope: 'openid email mcp:read mcp:compute mcp:propose',
      iat: now,
      exp: now + 300,
      jti: randomUUID(),
      ...overrides,
    });
  const signature = signJwt('sha256', Buffer.from(unsigned, 'ascii'), {
    key: signingKey.privateKey,
    dsaEncoding: 'ieee-p1363',
  });
  return `${unsigned}.${signature.toString('base64url')}`;
}

function authenticator(options: { active?: boolean; allowedClientIds?: readonly string[]; online?: () => Promise<boolean> } = {}) {
  let activeChecks = 0;
  const allowedClientIds = options.allowedClientIds ?? ['codexia-mcp-client'];
  const verify = createOAuthMcpAuthenticator({
    issuer,
    audience,
    jwksUrl: 'https://api.codexia.example/api/auth/jwks',
    allowedClientIds,
    ownerClientIds: ['codexia-web', 'codexia-ios'],
    projectIdsByClient: Object.fromEntries(allowedClientIds.map(clientId => [clientId, ['project-1']])),
    ownerSubject: 'internal-user-17',
    verifyActiveToken: async () => {
      activeChecks += 1;
      return options.online ? options.online() : (options.active ?? true);
    },
    fetch: async input => {
      assert.equal(String(input), 'https://api.codexia.example/api/auth/jwks');
      return Response.json({ keys: [jwk] });
    },
  });
  return { verify, activeChecks: () => activeChecks };
}

test('verified MCP principal receives only the operation scopes granted by its token', async () => {
  const instance = authenticator();
  const principal = await instance.verify(token({ scope: 'openid email mcp:read' }));
  assert.deepEqual(principal, {
    kind: 'external-mcp',
    issuer,
    userId: 'internal-user-17',
    clientId: 'codexia-mcp-client',
    projectIds: ['project-1'],
    scopes: ['mcp:read'],
  });
  assert.deepEqual((await instance.verify(token())).scopes, ['mcp:read', 'mcp:compute', 'mcp:propose']);
  assert.equal(instance.activeChecks(), 2);
});

test('MCP admission requires a configured MCP client and rejects owner clients', async () => {
  const instance = authenticator({ allowedClientIds: ['another-mcp-client'] });
  await assert.rejects(instance.verify(token()), (error: unknown) => {
    assert.equal((error as { status?: unknown }).status, 403);
    assert.equal((error as { code?: unknown }).code, 'OAUTH_MCP_CLIENT_NOT_ALLOWED');
    return true;
  });
  assert.throws(() => authenticator({ allowedClientIds: ['codexia-web'] }), /allowlists must be disjoint/u);
});

test('[TEST-AUTH-003-001] MCP project assignments are required, exact, and reject malformed or duplicate mappings', () => {
  assert.throws(() => parseOAuthMcpProjectAssignments(undefined, ['codexia-mcp-client']), /is required/u);
  assert.deepEqual(parseOAuthMcpProjectAssignments('{"codexia-mcp-client":["project-1"]}', ['codexia-mcp-client']), {
    'codexia-mcp-client': ['project-1'],
  });
  for (const [raw, message] of [
    ['{"codexia-mcp-client":["project-1"],"codexia-mcp-client":["project-2"]}', /duplicate/u],
    ['{"another-client":["project-1"]}', /every configured/u],
    ['{"codexia-mcp-client":[]}', /non-empty/u],
    ['{"codexia-mcp-client":["project-1","project-1"]}', /unique/u],
    ['["project-1"]', /JSON object/u],
  ] as const) {
    assert.throws(() => parseOAuthMcpProjectAssignments(raw, ['codexia-mcp-client']), message);
  }
  assert.throws(
    () =>
      createOAuthMcpAuthenticator({
        issuer,
        audience,
        jwksUrl: 'https://api.codexia.example/api/auth/jwks',
        allowedClientIds: ['codexia-mcp-client'],
        ownerClientIds: ['codexia-web'],
        projectIdsByClient: {},
        ownerSubject: 'internal-user-17',
        verifyActiveToken: async () => true,
      }),
    /Every allowed OAuth MCP client/u,
  );
});

test('MCP principal stays bound to the explicitly configured internal user', async () => {
  const instance = authenticator();
  await assert.rejects(instance.verify(token({ sub: 'another-internal-user' })), (error: unknown) => {
    assert.equal((error as { status?: unknown }).status, 403);
    assert.equal((error as { code?: unknown }).code, 'OAUTH_MCP_SUBJECT_NOT_ALLOWED');
    return true;
  });
  assert.equal(instance.activeChecks(), 0);
});

test('MCP tokens cannot carry owner or unrecognized operational scopes', async () => {
  const instance = authenticator();
  await assert.rejects(instance.verify(token({ scope: 'openid mcp:read codexia:api' })), (error: unknown) => {
    assert.equal((error as { status?: unknown }).status, 403);
    assert.equal((error as { code?: unknown }).code, 'OAUTH_MCP_SCOPE_INVALID');
    return true;
  });
  await assert.rejects(instance.verify(token({ scope: 'openid mcp:approve mcp:apply' })), (error: unknown) => {
    assert.equal((error as { status?: unknown }).status, 403);
    assert.equal((error as { code?: unknown }).code, 'OAUTH_MCP_SCOPE_INVALID');
    return true;
  });
  await assert.rejects(instance.verify(token({ scope: 'openid email' })), (error: unknown) => {
    assert.equal((error as { status?: unknown }).status, 403);
    assert.equal((error as { code?: unknown }).code, 'OAUTH_MCP_SCOPE_INVALID');
    return true;
  });
  await assert.rejects(instance.verify(token({ scope: undefined, scp: 'mcp:read' })), (error: unknown) => {
    assert.equal((error as { code?: unknown }).code, 'OAUTH_MCP_SCOPE_INVALID');
    return true;
  });
});

test('MCP admission rejects an inactive token and fails closed on introspection outage', async () => {
  const inactive = authenticator({ active: false });
  await assert.rejects(inactive.verify(token()), (error: unknown) => {
    assert.equal((error as { status?: unknown }).status, 401);
    assert.equal((error as { code?: unknown }).code, 'OAUTH_TOKEN_INACTIVE');
    return true;
  });
  const unavailable = authenticator({
    online: async () => {
      throw new Error('offline');
    },
  });
  await assert.rejects(unavailable.verify(token()), (error: unknown) => {
    assert.equal((error as { status?: unknown }).status, 503);
    assert.equal((error as { code?: unknown }).code, 'OAUTH_TOKEN_STATUS_UNAVAILABLE');
    return true;
  });
});

test('MCP admission requires the strict access-token type, authorization party, and API audience', async () => {
  const instance = authenticator();
  for (const invalid of [
    token({}, 'JWT'),
    token({ azp: 'different-client' }),
    token({ aud: 'https://other.example/api' }),
    token({ iss: 'https://other.example/api/auth' }),
    token({ exp: now - 20 }),
  ]) {
    await assert.rejects(instance.verify(invalid), (error: unknown) => {
      assert.equal((error as { status?: unknown }).status, 401);
      assert.equal((error as { code?: unknown }).code, 'OAUTH_TOKEN_INVALID');
      return true;
    });
  }
});
