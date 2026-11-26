import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import { oauthProvider } from '@better-auth/oauth-provider';
import { passkey } from '@better-auth/passkey';
import { betterAuth } from 'better-auth';
import { jwt, testUtils } from 'better-auth/plugins';
import { Pool } from 'pg';
import { ownerSecurity } from './owner-security.js';

const origin = 'https://codexia.example.test';
const ownerId = 'established-owner';
const webClientId = 'codexia-web';
const iosClientId = 'codexia-ios';

async function fixture(database?: Pool) {
  const grantRevocations: Array<{ clientId: string; subject: string; revokedAt: Date }> = [];
  const auth = betterAuth({
    ...(database ? { database } : {}),
    baseURL: `${origin}/api/auth`,
    secret: 'disposable-owner-security-fixture-secret',
    logger: { disabled: true },
    plugins: [
      testUtils(),
      passkey({ rpID: 'codexia.example.test', origin }),
      jwt(),
      oauthProvider({
        loginPage: '/oauth/login',
        consentPage: '/oauth/consent',
        scopes: ['openid', 'offline_access', 'author'],
      }),
      ownerSecurity({
        origin,
        ownerId,
        oauthClientIds: [webClientId, iosClientId],
        legacyOidcConfigured: true,
        async revokeOAuthGrant(input) {
          grantRevocations.push(input);
        },
      }),
    ],
  });
  const context = await auth.$context;
  if (database) await context.runMigrations();
  const { createUser, saveUser, login } = context.test;
  const owner = await saveUser(createUser({ id: ownerId }));
  const nonOwner = await saveUser(createUser({ id: 'not-the-owner' }));
  const current = await login({ userId: owner.id });
  const other = await login({ userId: owner.id });
  const foreign = await login({ userId: nonOwner.id });
  async function request(
    path: string,
    {
      headers = current.headers,
      body,
      suppliedOrigin = origin,
    }: { headers?: Headers; body?: unknown; suppliedOrigin?: string | null } = {},
  ) {
    const init = new Headers(headers);
    if (suppliedOrigin !== null) init.set('origin', suppliedOrigin);
    if (body !== undefined) init.set('content-type', 'application/json');
    return auth.handler(
      new Request(`${origin}/api/auth${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: init,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
  }
  async function consentSelection(id: string) {
    const response = await request('/codexia/owner-security/identity');
    assert.equal(response.status, 200);
    const result = (await response.json()) as { consents: { id: string; clientId: string; scopes: string[]; revision: string }[] };
    const row = result.consents.find(consent => consent.id === id);
    assert.ok(row);
    return { id: row.id, clientId: row.clientId, scopes: row.scopes, revision: row.revision };
  }
  return { context, current, other, foreign, request, consentSelection, grantRevocations };
}

test('owner management rejects cross-origin, missing-origin writes, bearer and foreign sessions', async () => {
  const { request, current, other, foreign, context } = await fixture();
  const path = '/revoke-session';
  const body = { token: other.token };
  const bearer = new Headers(current.headers);
  bearer.set('authorization', 'Bearer author-token');
  assert.equal((await request(path, { body, suppliedOrigin: 'https://foreign.example.test' })).status, 403);
  assert.equal((await request(path, { body, suppliedOrigin: null })).status, 403);
  assert.equal((await request(path, { body, headers: bearer })).status, 403);
  assert.equal((await request(path, { body, headers: foreign.headers })).status, 403);
  assert.equal((await request(path, { body, headers: new Headers() })).status, 401);
  assert.ok(await context.internalAdapter.findSession(other.token));
});

test('the maintained session endpoints preserve the current session and enforce freshness for bulk revoke', async () => {
  const { request, current, other, foreign, context } = await fixture();
  assert.equal((await request('/revoke-session', { body: { token: current.token } })).status, 403);
  assert.equal((await request('/revoke-session', { body: { token: foreign.token } })).status, 404);
  assert.equal((await request('/revoke-sessions', { body: {} })).status, 403);
  await context.internalAdapter.updateSession(current.token, { createdAt: new Date(Date.now() - 6 * 60_000) });
  assert.equal((await request('/revoke-other-sessions', { body: {} })).status, 403);
  assert.equal((await request('/revoke-session', { body: { token: other.token } })).status, 200);
  assert.equal(await context.internalAdapter.findSession(other.token), null);
  assert.ok(await context.internalAdapter.findSession(current.token));
  assert.ok(await context.internalAdapter.findSession(foreign.token));
});

test('passkey management requires the fresh owner and rejects deletion of their last passkey', async () => {
  const { request, current, foreign, context } = await fixture();
  const createPasskey = (name: string, credentialID: string) =>
    context.adapter.create({
      model: 'passkey',
      data: {
        userId: ownerId,
        name,
        credentialID,
        publicKey: 'Zml4dHVyZQ==',
        counter: 0,
        deviceType: 'singleDevice',
        backedUp: false,
        createdAt: new Date(),
      },
    });
  const passkey = await createPasskey('Current key', 'Y3JlZGVudGlhbA');
  assert.equal((await request('/passkey/list-user-passkeys', { headers: foreign.headers, suppliedOrigin: null })).status, 403);
  assert.equal((await request('/passkey/generate-register-options', { headers: foreign.headers, suppliedOrigin: null })).status, 403);
  assert.equal((await request('/passkey/delete-passkey', { body: { id: passkey.id } })).status, 403);
  assert.equal((await request('/passkey/update-passkey', { body: { id: passkey.id, name: 'Renamed' } })).status, 200);
  const spare = await createPasskey('Spare key', 'c3BhcmUtY3JlZGVudGlhbA');
  assert.equal((await request('/passkey/delete-passkey', { body: { id: spare.id } })).status, 200);
  assert.equal(await context.adapter.findOne({ model: 'passkey', where: [{ field: 'id', value: spare.id }] }), null);
  assert.equal((await request('/passkey/delete-passkey', { body: { id: passkey.id } })).status, 403);
  await context.internalAdapter.updateSession(current.token, { createdAt: new Date(Date.now() - 6 * 60_000) });
  assert.equal((await request('/passkey/update-passkey', { body: { id: passkey.id, name: 'Old session' } })).status, 403);
  assert.equal((await request('/passkey/generate-register-options', { suppliedOrigin: null })).status, 403);
  assert.ok(await context.adapter.findOne({ model: 'passkey', where: [{ field: 'id', value: passkey.id }] }));
});

test('identity reads only allowlisted clients and owner grants, with an unverified provider and no secrets', async () => {
  const { request, context, foreign } = await fixture();
  for (const clientId of [webClientId, 'internal-introspection']) {
    await context.adapter.create({
      model: 'oauthClient',
      data: {
        clientId,
        name: clientId,
        scopes: ['openid'],
        clientSecret: 'sensitive-fixture-client-secret',
        redirectUris: [`${origin}/callback`],
      },
    });
    await context.adapter.create({
      model: 'oauthConsent',
      data: {
        userId: ownerId,
        clientId,
        scopes: ['openid'],
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });
  }
  await context.adapter.create({
    model: 'oauthConsent',
    data: {
      userId: foreign.user.id,
      clientId: webClientId,
      scopes: ['openid'],
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  });
  const identity = await request('/codexia/owner-security/identity', { suppliedOrigin: null });
  assert.equal(identity.status, 200);
  assert.equal(identity.headers.get('cache-control'), 'no-store');
  const result = await identity.json();
  assert.deepEqual(result.provider, { status: 'operator-configured-unverified' });
  assert.deepEqual(
    result.clients.map((row: { clientId: string }) => row.clientId),
    [webClientId],
  );
  assert.deepEqual(
    result.consents.map((row: { clientId: string }) => row.clientId),
    [webClientId],
  );
  assert.doesNotMatch(JSON.stringify(result), /sensitive-fixture-client-secret|clientSecret|not-the-owner/u);
});

const authTestDatabase = process.env.CODEXIA_AUTH_TEST_DATABASE_URL;

async function createIsolatedAuthSchema(t: TestContext): Promise<Pool> {
  assert.ok(authTestDatabase, 'Set CODEXIA_AUTH_TEST_DATABASE_URL to a disposable auth database');
  const url = new URL(authTestDatabase);
  assert.match(url.protocol, /^postgres(?:ql)?:$/u);
  assert.equal(url.search + url.hash, '');
  const localDisposable = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && url.pathname === '/codexia_auth_test';
  const ciDisposable = process.env.CI === 'true' && url.hostname === 'postgres' && /^\/codexia_ci_[a-f0-9]{32}$/u.test(url.pathname);
  assert.ok(localDisposable || ciDisposable, 'owner security test requires an isolated disposable auth database');

  const schema = `owner_security_test_${randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({ connectionString: authTestDatabase });
  const scoped = new Pool({ connectionString: authTestDatabase, options: `-c search_path=${schema}` });
  t.after(async () => {
    try {
      await scoped.end();
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    } finally {
      await admin.end();
    }
  });
  await admin.query(`CREATE SCHEMA ${schema}`);
  return scoped;
}

test('withdrawing stored consent compares the owner, client, scopes and exact version before revoking the grant', {
  skip: authTestDatabase && process.env.CODEXIA_AUTH_TEST_DISPOSABLE === '1' ? false : 'requires a disposable auth database',
}, async t => {
  const database = await createIsolatedAuthSchema(t);
  const { request, current, foreign, context, consentSelection, grantRevocations } = await fixture(database);
  await context.adapter.create({ model: 'oauthClient', data: { clientId: webClientId, redirectUris: [`${origin}/callback`] } });
  await context.adapter.create({ model: 'oauthClient', data: { clientId: iosClientId, redirectUris: [`${origin}/ios-callback`] } });
  const updatedAt = new Date();
  const create = (userId: string, clientId: string) =>
    context.adapter.create({
      model: 'oauthConsent',
      data: { userId, clientId, scopes: ['openid', 'offline_access'], createdAt: updatedAt, updatedAt },
    });
  const consent = await create(ownerId, webClientId);
  const foreignConsent = await create(foreign.user.id, webClientId);
  const otherConsent = await create(ownerId, iosClientId);
  const path = '/codexia/owner-security/revoke-consent';
  const body = await consentSelection(consent.id);
  assert.equal((await request(path, { body, headers: foreign.headers })).status, 403);
  assert.equal((await request(path, { body: { ...body, id: foreignConsent.id } })).status, 404);
  assert.equal((await request(path, { body: { ...body, clientId: iosClientId } })).status, 404);
  assert.equal((await request(path, { body: { ...body, scopes: ['openid'] } })).status, 409);
  await context.adapter.update({
    model: 'oauthConsent',
    where: [{ field: 'id', value: consent.id }],
    update: { requestedUserInfoClaims: ['name'], updatedAt },
  });
  assert.equal((await request(path, { body })).status, 409);
  const currentSelection = await consentSelection(consent.id);
  await context.internalAdapter.updateSession(current.token, { createdAt: new Date(Date.now() - 6 * 60_000) });
  assert.equal((await request(path, { body: currentSelection })).status, 403);
  assert.equal(grantRevocations.length, 0);
  await context.internalAdapter.updateSession(current.token, { createdAt: new Date() });
  const receipt = await request(path, { body: currentSelection });
  assert.equal(receipt.status, 200);
  assert.deepEqual(await receipt.json(), { consentRemoved: true, grantRevoked: true });
  assert.equal(grantRevocations.length, 1);
  assert.equal(grantRevocations[0]?.clientId, webClientId);
  assert.equal(grantRevocations[0]?.subject, ownerId);
  assert.ok(grantRevocations[0]?.revokedAt instanceof Date);
  assert.equal((await request(path, { body })).status, 404);
  const left = await context.adapter.findMany<{ id: string }>({ model: 'oauthConsent' });
  assert.deepEqual(left.map(({ id }) => id).sort(), [foreignConsent.id, otherConsent.id].sort());
});

test('PostgreSQL preserves a concurrently updated consent with the same timestamp', {
  skip: authTestDatabase && process.env.CODEXIA_AUTH_TEST_DISPOSABLE === '1' ? false : 'requires a disposable auth database',
}, async t => {
  const scoped = await createIsolatedAuthSchema(t);
  const { request, context, consentSelection, grantRevocations } = await fixture(scoped);
  await context.adapter.create({ model: 'oauthClient', data: { clientId: webClientId, redirectUris: [`${origin}/callback`] } });
  const updatedAt = new Date(Math.floor(Date.now() / 1_000) * 1_000);
  const consent = await context.adapter.create({
    model: 'oauthConsent',
    data: {
      userId: ownerId,
      clientId: webClientId,
      scopes: ['openid'],
      resources: [`${origin}/api`],
      createdAt: updatedAt,
      updatedAt,
    },
  });
  const where = [{ field: 'id', value: consent.id }];
  const originalTransaction = context.adapter.transaction;
  const path = '/codexia/owner-security/revoke-consent';
  for (const update of [
    { scopes: ['openid', 'offline_access'] },
    { resources: [`${origin}/different-resource`] },
    { requestedUserInfoClaims: ['name'] },
  ]) {
    context.adapter.transaction = cb =>
      originalTransaction(async tx => {
        const originalDelete = tx.deleteMany;
        tx.deleteMany = async input => {
          if (input.model === 'oauthConsent') {
            await context.adapter.update({ model: 'oauthConsent', where, update: { ...update, updatedAt } });
          }
          return originalDelete(input);
        };
        return cb(tx);
      });
    assert.equal((await request(path, { body: await consentSelection(consent.id) })).status, 409);
    assert.equal(grantRevocations.length, 0, 'stale selection must not revoke JWTs');
    const persisted = await context.adapter.findOne<{ scopes: string[]; resources?: string[]; requestedUserInfoClaims?: string[] }>({
      model: 'oauthConsent',
      where,
    });
    assert.ok(persisted);
    for (const key of ['scopes', 'resources', 'requestedUserInfoClaims'] as const) {
      if (update[key]) assert.deepEqual(persisted[key], update[key]);
    }
  }
  context.adapter.transaction = originalTransaction;
  assert.equal((await request(path, { body: await consentSelection(consent.id) })).status, 200);
  assert.equal(await context.adapter.findOne({ model: 'oauthConsent', where }), null);
});
