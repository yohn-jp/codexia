import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer } from "../../src/server.js";
import { createBetterAuthRuntime, CODEXIA_OWNER_SCOPE } from "../../src/better-auth.js";
import { createBetterAuthBootstrap } from "../../src/bootstrap-auth.js";
import { migrateJwtAccessTokenRevocationSchema, pruneExpiredJwtAccessTokenRevocations } from "../../src/jwt-access-token-revocation.js";
import { generateKeyPair, SignJWT, exportJWK } from "jose";
import { Pool } from "pg";
import { CoreStore } from "@codexia/core";
import { createPostgresPersistence, migratePostgresDatabase } from "@codexia/persistence-postgres";
import type { ApiServerOptions } from "../../src/server.js";

export interface BetterAuthFixtureOptions {
  readonly databaseUrl: string;
  readonly staticDirectory?: string;
  readonly apiPort?: number;
  readonly usePostgresPersistence?: boolean;
  readonly appProfile?: Pick<ApiServerOptions, "profile" | "runtimeOptions">;
  readonly registerInBrowser?: (bootstrapOrigin: string) => Promise<BootstrapRegistration>;
}

export interface BootstrapRegistration {
  readonly ownerSubject: string;
  readonly webClientId: string;
  readonly iosClientId: string;
  readonly introspectionClientId: string;
}

export interface BetterAuthFixture {
  readonly apiOrigin: string;
  readonly issuer: string;
  readonly audience: string;
  readonly idpIssuer: string;
  readonly webClientId: string;
  readonly foreignClientId: string;
  readonly ownerSubject: string;
  readonly introspectionClientId: string;
  readonly introspectionClientSecret: string;
  issueOwnerAccessToken(): Promise<string>;
  issueForeignClientAccessToken(): Promise<string>;
  readRevocationRecord(jti: string): Promise<{
    issuer: string;
    jti: string;
    client_id: string;
    subject: string;
    session_id: string | null;
    expires_at: Date;
  } | null>;
  readSigningKeyIds(): Promise<string[]>;
  restartApi(): Promise<void>;
  seedExpiredRevocationRecord(jti: string): Promise<void>;
  pruneExpiredRevocations(): Promise<number>;
  close(): Promise<void>;
}

export function assertDisposableAuthFixtureDatabaseUrl(connectionString: string): void {
  let url: URL;
  try { url = new URL(connectionString); }
  catch { throw new Error("Better Auth fixture requires a PostgreSQL URL for a disposable loopback test database"); }
  const hostname = url.hostname.replace(/^\[|\]$/gu, "");
  const databaseName = decodeURIComponent(url.pathname.slice(1));
  const isolatedCiDatabase = process.env.CI === "true" && hostname === "postgres" && /^codexia_ci_[a-f0-9]{32}$/u.test(databaseName);
  const explicitlyOptedLoopbackDatabase = process.env.CODEXIA_AUTH_TEST_DISPOSABLE === "1" &&
    new Set(["localhost", "127.0.0.1", "::1"]).has(hostname) &&
    new Set(["codexia_auth_test", "codexia_web_oauth_test", "codexia_passkey_virtual"]).has(databaseName);
  if (!new Set(["postgres:", "postgresql:"]).has(url.protocol) ||
      (!explicitlyOptedLoopbackDatabase && !isolatedCiDatabase) || url.search || url.hash) {
    throw new Error("Better Auth fixture requires an explicitly opted-in disposable loopback auth database or uniquely named disposable CI database");
  }
}

interface IdpCodeState {
  readonly nonce: string;
  readonly challenge: string;
}

function listen(server: Server, port = 0): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.removeListener("error", reject);
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("Fixture listener did not bind a TCP port"));
      resolve(address.port);
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function bodyChunks(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer | string) => chunks.push(Buffer.from(chunk)));
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

function sendJson(response: ServerResponse, value: unknown, status = 200): void {
  response.statusCode = status;
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify(value));
}

function cookieJar() {
  const values = new Map<string, string>();
  return {
    remember(response: Response) {
      for (const line of response.headers.getSetCookie()) {
        const pair = line.split(";", 1)[0]!;
        const index = pair.indexOf("=");
        if (index > 0) values.set(pair.slice(0, index), pair.slice(index + 1));
      }
    },
    header() { return [...values].map(([key, value]) => `${key}=${value}`).join("; "); },
  };
}

function coreStoreForAuthFixture(): CoreStore {
  return {
    async listProjects() { return []; },
    async createProject({ title }: { title: string }) { return { id: "fixture-project", title, version: 1 }; },
    async status() { return { projectId: "fixture-project", projectVersion: 1, state: "durable" }; },
    async observe() { return { snapshot: { projectId: "fixture-project", projectVersion: 1 }, observedAt: new Date().toISOString(), state: "fresh" }; },
  } as unknown as CoreStore;
}

function persistenceForAuthFixture(): ApiServerOptions["persistence"] {
  return {
    async checkHealth() {},
    async read<T>(read: (reader: { getProject(id: string): Promise<unknown> }) => Promise<T>) {
      return read({ async getProject() { return null; } });
    },
  } as unknown as ApiServerOptions["persistence"];
}

export async function startBetterAuthFixture(options: BetterAuthFixtureOptions): Promise<BetterAuthFixture> {
  assertDisposableAuthFixtureDatabaseUrl(options.databaseUrl);
  const previousNodeEnv = process.env.NODE_ENV;
  const restoreNodeEnv = () => {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
  };
  const codes = new Map<string, IdpCodeState>();
  const subject = `fixture-owner-${randomUUID()}`;
  const email = `${subject}@example.test`;
  let upstreamSubject = subject;
  let idpIssuer = "";
  let ownerSubject = "";
  let apiServer: Server | undefined;
  let bootstrapServer: Server | undefined;
  let idpServer: Server | undefined;
  let runtime: ReturnType<typeof createBetterAuthRuntime> | undefined;
  let bootstrapPool: Pool | undefined;
  let bootstrap: ReturnType<typeof createBetterAuthBootstrap> | undefined;
  let usageDirectory: string | undefined;
  let domainPersistence: ApiServerOptions["persistence"] | undefined;
  let domainStore: CoreStore | undefined;
  try {
    process.env.NODE_ENV = "test";
    const idpKeyPair = await generateKeyPair("RS256");
    const idpPublicJwk = { ...(await exportJWK(idpKeyPair.publicKey)), kid: "codexia-fixture-idp-key", use: "sig", alg: "RS256" };
    idpServer = createHttpServer(async (request, response) => {
      const url = new URL(request.url ?? "/", idpIssuer);
      if (url.pathname === "/.well-known/openid-configuration") {
        sendJson(response, {
          issuer: idpIssuer,
          authorization_endpoint: `${idpIssuer}/authorize`,
          token_endpoint: `${idpIssuer}/token`,
          userinfo_endpoint: `${idpIssuer}/userinfo`,
          jwks_uri: `${idpIssuer}/jwks`,
          response_types_supported: ["code"],
          subject_types_supported: ["public"],
          id_token_signing_alg_values_supported: ["RS256"],
          token_endpoint_auth_methods_supported: ["client_secret_post"],
          code_challenge_methods_supported: ["S256"],
        });
      } else if (url.pathname === "/jwks") {
        sendJson(response, { keys: [idpPublicJwk] });
      } else if (url.pathname === "/authorize") {
        const state = url.searchParams.get("state");
        const nonce = url.searchParams.get("nonce");
        const challenge = url.searchParams.get("code_challenge");
        if (!state || !nonce || !challenge || url.searchParams.get("code_challenge_method") !== "S256") {
          sendJson(response, { error: "invalid_request" }, 400); return;
        }
        const code = randomUUID();
        const codeState = { nonce, challenge };
        codes.set(code, codeState);
        const callback = new URL(url.searchParams.get("redirect_uri") ?? "");
        callback.searchParams.set("code", code);
        callback.searchParams.set("state", state);
        response.statusCode = 302;
        response.setHeader("location", callback.toString());
        response.end();
      } else if (url.pathname === "/token") {
        const form = new URLSearchParams((await bodyChunks(request)).toString("utf8"));
        const code = form.get("code") ?? "";
        const codeState = codes.get(code);
        const verifier = form.get("code_verifier") ?? "";
        const challenge = createHash("sha256").update(verifier).digest("base64url");
        if (!codeState || !verifier || challenge !== codeState.challenge) {
          sendJson(response, { error: "invalid_grant" }, 400); return;
        }
        codes.delete(code);
        const idToken = await new SignJWT({ email, email_verified: true, name: "Codexia Fixture Owner", nonce: codeState.nonce })
          .setProtectedHeader({ alg: "RS256", kid: idpPublicJwk.kid })
          .setIssuer(idpIssuer).setAudience("codexia-fixture-client").setSubject(upstreamSubject)
          .setIssuedAt().setExpirationTime("5m").sign(idpKeyPair.privateKey);
        sendJson(response, { access_token: "fixture-upstream-access-token", token_type: "Bearer", expires_in: 300, id_token: idToken });
      } else if (url.pathname === "/userinfo") {
        sendJson(response, { sub: upstreamSubject, email, email_verified: true, name: "Codexia Fixture Owner" });
      } else {
        response.statusCode = 404;
        response.end();
      }
    });
    const idpPort = await listen(idpServer);
    idpIssuer = `http://127.0.0.1:${idpPort}`;
    const apiPort = options.apiPort ?? await (async () => {
      const probe = createHttpServer();
      const port = await listen(probe);
      await close(probe);
      return port;
    })();
    const apiOrigin = `http://127.0.0.1:${apiPort}`;
    const issuer = `${apiOrigin}/api/auth`;
    const audience = `${apiOrigin}/api`;

    bootstrapPool = new Pool({ connectionString: options.databaseUrl });
    await bootstrapPool.query("CREATE SCHEMA IF NOT EXISTS codexia_auth");
    await bootstrapPool.end();
    bootstrapPool = undefined;

    const ownerClientIds: string[] = ["fixture-owner-client-pending-registration"];
    const runtimeConfig = {
      databaseUrl: options.databaseUrl,
      publicOrigin: apiOrigin,
      oidcIssuer: idpIssuer,
      oidcClientId: "codexia-fixture-client",
      oidcClientSecret: "fixture-oidc-client-secret-with-sufficient-length",
      authSecret: "codexia-fixture-auth-secret-at-least-32-bytes-long",
      oauthIntrospectionClientId: "fixture-introspector-pending-registration",
      oauthIntrospectionClientSecret: "fixture-introspector-secret-placeholder-32-long",
      ownerSubject: "",
      ownerClientIds,
      mcpClientIds: [],
      allowInsecureLoopbackForTests: true,
    };
    usageDirectory = await mkdtemp(join(tmpdir(), "codexia-auth-fixture-history-"));
    runtime = createBetterAuthRuntime(runtimeConfig);
    await (await runtime.auth.$context).runMigrations();
    await migrateJwtAccessTokenRevocationSchema(runtime.pool);

    if (options.usePostgresPersistence) {
      await migratePostgresDatabase(options.databaseUrl);
      domainPersistence = createPostgresPersistence(options.databaseUrl);
      domainStore = new CoreStore({ persistence: domainPersistence });
    }

    const makeApi = (withOwner: boolean, withPostgresPersistence = false): Server => createServer({
      profile: "core",
      ...(withOwner ? options.appProfile : {}),
      store: withPostgresPersistence ? domainStore! : coreStoreForAuthFixture(),
      persistence: withPostgresPersistence ? domainPersistence! : persistenceForAuthFixture(),
      staticDir: options.staticDirectory ?? process.cwd(),
      usageDirectory: usageDirectory!,
      betterAuth: runtime!,
      ...(withOwner ? { oauthOwner: {
        issuer,
        audience,
        jwksUrl: `${issuer}/jwks`,
        ownerSubject,
        requiredScopes: [CODEXIA_OWNER_SCOPE],
        allowedClientIds: ownerClientIds,
        verifyActiveToken: runtime!.verifyActiveAccessToken,
        allowInsecureLoopbackForTests: true,
      } } : {}),
    });

    const bootstrapOrigin = "http://127.0.0.1:" + await (async () => {
      const probe = createHttpServer();
      const port = await listen(probe);
      await close(probe);
      return port;
    })();
    bootstrap = createBetterAuthBootstrap({
      ...runtimeConfig,
      publicOrigin: bootstrapOrigin,
      apiAudience: audience,
      ownerClientIds: ["fixture-web-" + randomUUID(), "fixture-ios-" + randomUUID()],
      oauthIntrospectionClientId: "fixture-introspection-" + randomUUID(),
    }, {
      ownerOidcSubject: subject,
      webRedirectUris: [apiOrigin + "/desktop", apiOrigin + "/mobile"],
    });
    bootstrapServer = createHttpServer(bootstrap.listener);
    await listen(bootstrapServer, Number(new URL(bootstrapOrigin).port));
    const cookie = cookieJar();
    const postBootstrap = (path: string, headers: HeadersInit = {}) => fetch(bootstrapOrigin + path, {
      method: "POST", redirect: "manual",
      headers: { origin: bootstrapOrigin, cookie: cookie.header(), ...headers },
    });
    if ((await postBootstrap("/api/auth/passkey/verify-registration")).status !== 404) {
      throw new Error("OIDC-only bootstrap exposed a Passkey ceremony on its temporary hostname");
    }
    if ((await postBootstrap("/register")).status !== 401) throw new Error("Bootstrap accepted a request without an IdP session");
    if ((await postBootstrap("/login", { origin: apiOrigin })).status !== 403) throw new Error("Bootstrap accepted a foreign origin");
    async function signIntoBootstrap(): Promise<void> {
      const signIn = await postBootstrap("/login");
      cookie.remember(signIn);
      const link = (await signIn.text()).match(/href="([^"]+)"/u)?.[1];
      if (!link) throw new Error("Bootstrap did not issue an IdP sign-in link");
      const upstream = await fetch(link.replaceAll("&amp;", "&"), { redirect: "manual" });
      const callback = upstream.headers.get("location");
      if (!callback) throw new Error("Synthetic OIDC authorization did not return to bootstrap");
      const callbackResponse = await fetch(callback, { redirect: "manual", headers: { cookie: cookie.header() } });
      cookie.remember(callbackResponse);
    }
    upstreamSubject = subject + "-unauthorized";
    await signIntoBootstrap();
    if ((await postBootstrap("/register")).status !== 401) throw new Error("Bootstrap established an owner session for a different IdP subject");
    upstreamSubject = subject;
    const registered = options.registerInBrowser
      ? await options.registerInBrowser(bootstrapOrigin)
      : await (async () => {
        await signIntoBootstrap();
        const registration = await postBootstrap("/register");
        if (registration.status !== 200) throw new Error("Protected bootstrap registration failed: " + await registration.text());
        const result = await registration.json() as BootstrapRegistration;
        const retry = await postBootstrap("/register");
        if (JSON.stringify(await retry.json()) !== JSON.stringify(result)) throw new Error("Bootstrap registration retry changed the registered IDs");
        if ((await postBootstrap("/api/auth/admin/oauth2/create-client")).status !== 404) throw new Error("Bootstrap exposed the raw registration API");
        return result;
      })();
    ownerSubject = registered.ownerSubject;
    runtimeConfig.ownerSubject = ownerSubject;
    ownerClientIds.splice(0, ownerClientIds.length, registered.webClientId, registered.iosClientId);
    runtimeConfig.oauthIntrospectionClientId = registered.introspectionClientId;

    const productionSignIn = await runtime.auth.api.signInSocial({
      body: { provider: "workspace-oidc", callbackURL: "/oauth/login", requestSignUp: true }, asResponse: true,
    });
    const productionCookie = cookieJar();
    productionCookie.remember(productionSignIn);
    const productionUrl = (await productionSignIn.json() as { url: string }).url;
    const productionUpstream = await fetch(productionUrl, { redirect: "manual" });
    const productionCallback = await runtime.handler(new Request(productionUpstream.headers.get("location")!, {
      headers: { cookie: productionCookie.header() },
    }));
    productionCookie.remember(productionCallback);
    const foreignClient = await runtime.auth.api.adminCreateOAuthClient({
      headers: new Headers({ cookie: productionCookie.header() }),
      body: {
        redirect_uris: [`${apiOrigin}/foreign-client`],
        client_name: "Codexia Fixture Foreign Public Client",
        resources: [audience],
        scope: `openid ${CODEXIA_OWNER_SCOPE} offline_access`,
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        application_type: "native",
        require_pkce: true,
        skip_consent: false,
      },
    });
    runtimeConfig.oauthIntrospectionClientSecret = "fixture-introspector-secret-placeholder-32-long";
    await runtime.assertRegisteredClients();

    await close(bootstrapServer);
    bootstrapServer = undefined;
    await bootstrap.close();
    bootstrap = undefined;
    apiServer = makeApi(true, Boolean(options.usePostgresPersistence));
    await listen(apiServer, apiPort);

    async function issueAccessToken(clientId: string, path: string): Promise<string> {
      const verifier = randomBytes(32).toString("base64url");
      const state = randomUUID();
      const redirectUri = new URL(path, apiOrigin).href;
      const authorization = await fetch(`${issuer}/oauth2/authorize?${new URLSearchParams({
        response_type: "code", client_id: clientId, redirect_uri: redirectUri,
        scope: `openid ${CODEXIA_OWNER_SCOPE}`, state, prompt: "consent", resource: audience,
        code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256",
      })}`, { redirect: "manual", headers: { accept: "application/json", cookie: productionCookie.header() } });
      if (!authorization.ok) throw new Error(`OAuth authorization failed (${authorization.status})`);
      const pending = await authorization.json() as { url?: string };
      const consentPage = new URL(pending.url ?? "", apiOrigin);
      if (consentPage.origin !== apiOrigin || consentPage.pathname !== "/oauth/consent") {
        throw new Error("OAuth authorization did not reach the consent page");
      }

      const consent = await fetch(`${issuer}/oauth2/consent`, {
        method: "POST", redirect: "manual",
        headers: { "content-type": "application/json", cookie: productionCookie.header(), origin: apiOrigin },
        body: JSON.stringify({ accept: true, oauth_query: consentPage.searchParams.toString() }),
      });
      if (!consent.ok) throw new Error(`OAuth consent failed (${consent.status})`);
      const granted = await consent.json() as { url?: string };
      const callback = new URL(granted.url ?? "", apiOrigin);
      const code = callback.searchParams.get("code");
      if (`${callback.origin}${callback.pathname}` !== redirectUri || !code || callback.searchParams.get("state") !== state) {
        throw new Error("OAuth consent did not return the bound authorization code");
      }

      const tokenResponse = await fetch(`${issuer}/oauth2/token`, {
        method: "POST", redirect: "manual",
        body: new URLSearchParams({ grant_type: "authorization_code", client_id: clientId, code,
          redirect_uri: redirectUri, code_verifier: verifier, resource: audience }),
      });
      if (!tokenResponse.ok) throw new Error(`OAuth token exchange failed (${tokenResponse.status})`);
      const token = await tokenResponse.json() as { access_token?: string; token_type?: string };
      if (!token.access_token || token.token_type !== "Bearer") throw new Error("OAuth token exchange did not issue an API bearer token");
      return token.access_token;
    }

    return {
      apiOrigin,
      issuer,
      audience,
      idpIssuer,
      webClientId: registered.webClientId,
      foreignClientId: foreignClient.client_id,
      ownerSubject,
      introspectionClientId: registered.introspectionClientId,
      introspectionClientSecret: runtimeConfig.oauthIntrospectionClientSecret,
      issueOwnerAccessToken: () => issueAccessToken(registered.webClientId, "/desktop"),
      issueForeignClientAccessToken: () => issueAccessToken(foreignClient.client_id, "/foreign-client"),
      async readSigningKeyIds() {
        const context = await runtime!.auth.$context;
        const rows = await context.adapter.findMany({ model: "jwks" });
        return rows.flatMap((row) => typeof row === "object" && row !== null && "id" in row && typeof row.id === "string" ? [row.id] : []);
      },
      async restartApi() {
        if (apiServer) await close(apiServer);
        apiServer = undefined;
        await runtime!.pool.end();
        runtime = createBetterAuthRuntime(runtimeConfig);
        await runtime.assertRegisteredClients();
        apiServer = makeApi(true, Boolean(options.usePostgresPersistence));
        await listen(apiServer, apiPort);
      },
      async readRevocationRecord(jti) {
        const result = await runtime!.pool.query<{
          issuer: string;
          jti: string;
          client_id: string;
          subject: string;
          session_id: string | null;
          expires_at: Date;
        }>(
          "SELECT issuer, jti, client_id, subject, session_id, expires_at FROM codexia_auth.oauth_jwt_access_token_revocation WHERE jti = $1",
          [jti],
        );
        return result.rows[0] ?? null;
      },
      async seedExpiredRevocationRecord(jti) {
        await runtime!.pool.query(
          `INSERT INTO codexia_auth.oauth_jwt_access_token_revocation
             (issuer, jti, client_id, subject, issued_at, expires_at, revoked_at)
           VALUES ($1, $2, 'fixture-client', 'fixture-subject', CURRENT_TIMESTAMP - INTERVAL '2 days',
                   CURRENT_TIMESTAMP - INTERVAL '1 day', CURRENT_TIMESTAMP - INTERVAL '1 day')`,
          [issuer, jti],
        );
      },
      async pruneExpiredRevocations() {
        return pruneExpiredJwtAccessTokenRevocations(runtime!.pool);
      },
      async close() {
        try {
          if (apiServer) await close(apiServer);
          if (bootstrapServer) await close(bootstrapServer);
          if (idpServer) await close(idpServer);
          if (runtime) await runtime.pool.end();
          if (domainPersistence) await domainPersistence.close();
          if (bootstrapPool) await bootstrapPool.end();
          if (usageDirectory) await rm(usageDirectory, { recursive: true, force: true });
        } finally {
          restoreNodeEnv();
        }
      },
    };
  } catch (error) {
    if (apiServer) await close(apiServer).catch(() => undefined);
    if (bootstrapServer) await close(bootstrapServer).catch(() => undefined);
    await bootstrap?.close().catch(() => undefined);
    if (idpServer) await close(idpServer).catch(() => undefined);
    if (runtime) await runtime.pool.end().catch(() => undefined);
    if (domainPersistence) await domainPersistence.close().catch(() => undefined);
    if (bootstrapPool) await bootstrapPool.end().catch(() => undefined);
    if (usageDirectory) await rm(usageDirectory, { recursive: true, force: true }).catch(() => undefined);
    restoreNodeEnv();
    throw error;
  }
}
