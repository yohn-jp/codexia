import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { request as nodeHttpRequest } from "node:http";
import { test } from "node:test";
import { assertDisposableAuthFixtureDatabaseUrl, startBetterAuthFixture } from "./fixtures/better-auth-server.js";

async function apiRequest(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const url = new URL(input instanceof Request ? input.url : String(input));
  const headers = new Headers(init.headers);
  headers.set("connection", "close");
  return new Promise((resolve, reject) => {
    const requestHeaders = Object.fromEntries(headers.entries());
    let body: string | Buffer | undefined;
    if (typeof init.body === "string" || Buffer.isBuffer(init.body)) body = init.body;
    else if (init.body instanceof URLSearchParams) {
      body = init.body.toString();
      if (!headers.has("content-type")) requestHeaders["content-type"] = "application/x-www-form-urlencoded";
    }
    const request = nodeHttpRequest({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port,
      method: init.method ?? "GET",
      path: `${url.pathname}${url.search}`,
      headers: requestHeaders,
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer | string) => chunks.push(Buffer.from(chunk)));
      response.on("error", reject);
      response.on("end", () => {
        const responseHeaders = new Headers();
        for (const [name, value] of Object.entries(response.headers)) {
          if (Array.isArray(value)) for (const item of value) responseHeaders.append(name, item);
          else if (value !== undefined) responseHeaders.set(name, value);
        }
        const body = Buffer.concat(chunks);
        resolve(new Response(body.length ? body : null, { status: response.statusCode ?? 500, headers: responseHeaders }));
      });
    });
    request.on("error", reject);
    if (body !== undefined) request.write(body);
    request.end();
  });
}

test("Better Auth signed-out OIDC login reaches the Fastify OAuth route and admits the configured owner", async (t) => {
  const databaseUrl = process.env.CODEXIA_AUTH_TEST_DATABASE_URL;
  assert.equal(process.env.CODEXIA_AUTH_TEST_DISPOSABLE, "1", "CODEXIA_AUTH_TEST_DISPOSABLE=1 is required for the disposable auth database");
  assert.ok(databaseUrl, "CODEXIA_AUTH_TEST_DATABASE_URL must name an explicitly disposable PostgreSQL auth database");
  assert.throws(() => assertDisposableAuthFixtureDatabaseUrl("postgres://test:test@db.example.test/codexia_auth_test"), /disposable/u);
  assert.throws(() => assertDisposableAuthFixtureDatabaseUrl("postgres://test:test@127.0.0.1/codexia_auth"), /disposable/u);
  assert.doesNotThrow(() => assertDisposableAuthFixtureDatabaseUrl(databaseUrl));
  const fixture = await startBetterAuthFixture({
    databaseUrl,
    staticDirectory: new URL("../../app/dist", import.meta.url).pathname,
  });
  t.after(() => fixture.close());

  const origin = fixture.apiOrigin;
  const baseAuth = `${origin}/api/auth`;
  const cookieValues = new Map<string, string>();
  const rememberCookies = (response: Response) => {
    for (const line of response.headers.getSetCookie()) {
      const pair = line.split(";", 1)[0]!;
      const index = pair.indexOf("=");
      if (index > 0) cookieValues.set(pair.slice(0, index), pair.slice(index + 1));
    }
  };
  const cookieHeader = () => [...cookieValues].map(([key, value]) => `${key}=${value}`).join("; ");

  let discoveryResponse: Response;
  try { discoveryResponse = await apiRequest(`${origin}/.well-known/openid-configuration/api/auth`, { headers: { accept: "application/json" } }); }
  catch (error) { throw new Error("Fastify discovery request failed", { cause: error }); }
  assert.equal(discoveryResponse.status, 200);
  const discovery = await discoveryResponse.json() as {
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
  assert.ok(discovery.token_endpoint_auth_methods_supported.includes("none"));
  assert.deepEqual(discovery.code_challenge_methods_supported, ["S256"]);

  const verifier = `fixture-${randomUUID()}-abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~`;
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const pendingResponse = await apiRequest(`${baseAuth}/oauth2/authorize?${new URLSearchParams({
    response_type: "code",
    client_id: fixture.webClientId,
    redirect_uri: `${origin}/desktop`,
    scope: "openid codexia:api offline_access",
    state: randomUUID(),
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: fixture.audience,
  })}`, { redirect: "manual", headers: { accept: "application/json" } });
  const pending = await pendingResponse.json() as { redirect?: boolean; url?: string };
  assert.equal(pending.redirect, true);
  assert.ok(pending.url);
  const loginPage = new URL(pending.url!, origin);
  assert.equal(loginPage.pathname, "/oauth/login");

  const previousWindow = (globalThis as unknown as { window?: unknown }).window;
  (globalThis as unknown as { window: { location: { search: string } } }).window = { location: { search: loginPage.search } };
  try {
    const { createAuthClient } = await import("better-auth/client");
    const { oauthProviderClient } = await import("@better-auth/oauth-provider/client");
    const client = createAuthClient({
      baseURL: baseAuth,
      plugins: [oauthProviderClient()],
      fetchOptions: {
        customFetchImpl: async (input: RequestInfo | URL, init?: RequestInit) => {
          const headers = new Headers(init?.headers);
          const cookie = cookieHeader();
          if (cookie) headers.set("cookie", cookie);
          headers.set("origin", origin);
          headers.set("connection", "close");
          const response = await apiRequest(input, { ...init, headers, redirect: "manual" });
          rememberCookies(response);
          return response;
        },
      },
    });

    const social = await client.signIn.social({
      provider: "workspace-oidc",
      callbackURL: `${loginPage.pathname}${loginPage.search}`,
      requestSignUp: true,
      disableRedirect: true,
    });
    assert.ok(social.data?.url, `OIDC sign-in failed: ${JSON.stringify(social.error)}`);
    const upstreamAuthorize = new URL(social.data.url);
    assert.equal(upstreamAuthorize.searchParams.get("redirect_uri"), `${origin}/api/auth/callback/workspace-oidc`);
    const upstream = await fetch(social.data.url, { redirect: "manual" });
    const callback = upstream.headers.get("location");
    assert.ok(callback, "IdP authorization must return to the configured OIDC callback");
    const callbackResponse = await apiRequest(callback, { redirect: "manual", headers: { cookie: cookieHeader() } });
    rememberCookies(callbackResponse);
    const resumedLocation = callbackResponse.headers.get("location");
    assert.ok(resumedLocation, "OIDC callback must return to the login page");
    const resumedUrl = new URL(resumedLocation, origin);
    assert.equal(resumedUrl.pathname, "/oauth/login");
    assert.equal(resumedUrl.search, loginPage.search, "the opaque signed authorization query must survive the provider round-trip");

    (globalThis as unknown as { window: { location: { search: string } } }).window.location.search = resumedUrl.search;
    const context = await client.$fetch("/oauth2/consent-context", { method: "POST", body: {} }) as {
      data?: { requestedScopes: string[]; client: { name: string }; redirectUri: string };
      error?: unknown;
    };
    assert.ok(context.data, `Fastify consent context failed: ${JSON.stringify(context.error)}`);
    assert.deepEqual(context.data.requestedScopes, ["openid", "codexia:api", "offline_access"]);
    assert.equal(context.data.client.name, "Codexia Web");
    assert.equal(context.data.redirectUri, new URLSearchParams(resumedUrl.search).get("redirect_uri"), "the server-verified consent context must bind the registered callback");

    const consent = await client.$fetch("/oauth2/consent", { method: "POST", body: { accept: true } }) as {
      data?: { url: string };
      error?: unknown;
    };
    assert.ok(consent.data?.url, `OAuth consent failed: ${JSON.stringify(consent.error)}`);
    const redirect = new URL(consent.data.url, origin);
    const code = redirect.searchParams.get("code");
    assert.ok(code);
    assert.equal(redirect.searchParams.get("state"), new URLSearchParams(loginPage.search).get("state"));
    assert.equal(redirect.searchParams.get("iss"), fixture.issuer);

    const tokenResponse = await apiRequest(`${baseAuth}/oauth2/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", connection: "close" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: fixture.webClientId,
        code,
        redirect_uri: `${origin}/desktop`,
        code_verifier: verifier,
        resource: fixture.audience,
      }),
    });
    const token = await tokenResponse.json() as Record<string, unknown>;
    assert.equal(tokenResponse.status, 200, JSON.stringify(token));
    assert.equal(token.token_type, "Bearer");
    assert.equal(token.expires_in, 300);
    assert.equal(typeof token.refresh_token, "string");
    assert.equal(typeof token.access_token, "string");

    const accessToken = token.access_token as string;
    const header = JSON.parse(Buffer.from(accessToken.split(".")[0]!, "base64url").toString("utf8")) as { typ: string; alg: string };
    const claims = JSON.parse(Buffer.from(accessToken.split(".")[1]!, "base64url").toString("utf8")) as Record<string, unknown>;
    assert.equal(header.typ, "at+jwt");
    assert.equal(header.alg, "ES256");
    assert.equal(claims.iss, fixture.issuer);
    assert.ok((Array.isArray(claims.aud) ? claims.aud : [claims.aud]).includes(fixture.audience));
    assert.equal(claims.sub, fixture.ownerSubject);
    assert.equal(claims.client_id, fixture.webClientId);
    assert.equal(claims.azp, fixture.webClientId);
    assert.equal(typeof claims.jti, "string");
    assert.equal(typeof claims.iat, "number");
    assert.equal(typeof claims.exp, "number");

    const apiSession = await apiRequest(`${origin}/api/session`, { headers: { authorization: `Bearer ${accessToken}` } });
    const apiSessionBody = await apiSession.json();
    assert.equal(apiSession.status, 200, JSON.stringify(apiSessionBody));
    assert.deepEqual(apiSessionBody, { authenticated: true, authorScope: "owner" });

    const signingKeysBeforeRestart = await fixture.readSigningKeyIds();
    assert.ok(signingKeysBeforeRestart.length > 0, "Better Auth must persist its signing key before the API restart");
    await fixture.restartApi();
    assert.deepEqual((await fixture.readSigningKeyIds()).sort(), [...signingKeysBeforeRestart].sort(),
      "a new API runtime must reuse persisted Better Auth signing keys");
    const restartedDiscovery = await apiRequest(`${origin}/.well-known/openid-configuration/api/auth`, { headers: { accept: "application/json" } });
    assert.equal(restartedDiscovery.status, 200, "OAuth discovery remains available after API restart");
    const restartedKeys = await apiRequest(`${baseAuth}/jwks`, { headers: { accept: "application/json" } });
    const jwks = await restartedKeys.json() as { keys?: Array<{ kid?: string }> };
    assert.equal(restartedKeys.status, 200);
    assert.deepEqual((jwks.keys ?? []).map((key) => key.kid).sort(), signingKeysBeforeRestart.sort(),
      "the published JWKS still names the persisted signing keys");
    const restartedSession = await apiRequest(`${origin}/api/session`, { headers: { authorization: `Bearer ${accessToken}` } });
    assert.equal(restartedSession.status, 200, "an already issued API token remains connected after the API runtime restart");
    const restartedLoginSession = await apiRequest(`${baseAuth}/get-session`, { headers: { cookie: cookieHeader() } });
    assert.equal(restartedLoginSession.status, 200, "the Better Auth login session remains available after the API runtime restart");

    const refreshResponse = await apiRequest(`${baseAuth}/oauth2/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", connection: "close" },
      body: new URLSearchParams({ grant_type: "refresh_token", client_id: fixture.webClientId, refresh_token: String(token.refresh_token), resource: fixture.audience }),
    });
    const refreshed = await refreshResponse.json() as Record<string, unknown>;
    assert.equal(refreshResponse.status, 200, JSON.stringify(refreshed));
    assert.notEqual(refreshed.refresh_token, token.refresh_token);
    assert.equal(refreshed.token_type, "Bearer");

    const foreignRevoke = await apiRequest(`${baseAuth}/oauth2/revoke`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: fixture.foreignClientId, token: accessToken, token_type_hint: "access_token" }),
    });
    assert.equal(foreignRevoke.status, 200, "a foreign registered client receives the RFC 7009 success response");
    assert.equal((await apiRequest(`${origin}/api/session`, { headers: { authorization: `Bearer ${accessToken}` } })).status, 200,
      "a foreign client cannot revoke the token owner's jti");
    assert.equal(await fixture.readRevocationRecord(claims.jti as string), null, "a foreign client cannot create a durable revocation record");

    const unregisteredClientRevoke = await apiRequest(`${baseAuth}/oauth2/revoke`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: `unregistered-${randomUUID()}`, token: accessToken, token_type_hint: "access_token" }),
    });
    const unregisteredClientError = await unregisteredClientRevoke.json() as { error?: string };
    assert.ok(unregisteredClientRevoke.status >= 400 && unregisteredClientRevoke.status < 500,
      "unregistered clients must still be rejected before revocation");
    assert.equal(unregisteredClientError.error, "invalid_client");

    const unknownRevoke = await apiRequest(`${baseAuth}/oauth2/revoke`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: fixture.webClientId, token: `unknown-${randomUUID()}`, token_type_hint: "access_token" }),
    });
    assert.equal(unknownRevoke.status, 200, "an unknown token receives the RFC 7009 success response");

    t.mock.timers.enable({ apis: ["Date"], now: ((claims.exp as number) + 1) * 1_000 });
    try {
      assert.equal((await apiRequest(`${origin}/api/session`, { headers: { authorization: `Bearer ${accessToken}` } })).status, 401,
        "an expired access token is denied by API admission");
      const expiredRevoke = await apiRequest(`${baseAuth}/oauth2/revoke`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id: fixture.webClientId, token: accessToken, token_type_hint: "access_token" }),
      });
      assert.equal(expiredRevoke.status, 200, "an expired token receives the RFC 7009 success response");
      assert.equal(await fixture.readRevocationRecord(claims.jti as string), null, "expired tokens must not create durable revocation records");
    } finally {
      t.mock.timers.reset();
    }
    assert.equal((await apiRequest(`${origin}/api/session`, { headers: { authorization: `Bearer ${accessToken}` } })).status, 200,
      "an expired token is not accidentally persisted as a revocation after the clock returns");

    const accessRevoke = await apiRequest(`${baseAuth}/oauth2/revoke`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: fixture.webClientId, token: accessToken, token_type_hint: "access_token" }),
    });
    assert.equal(accessRevoke.status, 200, "the registered owning client can revoke an individual JWT access token");
    assert.deepEqual(await fixture.readRevocationRecord(claims.jti as string), {
      issuer: fixture.issuer,
      jti: claims.jti,
      client_id: fixture.webClientId,
      subject: fixture.ownerSubject,
      session_id: typeof claims.sid === "string" ? claims.sid : null,
      expires_at: new Date((claims.exp as number) * 1_000),
    }, "revocation is durably bound to the exact issuer, jti, client, subject and session");
    assert.equal((await apiRequest(`${origin}/api/session`, { headers: { authorization: `Bearer ${accessToken}` } })).status, 401,
      "the exact revoked jti is denied by API admission");
    const revokedIntrospection = await apiRequest(`${baseAuth}/oauth2/introspect`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: fixture.introspectionClientId,
        client_secret: fixture.introspectionClientSecret,
        token: accessToken,
        token_type_hint: "access_token",
      }),
    });
    assert.equal(revokedIntrospection.status, 200);
    assert.deepEqual(await revokedIntrospection.json(), { active: false },
      "OAuth introspection must report an individually revoked JWT as inactive");
    const expiredRecordJti = `expired-${randomUUID()}`;
    await fixture.seedExpiredRevocationRecord(expiredRecordJti);
    assert.equal(await fixture.pruneExpiredRevocations(), 1, "the maintenance prune removes only the expired record");
    assert.equal(await fixture.readRevocationRecord(expiredRecordJti), null, "the expired revocation record is removed from PostgreSQL");
    assert.ok(await fixture.readRevocationRecord(claims.jti as string), "the active revocation record remains in PostgreSQL");
    assert.equal((await apiRequest(`${origin}/api/session`, { headers: { authorization: `Bearer ${accessToken}` } })).status, 401,
      "the live revocation remains effective after expired-record pruning");
    assert.equal((await apiRequest(`${origin}/api/session`, { headers: { authorization: `Bearer ${String(refreshed.access_token)}` } })).status, 200,
      "revoking one access token does not revoke a sibling token from the same session");

    const refreshRevoke = await apiRequest(`${baseAuth}/oauth2/revoke`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: fixture.webClientId, token: String(refreshed.refresh_token), token_type_hint: "refresh_token" }),
    });
    assert.equal(refreshRevoke.status, 200);
    const reusedRefresh = await apiRequest(`${baseAuth}/oauth2/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", client_id: fixture.webClientId, refresh_token: String(refreshed.refresh_token), resource: fixture.audience }),
    });
    assert.equal(reusedRefresh.status, 400, "revoked refresh token must not be reusable");

    const logout = await client.signOut();
    assert.equal(logout.error, null);
    const revokedSession = await apiRequest(`${origin}/api/session`, { headers: { authorization: `Bearer ${String(refreshed.access_token)}` } });
    assert.equal(revokedSession.status, 401);
  } finally {
    if (previousWindow === undefined) delete (globalThis as unknown as { window?: unknown }).window;
    else (globalThis as unknown as { window: unknown }).window = previousWindow;
  }
});
