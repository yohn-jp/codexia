import { expect, test } from "@playwright/test";
import { ownerLogin, fixtureProject } from "./postgres-fixture";

const authToken = process.env.CODEXIA_E2E_AUTH_TOKEN ?? "";

for (const shell of ["desktop", "mobile"] as const) {
  test(`Access SSO enters the ${shell} shell, reauthenticates and logs out without a Codexia token`, async ({ page }) => {
    let signedIn = false;
    let tokenLogins = 0;
    let tokenLogouts = 0;
    await page.route("**/api/version", route => route.fulfill({
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
    await expect(page.getByRole("button", { name: "ログアウト", exact: true })).toBeVisible();
    await expect(page.getByLabel("アクセス・トークン")).toHaveCount(0);
    await page.getByRole("button", { name: "ログアウト", exact: true }).click();
    await expect(page).toHaveURL(/\/cdn-cgi\/access\/logout$/u);
    expect(tokenLogins).toBe(0);
    expect(tokenLogouts).toBe(0);
  });
}

test("an unavailable initial version cannot incorrectly offer the standalone token form", async ({ page }) => {
  await page.route("**/api/version", route => route.fulfill({
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

  await page.route("**/api/version", (route) => route.fulfill({
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
  await expect(page.getByText("最初の作品を作成してください")).toBeVisible();
  expect(sessionRequests).toBe(3);
  expect(refreshRequests).toBe(1);
  expect(reauthRequests).toBe(0);
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

  await context.route("**/api/version", (route) => route.fulfill({
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
  await expect(page.getByText("最初の作品を作成してください")).toBeVisible();
  await expect(secondPage.getByText("最初の作品を作成してください")).toBeVisible();
  expect(new URL(page.url()).origin).toBe(new URL(secondPage.url()).origin);
  expect(await page.evaluate(() => Boolean(navigator.locks)), "Chromium must expose Web Locks for this cross-tab acceptance").toBe(true);
  expect(initialSessionRequests).toBeGreaterThanOrEqual(2);
  expect(totalSessionRequests).toBeGreaterThanOrEqual(4);
  expect(refreshRequests).toBe(1);
  expect(reauthRequests).toBe(0);
  await secondPage.close();
});

test("an interrupted initial project bootstrap resumes after persisted pageshow", async ({ page }) => {
  await ownerLogin(page);
  for (const abort of [false, true]) {
    const resumed = await page.context().newPage();
    let requests = 0;
    let release!: () => void;
    let started!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const pending = new Promise<void>((resolve) => { started = resolve; });
    await resumed.route("**/api/v1/persistence/projects*", async (route) => {
      requests += 1;
      if (requests > 1) return route.continue();
      const response = await route.fetch();
      expect(response.ok()).toBe(true);
      started();
      await held;
      if (abort) await route.abort("failed").catch(() => undefined);
      else await route.fulfill({ response }).catch(() => undefined);
    });
    await resumed.goto("/desktop/");
    await pending;
    await resumed.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true })));
    await resumed.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })));
    release();
    await expect(resumed.getByLabel("開く作品")).toBeVisible({ timeout: 15_000 });
    expect(requests).toBeGreaterThanOrEqual(2);
    await expect(resumed.getByRole("alert")).toHaveCount(0);
    await resumed.close();
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
  await expect(page.getByRole("textbox", { name: "原稿 Markdown" })).toContainText("The first line of the story.");
  expect(reads).toBeGreaterThanOrEqual(2);
  await page.locator(".pg-document-list").getByRole("button", { name: new RegExp(scenes[1]!.title) }).click();
  await expect(page.getByRole("textbox", { name: "原稿 Markdown" })).toContainText("The second line of the story.");
  await page.goBack();
  await expect(page.getByRole("textbox", { name: "原稿 Markdown" })).toContainText("The first line of the story.");
  await expect(page.getByRole("alert")).toHaveCount(0);
});
