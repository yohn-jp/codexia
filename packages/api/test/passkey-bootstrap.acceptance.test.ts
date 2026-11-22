import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { test } from "node:test";
import { chromium, type Browser, type BrowserContext, type CDPSession, type Page } from "@playwright/test";
import { Pool } from "pg";
import { assertDisposableAuthFixtureDatabaseUrl } from "./fixtures/better-auth-server.js";
import { createBetterAuthRuntime, type BetterAuthRuntimeConfig } from "../src/better-auth.js";

const grantIdentifier = "codexia:first-owner-passkey:v1";
const grantContext = "codexia-first-owner-v1";
const authRuntimeRole = "codexia_auth_runtime";

interface HttpFixture {
  readonly origin: string;
  readonly server: HttpServer;
  close(): Promise<void>;
}

interface RegistrationAttempt {
  readonly optionsStatus: number;
  readonly rpId?: string;
  readonly userVerification?: string;
  readonly verifyStatus?: number;
  readonly response?: Record<string, unknown>;
}

function listen(server: HttpServer, port = 0): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, () => {
      server.removeListener("error", reject);
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("Passkey fixture did not bind a TCP port"));
      resolve(address.port);
    });
  });
}

function close(server: HttpServer): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function bodyChunks(request: import("node:http").IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function send(response: import("node:http").ServerResponse, status: number, body: Buffer, headers?: Headers): void {
  const outputHeaders: Record<string, string | string[]> = headers ? Object.fromEntries(headers.entries()) : {};
  const cookies = headers?.getSetCookie() ?? [];
  if (cookies.length) outputHeaders["set-cookie"] = cookies;
  response.writeHead(status, outputHeaders);
  response.end(body);
}

async function startRuntimeHttpFixture(config: BetterAuthRuntimeConfig): Promise<{
  readonly runtime: ReturnType<typeof createBetterAuthRuntime>;
  readonly fixture: HttpFixture;
}> {
  const runtime = createBetterAuthRuntime(config);
  const server = createHttpServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", config.publicOrigin);
      if (url.pathname === "/") {
        send(response, 200, Buffer.from("<!doctype html><html><body><h1>Passkey acceptance fixture</h1></body></html>"),
          new Headers({ "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }));
        return;
      }
      const headers = new Headers();
      for (const [name, value] of Object.entries(request.headers)) {
        if (name === "host" || name === "connection" || value === undefined) continue;
        if (Array.isArray(value)) for (const item of value) headers.append(name, item);
        else headers.set(name, value);
      }
      const body = await bodyChunks(request);
      const method = request.method ?? "GET";
      const authRequest = new Request(url, {
        method,
        headers,
        ...(body.length && method !== "GET" && method !== "HEAD" ? { body: body.toString("utf8") } : {}),
      });
      const authResponse = await runtime.handler(authRequest);
      send(response, authResponse.status, Buffer.from(await authResponse.arrayBuffer()), authResponse.headers);
    })().catch(() => {
      if (!response.headersSent) response.writeHead(500, { "cache-control": "no-store" });
      response.end("Passkey fixture request failed");
    });
  });
  const origin = config.publicOrigin;
  const port = Number(new URL(origin).port);
  assert.ok(port > 0);
  await listen(server, port);
  return {
    runtime,
    fixture: {
      origin,
      server,
      close: () => close(server),
    },
  };
}

async function attachVirtualAuthenticator(
  context: BrowserContext,
  page: Page,
  hasUserVerification = true,
): Promise<{ readonly session: CDPSession; readonly authenticatorId: string }> {
  const session = await context.newCDPSession(page);
  await session.send("WebAuthn.enable");
  const result = await session.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification,
      isUserVerified: hasUserVerification,
      automaticPresenceSimulation: true,
    },
  });
  return { session, authenticatorId: result.authenticatorId };
}

async function newPasskeyPage(browser: Browser, contexts: BrowserContext[], origin: string): Promise<Page> {
  const context = await browser.newContext();
  contexts.push(context);
  const page = await context.newPage();
  await page.goto(origin);
  await attachVirtualAuthenticator(context, page);
  return page;
}

async function registerPasskey(
  page: Page,
  token: string,
  options: { readonly createSession?: boolean; readonly tamper?: "origin" | "challenge" | "rp" | "userVerification"; readonly rpId?: string } = {},
): Promise<RegistrationAttempt> {
  return page.evaluate(async ({ token, createSession, tamper, rpId, context }) => {
    const optionsResponse = await fetch(`/api/auth/passkey/generate-register-options?context=${encodeURIComponent(context)}`, {
      method: "GET",
      headers: { "x-codexia-owner-enrollment": token },
      credentials: "same-origin",
    });
    if (!optionsResponse.ok) return { optionsStatus: optionsResponse.status };
    const options = await optionsResponse.json() as {
      rp?: { id?: string };
      authenticatorSelection?: { userVerification?: string };
    };
    const publicKey = PublicKeyCredential.parseCreationOptionsFromJSON(options as never);
    if (rpId) publicKey.rp.id = rpId;
    const credential = await navigator.credentials.create({ publicKey });
    if (!(credential instanceof PublicKeyCredential)) throw new Error("Virtual authenticator did not create a credential");
    const encoded = credential.toJSON() as Record<string, unknown> & {
      response: { clientDataJSON: string; attestationObject: string };
    };
    if (tamper === "origin" || tamper === "challenge") {
      const bytes = Uint8Array.from(atob(encoded.response.clientDataJSON.replaceAll("-", "+").replaceAll("_", "/")), (character) => character.charCodeAt(0));
      const clientData = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
      if (tamper === "origin") clientData.origin = "https://wrong.codexia.test";
      if (tamper === "challenge") clientData.challenge = "not-the-issued-challenge";
      const json = new TextEncoder().encode(JSON.stringify(clientData));
      let binary = "";
      for (const byte of json) binary += String.fromCharCode(byte);
      encoded.response.clientDataJSON = btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
    }
    if (tamper === "rp" || tamper === "userVerification") {
      const bytes = Uint8Array.from(atob(encoded.response.attestationObject.replaceAll("-", "+").replaceAll("_", "/")), (character) => character.charCodeAt(0));
      const key = new TextEncoder().encode("authData");
      let keyOffset = -1;
      for (let offset = 0; offset <= bytes.length - key.length; offset++) {
        if (key.every((value, index) => bytes[offset + index] === value)) { keyOffset = offset; break; }
      }
      if (keyOffset < 0) throw new Error("Attestation omitted authenticator data");
      const headerOffset = keyOffset + key.length;
      const header = bytes[headerOffset]!;
      if ((header >> 5) !== 2) throw new Error("Attestation authenticator data is not a CBOR byte string");
      const extra = header & 31;
      const lengthBytes = extra < 24 ? 0 : extra === 24 ? 1 : extra === 25 ? 2 : extra === 26 ? 4 : 8;
      const dataOffset = headerOffset + 1 + lengthBytes;
      if (bytes.length < dataOffset + 37) throw new Error("Attestation authenticator data is truncated");
      if (tamper === "rp") {
        bytes.fill(0, dataOffset, dataOffset + 32);
      } else {
        const flagsOffset = dataOffset + 32;
        if ((bytes[flagsOffset]! & 0x04) === 0) throw new Error("Virtual authenticator did not set the user-verification flag");
        bytes[flagsOffset] = bytes[flagsOffset]! & ~0x04;
      }
      let binary = "";
      for (const byte of bytes) binary += String.fromCharCode(byte);
      encoded.response.attestationObject = btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
    }
    const verified = await fetch("/api/auth/passkey/verify-registration", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-codexia-owner-enrollment": token,
      },
      credentials: "same-origin",
      // Better Auth 1.7.26 leaves createSession undefined by default; the
      // owner bootstrap deliberately requires its transactional true path.
      body: JSON.stringify({ response: encoded, createSession: createSession ?? true }),
    });
    return {
      optionsStatus: optionsResponse.status,
      rpId: options.rp?.id,
      userVerification: options.authenticatorSelection?.userVerification,
      verifyStatus: verified.status,
      response: encoded,
    };
  }, { token, createSession: options.createSession, tamper: options.tamper, rpId: options.rpId, context: grantContext });
}

async function authenticatePasskey(page: Page): Promise<{ readonly optionsStatus: number; readonly verifyStatus?: number }> {
  return page.evaluate(async () => {
    const optionsResponse = await fetch("/api/auth/passkey/generate-authenticate-options", {
      credentials: "same-origin",
    });
    if (!optionsResponse.ok) return { optionsStatus: optionsResponse.status };
    const options = await optionsResponse.json();
    const publicKey = PublicKeyCredential.parseRequestOptionsFromJSON(options);
    const credential = await navigator.credentials.get({ publicKey });
    if (!(credential instanceof PublicKeyCredential)) throw new Error("Virtual authenticator did not return a credential");
    const response = await fetch("/api/auth/passkey/verify-authentication", {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ response: credential.toJSON() }),
    });
    return { optionsStatus: optionsResponse.status, verifyStatus: response.status };
  });
}

function cliEnv(databaseUrl: string, publicOrigin: string, authSecret: string, owner: { id: string; email: string; name: string }): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  for (const suffix of ["ISSUER", "CLIENT_ID", "CLIENT_SECRET"]) {
    delete environment[`CODEXIA_OIDC_${suffix}`];
    delete environment[`SCRIPTORIUM_OIDC_${suffix}`];
  }
  Object.assign(environment, {
    CODEXIA_AUTH_DATABASE_URL: databaseUrl,
    CODEXIA_PUBLIC_ORIGIN: publicOrigin,
    CODEXIA_AUTH_SECRET: authSecret,
    CODEXIA_OAUTH_INTROSPECTION_CLIENT_ID: "passkey-fixture-introspector",
    CODEXIA_OAUTH_INTROSPECTION_CLIENT_SECRET: "passkey-fixture-introspection-secret-over-32-bytes",
    CODEXIA_OAUTH_OWNER_CLIENT_IDS: "passkey-fixture-web,passkey-fixture-ios",
    CODEXIA_AUTH_PASSKEY_BOOTSTRAP_OWNER_ID: owner.id,
    CODEXIA_AUTH_PASSKEY_BOOTSTRAP_OWNER_EMAIL: owner.email,
    CODEXIA_AUTH_PASSKEY_BOOTSTRAP_OWNER_NAME: owner.name,
    CODEXIA_API_AUDIENCE: `${publicOrigin}/api`,
  });
  return environment;
}

function runPackageCli(command: "migrate-auth" | "grant-passkey-owner", args: readonly string[], env: NodeJS.ProcessEnv): {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
} {
  const script = new URL(`../dist/${command}.js`, import.meta.url);
  const result = spawnSync(process.execPath, [script.pathname, ...args], {
    cwd: new URL("..", import.meta.url).pathname,
    env,
    encoding: "utf8",
    timeout: 30_000,
  });
  return {
    status: result.status,
    stdout: String(result.stdout ?? ""),
    stderr: String(result.stderr ?? ""),
  };
}

function parseGrant(stdout: string): { readonly enrollmentToken: string; readonly expiresInSeconds: number; readonly ownerId: string; readonly setupPath: string } {
  try { return JSON.parse(stdout) as { enrollmentToken: string; expiresInSeconds: number; ownerId: string; setupPath: string }; }
  catch { throw new Error("Passkey grant CLI did not return its documented JSON result"); }
}

test("Better Auth 1.7.26 accepts only one operator-granted first owner and preserves the owner through restart", { timeout: 120_000 }, async (t) => {
  const databaseUrl = process.env.CODEXIA_AUTH_TEST_DATABASE_URL;
  assert.equal(process.env.CODEXIA_AUTH_TEST_DISPOSABLE, "1", "virtual WebAuthn acceptance needs an explicitly disposable auth database");
  assert.ok(databaseUrl, "CODEXIA_AUTH_TEST_DATABASE_URL must name a disposable PostgreSQL database");
  assertDisposableAuthFixtureDatabaseUrl(databaseUrl);

  const previousNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "test";
  const authSecret = randomBytes(32).toString("base64url");
  const owner = { id: `fixture-owner-${randomUUID()}`, email: `owner-${randomUUID()}@example.test`, name: "Codexia Acceptance Owner" };
  const authPortProbe = createHttpServer();
  let adminPool: Pool | undefined;
  let createdAuthRole = false;
  let runtime: ReturnType<typeof createBetterAuthRuntime> | undefined;
  let apiFixture: HttpFixture | undefined;
  let bootstrapRuntime: ReturnType<typeof createBetterAuthRuntime> | undefined;
  let browser: Browser | undefined;
  const contexts: BrowserContext[] = [];

  t.after(async () => {
    for (const context of contexts) await context.close().catch(() => undefined);
    if (browser) await browser.close().catch(() => undefined);
    if (bootstrapRuntime) await bootstrapRuntime.pool.end().catch(() => undefined);
    if (apiFixture) await apiFixture.close().catch(() => undefined);
    if (runtime) await runtime.pool.end().catch(() => undefined);
    if (adminPool) {
      await adminPool.query("DROP SCHEMA IF EXISTS codexia_auth CASCADE").catch(() => undefined);
      if (createdAuthRole) await adminPool.query(`DROP ROLE IF EXISTS ${authRuntimeRole}`).catch(() => undefined);
      await adminPool.end().catch(() => undefined);
    }
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
  });

  const database = new URL(databaseUrl);
  const rolePassword = randomBytes(32).toString("base64url");
  adminPool = new Pool({ connectionString: databaseUrl });
  await adminPool.query("DROP SCHEMA IF EXISTS codexia_auth CASCADE");
  const roleExists = await adminPool.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [authRuntimeRole]);
  assert.equal(roleExists.rowCount, 0, "the dedicated acceptance PostgreSQL cluster must not already use codexia_auth_runtime");
  await adminPool.query(`CREATE ROLE ${authRuntimeRole} LOGIN PASSWORD '${rolePassword}' NOSUPERUSER NOCREATEDB NOCREATEROLE`);
  createdAuthRole = true;
  await adminPool.query(`CREATE SCHEMA codexia_auth AUTHORIZATION ${authRuntimeRole}`);
  const runtimeDatabase = new URL(databaseUrl);
  runtimeDatabase.username = authRuntimeRole;
  runtimeDatabase.password = rolePassword;

  const authOriginProbePort = await listen(authPortProbe);
  await close(authPortProbe);
  const apiOrigin = `http://localhost:${authOriginProbePort}`;
  const migrationEnvironment = cliEnv(runtimeDatabase.toString(), "https://codexia-passkey-acceptance.example.test", authSecret, owner);
  const unappliedMigration = runPackageCli("migrate-auth", [], migrationEnvironment);
  assert.notEqual(unappliedMigration.status, 0, "auth schema migration must require --apply");
  const migration = runPackageCli("migrate-auth", ["--apply"], migrationEnvironment);
  assert.equal(migration.status, 0, "OIDC-free explicit auth migration must succeed against the disposable PostgreSQL schema");

  const grantWithoutApply = runPackageCli("grant-passkey-owner", [], migrationEnvironment);
  assert.notEqual(grantWithoutApply.status, 0, "operator grant command must require --apply");
  const grantResult = runPackageCli("grant-passkey-owner", ["--apply"], migrationEnvironment);
  assert.equal(grantResult.status, 0, "operator grant command must create a grant with OIDC settings absent");
  const grant = parseGrant(grantResult.stdout.trim());
  assert.equal(grant.ownerId, owner.id);
  assert.equal(grant.expiresInSeconds, 600);
  assert.equal(grant.setupPath, "/passkey");
  assert.equal(/^[A-Za-z0-9_-]{43}$/u.test(grant.enrollmentToken), true, "grant must be 32 random bytes encoded as base64url");

  const bootstrapConfig: BetterAuthRuntimeConfig = {
    databaseUrl: runtimeDatabase.toString(),
    publicOrigin: apiOrigin,
    authSecret,
    oauthIntrospectionClientId: "passkey-fixture-introspector",
    oauthIntrospectionClientSecret: "passkey-fixture-introspection-secret-over-32-bytes",
    ownerClientIds: ["passkey-fixture-web", "passkey-fixture-ios"],
    passkeyBootstrap: { ownerId: owner.id, ownerEmail: owner.email, ownerName: owner.name },
    allowInsecureLoopbackForTests: true,
  };
  const started = await startRuntimeHttpFixture(bootstrapConfig);
  bootstrapRuntime = started.runtime;
  apiFixture = started.fixture;
  assert.equal(apiFixture.origin, apiOrigin);

  const context = await bootstrapRuntime.auth.$context;
  const persistedGrant = await context.internalAdapter.findVerificationValue(grantIdentifier);
  assert.ok(persistedGrant);
  assert.equal(persistedGrant.value === createHash("sha256").update(grant.enrollmentToken).digest("hex"), true, "the database must retain only the SHA-256 grant digest");
  assert.equal(persistedGrant.value !== grant.enrollmentToken, true, "the database must not retain the raw grant");
  assert.ok(persistedGrant.expiresAt.getTime() > Date.now());
  assert.ok(persistedGrant.expiresAt.getTime() <= Date.now() + 10 * 60 * 1000);
  await assert.rejects(bootstrapRuntime.createPasskeyBootstrapGrant(), /already active/u);

  const invalidGrantUpdate = await context.adapter.findMany({ model: "user", limit: 1 });
  assert.equal(invalidGrantUpdate.length, 0);
  browser = await chromium.launch({
    headless: true,
  });
  const browserContext = await browser.newContext();
  contexts.push(browserContext);
  const page = await browserContext.newPage();
  await page.goto(apiOrigin);
  await attachVirtualAuthenticator(browserContext, page);

  const noGrant = await page.evaluate(async () => {
    const response = await fetch(`/api/auth/passkey/generate-register-options?context=${encodeURIComponent("codexia-first-owner-v1")}`);
    return response.status;
  });
  assert.ok(noGrant >= 400, "public registration options must fail without an operator grant");
  const wrongGrant = await page.evaluate(async ({ token }) => {
    const response = await fetch(`/api/auth/passkey/generate-register-options?context=${encodeURIComponent("codexia-first-owner-v1")}`, {
      headers: { "x-codexia-owner-enrollment": token },
    });
    return response.status;
  }, { token: `${grant.enrollmentToken}wrong` });
  assert.ok(wrongGrant >= 400, "a forged owner grant must fail");
  const publicSignup = await page.evaluate(async () => {
    const response = await fetch("/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Public Signup", email: "public@example.test", password: "not-a-real-password" }),
    });
    return response.status;
  });
  assert.ok(publicSignup >= 400, "public account signup must be unavailable");

  const missingContext = await page.evaluate(async ({ token }) => {
    const response = await fetch("/api/auth/passkey/generate-register-options", {
      headers: { "x-codexia-owner-enrollment": token },
    });
    return response.status;
  }, { token: grant.enrollmentToken });
  assert.ok(missingContext >= 400, "the bootstrap grant must be bound to the required context");

  await context.adapter.update({
    model: "verification",
    where: [{ field: "identifier", value: grantIdentifier }],
    update: { expiresAt: new Date(Date.now() - 1_000) },
  });
  const expiredRecord = await context.internalAdapter.findVerificationValue(grantIdentifier);
  assert.ok(expiredRecord && expiredRecord.expiresAt.getTime() < Date.now());
  const expiredOptions = await page.evaluate(async ({ token, context }) => {
    const response = await fetch(`/api/auth/passkey/generate-register-options?context=${encodeURIComponent(context)}`, {
      headers: { "x-codexia-owner-enrollment": token },
    });
    return response.status;
  }, { token: grant.enrollmentToken, context: grantContext });
  assert.ok(expiredOptions >= 400, "expired operator grants must not create registration challenges");
  const replacementResult = runPackageCli("grant-passkey-owner", ["--apply"], migrationEnvironment);
  assert.equal(replacementResult.status, 0, "an expired grant may be replaced while no owner exists");
  const replacementGrant = parseGrant(replacementResult.stdout.trim());
  assert.equal(replacementGrant.enrollmentToken !== grant.enrollmentToken, true, "an expired grant replacement must be fresh");

  const wrongOrigin = await registerPasskey(page, replacementGrant.enrollmentToken, { tamper: "origin" });
  assert.equal(wrongOrigin.optionsStatus, 200);
  assert.equal(wrongOrigin.rpId, "localhost");
  assert.equal(wrongOrigin.userVerification, "required");
  assert.ok((wrongOrigin.verifyStatus ?? 0) >= 400, "a response from a wrong origin must fail");
  assert.equal((await context.adapter.findMany({ model: "user", limit: 1 })).length, 0);

  const wrongChallengePage = await newPasskeyPage(browser, contexts, apiOrigin);
  const wrongChallenge = await registerPasskey(wrongChallengePage, replacementGrant.enrollmentToken, { tamper: "challenge" });
  assert.equal(wrongChallenge.optionsStatus, 200);
  assert.ok((wrongChallenge.verifyStatus ?? 0) >= 400, "an assertion with a changed challenge must fail");

  const wrongRpPage = await newPasskeyPage(browser, contexts, apiOrigin);
  const wrongRp = await registerPasskey(wrongRpPage, replacementGrant.enrollmentToken, { tamper: "rp" });
  assert.equal(wrongRp.optionsStatus, 200);
  assert.ok((wrongRp.verifyStatus ?? 0) >= 400, "a credential bound to a different valid RP ID must fail");

  const noUvPage = await newPasskeyPage(browser, contexts, apiOrigin);
  const noUv = await registerPasskey(noUvPage, replacementGrant.enrollmentToken, { tamper: "userVerification" });
  assert.equal(noUv.optionsStatus, 200);
  assert.equal(noUv.userVerification, "required");
  assert.ok((noUv.verifyStatus ?? 0) >= 400, "an authenticator response without user verification must fail server verification");

  const noSessionPage = await newPasskeyPage(browser, contexts, apiOrigin);
  const noSession = await registerPasskey(noSessionPage, replacementGrant.enrollmentToken, { createSession: false });
  assert.equal(noSession.optionsStatus, 200);
  assert.ok((noSession.verifyStatus ?? 0) >= 400, "bootstrap registration must reject createSession=false");
  assert.equal((await context.adapter.findMany({ model: "user", limit: 1 })).length, 0);
  assert.equal((await context.adapter.findMany({ model: "passkey" })).length, 0);

  const secondPage = await newPasskeyPage(browser!, contexts, apiOrigin);
  const race = await Promise.all([
    registerPasskey(page, replacementGrant.enrollmentToken),
    registerPasskey(secondPage, replacementGrant.enrollmentToken),
  ]);
  assert.deepEqual(race.map((attempt) => attempt.optionsStatus), [200, 200]);
  const winners = race.filter((attempt) => attempt.verifyStatus === 200);
  assert.equal(winners.length, 1, "only one concurrent attestation may consume the owner grant");
  const winnerIndex = race.findIndex((attempt) => attempt.verifyStatus === 200);
  const winnerPage = winnerIndex === 0 ? page : secondPage;
  const winnerResponse = winners[0]!.response;
  assert.ok(winnerResponse);
  assert.ok(race.some((attempt) => (attempt.verifyStatus ?? 0) >= 400), "the losing attestation must fail closed");

  const users = await context.adapter.findMany({ model: "user" });
  const passkeys = await context.adapter.findMany({ model: "passkey" });
  assert.equal(users.length, 1);
  assert.equal((users[0] as { id?: string }).id, owner.id, "the passkey must create the operator-selected internal owner ID");
  assert.equal(passkeys.length, 1);
  assert.equal((passkeys[0] as { userId?: string }).userId, owner.id, "the passkey must attach to the canonical owner");

  const replay = await winnerPage.evaluate(async ({ token, response }) => {
    const result = await fetch("/api/auth/passkey/verify-registration", {
      method: "POST",
      headers: { "content-type": "application/json", "x-codexia-owner-enrollment": token },
      credentials: "same-origin",
      body: JSON.stringify({ response, createSession: true }),
    });
    return result.status;
  }, { token: replacementGrant.enrollmentToken, response: winnerResponse });
  assert.ok(replay >= 400, "a consumed registration challenge must not replay");
  await assert.rejects(bootstrapRuntime.createPasskeyBootstrapGrant(), /empty authentication database/u);

  const authenticated = await winnerPage.evaluate(async () => {
    const response = await fetch("/api/auth/get-session", { credentials: "same-origin" });
    const result = await response.json() as { user?: { id?: string } };
    return { status: response.status, userId: result.user?.id };
  });
  assert.equal(authenticated.status, 200);
  assert.equal(authenticated.userId, owner.id);

  await apiFixture.close();
  apiFixture = undefined;
  await bootstrapRuntime.pool.end();
  bootstrapRuntime = undefined;

  const normalRuntimeConfig: BetterAuthRuntimeConfig = {
    ...bootstrapConfig,
    ownerSubject: owner.id,
  };
  const restarted = await startRuntimeHttpFixture(normalRuntimeConfig);
  runtime = restarted.runtime;
  apiFixture = restarted.fixture;
  await (await runtime.auth.$context).runMigrations();
  const restartedContext = await runtime.auth.$context;
  const restartedUser = await restartedContext.adapter.findOne({ model: "user", where: [{ field: "id", value: owner.id }] });
  assert.ok(restartedUser, "the same owner must survive a runtime restart without OIDC configuration");
  assert.equal((await restartedContext.adapter.findMany({ model: "passkey" })).length, 1);
  await winnerPage.goto(apiOrigin);
  const oldSession = await winnerPage.evaluate(async () => {
    const response = await fetch("/api/auth/get-session", { credentials: "same-origin" });
    return { status: response.status, body: await response.json() as { user?: { id?: string } } };
  });
  assert.equal(oldSession.status, 200, "the registration session must persist across an auth runtime restart");
  assert.equal(oldSession.body.user?.id, owner.id);
  const signout = await winnerPage.evaluate(async () => (await fetch("/api/auth/sign-out", {
    method: "POST", credentials: "same-origin",
  })).status);
  assert.equal(signout, 200);
  const signedOut = await winnerPage.evaluate(async () => (await fetch("/api/auth/get-session", { credentials: "same-origin" })).status);
  assert.equal(signedOut, 200);
  const signin = await authenticatePasskey(winnerPage);
  assert.equal(signin.optionsStatus, 200);
  assert.equal(signin.verifyStatus, 200, "the enrolled owner must sign in with the same passkey after restart");
  const signedIn = await winnerPage.evaluate(async () => {
    const response = await fetch("/api/auth/get-session", { credentials: "same-origin" });
    const result = await response.json() as { user?: { id?: string } };
    return { status: response.status, userId: result.user?.id };
  });
  assert.equal(signedIn.status, 200);
  assert.equal(signedIn.userId, owner.id);
});
