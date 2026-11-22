import { expect, test, type Page } from "@playwright/test";
import { ownerLogin, fixtureProject, createWritingFixture, manuscriptEditor, readPersistenceDrafts, fillDraft } from "./postgres-fixture";

const authToken = process.env.CODEXIA_E2E_AUTH_TOKEN ?? "";

async function mockAuthenticatedWorkspace(page: Page, hosted: boolean, session?: () => { status: number; body: unknown }): Promise<void> {
  await page.route("**/api/browser/version", (route) => route.fulfill({ json: { name: "codexia", version: "test", hosted, profile: hosted ? "hosted" : "core" } }));
  await page.route("**/api/session", (route) => {
    const response = session?.() ?? { status: 200, body: { authenticated: true, authorScope: hosted ? "hosted:synthetic-author" : "owner", ...(hosted ? { permissions: ["read", "write"] } : {}) } };
    return route.fulfill({ status: response.status, json: response.body });
  });
  await page.route("**/api/v1/persistence/status", (route) => route.fulfill({ json: { available: true, provider: "postgres" } }));
  await page.route("**/api/v1/persistence/projects*", (route) => route.fulfill({ json: [] }));
  await page.route("**/api/jobs", (route) => route.fulfill({ json: [] }));
  await page.route("**/api/jobs/events", (route) => route.fulfill({ headers: { "content-type": "text/event-stream" }, body: "" }));
  await page.route("**/api/inbox", (route) => route.fulfill({ json: { items: [], unreadCount: 0 } }));
  await page.goto("/desktop/");
  await expect(page.getByRole("heading", { name: "Database workspace" })).toBeVisible();
}

for (const shell of ["desktop", "mobile"] as const) {
  test(`Access SSO enters the ${shell} shell, reauthenticates and logs out without a Codexia token`, async ({ page }) => {
    let signedIn = false;
    let tokenLogins = 0;
    let tokenLogouts = 0;
    await page.route("**/api/version", route => route.abort("failed"));
    await page.route("**/api/browser/version", route => route.fulfill({
      json: { name: "codexia", version: "test", hosted: false, profile: "full", browserAuth: "cloudflare-access" },
    }));
    await page.route("**/api/session", route => signedIn
      ? route.fulfill({ json: { authenticated: true, authorScope: "owner" } })
      : route.fulfill({ status: 401, json: { error: "Authentication required", code: "UNAUTHORIZED" } }));
    await page.route("**/api/v1/persistence/status", route => route.fulfill({ json: { available: true, provider: "postgres" } }));
    await page.route("**/api/v1/persistence/projects*", route => route.fulfill({ json: [] }));
    await page.route("**/api/jobs", route => route.fulfill({ json: [] }));
    await page.route("**/api/jobs/events", route => route.fulfill({ headers: { "content-type": "text/event-stream" }, body: "" }));
    await page.route("**/api/inbox", route => route.fulfill({ json: { items: [], unreadCount: 0 } }));
    await page.route("**/api/login", route => { tokenLogins++; return route.fulfill({ status: 410 }); });
    await page.route("**/api/logout", route => { tokenLogouts++; return route.fulfill({ status: 410 }); });
    await page.route("**/cdn-cgi/access/logout", route => route.fulfill({ contentType: "text/html", body: "Access logout fixture" }));
    await page.goto(`/${shell}/`);
    await expect(page.getByRole("heading", { name: "Cloudflare Accessで認証してください" })).toBeVisible();
    await expect(page.getByLabel("アクセス・トークン")).toHaveCount(0);
    signedIn = true;
    await page.getByRole("button", { name: "再認証" }).click();
    if (shell === "mobile") await page.getByRole("button", { name: "設定を開く" }).click();
    await expect(page.getByRole("button", { name: "ログアウト", exact: true })).toBeVisible();
    await expect(page.getByLabel("アクセス・トークン")).toHaveCount(0);
    await page.getByRole("button", { name: "ログアウト", exact: true }).click();
    await expect(page).toHaveURL(/\/cdn-cgi\/access\/logout$/u);
    expect(tokenLogins).toBe(0);
    expect(tokenLogouts).toBe(0);
  });
}

test("an unavailable initial version cannot incorrectly offer the standalone token form", async ({ page }) => {
  await page.route(/\/api\/(?:browser\/)?version$/u, route => route.fulfill({
    status: 401, json: { error: "Edge authentication required", code: "UNAUTHORIZED" },
  }));
  await page.goto("/desktop/");
  await expect(page.getByRole("heading", { name: "PostgreSQLへ接続できません" })).toBeVisible();
  await expect(page.getByRole("button", { name: "ページを再読み込み" })).toBeVisible();
  await expect(page.getByLabel("アクセス・トークン")).toHaveCount(0);
});

test("an unknown hosted grant requests refresh and retries the initial session check", async ({ page }) => {
  let sessionRequests = 0;
  let refreshRequests = 0;
  let reauthRequests = 0;
  let grantFresh = false;

  await page.route("**/api/browser/version", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ name: "codexia", version: "test", hosted: true, profile: "hosted" }),
  }));
  await page.route("**/api/v1/persistence/status", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ available: true, provider: "postgres" }) }));
  await page.route("**/api/session", (route) => {
    sessionRequests += 1;
    if (!grantFresh) {
      return route.fulfill({
        status: 401,
        contentType: "application/json",
        body: JSON.stringify({ error: "Authentication required", code: "UNAUTHORIZED" }),
      });
    }
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ authenticated: true, authorScope: "hosted:synthetic-author", permissions: ["read", "write"] }),
    });
  });
  await page.route("**/api/v1/persistence/projects*", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: "[]",
  }));
  await page.route("**/api/jobs", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: "[]",
  }));
  await page.route("**/api/jobs/events", (route) => route.fulfill({ status: 200, headers: { "content-type": "text/event-stream" }, body: "" }));
  await page.route("**/api/inbox", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ items: [], unreadCount: 0 }),
  }));
  await page.route("**/_platform/refresh", async (route) => {
    refreshRequests += 1;
    grantFresh = true;
    await route.fulfill({ status: 204 });
  });
  await page.route("**/_platform/reauth", async (route) => {
    reauthRequests += 1;
    await route.fulfill({ status: 200, contentType: "text/html", body: "reauth fixture" });
  });

  await page.goto("/desktop/");
  await expect(page.getByRole("heading", { name: "割り当てられた作品がありません" })).toBeVisible();
  await expect(page.getByRole("button", { name: "最初の作品を作成" })).toHaveCount(0);
  expect(sessionRequests).toBe(3);
  expect(refreshRequests).toBe(1);
  expect(reauthRequests).toBe(0);
});

test("a failed standalone logout keeps the editor protected and lets the author retry", async ({ page }) => {
  await mockAuthenticatedWorkspace(page, false);
  let logoutRequests = 0;
  let serverLoggedOut = false;
  await page.route("**/api/logout", async (route) => {
    logoutRequests += 1;
    if (logoutRequests === 1) { await route.abort(); return; }
    serverLoggedOut = true;
    await route.fulfill({ json: { authenticated: false } });
  });

  await page.getByRole("button", { name: "ログアウト", exact: true }).click();
  await expect(page.getByRole("heading", { name: "認証・接続を再確認してください" })).toBeVisible();
  await expect(page.getByRole("alert")).toContainText("ログアウトの完了を確認できませんでした");
  await expect(page.getByLabel("アクセス・トークン")).toHaveCount(0);
  await page.getByRole("button", { name: "ログアウトを再試行" }).click();
  await expect(page.getByRole("heading", { name: "作品を開く" })).toBeVisible();
  expect(logoutRequests).toBe(2);
  expect(serverLoggedOut).toBe(true);
});

test("a failed pageshow session check cannot retry logout while the latest manuscript is unprotected", async ({ page }) => {
  const fixture = await createWritingFixture(page, "desktop", `Unprotected logout retry ${crypto.randomUUID()}`, "Initial manuscript.");
  await fillDraft(page, "Previously protected manuscript.");
  await page.evaluate(() => {
    const original = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore["put"]>) {
      if (this.name === "persistenceDrafts") throw new DOMException("Injected browser journal failure", "QuotaExceededError");
      return original.apply(this, args);
    };
  });
  await manuscriptEditor(page).fill("Latest manuscript that failed browser protection.");
  await expect(manuscriptEditor(page)).toContainText("Latest manuscript that failed browser protection.");

  let sessionUnavailable = false;
  let logoutRequests = 0;
  await page.route("**/api/session", (route) => sessionUnavailable
    ? route.fulfill({ status: 503, json: { error: "Session check unavailable" } })
    : route.continue());
  await page.route("**/api/logout", async (route) => {
    logoutRequests += 1;
    await route.fulfill({ json: { authenticated: false } });
  });
  sessionUnavailable = true;
  await page.evaluate(() => {
    window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true }));
    window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
  });
  await expect(page.getByRole("heading", { name: "認証・接続を再確認してください" })).toBeVisible();
  await page.getByRole("button", { name: "ログアウトを再試行" }).click();
  expect(logoutRequests).toBe(0);
  await expect(page.getByRole("alert")).toContainText("保護できない");

  sessionUnavailable = false;
  await page.getByRole("button", { name: "再試行", exact: true }).click();
  await expect(manuscriptEditor(page)).toContainText("Latest manuscript that failed browser protection.");
  await expect(page.getByRole("heading", { name: fixture.scene.title, exact: true })).toBeVisible();
  expect(logoutRequests).toBe(0);
});

test("OAuth reauthentication stays on the editor when draft protection fails", async ({ page }) => {
  test.skip(process.env.CODEXIA_E2E_OAUTH_UI !== "1", "requires an explicit OAuth-configured frontend build and provider fixture");
  const appBaseURL = process.env.CODEXIA_E2E_BASE_URL ?? process.env.CODEXIA_BASE_URL ?? `http://127.0.0.1:${process.env.CODEXIA_E2E_PORT ?? "4173"}`;
  const appOrigin = new URL(appBaseURL).origin;
  const headers = { Origin: appOrigin };
  const login = await page.request.post(new URL("/api/login", appBaseURL).toString(), { headers, data: { token: authToken } });
  expect(login.ok()).toBe(true);
  const projectResponse = await page.request.post(new URL("/api/v1/persistence/projects", appBaseURL).toString(), { headers, data: { title: `Unprotected OAuth retry ${crypto.randomUUID()}` } });
  expect(projectResponse.status()).toBe(201);
  const { project } = await projectResponse.json() as { project: { id: string } };
  const documentResponse = await page.request.post(new URL(`/api/v1/persistence/projects/${project.id}/documents`, appBaseURL).toString(), {
    headers: { ...headers, "Idempotency-Key": crypto.randomUUID() },
    data: { kind: "scene", title: "OAuth retry scene", orderKey: "a", markdown: "Initial manuscript." },
  });
  expect(documentResponse.status()).toBe(201);
  const { document } = await documentResponse.json() as { document: { id: string } };
  await page.goto(new URL(`/desktop/projects/${project.id}/scenes/${document.id}`, appBaseURL).toString());
  await expect(page.getByRole("heading", { name: "Database workspace" })).toBeVisible();
  await expect(manuscriptEditor(page)).toContainText("Initial manuscript.");
  await fillDraft(page, "Previously protected manuscript.");
  await page.evaluate(() => {
    const original = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore["put"]>) {
      if (this.name === "persistenceDrafts") throw new DOMException("Injected browser journal failure", "QuotaExceededError");
      return original.apply(this, args);
    };
  });
  await manuscriptEditor(page).fill("Latest manuscript that failed browser protection.");
  await expect(manuscriptEditor(page)).toContainText("Latest manuscript that failed browser protection.");

  let sessionUnavailable = false;
  let authorizationRequests = 0;
  await page.route("**/api/session", (route) => sessionUnavailable
    ? route.fulfill({ status: 503, json: { error: "Session check unavailable" } })
    : route.continue());
  await page.route("https://identity.example.test/authorize**", async (route) => {
    authorizationRequests += 1;
    await route.fulfill({ status: 200, contentType: "text/html", body: "OAuth provider fixture" });
  });
  sessionUnavailable = true;
  await page.evaluate(() => {
    window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true }));
    window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
  });
  await expect(page.getByRole("heading", { name: "認証・接続を再確認してください" })).toBeVisible();
  await page.getByRole("button", { name: "OAuthで再認証" }).click();
  await expect(page.getByRole("alert")).toContainText("保護できないためOAuth認証への移動を停止しました");
  expect(authorizationRequests).toBe(0);
  expect(new URL(page.url()).pathname).toContain(`/desktop/projects/${project.id}/scenes/${document.id}`);

  sessionUnavailable = false;
  await page.getByRole("button", { name: "再試行", exact: true }).click();
  await expect(manuscriptEditor(page)).toContainText("Latest manuscript that failed browser protection.");
  await expect(page.getByRole("heading", { name: "OAuth retry scene", exact: true })).toBeVisible();
});

test("recovery-session failure cannot discard an unjournaled manuscript through logout retry", async ({ page }) => {
  // Authoritative acceptance for #454: simulate an IndexedDB draft failure
  // and an independently failing session refresh on a real PostgreSQL document.
  const origin = process.env.CODEXIA_E2E_BASE_URL ?? process.env.CODEXIA_BASE_URL ?? `http://127.0.0.1:${process.env.CODEXIA_E2E_PORT ?? "4173"}`;
  const base = new URL(origin);
  const login = await page.request.post(new URL("/api/login", base).toString(), {
    headers: { Origin: base.origin },
    data: { token: authToken },
  });
  expect(login.status()).toBe(200);

  const { project, scene } = await createWritingFixture(page);
  let unavailable = false;
  let logoutRequests = 0;
  let saveRequests = 0;
  await page.route("**/api/session", route => unavailable
    ? route.fulfill({ status: 503, json: { error: "Temporary authentication outage" } })
    : route.continue());
  page.on("request", request => {
    if (new URL(request.url()).pathname === "/api/logout") logoutRequests += 1;
  });
  await page.route("**/api/v1/persistence/projects/*/documents/*", route => {
    if (route.request().method() === "PATCH") saveRequests += 1;
    return route.continue();
  });

  await page.evaluate(() => {
    const original = IDBObjectStore.prototype.put;
    const scope = window as Window & { __recoveryJournalWritesDenied?: boolean };
    scope.__recoveryJournalWritesDenied = true;
    IDBObjectStore.prototype.put = function (...args: Parameters<IDBObjectStore["put"]>) {
      if (this.name === "persistenceDrafts" && scope.__recoveryJournalWritesDenied) {
        throw new DOMException("Synthetic draft quota failure", "QuotaExceededError");
      }
      return original.apply(this, args);
    };
  });

  const currentInput = "復帰中も喪失させない未保護の入力。";
  await manuscriptEditor(page).fill(currentInput);
  await expect(manuscriptEditor(page)).toHaveText(currentInput);
  await expect(page.locator(".pg-save-state summary")).toHaveText("要確認");
  expect((await readPersistenceDrafts(page)).some(draft => draft.documentId === scene.id && draft.markdown === currentInput)).toBe(false);

  unavailable = true;
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })));
  await expect(page.getByRole("heading", { name: "認証・接続を再確認してください" })).toBeVisible();
  await page.getByRole("button", { name: "ログアウトを再試行" }).click();
  await expect(page.getByRole("alert")).toContainText("入力を保護できないためログアウトを停止しました");
  expect(logoutRequests, "no logout request can precede durable draft protection").toBe(0);
  expect(saveRequests, "no document patch may have protected the input in PostgreSQL").toBe(0);
  const server = await page.request.get(`/api/v1/persistence/projects/${project.id}/documents/${scene.id}`);
  expect(server.ok()).toBe(true);
  expect((await server.json() as { revision: { markdown: string } }).revision.markdown).not.toContain(currentInput);

  await page.evaluate(() => { (window as Window & { __recoveryJournalWritesDenied?: boolean }).__recoveryJournalWritesDenied = false; });
  await page.getByRole("button", { name: "ログアウトを再試行" }).click();
  await expect(page.getByRole("heading", { name: "作品を開く" })).toBeVisible();
  expect(logoutRequests, "only the protected retry is allowed to send logout").toBe(1);
  expect((await readPersistenceDrafts(page)).some(draft => draft.documentId === scene.id && draft.markdown === currentInput)).toBe(true);
});

test("a lost Hosted logout response can be retried and returns to the Praetorium entry path", async ({ page }) => {
  await mockAuthenticatedWorkspace(page, true);
  let logoutRequests = 0;
  let serverLoggedOut = false;
  let tokenLogins = 0;
  await page.route("**/api/login", (route) => { tokenLogins += 1; return route.fulfill({ status: 410 }); });
  await page.route("**/_platform/logout", async (route) => {
    logoutRequests += 1;
    if (logoutRequests === 1) { serverLoggedOut = true; await route.abort(); return; }
    await route.fulfill({ status: serverLoggedOut ? 204 : 500 });
  });

  await page.getByRole("button", { name: "ログアウト", exact: true }).click();
  await expect(page.getByRole("heading", { name: "認証・接続を再確認してください" })).toBeVisible();
  await expect(page.getByRole("alert")).toContainText("ログアウトの完了を確認できませんでした");
  await expect(page.getByLabel("アクセス・トークン")).toHaveCount(0);
  await page.getByRole("button", { name: "ログアウトを再試行" }).click();
  await expect(page.getByRole("heading", { name: "Praetoriumから再入場してください" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Praetoriumから再入場" })).toHaveAttribute("href", "/_platform/reauth");
  expect(logoutRequests).toBe(2);
  expect(serverLoggedOut).toBe(true);
  expect(tokenLogins).toBe(0);
});

test("an expired Hosted grant returns through Praetorium without showing a token form", async ({ page }) => {
  let expired = false;
  let reauthRequests = 0;
  await mockAuthenticatedWorkspace(page, true, () => expired
    ? { status: 401, body: { error: "Authentication required", code: "UNAUTHORIZED" } }
    : { status: 200, body: { authenticated: true, authorScope: "hosted:synthetic-author", permissions: ["read", "write"] } });
  await page.route("**/_platform/refresh", (route) => route.fulfill({ status: 401, json: { error: "Session expired" } }));
  await page.route("**/_platform/reauth", (route) => { reauthRequests += 1; return route.fulfill({ contentType: "text/html", body: "Praetorium re-entry" }); });
  expired = true;

  await page.reload();
  await expect(page).toHaveURL(/\/_platform\/reauth$/u);
  expect(reauthRequests).toBe(1);
  await expect(page.getByLabel("アクセス・トークン")).toHaveCount(0);
});

test("concurrent tabs serialize a rotated hosted grant through the browser lock", async ({ page }) => {
  const context = page.context();
  const secondPage = await context.newPage();
  let initialSessionRequests = 0;
  let totalSessionRequests = 0;
  let refreshRequests = 0;
  let reauthRequests = 0;
  let grantFresh = false;
  let releaseInitialRequests!: () => void;
  const bothInitialRequests = new Promise<void>((resolve) => { releaseInitialRequests = resolve; });

  await context.route("**/api/browser/version", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ name: "codexia", version: "test", hosted: true, profile: "hosted" }),
  }));
  await context.route("**/api/v1/persistence/status", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ available: true, provider: "postgres" }) }));
  await context.route("**/api/session", async (route) => {
    totalSessionRequests += 1;
    if (grantFresh) {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ authenticated: true, authorScope: "hosted:synthetic-author", permissions: ["read", "write"] }),
      });
    }
    initialSessionRequests += 1;
    if (initialSessionRequests === 2) releaseInitialRequests();
    await bothInitialRequests;
    return route.fulfill({
      status: 401,
      contentType: "application/json",
      body: JSON.stringify({ error: "Authentication required", code: "UNAUTHORIZED" }),
    });
  });
  await context.route("**/api/v1/persistence/projects*", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: "[]",
  }));
  await context.route("**/api/jobs", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: "[]",
  }));
  await context.route("**/api/jobs/events", (route) => route.fulfill({ status: 200, headers: { "content-type": "text/event-stream" }, body: "" }));
  await context.route("**/api/inbox", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ items: [], unreadCount: 0 }),
  }));
  await context.route("**/_platform/refresh", async (route) => {
    refreshRequests += 1;
    grantFresh = true;
    await route.fulfill({ status: 204 });
  });
  await context.route("**/_platform/reauth", async (route) => {
    reauthRequests += 1;
    await route.fulfill({ status: 200, contentType: "text/html", body: "reauth fixture" });
  });

  await Promise.all([page.goto("/desktop/?tab=first"), secondPage.goto("/desktop/?tab=second")]);
  await expect(page.getByRole("heading", { name: "割り当てられた作品がありません" })).toBeVisible();
  await expect(page.getByRole("button", { name: "最初の作品を作成" })).toHaveCount(0);
  await expect(secondPage.getByRole("heading", { name: "割り当てられた作品がありません" })).toBeVisible();
  await expect(secondPage.getByRole("button", { name: "最初の作品を作成" })).toHaveCount(0);
  expect(new URL(page.url()).origin).toBe(new URL(secondPage.url()).origin);
  expect(await page.evaluate(() => Boolean(navigator.locks)), "Chromium must expose Web Locks for this cross-tab acceptance").toBe(true);
  expect(initialSessionRequests).toBeGreaterThanOrEqual(2);
  expect(totalSessionRequests).toBeGreaterThanOrEqual(4);
  expect(refreshRequests).toBe(1);
  expect(reauthRequests).toBe(0);
  await secondPage.close();
});

test("an interrupted initial project bootstrap resumes after persisted pageshow", async ({ browser }) => {
  const baseURL = process.env.CODEXIA_E2E_BASE_URL ?? process.env.CODEXIA_BASE_URL ?? `http://127.0.0.1:${process.env.CODEXIA_E2E_PORT ?? "4173"}`;
  for (const abort of [false, true]) {
    // Keep each resume case independent: an already-open authenticated tab can
    // persist a selected project into shared localStorage and bypass the list
    // bootstrap this test is specifically pausing.
    const context = await browser.newContext();
    const login = await context.request.post(new URL("/api/login", baseURL).toString(), {
      headers: { Origin: new URL(baseURL).origin },
      data: { token: authToken },
    });
    expect(login.ok()).toBe(true);
    const resumed = await context.newPage();
    let requests = 0;
    let release!: () => void;
    let started!: () => void;
    let retryStarted!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const pending = new Promise<void>((resolve) => { started = resolve; });
    const retried = new Promise<void>((resolve) => { retryStarted = resolve; });
    await resumed.route("**/api/v1/persistence/projects*", async (route) => {
      requests += 1;
      if (requests > 1) {
        retryStarted();
        return route.continue();
      }
      const response = await route.fetch();
      expect(response.ok()).toBe(true);
      started();
      await held;
      if (abort) await route.abort("failed").catch(() => undefined);
      else await route.fulfill({ response }).catch(() => undefined);
    });
    await resumed.goto(new URL("/desktop/", baseURL).toString());
    await pending;
    await resumed.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true })));
    await resumed.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })));
    release();
    await retried;
    await expect(resumed.getByLabel("作品", { exact: true })).toBeVisible({ timeout: 15_000 });
    expect(requests).toBeGreaterThanOrEqual(2);
    await expect(resumed.getByRole("alert")).toHaveCount(0);
    await context.close();
  }
});

test("direct-link, active scene, and project activation resume after persisted pageshow", async ({ page }) => {
  await ownerLogin(page);
  const { project, scenes } = await fixtureProject(page.request);
  expect(scenes.length).toBeGreaterThanOrEqual(2);
  let reads = 0;
  let release!: () => void;
  let started!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const pending = new Promise<void>((resolve) => { started = resolve; });
  await page.route(`**/api/v1/persistence/projects/${project.id}/documents/${scenes[0]!.id}`, async (route) => {
    reads += 1;
    if (reads > 1) return route.continue();
    const response = await route.fetch();
    expect(response.ok()).toBe(true);
    started();
    await held;
    await route.fulfill({ response }).catch(() => undefined);
  });
  await page.goto(`/desktop/projects/${project.id}/scenes/${scenes[0]!.id}`);
  await pending;
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true })));
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })));
  release();
  await expect(page.getByRole("textbox", { name: "本文", exact: true })).toContainText("The first line of the story.");
  expect(reads).toBeGreaterThanOrEqual(2);
  await page.locator(".pg-document-list").getByRole("treeitem", { name: new RegExp(scenes[1]!.title) }).click();
  await expect(page.getByRole("textbox", { name: "本文", exact: true })).toContainText("The second line of the story.");
  await page.goBack();
  await expect(page.getByRole("textbox", { name: "本文", exact: true })).toContainText("The first line of the story.");
  await expect(page.getByRole("alert")).toHaveCount(0);
});
