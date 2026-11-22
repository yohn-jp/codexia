import test from "node:test";
import assert from "node:assert/strict";
import { CALLBACK_URI, nativeApiOrigin, nativeOAuthConfig, nativeReaderOrigin } from "./native-config.mjs";

const input = {
  VITE_CODEXIA_API_ORIGIN: "https://api.example.test",
  VITE_CODEXIA_OAUTH_IOS_CLIENT_ID: "codexia-ios-public",
  VITE_CODEXIA_API_AUDIENCE: "https://api.example.test/api",
};

test("native OAuth stays disabled without its dedicated public client ID", () => {
  assert.equal(nativeOAuthConfig({ VITE_CODEXIA_API_ORIGIN: input.VITE_CODEXIA_API_ORIGIN }), null);
});

test("native API transport can be configured independently of optional OAuth client registration", () => {
  assert.equal(nativeApiOrigin({ VITE_CODEXIA_API_ORIGIN: input.VITE_CODEXIA_API_ORIGIN }), "https://api.example.test/");
  assert.equal(nativeApiOrigin({}), null);
});

test("native reader origin is distinct from the API origin and optional when unavailable", () => {
  assert.equal(nativeReaderOrigin({}), null);
  assert.equal(nativeReaderOrigin({ VITE_CODEXIA_PUBLIC_READER_ORIGIN: "https://reader.example.test" }), "https://reader.example.test/");
  assert.notEqual(
    nativeApiOrigin({ VITE_CODEXIA_API_ORIGIN: input.VITE_CODEXIA_API_ORIGIN }),
    nativeReaderOrigin({ VITE_CODEXIA_PUBLIC_READER_ORIGIN: "https://reader.example.test" }),
  );
});

test("builds a separate public iOS client for the Better Auth issuer and API resource", () => {
  const config = nativeOAuthConfig(input);
  assert.equal(config.issuer, "https://api.example.test/api/auth");
  assert.equal(config.authorizationEndpoint, "https://api.example.test/api/auth/oauth2/authorize");
  assert.equal(config.tokenEndpoint, "https://api.example.test/api/auth/oauth2/token");
  assert.equal(config.apiOrigin, "https://api.example.test/");
  assert.equal(config.apiAudience, "https://api.example.test/api");
  assert.equal(config.clientId, "codexia-ios-public");
  assert.equal(config.redirectUri, CALLBACK_URI);
  assert.deepEqual(config.scopes, ["openid", "codexia:api", "offline_access"]);
});

test("defaults the resource indicator only from the explicit HTTPS API origin", () => {
  const config = nativeOAuthConfig({ ...input, VITE_CODEXIA_API_AUDIENCE: undefined });
  assert.equal(config.apiAudience, "https://api.example.test/api");
});

test("rejects missing API origin, non-HTTPS hosts, and path-bearing API origins", () => {
  assert.throws(() => nativeOAuthConfig({ ...input, VITE_CODEXIA_API_ORIGIN: undefined }), /HTTPS API origin/);
  for (const origin of ["http://api.example.test", "https://user:pass@api.example.test", "https://api.example.test/v1"]) {
    assert.throws(() => nativeOAuthConfig({ ...input, VITE_CODEXIA_API_ORIGIN: origin }), /HTTPS API origin|HTTPS origin/);
  }
});

test("rejects reader URLs that are not a public HTTPS origin", () => {
  for (const origin of ["http://reader.example.test", "https://reader.example.test/path", "https://reader.example.test/?q=1", "https://user:pass@reader.example.test", "https://reader.example.test/#fragment"]) {
    assert.throws(() => nativeReaderOrigin({ VITE_CODEXIA_PUBLIC_READER_ORIGIN: origin }), /HTTPS reader origin|reader origin/);
  }
});

test("rejects an audience that is not an absolute HTTPS resource URL", () => {
  assert.throws(() => nativeOAuthConfig({ ...input, VITE_CODEXIA_API_AUDIENCE: "api" }), /audience/);
});
