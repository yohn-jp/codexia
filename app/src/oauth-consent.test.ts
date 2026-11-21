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

test("consent permits registered owner/native and limited MCP scopes without mixing their privileges", () => {
  const allowed = [
    ["openid", "codexia:api"],
    ["openid", "email", "profile", "codexia:api"],
    ["openid", "codexia:api", "offline_access"],
    ["openid", "mcp:read"],
    ["openid", "mcp:read", "mcp:compute", "mcp:propose", "offline_access"],
  ];
  for (const requestedScopes of allowed) {
    assert.equal(canApproveOAuthConsent({ clientName: "Registered client", requestedScopes }), true, requestedScopes.join(" "));
  }
  const denied = [
    [],
    ["openid"],
    ["openid", "email", "profile"],
    ["codexia:api"],
    ["mcp:read"],
    ["openid", "codexia:api", "mcp:read"],
    ["openid", "mcp:compute", "unknown:write"],
    ["openid", "codexia:api", "unknown:write"],
  ];
  for (const requestedScopes of denied) {
    assert.equal(canApproveOAuthConsent({ clientName: "Registered client", requestedScopes }), false, requestedScopes.join(" "));
  }
  assert.equal(canApproveOAuthConsent({ clientName: null, requestedScopes: ["openid", "mcp:read"] }), false);
});

test("consent continuation allows only the current Web origin", () => {
  assert.equal(sameOriginOAuthContinuation("/desktop?code=one", "https://codexia.example.test"), "https://codexia.example.test/desktop?code=one");
  assert.throws(() => sameOriginOAuthContinuation("https://attacker.example.test/", "https://codexia.example.test"), /一致/u);
  assert.throws(() => sameOriginOAuthContinuation("//attacker.example.test/", "https://codexia.example.test"), /一致/u);
});

test("native consent continuation accepts only the app's exact registered deep link", () => {
  const origin = "https://codexia.example.test";
  const native = "jp.yohn.codexia:/oauth2redirect?code=one&state=two&iss=https%3A%2F%2Fcodexia.example.test%2Fapi%2Fauth";
  assert.equal(sameOriginOAuthContinuation(native, origin), native);
  for (const rejected of [
    "jp.yohn.codexia:/oauth2redirect/other?code=one",
    "jp.yohn.codexia://attacker.test/oauth2redirect?code=one",
    "jp.yohn.codexia:/oauth2redirect#fragment",
    "another.app:/oauth2redirect?code=one",
    "javascript:alert(1)",
    "https://attacker.test/oauth2redirect?code=one",
  ]) {
    assert.throws(() => sameOriginOAuthContinuation(rejected, origin), /一致/u, rejected);
  }
});
