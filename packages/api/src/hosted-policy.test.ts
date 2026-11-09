import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { test } from "node:test";
import {
  createHostedAuthorizationPolicy,
  HostedAuthorizationError,
  type HostedRuntimeAssignment,
} from "./hosted-policy.js";

const NOW = Date.parse("2026-10-17T03:00:00.000Z");
const NOW_SECONDS = Math.floor(NOW / 1000);
const REPOSITORY_ID = 342_100_801;
const INSTANCE_ID = "instance_123";
const RUNTIME_EPOCH = 7;
const ISSUER = "https://gateway.example.test";
const AUDIENCE = "https://instance.example.test";
const CONTROL_ISSUER = "https://control.example.test";

const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const otherPair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });

function publicJwkFor(keyPair: typeof pair, kid: string) {
  const rawPublicJwk = keyPair.publicKey.export({ format: "jwk" });
  return {
    kty: "EC",
    crv: "P-256",
    x: rawPublicJwk.x,
    y: rawPublicJwk.y,
    use: "sig",
    alg: "ES256",
    kid,
  };
}

const publicJwk = publicJwkFor(pair, "hosted-test-key");

function signJwt(payload: Record<string, unknown>, keyPair: typeof pair, kid: string): string {
  const header = Buffer.from(JSON.stringify({ alg: "ES256", kid, typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signingInput = `${header}.${body}`;
  const signature = sign("sha256", Buffer.from(signingInput), { key: keyPair.privateKey, dsaEncoding: "ieee-p1363" });
  return `${signingInput}.${signature.toString("base64url")}`;
}

function jwt(payload: Record<string, unknown>): string {
  return signJwt(payload, pair, "hosted-test-key");
}

function accessGrant(overrides: Record<string, unknown> = {}): string {
  return jwt({
    iss: ISSUER,
    sub: "github-user-42",
    aud: AUDIENCE,
    instanceId: INSTANCE_ID,
    repositoryId: REPOSITORY_ID,
    runtimeEpoch: RUNTIME_EPOCH,
    permissions: ["read", "write"],
    sessionRevision: 4,
    authorizationRevision: 9,
    iat: NOW_SECONDS,
    nbf: NOW_SECONDS,
    exp: NOW_SECONDS + 120,
    jti: "grant-1",
    ...overrides,
  });
}

function assignment(overrides: Partial<HostedRuntimeAssignment> = {}): HostedRuntimeAssignment {
  return {
    contractVersion: "scriptorium-platform/v1",
    instanceId: INSTANCE_ID,
    repositoryId: REPOSITORY_ID,
    repositoryLocator: "https://github.com/yohn-jp/novel",
    defaultBranchPolicy: "repository-default",
    runtimeEpoch: RUNTIME_EPOCH,
    credentialBrokerLocator: `${ISSUER}/internal/github/credential`,
    controlServicePolicy: {
      issuer: CONTROL_ISSUER,
      jwksUrl: `${CONTROL_ISSUER}/.well-known/control-jwks.json`,
      audience: "codexia-platform-control",
    },
    grantPolicy: {
      issuer: ISSUER,
      jwksUrl: `${ISSUER}/.well-known/jwks.json`,
      audience: AUDIENCE,
    },
    ...overrides,
  };
}

function response(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "Content-Type": "application/json" } });
}

function grantFetch(extra?: (url: URL, init?: RequestInit) => Response | Promise<Response>): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname === "/.well-known/jwks.json") return response({ keys: [publicJwk] });
    if (extra) return extra(url, init);
    throw new Error("unexpected upstream request");
  }) as typeof fetch;
}

test("hosted access grants bind issuer, audience, repository, instance, epoch and permission", async () => {
  const policy = createHostedAuthorizationPolicy({
    assignment: assignment(),
    now: () => NOW,
    fetch: grantFetch(),
  });
  const principal = await policy.authenticate(accessGrant(), "write");
  assert.deepEqual(principal, {
    userId: "github-user-42",
    permissions: ["read", "write"],
    repositoryId: REPOSITORY_ID,
    instanceId: INSTANCE_ID,
    runtimeEpoch: RUNTIME_EPOCH,
    sessionRevision: 4,
    authorizationRevision: 9,
    expiresAt: (NOW_SECONDS + 120) * 1000,
  });

  await assert.rejects(
    policy.authenticate(accessGrant({ runtimeEpoch: RUNTIME_EPOCH - 1 })),
    (error: unknown) => error instanceof HostedAuthorizationError && error.status === 401,
  );
  await assert.rejects(
    policy.authenticate(accessGrant({ repositoryId: REPOSITORY_ID + 1 })),
    (error: unknown) => error instanceof HostedAuthorizationError && error.status === 401,
  );
  await assert.rejects(
    policy.authenticate(accessGrant({ instanceId: "another-instance" })),
    (error: unknown) => error instanceof HostedAuthorizationError && error.status === 401,
  );
  await assert.rejects(
    policy.authenticate(accessGrant({ iss: "https://forged.example.test" })),
    (error: unknown) => error instanceof HostedAuthorizationError && error.status === 401,
  );
  await assert.rejects(
    policy.authenticate(accessGrant({ permissions: ["read"] }), "write"),
    (error: unknown) => error instanceof HostedAuthorizationError && error.status === 403,
  );
  await assert.rejects(
    policy.authenticate(accessGrant({ aud: "https://another-instance.example.test" })),
    (error: unknown) => error instanceof HostedAuthorizationError && error.status === 401,
  );
  assert.equal((await policy.authenticate(accessGrant({ sub: "github-user-99" }), "read")).userId, "github-user-99");
});

test("hosted access authorization never calls Git endpoints or exposes a credential broker", async () => {
  const calls: string[] = [];
  const policy = createHostedAuthorizationPolicy({ assignment: assignment(), now: () => NOW, fetch: grantFetch(async (url) => {
    calls.push(String(url));
    throw new Error("Git endpoints must never be called");
  }) });
  await policy.authenticate(accessGrant(), "write");
  assert.deepEqual(calls, []);
  assert.equal("authorizePublication" in policy, false);
  const exports = await import("./hosted-policy.js");
  assert.equal("createHostedGitCredentialProvider" in exports, false);
});

test("invalid hosted signing keys remain a service failure", async () => {
  const policy = createHostedAuthorizationPolicy({ assignment: assignment(), now: () => NOW, fetch: async () => response({keys: []}) });
  await assert.rejects(policy.authenticate(accessGrant(), "read"),
    (error: unknown) => error instanceof HostedAuthorizationError && error.status === 503);
});

test("hosted access grants reject future, overlong, and malformed authorization claims", async () => {
  const policy = createHostedAuthorizationPolicy({ assignment: assignment(), now: () => NOW, fetch: grantFetch() });
  for (const claims of [
    { iat: NOW_SECONDS + 1 },
    { nbf: NOW_SECONDS + 1 },
    { exp: NOW_SECONDS + 301 },
    { sessionRevision: -1 },
    { authorizationRevision: 1.5 },
  ]) {
    await assert.rejects(policy.authenticate(accessGrant(claims), "write"),
      (error: unknown) => error instanceof HostedAuthorizationError && error.status === 401);
  }
});

test("hosted access grants signed by an unknown key remain unauthorized after JWKS refresh", async () => {
  const policy = createHostedAuthorizationPolicy({ assignment: assignment(), now: () => NOW, fetch: grantFetch() });
  const token = signJwt({
    iss: ISSUER,
    sub: "github-user-42",
    aud: AUDIENCE,
    instanceId: INSTANCE_ID,
    repositoryId: REPOSITORY_ID,
    runtimeEpoch: RUNTIME_EPOCH,
    permissions: ["read", "write"],
    sessionRevision: 4,
    authorizationRevision: 9,
    iat: NOW_SECONDS,
    nbf: NOW_SECONDS,
    exp: NOW_SECONDS + 120,
    jti: "grant-unknown-key",
  }, otherPair, "unknown-key");
  await assert.rejects(policy.authenticate(token, "read"),
    (error: unknown) => error instanceof HostedAuthorizationError && error.status === 401);
});

test("expired and tampered hosted access grants fail closed", async () => {
  const policy = createHostedAuthorizationPolicy({ assignment: assignment(), now: () => NOW, fetch: grantFetch() });
  for (const token of [accessGrant({ exp: NOW_SECONDS - 1 }), `${accessGrant().slice(0, -4)}AAAA`]) {
    await assert.rejects(policy.authenticate(token, "write"),
      (error: unknown) => error instanceof HostedAuthorizationError && error.status === 401);
  }
});
