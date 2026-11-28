import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { isIPv4 } from 'node:net';
import rateLimit from '@fastify/rate-limit';
import Fastify from 'fastify';
import { jwtVerify, SignJWT } from 'jose';
import { z } from 'zod';
import { verifyAuthSchema } from './auth-schema.js';
import { type BetterAuthRuntimeConfig, createBetterAuthRuntime } from './better-auth.js';
import { readCodexiaEnvironment } from './environment.js';
import { httpContract, httpContractSchemaController } from './http-contract.js';
import { readBetterAuthMigrationConfig } from './migrate-auth.js';
import { grantIsPending, grantMatches, installedSetupOwner, readOwnerSetup, type SetupRegistration } from './owner-setup-store.js';
import { provisionSetupOAuthClients } from './setup-oauth-clients.js';

export const OWNER_SETUP_PATH = '/api/auth/codexia/setup';
const CONTEXT_HEADER = 'x-codexia-setup-transaction';
const TEN_MINUTES = 600;
const RATE_LIMIT_SECONDS = 60;

const profileBody = z
  .object({
    name: z.string().trim().min(1).max(120),
    email: z.email().max(254),
  })
  .strict();
const transactionBody = z.object({
  grantId: z.uuid(),
  sub: z.uuid(),
  exp: z.number().int(),
  profile: profileBody.optional(),
});
const credentialBody = z
  .object({
    response: z.record(z.string(), z.unknown()),
    createSession: z.literal(true).optional(),
  })
  .strict();

export function readOwnerSetupConfig() {
  const redirects = readCodexiaEnvironment('OWNER_SETUP_WEB_REDIRECT_URIS');
  const publicationPeers = readCodexiaEnvironment('OWNER_SETUP_PUBLICATION_PEERS')?.split(',') ?? [];
  if (publicationPeers.some(address => !isIPv4(address)) || new Set(publicationPeers).size !== publicationPeers.length) {
    throw new Error('Setup requires distinct IPv4 publication proxy peers');
  }
  return {
    config: readBetterAuthMigrationConfig(false),
    redirects: redirects?.split(',').map(value => value.trim()) ?? [],
    publicationPeers,
  };
}

function scopedKey(secret: string, purpose: string): Buffer {
  return createHmac('sha256', secret).update(purpose).digest();
}

function createSetupRateLimiter() {
  let windowStart = performance.now();
  let requests = 0;
  // A per-instance ceiling independent of spoofable forwarded IP headers.
  return () => {
    const now = performance.now();
    if (now - windowStart >= RATE_LIMIT_SECONDS * 1000) {
      windowStart = now;
      requests = 0;
    }
    if (requests >= 60) return false;
    requests += 1;
    return true;
  };
}

export function createOwnerSetupApp(
  config: BetterAuthRuntimeConfig,
  webRedirectUris: readonly string[],
  trustedPublicationPeers: readonly string[] = [],
) {
  const origin = new URL(config.publicOrigin);
  const [web, ios] = config.ownerClientIds;
  const introspection = config.oauthIntrospectionClientId;
  const httpFixture = config.allowInsecureLoopbackForTests === true && process.env.NODE_ENV === 'test' && origin.protocol === 'http:';
  if (
    !web ||
    !ios ||
    config.ownerClientIds.length !== 2 ||
    new Set([web, ios, introspection]).size !== 3 ||
    config.oauthIntrospectionClientSecret.length < 32 ||
    config.ownerSubject ||
    config.passkeyBootstrap ||
    config.oidcIssuer ||
    config.mcpClientIds?.length ||
    (config.apiAudience && config.apiAudience !== origin.origin + '/api') ||
    (config.passkeyRpId && config.passkeyRpId !== origin.hostname) ||
    !webRedirectUris.length ||
    webRedirectUris.some(uri => {
      const redirect = new URL(uri);
      return redirect.origin !== origin.origin || redirect.username || redirect.password || redirect.search || redirect.hash;
    }) ||
    new Set(webRedirectUris).size !== webRedirectUris.length
  ) {
    throw new Error('Setup requires the production origin, no existing owner, and three distinct preapproved OAuth clients');
  }

  const app = Fastify({ bodyLimit: 128 * 1024, logger: false, exposeHeadRoutes: false, schemaController: httpContractSchemaController });
  // The setup wire contract is generated from TypeSpec just like the normal API.
  // Register all component IDs because setup operation schemas reference shared
  // components through Fastify `$ref`s.
  for (const schema of httpContract.schemas) app.addSchema(schema);
  function setupRouteSchema(method: 'GET' | 'POST', url: string) {
    const route = httpContract.routes.find(candidate => candidate.method === method && candidate.url === url);
    if (!route) throw new Error(`Missing generated setup route schema: ${method} ${url}`);
    return route.schema;
  }
  // Status polling and setup grant attempts have independent budgets.
  const withinStatusWindow = createSetupRateLimiter();
  const withinAdmissionWindow = createSetupRateLimiter();
  const registration = new AsyncLocalStorage<SetupRegistration>();
  const clientId = new AsyncLocalStorage<string>();
  const provisioningOwner = new AsyncLocalStorage<string>();
  const auth = createBetterAuthRuntime(
    {
      ...config,
      authSecret: scopedKey(config.authSecret, 'codexia:setup-only:better-auth:v1').toString('hex'),
    },
    {
      ownerSetup: () => registration.getStore(),
      setupProvisioningOwner: () => provisioningOwner.getStore(),
      nextClientId() {
        const id = clientId.getStore();
        if (!id) throw new Error('Setup OAuth client is outside the server allowlist');
        return id;
      },
    },
  );

  const transactionKey = scopedKey(config.authSecret, 'codexia:setup-only:transaction:v1');
  const tokenIssuer = origin.origin + OWNER_SETUP_PATH;
  async function signTransaction(grantId: string, subject: string, exp: number, profile?: z.infer<typeof profileBody>) {
    return new SignJWT({ grantId, ...(profile ? { profile } : {}) })
      .setProtectedHeader({ alg: 'HS256', typ: 'codexia-setup+jwt' })
      .setIssuer(tokenIssuer)
      .setAudience('codexia:first-owner')
      .setSubject(subject)
      .setIssuedAt()
      .setExpirationTime(exp)
      .sign(transactionKey);
  }
  async function readTransaction(token: string | string[] | undefined) {
    if (typeof token !== 'string' || token.length > 2048) return undefined;
    try {
      const { payload, protectedHeader } = await jwtVerify(token, transactionKey, {
        algorithms: ['HS256'],
        issuer: tokenIssuer,
        audience: 'codexia:first-owner',
        requiredClaims: ['sub', 'iat', 'exp'],
        maxTokenAge: TEN_MINUTES,
      });
      if (protectedHeader.typ !== 'codexia-setup+jwt') return undefined;
      return {
        ...transactionBody.parse(payload),
        ceremonyContext: createHash('sha256').update(token).digest('base64url'),
      };
    } catch {
      return undefined;
    }
  }

  async function clientsReady(ownerId: string) {
    try {
      await provisionSetupOAuthClients(
        auth,
        clientId,
        new Headers(),
        ownerId,
        { web: web!, ios: ios!, introspection },
        webRedirectUris,
        httpFixture,
        true,
      );
      return true;
    } catch {
      return false;
    }
  }

  async function provisionClients(ownerId: string): Promise<void> {
    // Parallel setup-only replicas and operator retries share this PostgreSQL lock.
    const lock = await auth.pool.connect();
    try {
      await lock.query('BEGIN');
      const claim = await lock.query<{ acquired: boolean }>('SELECT pg_try_advisory_xact_lock(7149924356031231) AS acquired');
      if (!claim.rows[0]?.acquired) throw new Error('Client provisioning is already in progress');
      if ((await installedSetupOwner(auth.pool, undefined)) !== ownerId) throw new Error('Setup owner changed');
      // Use Better Auth's server-only registration operation. The temporary session
      // stays on the server and is removed even if one of the three clients fails.
      const session = await provisioningOwner.run(ownerId, () =>
        auth.auth.api.setupProvisioningSession({
          returnHeaders: true,
        }),
      );
      try {
        const cookie = session.headers
          .getSetCookie()
          .map(value => value.split(';')[0])
          .join('; ');
        await provisionSetupOAuthClients(
          auth,
          clientId,
          new Headers({ cookie, origin: origin.origin }),
          ownerId,
          { web: web!, ios: ios!, introspection },
          webRedirectUris,
          httpFixture,
        );
      } finally {
        await (await auth.auth.$context).internalAdapter.deleteSession(session.response.token);
      }
      await lock.query('COMMIT');
    } catch (error) {
      await lock.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      lock.release();
    }
  }

  // Anonymous requests see enough state to recover from a lost response, no owner
  // identifiers, browser session, OAuth client metadata, or grant metadata.
  app.addHook('onRequest', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
  });
  app.setErrorHandler((error, request, reply) => {
    const failure = z.object({ statusCode: z.number().min(400).max(499) }).safeParse(error);
    const status = failure.success ? failure.data.statusCode : 503;
    if (status === 429) {
      void reply.code(429).send({ code: 'SETUP_RATE_LIMIT' });
      return;
    }
    const validationCode =
      request.url === OWNER_SETUP_PATH + '/authorize'
        ? 'SETUP_KEY_INVALID'
        : request.url === OWNER_SETUP_PATH + '/profile'
          ? 'SETUP_PROFILE_INVALID'
          : 'SETUP_REQUEST_INVALID';
    void reply.code(status).send({ code: status === 503 ? 'SETUP_UNAVAILABLE' : validationCode });
  });
  app.setNotFoundHandler((_request, reply) => reply.code(403).send({ code: 'SETUP_ONLY' }));
  app.addHook('onClose', async () => auth.pool.end());

  app.register(async health => {
    await health.register(rateLimit, {
      global: false,
      addHeaders: { 'retry-after': true, 'x-ratelimit-limit': false, 'x-ratelimit-remaining': false, 'x-ratelimit-reset': false },
      addHeadersOnExceeding: { 'x-ratelimit-limit': false, 'x-ratelimit-remaining': false, 'x-ratelimit-reset': false },
    });
    health.get(
      '/health/ready',
      {
        exposeHeadRoute: false,
        config: {
          rateLimit: {
            max: 60,
            timeWindow: RATE_LIMIT_SECONDS * 1000,
            keyGenerator(request) {
              // Reserve an independent budget for the Quadlet's actual loopback probe.
              const peer = request.raw.socket.remoteAddress?.replace(/^::ffff:/u, '');
              return peer === '127.0.0.1' || peer === '::1' ? 'loopback' : 'network';
            },
          },
        },
      },
      async () => {
        await auth.pool.query('SELECT 1 FROM owner_setup LIMIT 1');
        return { status: 'ready' };
      },
    );
  });

  app.get(
    OWNER_SETUP_PATH + '/status',
    { exposeHeadRoute: false, schema: setupRouteSchema('GET', OWNER_SETUP_PATH + '/status') },
    async (request, reply) => {
      if (request.headers.authorization || (request.headers.origin && request.headers.origin !== origin.origin)) {
        return reply.code(403).send({ code: 'SETUP_SAME_ORIGIN_REQUIRED' });
      }
      if (!withinStatusWindow()) {
        return reply.header('Retry-After', String(RATE_LIMIT_SECONDS)).code(429).send({ code: 'SETUP_RATE_LIMIT' });
      }
      const state = await readOwnerSetup(auth.pool);
      if (!state) return { state: 'blocked' };
      if (state.owner_id && state.consumed_at && state.has_owner_passkey && state.owner_count === 1) {
        return { state: 'owner-enrolled', clientsReady: await clientsReady(state.owner_id) };
      }
      if (state.owner_count || state.consumed_at || state.owner_id) return { state: 'blocked' };
      if (!state.grant_id || !state.expires_at) return { state: 'waiting' };
      return { state: state.expires_at.getTime() > Date.now() ? 'setup-pending' : 'expired' };
    },
  );

  app.register(async setup => {
    setup.addHook('onRequest', async (request, reply) => {
      const fetchSite = request.headers['sec-fetch-site'];
      const browserOrigin =
        request.method === 'GET'
          ? (request.headers.origin ?? (fetchSite === 'same-origin' ? origin.origin : undefined))
          : request.headers.origin;
      const peerAddress = request.raw.socket.remoteAddress?.replace(/^::ffff:/u, '');
      const transportSecure =
        httpFixture ||
        request.protocol === 'https' ||
        (request.headers['x-forwarded-proto'] === 'https' && peerAddress !== undefined && trustedPublicationPeers.includes(peerAddress));
      if (
        !transportSecure ||
        request.headers.host !== origin.host ||
        browserOrigin !== origin.origin ||
        (fetchSite !== undefined && fetchSite !== 'same-origin') ||
        request.headers.authorization !== undefined ||
        (request.method === 'POST' && request.headers['content-type'] !== 'application/json')
      ) {
        return reply.code(403).send({ code: 'SETUP_SAME_ORIGIN_REQUIRED' });
      }
      if (request.url.includes('?')) return reply.code(400).send({ code: 'SETUP_REQUEST_INVALID' });
    });

    setup.post(
      OWNER_SETUP_PATH + '/authorize',
      {
        schema: setupRouteSchema('POST', OWNER_SETUP_PATH + '/authorize'),
        async onRequest(_request, reply) {
          if (!withinAdmissionWindow()) {
            return reply.header('Retry-After', String(RATE_LIMIT_SECONDS)).code(429).send({ code: 'SETUP_RATE_LIMIT' });
          }
        },
      },
      async (request, reply) => {
        const input = request.body as { key: string };
        const state = await readOwnerSetup(auth.pool);
        if (!grantMatches(state, input.key)) return reply.code(403).send({ code: 'SETUP_KEY_INVALID' });
        const expires = Math.min(Math.floor(state.expires_at.getTime() / 1000), Math.floor(Date.now() / 1000) + TEN_MINUTES);
        return { transaction: await signTransaction(state.grant_id, randomUUID(), expires) };
      },
    );

    setup.post(
      OWNER_SETUP_PATH + '/profile',
      { schema: setupRouteSchema('POST', OWNER_SETUP_PATH + '/profile') },
      async (request, reply) => {
        const tx = await readTransaction(request.headers[CONTEXT_HEADER]);
        if (!tx || tx.profile) return reply.code(403).send({ code: 'SETUP_TRANSACTION_INVALID' });
        const input = request.body as z.infer<typeof profileBody>;
        if (!grantIsPending(await readOwnerSetup(auth.pool), tx.grantId)) {
          return reply.code(409).send({ code: 'SETUP_CLOSED' });
        }
        return { transaction: await signTransaction(tx.grantId, tx.sub, tx.exp, input) };
      },
    );

    async function ceremony(method: 'GET' | 'POST', token: string | string[] | undefined, cookie: string | undefined, body: unknown) {
      const tx = await readTransaction(token);
      if (!tx?.profile) return new Response(null, { status: 403 });
      if (!grantIsPending(await readOwnerSetup(auth.pool), tx.grantId)) return new Response(null, { status: 409 });
      const generate = method === 'GET';
      const path = generate ? '/api/auth/passkey/generate-register-options' : '/api/auth/passkey/verify-registration';
      const url = new URL(path, origin);
      const input = generate ? undefined : credentialBody.safeParse(body);
      if (input?.error) return new Response(null, { status: 400 });
      if (generate) url.searchParams.set('context', tx.ceremonyContext);
      const headers = new Headers({ origin: origin.origin, 'sec-fetch-site': 'same-origin' });
      if (cookie) headers.set('cookie', cookie);
      if (!generate) headers.set('content-type', 'application/json');
      return registration.run(
        {
          ...tx.profile,
          grantId: tx.grantId,
          ownerId: tx.sub,
          ceremonyContext: tx.ceremonyContext,
        },
        () =>
          auth.auth.handler(
            new Request(url, {
              method,
              headers,
              ...(!generate && input?.success
                ? {
                    body: JSON.stringify({ ...input.data, createSession: true }),
                  }
                : {}),
            }),
          ),
      );
    }

    setup.get('/api/auth/passkey/generate-register-options', { exposeHeadRoute: false }, async (request, reply) => {
      const result = await ceremony('GET', request.headers[CONTEXT_HEADER], request.headers.cookie, undefined);
      if (!result.ok) return reply.code(result.status).send({ code: 'SETUP_CEREMONY_UNAVAILABLE' });
      return reply.header('Set-Cookie', result.headers.getSetCookie()).send(await result.json());
    });
    setup.post('/api/auth/passkey/verify-registration', async (request, reply) => {
      const result = await ceremony('POST', request.headers[CONTEXT_HEADER], request.headers.cookie, request.body);
      if (!result.ok) {
        const status = result.status === 409 || result.status === 403 ? result.status : 400;
        return reply.code(status).send({ code: 'SETUP_PASSKEY_UNVERIFIED' });
      }
      // Never return Better Auth's credential or raw session token to the browser.
      return reply.header('Set-Cookie', result.headers.getSetCookie()).send({ enrolled: true });
    });

    setup.post(
      OWNER_SETUP_PATH + '/complete',
      { schema: setupRouteSchema('POST', OWNER_SETUP_PATH + '/complete') },
      async (request, reply) => {
        const tx = await readTransaction(request.headers[CONTEXT_HEADER]);
        const state = await readOwnerSetup(auth.pool);
        if (
          !tx?.profile ||
          state?.grant_id !== tx.grantId ||
          state.owner_id !== tx.sub ||
          !state.consumed_at ||
          !state.has_owner_passkey ||
          state.owner_count !== 1
        ) {
          return reply.code(403).send({ code: 'SETUP_TRANSACTION_INVALID' });
        }
        const headers = auth.toHeaders(request.headers);
        const session = await auth.auth.api.getSession({ headers });
        const sessionConfirmed = session?.user.id === state.owner_id;
        // The winning signed transaction can retry after a committed response was
        // lost. It cannot sign in to anything or select the clients to provision.
        if (!(await clientsReady(state.owner_id))) await provisionClients(state.owner_id);
        return { state: 'owner-enrolled', clientsReady: true, sessionConfirmed };
      },
    );
  });

  return Object.assign(app, {
    async verifySchema() {
      await verifyAuthSchema(auth.pool, true);
    },
    async prepareActivation() {
      const ownerId = await installedSetupOwner(auth.pool, undefined);
      // Explicit operator retry also covers an expired browser transaction.
      await provisionClients(ownerId);
      return ownerId;
    },
  });
}
