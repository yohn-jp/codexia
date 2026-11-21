import assert from "node:assert/strict";
import { test } from "node:test";
import { webcrypto } from "node:crypto";
import { apiRequestUrl, beginOAuthAuthorization, completeOAuthAuthorization, type OAuthWebConfig } from "./oauth.js";

const config: OAuthWebConfig = {
  authorizationEndpoint: "https://identity.example.test/authorize",
  tokenEndpoint: "https://identity.example.test/token",
  clientId: "codexia-web-public",
  apiAudience: "https://api.example.test",
  redirectUri: "https://codexia.example.test/desktop",
  scopes: ["openid", "codexia.author"],
};

function installBrowserStubs() {
  const originalCrypto = Object.getOwnPropertyDescriptor(globalThis, "crypto");
  const originalSessionStorage = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const storage = new Map<string, string>();
  let assigned = "";
  Object.defineProperty(globalThis, "crypto", { configurable: true, value: webcrypto });
  Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => { storage.delete(key); },
  } });
  Object.defineProperty(globalThis, "window", { configurable: true, value: { location: {
    assign: (url: string) => { assigned = url; },
    href: config.redirectUri,
    origin: new URL(config.redirectUri).origin,
  } } });
  return {
    storage,
    get assigned() { return assigned; },
    restore() {
      for (const [key, descriptor] of [["crypto", originalCrypto], ["sessionStorage", originalSessionStorage], ["window", originalWindow]] as const) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
}

test("OAuth browser client uses state and S256 PKCE, then exchanges once without browser credentials", async () => {
  const browser = installBrowserStubs();
  try {
    await beginOAuthAuthorization(config);
    const authorization = new URL(browser.assigned);
    assert.equal(authorization.searchParams.get("client_id"), config.clientId);
    assert.equal(authorization.searchParams.get("resource"), config.apiAudience);
    assert.equal(authorization.searchParams.get("code_challenge_method"), "S256");
    assert.equal(authorization.searchParams.get("state")?.length, 43);
    const transaction = JSON.parse(browser.storage.get("codexia.oauth.pkce.v1")!) as { verifier: string };
    assert.equal(transaction.verifier.length, 64);
    const digest = await webcrypto.subtle.digest("SHA-256", new TextEncoder().encode(transaction.verifier));
    const bytes = new Uint8Array(digest);
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    const expectedChallenge = btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
    assert.equal(authorization.searchParams.get("code_challenge"), expectedChallenge);

    let submitted = new URLSearchParams();
    const token = await completeOAuthAuthorization(config,
      `${config.redirectUri}?code=authorization-code&state=${authorization.searchParams.get("state")}`,
      async (_input, init) => {
        submitted = new URLSearchParams(init?.body as URLSearchParams);
        assert.equal(init?.credentials, "omit");
        assert.equal(init?.redirect, "error");
        return Response.json({ access_token: "api-access-token", token_type: "Bearer", expires_in: 300 });
      });
    assert.equal(token, "api-access-token");
    assert.equal(submitted.get("code_verifier"), transaction.verifier);
    assert.equal(submitted.get("resource"), config.apiAudience);
    assert.equal(browser.storage.has("codexia.oauth.pkce.v1"), false);
  } finally { browser.restore(); }
});

test("OAuth callback rejects state mismatch and clears the one-time transaction", async () => {
  const browser = installBrowserStubs();
  try {
    await beginOAuthAuthorization(config);
    await assert.rejects(completeOAuthAuthorization(config, `${config.redirectUri}?code=x&state=wrong`), /state validation/u);
    assert.equal(browser.storage.has("codexia.oauth.pkce.v1"), false);
  } finally { browser.restore(); }
});

test("API origin resolver accepts only explicit API paths and an HTTPS origin", () => {
  assert.equal(apiRequestUrl("/api/session"), "/api/session");
  assert.equal(apiRequestUrl("/api/session", "https://api.example.test", "https://codexia.example.test"), "https://api.example.test/api/session");
  assert.equal(apiRequestUrl("/api/session", "https://codexia.example.test", "https://codexia.example.test"), "/api/session");
  assert.throws(() => apiRequestUrl("/_platform/logout", "https://api.example.test"), /Only Codexia API paths/u);
  assert.throws(() => apiRequestUrl("/api/session", "http://api.example.test"), /HTTPS/u);
  assert.throws(() => apiRequestUrl("/api/session", "https://api.example.test/v1"), /only an origin/u);
});
