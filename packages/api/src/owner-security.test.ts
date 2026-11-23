import assert from "node:assert/strict";
import test from "node:test";
import { oauthProvider } from "@better-auth/oauth-provider";
import { passkey } from "@better-auth/passkey";
import { betterAuth } from "better-auth";
import { jwt, testUtils } from "better-auth/plugins";
import { ownerSecurity } from "./owner-security.js";

const origin = "https://codexia.example.test";
const ownerId = "established-owner";
const webClientId = "codexia-web";
const iosClientId = "codexia-ios";

async function fixture() {
  const auth = betterAuth({
    baseURL: `${origin}/api/auth`,
    secret: "disposable-owner-security-fixture-secret",
    logger: { disabled: true },
    plugins: [
      testUtils(),
      passkey({ rpID: "codexia.example.test", origin }),
      jwt(),
      oauthProvider({
        loginPage: "/oauth/login",
        consentPage: "/oauth/consent",
        scopes: ["openid", "offline_access", "author"],
      }),
      ownerSecurity({ origin, ownerId, oauthClientIds: [webClientId, iosClientId], legacyOidcConfigured: true }),
    ],
  });
  const context = await auth.$context;
  const { createUser, saveUser, login } = context.test;
  const owner = await saveUser(createUser({ id: ownerId }));
  const nonOwner = await saveUser(createUser({ id: "not-the-owner" }));
  const current = await login({ userId: owner.id });
  const other = await login({ userId: owner.id });
  const foreign = await login({ userId: nonOwner.id });
  async function request(path: string, {
    headers = current.headers,
    body,
    suppliedOrigin = origin,
  }: { headers?: Headers; body?: unknown; suppliedOrigin?: string | null } = {}) {
    const init = new Headers(headers);
    if (suppliedOrigin !== null) init.set("origin", suppliedOrigin);
    if (body !== undefined) init.set("content-type", "application/json");
    return auth.handler(new Request(`${origin}/api/auth${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: init,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }));
  }
  return { context, current, other, foreign, request };
}

test("owner management rejects cross-origin, missing-origin writes, bearer and foreign sessions", async () => {
  const { request, current, other, foreign, context } = await fixture();
  const path = "/revoke-session";
  const body = { token: other.token };
  const bearer = new Headers(current.headers);
  bearer.set("authorization", "Bearer author-token");
  assert.equal((await request(path, { body, suppliedOrigin: "https://foreign.example.test" })).status, 403);
  assert.equal((await request(path, { body, suppliedOrigin: null })).status, 403);
  assert.equal((await request(path, { body, headers: bearer })).status, 403);
  assert.equal((await request(path, { body, headers: foreign.headers })).status, 403);
  assert.equal((await request(path, { body, headers: new Headers() })).status, 401);
  assert.ok(await context.internalAdapter.findSession(other.token));
});

test("the maintained session endpoints preserve the current session and enforce freshness for bulk revoke", async () => {
  const { request, current, other, foreign, context } = await fixture();
  assert.equal((await request("/revoke-session", { body: { token: current.token } })).status, 403);
  assert.equal((await request("/revoke-session", { body: { token: foreign.token } })).status, 404);
  assert.equal((await request("/revoke-sessions", { body: {} })).status, 403);
  await context.internalAdapter.updateSession(current.token, { createdAt: new Date(Date.now() - 6 * 60_000) });
  assert.equal((await request("/revoke-other-sessions", { body: {} })).status, 403);
  assert.equal((await request("/revoke-session", { body: { token: other.token } })).status, 200);
  assert.equal(await context.internalAdapter.findSession(other.token), null);
  assert.ok(await context.internalAdapter.findSession(current.token));
  assert.ok(await context.internalAdapter.findSession(foreign.token));
});

test("passkey management requires the fresh owner and rejects deletion of their last passkey", async () => {
  const { request, current, foreign, context } = await fixture();
  const passkey = await context.adapter.create({ model: "passkey", data: {
    userId: ownerId,
    name: "Current key",
    credentialID: "Y3JlZGVudGlhbA",
    publicKey: "Zml4dHVyZQ==",
    counter: 0,
    deviceType: "singleDevice",
    backedUp: false,
    createdAt: new Date(),
  } });
  assert.equal((await request("/passkey/list-user-passkeys", { headers: foreign.headers, suppliedOrigin: null })).status, 403);
  assert.equal((await request("/passkey/generate-register-options", { headers: foreign.headers, suppliedOrigin: null })).status, 403);
  assert.equal((await request("/passkey/delete-passkey", { body: { id: passkey.id } })).status, 403);
  assert.equal((await request("/passkey/update-passkey", { body: { id: passkey.id, name: "Renamed" } })).status, 200);
  await context.internalAdapter.updateSession(current.token, { createdAt: new Date(Date.now() - 6 * 60_000) });
  assert.equal((await request("/passkey/update-passkey", { body: { id: passkey.id, name: "Old session" } })).status, 403);
  assert.ok(await context.adapter.findOne({ model: "passkey", where: [{ field: "id", value: passkey.id }] }));
});

test("identity reads only allowlisted clients and owner grants, with an unverified provider and no secrets", async () => {
  const { request, context, foreign } = await fixture();
  for (const clientId of [webClientId, "internal-introspection"]) {
    await context.adapter.create({ model: "oauthClient", data: {
      clientId, name: clientId, scopes: ["openid"], clientSecret: "sensitive-fixture-client-secret",
      redirectUris: [`${origin}/callback`],
    } });
    await context.adapter.create({ model: "oauthConsent", data: {
      userId: ownerId, clientId, scopes: ["openid"], createdAt: new Date(), updatedAt: new Date(),
    } });
  }
  await context.adapter.create({ model: "oauthConsent", data: {
    userId: foreign.user.id, clientId: webClientId, scopes: ["openid"], createdAt: new Date(), updatedAt: new Date(),
  } });
  const identity = await request("/codexia/owner-security/identity", { suppliedOrigin: null });
  assert.equal(identity.status, 200);
  assert.equal(identity.headers.get("cache-control"), "no-store");
  const result = await identity.json();
  assert.deepEqual(result.provider, { status: "operator-configured-unverified" });
  assert.deepEqual(result.clients.map((row: { clientId: string }) => row.clientId), [webClientId]);
  assert.deepEqual(result.consents.map((row: { clientId: string }) => row.clientId), [webClientId]);
  assert.doesNotMatch(JSON.stringify(result), /sensitive-fixture-client-secret|clientSecret|not-the-owner/u);
});

test("withdrawing stored consent compares the owner, client, scopes and exact version", async () => {
  const { request, current, foreign, context } = await fixture();
  const updatedAt = new Date();
  const create = (userId: string, clientId: string) => context.adapter.create({
    model: "oauthConsent", data: { userId, clientId, scopes: ["openid", "offline_access"], createdAt: updatedAt, updatedAt },
  });
  const consent = await create(ownerId, webClientId);
  const foreignConsent = await create(foreign.user.id, webClientId);
  const otherConsent = await create(ownerId, iosClientId);
  const path = "/codexia/owner-security/revoke-consent";
  const body = { id: consent.id, clientId: webClientId, scopes: ["openid", "offline_access"], updatedAt: updatedAt.toISOString() };
  assert.equal((await request(path, { body: { ...body, id: foreignConsent.id } })).status, 404);
  assert.equal((await request(path, { body: { ...body, clientId: iosClientId } })).status, 404);
  assert.equal((await request(path, { body: { ...body, scopes: ["openid"] } })).status, 409);
  assert.equal((await request(path, { body: { ...body, updatedAt: new Date(0).toISOString() } })).status, 409);
  await context.internalAdapter.updateSession(current.token, { createdAt: new Date(Date.now() - 6 * 60_000) });
  assert.equal((await request(path, { body })).status, 403);
  await context.internalAdapter.updateSession(current.token, { createdAt: new Date() });
  const receipt = await request(path, { body });
  assert.equal(receipt.status, 200);
  assert.deepEqual(await receipt.json(), { consentRemoved: true });
  assert.equal((await request(path, { body })).status, 404);
  const left = await context.adapter.findMany<{ id: string }>({ model: "oauthConsent" });
  assert.deepEqual(left.map(({ id }) => id).sort(), [foreignConsent.id, otherConsent.id].sort());
});
