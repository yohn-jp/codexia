import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "@playwright/test";
import { createHash } from "node:crypto";
import { request as httpRequest } from "node:http";
import { startBetterAuthFixture } from "../../packages/api/test/fixtures/better-auth-server.js";

const appAssets = mkdtempSync(join(tmpdir(), "codexia-oauth-web-assets-"));
const fixtureDatabaseUrl = process.env.CODEXIA_TEST_DATABASE_URL ?? process.env.CODEXIA_E2E_DATABASE_URL;
test.afterAll(() => rmSync(appAssets, { recursive: true, force: true }));

interface SeenRequest {
  pathname: string;
  url: string;
  method: string;
  status: number;
  headers: Record<string, string>;
  body: string | null;
}

test("signed-out Web OAuth preserves the signed request through consent, PKCE, and protected owner API lists", async ({ browser }) => {
  assert.ok(fixtureDatabaseUrl, "Set CODEXIA_TEST_DATABASE_URL to a disposable local PostgreSQL database");
  const database = new URL(fixtureDatabaseUrl);
  const databaseName = decodeURIComponent(database.pathname.slice(1));
  const ciFixtureDatabase = process.env.CI === "true" && database.hostname === "postgres" && /^codexia_ci_[a-f0-9]{32}$/u.test(databaseName);
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(database.hostname) || ciFixtureDatabase, "OAuth fixture database must be local or the uniquely named disposable CI database");

    // Auth clients, OAuth sessions, token records and JWT checks use PostgreSQL. The fixture's CoreStore,
    // persistence object, and job history are in-memory/test doubles; this proves protected list admission,
    // not PostgreSQL manuscript row persistence.
    const fixture = await startBetterAuthFixture({ databaseUrl: fixtureDatabaseUrl, staticDirectory: appAssets });
  let context: Awaited<ReturnType<typeof browser.newContext>> | undefined;
  try {
    const buildEnvironment = {
      ...process.env,
      CODEXIA_PROFILE: process.env.CODEXIA_PROFILE ?? "core",
      CODEXIA_VITE_BUILD_OUTPUT_ROOT: appAssets,
      VITE_CODEXIA_OAUTH_ISSUER: fixture.issuer,
      VITE_CODEXIA_OAUTH_CLIENT_ID: fixture.webClientId,
      VITE_CODEXIA_API_AUDIENCE: fixture.audience,
      VITE_CODEXIA_OAUTH_DESKTOP_REDIRECT_URI: `${fixture.apiOrigin}/desktop`,
      VITE_CODEXIA_OAUTH_MOBILE_REDIRECT_URI: `${fixture.apiOrigin}/mobile`,
      VITE_CODEXIA_OAUTH_SCOPES: "openid codexia:api",
    };
    // Never mutate app/dist: other Playwright shards concurrently serve its
    // standard (non-OAuth) shells from the same checkout.
    for (const ui of ["launcher", "desktop", "mobile"]) {
      const build = spawnSync("pnpm", ["--filter", "@codexia/app", "exec", "vite", "build"], {
        cwd: resolve("."),
        encoding: "utf8",
        env: { ...buildEnvironment, CODEXIA_UI: ui },
      });
      assert.equal(build.status, 0, `Isolated ${ui} OAuth build failed:\n${build.stdout}\n${build.stderr}`);
    }

    const discoveryResponse = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const request = httpRequest(`${fixture.apiOrigin}/.well-known/oauth-authorization-server/api/auth`, (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer | string) => chunks.push(Buffer.from(chunk)));
        response.on("end", () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
      });
      request.on("error", reject);
      request.end();
    });
    assert.equal(discoveryResponse.status, 200);
    const discovery = JSON.parse(discoveryResponse.body) as Record<string, unknown>;
    assert.equal(discovery.issuer, fixture.issuer);
    assert.ok((discovery.token_endpoint_auth_methods_supported as unknown[]).includes("none"));
    assert.equal(discovery.authorization_endpoint, `${fixture.issuer}/oauth2/authorize`);

    context = await browser.newContext();
    const seen: SeenRequest[] = [];
    const responseStatuses = new Map<string, number[]>();
    const applyResponseStatuses = () => {
      const positions = new Map<string, number>();
      for (const request of seen) {
        const key = `${request.method} ${request.pathname}`;
        const position = positions.get(key) ?? 0;
        request.status = responseStatuses.get(key)?.[position] ?? 0;
        positions.set(key, position + 1);
      }
    };
    const responseTasks: Promise<void>[] = [];
    const tokenResponses: Record<string, unknown>[] = [];
    let upstreamCallbackLocation: string | null = null;
    const webCallbackUrls: URL[] = [];
    const page = await context.newPage();
    page.on("framenavigated", (frame) => {
      if (frame !== page.mainFrame()) return;
      const url = new URL(frame.url());
      if (url.pathname === "/desktop" && url.searchParams.has("code") && url.searchParams.has("iss")) webCallbackUrls.push(url);
    });
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (!url.pathname.startsWith("/api/")) return;
      seen.push({
          pathname: url.pathname,
          url: request.url(),
          method: request.method(),
          status: 0,
          headers: Object.fromEntries(Object.entries(request.headers()).map(([name, value]) => [name.toLowerCase(), value])),
          body: request.postData(),
        });
    });
    page.on("response", (response) => {
      const responseRequest = response.request();
      const responseKey = `${responseRequest.method()} ${new URL(response.url()).pathname}`;
      responseStatuses.set(responseKey, [...(responseStatuses.get(responseKey) ?? []), response.status()]);
      if (new URL(response.url()).pathname.endsWith("/api/auth/callback/workspace-oidc")) {
        responseTasks.push((async () => { upstreamCallbackLocation = await response.headerValue("location"); })());
      }
      if (new URL(response.url()).pathname !== "/api/auth/oauth2/token" || !response.ok()) return;
      responseTasks.push((async () => { tokenResponses.push(await response.json() as Record<string, unknown>); })());
    });
    await page.goto(`${fixture.apiOrigin}/desktop`);
    await page.getByRole("button", { name: "OAuthでサインイン" }).click();
    await page.waitForURL((url) => url.pathname === "/oauth/login" && Boolean(url.searchParams.get("sig")));
    const signedSearch = new URL(page.url()).search;
    try {
      await page.getByRole("button", { name: "登録済みアカウントで続ける" }).click({ timeout: 8000 });
    } catch (error) {
      console.error("OAuth login page rendered:", await page.locator("body").innerText());
      throw error;
    }
    await page.waitForURL((url) => url.pathname === "/oauth/consent", { waitUntil: "domcontentloaded" });
    await Promise.all(responseTasks);
    assert.ok(upstreamCallbackLocation, "the upstream OIDC callback must resume through Better Auth");
    const serverContinuation = new URL(upstreamCallbackLocation!, fixture.apiOrigin);
    assert.equal(serverContinuation.pathname, "/oauth/consent", "Better Auth must resume at its configured consent route");
    const socialSignIn = seen.find((request) => request.pathname === "/api/auth/sign-in/social" && request.method === "POST");
    assert.ok(socialSignIn?.body, "the Web login must start the official Better Auth social sign-in");
    const socialSignInBody = JSON.parse(socialSignIn.body) as Record<string, unknown>;
    assert.ok(socialSignInBody.callbackURL === `/oauth/login${signedSearch}`, "social sign-in must use the fixed login route with the exact signed query");
    const originalPrompt = new URLSearchParams(signedSearch);
    const consentPrompt = new URL(page.url()).searchParams;
    assert.ok(serverContinuation.search === new URL(page.url()).search, "Better Auth must retain its server-signed consent continuation");
    for (const name of ["response_type", "redirect_uri", "scope", "state", "client_id", "code_challenge", "code_challenge_method", "resource"]) {
      assert.equal(consentPrompt.get(name), originalPrompt.get(name), `the consent continuation must preserve ${name}`);
    }
    assert.equal(consentPrompt.getAll("sig").length, 1, "the consent route must carry one server-signed query");
    await page.getByText("Codexia Fixture Web", { exact: false }).waitFor();
    await Promise.all(responseTasks);
    applyResponseStatuses();
    assert.ok(seen.some((request) => request.pathname === "/api/auth/oauth2/consent-context" && request.status === 200), `the server must verify the signed prompt before consent display; observed ${JSON.stringify(seen.map(({ pathname, method, status }) => ({ pathname, method, status })))}`);
    // Register both response observers before triggering the OAuth callback.
    // Session and jobs can complete before sequential waitForResponse calls attach.
    const sessionResponse = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/session" && response.status() === 200);
    const jobsResponse = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/jobs" && response.request().method() === "GET" && response.status() === 200);
    await page.getByRole("button", { name: "許可して続ける" }).click();
    await Promise.all([sessionResponse, jobsResponse]);
    applyResponseStatuses();
    const callbackUrl = webCallbackUrls.at(-1);
    assert.ok(callbackUrl, "the authorization response must return to the registered app callback");

    const tokenRequest = seen.find((request) => request.pathname === `${new URL(fixture.issuer).pathname}/oauth2/token`);
    assert.ok(tokenRequest?.body, "browser must exchange the authorization code");
    const tokenResponse = tokenResponses.at(-1);
    assert.ok(tokenResponse && typeof tokenResponse.access_token === "string", "the token endpoint must issue an API access token");
    const tokenForm = new URLSearchParams(tokenRequest.body);
    const authorizeRequest = seen.find((request) => request.pathname.endsWith("/oauth2/authorize") && request.method === "GET");
    assert.ok(authorizeRequest, "authorization code flow must start with a browser navigation");
    const authorizationUrl = new URL(authorizeRequest.url);
    const authorizationParams = authorizationUrl.searchParams;
    assert.equal(authorizationParams.get("resource"), fixture.audience);
    assert.equal(authorizationParams.get("code_challenge_method"), "S256");
    assert.ok(callbackUrl.searchParams.get("state") === authorizationParams.get("state"), "authorization callback must retain the original state");
    assert.equal(tokenForm.get("grant_type"), "authorization_code");
    assert.ok(tokenForm.get("code") === callbackUrl.searchParams.get("code"), "the app must exchange the returned authorization code");
    assert.equal(tokenForm.get("resource"), fixture.audience);
    assert.equal(tokenForm.has("client_secret"), false);
    assert.ok(tokenForm.get("code_verifier"));
    assert.ok(createHash("sha256").update(tokenForm.get("code_verifier") ?? "").digest("base64url") === authorizationParams.get("code_challenge"), "the exchanged verifier must match the PKCE challenge");

    const apiSession = seen.find((request) => request.pathname === "/api/session" && request.status === 200);
    assert.ok(apiSession, `the API must accept the issued owner access token; observed ${JSON.stringify(seen.map(({ pathname, method, status }) => ({ pathname, method, status })))}`);
    const ownerList = seen.find((request) => request.pathname === "/api/jobs" && request.method === "GET" && request.status === 200);
    assert.ok(ownerList, `the owner token must reach the protected job list route; observed ${JSON.stringify(seen.map(({ pathname, method, status }) => ({ pathname, method, status })))}`);
    const sessionCookieNames = apiSession.headers.cookie?.split(";").map((part) => part.split("=", 1)[0].trim()) ?? [];
    assert.ok(apiSession.headers.authorization?.startsWith("Bearer "), `the owner API session request must send a bearer access token (headers=${Object.keys(apiSession.headers).join(",")}; cookies=${sessionCookieNames.join(",")})`);
    assert.ok(apiSession.headers.authorization === `Bearer ${String(tokenResponse.access_token)}`, "the API session must use the OAuth access token, not the ID token");
    assert.equal(Boolean(apiSession.headers.cookie), false, "ordinary bearer API calls must omit the Better Auth session cookie");
    assert.ok(ownerList.headers.authorization?.startsWith("Bearer "), "the owner list request must send a bearer access token");
    assert.ok(ownerList.headers.authorization === `Bearer ${String(tokenResponse.access_token)}`, "the protected owner list must use the OAuth access token");
    assert.equal(Boolean(ownerList.headers.cookie), false, "protected data list calls must omit the Better Auth session cookie");
    assert.equal(Boolean(tokenRequest.headers.cookie), false, "public-client token exchange must omit ambient cookies");
    if (typeof tokenResponse.id_token === "string") assert.ok(apiSession.headers.authorization !== `Bearer ${tokenResponse.id_token}`, "the API must never receive the upstream ID token");
  } finally {
    if (context) await context.close();
    await fixture.close();
  }
});
