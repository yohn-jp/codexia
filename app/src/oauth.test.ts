import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash, webcrypto } from "node:crypto";
import { apiRequestUrl, beginOAuthAuthorization, completeOAuthAuthorization, type OAuthWebConfig } from "./oauth.js";

const config: OAuthWebConfig = {
  issuer: "https://codexia.example.test/api/auth",
  clientId: "codexia-web-public",
  apiAudience: "https://codexia.example.test/api",
  redirectUri: "https://codexia.example.test/desktop",
  scopes: ["openid", "codexia:api"],
};

const metadata = {
  issuer: config.issuer,
  authorization_endpoint: `${config.issuer}/oauth2/authorize`,
  token_endpoint: `${config.issuer}/oauth2/token`,
  response_types_supported: ["code"],
  grant_types_supported: ["authorization_code"],
  token_endpoint_auth_methods_supported: ["none"],
  code_challenge_methods_supported: ["S256"],
  authorization_response_iss_parameter_supported: true,
  scopes_supported: ["openid", "codexia:api"],
};

function metadataFetch(): typeof fetch {
  return async (input, init) => {
    assert.equal(new URL(String(input)).pathname, "/.well-known/oauth-authorization-server/api/auth");
    assert.equal(init?.credentials, "omit");
    assert.equal(init?.redirect, "error");
    return Response.json(metadata);
  };
}

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
    await beginOAuthAuthorization(config, metadataFetch());
    const authorization = new URL(browser.assigned);
    assert.equal(authorization.searchParams.get("client_id"), config.clientId);
    assert.equal(authorization.searchParams.get("resource"), config.apiAudience);
    assert.equal(authorization.searchParams.get("code_challenge_method"), "S256");
    const state = authorization.searchParams.get("state");
    assert.match(state ?? "", /^[A-Za-z0-9_-]{43,}$/u);
    const callback = `${config.redirectUri}?code=authorization-code&state=${state}&iss=${encodeURIComponent(config.issuer)}`;

    let submitted = new URLSearchParams();
    const token = await completeOAuthAuthorization(config, callback,
      async (input, init) => {
        if (init?.method !== "POST") return Response.json(metadata);
        assert.equal(String(input), metadata.token_endpoint);
        submitted = new URLSearchParams(init?.body as URLSearchParams);
        assert.equal(init?.credentials, "omit");
        assert.equal(init?.redirect, "error");
        return Response.json({
          access_token: "codexia-api-access-token",
          id_token: "upstream-oidc-id-token-must-not-be-used-as-an-api-bearer",
          token_type: "Bearer",
          expires_in: 300,
        });
      });
    assert.equal(token, "codexia-api-access-token", "the API client uses the OAuth access token, never the OIDC ID token");
    const verifier = submitted.get("code_verifier") ?? "";
    assert.match(verifier, /^[A-Za-z0-9._~-]{43,128}$/u);
    assert.equal(authorization.searchParams.get("code_challenge"), createHash("sha256").update(verifier).digest("base64url"));
    assert.equal(submitted.get("code"), "authorization-code");
    assert.equal(submitted.get("resource"), config.apiAudience);
    assert.equal(submitted.has("client_secret"), false, "a public Web client never sends a client secret");
    await assert.rejects(completeOAuthAuthorization(config, callback, async () => {
      assert.fail("a consumed transaction cannot send another request");
    }), /state validation/u);
  } finally { browser.restore(); }
});

test("OAuth callback rejects state mismatch and clears the one-time transaction", async () => {
  const browser = installBrowserStubs();
  try {
    await beginOAuthAuthorization(config, metadataFetch());
    const state = new URL(browser.assigned).searchParams.get("state");
    const unexpectedFetch = async () => assert.fail("a rejected or consumed transaction cannot send a request");
    await assert.rejects(completeOAuthAuthorization(config, `${config.redirectUri}?code=x&state=wrong`, unexpectedFetch), /state validation/u);
    await assert.rejects(completeOAuthAuthorization(config, `${config.redirectUri}?code=x&state=${state}`, unexpectedFetch), /state validation/u);
  } finally { browser.restore(); }
});

test("OAuth callback rejects ambiguous state before making a token request", async () => {
  const browser = installBrowserStubs();
  try {
    await beginOAuthAuthorization(config, metadataFetch());
    const state = new URL(browser.assigned).searchParams.get("state");
    let requests = 0;
    await assert.rejects(completeOAuthAuthorization(
      config,
      `${config.redirectUri}?code=x&state=${state}&state=${state}`,
      async () => { requests += 1; return Response.json({}); },
    ), /ambiguous state/u);
    assert.equal(requests, 0);
  } finally { browser.restore(); }
});

test("OAuth callback rejects a token response without a usable API access token", async () => {
  const browser = installBrowserStubs();
  try {
    await beginOAuthAuthorization(config, metadataFetch());
    const state = new URL(browser.assigned).searchParams.get("state");
    await assert.rejects(completeOAuthAuthorization(
      config,
      `${config.redirectUri}?code=x&state=${state}&iss=${encodeURIComponent(config.issuer)}`,
      async (_input, init) => init?.method === "POST" ? Response.json({
        id_token: "identity-token-is-not-an-api-credential",
        token_type: "Bearer",
        expires_in: 300,
      }) : Response.json(metadata),
    ), /usable API bearer access token/u);
  } finally { browser.restore(); }
});

test("OAuth callback rejects a different authorization-server issuer", async () => {
  const browser = installBrowserStubs();
  try {
    await beginOAuthAuthorization(config, metadataFetch());
    const state = new URL(browser.assigned).searchParams.get("state");
    let tokenExchanges = 0;
    await assert.rejects(completeOAuthAuthorization(
      config,
      `${config.redirectUri}?code=x&state=${state}&iss=https%3A%2F%2Fwrong.example.test%2Fapi%2Fauth`,
      async (_input, init) => {
        if (init?.method === "POST") tokenExchanges += 1;
        return Response.json(metadata);
      },
    ), /issuer validation/u);
    assert.equal(tokenExchanges, 0);
  } finally { browser.restore(); }
});

test("OAuth discovery rejects a wrong issuer and public-client capability mismatch", async () => {
  const browser = installBrowserStubs();
  try {
    await assert.rejects(beginOAuthAuthorization(config,
      async () => Response.json({ ...metadata, issuer: "https://wrong.example.test/api/auth" })), /metadata does not meet/u);
    await assert.rejects(beginOAuthAuthorization(config,
      async () => Response.json({ ...metadata, token_endpoint_auth_methods_supported: ["client_secret_post"] })), /metadata does not meet/u);
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
