import { resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "./author-oauth-fixture";
import { createOAuthWritingFixture, manuscriptEditor, readPersistenceDrafts, fillDraft, seedWritingProject, writingFixturePath } from "./postgres-fixture";

const mockShellOrigin = "http://127.0.0.1:4173";
const shellAssets = fileURLToPath(new URL("../../app/dist/", import.meta.url));
test.use({ baseURL: mockShellOrigin });

test.beforeEach(async ({ context }) => {
  await context.route(`${mockShellOrigin}/**`, async (route) => {
    const request = route.request();
    const { pathname } = new URL(request.url());
    const shell = pathname.split("/")[1];
    if (request.method() !== "GET" || (shell !== "desktop" && shell !== "mobile")) {
      await route.fulfill({ status: 404 });
      return;
    }
    const shellDirectory = resolve(shellAssets, shell);
    const file = pathname === `/${shell}` || pathname === `/${shell}/`
      ? resolve(shellDirectory, "index.html")
      : resolve(shellAssets, `.${pathname}`);
    if (!file.startsWith(shellDirectory + sep)) {
      await route.fulfill({ status: 404 });
      return;
    }
    await route.fulfill({ path: file });
  });
});

test("an unavailable initial version cannot incorrectly offer the standalone token form", async ({ page }) => {
  await page.route(/\/api\/(?:browser\/)?version$/u, route => route.fulfill({
    status: 401, json: { error: "Edge authentication required", code: "UNAUTHORIZED" },
  }));
  await page.goto("/desktop/");
  await expect(page.getByRole("heading", { name: "PostgreSQLへ接続できません" })).toBeVisible();
  await expect(page.getByRole("button", { name: "ページを再読み込み" })).toBeVisible();
  await expect(page.getByLabel("アクセス・トークン")).toHaveCount(0);
});

test("an unauthenticated standalone browser without Web OAuth configuration cannot submit a static token", async ({ page }) => {
  await page.route("**/api/browser/version", route => route.fulfill({
    json: { name: "codexia", version: "test", profile: "core" },
  }));
  await page.route("**/api/session", route => route.fulfill({
    status: 401, json: { error: "Authentication required", code: "UNAUTHORIZED" },
  }));
  await page.goto("/desktop/");
  await expect(page.getByRole("heading", { name: "サインインを利用できません" })).toBeVisible();
  await expect(page.getByText("管理者に Web OAuth クライアントの設定を確認してください。")).toBeVisible();
  await expect(page.getByLabel("アクセス・トークン")).toHaveCount(0);
});

test("a failed OAuth logout keeps the editor protected and lets the author retry", async ({ page, authorizeAuthor }) => {
  await createOAuthWritingFixture(authorizeAuthor, page);
  let logoutRequests = 0;
  await page.route("**/api/auth/sign-out", async (route) => {
    logoutRequests += 1;
    if (logoutRequests === 1) { await route.abort(); return; }
    await route.continue();
  });

  await page.getByRole("button", { name: "ログアウト", exact: true }).click();
  await expect(page.getByRole("heading", { name: "認証・接続を再確認してください" })).toBeVisible();
  await expect(page.getByRole("alert")).toContainText("サーバー側セッションを終了できませんでした");
  await expect(page.getByLabel("アクセス・トークン")).toHaveCount(0);
  await page.getByRole("button", { name: "ログアウトを再試行" }).click();
  await expect(page.getByRole("button", { name: "OAuthでサインイン" })).toBeVisible();
  expect(logoutRequests).toBe(2);
  const session = await page.request.get(new URL("/api/auth/get-session", page.url()).href);
  expect(session.ok()).toBe(true);
  expect(await session.json()).toBeNull();
});

test("a failed pageshow session check cannot retry logout while the latest manuscript is unprotected", async ({ page, authorizeAuthor }) => {
  const fixture = await createOAuthWritingFixture(authorizeAuthor, page, "desktop", "Unprotected logout retry", "Initial manuscript.");
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
  await page.route("**/api/auth/sign-out", async (route) => {
    logoutRequests += 1;
    await route.continue();
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

test("recovery-session failure cannot discard an unjournaled manuscript through logout retry", async ({ page, authorizeAuthor }) => {
  // Authoritative acceptance for #454: simulate an IndexedDB draft failure
  // and an independently failing session refresh on a real PostgreSQL document.
  const { project, scene, author } = await createOAuthWritingFixture(authorizeAuthor, page);
  // Wait for the persisted manuscript to be hydrated before injecting an
  // IndexedDB failure; otherwise the initial document can arrive after fill().
  await expect(manuscriptEditor(page)).toHaveText("最初の本文。次の文章です。");
  let unavailable = false;
  let logoutRequests = 0;
  let saveRequests = 0;
  await page.route("**/api/session", route => unavailable
    ? route.fulfill({ status: 503, json: { error: "Temporary authentication outage" } })
    : route.continue());
  page.on("request", request => {
    if (new URL(request.url()).pathname === "/api/auth/sign-out") logoutRequests += 1;
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
  await expect(page.locator(".pg-save-state summary")).toHaveText("この入力はまだ保護されていません");
  expect((await readPersistenceDrafts(page)).some(draft => draft.documentId === scene.id && draft.markdown === currentInput)).toBe(false);

  unavailable = true;
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })));
  await expect(page.getByRole("heading", { name: "認証・接続を再確認してください" })).toBeVisible();
  await page.getByRole("button", { name: "ログアウトを再試行" }).click();
  await expect(page.getByRole("alert")).toContainText("入力を保護できないためログアウトを停止しました");
  expect(logoutRequests, "no logout request can precede durable draft protection").toBe(0);
  expect(saveRequests, "no document patch may have protected the input in PostgreSQL").toBe(0);
  const server = await author.fetch(`/api/v1/persistence/projects/${project.id}/documents/${scene.id}`);
  expect(server.ok()).toBe(true);
  expect((await server.json() as { revision: { markdown: string } }).revision.markdown).not.toContain(currentInput);

  await page.evaluate(() => { (window as Window & { __recoveryJournalWritesDenied?: boolean }).__recoveryJournalWritesDenied = false; });
  await page.getByRole("button", { name: "ログアウトを再試行" }).click();
  await expect(page.getByRole("button", { name: "OAuthでサインイン" })).toBeVisible();
  expect(logoutRequests, "only the protected retry is allowed to send logout").toBe(1);
  expect((await readPersistenceDrafts(page)).some(draft => draft.documentId === scene.id && draft.markdown === currentInput)).toBe(true);
});

test("an interrupted initial project bootstrap resumes after persisted pageshow", async ({ browser, authorizeAuthor }) => {
  for (const abort of [false, true]) {
    // Keep each resume case independent: an already-open authenticated tab can
    // persist a selected project into shared localStorage and bypass the list
    // bootstrap this test is specifically pausing.
    const context = await browser.newContext();
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
    const opening = authorizeAuthor("desktop", resumed);
    await pending;
    await resumed.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true })));
    await resumed.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })));
    release();
    await retried;
    await opening;
    await expect(resumed.getByLabel("作品", { exact: true })).toBeVisible({ timeout: 15_000 });
    expect(requests).toBeGreaterThanOrEqual(2);
    await expect(resumed.getByRole("alert")).toHaveCount(0);
    await context.close();
  }
});

test("direct-link, active scene, and project activation resume after persisted pageshow", async ({ page, authorizeAuthor }) => {
  const author = await authorizeAuthor("desktop");
  const initial = "The first line of the story.";
  const { project, scene, second } = await seedWritingProject(author.fetch, author.origin, "Scene One", initial);
  let reads = 0;
  let release!: () => void;
  let started!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const pending = new Promise<void>((resolve) => { started = resolve; });
  await page.route(`**/api/v1/persistence/projects/${project.id}/documents/${scene.id}`, async (route) => {
    reads += 1;
    if (reads > 1) return route.continue();
    const response = await route.fetch();
    expect(response.ok()).toBe(true);
    started();
    await held;
    await route.fulfill({ response }).catch(() => undefined);
  });
  const opening = authorizeAuthor("desktop", page, { path: writingFixturePath("desktop", project, scene) });
  await pending;
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true })));
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })));
  release();
  await opening;
  await expect(manuscriptEditor(page)).toContainText(initial);
  expect(reads).toBeGreaterThanOrEqual(2);
  await page.locator(".pg-document-list").getByRole("treeitem", { name: new RegExp(second.title) }).click();
  await expect(manuscriptEditor(page)).toContainText("最初の本文。");
  await page.goBack();
  await expect(manuscriptEditor(page)).toContainText(initial);
  await expect(page.getByRole("alert")).toHaveCount(0);
});
