import { execFileSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import dns from 'node:dns';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import {
  createServer as createHttpServer,
  type IncomingMessage,
  request as nodeHttpRequest,
  type Server,
  type ServerResponse,
} from 'node:http';
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getCACertificates, setDefaultCACertificates } from 'node:tls';
import { CoreStore } from '@codexia/core';
import { createPostgresPersistence, migratePostgresDatabase } from '@codexia/persistence-postgres';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { Pool } from 'pg';
import { CODEXIA_OWNER_SCOPE, createBetterAuthRuntime } from '../../src/better-auth.js';
import { createBetterAuthBootstrap } from '../../src/bootstrap-auth.js';
import { migrateJwtAccessTokenRevocationSchema, pruneExpiredJwtAccessTokenRevocations } from '../../src/jwt-access-token-revocation.js';
import type { ApiServerOptions } from '../../src/server.js';
import { createServer } from '../../src/server.js';

export interface BetterAuthFixtureOptions {
  readonly databaseUrl: string;
  readonly staticDirectory?: string;
  readonly apiPort?: number;
  /** Use localhost for browser acceptance that performs real WebAuthn. */
  readonly apiHostname?: 'localhost' | '127.0.0.1' | 'codexia-mcp-fixture.test';
  readonly usePostgresPersistence?: boolean;
  /** Register a real MCP client with a single assigned PostgreSQL project. */
  readonly includeMcp?: boolean;
  /** A caller-owned store and pool that the fixture does not replace or close. */
  readonly domain?: Pick<ApiServerOptions, 'store' | 'persistence'>;
  readonly createApiServer?: typeof createServer;
  readonly observeApiServer?: (server: Server) => void;
  readonly appProfile?: Pick<ApiServerOptions, 'profile' | 'runtimeOptions'>;
  readonly registerInBrowser?: (bootstrapOrigin: string) => Promise<BootstrapRegistration>;
}

export interface BootstrapRegistration {
  readonly ownerSubject: string;
  readonly webClientId: string;
  readonly mcpClientId?: string;
  readonly mcpProjectId?: string;
  readonly unassignedMcpProjectId?: string;
  readonly iosClientId: string;
  readonly introspectionClientId: string;
}

export interface BetterAuthFixture {
  readonly apiOrigin: string;
  readonly tlsCaCertificate?: string;
  readonly issuer: string;
  readonly audience: string;
  readonly idpIssuer: string;
  readonly webClientId: string;
  readonly iosClientId: string;
  readonly mcpClientId?: string;
  readonly mcpProjectId?: string;
  readonly unassignedMcpProjectId?: string;
  readonly foreignClientId: string;
  readonly ownerSubject: string;
  readonly introspectionClientId: string;
  readonly introspectionClientSecret: string;
  ownerSessionCookie(): string;
  expireOwnerFreshProof(): Promise<void>;
  issueOwnerAccessToken(): Promise<string>;
  issueOwnerOAuthTokens(): Promise<{ accessToken: string; refreshToken: string }>;
  prepareOwnerAuthorizationCode(): Promise<() => Promise<Response>>;
  issueIosOAuthTokens(): Promise<{ accessToken: string; refreshToken: string }>;
  createFreshOwnerSession(): Promise<string>;
  ageOwnerSession(): Promise<void>;
  issueForeignClientAccessToken(): Promise<string>;
  issueMcpAccessToken(): Promise<{ accessToken: string; refreshToken: string }>;
  refreshMcpAccessToken(refreshToken: string): Promise<{ accessToken: string; refreshToken: string }>;
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
  try {
    url = new URL(connectionString);
  } catch {
    throw new Error('Better Auth fixture requires a PostgreSQL URL for a disposable loopback test database');
  }
  const hostname = url.hostname.replace(/^\[|\]$/gu, '');
  const databaseName = decodeURIComponent(url.pathname.slice(1));
  const isolatedCiDatabase = process.env.CI === 'true' && hostname === 'postgres' && /^codexia_ci_[a-f0-9]{32}$/u.test(databaseName);
  const explicitlyOptedLoopbackDatabase =
    process.env.CODEXIA_AUTH_TEST_DISPOSABLE === '1' &&
    new Set(['localhost', '127.0.0.1', '::1']).has(hostname) &&
    (new Set(['codexia_auth_test', 'codexia_web_oauth_test', 'codexia_passkey_virtual']).has(databaseName) ||
      /^codexia_perf_[a-z0-9_-]+$/u.test(databaseName) ||
      /^codexia_e2e_compat_[a-z0-9_]+$/u.test(databaseName));
  if (
    !new Set(['postgres:', 'postgresql:']).has(url.protocol) ||
    (!explicitlyOptedLoopbackDatabase && !isolatedCiDatabase) ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      'Better Auth fixture requires an explicitly opted-in disposable loopback auth database or uniquely named disposable CI database',
    );
  }
}

interface IdpCodeState {
  readonly nonce: string;
  readonly challenge: string;
}

function listen(server: Server, port = 0): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', reject);
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('Fixture listener did not bind a TCP port'));
      resolve(address.port);
    });
  });
}

function listenOnLoopbackAlias(server: Server, port: number, hostname: string): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, hostname, () => {
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('Fixture loopback listener did not bind a TCP port'));
      resolve(address.port);
    });
  });
}

function listenHttps(server: HttpsServer, port = 0): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('Fixture HTTPS listener did not bind a TCP port'));
      resolve(address.port);
    });
  });
}

function proxyApiRequests(
  incoming: IncomingMessage,
  outgoing: ServerResponse,
  backendPort: () => number | undefined,
  useTls: boolean,
): void {
  const port = backendPort();
  if (!port) {
    outgoing.writeHead(503);
    outgoing.end();
    return;
  }
  const host = incoming.headers.host;
  const headers = useTls
    ? { ...incoming.headers, 'x-forwarded-proto': 'https', ...(host ? { 'x-forwarded-host': host } : {}) }
    : incoming.headers;
  const upstream = nodeHttpRequest({ hostname: '127.0.0.1', port, method: incoming.method, path: incoming.url, headers }, response => {
    outgoing.writeHead(response.statusCode ?? 502, response.headers);
    response.pipe(outgoing);
  });
  upstream.on('error', () => {
    if (!outgoing.headersSent) outgoing.writeHead(502);
    outgoing.end();
  });
  incoming.on('aborted', () => upstream.destroy());
  outgoing.on('close', () => {
    if (!outgoing.writableEnded) upstream.destroy();
  });
  incoming.pipe(upstream);
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
}

function bodyChunks(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer | string) => chunks.push(Buffer.from(chunk)));
    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', reject);
  });
}

function sendJson(response: ServerResponse, value: unknown, status = 200): void {
  response.statusCode = status;
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify(value));
}

function cookieJar() {
  const values = new Map<string, string>();
  return {
    remember(response: Response) {
      for (const line of response.headers.getSetCookie()) {
        const pair = line.split(';', 1)[0]!;
        const index = pair.indexOf('=');
        if (index > 0) values.set(pair.slice(0, index), pair.slice(index + 1));
      }
    },
    header() {
      return [...values].map(([key, value]) => `${key}=${value}`).join('; ');
    },
  };
}

function coreStoreForAuthFixture(): CoreStore {
  return {
    async createProject({ title }: { title: string }) {
      return { id: 'fixture-project', title, version: 1 };
    },
    async status() {
      return { projectId: 'fixture-project', projectVersion: 1, state: 'durable' };
    },
    async observe() {
      return { snapshot: { projectId: 'fixture-project', projectVersion: 1 }, observedAt: new Date().toISOString(), state: 'fresh' };
    },
  } as unknown as CoreStore;
}

function persistenceForAuthFixture(): ApiServerOptions['persistence'] {
  return {
    async checkHealth() {},
    async read<T>(read: (reader: { getProject(id: string): Promise<unknown> }) => Promise<T>) {
      return read({
        async getProject() {
          return null;
        },
      });
    },
  } as unknown as ApiServerOptions['persistence'];
}

export async function startBetterAuthFixture(options: BetterAuthFixtureOptions): Promise<BetterAuthFixture> {
  assertDisposableAuthFixtureDatabaseUrl(options.databaseUrl);
  if (options.domain && options.usePostgresPersistence) {
    throw new Error('Select either caller-owned domain persistence or fixture-owned PostgreSQL persistence');
  }
  const previousNodeEnv = process.env.NODE_ENV;
  const restoreNodeEnv = () => {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
  };
  let restoreFixtureDns: (() => void) | undefined;
  let restoreFixtureTls: (() => void) | undefined;
  const codes = new Map<string, IdpCodeState>();
  const subject = `fixture-owner-${randomUUID()}`;
  const email = `${subject}@example.test`;
  let upstreamSubject = subject;
  let idpIssuer = '';
  let ownerSubject = '';
  let apiServer: Server | undefined;
  let apiProxyServer: Server | undefined;
  let apiBackendPort: number | undefined;
  let tlsDirectory: string | undefined;
  let bootstrapServer: Server | undefined;
  let idpServer: Server | undefined;
  let runtime: ReturnType<typeof createBetterAuthRuntime> | undefined;
  let bootstrapPool: Pool | undefined;
  let bootstrap: ReturnType<typeof createBetterAuthBootstrap> | undefined;
  let usageDirectory: string | undefined;
  let domainPersistence: ApiServerOptions['persistence'] | undefined;
  let domainStore: CoreStore | undefined;
  try {
    process.env.NODE_ENV = 'test';
    tlsDirectory = await mkdtemp(join(tmpdir(), 'codexia-auth-fixture-tls-'));
    const certificatePath = join(tlsDirectory, 'certificate.pem');
    const privateKeyPath = join(tlsDirectory, 'private-key.pem');
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        privateKeyPath,
        '-out',
        certificatePath,
        '-days',
        '1',
        '-subj',
        '/CN=127.0.0.1',
        '-addext',
        'subjectAltName=DNS:localhost,DNS:codexia-mcp-fixture.test,IP:127.0.0.1',
        '-addext',
        'basicConstraints=critical,CA:TRUE',
      ],
      { stdio: 'ignore' },
    );
    const certificate = await readFile(certificatePath);
    const privateKey = await readFile(privateKeyPath);
    if (options.includeMcp) {
      const previousFixtureCertificates = getCACertificates('default');
      setDefaultCACertificates([...previousFixtureCertificates, certificate]);
      restoreFixtureTls = () => setDefaultCACertificates(previousFixtureCertificates);
      const originalLookup = dns.lookup;
      dns.lookup = ((hostname: string, ...args: unknown[]) => {
        if (hostname === 'codexia-mcp-fixture.test') {
          const callback = args.at(-1) as (...callbackArgs: unknown[]) => void;
          const optionsArg = args[0];
          const address = '127.0.0.1';
          if (typeof optionsArg === 'function') (optionsArg as (error: null, address: string, family: number) => void)(null, address, 4);
          else if (typeof optionsArg === 'object' && optionsArg !== null && 'all' in optionsArg && (optionsArg as { all?: boolean }).all)
            callback(null, [{ address, family: 4 }]);
          else callback(null, address, 4);
          return;
        }
        return (originalLookup as (...lookupArgs: unknown[]) => unknown)(hostname, ...args);
      }) as typeof dns.lookup;
      syncBuiltinESMExports();
      restoreFixtureDns = () => {
        dns.lookup = originalLookup;
        syncBuiltinESMExports();
      };
    }
    const idpKeyPair = await generateKeyPair('RS256');
    const idpPublicJwk = { ...(await exportJWK(idpKeyPair.publicKey)), kid: 'codexia-fixture-idp-key', use: 'sig', alg: 'RS256' };
    const idpHandler = async (request: IncomingMessage, response: ServerResponse) => {
      const url = new URL(request.url ?? '/', idpIssuer);
      if (url.pathname === '/.well-known/openid-configuration') {
        sendJson(response, {
          issuer: idpIssuer,
          authorization_endpoint: `${idpIssuer}/authorize`,
          token_endpoint: `${idpIssuer}/token`,
          userinfo_endpoint: `${idpIssuer}/userinfo`,
          jwks_uri: `${idpIssuer}/jwks`,
          response_types_supported: ['code'],
          subject_types_supported: ['public'],
          id_token_signing_alg_values_supported: ['RS256'],
          token_endpoint_auth_methods_supported: ['client_secret_post'],
          code_challenge_methods_supported: ['S256'],
        });
      } else if (url.pathname === '/jwks') {
        sendJson(response, { keys: [idpPublicJwk] });
      } else if (url.pathname === '/authorize') {
        const state = url.searchParams.get('state');
        const nonce = url.searchParams.get('nonce');
        const challenge = url.searchParams.get('code_challenge');
        if (!state || !nonce || !challenge || url.searchParams.get('code_challenge_method') !== 'S256') {
          sendJson(response, { error: 'invalid_request' }, 400);
          return;
        }
        const code = randomUUID();
        const codeState = { nonce, challenge };
        codes.set(code, codeState);
        const callback = new URL(url.searchParams.get('redirect_uri') ?? '');
        callback.searchParams.set('code', code);
        callback.searchParams.set('state', state);
        response.statusCode = 302;
        response.setHeader('location', callback.toString());
        response.end();
      } else if (url.pathname === '/token') {
        const form = new URLSearchParams((await bodyChunks(request)).toString('utf8'));
        const code = form.get('code') ?? '';
        const codeState = codes.get(code);
        const verifier = form.get('code_verifier') ?? '';
        const challenge = createHash('sha256').update(verifier).digest('base64url');
        if (!codeState || !verifier || challenge !== codeState.challenge) {
          sendJson(response, { error: 'invalid_grant' }, 400);
          return;
        }
        codes.delete(code);
        const idToken = await new SignJWT({ email, email_verified: true, name: 'Codexia Fixture Owner', nonce: codeState.nonce })
          .setProtectedHeader({ alg: 'RS256', kid: idpPublicJwk.kid })
          .setIssuer(idpIssuer)
          .setAudience('codexia-fixture-client')
          .setSubject(upstreamSubject)
          .setIssuedAt()
          .setExpirationTime('5m')
          .sign(idpKeyPair.privateKey);
        sendJson(response, { access_token: 'fixture-upstream-access-token', token_type: 'Bearer', expires_in: 300, id_token: idToken });
      } else if (url.pathname === '/userinfo') {
        sendJson(response, { sub: upstreamSubject, email, email_verified: true, name: 'Codexia Fixture Owner' });
      } else {
        response.statusCode = 404;
        response.end();
      }
    };
    idpServer = options.includeMcp ? createHttpsServer({ cert: certificate, key: privateKey }, idpHandler) : createHttpServer(idpHandler);
    const idpPort = options.includeMcp ? await listenHttps(idpServer as HttpsServer) : await listen(idpServer);
    idpIssuer = `${options.includeMcp ? 'https' : 'http'}://127.0.0.1:${idpPort}`;
    let publicPort = 0;
    const proxyHandler = (request: IncomingMessage, response: ServerResponse) =>
      proxyApiRequests(request, response, () => apiBackendPort, options.includeMcp === true);
    apiProxyServer = options.includeMcp
      ? createHttpsServer({ cert: certificate, key: privateKey }, proxyHandler)
      : createHttpServer(proxyHandler);
    publicPort = options.includeMcp
      ? await listenHttps(apiProxyServer as HttpsServer, options.apiPort ?? 0)
      : await listen(apiProxyServer, options.apiPort ?? 0);
    const apiOrigin = `${options.includeMcp ? 'https' : 'http'}://${options.apiHostname ?? '127.0.0.1'}:${publicPort}`;
    const issuer = `${apiOrigin}/api/auth`;
    const audience = `${apiOrigin}/api`;

    bootstrapPool = new Pool({ connectionString: options.databaseUrl });
    await bootstrapPool.query('CREATE SCHEMA IF NOT EXISTS codexia_auth');
    await bootstrapPool.end();
    bootstrapPool = undefined;

    const ownerClientIds: string[] = ['fixture-owner-client-pending-registration'];
    const mcpClientIds: string[] = [];
    const runtimeConfig = {
      databaseUrl: options.databaseUrl,
      publicOrigin: apiOrigin,
      oidcIssuer: idpIssuer,
      oidcClientId: 'codexia-fixture-client',
      oidcClientSecret: 'fixture-oidc-client-secret-with-sufficient-length',
      authSecret: 'codexia-fixture-auth-secret-at-least-32-bytes-long',
      oauthIntrospectionClientId: 'fixture-introspector-pending-registration',
      oauthIntrospectionClientSecret: 'fixture-introspector-secret-placeholder-32-long',
      ownerSubject: '',
      ownerClientIds,
      mcpClientIds,
      allowInsecureLoopbackForTests: true,
    };
    usageDirectory = await mkdtemp(join(tmpdir(), 'codexia-auth-fixture-history-'));
    runtime = createBetterAuthRuntime(runtimeConfig);
    await (await runtime.auth.$context).runMigrations();
    await migrateJwtAccessTokenRevocationSchema(runtime.pool);

    if (options.usePostgresPersistence) {
      await migratePostgresDatabase(options.databaseUrl);
      domainPersistence = createPostgresPersistence(options.databaseUrl);
      domainStore = new CoreStore({ persistence: domainPersistence });
    }

    let mcpProjectId: string | undefined;
    let unassignedMcpProjectId: string | undefined;
    if (options.includeMcp) {
      if (!domainStore || !domainPersistence) throw new Error('MCP OAuth fixture requires PostgreSQL Core persistence');
      mcpProjectId = (await domainStore.createProject({ title: 'MCP OAuth assigned project' })).id;
      unassignedMcpProjectId = (await domainStore.createProject({ title: 'MCP OAuth unassigned project' })).id;
    }

    const makeApi = (): Server => {
      const server = (options.createApiServer ?? createServer)({
        profile: 'core',
        ...options.appProfile,
        store: options.domain?.store ?? domainStore ?? coreStoreForAuthFixture(),
        persistence: options.domain?.persistence ?? domainPersistence ?? persistenceForAuthFixture(),
        staticDir: options.staticDirectory ?? process.cwd(),
        usageDirectory: usageDirectory!,
        betterAuth: runtime!,
        ...(options.includeMcp ? { trustProxy: true } : {}),
        oauthOwner: {
          issuer,
          audience,
          jwksUrl: `${issuer}/jwks`,
          ownerSubject,
          requiredScopes: [CODEXIA_OWNER_SCOPE],
          allowedClientIds: ownerClientIds,
          verifyActiveToken: runtime!.verifyActiveAccessToken,
          allowInsecureLoopbackForTests: true,
        },
        ...(mcpClientIds.length > 0 && mcpProjectId
          ? {
              oauthMcp: {
                issuer,
                audience,
                jwksUrl: `${issuer}/jwks`,
                ownerSubject,
                allowedClientIds: mcpClientIds,
                ownerClientIds,
                projectIdsByClient: { [mcpClientIds[0]!]: [mcpProjectId] },
                verifyActiveToken: runtime!.verifyActiveAccessToken,
              },
            }
          : {}),
      });
      options.observeApiServer?.(server);
      return server;
    };

    const bootstrapOrigin =
      'http://127.0.0.1:' +
      (await (async () => {
        const probe = createHttpServer();
        const port = await listen(probe);
        await close(probe);
        return port;
      })());
    bootstrap = createBetterAuthBootstrap(
      {
        ...runtimeConfig,
        publicOrigin: bootstrapOrigin,
        apiAudience: audience,
        ownerClientIds: ['fixture-web-' + randomUUID(), 'fixture-ios-' + randomUUID()],
        oauthIntrospectionClientId: 'fixture-introspection-' + randomUUID(),
      },
      {
        ownerOidcSubject: subject,
        webRedirectUris: [apiOrigin + '/desktop'],
      },
    );
    bootstrapServer = createHttpServer(bootstrap.listener);
    await listenOnLoopbackAlias(bootstrapServer, Number(new URL(bootstrapOrigin).port), '127.0.0.1');
    const cookie = cookieJar();
    const postBootstrap = (path: string, headers: HeadersInit = {}) =>
      fetch(bootstrapOrigin + path, {
        method: 'POST',
        redirect: 'manual',
        headers: { origin: bootstrapOrigin, cookie: cookie.header(), ...headers },
      });
    if ((await postBootstrap('/api/auth/passkey/verify-registration')).status !== 404) {
      throw new Error('OIDC-only bootstrap exposed a Passkey ceremony on its temporary hostname');
    }
    if ((await postBootstrap('/register')).status !== 401) throw new Error('Bootstrap accepted a request without an IdP session');
    if ((await postBootstrap('/login', { origin: apiOrigin })).status !== 403) throw new Error('Bootstrap accepted a foreign origin');
    async function signIntoBootstrap(): Promise<void> {
      const signIn = await postBootstrap('/login');
      cookie.remember(signIn);
      const signInHtml = await signIn.text();
      const link = signInHtml.match(/href="([^"]+)"/u)?.[1];
      if (!link) throw new Error(`Bootstrap did not issue an IdP sign-in link (${signIn.status}): ${signInHtml}`);
      const upstream = await fetch(link.replaceAll('&amp;', '&'), { redirect: 'manual' });
      const callback = upstream.headers.get('location');
      if (!callback) throw new Error('Synthetic OIDC authorization did not return to bootstrap');
      const callbackResponse = await fetch(callback, { redirect: 'manual', headers: { cookie: cookie.header() } });
      cookie.remember(callbackResponse);
    }
    upstreamSubject = subject + '-unauthorized';
    await signIntoBootstrap();
    if ((await postBootstrap('/register')).status !== 401)
      throw new Error('Bootstrap established an owner session for a different IdP subject');
    upstreamSubject = subject;
    const registered = options.registerInBrowser
      ? await options.registerInBrowser(bootstrapOrigin)
      : await (async () => {
          await signIntoBootstrap();
          const registration = await postBootstrap('/register');
          if (registration.status !== 200) throw new Error('Protected bootstrap registration failed: ' + (await registration.text()));
          const result = (await registration.json()) as BootstrapRegistration;
          const retry = await postBootstrap('/register');
          if (JSON.stringify(await retry.json()) !== JSON.stringify(result))
            throw new Error('Bootstrap registration retry changed the registered IDs');
          if ((await postBootstrap('/api/auth/admin/oauth2/create-client')).status !== 404)
            throw new Error('Bootstrap exposed the raw registration API');
          return result;
        })();
    ownerSubject = registered.ownerSubject;
    runtimeConfig.ownerSubject = ownerSubject;
    ownerClientIds.splice(0, ownerClientIds.length, registered.webClientId, registered.iosClientId);
    runtimeConfig.oauthIntrospectionClientId = registered.introspectionClientId;

    // Construct the serving runtime with its final owner subject, as production does.
    await runtime.pool.end();
    runtime = createBetterAuthRuntime(runtimeConfig);
    async function signInFixtureOwner() {
      const activeRuntime = runtime!;
      const signIn = await activeRuntime.auth.api.signInSocial({
        body: { provider: 'workspace-oidc', callbackURL: '/oauth/login', requestSignUp: true },
        asResponse: true,
      });
      const cookie = cookieJar();
      cookie.remember(signIn);
      const productionUrl = ((await signIn.json()) as { url: string }).url;
      const upstream = await fetch(productionUrl, { redirect: 'manual' });
      const callback = upstream.headers.get('location');
      if (!callback) throw new Error('Fixture owner sign-in did not reach the registered callback');
      cookie.remember(await activeRuntime.handler(new Request(callback, { headers: { cookie: cookie.header() } })));
      const session = await fixtureOwnerSession(cookie);
      if (session?.user.id !== ownerSubject) throw new Error('Fixture login did not confirm the established owner');
      return cookie;
    }

    function fixtureOwnerSession(cookie: ReturnType<typeof cookieJar>) {
      return runtime!.auth.api.getSession({
        headers: new Headers({ cookie: cookie.header() }),
        query: { disableCookieCache: true, disableRefresh: true },
      });
    }

    let productionCookie = await signInFixtureOwner();
    const foreignClient = await runtime.auth.api.adminCreateOAuthClient({
      headers: new Headers({ cookie: productionCookie.header() }),
      body: {
        redirect_uris: [`${apiOrigin}/foreign-client`],
        client_name: 'Codexia Fixture Foreign Public Client',
        resources: [audience],
        scope: `openid ${CODEXIA_OWNER_SCOPE} offline_access`,
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        application_type: 'native',
        require_pkce: true,
        skip_consent: false,
      },
    });
    let mcpClient: { client_id: string } | undefined;
    if (options.includeMcp) {
      if (!mcpProjectId) throw new Error('MCP OAuth fixture project was not initialized');
      mcpClient = await runtime.auth.api.adminCreateOAuthClient({
        headers: new Headers({ cookie: productionCookie.header() }),
        body: {
          redirect_uris: [`${apiOrigin}/mcp-client`],
          client_name: 'Codexia Fixture MCP Public Client',
          resources: [audience],
          scope: 'openid mcp:read mcp:compute mcp:propose offline_access',
          token_endpoint_auth_method: 'none',
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
          application_type: 'native',
          require_pkce: true,
          skip_consent: false,
        },
      });
      mcpClientIds.push(mcpClient.client_id);
      await runtime.pool.end();
      runtime = createBetterAuthRuntime(runtimeConfig);
    }
    runtimeConfig.oauthIntrospectionClientSecret = 'fixture-introspector-secret-placeholder-32-long';
    await runtime.assertRegisteredClients();

    await close(bootstrapServer);
    bootstrapServer = undefined;
    await bootstrap.close();
    bootstrap = undefined;
    apiServer = makeApi();
    apiBackendPort = await listen(apiServer);

    async function prepareAuthorizationCode(clientId: string, path: string, scopes = `openid ${CODEXIA_OWNER_SCOPE} offline_access`) {
      // Browser tests can revoke the fixture's previous owner session along with other devices.
      if ((await fixtureOwnerSession(productionCookie))?.user.id !== ownerSubject) {
        productionCookie = await signInFixtureOwner();
      }
      const cookie = productionCookie.header();
      const verifier = randomBytes(32).toString('base64url');
      const state = randomUUID();
      const redirectUri = path.includes(':') ? path : new URL(path, apiOrigin).href;
      const authorization = await fetch(
        `${issuer}/oauth2/authorize?${new URLSearchParams({
          response_type: 'code',
          client_id: clientId,
          redirect_uri: redirectUri,
          scope: scopes,
          state,
          prompt: 'consent',
          resource: audience,
          code_challenge: createHash('sha256').update(verifier).digest('base64url'),
          code_challenge_method: 'S256',
        })}`,
        { redirect: 'manual', headers: { accept: 'application/json', cookie } },
      );
      if (!authorization.ok) throw new Error(`OAuth authorization failed (${authorization.status})`);
      const pending = (await authorization.json()) as { url?: string };
      const consentPage = new URL(pending.url ?? '', apiOrigin);
      if (consentPage.origin !== apiOrigin || consentPage.pathname !== '/oauth/consent') {
        throw new Error('OAuth authorization did not reach the consent page');
      }

      const consent = await fetch(`${issuer}/oauth2/consent`, {
        method: 'POST',
        redirect: 'manual',
        headers: { 'content-type': 'application/json', cookie, origin: apiOrigin },
        body: JSON.stringify({ accept: true, oauth_query: consentPage.searchParams.toString() }),
      });
      if (!consent.ok) throw new Error(`OAuth consent failed (${consent.status})`);
      const granted = (await consent.json()) as { url?: string };
      const callback = new URL(granted.url ?? '', apiOrigin);
      const code = callback.searchParams.get('code');
      if (
        callback.href.split(/[?#]/u, 1)[0] !== redirectUri ||
        !code ||
        callback.searchParams.get('state') !== state ||
        callback.searchParams.get('iss') !== issuer
      ) {
        throw new Error('OAuth consent did not return the bound authorization code');
      }

      return () =>
        fetch(`${issuer}/oauth2/token`, {
          method: 'POST',
          redirect: 'manual',
          body: new URLSearchParams({
            grant_type: 'authorization_code',
            client_id: clientId,
            code,
            redirect_uri: redirectUri,
            code_verifier: verifier,
            resource: audience,
          }),
        });
    }

    async function issueAccessToken(clientId: string, path: string, scopes?: string) {
      const exchange = await prepareAuthorizationCode(clientId, path, scopes);
      const tokenResponse = await exchange();
      if (!tokenResponse.ok) throw new Error(`OAuth token exchange failed (${tokenResponse.status})`);
      const token = (await tokenResponse.json()) as { access_token?: string; refresh_token?: string; token_type?: string };
      if (!token.access_token || token.token_type !== 'Bearer') throw new Error('OAuth token exchange did not issue an API bearer token');
      return { accessToken: token.access_token, refreshToken: token.refresh_token ?? '' };
    }

    return {
      apiOrigin,
      ...(options.includeMcp ? { tlsCaCertificate: certificate.toString('utf8') } : {}),
      issuer,
      audience,
      idpIssuer,
      webClientId: registered.webClientId,
      iosClientId: registered.iosClientId,
      ...(mcpClient ? { mcpClientId: mcpClient.client_id } : {}),
      ...(mcpProjectId ? { mcpProjectId } : {}),
      ...(unassignedMcpProjectId ? { unassignedMcpProjectId } : {}),
      foreignClientId: foreignClient.client_id,
      ownerSubject,
      introspectionClientId: registered.introspectionClientId,
      introspectionClientSecret: runtimeConfig.oauthIntrospectionClientSecret,
      ownerSessionCookie: () => productionCookie.header(),
      async expireOwnerFreshProof() {
        const active = await fixtureOwnerSession(productionCookie);
        if (!active) throw new Error('Fixture owner session unavailable');
        await (await runtime!.auth.$context).adapter.update({
          model: 'session',
          where: [{ field: 'id', value: active.session.id }],
          update: { createdAt: new Date(Date.now() - 10 * 60 * 1000) },
        });
      },
      issueOwnerAccessToken: async () => (await issueAccessToken(registered.webClientId, '/desktop')).accessToken,
      issueOwnerOAuthTokens: async () => issueAccessToken(registered.webClientId, '/desktop'),
      prepareOwnerAuthorizationCode: async () => prepareAuthorizationCode(registered.webClientId, '/desktop'),
      issueIosOAuthTokens: async () => issueAccessToken(registered.iosClientId, 'jp.yohn.codexia:/oauth2redirect'),
      async createFreshOwnerSession() {
        productionCookie = await signInFixtureOwner();
        return productionCookie.header();
      },
      async ageOwnerSession() {
        const current = await fixtureOwnerSession(productionCookie);
        if (!current) throw new Error('Fixture owner session is unavailable');
        await (await runtime!.auth.$context).internalAdapter.updateSession(current.session.token, {
          createdAt: new Date(Date.now() - 6 * 60_000),
        });
      },
      issueForeignClientAccessToken: async () => (await issueAccessToken(foreignClient.client_id, '/foreign-client')).accessToken,
      async issueMcpAccessToken() {
        if (!mcpClient) throw new Error('MCP OAuth client was not registered in this fixture');
        return issueAccessToken(mcpClient.client_id, '/mcp-client', 'openid mcp:read mcp:compute mcp:propose offline_access');
      },
      async refreshMcpAccessToken(refreshToken: string) {
        if (!mcpClient || !refreshToken) throw new Error('MCP refresh requires a registered client and token');
        const response = await fetch(`${issuer}/oauth2/token`, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'refresh_token',
            client_id: mcpClient.client_id,
            refresh_token: refreshToken,
            resource: audience,
          }),
        });
        if (!response.ok) throw new Error(`MCP OAuth refresh failed (${response.status})`);
        const token = (await response.json()) as { access_token?: string; refresh_token?: string; token_type?: string };
        if (!token.access_token || token.token_type !== 'Bearer') throw new Error('MCP refresh did not issue an API bearer token');
        return { accessToken: token.access_token, refreshToken: token.refresh_token ?? refreshToken };
      },
      async readSigningKeyIds() {
        const context = await runtime!.auth.$context;
        const rows = await context.adapter.findMany({ model: 'jwks' });
        return rows.flatMap(row => (typeof row === 'object' && row !== null && 'id' in row && typeof row.id === 'string' ? [row.id] : []));
      },
      async restartApi() {
        if (apiServer) await close(apiServer);
        apiServer = undefined;
        const moduleCache = options.appProfile?.runtimeOptions?.cacheDirectory;
        if (moduleCache) await rm(moduleCache, { recursive: true, force: true });
        if (options.usePostgresPersistence) {
          await domainPersistence?.close();
          domainPersistence = createPostgresPersistence(options.databaseUrl);
          domainStore = new CoreStore({ persistence: domainPersistence });
        }
        await runtime!.pool.end();
        runtime = createBetterAuthRuntime(runtimeConfig);
        await runtime.assertRegisteredClients();
        apiServer = makeApi();
        apiBackendPort = await listen(apiServer, apiBackendPort ?? 0);
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
          'SELECT issuer, jti, client_id, subject, session_id, expires_at FROM codexia_auth.oauth_jwt_access_token_revocation WHERE jti = $1',
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
          if (apiProxyServer) await close(apiProxyServer);
          if (bootstrapServer) await close(bootstrapServer);
          if (idpServer) await close(idpServer);
          if (runtime) await runtime.pool.end();
          if (domainPersistence) await domainPersistence.close();
          if (bootstrapPool) await bootstrapPool.end();
          if (usageDirectory) await rm(usageDirectory, { recursive: true, force: true });
          if (tlsDirectory) await rm(tlsDirectory, { recursive: true, force: true });
        } finally {
          restoreFixtureDns?.();
          restoreFixtureTls?.();
          restoreNodeEnv();
        }
      },
    };
  } catch (error) {
    if (apiServer) await close(apiServer).catch(() => undefined);
    if (apiProxyServer) await close(apiProxyServer).catch(() => undefined);
    if (bootstrapServer) await close(bootstrapServer).catch(() => undefined);
    await bootstrap?.close().catch(() => undefined);
    if (idpServer) await close(idpServer).catch(() => undefined);
    if (runtime) await runtime.pool.end().catch(() => undefined);
    if (domainPersistence) await domainPersistence.close().catch(() => undefined);
    if (bootstrapPool) await bootstrapPool.end().catch(() => undefined);
    if (usageDirectory) await rm(usageDirectory, { recursive: true, force: true }).catch(() => undefined);
    if (tlsDirectory) await rm(tlsDirectory, { recursive: true, force: true }).catch(() => undefined);
    restoreFixtureDns?.();
    restoreFixtureTls?.();
    restoreNodeEnv();
    throw error;
  }
}
