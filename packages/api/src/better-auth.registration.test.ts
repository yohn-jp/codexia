import assert from "node:assert/strict";
import test from "node:test";
import { assertBetterAuthClientRegistrations, type BetterAuthClientRegistry } from "./better-auth.js";

const config = {
  audience: "https://codexia.example.test/api",
  ownerSubject: "existing-owner-user",
  ownerClientIds: ["codexia-web", "codexia-ios"],
  mcpClientIds: ["codexia-mcp"],
  introspectionClientId: "codexia-introspector",
};

function makeRegistry(overrides: Partial<{
  owner: unknown | null;
  clients: Record<string, unknown>;
  resources: Record<string, readonly unknown[]>;
}> = {}): BetterAuthClientRegistry {
  const clients = overrides.clients ?? {
    "codexia-web": {
      clientId: "codexia-web", tokenEndpointAuthMethod: "none", grantTypes: ["authorization_code", "refresh_token"],
      responseTypes: ["code"], requirePKCE: true, scopes: ["openid", "codexia:api"], disabled: false,
    },
    "codexia-ios": {
      clientId: "codexia-ios", tokenEndpointAuthMethod: "none", grantTypes: ["authorization_code", "refresh_token"],
      responseTypes: ["code"], requirePKCE: true, scopes: ["openid", "codexia:api"], disabled: false,
    },
    "codexia-mcp": {
      clientId: "codexia-mcp", tokenEndpointAuthMethod: "none", grantTypes: ["authorization_code", "refresh_token"],
      responseTypes: ["code"], requirePKCE: true, scopes: ["openid", "mcp:read"], disabled: false,
    },
    "codexia-introspector": {
      clientId: "codexia-introspector", tokenEndpointAuthMethod: "client_secret_post", clientSecret: "stored-hash",
      grantTypes: ["authorization_code"], responseTypes: ["code"], disabled: false,
    },
  };
  const resources = overrides.resources ?? Object.fromEntries(
    Object.keys(clients).map((clientId) => [clientId, [{ resourceId: config.audience }]]),
  );
  return {
    async getOwner() { return Object.hasOwn(overrides, "owner") ? overrides.owner : { id: config.ownerSubject }; },
    async getClient(clientId) { return clients[clientId] ?? null; },
    async getClientResources(clientId) { return resources[clientId] ?? []; },
  };
}

test("registered public clients use PKCE, authorization code, owner scope, and the API resource", async () => {
  await assertBetterAuthClientRegistrations(config, makeRegistry());
});

test("registration validation rejects a configured owner client that is missing", async () => {
  const registry = makeRegistry({ clients: {} });
  await assert.rejects(assertBetterAuthClientRegistrations(config, registry), /Registered Better Auth owner client is missing/u);
});

test("registration validation rejects a configured owner subject that is missing", async () => {
  await assert.rejects(assertBetterAuthClientRegistrations(config, makeRegistry({ owner: null })), /owner subject is not registered/u);
});

test("registration validation rejects duplicate client IDs instead of normalizing configuration", async () => {
  await assert.rejects(
    assertBetterAuthClientRegistrations({ ...config, ownerClientIds: ["codexia-web", "codexia-web"] }, makeRegistry()),
    /owner client registration is required/u,
  );
});

test("registration validation rejects a disabled or non-PKCE public client", async () => {
  const clients = {
    "codexia-web": {
      clientId: "codexia-web", tokenEndpointAuthMethod: "none", grantTypes: ["authorization_code", "refresh_token"],
      responseTypes: ["code"], requirePKCE: true, scopes: ["openid", "codexia:api"], disabled: false,
    },
    "codexia-ios": {
      clientId: "codexia-ios", tokenEndpointAuthMethod: "none", grantTypes: ["authorization_code"],
      responseTypes: ["code"], requirePKCE: false, scopes: ["openid", "codexia:api"], disabled: true,
    },
    "codexia-mcp": {
      clientId: "codexia-mcp", tokenEndpointAuthMethod: "none", grantTypes: ["authorization_code", "refresh_token"],
      responseTypes: ["code"], requirePKCE: true, scopes: ["openid", "mcp:read"], disabled: false,
    },
    "codexia-introspector": {
      clientId: "codexia-introspector", tokenEndpointAuthMethod: "client_secret_post", clientSecret: "stored-hash",
      grantTypes: ["authorization_code"], responseTypes: ["code"], disabled: false,
    },
  };
  await assert.rejects(assertBetterAuthClientRegistrations(config, makeRegistry({ clients })), /Registered Better Auth owner client is disabled or does not require Authorization Code with PKCE/u);
});

test("registration validation rejects a public client with ambiguous enabled state", async () => {
  const registry = makeRegistry({ clients: {
    "codexia-web": {
      clientId: "codexia-web", tokenEndpointAuthMethod: "none", grantTypes: ["authorization_code", "refresh_token"],
      responseTypes: ["code"], requirePKCE: true, scopes: ["openid", "codexia:api"],
    },
  } });
  await assert.rejects(assertBetterAuthClientRegistrations(config, registry), /disabled or does not require Authorization Code with PKCE/u);
});

test("registration validation rejects clients not linked to the configured API audience", async () => {
  const resources = { "codexia-web": [{ resourceId: "https://other.example.test/api" }] };
  await assert.rejects(assertBetterAuthClientRegistrations(config, makeRegistry({ resources })), /not linked to the configured API audience/u);
});

test("registration validation rejects a public introspection client", async () => {
  const clients = {
    "codexia-web": { clientId: "codexia-web", tokenEndpointAuthMethod: "none", grantTypes: ["authorization_code", "refresh_token"], responseTypes: ["code"], requirePKCE: true, scopes: ["openid", "codexia:api"], disabled: false },
    "codexia-ios": { clientId: "codexia-ios", tokenEndpointAuthMethod: "none", grantTypes: ["authorization_code", "refresh_token"], responseTypes: ["code"], requirePKCE: true, scopes: ["openid", "codexia:api"], disabled: false },
    "codexia-mcp": { clientId: "codexia-mcp", tokenEndpointAuthMethod: "none", grantTypes: ["authorization_code", "refresh_token"], responseTypes: ["code"], requirePKCE: true, scopes: ["openid", "mcp:read"], disabled: false },
    "codexia-introspector": { clientId: "codexia-introspector", tokenEndpointAuthMethod: "none", grantTypes: ["authorization_code"], responseTypes: ["code"], disabled: false },
  };
  await assert.rejects(assertBetterAuthClientRegistrations(config, makeRegistry({ clients })), /confidential registered client/u);
});

test("registration validation rejects an owner public client with unapproved extra scopes", async () => {
  const registry = makeRegistry({ clients: {
    "codexia-web": {
      clientId: "codexia-web", tokenEndpointAuthMethod: "none", grantTypes: ["authorization_code", "refresh_token"],
      responseTypes: ["code"], requirePKCE: true, scopes: ["openid", "codexia:api", "mcp:propose"], disabled: false,
    },
    "codexia-ios": {
      clientId: "codexia-ios", tokenEndpointAuthMethod: "none", grantTypes: ["authorization_code", "refresh_token"],
      responseTypes: ["code"], requirePKCE: true, scopes: ["openid", "codexia:api"], disabled: false,
    },
    "codexia-mcp": {
      clientId: "codexia-mcp", tokenEndpointAuthMethod: "none", grantTypes: ["authorization_code", "refresh_token"],
      responseTypes: ["code"], requirePKCE: true, scopes: ["openid", "mcp:read"], disabled: false,
    },
    "codexia-introspector": {
      clientId: "codexia-introspector", tokenEndpointAuthMethod: "client_secret_post", clientSecret: "stored-hash",
      grantTypes: ["authorization_code"], responseTypes: ["code"], disabled: false,
    },
  } });
  await assert.rejects(assertBetterAuthClientRegistrations(config, registry), /owner client has an unsupported scope/u);
});
