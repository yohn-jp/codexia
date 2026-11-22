import assert from 'node:assert/strict';
import test from 'node:test';
import { probePublicOAuthEdge } from './verify-public-oauth-edge.mjs';

const origin = 'https://api.codexia.example';
const resourceUrl = `${origin}/.well-known/oauth-protected-resource/api`;
const resourceMetadata = {
  resource: `${origin}/api`,
  authorization_servers: [`${origin}/api/auth`],
  scopes_supported: ['mcp:read', 'mcp:compute', 'mcp:propose'],
  bearer_methods_supported: ['header'],
};
const openIdConfiguration = {
  issuer: `${origin}/api/auth`,
  authorization_endpoint: `${origin}/api/auth/oauth2/authorize`,
  token_endpoint: `${origin}/api/auth/oauth2/token`,
  jwks_uri: `${origin}/api/auth/jwks`,
  code_challenge_methods_supported: ['S256'],
};
const authorizationServer = { ...openIdConfiguration };
const response = (body, status = 200, headers = {}) => new Response(body === null ? null : JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json', ...headers },
});

function fixtureFetch(overrides = {}) {
  const calls = [];
  const fetchImpl = async (input, init) => {
    const url = new URL(input);
    calls.push({ url, init });
    assert.equal(init.credentials, 'omit');
    assert.equal(init.redirect, 'manual');
    const headers = new Headers(init.headers);
    for (const name of ['authorization', 'cookie', 'cf-access-client-id', 'cf-access-client-secret', 'cf-access-jwt-assertion']) {
      assert.equal(headers.has(name), false, `public verification must not send ${name}`);
    }
    if (overrides[url.pathname]) return overrides[url.pathname](url, init);
    switch (url.pathname) {
      case '/.well-known/oauth-protected-resource/api': return response(resourceMetadata);
      case '/.well-known/oauth-authorization-server/api/auth': return response(authorizationServer);
      case '/.well-known/openid-configuration/api/auth': return response(openIdConfiguration);
      case '/api/auth/jwks': return response({ keys: [{ kid: 'public-key' }] });
      case '/mcp': return response({ error: 'UNAUTHORIZED' }, 401, {
        'www-authenticate': `Bearer resource_metadata="${resourceUrl}", scope="mcp:read mcp:compute mcp:propose"`,
      });
      case '/api/projects': return response({ error: 'UNAUTHORIZED' }, 401);
      case '/desktop': return response(null, 302, { location: 'https://team.cloudflareaccess.com/cdn-cgi/access/login/example' });
      default: return response({ error: 'not found' }, 404);
    }
  };
  return { calls, fetchImpl };
}

test('public OAuth edge probe checks protocol metadata, MCP challenge, API denial and retained UI Access', async () => {
  const { calls, fetchImpl } = fixtureFetch();
  const result = await probePublicOAuthEdge({ origin, fetchImpl });
  assert.deepEqual(result, {
    resource: `${origin}/api`,
    issuer: `${origin}/api/auth`,
    mcpUnauthorizedStatus: 401,
    protectedApiUnauthorizedStatus: 401,
    uiAccessBoundaryStatus: 302,
  });
  assert.deepEqual(calls.map(({ url, init }) => [url.pathname, init.method]), [
    ['/.well-known/oauth-protected-resource/api', 'GET'],
    ['/.well-known/oauth-authorization-server/api/auth', 'GET'],
    ['/.well-known/openid-configuration/api/auth', 'GET'],
    ['/api/auth/jwks', 'GET'],
    ['/mcp', 'GET'],
    ['/api/projects', 'GET'],
    ['/desktop', 'GET'],
  ]);
});

test('public OAuth metadata cannot be hidden behind an Access redirect or edge challenge', async () => {
  const { fetchImpl: redirected } = fixtureFetch({
    [ '/.well-known/oauth-protected-resource/api' ]: () => response(null, 302, { location: 'https://team.cloudflareaccess.com/cdn-cgi/access/login/example' }),
  });
  await assert.rejects(probePublicOAuthEdge({ origin, fetchImpl: redirected }), /Access redirect or edge challenge/u);

  const { fetchImpl: challenged } = fixtureFetch({
    [ '/.well-known/oauth-protected-resource/api' ]: () => response({ challenge: true }, 403, { 'cf-mitigated': 'challenge' }),
  });
  await assert.rejects(probePublicOAuthEdge({ origin, fetchImpl: challenged }), /interactive edge challenge/u);
});

test('public OAuth probe rejects incorrect resource metadata and missing MCP bearer challenge', async () => {
  const { fetchImpl: wrongResource } = fixtureFetch({
    [ '/.well-known/oauth-protected-resource/api' ]: () => response({ ...resourceMetadata, resource: `${origin}/` }),
  });
  await assert.rejects(probePublicOAuthEdge({ origin, fetchImpl: wrongResource }), /configured API audience/u);

  const { fetchImpl: missingChallenge } = fixtureFetch({
    '/mcp': () => response({ error: 'unauthorized' }, 401),
  });
  await assert.rejects(probePublicOAuthEdge({ origin, fetchImpl: missingChallenge }), /expected OAuth protected-resource challenge/u);
});

test('public OAuth probe rejects anonymous data access and a public UI entry', async () => {
  const { fetchImpl: openApi } = fixtureFetch({
    '/api/projects': () => response([{ id: 'project-1' }]),
  });
  await assert.rejects(probePublicOAuthEdge({ origin, fetchImpl: openApi }), /was not denied by API authentication/u);

  const { fetchImpl: openUi } = fixtureFetch({
    '/desktop': () => response({ public: true }),
  });
  await assert.rejects(probePublicOAuthEdge({ origin, fetchImpl: openUi }), /did not remain behind the static UI Access boundary/u);
});

test('public OAuth probe accepts only a bare HTTPS origin', async () => {
  const { fetchImpl } = fixtureFetch();
  await assert.rejects(probePublicOAuthEdge({ origin: 'http://api.codexia.example', fetchImpl }), /HTTPS origin/u);
  await assert.rejects(probePublicOAuthEdge({ origin: `${origin}/prefix`, fetchImpl }), /without credentials, path/u);
});
