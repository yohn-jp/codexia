import assert from "node:assert/strict";
import { test } from "node:test";
import { canApproveOAuthConsent, parseOAuthConsentContext, sameOriginOAuthContinuation } from "./oauth-consent.js";

const redirectUri = "https://codexia.example.test/desktop";

test("consent display accepts only unique server-verified scope values", () => {
  const context = parseOAuthConsentContext({ client: { name: "Codexia Web" }, requestedScopes: ["openid", "codexia:api"], redirectUri });
  assert.deepEqual(context, { clientName: "Codexia Web", requestedScopes: ["openid", "codexia:api"], redirectUri });
  assert.equal(canApproveOAuthConsent(context), true);
  assert.equal(canApproveOAuthConsent(parseOAuthConsentContext({ client: null, requestedScopes: ["openid", "codexia:api"], redirectUri })), false);
  assert.equal(canApproveOAuthConsent(parseOAuthConsentContext({ client: { name: "Other client" }, requestedScopes: ["openid", "unknown:scope"], redirectUri })), false);
  assert.throws(() => parseOAuthConsentContext({ client: { name: "Codexia Web" }, requestedScopes: ["openid", "openid"], redirectUri }), /invalid/u);
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
    assert.equal(canApproveOAuthConsent({ clientName: "Registered client", requestedScopes, redirectUri }), true, requestedScopes.join(" "));
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
    assert.equal(canApproveOAuthConsent({ clientName: "Registered client", requestedScopes, redirectUri }), false, requestedScopes.join(" "));
  }
  assert.equal(canApproveOAuthConsent({ clientName: null, requestedScopes: ["openid", "mcp:read"], redirectUri }), false);
});

test("consent continuation accepts only exact registered Web, native and MCP callbacks", () => {
  const origin = "https://codexia.example.test";
  const clientWeb = "https://reader.example.test/consent/callback?client=reader";
  const native = "jp.yohn.codexia:/oauth2redirect?code=one&state=two&iss=https%3A%2F%2Fcodexia.example.test%2Fapi%2Fauth";
  const mcpLoopback = "http://127.0.0.1:48192/callback?code=two&state=three";
  const mcpHttps = "https://reader.example.test/consent/callback?client=reader&code=three&state=four";

  assert.equal(sameOriginOAuthContinuation("/desktop?code=one", origin), origin + "/desktop?code=one");
  assert.equal(sameOriginOAuthContinuation(native, origin, "jp.yohn.codexia:/oauth2redirect"), native);
  assert.equal(sameOriginOAuthContinuation(mcpLoopback, origin, "http://127.0.0.1:48192/callback"), mcpLoopback);
  assert.equal(sameOriginOAuthContinuation(mcpHttps, origin, clientWeb), mcpHttps);

  for (const [value, registered] of [
    ["https://attacker.test/", clientWeb],
    ["//attacker.test/", clientWeb],
    [native, undefined],
    [native, "jp.yohn.codexia:/oauth2redirect/other"],
    ["jp.yohn.codexia://attacker.test/oauth2redirect?code=one", "jp.yohn.codexia:/oauth2redirect"],
    ["jp.yohn.codexia:/oauth2redirect#fragment", "jp.yohn.codexia:/oauth2redirect"],
    ["javascript:alert(1)", "javascript:alert(1)"],
    ["http://attacker.test/callback?code=one", "http://attacker.test/callback"],
    ["http://127.0.0.1:48193/callback?code=one", "http://127.0.0.1:48192/callback"],
    ["https://reader.example.test/consent/callback?code=one", clientWeb],
  ] as Array<[string, string | undefined]>) {
    assert.throws(() => sameOriginOAuthContinuation(value, origin, registered), /一致/u, value);
  }
});

test("consent context rejects absent or malformed server-proven callback URIs", () => {
  for (const redirect of [undefined, "", "relative-path", "https://user:pass@example.test/cb", "https://reader.example.test/cb#fragment"]) {
    assert.throws(() => parseOAuthConsentContext({ client: { name: "Client" }, requestedScopes: ["openid", "mcp:read"], redirectUri: redirect }), /callback/u);
  }
});
