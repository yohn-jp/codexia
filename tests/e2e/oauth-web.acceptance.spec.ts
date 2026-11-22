import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test, type Request, type Route } from "@playwright/test";
import { expectServerSaved, manuscriptEditor } from "./postgres-fixture";
import { createHash } from "node:crypto";
import { request as httpRequest } from "node:http";
import { createPostgresPersistence } from "@codexia/persistence-postgres";
import type { DocumentId, ProjectId } from "@codexia/persistence-contracts";
import { startBetterAuthFixture, type BootstrapRegistration } from "../../packages/api/test/fixtures/better-auth-server.js";

const appAssets = mkdtempSync(join(tmpdir(), "codexia-oauth-web-assets-"));
const fixtureDatabaseUrl = process.env.CODEXIA_WEB_OAUTH_TEST_DATABASE_URL ?? process.env.CODEXIA_E2E_DATABASE_URL;
test.afterAll(() => rmSync(appAssets, { recursive: true, force: true }));

interface SeenRequest {
  pathname: string;
  url: string;
  method: string;
  status: number;
  headers: Record<string, string>;
  body: string | null;
}

test("Web OAuth preserves consent, owner persistence, and drafts during reauthentication", async ({ browser }) => {
  assert.ok(fixtureDatabaseUrl, "Set CODEXIA_WEB_OAUTH_TEST_DATABASE_URL or the isolated CI database for Web OAuth acceptance");
  const database = new URL(fixtureDatabaseUrl);
  const databaseName = decodeURIComponent(database.pathname.slice(1));
  const ciFixtureDatabase = process.env.CI === "true" && database.hostname === "postgres" && /^codexia_ci_[a-f0-9]{32}$/u.test(databaseName);
  const optedLocalFixtureDatabase = process.env.CODEXIA_AUTH_TEST_DISPOSABLE === "1" &&
    ["127.0.0.1", "localhost", "[::1]"].includes(database.hostname) &&
    databaseName === "codexia_web_oauth_test";
  assert.ok(optedLocalFixtureDatabase || ciFixtureDatabase, "OAuth fixture database must be explicitly opted-in or uniquely disposable in CI");
  assert.ok(!database.search && !database.hash, "OAuth fixture URL must not include query parameters or fragments");

  // Auth clients, sessions, token records, and manuscript revisions use PostgreSQL.
  const fixture = await startBetterAuthFixture({
    databaseUrl: fixtureDatabaseUrl,
    staticDirectory: appAssets,
    usePostgresPersistence: true,
    async registerInBrowser(origin) {
      const bootstrapContext = await browser.newContext();
      try {
        const page = await bootstrapContext.newPage();
        await page.goto(origin);
        await page.getByRole("button", { name: "Sign in to the identity provider" }).click();
        await page.getByRole("link", { name: "Continue to the identity provider" }).click();
        await expect(page).toHaveURL(origin + "/");
        const response = page.waitForResponse(origin + "/register");
        await page.getByRole("button", { name: "Register the approved OAuth clients" }).click();
        const registration = await response;
        assert.equal(registration.status(), 200, await registration.text());
        return await registration.json() as BootstrapRegistration;
      } finally {
        await bootstrapContext.close();
      }
    },
  });
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
    for (const ui of ["launcher", "desktop", "mobile", "oauth"]) {
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
    const observedRequests = new Map<Request, SeenRequest>();
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
      const observation = {
        pathname: url.pathname,
        url: request.url(),
        method: request.method(),
        status: 0,
        headers: Object.fromEntries(Object.entries(request.headers()).map(([name, value]) => [name.toLowerCase(), value])),
        body: request.postData(),
      };
      seen.push(observation);
      observedRequests.set(request, observation);
    });
    page.on("response", (response) => {
      const request = observedRequests.get(response.request());
      if (request) request.status = response.status();
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
      await page.getByRole("button", { name: "IDプロバイダーでサインイン" }).click({ timeout: 8000 });
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
    await page.getByText("Codexia Web", { exact: false }).waitFor();
    await Promise.all(responseTasks);
    assert.ok(seen.some((request) => request.pathname === "/api/auth/oauth2/consent-context" && request.status === 200), `the server must verify the signed prompt before consent display; observed ${JSON.stringify(seen.map(({ pathname, method, status }) => ({ pathname, method, status })))}`);
    // Register both response observers before triggering the OAuth callback.
    // Session and jobs can complete before sequential waitForResponse calls attach.
    const projectListResponse = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/v1/persistence/projects" && response.request().method() === "GET" && response.status() === 200);
    const sessionResponse = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/session" && response.status() === 200);
    const jobsResponse = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/jobs" && response.request().method() === "GET" && response.status() === 200);
    await page.getByRole("button", { name: "許可して続ける" }).click();
    await Promise.all([sessionResponse, jobsResponse, projectListResponse]);
    await Promise.all(responseTasks);
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
    await manuscriptEditor(page).fill(manuscript);
    const savePromise = page.waitForResponse((response) => new URL(response.url()).pathname === `/api/v1/persistence/projects/${createdProject.id}/documents/${scene.id}` && response.request().method() === "PATCH" && response.status() === 200);
    await savePromise;
    await expectServerSaved(page);

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

    const projectCreateRequest = seen.find((request) => request.pathname === "/api/v1/persistence/projects" && request.method === "POST");
    const documentCreateRequest = seen.find((request) => request.pathname === `/api/v1/persistence/projects/${createdProject.id}/documents` && request.method === "POST");
    const manuscriptSaveRequest = seen.find((request) => request.pathname === `/api/v1/persistence/projects/${createdProject.id}/documents/${scene.id}` && request.method === "PATCH");
    for (const request of [projectCreateRequest, documentCreateRequest, manuscriptSaveRequest]) {
      assert.ok(request, "project, document and manuscript mutation requests must be observed");
      assert.ok(request.headers.authorization === `Bearer ${String(tokenResponse.access_token)}`, "each author mutation must use the OAuth access token");
      assert.equal(Boolean(request.headers.cookie), false, "author mutation requests must omit ambient cookies");
      assert.equal(request.status, request.method === "PATCH" ? 200 : 201);
    }

    await test.step("an unprotected draft blocks OAuth reauthentication", async () => {
      const documentPath = new URL(page.url()).pathname;
      const authorizePath = `${new URL(fixture.issuer).pathname}/oauth2/authorize`;
      const countAuthorizations = () => seen.filter((request) => request.pathname === authorizePath).length;
      const authorizationsBeforeRecovery = countAuthorizations();
      await page.evaluate(() => {
        const put = IDBObjectStore.prototype.put;
        IDBObjectStore.prototype.put = function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore["put"]>) {
          if (this.name === "persistenceDrafts") throw new DOMException("Browser draft unavailable", "QuotaExceededError");
          return put.apply(this, args);
        };
      });
      const unsaved = "Editing without device storage must survive session recovery.";
      await manuscriptEditor(page).fill(unsaved);
      await expect(manuscriptEditor(page)).toHaveText(unsaved);

      const unavailableSession = (route: Route) =>
        route.fulfill({ status: 503, json: { error: "Session check unavailable" } });
      await page.route("**/api/session", unavailableSession);
      await page.evaluate(() => {
        window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true }));
        window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
      });
      await expect(page.getByRole("heading", { name: "認証・接続を再確認してください" })).toBeVisible();
      await page.getByRole("button", { name: "OAuthで再認証" }).click();
      await expect(page.getByRole("alert")).toContainText("保護できないためOAuth認証への移動を停止しました");
      expect(countAuthorizations()).toBe(authorizationsBeforeRecovery);
      expect(new URL(page.url()).pathname).toBe(documentPath);

      await page.unroute("**/api/session", unavailableSession);
      await page.getByRole("button", { name: "再試行", exact: true }).click();
      await expect(manuscriptEditor(page)).toHaveText(unsaved);
      await expect(page.getByRole("heading", { name: "OAuth Scene", exact: true })).toBeVisible();
    });
  } finally {
    if (context) await context.close();
    await fixture.close();
  }
});
