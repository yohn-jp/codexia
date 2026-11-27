import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { request as nodeHttpsRequest } from 'node:https';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { getCACertificates, setDefaultCACertificates } from 'node:tls';
import { assertDisposableAuthFixtureDatabaseUrl, startBetterAuthFixture } from './fixtures/better-auth-server.js';

async function apiRequest(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const url = new URL(input instanceof Request ? input.url : String(input));
  const headers = new Headers(init.headers);
  headers.set('connection', 'close');
  return new Promise((resolve, reject) => {
    const requestHeaders = Object.fromEntries(headers.entries());
    let body: string | Buffer | undefined;
    if (typeof init.body === 'string' || Buffer.isBuffer(init.body)) body = init.body;
    else if (init.body instanceof URLSearchParams) {
      body = init.body.toString();
      if (!headers.has('content-type')) requestHeaders['content-type'] = 'application/x-www-form-urlencoded';
    }
    const request = nodeHttpsRequest(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port,
        method: init.method ?? 'GET',
        path: `${url.pathname}${url.search}`,
        headers: requestHeaders,
      },
      response => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer | string) => chunks.push(Buffer.from(chunk)));
        response.on('error', reject);
        response.on('end', () => {
          const responseHeaders = new Headers();
          for (const [name, value] of Object.entries(response.headers)) {
            if (Array.isArray(value)) for (const item of value) responseHeaders.append(name, item);
            else if (value !== undefined) responseHeaders.set(name, value);
          }
          const body = Buffer.concat(chunks);
          resolve(new Response(body.length ? body : null, { status: response.statusCode ?? 500, headers: responseHeaders }));
        });
      },
    );
    request.on('error', reject);
    if (body !== undefined) request.write(body);
    request.end();
  });
}

test('Better Auth PKCE MCP client lists and invokes tools through central OAuth admission', async t => {
  const databaseUrl = process.env.CODEXIA_AUTH_TEST_DATABASE_URL;
  assert.equal(
    process.env.CODEXIA_AUTH_TEST_DISPOSABLE,
    '1',
    'CODEXIA_AUTH_TEST_DISPOSABLE=1 is required for the disposable auth database',
  );
  assert.ok(databaseUrl, 'CODEXIA_AUTH_TEST_DATABASE_URL must name an explicitly disposable PostgreSQL auth database');
  assert.throws(() => assertDisposableAuthFixtureDatabaseUrl('postgres://test:test@db.example.test/codexia_auth_test'), /disposable/u);
  assert.throws(() => assertDisposableAuthFixtureDatabaseUrl('postgres://test:test@127.0.0.1/codexia_auth'), /disposable/u);
  assert.doesNotThrow(() => assertDisposableAuthFixtureDatabaseUrl(databaseUrl));
  const callerNodeEnv = process.env.NODE_ENV;
  delete process.env.NODE_ENV;
  let closeFixture: (() => Promise<void>) | undefined;
  t.after(async () => {
    try {
      await closeFixture?.();
      assert.equal(Object.hasOwn(process.env, 'NODE_ENV'), false, 'the fixture restores an unset NODE_ENV');
    } finally {
      if (callerNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = callerNodeEnv;
    }
  });
  const mcpSource = (await import(new URL('../../../modules/mcp/src/index.ts', import.meta.url).href)) as {
    mcpManifest: { id: 'mcp' };
    createModule(context: unknown): Promise<unknown>;
  };
  const mcpRuntimeCache = await mkdtemp(join(tmpdir(), 'codexia-mcp-oauth-runtime-'));
  t.after(() => rm(mcpRuntimeCache, { recursive: true, force: true }));
  const fixture = await startBetterAuthFixture({
    databaseUrl,
    usePostgresPersistence: true,
    includeMcp: true,
    apiHostname: 'codexia-mcp-fixture.test',
    appProfile: {
      runtimeOptions: {
        manifests: [mcpSource.mcpManifest as never],
        enabled: ['mcp'],
        loaders: { mcp: mcpSource.createModule as never },
        cacheDirectory: mcpRuntimeCache,
      },
    },
    staticDirectory: new URL('../../app/dist', import.meta.url).pathname,
  });
  closeFixture = () => fixture.close();
  const priorTrustedCertificates = getCACertificates('default');
  setDefaultCACertificates([...priorTrustedCertificates, fixture.tlsCaCertificate!]);
  t.after(() => setDefaultCACertificates(priorTrustedCertificates));

  const origin = fixture.apiOrigin;
  const baseAuth = `${origin}/api/auth`;
  const cookieValues = new Map<string, string>();
  const rememberCookies = (response: Response) => {
    for (const line of response.headers.getSetCookie()) {
      const pair = line.split(';', 1)[0]!;
      const index = pair.indexOf('=');
      if (index > 0) cookieValues.set(pair.slice(0, index), pair.slice(index + 1));
    }
  };
  const cookieHeader = () => [...cookieValues].map(([key, value]) => `${key}=${value}`).join('; ');

  let discoveryResponse: Response;
  try {
    discoveryResponse = await apiRequest(`${origin}/.well-known/openid-configuration/api/auth`, {
      headers: { accept: 'application/json' },
    });
  } catch (error) {
    throw new Error('Fastify discovery request failed', { cause: error });
  }
  assert.equal(discoveryResponse.status, 200);
  const discovery = (await discoveryResponse.json()) as {
    issuer: string;
    authorization_endpoint: string;
    token_endpoint: string;
    jwks_uri: string;
    token_endpoint_auth_methods_supported: string[];
    code_challenge_methods_supported: string[];
  };
  assert.equal(discovery.issuer, fixture.issuer);
  assert.equal(discovery.authorization_endpoint, `${baseAuth}/oauth2/authorize`);
  assert.equal(discovery.token_endpoint, `${baseAuth}/oauth2/token`);
  assert.equal(discovery.jwks_uri, `${baseAuth}/jwks`);
  assert.ok(discovery.token_endpoint_auth_methods_supported.includes('none'));
  assert.deepEqual(discovery.code_challenge_methods_supported, ['S256']);
  const authorizationServerMetadataResponse = await apiRequest(`${origin}/.well-known/oauth-authorization-server/api/auth`, {
    headers: { accept: 'application/json' },
  });
  assert.equal(authorizationServerMetadataResponse.status, 200);
  const authorizationServerMetadata = (await authorizationServerMetadataResponse.json()) as {
    authorization_response_iss_parameter_supported?: boolean;
  };
  assert.equal(
    authorizationServerMetadata.authorization_response_iss_parameter_supported,
    true,
    'Better Auth must advertise RFC 9207 authorization response issuer identification',
  );

  assert.ok(
    fixture.mcpClientId && fixture.mcpProjectId && fixture.unassignedMcpProjectId,
    'the Better Auth fixture must register one MCP client and create assigned and unassigned projects',
  );
  const mcpCredential = await fixture.issueMcpAccessToken();
  assert.ok(mcpCredential.accessToken && mcpCredential.refreshToken, 'PKCE MCP authorization must issue access and refresh tokens');
  const refreshedMcpCredential = await fixture.refreshMcpAccessToken(mcpCredential.refreshToken);
  assert.ok(refreshedMcpCredential.accessToken, 'Better Auth must refresh the registered MCP grant');
  const moduleRequire = createRequire(new URL('../../../modules/mcp/package.json', import.meta.url));
  const mcpClientSdk = (await import(moduleRequire.resolve('@modelcontextprotocol/client'))) as {
    Client: new (
      info: { name: string; version: string },
      options: { versionNegotiation: { mode: { pin: string } } },
    ) => {
      connect(transport: unknown): Promise<void>;
      listTools(): Promise<{ tools: Array<{ name: string }> }>;
      callTool(request: {
        name: string;
        arguments: Record<string, unknown>;
      }): Promise<{ isError?: boolean; structuredContent?: Record<string, unknown> }>;
      close(): Promise<void>;
    };
    StreamableHTTPClientTransport: new (url: URL, options: { authProvider: { token(): Promise<string> } }) => { close(): Promise<void> };
  };
  const mcpTransport = new mcpClientSdk.StreamableHTTPClientTransport(
    new URL(`/mcp?projectId=${encodeURIComponent(fixture.mcpProjectId)}`, origin),
    {
      authProvider: { token: async () => refreshedMcpCredential.accessToken },
    },
  );
  const mcpClient = new mcpClientSdk.Client(
    { name: 'codexia-better-auth-integration', version: '1.0.0' },
    {
      versionNegotiation: { mode: { pin: '2026-07-28' } },
    },
  );
  try {
    await mcpClient.connect(mcpTransport);
    const tools = await mcpClient.listTools();
    assert.ok(tools.tools.some(tool => tool.name === 'discover_actions'));
    assert.ok(tools.tools.some(tool => tool.name === 'invoke_action'));
    const discovered = await mcpClient.callTool({ name: 'discover_actions', arguments: { project_id: fixture.mcpProjectId } });
    assert.notEqual(discovered.isError, true, JSON.stringify(discovered.structuredContent));
    const actionResult = await mcpClient.callTool({
      name: 'invoke_action',
      arguments: {
        project_id: fixture.mcpProjectId,
        action_id: 'core.status',
        input: {},
      },
    });
    assert.notEqual(actionResult.isError, true, JSON.stringify(actionResult.structuredContent));
    const payload = actionResult.structuredContent?.data as { projectId?: string } | undefined;
    assert.equal(payload?.projectId, fixture.mcpProjectId, 'the 2026 MCP tool call must execute against the selected PostgreSQL project');
    const unassignedProjectResult = await mcpClient.callTool({
      name: 'invoke_action',
      arguments: {
        project_id: fixture.unassignedMcpProjectId,
        action_id: 'core.status',
        input: {},
      },
    });
    assert.equal(
      unassignedProjectResult.isError,
      true,
      'the registered OAuth client must not use its assigned token on a different PostgreSQL project',
    );
  } finally {
    await mcpClient.close();
    await mcpTransport.close();
  }
  const mcpResource = `${origin}/mcp?projectId=${encodeURIComponent(fixture.mcpProjectId)}`;
  const mcpRevoke = await apiRequest(`${baseAuth}/oauth2/revoke`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: fixture.mcpClientId, token: mcpCredential.accessToken, token_type_hint: 'access_token' }),
  });
  assert.equal(mcpRevoke.status, 200, 'the registered MCP client can revoke its exact access token');
  assert.equal(
    (await apiRequest(mcpResource, { headers: { authorization: `Bearer ${mcpCredential.accessToken}` } })).status,
    401,
    'the exact revoked MCP access token is denied at central API admission',
  );
  assert.equal(
    (await apiRequest(mcpResource, { headers: { authorization: `Bearer ${refreshedMcpCredential.accessToken}` } })).status,
    405,
    'a refreshed sibling MCP token remains active and reaches the authenticated SDK method gate',
  );
  const ownerBearer = await fixture.issueOwnerAccessToken();
  assert.equal(
    (await apiRequest(mcpResource, { headers: { authorization: `Bearer ${ownerBearer}` } })).status,
    403,
    'owner OAuth tokens do not gain MCP client admission',
  );

  await t.test('ChangeSet decisions require an owner even on an MCP-assigned project', async () => {
    const projectPath = `${origin}/api/v1/persistence/projects/${fixture.mcpProjectId}`;
    const reviewHeaders = { authorization: `Bearer ${ownerBearer}`, origin, 'content-type': 'application/json' };
    const projectResponse = await apiRequest(projectPath, { headers: reviewHeaders });
    assert.equal(projectResponse.status, 200);
    const { project } = (await projectResponse.json()) as { project: { version: number } };
    const reviewNodeId = randomUUID();
    const proposalResponse = await apiRequest(`${projectPath}/changesets`, {
      method: 'POST',
      headers: { ...reviewHeaders, 'idempotency-key': randomUUID() },
      body: JSON.stringify({
        projectVersion: project.version,
        operations: [
          {
            type: 'knowledge.node.save',
            command: {
              projectId: fixture.mcpProjectId,
              id: reviewNodeId,
              type: 'person',
              name: 'Review candidate',
              attributes: {},
              status: 'proposed',
              expectedVersion: null,
            },
          },
        ],
      }),
    });
    assert.equal(proposalResponse.status, 201);
    type ReviewResult = { changeSet: { id: string; version: number; status: string }; receipt?: unknown };
    const { changeSet: proposed } = (await proposalResponse.json()) as ReviewResult;
    const changeSetPath = `${projectPath}/changesets/${proposed.id}`;
    const mcpReviewHeaders = { ...reviewHeaders, authorization: `Bearer ${refreshedMcpCredential.accessToken}` };
    const decide = (action: 'approve' | 'apply', version: number, headers: HeadersInit) =>
      apiRequest(`${changeSetPath}/${action}`, { method: 'POST', headers, body: JSON.stringify({ expectedVersion: version }) });

    const anonymousHeaders = { origin, 'content-type': 'application/json' };
    assert.equal((await decide('approve', proposed.version, anonymousHeaders)).status, 401);
    assert.equal((await decide('approve', proposed.version, mcpReviewHeaders)).status, 403);
    const approval = await decide('approve', proposed.version, reviewHeaders);
    assert.equal(approval.status, 200, 'the same proposal remains available for the owner to approve');
    const { changeSet: approved } = (await approval.json()) as ReviewResult;
    assert.equal((await decide('apply', approved.version, anonymousHeaders)).status, 401);
    assert.equal((await decide('apply', approved.version, mcpReviewHeaders)).status, 403);
    const detail = await apiRequest(changeSetPath, { headers: reviewHeaders });
    assert.equal(detail.status, 200);
    assert.deepEqual((await detail.json()) as ReviewResult, { changeSet: approved });
    const nodes = await apiRequest(`${projectPath}/nodes`, { headers: reviewHeaders });
    assert.equal(nodes.status, 200);
    assert.ok(!((await nodes.json()) as { nodes: { id: string }[] }).nodes.some(node => node.id === reviewNodeId));
  });

  const verifier = `fixture-${randomUUID()}-abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~`;
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const pendingResponse = await apiRequest(
    `${baseAuth}/oauth2/authorize?${new URLSearchParams({
      response_type: 'code',
      client_id: fixture.webClientId,
      redirect_uri: `${origin}/desktop`,
      scope: 'openid codexia:api offline_access',
      state: randomUUID(),
      code_challenge: challenge,
      code_challenge_method: 'S256',
      resource: fixture.audience,
    })}`,
    { redirect: 'manual', headers: { accept: 'application/json' } },
  );
  const pending = (await pendingResponse.json()) as { redirect?: boolean; url?: string };
  assert.equal(pending.redirect, true);
  assert.ok(pending.url);
  const loginPage = new URL(pending.url!, origin);
  assert.equal(loginPage.pathname, '/oauth/login');

  const previousWindow = (globalThis as unknown as { window?: unknown }).window;
  (globalThis as unknown as { window: { location: { search: string } } }).window = { location: { search: loginPage.search } };
  try {
    const { createAuthClient } = await import('better-auth/client');
    const { oauthProviderClient } = await import('@better-auth/oauth-provider/client');
    const client = createAuthClient({
      baseURL: baseAuth,
      plugins: [oauthProviderClient()],
      fetchOptions: {
        customFetchImpl: async (input: RequestInfo | URL, init?: RequestInit) => {
          const headers = new Headers(init?.headers);
          const cookie = cookieHeader();
          if (cookie) headers.set('cookie', cookie);
          headers.set('origin', origin);
          headers.set('connection', 'close');
          const response = await apiRequest(input, { ...init, headers, redirect: 'manual' });
          rememberCookies(response);
          return response;
        },
      },
    });

    const social = await client.signIn.social({
      provider: 'workspace-oidc',
      callbackURL: `${loginPage.pathname}${loginPage.search}`,
      requestSignUp: true,
      disableRedirect: true,
    });
    assert.ok(social.data?.url, `OIDC sign-in failed: ${JSON.stringify(social.error)}`);
    const upstreamAuthorize = new URL(social.data.url);
    assert.equal(upstreamAuthorize.searchParams.get('redirect_uri'), `${origin}/api/auth/callback/workspace-oidc`);
    const upstream = await fetch(social.data.url, { redirect: 'manual' });
    const callback = upstream.headers.get('location');
    assert.ok(callback, 'IdP authorization must return to the configured OIDC callback');
    const callbackResponse = await apiRequest(callback, { redirect: 'manual', headers: { cookie: cookieHeader() } });
    rememberCookies(callbackResponse);
    const resumedLocation = callbackResponse.headers.get('location');
    assert.ok(resumedLocation, 'OIDC callback must return to the login page');
    const resumedUrl = new URL(resumedLocation, origin);
    assert.equal(resumedUrl.pathname, '/oauth/login');
    assert.equal(resumedUrl.search, loginPage.search, 'the opaque signed authorization query must survive the provider round-trip');

    (globalThis as unknown as { window: { location: { search: string } } }).window.location.search = resumedUrl.search;
    const context = (await client.$fetch('/oauth2/consent-context', { method: 'POST', body: {} })) as {
      data?: { requestedScopes: string[]; client: { name: string }; redirectUri: string };
      error?: unknown;
    };
    assert.ok(context.data, `Fastify consent context failed: ${JSON.stringify(context.error)}`);
    assert.deepEqual(context.data.requestedScopes, ['openid', 'codexia:api', 'offline_access']);
    assert.equal(context.data.client.name, 'Codexia Web');
    assert.equal(
      context.data.redirectUri,
      new URLSearchParams(resumedUrl.search).get('redirect_uri'),
      'the server-verified consent context must bind the registered callback',
    );

    const consent = (await client.$fetch('/oauth2/consent', { method: 'POST', body: { accept: true } })) as {
      data?: { url: string };
      error?: unknown;
    };
    assert.ok(consent.data?.url, `OAuth consent failed: ${JSON.stringify(consent.error)}`);
    const redirect = new URL(consent.data.url, origin);
    const code = redirect.searchParams.get('code');
    assert.ok(code);
    assert.equal(redirect.searchParams.get('state'), new URLSearchParams(loginPage.search).get('state'));
    assert.equal(redirect.searchParams.get('iss'), fixture.issuer);

    const tokenResponse = await apiRequest(`${baseAuth}/oauth2/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', connection: 'close' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: fixture.webClientId,
        code,
        redirect_uri: `${origin}/desktop`,
        code_verifier: verifier,
        resource: fixture.audience,
      }),
    });
    const token = (await tokenResponse.json()) as Record<string, unknown>;
    assert.equal(tokenResponse.status, 200, JSON.stringify(token));
    assert.equal(token.token_type, 'Bearer');
    assert.equal(token.expires_in, 300);
    assert.equal(typeof token.refresh_token, 'string');
    assert.equal(typeof token.access_token, 'string');

    const accessToken = token.access_token as string;
    const consentListUrl = `${baseAuth}/oauth2/get-consents`;
    assert.equal((await apiRequest(consentListUrl)).status, 401);
    assert.equal((await apiRequest(consentListUrl, { headers: { authorization: `Bearer ${accessToken}` } })).status, 401);
    assert.equal(
      (await apiRequest(consentListUrl, { headers: { cookie: cookieHeader(), origin: 'https://untrusted.example' } })).status,
      403,
    );
    const consentList = await apiRequest(consentListUrl, { headers: { cookie: cookieHeader() } });
    assert.equal(consentList.status, 200);
    assert.equal(consentList.headers.get('cache-control'), 'no-store');
    const listedGrants = (await consentList.json()) as Array<{
      id: string;
      clientId: string;
      scopes: string[];
      createdAt: string;
      updatedAt: string;
    }>;
    const listedGrant = listedGrants.find(grant => grant.clientId === fixture.webClientId);
    assert.ok(listedGrant?.id);
    assert.deepEqual(Object.keys(listedGrant).sort(), ['clientId', 'createdAt', 'id', 'scopes', 'updatedAt']);
    assert.deepEqual(listedGrant.scopes, ['openid', 'codexia:api', 'offline_access']);
    for (const endpoint of ['update-consent', 'delete-consent']) {
      const mutation = await apiRequest(`${baseAuth}/oauth2/${endpoint}`, {
        method: 'POST',
        headers: { cookie: cookieHeader(), origin, 'content-type': 'application/json' },
        body: JSON.stringify({ id: listedGrant.id, update: { scopes: [] } }),
      });
      assert.equal(mutation.status, 404);
    }
    const header = JSON.parse(Buffer.from(accessToken.split('.')[0]!, 'base64url').toString('utf8')) as { typ: string; alg: string };
    const claims = JSON.parse(Buffer.from(accessToken.split('.')[1]!, 'base64url').toString('utf8')) as Record<string, unknown>;
    assert.equal(header.typ, 'at+jwt');
    assert.equal(header.alg, 'ES256');
    assert.equal(claims.iss, fixture.issuer);
    assert.ok((Array.isArray(claims.aud) ? claims.aud : [claims.aud]).includes(fixture.audience));
    assert.equal(claims.sub, fixture.ownerSubject);
    assert.equal(claims.client_id, fixture.webClientId);
    assert.equal(claims.azp, fixture.webClientId);
    assert.equal(typeof claims.jti, 'string');
    assert.equal(typeof claims.iat, 'number');
    assert.equal(typeof claims.exp, 'number');

    const apiSession = await apiRequest(`${origin}/api/session`, { headers: { authorization: `Bearer ${accessToken}` } });
    const apiSessionBody = await apiSession.json();
    assert.equal(apiSession.status, 200, JSON.stringify(apiSessionBody));
    assert.deepEqual(apiSessionBody, { authenticated: true, authorScope: 'owner' });

    const signingKeysBeforeRestart = await fixture.readSigningKeyIds();
    assert.ok(signingKeysBeforeRestart.length > 0, 'Better Auth must persist its signing key before the API restart');
    await fixture.restartApi();
    assert.deepEqual(
      (await fixture.readSigningKeyIds()).sort(),
      [...signingKeysBeforeRestart].sort(),
      'a new API runtime must reuse persisted Better Auth signing keys',
    );
    const restartedDiscovery = await apiRequest(`${origin}/.well-known/openid-configuration/api/auth`, {
      headers: { accept: 'application/json' },
    });
    assert.equal(restartedDiscovery.status, 200, 'OAuth discovery remains available after API restart');
    const restartedKeys = await apiRequest(`${baseAuth}/jwks`, { headers: { accept: 'application/json' } });
    const jwks = (await restartedKeys.json()) as { keys?: Array<{ kid?: string }> };
    assert.equal(restartedKeys.status, 200);
    assert.deepEqual(
      (jwks.keys ?? []).map(key => key.kid).sort(),
      signingKeysBeforeRestart.sort(),
      'the published JWKS still names the persisted signing keys',
    );
    const restartedSession = await apiRequest(`${origin}/api/session`, { headers: { authorization: `Bearer ${accessToken}` } });
    assert.equal(restartedSession.status, 200, 'an already issued API token remains connected after the API runtime restart');
    const restartedLoginSession = await apiRequest(`${baseAuth}/get-session`, { headers: { cookie: cookieHeader() } });
    assert.equal(restartedLoginSession.status, 200, 'the Better Auth login session remains available after the API runtime restart');

    const { session: currentSession } = (await restartedLoginSession.json()) as { session: { token: string } };
    assert.ok(currentSession?.token);
    const ownerHeaders = { cookie: cookieHeader(), origin };
    const sessions = await apiRequest(`${baseAuth}/list-sessions`, { headers: ownerHeaders });
    assert.equal(sessions.status, 200);
    assert.equal(sessions.headers.get('cache-control'), 'no-store');
    const listedSessions = (await sessions.json()) as Array<{ token: string; userId: string }>;
    assert.ok(listedSessions.some(({ token, userId }) => token === currentSession.token && userId === fixture.ownerSubject));
    assert.equal(
      (
        await apiRequest(`${baseAuth}/list-sessions`, {
          headers: { ...ownerHeaders, authorization: `Bearer ${accessToken}` },
        })
      ).status,
      403,
    );
    const missingWriteOrigin = await apiRequest(`${baseAuth}/revoke-other-sessions`, {
      method: 'POST',
      headers: { cookie: cookieHeader(), 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(missingWriteOrigin.status, 403);
    assert.equal((await missingWriteOrigin.json()).code, 'MISSING_OR_NULL_ORIGIN');
    const revokeCurrent = await apiRequest(`${baseAuth}/revoke-session`, {
      method: 'POST',
      headers: { ...ownerHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ token: currentSession.token }),
    });
    assert.equal(revokeCurrent.status, 403);
    assert.equal((await revokeCurrent.json()).code, 'OWNER_SECURITY_CURRENT_SESSION');
    const ownerPasskeys = await apiRequest(`${baseAuth}/passkey/list-user-passkeys`, { headers: ownerHeaders });
    assert.equal(ownerPasskeys.status, 200);
    assert.deepEqual(await ownerPasskeys.json(), []);
    assert.equal(
      (
        await apiRequest(`${baseAuth}/passkey/list-user-passkeys`, {
          headers: { ...ownerHeaders, 'sec-fetch-site': 'same-site' },
        })
      ).status,
      403,
    );
    const ownerIdentityResponse = await apiRequest(`${baseAuth}/codexia/owner-security/identity`, { headers: ownerHeaders });
    assert.equal(ownerIdentityResponse.status, 200);
    const ownerIdentity = (await ownerIdentityResponse.json()) as {
      provider: { status: string };
      clients: Array<{ clientId: string; name: string; redirectUris: string[]; disabled: boolean }>;
      consents: Array<{ id: string; clientId: string; scopes: string[]; revision: string }>;
    };
    assert.equal(ownerIdentity.provider.status, 'operator-configured-unverified');
    assert.ok(ownerIdentity.clients.some(client => client.clientId === fixture.webClientId));
    assert.ok(ownerIdentity.consents.some(consent => consent.clientId === fixture.webClientId));
    assert.doesNotMatch(JSON.stringify(ownerIdentity), /clientSecret|sensitive|fixture-introspector-secret/u);
    assert.equal(
      (
        await apiRequest(`${baseAuth}/codexia/owner-security/identity`, {
          headers: { ...ownerHeaders, origin: 'https://untrusted.example' },
        })
      ).status,
      403,
    );

    const refreshResponse = await apiRequest(`${baseAuth}/oauth2/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', connection: 'close' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: fixture.webClientId,
        refresh_token: String(token.refresh_token),
        resource: fixture.audience,
      }),
    });
    const refreshed = (await refreshResponse.json()) as Record<string, unknown>;
    assert.equal(refreshResponse.status, 200, JSON.stringify(refreshed));
    assert.notEqual(refreshed.refresh_token, token.refresh_token);
    assert.equal(refreshed.token_type, 'Bearer');

    const foreignRevoke = await apiRequest(`${baseAuth}/oauth2/revoke`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: fixture.foreignClientId, token: accessToken, token_type_hint: 'access_token' }),
    });
    assert.equal(foreignRevoke.status, 200, 'a foreign registered client receives the RFC 7009 success response');
    assert.equal(
      (await apiRequest(`${origin}/api/session`, { headers: { authorization: `Bearer ${accessToken}` } })).status,
      200,
      "a foreign client cannot revoke the token owner's jti",
    );
    assert.equal(
      await fixture.readRevocationRecord(claims.jti as string),
      null,
      'a foreign client cannot create a durable revocation record',
    );

    const unregisteredClientRevoke = await apiRequest(`${baseAuth}/oauth2/revoke`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: `unregistered-${randomUUID()}`, token: accessToken, token_type_hint: 'access_token' }),
    });
    const unregisteredClientError = (await unregisteredClientRevoke.json()) as { error?: string };
    assert.ok(
      unregisteredClientRevoke.status >= 400 && unregisteredClientRevoke.status < 500,
      'unregistered clients must still be rejected before revocation',
    );
    assert.equal(unregisteredClientError.error, 'invalid_client');

    const unknownRevoke = await apiRequest(`${baseAuth}/oauth2/revoke`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: fixture.webClientId, token: `unknown-${randomUUID()}`, token_type_hint: 'access_token' }),
    });
    assert.equal(unknownRevoke.status, 200, 'an unknown token receives the RFC 7009 success response');

    t.mock.timers.enable({ apis: ['Date'], now: ((claims.exp as number) + 1) * 1_000 });
    try {
      assert.equal(
        (await apiRequest(`${origin}/api/session`, { headers: { authorization: `Bearer ${accessToken}` } })).status,
        401,
        'an expired access token is denied by API admission',
      );
      const expiredRevoke = await apiRequest(`${baseAuth}/oauth2/revoke`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: fixture.webClientId, token: accessToken, token_type_hint: 'access_token' }),
      });
      assert.equal(expiredRevoke.status, 200, 'an expired token receives the RFC 7009 success response');
      assert.equal(
        await fixture.readRevocationRecord(claims.jti as string),
        null,
        'expired tokens must not create durable revocation records',
      );
    } finally {
      t.mock.timers.reset();
    }
    assert.equal(
      (await apiRequest(`${origin}/api/session`, { headers: { authorization: `Bearer ${accessToken}` } })).status,
      200,
      'an expired token is not accidentally persisted as a revocation after the clock returns',
    );

    const accessRevoke = await apiRequest(`${baseAuth}/oauth2/revoke`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: fixture.webClientId, token: accessToken, token_type_hint: 'access_token' }),
    });
    assert.equal(accessRevoke.status, 200, 'the registered owning client can revoke an individual JWT access token');
    assert.deepEqual(
      await fixture.readRevocationRecord(claims.jti as string),
      {
        issuer: fixture.issuer,
        jti: claims.jti,
        client_id: fixture.webClientId,
        subject: fixture.ownerSubject,
        session_id: typeof claims.sid === 'string' ? claims.sid : null,
        expires_at: new Date((claims.exp as number) * 1_000),
      },
      'revocation is durably bound to the exact issuer, jti, client, subject and session',
    );
    assert.equal(
      (await apiRequest(`${origin}/api/session`, { headers: { authorization: `Bearer ${accessToken}` } })).status,
      401,
      'the exact revoked jti is denied by API admission',
    );
    const revokedIntrospection = await apiRequest(`${baseAuth}/oauth2/introspect`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: fixture.introspectionClientId,
        client_secret: fixture.introspectionClientSecret,
        token: accessToken,
        token_type_hint: 'access_token',
      }),
    });
    assert.equal(revokedIntrospection.status, 200);
    assert.deepEqual(
      await revokedIntrospection.json(),
      { active: false },
      'OAuth introspection must report an individually revoked JWT as inactive',
    );
    const expiredRecordJti = `expired-${randomUUID()}`;
    await fixture.seedExpiredRevocationRecord(expiredRecordJti);
    assert.equal(await fixture.pruneExpiredRevocations(), 1, 'the maintenance prune removes only the expired record');
    assert.equal(await fixture.readRevocationRecord(expiredRecordJti), null, 'the expired revocation record is removed from PostgreSQL');
    assert.ok(await fixture.readRevocationRecord(claims.jti as string), 'the active revocation record remains in PostgreSQL');
    assert.equal(
      (await apiRequest(`${origin}/api/session`, { headers: { authorization: `Bearer ${accessToken}` } })).status,
      401,
      'the live revocation remains effective after expired-record pruning',
    );
    assert.equal(
      (await apiRequest(`${origin}/api/session`, { headers: { authorization: `Bearer ${String(refreshed.access_token)}` } })).status,
      200,
      'revoking one access token does not revoke a sibling token from the same session',
    );

    const refreshRevoke = await apiRequest(`${baseAuth}/oauth2/revoke`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: fixture.webClientId,
        token: String(refreshed.refresh_token),
        token_type_hint: 'refresh_token',
      }),
    });
    assert.equal(refreshRevoke.status, 200);
    const reusedRefresh = await apiRequest(`${baseAuth}/oauth2/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: fixture.webClientId,
        refresh_token: String(refreshed.refresh_token),
        resource: fixture.audience,
      }),
    });
    assert.equal(reusedRefresh.status, 400, 'revoked refresh token must not be reusable');

    const logout = await client.signOut();
    assert.equal(logout.error, null);
    const revokedSession = await apiRequest(`${origin}/api/session`, {
      headers: { authorization: `Bearer ${String(refreshed.access_token)}` },
    });
    assert.equal(revokedSession.status, 401);

    const ownerGrant = await fixture.issueOwnerOAuthTokens();
    const iosGrant = await fixture.issueIosOAuthTokens();
    const exchangePendingCode = await fixture.prepareOwnerAuthorizationCode();
    const ownerGrantHeaders = { authorization: `Bearer ${ownerGrant.accessToken}` };
    const iosGrantHeaders = { authorization: `Bearer ${iosGrant.accessToken}` };
    assert.equal((await apiRequest(`${origin}/api/session`, { headers: ownerGrantHeaders })).status, 200);
    assert.equal((await apiRequest(`${origin}/api/session`, { headers: iosGrantHeaders })).status, 200);

    const freshOwnerCookie = await fixture.createFreshOwnerSession();
    const ownerManagementHeaders = { cookie: freshOwnerCookie, origin };
    const readOwnerIdentity = async () => {
      const response = await apiRequest(`${baseAuth}/codexia/owner-security/identity`, { headers: ownerManagementHeaders });
      assert.equal(response.status, 200);
      return (await response.json()) as {
        consents: Array<{ id: string; clientId: string; scopes: string[]; revision: string }>;
      };
    };
    const grantSelection = async () => {
      const identity = await readOwnerIdentity();
      const grant = identity.consents.find(row => row.clientId === fixture.webClientId);
      assert.ok(grant, 'the owner can read their web OAuth grant');
      return { id: grant.id, clientId: grant.clientId, scopes: grant.scopes, revision: grant.revision };
    };
    const consentToWithdraw = await grantSelection();
    const revokeGrantUrl = `${baseAuth}/codexia/owner-security/revoke-consent`;
    const revokeGrantBody = JSON.stringify(consentToWithdraw);
    const missingGrantOrigin = await apiRequest(revokeGrantUrl, {
      method: 'POST',
      headers: { cookie: freshOwnerCookie, 'content-type': 'application/json' },
      body: revokeGrantBody,
    });
    assert.equal(missingGrantOrigin.status, 403, 'grant withdrawal requires a same-origin CSRF signal');
    const foreignGrantOrigin = await apiRequest(revokeGrantUrl, {
      method: 'POST',
      headers: { ...ownerManagementHeaders, origin: 'https://untrusted.example', 'content-type': 'application/json' },
      body: revokeGrantBody,
    });
    assert.equal(foreignGrantOrigin.status, 403, 'grant withdrawal rejects a foreign Origin');
    const bearerGrantRevoke = await apiRequest(revokeGrantUrl, {
      method: 'POST',
      headers: { ...ownerManagementHeaders, authorization: `Bearer ${ownerGrant.accessToken}`, 'content-type': 'application/json' },
      body: revokeGrantBody,
    });
    assert.equal(bearerGrantRevoke.status, 403, 'a bearer token cannot authorize browser grant management');
    assert.equal((await bearerGrantRevoke.json()).code, 'OWNER_SECURITY_COOKIE_REQUIRED');
    await fixture.ageOwnerSession();
    const staleGrantRevoke = await apiRequest(revokeGrantUrl, {
      method: 'POST',
      headers: { ...ownerManagementHeaders, 'content-type': 'application/json' },
      body: revokeGrantBody,
    });
    assert.equal(staleGrantRevoke.status, 403, 'grant withdrawal requires fresh owner reauthentication');
    assert.equal((await staleGrantRevoke.json()).code, 'OWNER_SECURITY_REAUTH_REQUIRED');
    assert.equal((await apiRequest(`${origin}/api/session`, { headers: ownerGrantHeaders })).status, 200);

    const reauthenticatedOwnerCookie = await fixture.createFreshOwnerSession();
    const reauthenticatedHeaders = { cookie: reauthenticatedOwnerCookie, origin };
    const refreshedSelection = await (async () => {
      const response = await apiRequest(`${baseAuth}/codexia/owner-security/identity`, { headers: reauthenticatedHeaders });
      assert.equal(response.status, 200);
      const identity = (await response.json()) as { consents: Array<{ id: string; clientId: string; scopes: string[]; revision: string }> };
      const row = identity.consents.find(grant => grant.clientId === fixture.webClientId);
      assert.ok(row);
      return { id: row.id, clientId: row.clientId, scopes: row.scopes, revision: row.revision };
    })();
    const withdrawn = await apiRequest(revokeGrantUrl, {
      method: 'POST',
      headers: { ...reauthenticatedHeaders, 'content-type': 'application/json' },
      body: JSON.stringify(refreshedSelection),
    });
    assert.equal(withdrawn.status, 200, JSON.stringify(await withdrawn.clone().json()));
    assert.deepEqual(await withdrawn.json(), { consentRemoved: true, grantRevoked: true });
    const postWithdrawalIdentity = await apiRequest(`${baseAuth}/codexia/owner-security/identity`, { headers: reauthenticatedHeaders });
    assert.equal(postWithdrawalIdentity.status, 200);
    const postWithdrawal = (await postWithdrawalIdentity.json()) as { consents: Array<{ clientId: string }> };
    assert.equal(
      postWithdrawal.consents.some(grant => grant.clientId === fixture.webClientId),
      false,
    );
    assert.equal(
      (await apiRequest(`${origin}/api/session`, { headers: ownerGrantHeaders })).status,
      401,
      'an already issued web JWT is denied at API admission after its owner withdraws consent',
    );
    const inactiveGrantIntrospection = await apiRequest(`${baseAuth}/oauth2/introspect`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: fixture.introspectionClientId,
        client_secret: fixture.introspectionClientSecret,
        token: ownerGrant.accessToken,
        token_type_hint: 'access_token',
      }),
    });
    assert.equal(inactiveGrantIntrospection.status, 200);
    assert.deepEqual(
      await inactiveGrantIntrospection.json(),
      { active: false },
      'the withdrawn grant is inactive through OAuth introspection as well as API admission',
    );
    const withdrawnRefresh = await apiRequest(`${baseAuth}/oauth2/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: fixture.webClientId,
        refresh_token: ownerGrant.refreshToken,
        resource: fixture.audience,
      }),
    });
    assert.equal(withdrawnRefresh.status, 400, 'a refresh token from the withdrawn owner grant cannot mint another access token');
    const withdrawnCode = await exchangePendingCode();
    assert.equal(withdrawnCode.status, 400, 'a code issued before withdrawal cannot mint a new grant');
    assert.equal((await withdrawnCode.json()).error, 'invalid_grant');
    assert.equal(
      (await apiRequest(`${origin}/api/session`, { headers: iosGrantHeaders })).status,
      200,
      'withdrawing the web grant leaves the owner’s separate iOS client grant active',
    );
    const iosRefresh = await apiRequest(`${baseAuth}/oauth2/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: fixture.iosClientId,
        refresh_token: iosGrant.refreshToken,
        resource: fixture.audience,
      }),
    });
    assert.equal(iosRefresh.status, 200, 'withdrawing the web grant leaves the iOS refresh-token family usable');
  } finally {
    if (previousWindow === undefined) delete (globalThis as unknown as { window?: unknown }).window;
    else (globalThis as unknown as { window: unknown }).window = previousWindow;
  }
});

test('Better Auth fixture teardown closes an active proxied response when the backend stops', async () => {
  const { createServer: createHttpServer } = await import('node:http');
  const { setTimeout: deadline } = await import('node:timers/promises');
  const databaseUrl = process.env.CODEXIA_AUTH_TEST_DATABASE_URL;
  assert.ok(databaseUrl, 'CODEXIA_AUTH_TEST_DATABASE_URL must name an explicitly disposable PostgreSQL auth database');
  const fixture = await startBetterAuthFixture({
    databaseUrl,
    createApiServer: () => {
      const server = createHttpServer((_, response) => {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.write('data: fixture-ready\n\n');
      });
      const close = server.close.bind(server);
      server.close = callback => {
        close(callback);
        server.closeAllConnections();
        return server;
      };
      return server;
    },
  });
  const request = new AbortController();
  let closing: Promise<void> | undefined;
  try {
    const response = await fetch(fixture.apiOrigin, { signal: request.signal });
    assert.equal(response.status, 200);
    const chunk = await response.body?.getReader().read();
    assert.equal(new TextDecoder().decode(chunk?.value), 'data: fixture-ready\n\n');
    closing = fixture.close();
    assert.equal(
      await Promise.race([closing.then(() => true), deadline(2_000, false, { ref: false })]),
      true,
      'fixture teardown waited for a client that had not yet been disposed',
    );
  } finally {
    request.abort();
    await (closing ?? fixture.close());
  }
});
