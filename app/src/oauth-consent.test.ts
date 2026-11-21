import assert from "node:assert/strict";
import { test } from "node:test";
import { canApproveOAuthConsent, parseOAuthConsentContext, sameOriginOAuthContinuation } from "./oauth-consent.js";

test("consent display accepts only unique server-verified scope values", () => {
  const context = parseOAuthConsentContext({ client: { name: "Codexia Web" }, requestedScopes: ["openid", "codexia:api"] });
  assert.deepEqual(context, { clientName: "Codexia Web", requestedScopes: ["openid", "codexia:api"] });
  assert.equal(canApproveOAuthConsent(context), true);
  assert.equal(canApproveOAuthConsent(parseOAuthConsentContext({ client: null, requestedScopes: ["openid", "codexia:api"] })), false);
  assert.equal(canApproveOAuthConsent(parseOAuthConsentContext({ client: { name: "Other client" }, requestedScopes: ["openid", "unknown:scope"] })), false);
  assert.throws(() => parseOAuthConsentContext({ client: { name: "Codexia Web" }, requestedScopes: ["openid", "openid"] }), /invalid/u);
});

test("consent continuation allows only the current Web origin", () => {
  assert.equal(sameOriginOAuthContinuation("/desktop?code=one", "https://codexia.example.test"), "https://codexia.example.test/desktop?code=one");
  assert.throws(() => sameOriginOAuthContinuation("https://attacker.example.test/", "https://codexia.example.test"), /一致/u);
  assert.throws(() => sameOriginOAuthContinuation("//attacker.example.test/", "https://codexia.example.test"), /一致/u);
});
