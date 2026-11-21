import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { createServer as createHttpServer, type Server } from "node:http";
import { once } from "node:events";
import { test } from "node:test";
import { createLocalJWKSet, exportJWK, generateKeyPair, jwtVerify, SignJWT } from "jose";
import { Pool } from "pg";
import { createBetterAuthRuntime } from "./better-auth.js";
import { migrateJwtAccessTokenRevocationSchema } from "./jwt-access-token-revocation.js";

const databaseUrl = process.env.CODEXIA_AUTH_TEST_DATABASE_URL;
const disposableDatabaseOptIn = process.env.CODEXIA_AUTH_TEST_DISPOSABLE === "1";

function assertDisposableDatabaseUrl(value: string, explicitOptIn: boolean): URL {
  if (!explicitOptIn) throw new Error("Set CODEXIA_AUTH_TEST_DISPOSABLE=1 only for a disposable database");
  let parsed: URL;
  try { parsed = new URL(value); }
  catch { throw new Error("CODEXIA_AUTH_TEST_DATABASE_URL must be a valid PostgreSQL URL"); }
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/gu, "");
  const isLoopbackIpv4 = isIP(host) === 4 && Number(host.split(".", 1)[0]) === 127;
  const loopback = host === "localhost" || isLoopbackIpv4 || (isIP(host) === 6 && host === "::1");
  if (!(parsed.protocol === "postgres:" || parsed.protocol === "postgresql:") || !loopback || parsed.pathname !== "/codexia_auth_test") {
    throw new Error("Auth persistence acceptance tests require loopback PostgreSQL and database codexia_auth_test");
  }
  return parsed;
}

async function createAuthSchema(pool: Pool): Promise<void> {
  await pool.query("CREATE SCHEMA codexia_auth");
}

interface CookieJar {
  readonly values: Map<string, string>;
  remember(response: Response): void;
  header(): string;
}

function cookieJar(): CookieJar {
  const values = new Map<string, string>();
  return {
    values,
    remember(response) {
      for (const line of response.headers.getSetCookie()) {
        const pair = line.split(";", 1)[0]!;
        const separator = pair.indexOf("=");
        if (separator > 0) values.set(pair.slice(0, separator), pair.slice(separator + 1));
      }
    },
    header() { return [...values].map(([name, value]) => `${name}=${value}`).join("; "); },
  };
}

async function listen(server: Server): Promise<number> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return address.port;
}

async function close(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function requestHandler(runtime: ReturnType<typeof createBetterAuthRuntime>, url: string, init?: RequestInit): Promise<Response> {
  return runtime.handler(new Request(url, init));
}

test("auth persistence fixture rejects non-disposable database targets without contacting them", () => {
  assert.throws(() => assertDisposableDatabaseUrl("postgres://codexia:secret@127.0.0.1/codexia_auth_test", false), /CODEXIA_AUTH_TEST_DISPOSABLE/u);
  assert.throws(() => assertDisposableDatabaseUrl("postgres://codexia:secret@db.example.test/codexia_auth_test", true), /loopback PostgreSQL/u);
  assert.throws(() => assertDisposableDatabaseUrl("postgres://codexia:secret@127.0.0.1/codexia", true), /loopback PostgreSQL/u);
  assert.throws(() => assertDisposableDatabaseUrl("postgres://codexia:secret@127.database-attacker.test/codexia_auth_test", true), /loopback PostgreSQL/u);
  assert.throws(() => assertDisposableDatabaseUrl("http://127.0.0.1/codexia_auth_test", true), /loopback PostgreSQL/u);
});

test("auth persistence fixture preserves an existing codexia_auth schema", {
  skip: !databaseUrl || !disposableDatabaseOptIn ? "Set explicit disposable PostgreSQL test configuration" : false,
  timeout: 30_000,
}, async () => {
  assert.ok(databaseUrl);
  assertDisposableDatabaseUrl(databaseUrl, disposableDatabaseOptIn);
  const pool = new Pool({ connectionString: databaseUrl });
  let schemaCreated = false;
  try {
    await createAuthSchema(pool);
    schemaCreated = true;
    await pool.query("CREATE TABLE codexia_auth.fixture_sentinel (value text PRIMARY KEY)");
    await pool.query("INSERT INTO codexia_auth.fixture_sentinel(value) VALUES ('preserve-me')");
    await assert.rejects(createAuthSchema(pool), /already exists/u);
    const sentinel = await pool.query("SELECT value FROM codexia_auth.fixture_sentinel");
    assert.deepEqual(sentinel.rows, [{ value: "preserve-me" }], "an existing auth schema and its data must remain intact after setup refusal");
  } finally {
    if (schemaCreated) await pool.query("DROP SCHEMA codexia_auth CASCADE");
    await pool.end();
  }
});

test("Better Auth PostgreSQL restart preserves JWKS signing key, session and refresh continuity", {
  skip: !databaseUrl || !disposableDatabaseOptIn ? "Set CODEXIA_AUTH_TEST_DISPOSABLE=1 and CODEXIA_AUTH_TEST_DATABASE_URL for a disposable PostgreSQL database" : false,
  timeout: 120_000,
}, async () => {
  assert.ok(databaseUrl);
  assertDisposableDatabaseUrl(databaseUrl, disposableDatabaseOptIn);

  process.env.NODE_ENV = "test";
  const schemaPool = new Pool({ connectionString: databaseUrl });
  let schemaCreated = false;

  const idpKeys = await generateKeyPair("RS256");
  const idpJwk = await exportJWK(idpKeys.publicKey);
  const idpIssuerHolder: { value: string } = { value: "" };
  const states = new Map<string, { nonce: string; challenge: string }>();
  const codes = new Map<string, { nonce: string; challenge: string }>();
  const idp = createHttpServer(async (request, response) => {
    const url = new URL(request.url ?? "/", idpIssuerHolder.value);
    if (url.pathname === "/.well-known/openid-configuration") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({
        issuer: idpIssuerHolder.value,
        authorization_endpoint: `${idpIssuerHolder.value}/authorize`,
        token_endpoint: `${idpIssuerHolder.value}/token`,
        userinfo_endpoint: `${idpIssuerHolder.value}/userinfo`,
        jwks_uri: `${idpIssuerHolder.value}/jwks`,
        response_types_supported: ["code"],
        subject_types_supported: ["public"],
        id_token_signing_alg_values_supported: ["RS256"],
        token_endpoint_auth_methods_supported: ["client_secret_post"],
      }));
      return;
    }
    if (url.pathname === "/jwks") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ keys: [{ ...idpJwk, kid: "codexia-persistence-fixture", use: "sig", alg: "RS256" }] }));
      return;
    }
    if (url.pathname === "/authorize") {
      const state = url.searchParams.get("state");
      const nonce = url.searchParams.get("nonce");
      const challenge = url.searchParams.get("code_challenge");
      const redirectUri = url.searchParams.get("redirect_uri");
      if (!state || !nonce || !challenge || !redirectUri) { response.writeHead(400).end(); return; }
      states.set(state, { nonce, challenge });
      const code = `fixture-${states.size}`;
      codes.set(code, states.get(state)!);
      const callback = new URL(redirectUri);
      callback.searchParams.set("code", code);
      callback.searchParams.set("state", state);
      response.writeHead(302, { location: callback.toString() }).end();
      return;
    }
    if (url.pathname === "/token") {
      const body: Buffer[] = [];
      for await (const chunk of request) body.push(Buffer.from(chunk));
      const form = new URLSearchParams(Buffer.concat(body).toString("utf8"));
      const stored = codes.get(form.get("code") ?? "");
      const verifier = form.get("code_verifier");
      if (!stored || !verifier || createHash("sha256").update(verifier).digest("base64url") !== stored.challenge) {
        response.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: "invalid_grant" }));
        return;
      }
      const idToken = await new SignJWT({ email: "fixture-owner@example.test", email_verified: true, name: "Fixture Owner", nonce: stored.nonce })
        .setProtectedHeader({ alg: "RS256", kid: "codexia-persistence-fixture" })
        .setIssuer(idpIssuerHolder.value).setAudience("codexia-persistence-fixture-client")
        .setSubject("fixture-owner-subject").setIssuedAt().setExpirationTime("5m").sign(idpKeys.privateKey);
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ access_token: "fixture-upstream-access-token", token_type: "Bearer", expires_in: 300, id_token: idToken }));
      return;
    }
    if (url.pathname === "/userinfo") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ sub: "fixture-owner-subject", email: "fixture-owner@example.test", email_verified: true, name: "Fixture Owner" }));
      return;
    }
    response.writeHead(404).end();
  });

  let firstRuntime: ReturnType<typeof createBetterAuthRuntime> | undefined;
  let secondRuntime: ReturnType<typeof createBetterAuthRuntime> | undefined;
  let idpPort = 0;
  let authPort = 0;
  let idpServer: Server | undefined;
  try {
    await createAuthSchema(schemaPool);
    schemaCreated = true;
    idpPort = await listen(idp);
    idpServer = idp;
    idpIssuerHolder.value = `http://127.0.0.1:${idpPort}`;
    const portProbe = createHttpServer();
    authPort = await listen(portProbe);
    await new Promise<void>((resolve, reject) => portProbe.close((error) => error ? reject(error) : resolve()));
    const publicOrigin = `http://127.0.0.1:${authPort}`;
    const apiAudience = `${publicOrigin}/api`;
    const config = {
      databaseUrl,
      publicOrigin,
      oidcIssuer: idpIssuerHolder.value,
      oidcClientId: "codexia-persistence-fixture-client",
      oidcClientSecret: "codexia-fixture-oidc-client-secret",
      authSecret: "codexia-auth-persistence-fixture-secret-32-bytes-minimum",
      oauthIntrospectionClientId: "codexia-persistence-introspection-client",
      oauthIntrospectionClientSecret: "codexia-auth-persistence-introspection-secret",
      apiAudience,
      ownerClientIds: ["codexia-persistence-fixture-owner-client"],
      allowInsecureLoopbackForTests: true,
    } as const;

    firstRuntime = createBetterAuthRuntime(config);
    const firstContext = await firstRuntime.auth.$context;
    await firstContext.runMigrations();
    await migrateJwtAccessTokenRevocationSchema(firstRuntime.pool);

    const authBase = `${publicOrigin}/api/auth`;
    const cookies = cookieJar();
    const signIn = await requestHandler(firstRuntime, `${authBase}/sign-in/social`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "workspace-oidc", callbackURL: "/oauth/login", requestSignUp: true }),
    });
    cookies.remember(signIn);
    const signInBody = await signIn.json() as { url?: string };
    assert.ok(signInBody.url, `OIDC sign-in start failed (${signIn.status})`);
    const authorize = await fetch(signInBody.url, { redirect: "manual" });
    const idpCallback = authorize.headers.get("location");
    assert.ok(idpCallback, `fixture IdP authorization failed (${authorize.status})`);
    const callback = await requestHandler(firstRuntime, idpCallback, { redirect: "manual", headers: { cookie: cookies.header() } });
    cookies.remember(callback);
    assert.ok(callback.status >= 300 && callback.status < 400, `OIDC callback did not complete (${callback.status})`);

    const registered = await firstRuntime.auth.api.adminCreateOAuthClient({
      headers: new Headers({ cookie: cookies.header() }),
      body: {
        redirect_uris: [`${publicOrigin}/client/callback`],
        client_name: "Codexia persistence fixture client",
        resources: [apiAudience],
        scope: "openid codexia:api offline_access",
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        application_type: "native",
        require_pkce: true,
        skip_consent: false,
      },
    });
    const introspection = await firstRuntime.auth.api.adminCreateOAuthClient({
      headers: new Headers({ cookie: cookies.header() }),
      body: {
        client_name: "Codexia persistence fixture introspector",
        resources: [apiAudience],
        scope: "codexia:api",
        token_endpoint_auth_method: "client_secret_post",
        redirect_uris: ["https://introspection.example.test/callback"],
        grant_types: ["authorization_code"],
        response_types: ["code"],
        application_type: "web",
        require_pkce: true,
        skip_consent: true,
      },
    });

    const verifier = "codexia-persistence-fixture-verifier-with-sufficient-entropy-0123456789";
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const authorizeUrl = new URL(`${authBase}/oauth2/authorize`);
    authorizeUrl.search = new URLSearchParams({
      response_type: "code", client_id: registered.client_id,
      redirect_uri: `${publicOrigin}/client/callback`, scope: "openid codexia:api offline_access",
      state: "codexia-persistence-fixture-state", code_challenge: challenge,
      code_challenge_method: "S256", resource: apiAudience,
    }).toString();
    const downstreamAuthorize = await requestHandler(firstRuntime, authorizeUrl.toString(), { redirect: "manual", headers: { cookie: cookies.header() } });
    const consentLocation = downstreamAuthorize.headers.get("location");
    assert.equal(downstreamAuthorize.status, 302, `OAuth authorization must redirect to the configured consent page (${await downstreamAuthorize.text()})`);
    assert.ok(consentLocation, "OAuth authorization must preserve its signed query on the consent redirect");
    const consentUrl = new URL(consentLocation, publicOrigin);
    const consent = await firstRuntime.auth.api.oauth2Consent({
      headers: new Headers({ cookie: cookies.header() }),
      body: { accept: true, oauth_query: consentUrl.searchParams.toString() },
    });
    const authorizationCode = new URL(consent.url, publicOrigin).searchParams.get("code");
    assert.ok(authorizationCode, "consent must issue an authorization code");

    const requestToken = (runtime: ReturnType<typeof createBetterAuthRuntime>, fields: Record<string, string>) =>
      requestHandler(runtime, `${runtime.issuer}/oauth2/token`, {
        method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(fields),
      });
    const initialResponse = await requestToken(firstRuntime, {
      grant_type: "authorization_code", client_id: registered.client_id,
      code: authorizationCode, redirect_uri: `${publicOrigin}/client/callback`, code_verifier: verifier,
      resource: apiAudience,
    });
    const initial = await initialResponse.json() as Record<string, unknown>;
    assert.equal(initialResponse.status, 200, `OAuth token exchange failed (${JSON.stringify(initial)})`);
    const originalAccessToken = String(initial.access_token);
    const originalRefreshToken = String(initial.refresh_token);
    assert.ok(originalAccessToken && originalRefreshToken, "OAuth token exchange must return access and refresh tokens");

    const firstJwksResponse = await requestHandler(firstRuntime, `${firstRuntime.issuer}/jwks`);
    assert.equal(firstJwksResponse.status, 200);
    const firstJwks = await firstJwksResponse.json() as { keys: Array<{ kid: string; kty: string; alg?: string }> };
    assert.ok(firstJwks.keys.some((key) => key.kid && key.kty === "EC"), "Better Auth must publish its ES256 signing key");
    const firstSession = await requestHandler(firstRuntime, `${authBase}/get-session`, { headers: { cookie: cookies.header() } });
    assert.equal(firstSession.status, 200, "OIDC callback must establish a persisted Better Auth session");
    const firstSessionBody = await firstSession.json() as { user?: { id?: string; email?: string }; session?: { id?: string } };
    assert.equal(firstSessionBody.user?.email, "fixture-owner@example.test");
    assert.ok(firstSessionBody.session?.id, "OIDC callback must return a persisted session");

    await firstRuntime.pool.end();
    firstRuntime = undefined;

    secondRuntime = createBetterAuthRuntime(config);
    const secondJwksResponse = await requestHandler(secondRuntime, `${secondRuntime.issuer}/jwks`);
    assert.equal(secondJwksResponse.status, 200);
    const secondJwks = await secondJwksResponse.json() as { keys: Array<{ kid: string; kty: string; alg?: string }> };
    assert.deepEqual(secondJwks.keys, firstJwks.keys, "restart must expose the same persisted Better Auth JWKS keys");

    const verifyWithRestartedJwks = createLocalJWKSet(secondJwks);
    await jwtVerify(originalAccessToken, verifyWithRestartedJwks, {
      issuer: secondRuntime.issuer, audience: apiAudience, algorithms: ["ES256"], typ: "at+jwt",
      requiredClaims: ["iss", "sub", "aud", "exp", "iat", "jti", "client_id"],
    });

    const restoredSession = await requestHandler(secondRuntime, `${secondRuntime.issuer}/get-session`, { headers: { cookie: cookies.header() } });
    assert.equal(restoredSession.status, 200);
    const restoredSessionBody = await restoredSession.json() as { user?: { id?: string; email?: string }; session?: { id?: string } };
    assert.equal(restoredSessionBody.user?.email, "fixture-owner@example.test", "session must remain valid across runtime restart");
    assert.equal(restoredSessionBody.session?.id, firstSessionBody.session.id, "restarted runtime must restore the same persisted session");

    const refreshedResponse = await requestToken(secondRuntime, {
      grant_type: "refresh_token", client_id: registered.client_id,
      refresh_token: originalRefreshToken, resource: apiAudience,
    });
    const refreshed = await refreshedResponse.json() as Record<string, unknown>;
    assert.equal(refreshedResponse.status, 200, `refresh token must remain exchangeable after restart (${JSON.stringify(refreshed)})`);
    assert.notEqual(refreshed.refresh_token, originalRefreshToken, "refresh exchange must rotate the persisted refresh token");
    assert.equal(refreshed.token_type, "Bearer");

    const introspectionResponse = await requestHandler(secondRuntime, `${secondRuntime.issuer}/oauth2/introspect`, {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: introspection.client_id, client_secret: introspection.client_secret ?? "", token: String(refreshed.access_token) }),
    });
    const introspectionBody = await introspectionResponse.json() as { active?: boolean };
    assert.equal(introspectionResponse.status, 200);
    assert.equal(introspectionBody.active, true, "restarted runtime must recognize the access token issued after persisted refresh");
  } finally {
    if (firstRuntime) await firstRuntime.pool.end();
    if (secondRuntime) await secondRuntime.pool.end();
    if (idpServer) await close(idpServer);
    if (schemaCreated) await schemaPool.query("DROP SCHEMA codexia_auth CASCADE");
    await schemaPool.end();
  }
});
