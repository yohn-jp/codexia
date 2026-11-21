import { expect, test, type Page } from "@playwright/test";
import { authToken, createWritingFixture, manuscriptEditor, readPersistenceDrafts } from "./postgres-fixture";

async function establishOwnerSession(page: Page): Promise<void> {
  const origin = process.env.CODEXIA_E2E_BASE_URL ?? process.env.CODEXIA_BASE_URL ?? `http://127.0.0.1:${process.env.CODEXIA_E2E_PORT ?? "4173"}`;
  const base = new URL(origin);
  const response = await page.request.post(new URL("/api/login", base).toString(), {
    headers: { Origin: base.origin },
    data: { token: authToken },
  });
  expect(response.status()).toBe(200);
}

async function denyDraftWrites(page: Page, enabled: boolean): Promise<void> {
  await page.evaluate((deny) => {
    const probe = window as Window & { __originalIdbPut?: typeof IDBObjectStore.prototype.put; __denyPgDraftWrites?: boolean };
    probe.__denyPgDraftWrites = deny;
    if (!probe.__originalIdbPut) {
      probe.__originalIdbPut = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function (...args: Parameters<IDBObjectStore["put"]>) {
        if (this.name === "persistenceDrafts" && probe.__denyPgDraftWrites) {
          throw new DOMException("Synthetic draft quota failure", "QuotaExceededError");
        }
        return probe.__originalIdbPut!.apply(this, args);
      };
    }
  }, enabled);
}

async function triggerFailedResume(page: Page): Promise<void> {
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })));
  await expect(page.getByRole("heading", { name: "認証・接続を再確認してください" })).toBeVisible();
}

test("failed recovery blocks logout and OAuth reauthentication until the current input is journaled", async ({ page }) => {
  await establishOwnerSession(page);
  const { project, scene } = await createWritingFixture(page);
  let sessionUnavailable = false;
  let logoutRequests = 0;
  let documentSaveRequests = 0;
  let oauthNavigationRequests = 0;
  await page.route("**/api/session", async (route) => sessionUnavailable
    ? route.fulfill({ status: 503, json: { error: "Authentication temporarily unavailable" } })
    : route.continue());
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/logout") logoutRequests += 1;
  });
  await page.route("**/api/v1/persistence/projects/*/documents/*", async (route) => {
    if (route.request().method() === "PATCH") documentSaveRequests += 1;
    return route.continue();
  });
  await page.route("http://127.0.0.1:4174/**", async (route) => {
    oauthNavigationRequests += 1;
    return route.fulfill({ contentType: "text/html", body: "Synthetic OAuth authorization endpoint" });
  });
  const currentInput = "復帰時の確認障害中も失わない入力。";
  await denyDraftWrites(page, true);
  await manuscriptEditor(page).fill(currentInput);
  await expect(manuscriptEditor(page)).toHaveText(currentInput);
  await expect(page.locator(".pg-save-state summary")).toHaveText("要確認");
  expect((await readPersistenceDrafts(page)).some((draft) => draft.documentId === scene.id && draft.markdown === currentInput)).toBe(false);

  sessionUnavailable = true;
  await triggerFailedResume(page);
  await page.getByRole("button", { name: "ログアウトを再試行" }).click();
  await expect(page.getByRole("alert")).toContainText("入力を保護できないためログアウトを停止しました");
  expect(logoutRequests).toBe(0);
  expect(documentSaveRequests).toBe(0);

  const blockedUrl = page.url();
  await page.getByRole("button", { name: "OAuthで再認証" }).click();
  await expect(page.getByRole("alert")).toContainText("入力を保護できないためOAuth認証への移動を停止しました");
  expect(page.url()).toBe(blockedUrl);
  expect(oauthNavigationRequests).toBe(0);
  expect(logoutRequests).toBe(0);
  expect(documentSaveRequests).toBe(0);

  const unchanged = await page.request.get(`/api/v1/persistence/projects/${project.id}/documents/${scene.id}`);
  expect(unchanged.ok()).toBe(true);
  expect((await unchanged.json() as { revision: { markdown: string } }).revision.markdown).not.toContain(currentInput);

  await denyDraftWrites(page, false);
  await page.getByRole("button", { name: "ログアウトを再試行" }).click();
  await expect(page.getByRole("heading", { name: "作品を開く" })).toBeVisible();
  expect(logoutRequests).toBe(1);
  expect(documentSaveRequests).toBe(0);
  expect((await readPersistenceDrafts(page)).some((draft) => draft.projectId === project.id && draft.documentId === scene.id && draft.markdown === currentInput)).toBe(true);
});

test("OAuth reauthentication may continue after the current editor is protected", async ({ page }) => {
  await establishOwnerSession(page);
  const { scene } = await createWritingFixture(page);
  let sessionUnavailable = false;
  let oauthNavigationRequests = 0;
  await page.route("**/api/session", async (route) => sessionUnavailable
    ? route.fulfill({ status: 503, json: { error: "Authentication temporarily unavailable" } })
    : route.continue());
  await page.route("http://127.0.0.1:4174/**", async (route) => {
    oauthNavigationRequests += 1;
    return route.fulfill({ contentType: "text/html", body: "Synthetic OAuth authorization endpoint" });
  });

  const currentInput = "保護できた後にOAuthへ進む原稿。";
  await manuscriptEditor(page).fill(currentInput);
  await expect.poll(async () => (await readPersistenceDrafts(page)).some((draft) => draft.documentId === scene.id && draft.markdown === currentInput)).toBe(true);
  sessionUnavailable = true;
  await triggerFailedResume(page);
  await page.getByRole("button", { name: "OAuthで再認証" }).click();
  await expect(page).toHaveURL(/127\.0\.0\.1:4174\/oauth2\/authorize/u);
  expect(oauthNavigationRequests).toBe(1);
});
