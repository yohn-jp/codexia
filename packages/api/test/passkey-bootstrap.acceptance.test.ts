import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { initializeFreshPostgresSchema, inspectFreshPostgresSchema } from '@codexia/persistence-postgres';
import { type Browser, type BrowserContext, type CDPSession, chromium, expect, type Page } from '@playwright/test';
import type { LightMyRequestResponse } from 'fastify';
import { Pool } from 'pg';
import { verifyAuthSchema } from '../src/auth-schema.js';
import { type BetterAuthRuntimeConfig, CODEXIA_OWNER_SCOPE, createBetterAuthRuntime } from '../src/better-auth.js';
import { migrateBetterAuth } from '../src/migrate-auth.js';
import { createOwnerSetupApp } from '../src/owner-setup.js';
import { installedSetupOwner, issueOwnerSetupGrant } from '../src/owner-setup-store.js';
import { type ApiServerOptions, createServer as createApiServer } from '../src/server.js';
import { assertDisposableAuthFixtureDatabaseUrl } from './fixtures/better-auth-server.js';

const grantIdentifier = 'codexia:first-owner-passkey:v1';
const grantContext = 'codexia-first-owner-v1';
const authRuntimeRole = 'codexia_auth_runtime';

interface HttpFixture {
  readonly origin: string;
  readonly server: HttpServer;
  close(): Promise<void>;
}

interface RegistrationAttempt {
  readonly optionsStatus: number;
  readonly rpId?: string;
  readonly userVerification?: string;
  readonly verifyStatus?: number;
  readonly response?: Record<string, unknown>;
}

const virtualAuthenticators = new WeakMap<Page, { readonly session: CDPSession; readonly authenticatorId: string }>();

function listen(server: HttpServer, port = 0): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, () => {
      server.removeListener('error', reject);
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('Passkey fixture did not bind a TCP port'));
      resolve(address.port);
    });
  });
}

function close(server: HttpServer): Promise<void> {
  return new Promise((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
}

async function bodyChunks(request: import('node:http').IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function send(response: import('node:http').ServerResponse, status: number, body: Buffer, headers?: Headers): void {
  const outputHeaders: Record<string, string | string[]> = headers ? Object.fromEntries(headers.entries()) : {};
  const cookies = headers?.getSetCookie() ?? [];
  if (cookies.length) outputHeaders['set-cookie'] = cookies;
  response.writeHead(status, outputHeaders);
  response.end(body);
}

async function startRuntimeHttpFixture(
  config: BetterAuthRuntimeConfig,
  bootstrap?: { readonly nextClientId: () => string },
): Promise<{
  readonly runtime: ReturnType<typeof createBetterAuthRuntime>;
  readonly fixture: HttpFixture;
}> {
  const runtime = createBetterAuthRuntime(config, bootstrap);
  const server = createHttpServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? '/', config.publicOrigin);
      if (url.pathname === '/') {
        send(
          response,
          200,
          Buffer.from('<!doctype html><html><body><h1>Passkey acceptance fixture</h1></body></html>'),
          new Headers({ 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }),
        );
        return;
      }
      const headers = new Headers();
      for (const [name, value] of Object.entries(request.headers)) {
        if (name === 'host' || name === 'connection' || value === undefined) continue;
        if (Array.isArray(value)) for (const item of value) headers.append(name, item);
        else headers.set(name, value);
      }
      const body = await bodyChunks(request);
      const method = request.method ?? 'GET';
      const authRequest = new Request(url, {
        method,
        headers,
        ...(body.length && method !== 'GET' && method !== 'HEAD' ? { body: body.toString('utf8') } : {}),
      });
      const authResponse = await runtime.handler(authRequest);
      send(response, authResponse.status, Buffer.from(await authResponse.arrayBuffer()), authResponse.headers);
    })().catch(() => {
      if (!response.headersSent) response.writeHead(500, { 'cache-control': 'no-store' });
      response.end('Passkey fixture request failed');
    });
  });
  const origin = config.publicOrigin;
  const port = Number(new URL(origin).port);
  assert.ok(port > 0);
  await listen(server, port);
  return {
    runtime,
    fixture: {
      origin,
      server,
      close: () => close(server),
    },
  };
}

async function attachVirtualAuthenticator(
  context: BrowserContext,
  page: Page,
  hasUserVerification = true,
): Promise<{ readonly session: CDPSession; readonly authenticatorId: string }> {
  const session = await context.newCDPSession(page);
  await session.send('WebAuthn.enable');
  const result = await session.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification,
      isUserVerified: hasUserVerification,
      automaticPresenceSimulation: true,
    },
  });
  return { session, authenticatorId: result.authenticatorId };
}

async function newPasskeyPage(browser: Browser, contexts: BrowserContext[], origin: string): Promise<Page> {
  const context = await browser.newContext();
  contexts.push(context);
  const page = await context.newPage();
  await page.goto(origin);
  virtualAuthenticators.set(page, await attachVirtualAuthenticator(context, page));
  return page;
}

async function registerPasskey(
  page: Page,
  token: string,
  options: {
    readonly createSession?: boolean;
    readonly setup?: boolean;
    readonly hold?: boolean;
    readonly tamper?: 'origin' | 'challenge' | 'rp' | 'userVerification';
    readonly rpId?: string;
  } = {},
): Promise<RegistrationAttempt> {
  return page.evaluate(
    async ({ token, createSession, setup, hold, tamper, rpId, context }) => {
      const header = setup ? 'x-codexia-setup-transaction' : 'x-codexia-owner-enrollment';
      const query = setup ? '' : '?context=' + encodeURIComponent(context);
      const optionsResponse = await fetch('/api/auth/passkey/generate-register-options' + query, {
        method: 'GET',
        headers: { [header]: token },
        credentials: 'same-origin',
      });
      if (!optionsResponse.ok) return { optionsStatus: optionsResponse.status };
      const options = (await optionsResponse.json()) as {
        rp?: { id?: string };
        authenticatorSelection?: { userVerification?: string };
      };
      const publicKey = PublicKeyCredential.parseCreationOptionsFromJSON(options as never);
      if (rpId) publicKey.rp.id = rpId;
      const credential = await navigator.credentials.create({ publicKey });
      if (!(credential instanceof PublicKeyCredential)) throw new Error('Virtual authenticator did not create a credential');
      const encoded = { ...credential.toJSON() };
      if (
        !('attestationObject' in encoded.response) ||
        typeof encoded.response.attestationObject !== 'string' ||
        typeof encoded.response.clientDataJSON !== 'string'
      ) {
        throw new Error('Virtual authenticator did not return an attestation response');
      }
      if (tamper === 'origin' || tamper === 'challenge') {
        const bytes = Uint8Array.from(atob(encoded.response.clientDataJSON.replaceAll('-', '+').replaceAll('_', '/')), character =>
          character.charCodeAt(0),
        );
        const clientData = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
        if (tamper === 'origin') clientData.origin = 'https://wrong.codexia.test';
        if (tamper === 'challenge') clientData.challenge = 'not-the-issued-challenge';
        const json = new TextEncoder().encode(JSON.stringify(clientData));
        let binary = '';
        for (const byte of json) binary += String.fromCharCode(byte);
        encoded.response.clientDataJSON = btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
      }
      if (tamper === 'rp' || tamper === 'userVerification') {
        const bytes = Uint8Array.from(atob(encoded.response.attestationObject.replaceAll('-', '+').replaceAll('_', '/')), character =>
          character.charCodeAt(0),
        );
        const key = new TextEncoder().encode('authData');
        let keyOffset = -1;
        for (let offset = 0; offset <= bytes.length - key.length; offset++) {
          if (key.every((value, index) => bytes[offset + index] === value)) {
            keyOffset = offset;
            break;
          }
        }
        if (keyOffset < 0) throw new Error('Attestation omitted authenticator data');
        const headerOffset = keyOffset + key.length;
        const header = bytes[headerOffset]!;
        if (header >> 5 !== 2) throw new Error('Attestation authenticator data is not a CBOR byte string');
        const extra = header & 31;
        const lengthBytes = extra < 24 ? 0 : extra === 24 ? 1 : extra === 25 ? 2 : extra === 26 ? 4 : 8;
        const dataOffset = headerOffset + 1 + lengthBytes;
        if (bytes.length < dataOffset + 37) throw new Error('Attestation authenticator data is truncated');
        if (tamper === 'rp') {
          bytes.fill(0, dataOffset, dataOffset + 32);
        } else {
          const flagsOffset = dataOffset + 32;
          if ((bytes[flagsOffset]! & 0x04) === 0) throw new Error('Virtual authenticator did not set the user-verification flag');
          bytes[flagsOffset] = bytes[flagsOffset]! & ~0x04;
        }
        let binary = '';
        for (const byte of bytes) binary += String.fromCharCode(byte);
        encoded.response.attestationObject = btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
      }
      const verified = hold
        ? undefined
        : await fetch('/api/auth/passkey/verify-registration', {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              [header]: token,
            },
            credentials: 'same-origin',
            // Better Auth 1.7.26 leaves createSession undefined by default; the
            // owner bootstrap deliberately requires its transactional true path.
            body: JSON.stringify({ response: encoded, createSession: createSession ?? true }),
          });
      return {
        optionsStatus: optionsResponse.status,
        rpId: options.rp?.id,
        userVerification: options.authenticatorSelection?.userVerification,
        ...(verified ? { verifyStatus: verified.status } : {}),
        response: encoded,
      };
    },
    {
      token,
      createSession: options.createSession,
      setup: options.setup,
      hold: options.hold,
      tamper: options.tamper,
      rpId: options.rpId,
      context: grantContext,
    },
  );
}

async function authenticatePasskey(
  page: Page,
  persistedCredentialId: string,
): Promise<{
  readonly optionsStatus: number;
  readonly verifyStatus?: number;
  readonly verifyCode?: string;
  readonly credentialId?: string;
  readonly allowedCredentialIds?: readonly string[];
}> {
  return page.evaluate(
    async ({ persistedCredentialId }) => {
      const optionsResponse = await fetch('/api/auth/passkey/generate-authenticate-options', {
        credentials: 'same-origin',
      });
      if (!optionsResponse.ok) return { optionsStatus: optionsResponse.status };
      const options = await optionsResponse.json();
      const publicKey = PublicKeyCredential.parseRequestOptionsFromJSON(options);
      const allowedCredentialIds =
        publicKey.allowCredentials?.map(({ id }) => {
          let binary = '';
          const bytes = id instanceof ArrayBuffer ? new Uint8Array(id) : new Uint8Array(id.buffer, id.byteOffset, id.byteLength);
          for (const byte of bytes) binary += String.fromCharCode(byte);
          return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
        }) ?? [];
      // Select the persisted credential only when the server allows discovery.
      if (allowedCredentialIds.length === 0) {
        const binaryId = atob(persistedCredentialId.replaceAll('-', '+').replaceAll('_', '/'));
        publicKey.allowCredentials = [
          {
            type: 'public-key',
            id: Uint8Array.from(binaryId, character => character.charCodeAt(0)).buffer,
          },
        ];
      }
      const credential = await navigator.credentials.get({ publicKey });
      if (!(credential instanceof PublicKeyCredential)) throw new Error('Virtual authenticator did not return a credential');
      const response = await fetch('/api/auth/passkey/verify-authentication', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ response: credential.toJSON() }),
      });
      const result = (await response.json().catch(() => ({}))) as { code?: unknown; status?: unknown };
      const verifyCode = [result.code, result.status].filter((value): value is string => typeof value === 'string').join(':');
      return {
        optionsStatus: optionsResponse.status,
        verifyStatus: response.status,
        ...(verifyCode ? { verifyCode } : {}),
        credentialId: credential.id,
        allowedCredentialIds,
      };
    },
    { persistedCredentialId },
  );
}

function cliEnv(
  databaseUrl: string,
  publicOrigin: string,
  authSecret: string,
  owner: { id: string; email: string; name: string },
): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  for (const suffix of ['ISSUER', 'CLIENT_ID', 'CLIENT_SECRET']) {
    delete environment[`CODEXIA_OIDC_${suffix}`];
  }
  Object.assign(environment, {
    CODEXIA_AUTH_DATABASE_URL: databaseUrl,
    CODEXIA_PUBLIC_ORIGIN: publicOrigin,
    CODEXIA_AUTH_SECRET: authSecret,
    CODEXIA_OAUTH_INTROSPECTION_CLIENT_ID: 'passkey-fixture-introspector',
    CODEXIA_OAUTH_INTROSPECTION_CLIENT_SECRET: 'passkey-fixture-introspection-secret-over-32-bytes',
    CODEXIA_OAUTH_OWNER_CLIENT_IDS: 'passkey-fixture-web,passkey-fixture-ios',
    CODEXIA_AUTH_PASSKEY_BOOTSTRAP_OWNER_ID: owner.id,
    CODEXIA_AUTH_PASSKEY_BOOTSTRAP_OWNER_EMAIL: owner.email,
    CODEXIA_AUTH_PASSKEY_BOOTSTRAP_OWNER_NAME: owner.name,
    CODEXIA_API_AUDIENCE: `${publicOrigin}/api`,
  });
  return environment;
}

function runPackageCli(
  command: 'migrate-auth' | 'grant-passkey-owner' | 'grant-passkey-owner-recovery' | 'verify-auth-clients' | 'owner-setup-operator',
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
} {
  const script = new URL(`../dist/${command}.js`, import.meta.url);
  const result = spawnSync(process.execPath, [script.pathname, ...args], {
    cwd: new URL('..', import.meta.url).pathname,
    env,
    encoding: 'utf8',
    timeout: 30_000,
  });
  return {
    status: result.status,
    stdout: String(result.stdout ?? ''),
    stderr: String(result.stderr ?? ''),
  };
}

function parseGrant(stdout: string): {
  readonly enrollmentToken: string;
  readonly expiresInSeconds: number;
  readonly ownerId: string;
  readonly setupPath: string;
} {
  try {
    return JSON.parse(stdout) as { enrollmentToken: string; expiresInSeconds: number; ownerId: string; setupPath: string };
  } catch {
    throw new Error('Passkey grant CLI did not return its documented JSON result');
  }
}

test('Better Auth 1.7.26 accepts only one operator-granted first owner and preserves the owner through restart', {
  timeout: 240_000,
  skip:
    process.env.CODEXIA_PASSKEY_ACCEPTANCE === '1'
      ? false
      : 'Requires the dedicated Chromium + disposable PostgreSQL acceptance lane; run test:passkey-acceptance.',
}, async t => {
  const databaseUrl = process.env.CODEXIA_AUTH_TEST_DATABASE_URL;
  assert.equal(process.env.CODEXIA_AUTH_TEST_DISPOSABLE, '1', 'virtual WebAuthn acceptance needs an explicitly disposable auth database');
  assert.ok(databaseUrl, 'CODEXIA_AUTH_TEST_DATABASE_URL must name a disposable PostgreSQL database');
  assertDisposableAuthFixtureDatabaseUrl(databaseUrl);

  const previousNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'test';
  const authSecret = randomBytes(32).toString('base64url');
  const owner = { id: `fixture-owner-${randomUUID()}`, email: `owner-${randomUUID()}@example.test`, name: 'Codexia Acceptance Owner' };
  const authPortProbe = createHttpServer();
  let adminPool: Pool | undefined;
  let createdAuthRole = false;
  let runtime: ReturnType<typeof createBetterAuthRuntime> | undefined;
  let apiFixture: HttpFixture | undefined;
  let bootstrapRuntime: ReturnType<typeof createBetterAuthRuntime> | undefined;
  let authorApiServer: HttpServer | undefined;
  let authorApiUsageDirectory: string | undefined;
  let browser: Browser | undefined;
  const contexts: BrowserContext[] = [];

  t.after(async () => {
    for (const context of contexts) await context.close().catch(() => undefined);
    if (browser) await browser.close().catch(() => undefined);
    if (authorApiServer) await close(authorApiServer).catch(() => undefined);
    if (authorApiUsageDirectory) await rm(authorApiUsageDirectory, { recursive: true, force: true }).catch(() => undefined);
    if (bootstrapRuntime) await bootstrapRuntime.pool.end().catch(() => undefined);
    if (apiFixture) await apiFixture.close().catch(() => undefined);
    if (runtime) await runtime.pool.end().catch(() => undefined);
    if (adminPool) {
      await adminPool.query('DROP SCHEMA IF EXISTS codexia_auth CASCADE').catch(() => undefined);
      if (createdAuthRole) await adminPool.query(`DROP ROLE IF EXISTS ${authRuntimeRole}`).catch(() => undefined);
      await adminPool.end().catch(() => undefined);
    }
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
  });

  const database = new URL(databaseUrl);
  const rolePassword = randomBytes(32).toString('base64url');
  adminPool = new Pool({ connectionString: databaseUrl });
  await adminPool.query('DROP SCHEMA IF EXISTS codexia_auth CASCADE');
  const roleExists = await adminPool.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [authRuntimeRole]);
  assert.equal(roleExists.rowCount, 0, 'the dedicated acceptance PostgreSQL cluster must not already use codexia_auth_runtime');
  await adminPool.query(`CREATE ROLE ${authRuntimeRole} LOGIN PASSWORD '${rolePassword}' NOSUPERUSER NOCREATEDB NOCREATEROLE`);
  createdAuthRole = true;
  await adminPool.query(`CREATE SCHEMA codexia_auth AUTHORIZATION ${authRuntimeRole}`);
  const runtimeDatabase = new URL(databaseUrl);
  runtimeDatabase.username = authRuntimeRole;
  runtimeDatabase.password = rolePassword;

  const authOriginProbePort = await listen(authPortProbe);
  await close(authPortProbe);
  const apiOrigin = `http://localhost:${authOriginProbePort}`;
  const migrationEnvironment = cliEnv(runtimeDatabase.toString(), 'https://codexia-passkey-acceptance.example.test', authSecret, owner);
  const unappliedMigration = runPackageCli('migrate-auth', [], migrationEnvironment);
  assert.notEqual(unappliedMigration.status, 0, 'auth schema migration must require --apply');
  const migration = runPackageCli('migrate-auth', ['--apply'], migrationEnvironment);
  assert.equal(migration.status, 0, 'OIDC-free explicit auth migration must succeed against the disposable PostgreSQL schema');
  const readOnlyPool = new Pool({
    connectionString: runtimeDatabase.toString(),
    options: '-c search_path=codexia_auth -c default_transaction_read_only=on',
  });
  try {
    await verifyAuthSchema(readOnlyPool);
    const candidateAudience = 'https://auth-preflight.example.test/api';
    const preflight = runPackageCli('verify-auth-clients', [], { ...migrationEnvironment, CODEXIA_API_AUDIENCE: candidateAudience });
    assert.notEqual(preflight.status, 0, 'an unregistered owner cannot be deployed');
    const seeded = await readOnlyPool.query('SELECT 1 FROM codexia_auth."oauthResource" WHERE identifier = $1', [candidateAudience]);
    assert.equal(seeded.rowCount, 0, 'candidate verification must not seed resources into the installed auth database');
  } finally {
    await readOnlyPool.end();
  }

  const grantWithoutApply = runPackageCli('grant-passkey-owner', [], migrationEnvironment);
  assert.notEqual(grantWithoutApply.status, 0, 'operator grant command must require --apply');
  const grantResult = runPackageCli('grant-passkey-owner', ['--apply'], migrationEnvironment);
  assert.equal(grantResult.status, 0, 'operator grant command must create a grant with OIDC settings absent');
  const grant = parseGrant(grantResult.stdout.trim());
  assert.equal(grant.ownerId, owner.id);
  assert.equal(grant.expiresInSeconds, 600);
  assert.equal(grant.setupPath, '/passkey');
  assert.equal(/^[A-Za-z0-9_-]{43}$/u.test(grant.enrollmentToken), true, 'grant must be 32 random bytes encoded as base64url');

  const bootstrapConfig: BetterAuthRuntimeConfig = {
    databaseUrl: runtimeDatabase.toString(),
    publicOrigin: apiOrigin,
    apiAudience: migrationEnvironment.CODEXIA_API_AUDIENCE!,
    authSecret,
    oauthIntrospectionClientId: 'passkey-fixture-introspector',
    oauthIntrospectionClientSecret: 'passkey-fixture-introspection-secret-over-32-bytes',
    ownerClientIds: ['passkey-fixture-web', 'passkey-fixture-ios'],
    passkeyBootstrap: { ownerId: owner.id, ownerEmail: owner.email, ownerName: owner.name },
    allowInsecureLoopbackForTests: true,
  };
  const registrationId = new AsyncLocalStorage<string>();
  const started = await startRuntimeHttpFixture(bootstrapConfig, {
    nextClientId() {
      const id = registrationId.getStore();
      if (!id) throw new Error('OAuth acceptance client creation omitted its approved ID');
      return id;
    },
  });
  bootstrapRuntime = started.runtime;
  apiFixture = started.fixture;
  assert.equal(apiFixture.origin, apiOrigin);

  const context = await bootstrapRuntime.auth.$context;
  const persistedGrant = await context.internalAdapter.findVerificationValue(grantIdentifier);
  assert.ok(persistedGrant);
  assert.equal(
    persistedGrant.value === createHash('sha256').update(grant.enrollmentToken).digest('hex'),
    true,
    'the database must retain only the SHA-256 grant digest',
  );
  assert.equal(persistedGrant.value !== grant.enrollmentToken, true, 'the database must not retain the raw grant');
  assert.ok(persistedGrant.expiresAt.getTime() > Date.now());
  assert.ok(persistedGrant.expiresAt.getTime() <= Date.now() + 10 * 60 * 1000);
  await assert.rejects(bootstrapRuntime.createPasskeyBootstrapGrant(), /already active/u);

  const invalidGrantUpdate = await context.adapter.findMany({ model: 'user', limit: 1 });
  assert.equal(invalidGrantUpdate.length, 0);
  browser = await chromium.launch({
    headless: true,
    ...(process.env.CODEXIA_E2E_CHROMIUM ? { executablePath: process.env.CODEXIA_E2E_CHROMIUM } : {}),
  });
  const browserContext = await browser.newContext();
  contexts.push(browserContext);
  const page = await browserContext.newPage();
  await page.goto(apiOrigin);
  virtualAuthenticators.set(page, await attachVirtualAuthenticator(browserContext, page));

  const noGrant = await page.evaluate(async () => {
    const response = await fetch(`/api/auth/passkey/generate-register-options?context=${encodeURIComponent('codexia-first-owner-v1')}`);
    return response.status;
  });
  assert.ok(noGrant >= 400, 'public registration options must fail without an operator grant');
  const wrongGrant = await page.evaluate(
    async ({ token }) => {
      const response = await fetch(`/api/auth/passkey/generate-register-options?context=${encodeURIComponent('codexia-first-owner-v1')}`, {
        headers: { 'x-codexia-owner-enrollment': token },
      });
      return response.status;
    },
    { token: `${grant.enrollmentToken}wrong` },
  );
  assert.ok(wrongGrant >= 400, 'a forged owner grant must fail');
  const publicSignup = await page.evaluate(async () => {
    const response = await fetch('/api/auth/sign-up/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Public Signup', email: 'public@example.test', password: 'not-a-real-password' }),
    });
    return response.status;
  });
  assert.ok(publicSignup >= 400, 'public account signup must be unavailable');

  const missingContext = await page.evaluate(
    async ({ token }) => {
      const response = await fetch('/api/auth/passkey/generate-register-options', {
        headers: { 'x-codexia-owner-enrollment': token },
      });
      return response.status;
    },
    { token: grant.enrollmentToken },
  );
  assert.ok(missingContext >= 400, 'the bootstrap grant must be bound to the required context');

  await context.adapter.update({
    model: 'verification',
    where: [{ field: 'identifier', value: grantIdentifier }],
    update: { expiresAt: new Date(Date.now() - 1_000) },
  });
  const expiredRecord = await context.internalAdapter.findVerificationValue(grantIdentifier);
  assert.ok(expiredRecord && expiredRecord.expiresAt.getTime() < Date.now());
  const expiredOptions = await page.evaluate(
    async ({ token, context }) => {
      const response = await fetch(`/api/auth/passkey/generate-register-options?context=${encodeURIComponent(context)}`, {
        headers: { 'x-codexia-owner-enrollment': token },
      });
      return response.status;
    },
    { token: grant.enrollmentToken, context: grantContext },
  );
  assert.ok(expiredOptions >= 400, 'expired operator grants must not create registration challenges');
  const replacementResult = runPackageCli('grant-passkey-owner', ['--apply'], migrationEnvironment);
  assert.equal(replacementResult.status, 0, 'an expired grant may be replaced while no owner exists');
  const replacementGrant = parseGrant(replacementResult.stdout.trim());
  assert.equal(replacementGrant.enrollmentToken !== grant.enrollmentToken, true, 'an expired grant replacement must be fresh');

  const wrongOrigin = await registerPasskey(page, replacementGrant.enrollmentToken, { tamper: 'origin' });
  assert.equal(wrongOrigin.optionsStatus, 200);
  assert.equal(wrongOrigin.rpId, 'localhost');
  assert.equal(wrongOrigin.userVerification, 'required');
  assert.ok((wrongOrigin.verifyStatus ?? 0) >= 400, 'a response from a wrong origin must fail');
  assert.equal((await context.adapter.findMany({ model: 'user', limit: 1 })).length, 0);

  const wrongChallengePage = await newPasskeyPage(browser, contexts, apiOrigin);
  const wrongChallenge = await registerPasskey(wrongChallengePage, replacementGrant.enrollmentToken, { tamper: 'challenge' });
  assert.equal(wrongChallenge.optionsStatus, 200);
  assert.ok((wrongChallenge.verifyStatus ?? 0) >= 400, 'an assertion with a changed challenge must fail');

  const wrongRpPage = await newPasskeyPage(browser, contexts, apiOrigin);
  const wrongRp = await registerPasskey(wrongRpPage, replacementGrant.enrollmentToken, { tamper: 'rp' });
  assert.equal(wrongRp.optionsStatus, 200);
  assert.ok((wrongRp.verifyStatus ?? 0) >= 400, 'a credential bound to a different valid RP ID must fail');

  const noUvPage = await newPasskeyPage(browser, contexts, apiOrigin);
  const noUv = await registerPasskey(noUvPage, replacementGrant.enrollmentToken, { tamper: 'userVerification' });
  assert.equal(noUv.optionsStatus, 200);
  assert.equal(noUv.userVerification, 'required');
  assert.ok((noUv.verifyStatus ?? 0) >= 400, 'an authenticator response without user verification must fail server verification');

  const noSessionPage = await newPasskeyPage(browser, contexts, apiOrigin);
  const noSession = await registerPasskey(noSessionPage, replacementGrant.enrollmentToken, { createSession: false });
  assert.equal(noSession.optionsStatus, 200);
  assert.ok((noSession.verifyStatus ?? 0) >= 400, 'bootstrap registration must reject createSession=false');
  assert.equal((await context.adapter.findMany({ model: 'user', limit: 1 })).length, 0);
  assert.equal((await context.adapter.findMany({ model: 'passkey' })).length, 0);

  // Keep rejected attestations out of the authenticators participating in the
  // race: WebAuthn creates a local credential before the server accepts it.
  const raceFirstPage = await newPasskeyPage(browser!, contexts, apiOrigin);
  const secondPage = await newPasskeyPage(browser!, contexts, apiOrigin);
  const race = await Promise.all([
    registerPasskey(raceFirstPage, replacementGrant.enrollmentToken),
    registerPasskey(secondPage, replacementGrant.enrollmentToken),
  ]);
  assert.deepEqual(
    race.map(attempt => attempt.optionsStatus),
    [200, 200],
  );
  const winners = race.filter(attempt => attempt.verifyStatus === 200);
  assert.equal(winners.length, 1, 'only one concurrent attestation may consume the owner grant');
  const winnerIndex = race.findIndex(attempt => attempt.verifyStatus === 200);
  const winnerPage = winnerIndex === 0 ? raceFirstPage : secondPage;
  const winnerResponse = winners[0]!.response;
  assert.ok(winnerResponse);
  assert.ok(
    race.some(attempt => (attempt.verifyStatus ?? 0) >= 400),
    'the losing attestation must fail closed',
  );

  const users = await context.adapter.findMany({ model: 'user' });
  const passkeys = await context.adapter.findMany({ model: 'passkey' });
  assert.equal(users.length, 1);
  assert.equal((users[0] as { id?: string }).id, owner.id, 'the passkey must create the operator-selected internal owner ID');
  assert.equal(passkeys.length, 1);
  assert.equal((passkeys[0] as { userId?: string }).userId, owner.id, 'the passkey must attach to the canonical owner');
  const persistedCredentialId = (passkeys[0] as { credentialID?: string }).credentialID;
  assert.equal(
    persistedCredentialId,
    (winnerResponse as { id?: string }).id,
    'the single persisted passkey must be the credential returned by the winning virtual authenticator',
  );

  const replay = await winnerPage.evaluate(
    async ({ token, response }) => {
      const result = await fetch('/api/auth/passkey/verify-registration', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-codexia-owner-enrollment': token },
        credentials: 'same-origin',
        body: JSON.stringify({ response, createSession: true }),
      });
      return result.status;
    },
    { token: replacementGrant.enrollmentToken, response: winnerResponse },
  );
  assert.ok(replay >= 400, 'a consumed registration challenge must not replay');
  await assert.rejects(bootstrapRuntime.createPasskeyBootstrapGrant(), /empty authentication database/u);

  const authenticated = await winnerPage.evaluate(async () => {
    const response = await fetch('/api/auth/get-session', { credentials: 'same-origin' });
    const result = (await response.json()) as { user?: { id?: string } };
    return { status: response.status, userId: result.user?.id };
  });
  assert.equal(authenticated.status, 200);
  assert.equal(authenticated.userId, owner.id);

  const sessionCookies = await winnerPage.context().cookies(apiOrigin);
  const ownerCookie = sessionCookies.map(({ name, value }) => `${name}=${value}`).join('; ');
  assert.ok(ownerCookie, 'passkey registration must create an owner session usable for OAuth client setup');
  const ownerHeaders = new Headers({ cookie: ownerCookie, origin: apiOrigin });
  const webClientId = bootstrapConfig.ownerClientIds[0]!;
  const iosClientId = bootstrapConfig.ownerClientIds[1]!;
  const oauthRuntime = bootstrapRuntime;
  const registerOAuthClient = async (
    clientId: string,
    body: NonNullable<Parameters<NonNullable<typeof oauthRuntime.auth.api.adminCreateOAuthClient>>[0]>['body'],
  ) => registrationId.run(clientId, () => oauthRuntime.auth.api.adminCreateOAuthClient({ headers: ownerHeaders, body }));
  const ownerScope = `openid ${CODEXIA_OWNER_SCOPE} offline_access`;
  const webClient = await registerOAuthClient(webClientId, {
    client_name: 'Codexia Acceptance Web',
    redirect_uris: [`${apiOrigin}/desktop`],
    resources: [oauthRuntime.audience],
    scope: ownerScope,
    token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    application_type: 'native',
    require_pkce: true,
    skip_consent: false,
  });
  assert.equal(webClient.client_id, webClientId);
  const iosClient = await registerOAuthClient(iosClientId, {
    client_name: 'Codexia Acceptance iOS',
    redirect_uris: ['jp.yohn.codexia:/oauth2redirect'],
    resources: [oauthRuntime.audience],
    scope: ownerScope,
    token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    application_type: 'native',
    require_pkce: true,
    skip_consent: false,
  });
  assert.equal(iosClient.client_id, iosClientId);
  const introspectionClient = await registerOAuthClient(bootstrapConfig.oauthIntrospectionClientId, {
    client_name: 'Codexia Acceptance API introspection',
    redirect_uris: [`${new URL(oauthRuntime.audience).origin}/oauth/introspection`],
    resources: [oauthRuntime.audience],
    scope: 'openid',
    token_endpoint_auth_method: 'client_secret_post',
    grant_types: ['authorization_code'],
    response_types: ['code'],
    application_type: 'native',
    require_pkce: true,
    skip_consent: true,
  });
  assert.equal(introspectionClient.client_id, bootstrapConfig.oauthIntrospectionClientId);
  await oauthRuntime.assertRegisteredClients(owner.id);
  await oauthRuntime.verifyIntrospectionCredentials();
  const admitted = runPackageCli('verify-auth-clients', [], { ...migrationEnvironment, CODEXIA_OAUTH_OWNER_SUBJECT: owner.id });
  assert.equal(admitted.status, 0, 'a compatible schema and registered clients pass read-only deployment verification');

  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const state = randomBytes(18).toString('base64url');
  const authorizationParams = new URLSearchParams({
    response_type: 'code',
    client_id: webClientId,
    redirect_uri: `${apiOrigin}/desktop`,
    scope: ownerScope,
    resource: oauthRuntime.audience,
    state,
    nonce: randomBytes(18).toString('base64url'),
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });
  const authorization = await fetch(`${oauthRuntime.issuer}/oauth2/authorize?${authorizationParams}`, {
    headers: ownerHeaders,
    redirect: 'manual',
  });
  assert.equal(
    authorization.status,
    200,
    `the registered Passkey owner must begin OAuth authorization: ${authorization.status} ${await authorization.clone().text()}`,
  );
  const authorizationResult = (await authorization.json()) as { url?: string };
  assert.ok(authorizationResult.url);
  const consentLocation = new URL(authorizationResult.url, apiOrigin);
  assert.equal(consentLocation.pathname, '/oauth/consent');
  const oauthQuery = consentLocation.search.slice(1);
  assert.ok(oauthQuery.includes('sig='), 'the consent request must be signed by the OAuth provider');
  const consentContext = await oauthRuntime.getConsentContext(ownerHeaders, oauthQuery);
  assert.deepEqual(consentContext.requestedScopes, ['openid', CODEXIA_OWNER_SCOPE, 'offline_access']);
  assert.equal(consentContext.redirectUri, `${apiOrigin}/desktop`);
  const consent = await fetch(`${oauthRuntime.issuer}/oauth2/consent`, {
    method: 'POST',
    headers: new Headers({ cookie: ownerCookie, origin: apiOrigin, 'content-type': 'application/json' }),
    body: JSON.stringify({ accept: true, oauth_query: oauthQuery }),
  });
  assert.equal(consent.status, 200, `OAuth consent must succeed: ${await consent.clone().text()}`);
  const consentResult = (await consent.json()) as { url?: string };
  assert.ok(consentResult.url);
  const callback = new URL(consentResult.url, apiOrigin);
  const code = callback.searchParams.get('code');
  assert.ok(code);
  assert.equal(callback.searchParams.get('state'), state);
  assert.equal(callback.searchParams.get('iss'), oauthRuntime.issuer);
  const tokenResponse = await fetch(`${oauthRuntime.issuer}/oauth2/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: webClientId,
      code,
      redirect_uri: `${apiOrigin}/desktop`,
      code_verifier: verifier,
      resource: oauthRuntime.audience,
    }),
  });
  const tokens = (await tokenResponse.json()) as { access_token?: string; refresh_token?: string; token_type?: string };
  assert.equal(tokenResponse.status, 200, `PKCE token exchange must succeed: ${JSON.stringify(tokens)}`);
  assert.equal(tokens.token_type, 'Bearer');
  assert.ok(tokens.access_token);
  assert.ok(tokens.refresh_token);

  authorApiUsageDirectory = await mkdtemp(join(tmpdir(), 'codexia-passkey-owner-api-'));
  const testStore = {
    async createProject({ title }: { title: string }) {
      return { id: 'fixture-project', title, version: 1 };
    },
    async status() {
      return { projectId: 'fixture-project', projectVersion: 1, state: 'durable' };
    },
    async observe() {
      return { snapshot: { projectId: 'fixture-project', projectVersion: 1 }, observedAt: new Date().toISOString(), state: 'fresh' };
    },
  } as unknown as ApiServerOptions['store'];
  const testPersistence = {
    async checkHealth() {},
    async read<T>(read: (reader: { getProject(id: string): Promise<unknown> }) => Promise<T>) {
      return read({
        async getProject() {
          return null;
        },
      });
    },
  } as unknown as ApiServerOptions['persistence'];
  authorApiServer = createApiServer({
    profile: 'core',
    store: testStore,
    persistence: testPersistence,
    staticDir: process.cwd(),
    usageDirectory: authorApiUsageDirectory,
    betterAuth: oauthRuntime,
    oauthOwner: {
      issuer: oauthRuntime.issuer,
      audience: oauthRuntime.audience,
      jwksUrl: `${oauthRuntime.issuer}/jwks`,
      ownerSubject: owner.id,
      requiredScopes: [CODEXIA_OWNER_SCOPE],
      allowedClientIds: [webClientId, iosClientId],
      verifyActiveToken: oauthRuntime.verifyActiveAccessToken,
      allowInsecureLoopbackForTests: true,
    },
  });
  const ownerApiPort = await listen(authorApiServer);
  const ownerApiOrigin = `http://localhost:${ownerApiPort}`;
  assert.equal((await fetch(`${ownerApiOrigin}/api/jobs`)).status, 401, 'the author API must deny requests without a token');
  const ownerApiResponse = await fetch(`${ownerApiOrigin}/api/jobs`, {
    headers: { authorization: `Bearer ${tokens.access_token}` },
  });
  assert.equal(
    ownerApiResponse.status,
    200,
    `the Passkey owner token must reach author-only API routes: ${await ownerApiResponse.clone().text()}`,
  );
  assert.deepEqual(await ownerApiResponse.json(), []);

  await apiFixture.close();
  apiFixture = undefined;
  await bootstrapRuntime.pool.end();
  bootstrapRuntime = undefined;

  const normalRuntimeConfig: BetterAuthRuntimeConfig = {
    ...bootstrapConfig,
    ownerSubject: owner.id,
  };
  const restarted = await startRuntimeHttpFixture(normalRuntimeConfig);
  runtime = restarted.runtime;
  apiFixture = restarted.fixture;
  await (await runtime.auth.$context).runMigrations();
  const restartedContext = await runtime.auth.$context;
  const restartedUser = await restartedContext.adapter.findOne({ model: 'user', where: [{ field: 'id', value: owner.id }] });
  assert.ok(restartedUser, 'the same owner must survive a runtime restart without OIDC configuration');
  assert.equal((await restartedContext.adapter.findMany({ model: 'passkey' })).length, 1);
  await winnerPage.goto(apiOrigin);
  const oldSession = await winnerPage.evaluate(async () => {
    const response = await fetch('/api/auth/get-session', { credentials: 'same-origin' });
    return { status: response.status, body: (await response.json()) as { user?: { id?: string } } };
  });
  assert.equal(oldSession.status, 200, 'the registration session must persist across an auth runtime restart');
  assert.equal(oldSession.body.user?.id, owner.id);
  const signout = await winnerPage.evaluate(
    async () =>
      (
        await fetch('/api/auth/sign-out', {
          method: 'POST',
          credentials: 'same-origin',
        })
      ).status,
  );
  assert.equal(signout, 200);
  const signedOut = await winnerPage.evaluate(async () => {
    const response = await fetch('/api/auth/get-session', { credentials: 'same-origin' });
    return { status: response.status, body: await response.json() };
  });
  assert.deepEqual(signedOut, { status: 200, body: null });
  assert.ok(persistedCredentialId);
  const signin = await authenticatePasskey(winnerPage, persistedCredentialId);
  assert.equal(signin.optionsStatus, 200);
  const winnerAuthenticator = virtualAuthenticators.get(winnerPage);
  assert.ok(winnerAuthenticator, 'the winning page must retain its virtual authenticator across the runtime restart');
  const winnerCredentials = await winnerAuthenticator.session.send('WebAuthn.getCredentials', {
    authenticatorId: winnerAuthenticator.authenticatorId,
  });
  assert.equal(
    winnerCredentials.credentials.length,
    1,
    'the winning authenticator must contain exactly the credential persisted by the concurrent registration race',
  );
  assert.equal(
    signin.credentialId,
    persistedCredentialId,
    'authentication must select the persisted credential from the winning authenticator',
  );
  if (signin.allowedCredentialIds?.length) {
    assert.ok(
      signin.allowedCredentialIds.includes(persistedCredentialId),
      'the server-supplied allow list must include the persisted winning credential',
    );
  }
  assert.equal(
    signin.verifyStatus,
    200,
    `the enrolled owner must sign in with the winning passkey after restart (verification code: ${signin.verifyCode ?? 'none'})`,
  );
  const signedIn = await winnerPage.evaluate(async () => {
    const response = await fetch('/api/auth/get-session', { credentials: 'same-origin' });
    const result = (await response.json()) as { user?: { id?: string } };
    return { status: response.status, userId: result.user?.id };
  });
  assert.equal(signedIn.status, 200);
  assert.equal(signedIn.userId, owner.id);
});

if (process.env.CODEXIA_PASSKEY_ACCEPTANCE === '1')
  test('[TEST-AUTH-004-001] same-origin setup-only Fastify commits one verified owner and closes setup before OAuth activation', {
    timeout: 120_000,
  }, async t => {
    const sourceDatabaseUrl = process.env.CODEXIA_AUTH_TEST_DATABASE_URL!;
    assertDisposableAuthFixtureDatabaseUrl(sourceDatabaseUrl);
    const previousEnvironment = process.env.NODE_ENV;
    process.env.NODE_ENV = 'test';
    const fixtureAdmin = new Pool({ connectionString: sourceDatabaseUrl });
    const databaseName = `codexia_r4_${randomUUID().replaceAll('-', '')}`;
    let createdDatabase = false;
    let createdRole = false;
    const isolatedDatabaseUrl = new URL(sourceDatabaseUrl);
    isolatedDatabaseUrl.pathname = `/${databaseName}`;
    const databaseUrl = isolatedDatabaseUrl.href;
    const database = new Pool({ connectionString: databaseUrl });
    let app: ReturnType<typeof createOwnerSetupApp> | undefined;
    let authPool: Pool | undefined;
    let browser: Browser | undefined;
    let active: Awaited<ReturnType<typeof startRuntimeHttpFixture>> | undefined;
    t.after(async () => {
      await browser?.close().catch(() => undefined);
      await app?.close().catch(() => undefined);
      await authPool?.end().catch(() => undefined);
      await active?.fixture.close().catch(() => undefined);
      await active?.runtime.pool.end().catch(() => undefined);
      await database.end();
      try {
        if (createdDatabase) await fixtureAdmin.query(`DROP DATABASE ${databaseName}`);
        if (createdRole) await fixtureAdmin.query('DROP ROLE codexia_auth_runtime');
      } finally {
        await fixtureAdmin.end();
        if (previousEnvironment === undefined) delete process.env.NODE_ENV;
        else process.env.NODE_ENV = previousEnvironment;
      }
    });
    await fixtureAdmin.query(`CREATE DATABASE ${databaseName}`);
    createdDatabase = true;
    // Simulate the interrupted R4 checkpoint: application migrations and the
    // least-privilege auth namespace exist, while Better Auth has not yet run.
    await initializeFreshPostgresSchema(databaseUrl);
    const applicationCheckpoint = await inspectFreshPostgresSchema(databaseUrl);
    assert.equal(applicationCheckpoint.pristine, false);
    assert.match(applicationCheckpoint.fingerprint, /^sha256:[a-f0-9]{64}$/u);
    const databaseIdentitySql =
      'SELECT system_identifier::text || chr(58) || ' +
      '(SELECT oid::text FROM pg_database WHERE datname=current_database()) AS identity FROM pg_control_system()';
    const databaseIdentity = (await database.query<{ identity: string }>(databaseIdentitySql)).rows[0]?.identity;
    assert.match(databaseIdentity ?? '', /^[1-9][0-9]{0,19}:[1-9][0-9]{0,9}$/u);

    const password = randomBytes(32).toString('base64url');
    await database.query(
      `CREATE ROLE codexia_auth_runtime LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`,
    );
    createdRole = true;
    await database.query('CREATE SCHEMA codexia_auth AUTHORIZATION codexia_auth_runtime');
    const authNamespaceCheckpoint = await database.query<{ pristine: boolean }>(`
      SELECT n.nspowner = (SELECT oid FROM pg_roles WHERE rolname='codexia_auth_runtime')
        AND NOT EXISTS (SELECT FROM aclexplode(COALESCE(n.nspacl, acldefault('n',n.nspowner))) a WHERE a.grantee<>n.nspowner)
        AND NOT EXISTS (SELECT FROM pg_auth_members WHERE member=n.nspowner OR roleid=n.nspowner)
        AND NOT EXISTS (SELECT FROM pg_depend d WHERE d.refclassid='pg_namespace'::regclass AND d.refobjid=n.oid)
        AND NOT EXISTS (SELECT FROM pg_class c WHERE c.relnamespace=n.oid)
        AND NOT EXISTS (SELECT FROM pg_proc p WHERE p.pronamespace=n.oid)
        AND NOT EXISTS (SELECT FROM pg_type t WHERE t.typnamespace=n.oid) AS pristine
      FROM pg_namespace n WHERE n.nspname='codexia_auth'
    `);
    assert.equal(authNamespaceCheckpoint.rows[0]?.pristine, true, 'interrupted R4 checkpoint must be an empty auth namespace');
    const runtimeDatabase = new URL(databaseUrl);
    runtimeDatabase.username = 'codexia_auth_runtime';
    runtimeDatabase.password = password;
    const portProbe = createHttpServer();
    const port = await listen(portProbe);
    await close(portProbe);
    const config = {
      databaseUrl: runtimeDatabase.href,
      publicOrigin: `http://localhost:${port}`,
      authSecret: randomBytes(32).toString('base64url'),
      oauthIntrospectionClientId: 'setup-fixture-introspection',
      oauthIntrospectionClientSecret: randomBytes(32).toString('base64url'),
      ownerClientIds: ['setup-fixture-web', 'setup-fixture-ios'],
      allowInsecureLoopbackForTests: true,
    } as const;

    await migrateBetterAuth({ ...config, installOwnerSetupSchema: true });
    authPool = new Pool({ connectionString: runtimeDatabase.href, options: '-c search_path=codexia_auth' });
    const rateLimitApp = createOwnerSetupApp(config, [config.publicOrigin + '/desktop/']);
    try {
      const readiness = { method: 'GET', url: '/health/ready' } as const;
      const networkReadiness = {
        ...readiness,
        remoteAddress: '192.0.2.10',
        headers: { 'x-forwarded-for': '127.0.0.1' },
      };
      const status = { method: 'GET', url: '/api/auth/codexia/setup/status' } as const;
      for (let attempt = 0; attempt < 60; attempt++) {
        const allowed = await rateLimitApp.inject(status);
        assert.equal(allowed.statusCode, 200);
        assert.deepEqual(allowed.json(), { state: 'blocked' });
        assert.equal((await rateLimitApp.inject(networkReadiness)).statusCode, 200);
      }
      assert.equal(
        (await rateLimitApp.inject(readiness)).statusCode,
        200,
        'network traffic must leave the loopback health probe available',
      );
      const authorize = await rateLimitApp.inject({
        method: 'POST',
        url: '/api/auth/codexia/setup/authorize',
        headers: { origin: config.publicOrigin, host: new URL(config.publicOrigin).host },
        payload: { key: 'X'.repeat(43) },
      });
      assert.equal(authorize.statusCode, 403, 'status traffic must leave the setup key quota available');
      assert.deepEqual(authorize.json(), { code: 'SETUP_KEY_INVALID' });
      await authPool.query('ALTER TABLE owner_setup RENAME TO unavailable_owner_setup');
      try {
        // A database query would now fail. Exhausted quotas must reject first.
        for (const input of [networkReadiness, status]) {
          const blocked = await rateLimitApp.inject(input);
          assert.equal(blocked.statusCode, 429, input.url);
          const retryAfter = Number(blocked.headers['retry-after']);
          assert.ok(Number.isInteger(retryAfter) && retryAfter >= 1 && retryAfter <= 60, input.url);
          assert.equal(blocked.headers['cache-control'], 'no-store');
          assert.deepEqual(blocked.json(), { code: 'SETUP_RATE_LIMIT' });
        }
        assert.equal((await rateLimitApp.inject(readiness)).statusCode, 503, 'an unhealthy database must fail readiness');
      } finally {
        await authPool.query('ALTER TABLE unavailable_owner_setup RENAME TO owner_setup');
      }
    } finally {
      await rateLimitApp.close();
    }
    app = createOwnerSetupApp(config, [config.publicOrigin + '/desktop/']);
    const dist = process.env.CODEXIA_PASSKEY_SETUP_UI_DIST;
    if (dist) {
      // Serve the canonical desktop shell and assets at the normal setup route. API requests still
      // go directly to the actual setup-only Fastify routes and PostgreSQL.
      const index = await readFile(join(dist, 'index.html'), 'utf8');
      const assetDirectory = join(dist, 'assets');
      const assets = new Map<string, { readonly type: string; readonly body: Buffer }>();
      for (const file of await readdir(assetDirectory, { withFileTypes: true })) {
        if (!file.isFile() || !/^[\w-]+[.](js|css)$/u.test(file.name)) continue;
        assets.set(file.name, {
          type: file.name.endsWith('.css') ? 'text/css' : 'text/javascript',
          body: await readFile(join(assetDirectory, file.name)),
        });
      }
      app.get('/console/setup', (_request, reply) => reply.type('text/html').send(index));
      app.get<{ Params: { file: string } }>('/desktop/assets/:file', (request, reply) => {
        const asset = assets.get(request.params.file);
        return asset ? reply.type(asset.type).send(asset.body) : reply.code(404).send();
      });
    }
    await app.verifySchema();
    if (dist) {
      for (const asset of ['unknown.js', '%2e%2e%2findex.html', 'subdirectory%2fasset.js']) {
        const source: LightMyRequestResponse = await app.inject({ method: 'GET', url: '/desktop/assets/' + asset });
        assert.equal(source.statusCode, 404, asset);
        assert.equal(source.body, '');
      }
    }
    await app.listen({ host: 'localhost', port });
    const setupPath = '/api/auth/codexia/setup';
    const originHeaders = { origin: config.publicOrigin, 'content-type': 'application/json', host: new URL(config.publicOrigin).host };
    const status = async () => (await app!.inject({ method: 'GET', url: setupPath + '/status' })).json();
    assert.deepEqual(await status(), { state: 'blocked' });
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: setupPath + '/authorize',
          headers: originHeaders,
          payload: { key: 'X'.repeat(43) },
        })
      ).statusCode,
      403,
    );

    const handoffs: { key: string; grantId: string; expiresAt: Date }[] = [];
    assert.equal(
      await issueOwnerSetupGrant(authPool, { freshInstall: true }, async value => {
        handoffs.push(value);
      }),
      true,
    );
    const original = handoffs[0]!;
    assert.ok(original);
    assert.equal(Buffer.from(original.key, 'base64url').length, 32);
    const grant = (await authPool.query('SELECT grant_digest, extract(epoch FROM expires_at - issued_at)::int AS ttl FROM owner_setup'))
      .rows[0];
    assert.deepEqual(grant, { grant_digest: createHash('sha256').update(original.key).digest('hex'), ttl: 86400 });
    assert.equal(
      await issueOwnerSetupGrant(authPool, { freshInstall: true }, async () => assert.fail('rerun exported a second key')),
      false,
    );
    assert.deepEqual(await status(), { state: 'setup-pending' });
    const elapsed = await authPool.query(
      "UPDATE owner_setup SET issued_at = now() - interval '25 hours', expires_at = now() - interval '1 hour'",
    );
    assert.equal(elapsed.rowCount, 1);
    assert.deepEqual(await status(), { state: 'expired' });
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: setupPath + '/authorize',
          headers: originHeaders,
          payload: { key: original.key },
        })
      ).statusCode,
      403,
    );
    await assert.rejects(installedSetupOwner(authPool, undefined));
    assert.equal(
      await issueOwnerSetupGrant(authPool, { replaceGrantId: original.grantId }, async value => {
        handoffs.push(value);
      }),
      true,
    );
    assert.notEqual(handoffs[1]?.key, original.key);
    assert.equal(
      await issueOwnerSetupGrant(authPool, { replaceGrantId: original.grantId }, async () => assert.fail('replayed reissue')),
      false,
    );
    const key = handoffs[1]!.key;

    browser = await chromium.launch({
      headless: true,
      ...(process.env.CODEXIA_E2E_CHROMIUM ? { executablePath: process.env.CODEXIA_E2E_CHROMIUM } : {}),
    });
    async function setupPage() {
      const browserContext = await browser!.newContext();
      const page = await browserContext.newPage();
      await page.route(config.publicOrigin + '/', route =>
        route.fulfill({
          contentType: 'text/html',
          body: '<!doctype html><title>Owner setup acceptance fixture</title><h1>Owner setup</h1>',
        }),
      );
      await page.goto(config.publicOrigin);
      await attachVirtualAuthenticator(browserContext, page);
      return page;
    }
    const first = await setupPage();
    const second = await setupPage();
    const authorize = async (page: Page, name: string) =>
      page.evaluate(
        async ({ setupPath, key, name }) => {
          const headers = { 'content-type': 'application/json' };
          const grant = await fetch(setupPath + '/authorize', {
            method: 'POST',
            headers,
            body: JSON.stringify({ key }),
          });
          if (!grant.ok) throw new Error('Expected local fixture key admission');
          const { transaction } = await grant.json();
          const profile = await fetch(setupPath + '/profile', {
            method: 'POST',
            headers: { ...headers, 'x-codexia-setup-transaction': transaction },
            body: JSON.stringify({ name, email: name + '@example.test' }),
          });
          return (await profile.json()).transaction as string;
        },
        { setupPath, key, name },
      );

    for (const tamper of ['origin', 'challenge', 'rp', 'userVerification'] as const) {
      const rejected = await setupPage();
      const badTransaction = await authorize(rejected, 'rejected');
      const failed = await registerPasskey(rejected, badTransaction, { setup: true, tamper });
      await rejected.context().close();
      assert.equal(failed.verifyStatus, 400, tamper);
      assert.equal((await authPool.query('SELECT 1 FROM "user"')).rowCount, 0);
      assert.equal((await authPool.query('SELECT 1 FROM "passkey"')).rowCount, 0);
    }

    if (dist) {
      const wizard = await setupPage();
      await wizard.goto(config.publicOrigin + '/console/setup');
      const setupKey = wizard.getByLabel('初期登録キー');
      await setupKey.fill(key);
      await wizard.getByRole('button', { name: 'キーを確認' }).click();
      await expect(wizard.getByRole('heading', { name: '所有者プロフィール' })).toBeFocused();
      await wizard.getByLabel('表示名').fill('Browser owner');
      await wizard.getByLabel('連絡先メールアドレス').fill('browser-owner@example.test');
      await wizard.getByRole('button', { name: '次へ' }).click();
      await expect(wizard.getByRole('heading', { name: 'Passkeyを作成' })).toBeFocused();
      const noCredential = await wizard.evaluate(() => ({
        url: window.location.href,
        local: JSON.stringify(localStorage),
        session: JSON.stringify(sessionStorage),
      }));
      assert.ok(Object.values(noCredential).every(value => !value.includes(key)));
      const prompt = wizard.getByRole('button', { name: 'Passkeyを作成' });
      const verificationPath = config.publicOrigin + '/api/auth/passkey/verify-registration';
      // Hold the ceremony at the browser boundary so the independent race below
      // can exercise two verified registrations with an unconsumed setup grant.
      await wizard.route(
        verificationPath,
        route =>
          route.fulfill({
            status: 409,
            json: { code: 'SETUP_PASSKEY_UNVERIFIED' },
          }),
        { times: 1 },
      );
      const verification = wizard.waitForRequest(verificationPath);
      await prompt.click();
      const credential = await verification;
      assert.equal(credential.method(), 'POST');
      assert.ok(credential.headers()['x-codexia-setup-transaction']);
      assert.equal((await authPool.query('SELECT 1 FROM "user"')).rowCount, 0);
      await wizard.context().close();
    }

    const failedCommitPage = await setupPage();
    const failedCommitToken = await authorize(failedCommitPage, 'failed-commit');
    await authPool.query('ALTER TABLE "passkey" ADD CONSTRAINT reject_fixture_passkey CHECK (false) NOT VALID');
    try {
      const failedCommit = await registerPasskey(failedCommitPage, failedCommitToken, { setup: true });
      assert.equal(failedCommit.verifyStatus, 400);
      assert.equal((await authPool.query('SELECT 1 FROM "user"')).rowCount, 0);
      assert.deepEqual(await status(), { state: 'setup-pending' });
    } finally {
      await authPool.query('ALTER TABLE "passkey" DROP CONSTRAINT reject_fixture_passkey');
      await failedCommitPage.context().close();
    }

    const [firstToken, secondToken] = await Promise.all([authorize(first, 'first'), authorize(second, 'second')]);
    await first.bringToFront();
    const firstAttempt = await registerPasskey(first, firstToken, { setup: true, hold: true });
    await second.bringToFront();
    const secondAttempt = await registerPasskey(second, secondToken, { setup: true, hold: true });
    const finish = async (page: Page, token: string, response: Record<string, unknown> | undefined) =>
      page.evaluate(
        async ({ token, response }) => {
          const result = await fetch('/api/auth/passkey/verify-registration', {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-codexia-setup-transaction': token },
            body: JSON.stringify({ response }),
          });
          return result.status;
        },
        { token, response },
      );
    const attempts = await Promise.all([
      finish(first, firstToken, firstAttempt.response),
      finish(second, secondToken, secondAttempt.response),
    ]);
    assert.equal(attempts.filter(attempt => attempt === 200).length, 1);
    const winner = attempts[0] === 200 ? 0 : 1;
    assert.equal([firstAttempt, secondAttempt][winner]?.rpId, 'localhost');
    assert.equal([firstAttempt, secondAttempt][winner]?.userVerification, 'required');
    const winningPage = [first, second][winner]!;
    const winnerToken = [firstToken, secondToken][winner]!;
    const losingToken = [firstToken, secondToken][winner === 0 ? 1 : 0]!;
    assert.equal((await authPool.query('SELECT 1 FROM "user"')).rowCount, 1);
    assert.equal((await authPool.query('SELECT 1 FROM "passkey"')).rowCount, 1);
    const enrolledId = await installedSetupOwner(authPool, undefined);
    assert.deepEqual(await status(), { state: 'owner-enrolled', clientsReady: false });
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: setupPath + '/complete',
          headers: { ...originHeaders, 'x-codexia-setup-transaction': losingToken },
          payload: {},
        })
      ).statusCode,
      403,
    );
    const resumed = await app.inject({
      method: 'POST',
      url: setupPath + '/complete',
      headers: { ...originHeaders, 'x-codexia-setup-transaction': winnerToken },
      payload: {},
    });
    assert.deepEqual(resumed.json(), { state: 'owner-enrolled', clientsReady: true, sessionConfirmed: false });
    const completed = await winningPage.evaluate(
      async ({ setupPath, winnerToken }) => {
        const response = await fetch(setupPath + '/complete', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-codexia-setup-transaction': winnerToken },
          body: '{}',
        });
        return { status: response.status, body: await response.json() };
      },
      { setupPath, winnerToken },
    );
    assert.deepEqual(completed, { status: 200, body: { state: 'owner-enrolled', clientsReady: true, sessionConfirmed: true } });
    assert.equal(await app.prepareActivation(), enrolledId);
    assert.equal((await authPool.query('SELECT 1 FROM "oauthClient"')).rowCount, 3);
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: setupPath + '/authorize',
          headers: originHeaders,
          payload: { key },
        })
      ).statusCode,
      403,
    );
    assert.equal(await issueOwnerSetupGrant(authPool, { freshInstall: true }, async () => assert.fail('owner data reopened setup')), false);
    const rejectedIssuance = runPackageCli('owner-setup-operator', ['--issue-new-approved'], {
      ...process.env,
      CODEXIA_AUTH_DATABASE_URL: runtimeDatabase.href,
      CODEXIA_PUBLIC_ORIGIN: 'https://codexia.example.test',
      CODEXIA_AUTH_SECRET: config.authSecret,
      CODEXIA_OAUTH_INTROSPECTION_CLIENT_ID: config.oauthIntrospectionClientId,
      CODEXIA_OAUTH_INTROSPECTION_CLIENT_SECRET: config.oauthIntrospectionClientSecret,
      CODEXIA_OAUTH_OWNER_CLIENT_IDS: config.ownerClientIds.join(','),
      CODEXIA_OWNER_SETUP_WEB_REDIRECT_URIS: 'https://codexia.example.test/desktop/',
    });
    assert.notEqual(rejectedIssuance.status, 0, 'a protected first-issue request fails when no grant can be issued');
    assert.equal(rejectedIssuance.stdout, '', 'a failed issuance has no handoff document');
    await assert.rejects(installedSetupOwner(authPool, randomUUID()), /single approved owner/u);
    assert.ok((await finish(winningPage, winnerToken, [firstAttempt, secondAttempt][winner]?.response)) >= 400);
    const credential = await authPool.query<{ credentialID: string }>('SELECT "credentialID" FROM "passkey" WHERE "userId" = $1', [
      enrolledId,
    ]);
    await app.close();
    app = undefined;
    active = await startRuntimeHttpFixture({ ...config, ownerSubject: enrolledId });
    const sessionHeaders = async () => {
      const browserCookies = await winningPage.context().cookies();
      const cookie = browserCookies.map(({ name, value }) => name + '=' + value).join('; ');
      return new Headers({ cookie, origin: config.publicOrigin });
    };
    assert.equal(await active.runtime.auth.api.getSession({ headers: await sessionHeaders() }), null);
    await active.runtime.assertRegisteredClients();
    await active.runtime.verifyIntrospectionCredentials();
    await winningPage.bringToFront();
    const signedIn = await authenticatePasskey(winningPage, credential.rows[0]!.credentialID);
    assert.equal(signedIn.verifyStatus, 200, signedIn.verifyCode);
    assert.equal(signedIn.credentialId, credential.rows[0]?.credentialID);
    assert.deepEqual(await active.runtime.checkOwnerSession(await sessionHeaders()), { status: 200 });
    assert.equal((await database.query<{ identity: string }>(databaseIdentitySql)).rows[0]?.identity, databaseIdentity);
    assert.deepEqual(await inspectFreshPostgresSchema(databaseUrl), applicationCheckpoint);
  });
