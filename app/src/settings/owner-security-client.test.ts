import assert from "node:assert/strict";
import test from "node:test";
import { confirmAuthMutation, fetchOwnerConsents, outcomeWasUnconfirmed } from "./owner-security-client";

test("owner consents use only the same-origin Better Auth cookie and discard unrecognized fields", async () => {
  const consents = await fetchOwnerConsents(async (input, init) => {
    assert.equal(input, "/api/auth/oauth2/get-consents");
    assert.equal(init?.method, "GET");
    assert.equal(init?.credentials, "same-origin");
    assert.equal(init?.cache, "no-store");
    assert.equal(init?.redirect, "error");
    assert.equal(new Headers(init?.headers).has("authorization"), false);
    return Response.json([{ id: "consent", clientId: "web", scopes: ["openid"], clientSecret: "extra-field" }]);
  });
  assert.deepEqual(consents, [{ id: "consent", clientId: "web", scopes: ["openid"] }]);
});

test("owner consent listing fails closed for anonymous and malformed responses", async () => {
  await assert.rejects(fetchOwnerConsents(async () => new Response(null, { status: 401 })));
  await assert.rejects(fetchOwnerConsents(async () => Response.json([{ id: "consent", clientId: "web", scopes: [2] }])));
});

test("unknown mutation outcome distinguishes transport and upstream failures from explicit denials", () => {
  assert.equal(outcomeWasUnconfirmed(new TypeError("Failed to fetch")), true);
  assert.equal(outcomeWasUnconfirmed({ status: 503 }), true);
  assert.equal(outcomeWasUnconfirmed({ status: 403, code: "REAUTH_REQUIRED" }), false);
  assert.equal(outcomeWasUnconfirmed(new DOMException("Cancelled", "NotAllowedError")), false);
});

test("a successful HTTP response without the expected mutation result is unconfirmed", () => {
  const confirms = (data: unknown) => Boolean(data && typeof data === "object" && "status" in data && data.status === true);
  assert.doesNotThrow(() => confirmAuthMutation({ data: { status: true } }, confirms));
  assert.throws(() => confirmAuthMutation({ data: null }, confirms), outcomeWasUnconfirmed);
  assert.throws(() => confirmAuthMutation({ data: { status: false } }, confirms), outcomeWasUnconfirmed);
  const denial = { status: 403, code: "REAUTH_REQUIRED" };
  assert.throws(() => confirmAuthMutation({ data: null, error: denial }, confirms), (error) => error === denial);
});
