import { expect, test, type Page } from "@playwright/test";
import { createWritingFixture, ownerLogin, readPersistenceDrafts } from "./postgres-fixture";

test.use({ hasTouch: true });
const editor = (page: Page) => page.getByRole("textbox", { name: "原稿 Markdown" });
async function markdown(page: Page) { return editor(page).locator(".cm-line").evaluateAll((lines) => lines.map((line) => line.textContent ?? "").join("\n")); }
async function expectMarkdown(page: Page, text: string) { await expect.poll(() => markdown(page)).toBe(text); }
const legacyKey = "scriptorium:draft:legacy-project:legacy-scene";
async function seedLegacy(page: Page, text = "旧記録の日本語原稿😀") {
  await page.evaluate(({ key, text }) => localStorage.setItem(key, JSON.stringify({ version: 1, projectId: "legacy-project", sceneId: "legacy-scene", text, revision: "old-revision", savedAt: Date.now() })), { key: legacyKey, text });
}
async function previewLegacy(page: Page) {
  const section = page.locator("details.pg-legacy-import");
  if (!await section.evaluate((element) => (element as HTMLDetailsElement).open)) {
    await section.locator("summary").click();
  }
  await page.getByRole("button", { name: "旧Draftを確認", exact: true }).click();
  await page.getByRole("button", { name: "legacy-project / legacy-scene", exact: true }).click();
  await expect(page.getByRole("region", { name: "旧Draftのプレビュー" })).toBeVisible();
}
async function sourceExists(page: Page) { return page.evaluate((key) => localStorage.getItem(key) !== null, legacyKey); }
async function denyWrites(page: Page, enabled: boolean) {
  await page.evaluate((enabled) => {
    const probe = window as Window & { __originalIdbPut?: typeof IDBObjectStore.prototype.put; __denyPgDraftWrites?: boolean };
    probe.__denyPgDraftWrites = enabled;
    if (!probe.__originalIdbPut) {
      probe.__originalIdbPut = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function (...args: Parameters<IDBObjectStore["put"]>) {
        if (this.name === "persistenceDrafts" && probe.__denyPgDraftWrites) throw new DOMException("Synthetic draft quota failure", "QuotaExceededError");
        return probe.__originalIdbPut!.apply(this, args);
      };
    }
  }, enabled);
}

test("legacy draft import preserves active input when its journal debounce is pending", async ({ page }) => {
  const { scene } = await createWritingFixture(page); await seedLegacy(page); await previewLegacy(page);
  await page.route("**/api/v1/persistence/projects/*/documents/*", (route) => route.request().method() === "PATCH" ? route.abort("failed") : route.continue());
  const text = "現在入力中の原稿を旧記録で消さない。";
  await editor(page).fill(text);
  await page.getByRole("button", { name: "この文書へ取り込む" }).click();
  await expectMarkdown(page, text); expect(await sourceExists(page)).toBe(true);
  await expect.poll(async () => (await readPersistenceDrafts(page)).some((draft) => draft.documentId === scene.id && draft.markdown === text)).toBe(true);
});

test("legacy draft import can be canceled, reloads its source, and removes it only after journal durability", async ({ page }) => {
  const { scene } = await createWritingFixture(page); await seedLegacy(page); await previewLegacy(page);
  await page.getByRole("button", { name: "取り込みをキャンセル" }).click(); expect(await sourceExists(page)).toBe(true);
  await seedLegacy(page, "再読込した元原稿。");
  await page.getByRole("button", { name: "legacy-project / legacy-scene", exact: true }).click();
  await expect(page.getByRole("region", { name: "旧Draftのプレビュー" })).toContainText("再読込した元原稿。");
  await page.route("**/api/v1/persistence/projects/*/documents/*", (route) => route.request().method() === "PATCH" ? route.abort("failed") : route.continue());
  await page.getByRole("button", { name: "この文書へ取り込む" }).click();
  await expect(editor(page)).toHaveText("再読込した元原稿。");
  await expect.poll(async () => (await readPersistenceDrafts(page)).some((draft) => draft.documentId === scene.id && draft.markdown === "再読込した元原稿。")).toBe(true);
  expect(await sourceExists(page)).toBe(false);
});

test("legacy draft import retains the confirmed PostgreSQL revision and creates a new generation", async ({ page }) => {
  const { project, scene } = await createWritingFixture(page); const text = "先に確定した本文。";
  await editor(page).fill(text);
  // "Saved" may still describe the previous revision until the async PATCH
  // completes. Pin only a revision whose canonical PostgreSQL body is this text.
  const url = `/api/v1/persistence/projects/${project.id}/documents/${scene.id}`;
  await expect.poll(async () => {
    const response = await page.request.get(url);
    return response.ok() ? ((await response.json()) as { revision: { markdown: string } }).revision.markdown : "";
  }).toBe(text);
  const before = await page.request.get(url); const original = await before.json();
  await seedLegacy(page); await previewLegacy(page); await page.getByRole("button", { name: "この文書へ取り込む" }).click();
  await expect(editor(page)).toHaveText("旧記録の日本語原稿😀");
  await expect(page.getByText("PostgreSQLへ保存済み", { exact: true })).toBeVisible();
  const pinned = await page.request.get(`/api/v1/persistence/projects/${project.id}/documents/${scene.id}?revision=${original.revision.id}`);
  expect((await pinned.json()).revision.markdown).toBe(text); expect(await sourceExists(page)).toBe(false);
});

test("legacy draft import preserves input after its strict journal write fails", async ({ page }) => {
  await createWritingFixture(page); const original = await editor(page).innerText(); await seedLegacy(page); await previewLegacy(page); await denyWrites(page, true);
  await page.getByRole("button", { name: "この文書へ取り込む" }).click();
  // Import is asynchronous. Keep the synthetic IndexedDB failure enabled until
  // the application confirms the failed durable write; otherwise the pending
  // write succeeds after denyWrites(false), silently removing the source.
  await expect(page.locator("details.pg-legacy-import").getByRole("status"))
    .toContainText("Browser storage is full");
  await expectMarkdown(page, original); expect(await sourceExists(page)).toBe(true);
  await denyWrites(page, false);
  await page.getByRole("button", { name: "この文書へ取り込む" }).click();
  await expect(editor(page)).toHaveText("旧記録の日本語原稿😀");
});

test("legacy draft import reports a rejected composition flush and keeps its source", async ({ page }) => {
  await createWritingFixture(page); await seedLegacy(page); await previewLegacy(page); const text = await editor(page).innerText();
  await editor(page).dispatchEvent("compositionstart", { data: "にほんご" });
  await page.getByRole("button", { name: "この文書へ取り込む" }).click();
  await expectMarkdown(page, text); expect(await sourceExists(page)).toBe(true);
  await expect(page.getByRole("alert").first()).toContainText(/変換|入力/u);
  await editor(page).dispatchEvent("compositionend", { data: "日本語" });
});

test("legacy draft composition cannot write old scene text into a newly selected scene", async ({ page }) => {
  const { second } = await createWritingFixture(page); await seedLegacy(page); await previewLegacy(page);
  await editor(page).dispatchEvent("compositionstart", { data: "にほんご" });
  await page.getByRole("button", { name: "この文書へ取り込む" }).click();
  await editor(page).dispatchEvent("compositionend", { data: "日本語" });
  await page.locator(".pg-document-list").getByRole("button", { name: new RegExp(second.title) }).click();
  await expect(editor(page)).toContainText("最初の本文。"); expect(await sourceExists(page)).toBe(true);
});

test("the launcher remembers an explicit choice while direct Shell links keep the preference", async ({ page }) => {
  await page.goto("/"); await page.getByRole("button", { name: /Desktop|デスクトップ/u }).first().click();
  await expect(page).toHaveURL(/desktop/u);
  await page.goto("/mobile/"); await expect(page.getByLabel("アクセス・トークン")).toBeVisible();
  await page.goto("/"); await expect(page).toHaveURL(/desktop/u);
});

test("recovery retry after pagehide retains its exact PostgreSQL draft", async ({ page }) => {
  const { scene } = await createWritingFixture(page);
  await page.route("**/api/v1/persistence/projects/*/documents/*", (route) => route.request().method() === "PATCH" ? route.abort("failed") : route.continue());
  await editor(page).fill("頁を隠しても残る日本語のDraft。");
  await expect.poll(async () => (await readPersistenceDrafts(page)).some((draft) => draft.documentId === scene.id)).toBe(true);
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true })));
  await page.unroute("**/api/v1/persistence/projects/*/documents/*");
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })));
  await expect(editor(page)).toHaveText("頁を隠しても残る日本語のDraft。");
  await expect(page.getByText("PostgreSQLへ保存済み", { exact: true })).toBeVisible();
});

test("both production Shells preserve recoverable Japanese drafts and the Mobile writing and reading flow", async ({ page }) => {
  for (const mode of ["desktop", "mobile"] as const) {
    await page.setViewportSize({ width: mode === "mobile" ? 390 : 1280, height: 900 });
    const { project, scene } = await createWritingFixture(page, mode);
    const text = "東京《とうきょう》へ向かう。\n日本語😀の本文。";
    await editor(page).fill(text);
    await expectMarkdown(page, text);
    // "Saved" can reflect the previous revision. The reader must open only
    // after this exact manuscript is durable in PostgreSQL.
    await expect.poll(async () => {
      const response = await page.request.get(`/api/v1/persistence/projects/${project.id}/documents/${scene.id}`);
      return response.ok() ? ((await response.json()) as { revision: { markdown: string } }).revision.markdown : "";
    }).toBe(text);
    await page.getByRole("button", { name: "読む", exact: true }).click();
    await expect(page.getByRole("region", { name: "原稿の閲覧" })).toContainText("東京");
    await page.getByRole("button", { name: "編集へ戻る" }).click(); await expectMarkdown(page, text);
    await page.reload();
    if (mode === "mobile") await page.getByRole("navigation", { name: "モバイル画面" }).getByRole("button", { name: "書く", exact: true }).click();
    await expectMarkdown(page, text);
  }
});

test("profile-selected workspace panels remain discoverable in the PostgreSQL workspace", async ({ page }) => {
  const { project } = await createWritingFixture(page);
  const response = await page.request.get(`/api/projects/${project.id}/contributions`); expect(response.ok()).toBe(true);
  const catalog = await response.json();
  const contributions = Array.isArray(catalog) ? catalog : catalog.contributions;
  expect(Array.isArray(contributions)).toBe(true);
  const menu = page.locator(".st-workspace-panel-menu");
  await menu.locator("summary").click();
  for (const item of contributions.filter((item: { kind?: string; contexts?: string[] }) => (item.kind ?? "panel") === "panel" && (!item.contexts || item.contexts.includes("workspace")))) {
    const row = menu.locator(".st-workspace-panel-menu-item").filter({
      has: page.getByText(item.title, { exact: true }),
    });
    await expect(row.getByRole("button").first()).toBeVisible();
  }
  await expect(editor(page)).toBeVisible();
});

test("UX canon keeps the manuscript visible and stable through PostgreSQL save responses", async ({ page }) => {
  await createWritingFixture(page); await editor(page).evaluate((element) => { element.dataset.originalEditor = "retained"; });
  await editor(page).fill("保存応答でも選択と同じエディタを保持する。");
  await expect(page.getByText("PostgreSQLへ保存済み", { exact: true })).toBeVisible();
  await expect(editor(page)).toHaveAttribute("data-original-editor", "retained");
  await editor(page).press("Control+A");
  await page.getByRole("button", { name: "選択範囲をText Anchorにする" }).click();
  await expect(page.locator(".pg-notice")).toContainText("Text Anchorを保存しました");
});

test("UX canon puts Japanese prose before optional chrome at every shell width", async ({ page }) => {
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: 900 }); await createWritingFixture(page, width < 640 ? "mobile" : "desktop");
    await editor(page).fill("本文を中心に読める幅と余白を保つ。".repeat(20));
    const box = await editor(page).boundingBox(); expect(box).not.toBeNull(); expect(box!.width).toBeGreaterThan(200);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 2)).toBe(true);
  }
});

test("UX canon preserves focus and recovery when journal storage fails and returns", async ({ page }) => {
  const { scene } = await createWritingFixture(page); await denyWrites(page, true);
  const text = "保存領域が戻るまで失わない原稿。";
  await editor(page).fill(text); await expect(page.getByRole("alert").first()).toBeVisible(); await expectMarkdown(page, text);
  await denyWrites(page, false); await editor(page).press("End"); await editor(page).press("!");
  await expect.poll(async () => (await readPersistenceDrafts(page)).some((draft) => draft.documentId === scene.id && draft.markdown.includes(text)) || page.getByText("PostgreSQLへ保存済み", { exact: true }).isVisible()).toBeTruthy();
  await expect(editor(page)).toContainText(text);
});

test("UX canon keeps explicit shells usable with long Japanese titles and enlarged text", async ({ page }) => {
  for (const mode of ["desktop", "mobile"] as const) {
    await page.setViewportSize({ width: mode === "mobile" ? 390 : 1280, height: 900 }); await createWritingFixture(page, mode, "長い日本語の章題".repeat(8));
    await page.getByLabel("原稿の文字サイズ").fill("24"); await editor(page).fill("大きな文字でも読み書きできる。".repeat(10));
    await expect(editor(page)).toHaveCSS("font-size", "24px");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 2)).toBe(true);
    await expect(page.getByRole("button", { name: "今すぐ保存" })).toBeVisible();
  }
});

test("optional terminology cancels work at pagehide and resumes at pageshow", async ({ page }) => {
  await createWritingFixture(page); const requests: string[] = [];
  page.on("request", (request) => { if (/terms|terminology/u.test(request.url())) requests.push(request.url()); });
  await editor(page).fill("Lantern Harborの用語を確認する。");
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true })));
  const hiddenCount = requests.length;
  await page.waitForTimeout(200);
  expect(requests.length).toBe(hiddenCount);
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })));
  await expect(editor(page)).toContainText("Lantern Harbor");
  await editor(page).press("End"); await editor(page).press("!"); await expect(editor(page)).toContainText("!");
});

test("Full WebKit terminology stays safe across a held native Shell departure window", async ({ page }) => {
  await createWritingFixture(page); const text = "東京《とうきょう》の用語と変換を保持する。";
  await editor(page).fill(text); await expect(page.getByText("IndexedDB回復Journalに保存済み", { exact: true })).toBeVisible();
  await editor(page).dispatchEvent("compositionstart", { data: "とうきょう" });
  await page.getByRole("button", { name: "モバイルUIへ" }).click();
  await expect(page).toHaveURL(/desktop/u); await expectMarkdown(page, text);
  await editor(page).dispatchEvent("compositionend", { data: "東京" });
  await page.getByRole("button", { name: "モバイルUIへ" }).click();
  await expect(page).toHaveURL(/mobile/u);
  await page.getByRole("navigation", { name: "モバイル画面" }).getByRole("button", { name: "書く", exact: true }).click();
  await expectMarkdown(page, text);
});
