import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { createHash } from "node:crypto";
import { request as httpRequest } from "node:http";
import { createPostgresPersistence } from "@codexia/persistence-postgres";
import type { DocumentId, ProjectId } from "@codexia/persistence-contracts";
import { assertDisposableAuthFixtureDatabaseUrl, startBetterAuthFixture } from "../../packages/api/test/fixtures/better-auth-server.js";

const appRoot = resolve("app");
const appAssets = resolve(appRoot, "dist");
const fixtureDatabaseUrl = process.env.CODEXIA_WEB_OAUTH_TEST_DATABASE_URL ?? process.env.CODEXIA_E2E_DATABASE_URL;
mkdirSync(appAssets, { recursive: true });

test("Better Auth browser fixtures accept only explicit local or uniquely named CI databases", () => {
  const previousOptIn = process.env.CODEXIA_AUTH_TEST_DISPOSABLE;
  const previousCi = process.env.CI;
  try {
    delete process.env.CODEXIA_AUTH_TEST_DISPOSABLE;
    process.env.CI = "false";
    assert.throws(() => assertDisposableAuthFixtureDatabaseUrl("postgres://codexia:codexia@127.0.0.1:5432/codexia_web_oauth_test"));

    process.env.CODEXIA_AUTH_TEST_DISPOSABLE = "1";
    assert.doesNotThrow(() => assertDisposableAuthFixtureDatabaseUrl("postgres://codexia:codexia@127.0.0.1:5432/codexia_web_oauth_test"));
    assert.throws(() => assertDisposableAuthFixtureDatabaseUrl("postgres://codexia:codexia@127.0.0.1:5432/codexia_dev"));
    assert.throws(() => assertDisposableAuthFixtureDatabaseUrl("postgres://codexia:codexia@db.example.test/codexia_web_oauth_test"));
    assert.throws(() => assertDisposableAuthFixtureDatabaseUrl("postgres://codexia:codexia@127.0.0.1:5432/codexia_web_oauth_test?sslmode=require"));
    assert.throws(() => assertDisposableAuthFixtureDatabaseUrl("postgres://codexia:codexia@127.0.0.1:5432/codexia_web_oauth_test#fragment"));

    delete process.env.CODEXIA_AUTH_TEST_DISPOSABLE;
    process.env.CI = "true";
    assert.doesNotThrow(() => assertDisposableAuthFixtureDatabaseUrl("postgres://codexia:codexia@postgres:5432/codexia_ci_0123456789abcdef0123456789abcdef"));
    assert.throws(() => assertDisposableAuthFixtureDatabaseUrl("postgres://codexia:codexia@postgres:5432/codexia_ci_0123456789abcdef0123456789abcdef?sslmode=require"));
    assert.throws(() => assertDisposableAuthFixtureDatabaseUrl("postgres://codexia:codexia@postgres:5432/codexia_test"));
  } finally {
    if (previousOptIn === undefined) delete process.env.CODEXIA_AUTH_TEST_DISPOSABLE;
    else process.env.CODEXIA_AUTH_TEST_DISPOSABLE = previousOptIn;
    if (previousCi === undefined) delete process.env.CI;
    else process.env.CI = previousCi;
  }
});

interface SeenRequest {
  pathname: string;
  url: string;
  method: string;
  status: number;
  headers: Record<string, string>;
  body: string | null;
}

test("signed-out Web OAuth preserves the signed request through consent, PKCE, and protected owner API lists", async ({ browser }) => {
  assert.ok(fixtureDatabaseUrl, "Set CODEXIA_WEB_OAUTH_TEST_DATABASE_URL to the dedicated disposable local PostgreSQL database");
  const database = new URL(fixtureDatabaseUrl);
  const databaseName = decodeURIComponent(database.pathname.slice(1));
  const ciFixtureDatabase = process.env.CI === "true" && database.hostname === "postgres" && /^codexia_ci_[a-f0-9]{32}$/u.test(databaseName);
  const optedLocalFixtureDatabase = process.env.CODEXIA_AUTH_TEST_DISPOSABLE === "1" && database.hostname === "127.0.0.1" && databaseName === "codexia_web_oauth_test";
  assert.ok(optedLocalFixtureDatabase || ciFixtureDatabase, "OAuth fixture database must be the opted-in dedicated loopback database or uniquely named disposable CI database");
  assert.ok(!database.search && !database.hash, "OAuth fixture database URL must not include query parameters or a fragment");

    // Auth clients, OAuth sessions, token records, JWT checks and manuscript CoreStore/persistence use PostgreSQL.
    // The job-history list is a separate in-memory test double.
    const fixture = await startBetterAuthFixture({ databaseUrl: fixtureDatabaseUrl, staticDirectory: appAssets, usePostgresPersistence: true });
  let context: Awaited<ReturnType<typeof browser.newContext>> | undefined;
  try {
    const build = spawnSync("pnpm", ["--filter", "@codexia/app", "build"], {
      cwd: resolve("."),
      encoding: "utf8",
      env: {
        ...process.env,
        CODEXIA_PROFILE: process.env.CODEXIA_PROFILE ?? "core",
        VITE_CODEXIA_OAUTH_ISSUER: fixture.issuer,
        VITE_CODEXIA_OAUTH_CLIENT_ID: fixture.webClientId,
        VITE_CODEXIA_API_AUDIENCE: fixture.audience,
        VITE_CODEXIA_OAUTH_DESKTOP_REDIRECT_URI: `${fixture.apiOrigin}/desktop`,
        VITE_CODEXIA_OAUTH_MOBILE_REDIRECT_URI: `${fixture.apiOrigin}/mobile`,
        VITE_CODEXIA_OAUTH_SCOPES: "openid codexia:api",
      },
    });
    assert.equal(build.status, 0, `Web build failed:\n${build.stdout}\n${build.stderr}`);

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
    const projectListResponse = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/v1/persistence/projects" && response.request().method() === "GET" && response.status() === 200);
    await page.getByRole("button", { name: "許可して続ける" }).click();
    await page.waitForResponse((response) => new URL(response.url()).pathname === "/api/session" && response.status() === 200);
    await page.waitForResponse((response) => new URL(response.url()).pathname === "/api/jobs" && response.request().method() === "GET" && response.status() === 200);
    await projectListResponse;
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

    const projectList = seen.find((request) => request.pathname === "/api/v1/persistence/projects" && request.method === "GET" && request.status === 200);
    assert.ok(projectList, `the owner bearer token must read the PostgreSQL-backed project list; observed ${JSON.stringify(seen.map(({ pathname, method, status }) => ({ pathname, method, status })))}`);
    assert.ok(projectList.headers.authorization === `Bearer ${String(tokenResponse.access_token)}`, "the project list must use the OAuth access token");
    assert.equal(Boolean(projectList.headers.cookie), false, "the project list must omit the Better Auth session cookie");

    const projectTitle = `OAuth browser acceptance ${crypto.randomUUID()}`;
    await page.getByRole("button", { name: "最初の作品を作成" }).click();
    await page.getByLabel("作品名").fill(projectTitle);
    const projectCreatePromise = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/v1/persistence/projects" && response.request().method() === "POST" && response.status() === 201);
    await page.locator("details.pg-library-create").locator("button[type=submit]").click();
    const projectCreateResponse = await projectCreatePromise;
    const createdProject = (await projectCreateResponse.json() as { project: { id: string; title: string } }).project;
    assert.equal(createdProject.title, projectTitle);

    const createDocument = async (kind: "volume" | "chapter" | "scene", title: string, parentLabel: string | null) => {
      const form = page.locator("details.pg-library-create-document");
      if (!await form.evaluate((element) => (element as HTMLDetailsElement).open)) await form.locator("summary").click();
      await form.getByLabel("文書名").fill(title);
      await form.getByLabel("種類").selectOption(kind);
      await form.getByLabel("追加先").selectOption(parentLabel ? { label: parentLabel } : { label: "作品の直下" });
      const responsePromise = page.waitForResponse((response) => new URL(response.url()).pathname === `/api/v1/persistence/projects/${createdProject.id}/documents` && response.request().method() === "POST" && response.status() === 201);
      await form.locator("button[type=submit]").click();
      const response = await responsePromise;
      return (await response.json() as { document: { id: string; title: string }; revision: { id: string } }).document;
    };
    const volume = await createDocument("volume", "OAuth Volume", null);
    const chapter = await createDocument("chapter", "OAuth Chapter", volume.title);
    const scene = await createDocument("scene", "OAuth Scene", chapter.title);
    await page.getByRole("heading", { name: scene.title, exact: true }).waitFor();
    const manuscript = "Bearer-authenticated manuscript text survives PostgreSQL revision storage.";
    await page.getByRole("textbox", { name: "本文", exact: true }).fill(manuscript);
    const savePromise = page.waitForResponse((response) => new URL(response.url()).pathname === `/api/v1/persistence/projects/${createdProject.id}/documents/${scene.id}` && response.request().method() === "PATCH" && response.status() === 200);
    await savePromise;
    await expect(page.locator(".pg-save-state summary")).toHaveText("保存済み", { timeout: 15_000 });

    const persisted = createPostgresPersistence(fixtureDatabaseUrl);
    try {
      const saved = await persisted.read(async (reader) => {
        const project = await reader.getProject(createdProject.id as ProjectId);
        const document = await reader.getDocument(createdProject.id as ProjectId, scene.id as DocumentId);
        const revision = document?.headRevisionId
          ? await reader.getRevision(createdProject.id as ProjectId, scene.id as DocumentId, document.headRevisionId)
          : undefined;
        return { project, document, revision };
      });
      assert.equal(saved.project?.title, projectTitle, "project row must exist in PostgreSQL");
      assert.equal(saved.document?.title, scene.title, "document row must exist in PostgreSQL");
      assert.equal(saved.revision?.markdown, manuscript, "the authenticated Web save must persist its manuscript revision in PostgreSQL");
    } finally {
      await persisted.close();
    }

    applyResponseStatuses();
    const projectCreateRequest = seen.find((request) => request.pathname === "/api/v1/persistence/projects" && request.method === "POST");
    const documentCreateRequest = seen.find((request) => request.pathname === `/api/v1/persistence/projects/${createdProject.id}/documents` && request.method === "POST");
    const manuscriptSaveRequest = seen.find((request) => request.pathname === `/api/v1/persistence/projects/${createdProject.id}/documents/${scene.id}` && request.method === "PATCH");
    for (const request of [projectCreateRequest, documentCreateRequest, manuscriptSaveRequest]) {
      assert.ok(request, "project, document and manuscript mutation requests must be observed");
      assert.ok(request.headers.authorization === `Bearer ${String(tokenResponse.access_token)}`, "each author mutation must use the OAuth access token");
      assert.equal(Boolean(request.headers.cookie), false, "author mutation requests must omit ambient cookies");
      assert.equal(request.status, request.method === "PATCH" ? 200 : 201);
    }
  } finally {
    if (context) await context.close();
    await fixture.close();
  }
});
