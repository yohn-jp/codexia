import assert from "node:assert/strict";
import test from "node:test";
import { createBetterAuthRuntime, type BetterAuthRuntimeConfig } from "./better-auth.js";

const baseConfig: BetterAuthRuntimeConfig = {
  databaseUrl: "postgres://codexia_auth_runtime:placeholder@127.0.0.1:5432/codexia",
  publicOrigin: "https://codexia.example.test",
  oidcIssuer: "https://idp.example.test",
  oidcClientId: "codexia-web",
  oidcClientSecret: "fixture-oidc-client-secret-with-enough-length",
  authSecret: "fixture-auth-secret-with-at-least-thirty-two-bytes",
  oauthIntrospectionClientId: "codexia-introspector",
  oauthIntrospectionClientSecret: "fixture-introspection-secret-with-enough-length",
  ownerClientIds: ["codexia-web"],
};

test("Better Auth runtime rejects insecure production origins before opening PostgreSQL", () => {
  assert.throws(() => createBetterAuthRuntime({ ...baseConfig, publicOrigin: "http://codexia.example.test" }), /absolute HTTPS URL/u);
});

test("Better Auth runtime rejects non-PostgreSQL or URL-overridden auth database settings before connecting", () => {
  assert.throws(() => createBetterAuthRuntime({ ...baseConfig, databaseUrl: "https://example.test/auth" }), /absolute PostgreSQL URL/u);
  assert.throws(() => createBetterAuthRuntime({ ...baseConfig, databaseUrl: `${baseConfig.databaseUrl}?options=-c%20search_path=public` }), /without query or fragment/u);
});

test("Better Auth runtime rejects owner and limited MCP client overlap before opening PostgreSQL", () => {
  assert.throws(() => createBetterAuthRuntime({ ...baseConfig, mcpClientIds: ["codexia-web"] }), /must be disjoint/u);
});

test("Better Auth supports Passkey-first bootstrap without upstream OIDC", async () => {
  const runtime = createBetterAuthRuntime({
    ...baseConfig,
    oidcIssuer: undefined,
    oidcClientId: undefined,
    oidcClientSecret: undefined,
    passkeyBootstrap: {
      ownerId: "operator-approved-owner",
      ownerEmail: "owner@example.test",
      ownerName: "Codexia Owner",
    },
  });
  await runtime.pool.end();
});

test("Better Auth refuses partial upstream OIDC settings", () => {
  assert.throws(() => createBetterAuthRuntime({ ...baseConfig, oidcClientSecret: undefined }), /configured together/u);
  assert.throws(() => createBetterAuthRuntime({ ...baseConfig, oidcIssuer: undefined }), /configured together/u);
});

test("Better Auth validates Passkey owner bootstrap identity before opening PostgreSQL", () => {
  assert.throws(() => createBetterAuthRuntime({
    ...baseConfig,
    passkeyBootstrap: { ownerId: " ", ownerEmail: "owner@example.test", ownerName: "Codexia Owner" },
  }), /stable owner ID/u);
  assert.throws(() => createBetterAuthRuntime({
    ...baseConfig,
    passkeyBootstrap: { ownerId: "owner", ownerEmail: "not-an-email", ownerName: "Codexia Owner" },
  }), /email/u);
});
