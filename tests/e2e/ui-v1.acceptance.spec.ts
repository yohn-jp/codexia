import { expect, test, type Page } from "@playwright/test";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { createWritingFixture, expectDeviceDraft, expectServerSaved, openManuscriptScene, openProtectionDetails, openRevisionHistory, ownerLogin, readPersistenceDrafts, manuscriptEditor as editor, readManuscriptMarkdown as markdown } from "./postgres-fixture";

const requirePersistence = createRequire(new URL("../../packages/persistence-postgres/package.json", import.meta.url));
type TestPostgresClient = {
  connect(): Promise<void>;
  query(sql: string, parameters?: unknown[]): Promise<unknown>;
  end(): Promise<void>;
};
const { Client } = requirePersistence("pg") as { Client: new (options: { connectionString: string }) => TestPostgresClient };

test.use({ hasTouch: true });
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
async function persistedMarkdown(page: Page, projectId: string, documentId: string): Promise<string> {
  const response = await page.request.get(`/api/v1/persistence/projects/${projectId}/documents/${documentId}`);
  if (!response.ok()) return "";
  return ((await response.json()) as { revision: { markdown: string } }).revision.markdown;
}
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
  await editor(page).click(); await editor(page).press("ControlOrMeta+a"); await page.keyboard.insertText(text);
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

// Keep the original fill-based acceptance intact while comparing it with a
// user-facing selection + typing path. This isolates the automation boundary
// without weakening the canonical persisted-body assertion.
test("keyboard select-all replacement saves exactly the intended manuscript", async ({ page }) => {
  const { project, scene } = await createWritingFixture(page);
  const text = "先に確定した本文。";
  await expectMarkdown(page, "最初の本文。\n次の文章です。");
  await editor(page).click();
  await editor(page).press("ControlOrMeta+a");
  await page.keyboard.insertText(text);
  await expectMarkdown(page, text);
  const url = `/api/v1/persistence/projects/${project.id}/documents/${scene.id}`;
  await expect.poll(async () => {
    const response = await page.request.get(url);
    return response.ok() ? ((await response.json()) as { revision: { markdown: string } }).revision.markdown : "";
  }).toBe(text);
});

test("legacy draft import retains the confirmed PostgreSQL revision and creates a new generation", async ({ page }) => {
  const { project, scene } = await createWritingFixture(page); const text = "先に確定した本文。";
  // Use the same user-facing replacement path that passes in WebKit. The
  // legacy fill probe was diagnostic only and can append to a contenteditable
  // document in WebKit while Chromium masks the automation difference.
  await editor(page).click();
  await editor(page).press("ControlOrMeta+a");
  await page.keyboard.insertText(text);
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
  await expectServerSaved(page);
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
    .toContainText("ブラウザーの保存領域がいっぱいです");
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
  await page.locator(".pg-document-list").getByRole("treeitem", { name: new RegExp(second.title) }).click();
  await expect(editor(page)).toContainText("最初の本文。"); expect(await sourceExists(page)).toBe(true);
});

test("the launcher remembers an explicit choice while direct Shell links keep the preference", async ({ page }) => {
  await page.goto("/"); await page.getByRole("button", { name: /Desktop|デスクトップ/u }).first().click();
  await expect(page).toHaveURL(/desktop/u);
  await page.goto("/mobile/"); await expect(page.getByLabel("アクセス・トークン")).toBeVisible();
  await page.goto("/"); await expect(page).toHaveURL(/desktop/u);
});

test("revision history responses and errors stay bound to the scene that requested them", async ({ page }) => {
  const { project, scene, second } = await createWritingFixture(page);
  const aPast = "Aだけにある過去本文。";
  const aCurrent = "Aの現在本文。";
  const bPast = "Bだけにある過去本文。";
  const bCurrent = "Bの現在本文。";
  await editor(page).fill(aPast);
  await expect.poll(() => persistedMarkdown(page, project.id, scene.id)).toBe(aPast);
  await editor(page).fill(aCurrent);
  await expect.poll(() => persistedMarkdown(page, project.id, scene.id)).toBe(aCurrent);
  await openManuscriptScene(page, second);
  await editor(page).fill(bPast);
  await expect.poll(() => persistedMarkdown(page, project.id, second.id)).toBe(bPast);
  await editor(page).fill(bCurrent);
  await expect.poll(() => persistedMarkdown(page, project.id, second.id)).toBe(bCurrent);
  await openManuscriptScene(page, scene);

  const historyUrl = (url: URL) => url.pathname === `/api/v1/persistence/projects/${project.id}/documents/${scene.id}/revisions`;
  let releaseHistory!: () => void;
  let markHistoryStarted!: () => void;
  const historyGate = new Promise<void>((resolve) => { releaseHistory = resolve; });
  const historyStarted = new Promise<void>((resolve) => { markHistoryStarted = resolve; });
  await page.route(historyUrl, async (route) => {
    markHistoryStarted();
    await historyGate;
    await route.continue();
  });
  await openRevisionHistory(page);
  await historyStarted;
  await openManuscriptScene(page, second);
  const historyResponse = page.waitForResponse((response) => historyUrl(new URL(response.url())));
  releaseHistory();
  await historyResponse;
  await openRevisionHistory(page);
  const history = page.getByRole("region", { name: "Revision履歴", exact: true });
  await expect(history).toBeVisible();
  await expect(history).toContainText(bPast);
  await expect(history).not.toContainText(aPast);

  await openManuscriptScene(page, scene);
  await page.unroute(historyUrl);
  let releaseFailure!: () => void;
  let markFailureStarted!: () => void;
  const failureGate = new Promise<void>((resolve) => { releaseFailure = resolve; });
  const failureStarted = new Promise<void>((resolve) => { markFailureStarted = resolve; });
  await page.route(historyUrl, async (route) => {
    markFailureStarted();
    await failureGate;
    await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "A履歴の取得失敗", code: "TEST_FAILURE" }) });
  });
  await openRevisionHistory(page);
  await failureStarted;
  await openManuscriptScene(page, second);
  const failureResponse = page.waitForResponse((response) => historyUrl(new URL(response.url())));
  releaseFailure();
  await failureResponse;
  await expect(page.getByText("A履歴の取得失敗", { exact: true })).toHaveCount(0);
  await expect(editor(page)).toContainText(bCurrent);

  await openManuscriptScene(page, scene);
  await page.unroute(historyUrl);
  let releaseInitial!: () => void;
  let markInitialStarted!: () => void;
  const initialGate = new Promise<void>((resolve) => { releaseInitial = resolve; });
  const initialStarted = new Promise<void>((resolve) => { markInitialStarted = resolve; });
  await page.route(historyUrl, async (route) => {
    markInitialStarted();
    await initialGate;
    await route.continue();
  });
  await openRevisionHistory(page);
  await initialStarted;
  const failedDocumentPath = `/api/v1/persistence/projects/${project.id}/documents/${second.id}`;
  const failedDocumentRoute = (url: URL) => url.pathname === failedDocumentPath;
  await page.route(failedDocumentRoute, (route) => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "対象の文書を開けませんでした。" }) }));
  await page.locator(`.pg-document-list .pg-outline-item[data-document-id="${second.id}"] > .pg-outline-row > .pg-outline-document`).click();
  const editorAlert = page.locator(".pg-editor-column").getByRole("alert");
  await expect(editorAlert).toHaveText("対象の文書を開けませんでした。");
  await expect(editorAlert).toHaveCount(1);
  const initialResponse = page.waitForResponse((response) => historyUrl(new URL(response.url())));
  releaseInitial();
  await initialResponse;
  await expect(page.getByRole("region", { name: "Revision履歴", exact: true })).toHaveCount(0);
  await page.unroute(historyUrl);
  await page.unroute(failedDocumentRoute);
  await openManuscriptScene(page, scene);
  await openRevisionHistory(page);
  await expect(page.getByRole("region", { name: "Revision履歴", exact: true }).getByRole("status")).toHaveCount(0);
});

test("revision history restarts a blocked page after a save on the same scene", async ({ page }) => {
  test.setTimeout(90_000);
  const { project, scene } = await createWritingFixture(page);
  const documentPath = `/api/v1/persistence/projects/${project.id}/documents/${scene.id}`;
  const revisionsResponse = await page.request.get(documentPath);
  expect(revisionsResponse.ok()).toBe(true);
  let current = (await revisionsResponse.json() as { revision: { id: string; markdown: string } }).revision;
  for (let number = 2; number <= 51; number += 1) {
    const markdown = `Revision ${number}.`;
    const response = await page.request.patch(documentPath, {
      headers: { Origin: new URL(page.url()).origin, "Idempotency-Key": randomUUID(), "X-Client-Id": "revision-page-save-test" },
      data: {
        baseRevisionId: current.id,
        changes: [{ fromUtf16: 0, toUtf16: current.markdown.length, insert: markdown }],
        resultingSha256: createHash("sha256").update(markdown).digest("hex"),
        clientId: "revision-page-save-test",
      },
    });
    expect(response.status()).toBe(200);
    current = (await response.json() as { revision: { id: string; markdown: string } }).revision;
  }
  await page.goto(`/desktop/projects/${project.id}/scenes/${scene.id}`);
  await expect(editor(page)).toContainText(current.markdown);
  await openRevisionHistory(page);
  const history = page.getByRole("region", { name: "Revision履歴", exact: true });
  await expect(history.locator("article")).toHaveCount(50);

  let releasePage!: () => void;
  let markPageStarted!: () => void;
  let markRefreshStarted!: () => void;
  const pageGate = new Promise<void>((resolve) => { releasePage = resolve; });
  const pageStarted = new Promise<void>((resolve) => { markPageStarted = resolve; });
  const refreshStarted = new Promise<void>((resolve) => { markRefreshStarted = resolve; });
  let pageBlocked = false;
  await page.route((url) => url.pathname === `${documentPath}/revisions`, async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.has("before") && !pageBlocked) {
      pageBlocked = true;
      markPageStarted();
      await pageGate;
    } else if (!url.searchParams.has("before")) {
      markRefreshStarted();
    }
    await route.continue();
  });
  await history.getByRole("button", { name: "さらに古いRevisionを読む", exact: true }).click();
  await pageStarted;
  const savedMarkdown = "A new receipt arrives while history is loading.";
  await editor(page).fill(savedMarkdown);
  await expect.poll(async () => persistedMarkdown(page, project.id, scene.id)).toBe(savedMarkdown);
  await expect(page.getByRole("button", { name: "今すぐ保存", exact: true })).toBeDisabled();
  releasePage();
  await refreshStarted;
  await expect(history.locator("article")).toHaveCount(50);
  await expect(history).toContainText(savedMarkdown);
  await expect(history.getByRole("button", { name: "さらに古いRevisionを読む", exact: true })).toBeEnabled();
});

test("revision history pages tied PostgreSQL revisions through retry, navigation, and restore", async ({ page }) => {
  test.setTimeout(120_000);
  const { project, scene, second } = await createWritingFixture(page);
  const documentPath = `/api/v1/persistence/projects/${project.id}/documents/${scene.id}`;
  const historyUrl = (url: URL) => url.pathname === `${documentPath}/revisions`;
  const documentResponse = await page.request.get(documentPath);
  expect(documentResponse.ok()).toBe(true);
  let revision = (await documentResponse.json() as { revision: { id: string; markdown: string } }).revision;
  const initialRevision = revision;
  let revisionCount = 1;

  async function seedTo(count: number): Promise<void> {
    while (revisionCount < count) {
      const markdown = `Stored revision ${String(revisionCount + 1).padStart(3, "0")}.`;
      const response = await page.request.patch(documentPath, {
        headers: {
          Origin: new URL(page.url()).origin,
          "Idempotency-Key": randomUUID(),
          "X-Client-Id": "revision-history-pagination-test",
        },
        data: {
          baseRevisionId: revision.id,
          changes: [{ fromUtf16: 0, toUtf16: revision.markdown.length, insert: markdown }],
          resultingSha256: createHash("sha256").update(markdown).digest("hex"),
          clientId: "revision-history-pagination-test",
        },
      });
      expect(response.status()).toBe(200);
      revision = (await response.json() as { revision: { id: string; markdown: string } }).revision;
      revisionCount += 1;
    }
  }

  async function tieRevisionTimes(): Promise<void> {
    const databaseUrl = process.env.CODEXIA_E2E_DATABASE_URL;
    expect(databaseUrl, "the browser test must use its disposable PostgreSQL database").toBeTruthy();
    const client = new Client({ connectionString: databaseUrl! });
    try {
      await client.connect();
      await client.query("BEGIN");
      // The disposable fixture deliberately creates an otherwise impossible timestamp tie.
      await client.query("SET LOCAL session_replication_role = replica");
      await client.query(
        "UPDATE document_revision SET created_at = $1 WHERE project_id = $2 AND document_id = $3",
        [new Date("2020-01-01T00:00:00.000Z"), project.id, scene.id],
      );
      await client.query("COMMIT");
    } finally {
      await client.end();
    }
  }

  async function reopenScene(): Promise<void> {
    await page.goto(`/desktop/projects/${project.id}/scenes/${scene.id}`);
    await expect(editor(page)).toContainText(revision.markdown);
  }

  await seedTo(50);
  await tieRevisionTimes();
  await reopenScene();
  await openRevisionHistory(page);
  const history = page.getByRole("region", { name: "Revision履歴", exact: true });
  await expect(history.locator("article")).toHaveCount(50);
  await expect(history.getByRole("button", { name: "さらに古いRevisionを読む", exact: true })).toHaveCount(0);

  await seedTo(51);
  await tieRevisionTimes();
  await reopenScene();
  await openRevisionHistory(page);
  await expect(history.locator("article")).toHaveCount(50);
  const nextPage = history.getByRole("button", { name: "さらに古いRevisionを読む", exact: true });
  await expect(nextPage).toBeVisible();
  await nextPage.click();
  await expect(history.locator("article")).toHaveCount(51);
  await expect(history).toContainText("最初の本文。");

  await seedTo(150);
  await tieRevisionTimes();
  await reopenScene();
  await openRevisionHistory(page);
  await expect(history.locator("article")).toHaveCount(50);
  let failOnePage = true;
  await page.route(historyUrl, async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.has("before") && failOnePage) {
      failOnePage = false;
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "履歴ページ取得失敗", code: "TEST_FAILURE" }) });
      return;
    }
    await route.continue();
  });
  await history.getByRole("button", { name: "さらに古いRevisionを読む", exact: true }).click();
  await expect(history.getByRole("alert")).toContainText("履歴ページ取得失敗");
  await expect(history.locator("article")).toHaveCount(50);
  await history.getByRole("button", { name: "さらに古いRevisionを読む", exact: true }).click();
  await expect(history.locator("article")).toHaveCount(100);
  const pageIds = await history.locator("article").evaluateAll((articles) => articles.map((article) => article.getAttribute("data-revision-id")));
  expect(new Set(pageIds).size).toBe(100);

  let releasePage!: () => void;
  let markPageStarted!: () => void;
  const pageGate = new Promise<void>((resolve) => { releasePage = resolve; });
  const pageStarted = new Promise<void>((resolve) => { markPageStarted = resolve; });
  await page.unroute(historyUrl);
  await page.route(historyUrl, async (route) => {
    if (new URL(route.request().url()).searchParams.has("before")) {
      markPageStarted();
      await pageGate;
    }
    await route.continue();
  });
  await history.getByRole("button", { name: "さらに古いRevisionを読む", exact: true }).click();
  await pageStarted;
  const stalePageResponse = page.waitForResponse((response) => historyUrl(new URL(response.url())) && new URL(response.url()).searchParams.has("before"));
  await openManuscriptScene(page, second);
  releasePage();
  await stalePageResponse;
  await expect(history).toHaveCount(0);
  await page.unroute(historyUrl);
  await openRevisionHistory(page);
  await expect(page.getByRole("region", { name: "Revision履歴", exact: true })).not.toContainText("Stored revision");

  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto(`/mobile/projects/${project.id}/scenes/${scene.id}?view=writing`);
  await expect(editor(page)).toContainText(revision.markdown);
  await openRevisionHistory(page);
  const mobileHistory = page.getByRole("region", { name: "Revision履歴", exact: true });
  const mobileNextPage = mobileHistory.getByRole("button", { name: "さらに古いRevisionを読む", exact: true });
  await expect(mobileNextPage).toBeVisible();
  await mobileNextPage.scrollIntoViewIfNeeded();
  const buttonBounds = await mobileNextPage.boundingBox();
  expect(buttonBounds).toBeTruthy();
  expect(buttonBounds!.x).toBeGreaterThanOrEqual(0);
  expect(buttonBounds!.x + buttonBounds!.width).toBeLessThanOrEqual(360);
  await mobileNextPage.click();
  await expect(mobileHistory.locator("article")).toHaveCount(100);
  await mobileHistory.getByRole("button", { name: "さらに古いRevisionを読む", exact: true }).click();
  await expect(mobileHistory.locator("article")).toHaveCount(150);
  const mobileIds = await mobileHistory.locator("article").evaluateAll((articles) => articles.map((article) => article.getAttribute("data-revision-id")));
  expect(new Set(mobileIds).size).toBe(150);
  const originalRevision = mobileHistory.locator(`article[data-revision-id="${initialRevision.id}"]`);
  await expect(originalRevision).toContainText("最初の本文。");
  await originalRevision.getByRole("button", { name: "このRevisionを新しいRevisionとして復元", exact: true }).click();
  await expect(editor(page)).toContainText("最初の本文。");
  await expect(page.getByRole("region", { name: "Revision履歴", exact: true })).toHaveCount(0);
  const restoredResponse = await page.request.get(documentPath);
  expect(restoredResponse.ok()).toBe(true);
  const restored = (await restoredResponse.json() as { document: { headRevisionId: string }; revision: { id: string; markdown: string } });
  expect(restored.revision.markdown).toBe(initialRevision.markdown);
  expect(restored.document.headRevisionId).toBe(restored.revision.id);
  expect(restored.revision.id).not.toBe(initialRevision.id);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 2)).toBe(true);
});

test("a failed Knowledge list does not block the initial document and can be retried in its panel", async ({ page }) => {
  await ownerLogin(page);
  const headers = { Origin: new URL(page.url()).origin };
  const createdProject = await page.request.post("/api/v1/persistence/projects", { headers, data: { title: `Knowledge failure ${crypto.randomUUID()}` } });
  expect(createdProject.status()).toBe(201);
  const { project } = await createdProject.json() as { project: { id: string } };
  const createdDocument = await page.request.post(`/api/v1/persistence/projects/${project.id}/documents`, {
    headers: { ...headers, "Idempotency-Key": crypto.randomUUID() },
    data: { kind: "scene", title: "唯一のシーン", orderKey: "a", markdown: "初期本文。" },
  });
  expect(createdDocument.status()).toBe(201);
  const document = (await createdDocument.json() as { document: { id: string } }).document;
  const nodesUrl = (url: URL) => url.pathname === `/api/v1/persistence/projects/${project.id}/nodes`;
  let releaseKnowledgeFailure!: () => void;
  let markKnowledgeStarted!: () => void;
  const knowledgeFailureGate = new Promise<void>((resolve) => { releaseKnowledgeFailure = resolve; });
  const knowledgeRequestStarted = new Promise<void>((resolve) => { markKnowledgeStarted = resolve; });
  let nodeRequestCount = 0;
  await page.route(nodesUrl, async (route) => {
    nodeRequestCount += 1;
    if (nodeRequestCount === 1) {
      markKnowledgeStarted();
      await knowledgeFailureGate;
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Knowledge一覧を利用できません。", code: "TEST_FAILURE" }) });
      return;
    }
    await route.continue();
  });
  const documentListResponse = page.waitForResponse((response) => new URL(response.url()).pathname === `/api/v1/persistence/projects/${project.id}/documents`);
  await page.goto(`/desktop/projects/${project.id}`);
  await documentListResponse;
  await knowledgeRequestStarted;
  releaseKnowledgeFailure();
  await page.waitForResponse((response) => nodesUrl(new URL(response.url())));

  await expect(page.locator(`.pg-document-list [data-document-id="${document.id}"]`)).toBeVisible();
  const manuscript = editor(page);
  await expect(manuscript).toContainText("初期本文。");
  const draft = "Knowledge一覧が使えなくても編集して保存できる。";
  await manuscript.fill(draft);
  await expect.poll(() => persistedMarkdown(page, project.id, document.id)).toBe(draft);

  const toolbar = page.getByRole("toolbar", { name: "ワークスペース配置" });
  const panelMenu = toolbar.locator("details");
  if (!await panelMenu.evaluate((element) => (element as HTMLDetailsElement).open)) await panelMenu.locator("summary").click();
  await toolbar.getByRole("button", { name: "知識と根拠を表示", exact: true }).click();
  const knowledge = page.locator('[data-workspace-panel="inspector"] .pg-knowledge');
  await expect(knowledge.getByRole("alert")).toContainText("Knowledge一覧を利用できません。");
  await knowledge.getByRole("button", { name: "再試行", exact: true }).click();
  await expect(knowledge.getByRole("alert")).toHaveCount(0);
  await expect(manuscript).toContainText(draft);
});

test("same-named scenes show their chapter in the desktop and mobile writing headers", async ({ page }) => {
  const { project } = await createWritingFixture(page);
  const origin = new URL(page.url()).origin;
  const add = async (data: { kind: "chapter" | "scene"; title: string; orderKey: string; parentId?: string }) => {
    const response = await page.request.post(`/api/v1/persistence/projects/${project.id}/documents`, {
      headers: { Origin: origin, "Idempotency-Key": randomUUID() },
      data: { ...data, markdown: "" },
    });
    expect(response.status(), await response.text()).toBe(201);
    return (await response.json() as { document: { id: string } }).document;
  };
  const first = await add({ kind: "chapter", title: "第一章", orderKey: "c" });
  const third = await add({ kind: "chapter", title: "第三章", orderKey: "d" });
  const source = await add({ kind: "scene", title: "帰港", orderKey: "a", parentId: first.id });
  const writing = await add({ kind: "scene", title: "帰港", orderKey: "a", parentId: third.id });

  for (const mode of ["desktop", "mobile"] as const) {
    await page.setViewportSize({ width: mode === "desktop" ? 1280 : 390, height: 844 });
    const context = page.locator(mode === "desktop" ? ".pg-editor-heading .eyebrow" : ".mobile-shell-context");
    for (const [document, chapter] of [[writing, "第三章"], [source, "第一章"]] as const) {
      await page.goto(`${origin}/${mode}/projects/${project.id}/scenes/${document.id}${mode === "mobile" ? "?view=writing" : ""}`);
      await expect(editor(page)).toBeVisible();
      await expect(context).toBeVisible();
      await expect(context).toHaveText(`${chapter} / ${project.title}`);
    }
  }
});

test("mobile reference sheet has a named dialog and excludes the background from assistive technology", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await createWritingFixture(page, "mobile");
  const pageRoot = page.locator("#ion-view-container-root");
  const sheet = page.locator("ion-modal.mobile-shell-reference-modal");

  const outlineTrigger = page.getByRole("button", { name: "構成", exact: true });
  await outlineTrigger.click();
  await expect(page.getByRole("dialog", { name: "原稿の参照", exact: true })).toBeVisible();
  await expect(pageRoot).toHaveAttribute("aria-hidden", "true");
  await expect(page.getByRole("navigation", { name: "モバイル画面" })).toHaveCount(0);
  const focusStaysInSheet = () => sheet.evaluate((element) => {
    const documentFocus = element.ownerDocument.activeElement;
    const shadowFocus = element.shadowRoot?.activeElement;
    return documentFocus === element
      ? Boolean(shadowFocus && element.shadowRoot?.contains(shadowFocus))
      : Boolean(documentFocus && element.contains(documentFocus));
  });

  await page.keyboard.press("Tab");
  await expect.poll(focusStaysInSheet).toBe(true);
  await page.keyboard.press("Shift+Tab");
  await expect.poll(focusStaysInSheet).toBe(true);
  await page.keyboard.press("Escape");
  await expect(sheet).not.toBeVisible();
  await expect(pageRoot).not.toHaveAttribute("aria-hidden", "true");
  await expect(outlineTrigger).toBeFocused();

  const inspectorTrigger = page.getByRole("button", { name: "知識・保存", exact: true });
  await inspectorTrigger.click();
  await expect(page.getByRole("dialog", { name: "原稿の参照", exact: true })).toBeVisible();
  await expect(pageRoot).toHaveAttribute("aria-hidden", "true");
  await sheet.getByRole("button", { name: "閉じる", exact: true }).click();
  await expect(sheet).not.toBeVisible();
  await expect(pageRoot).not.toHaveAttribute("aria-hidden", "true");
  await expect(inspectorTrigger).toBeFocused();
});

test("mobile outline reveal keeps its title, tabs, and dismiss control visible at narrow widths", async ({ page }) => {
  const { project } = await createWritingFixture(page, "mobile", "作業中の初期シーン");
  const origin = new URL(page.url()).origin;
  async function createDocument(input: {
    kind: "volume" | "chapter" | "scene";
    title: string;
    orderKey: string;
    parentId?: string;
  }): Promise<{ id: string }> {
    const response = await page.request.post(`/api/v1/persistence/projects/${project.id}/documents`, {
      headers: { Origin: origin, "Idempotency-Key": randomUUID() },
      data: { markdown: "", ...input },
    });
    expect(response.status(), await response.text()).toBe(201);
    return (await response.json() as { document: { id: string } }).document;
  }

  const volume = await createDocument({ kind: "volume", title: "第一巻　潮が満ちる", orderKey: "00" });
  const chapter = await createDocument({ kind: "chapter", title: "第三章　濡れた目録", orderKey: "00", parentId: volume.id });
  const title = "薄明の羅針盤と夜明け前の連絡船が交わした長い約束「青い目録」 CodexiaMobileManuscript";
  const scene = await createDocument({ kind: "scene", title, orderKey: "00", parentId: chapter.id });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(new URL(`/mobile/projects/${project.id}/scenes/${scene.id}?view=writing`, page.url()).toString());
  await expect(editor(page)).toBeVisible();
  const currentTitle = page.locator(".mobile-shell-current-title");
  await expect(currentTitle).toHaveText(title);
  const editorPanelFocus = await page.locator('.st-workspace-panel[data-workspace-panel="editor"]').evaluate((element) => {
    const panel = element as HTMLElement;
    panel.focus();
    const style = getComputedStyle(panel);
    return {
      focused: document.activeElement === panel,
      outlineStyle: style.outlineStyle,
      outlineWidth: style.outlineWidth,
      outlineOffset: style.outlineOffset,
    };
  });
  expect(editorPanelFocus).toEqual({ focused: true, outlineStyle: "solid", outlineWidth: "3px", outlineOffset: "-3px" });
  for (const { width, height } of [{ width: 390, height: 844 }, { width: 320, height: 760 }]) {
    await page.setViewportSize({ width, height });
    await expect(currentTitle).toBeVisible();
    const titleLayout = await currentTitle.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        whiteSpace: style.whiteSpace,
        textOverflow: style.textOverflow,
        overflow: style.overflow,
        scrollWidth: element.scrollWidth,
        clientWidth: element.clientWidth,
      };
    });
    expect(titleLayout.whiteSpace).toBe("normal");
    expect(titleLayout.textOverflow).toBe("clip");
    expect(titleLayout.overflow).toBe("visible");
    expect(titleLayout.scrollWidth).toBeLessThanOrEqual(titleLayout.clientWidth + 1);

    await page.getByRole("button", { name: "構成", exact: true }).click();
    const sheet = page.locator("ion-modal.mobile-shell-reference-modal");
    await expect(page.getByRole("dialog", { name: "原稿の参照", exact: true })).toBeVisible();
    await expect(sheet.locator(".mobile-shell-reference-header")).toBeVisible();
    const sheetLayout = () => sheet.evaluate((element) => {
      const header = element.querySelector<HTMLElement>(".mobile-shell-reference-header");
      const close = element.querySelector<HTMLButtonElement>(".mobile-shell-reference-close");
      const selected = element.querySelector<HTMLElement>('.mobile-shell-reference-pane .pg-outline-document[aria-current="page"]');
      if (!header || !close || !selected) return { headerVisible: false, closeVisible: false, selectedVisible: false };
      const headerRect = header.getBoundingClientRect();
      const closeRect = close.getBoundingClientRect();
      const selectedRect = selected.getBoundingClientRect();
      return {
        headerVisible: headerRect.top >= 0 && headerRect.bottom <= window.innerHeight,
        closeVisible: closeRect.top >= 0 && closeRect.bottom <= window.innerHeight,
        selectedVisible: selectedRect.top >= headerRect.bottom && selectedRect.top < window.innerHeight
          && selectedRect.bottom > headerRect.bottom,
      };
    });
    await expect.poll(sheetLayout).toEqual({ headerVisible: true, closeVisible: true, selectedVisible: true });
    await expect(sheet.getByRole("tablist", { name: "参照する情報" })).toBeVisible();
    await expect(sheet.locator('.mobile-shell-reference-pane .pg-outline-document[aria-current="page"]')).toContainText(title);
    await sheet.getByRole("button", { name: "閉じる", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "原稿の参照", exact: true })).toBeHidden();
    await expect(currentTitle).toHaveText(title);
    await expect(editor(page)).toBeVisible();
  }
});

test("mobile Knowledge write failures stay visible in the global status after leaving the editor", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const { project } = await createWritingFixture(page, "mobile");
  const failure = "Knowledge候補を保存できませんでした。";
  await page.route(`**/api/v1/persistence/projects/${project.id}/nodes/*`, async (route) => {
    if (route.request().method() === "PUT") {
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: failure }) });
      return;
    }
    await route.continue();
  });

  await page.getByRole("button", { name: "知識・保存", exact: true }).click();
  const sheet = page.locator("ion-modal.mobile-shell-reference-modal");
  await expect(page.getByRole("dialog", { name: "原稿の参照", exact: true })).toBeVisible();
  await sheet.locator(".pg-knowledge-tools > summary").click();
  await sheet.getByLabel("Knowledge候補を追加").fill("失敗する候補");
  await sheet.getByRole("button", { name: "候補を保存", exact: true }).click();
  const status = sheet.getByRole("region", { name: "保存と回復の状態" });
  await expect(status.getByRole("alert")).toHaveText(failure);
  await expect(status.getByRole("alert")).toBeVisible();
  await expect(status).toHaveCSS("position", "static");

  await sheet.getByRole("button", { name: "閉じる", exact: true }).click();
  await expect(sheet).toBeHidden();
  await page.getByRole("button", { name: "設定を開く", exact: true }).click();
  const globalStatus = page.locator(".mobile-shell-status").first();
  await expect(globalStatus.getByRole("alert")).toHaveText(failure);
  await expect(globalStatus.getByRole("alert")).toBeVisible();
  await expect(page.locator(".pg-editor-column")).toBeHidden();
  await expect(page.getByRole("alert")).toHaveCount(1);
});

test("desktop mode switch stays visible and operable at 320 CSS pixels", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 844 });
  const title = "320pxでも切れずに参照できる長い作品名".repeat(4);
  const { project, scene } = await createWritingFixture(page, "desktop", title);
  const desktopShell = page.locator(".st-desktop-shell");
  const modeSwitch = page.getByRole("button", { name: "モバイル ↗", exact: true });

  for (const width of [320, 640, 1280, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await expect(desktopShell).toBeVisible();
    await expect(page).toHaveURL(/\/desktop\//u);
    await expect(modeSwitch).toBeVisible();
    await expect(page.locator(".st-studio-breadcrumb strong")).toHaveText(title);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 2)).toBe(true);
    const box = await modeSwitch.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(width);
  }

  const pointerBox = await modeSwitch.boundingBox();
  expect(pointerBox).not.toBeNull();
  await page.mouse.click(pointerBox!.x + pointerBox!.width / 2, pointerBox!.y + pointerBox!.height / 2);
  await expect(page).toHaveURL(/\/mobile\//u);
  await expect(page.getByRole("textbox", { name: "本文", exact: true })).toContainText("最初の本文。");

  await page.goto(`/desktop/projects/${project.id}/scenes/${scene.id}`);
  for (let attempt = 0; attempt < 24; attempt += 1) {
    if (await modeSwitch.evaluate((element) => document.activeElement === element)) break;
    await page.keyboard.press("Tab");
  }
  await expect(modeSwitch).toBeFocused();
  const focusState = await modeSwitch.evaluate((element) => {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return { outlineStyle: style.outlineStyle, outlineWidth: style.outlineWidth, left: rect.left, right: rect.right };
  });
  expect(focusState.outlineStyle).toBe("solid");
  expect(focusState.outlineWidth).toBe("3px");
  expect(focusState.left).toBeGreaterThanOrEqual(0);
  expect(focusState.right).toBeLessThanOrEqual(320);
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/mobile\//u);
  await expect(page.getByRole("textbox", { name: "本文", exact: true })).toContainText("最初の本文。");
});

test("recovery retry after pagehide retains its exact PostgreSQL draft", async ({ page }) => {
  const { project, scene } = await createWritingFixture(page);
  const text = "頁を隠しても残る日本語のDraft。";
  await expectMarkdown(page, "最初の本文。\n次の文章です。");
  await page.route("**/api/v1/persistence/projects/*/documents/*", (route) => route.request().method() === "PATCH" ? route.abort("failed") : route.continue());
  await editor(page).click();
  await editor(page).press("ControlOrMeta+a");
  await page.keyboard.insertText(text);
  await expectMarkdown(page, text);
  await expect.poll(async () => (await readPersistenceDrafts(page)).some((draft) => draft.documentId === scene.id && draft.markdown === text)).toBe(true);
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true })));
  await page.unroute("**/api/v1/persistence/projects/*/documents/*");
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })));
  await expectMarkdown(page, text);
  await expect.poll(async () => {
    const response = await page.request.get(`/api/v1/persistence/projects/${project.id}/documents/${scene.id}`);
    return response.ok() ? ((await response.json()) as { revision: { markdown: string } }).revision.markdown : "";
  }).toBe(text);
  await expectServerSaved(page);
});

test("both production Shells preserve recoverable Japanese drafts and the Mobile writing and reading flow", async ({ page }) => {
  for (const mode of ["desktop", "mobile"] as const) {
    await page.setViewportSize({ width: mode === "mobile" ? 390 : 1280, height: 900 });
    const { project, scene } = await createWritingFixture(page, mode, undefined, "");
    const text = "東京《とうきょう》へ向かう。\n日本語😀の本文。";
    await editor(page).click();
    await page.keyboard.insertText(text);
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

async function visibleReaderParagraphs(page: Page): Promise<string[]> {
  return page.locator(".reading-pager-content .ruby-line").evaluateAll((elements) => {
    const viewport = document.querySelector<HTMLElement>(".reading-pager");
    if (!viewport) return [];
    const box = viewport.getBoundingClientRect();
    return elements.filter((element) => {
      const rect = element.getBoundingClientRect();
      return rect.right > box.left && rect.left < box.right && rect.bottom > box.top && rect.top < box.bottom;
    }).map((element) => element.textContent ?? "");
  });
}

test("Mobile reader keeps first-to-last Japanese paragraphs visible at supported widths and cancels touch gestures", async ({ page, browserName }) => {
  for (const width of [320, 390]) {
    for (const direction of ["horizontal", "vertical"] as const) {
      await page.setViewportSize({ width, height: 844 });
      const text = Array.from({ length: 130 }, (_, index) => `第${index + 1}段落｜日本語の本文を読む。`).join("\n");
      await createWritingFixture(page, "mobile", undefined, text);
      await page.getByRole("button", { name: "読む", exact: true }).click();
      const displayMenu = page.locator(".pg-editor-display-menu");
      if (!await displayMenu.evaluate((element) => (element as HTMLDetailsElement).open)) await displayMenu.locator("summary").click();
      await page.getByLabel("組方向").selectOption(direction);
      await expect.poll(() => visibleReaderParagraphs(page)).toContainEqual(expect.stringContaining("第1段落"));

      const pager = page.locator(".reading-pager");
      const pagerBounds = await pager.boundingBox();
      expect(pagerBounds).not.toBeNull();
      expect(pagerBounds!.x).toBeGreaterThanOrEqual(0);
      expect(pagerBounds!.x + pagerBounds!.width).toBeLessThanOrEqual(width);
      const beforePage = await pager.getAttribute("data-page-index");
      const beforeClass = await pager.getAttribute("class");
      const box = await pager.boundingBox();
      expect(box).not.toBeNull();
      const x = direction === "vertical" ? box!.x + 30 : box!.x + box!.width - 30;
      const y = box!.y + box!.height / 2;
      if (browserName === "chromium") {
        const cdp = await page.context().newCDPSession(page);
        try {
          for (const movedX of [null, direction === "vertical" ? x + 70 : x - 70]) {
            await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y, id: 7 }] });
            if (movedX !== null) await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: movedX, y, id: 7 }] });
            await cdp.send("Input.dispatchTouchEvent", { type: "touchCancel", touchPoints: [] });
            await expect(pager).toHaveAttribute("data-page-index", beforePage!);
            await expect(pager).toHaveAttribute("class", beforeClass!);
          }
          const centerX = box!.x + box!.width / 2;
          const forwardX = centerX + (direction === "vertical" ? 70 : -70);
          for (const [start, end, expectedPage] of [[centerX, forwardX, "1"], [forwardX, centerX, "0"]] as const) {
            await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: start, y, id: 7 }] });
            await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: end, y, id: 7 }] });
            await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
            await expect(pager).toHaveAttribute("data-page-index", expectedPage);
          }
        } finally {
          await cdp.detach();
        }
      }

      await page.getByRole("button", { name: "次のページ", exact: true }).click();
      await expect.poll(async () => {
        const paragraphs = await visibleReaderParagraphs(page);
        return paragraphs.length > 0 && paragraphs.some((paragraph) => paragraph.includes("第"));
      }).toBe(true);
      await expect.poll(() => pager.getAttribute("data-page-index")).not.toBe(beforePage);
      await page.getByRole("button", { name: "前のページ", exact: true }).click();
      await expect(pager).toHaveAttribute("data-page-index", "0");
      await expect.poll(() => visibleReaderParagraphs(page)).toContainEqual(expect.stringContaining("第1段落"));

      const tapX = direction === "vertical" ? x : box!.x + box!.width - 30;
      await page.mouse.click(tapX, y);
      await expect.poll(() => pager.getAttribute("data-page-index")).not.toBe("0");
      for (let index = 0; index < 20 && Number(await pager.getAttribute("data-page-index")) < Number(await pager.getAttribute("data-page-count")) - 1; index += 1) {
        await page.getByRole("button", { name: "次のページ", exact: true }).click();
      }
      await expect.poll(() => visibleReaderParagraphs(page)).toContainEqual(expect.stringContaining("第130段落"));
    }
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
  await expectServerSaved(page);
  await expect(editor(page)).toHaveAttribute("data-original-editor", "retained");
  await editor(page).press("Control+A");
  await page.locator(".pg-editor-command-menu > summary").click();
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
  await editor(page).click(); await editor(page).press("ControlOrMeta+a"); await page.keyboard.insertText(text); await expect(page.getByRole("alert").first()).toBeVisible(); await expectMarkdown(page, text);
  await denyWrites(page, false); await editor(page).press("End"); await editor(page).press("!");
  await expect.poll(async () => (await readPersistenceDrafts(page)).some((draft) => draft.documentId === scene.id && draft.markdown.includes(text)) || (await page.locator(".pg-save-state summary").textContent()) === "作品に保存済み").toBeTruthy();
  await expect(editor(page)).toContainText(text);
});

test("UX canon keeps explicit shells usable with long Japanese titles and enlarged text", async ({ page }) => {
  for (const mode of ["desktop", "mobile"] as const) {
    await page.setViewportSize({ width: mode === "mobile" ? 390 : 1280, height: 900 }); await createWritingFixture(page, mode, "長い日本語の章題".repeat(8));
    const displayMenu = page.locator(".pg-editor-display-menu");
    if (!await displayMenu.evaluate((element) => (element as HTMLDetailsElement).open)) await displayMenu.locator("summary").click();
    await page.getByLabel("原稿の文字サイズ").fill("24"); await editor(page).fill("大きな文字でも読み書きできる。".repeat(10));
    await expect(editor(page)).toHaveCSS("font-size", "24px");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 2)).toBe(true);
    await expect(page.getByRole("button", { name: "今すぐ保存" })).toBeVisible();
  }
});

test("guarded shell switches remember completed choices and keep the manuscript without preference storage", async ({ page }) => {
  const { project, scene } = await createWritingFixture(page, "desktop");
  const firstDraft = "切替前の現在の原稿を保持する。";
  await page.evaluate(() => localStorage.setItem("scriptorium:ui-mode", "desktop"));
  await editor(page).fill(firstDraft);
  await expectMarkdown(page, firstDraft);
  await expectDeviceDraft(page);

  await editor(page).dispatchEvent("compositionstart", { data: "にほんご" });
  await page.getByRole("button", { name: "モバイル ↗", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/desktop/projects/${project.id}/scenes/${scene.id}`, "u"));
  expect(await page.evaluate(() => localStorage.getItem("scriptorium:ui-mode"))).toBe("desktop");
  await expectMarkdown(page, firstDraft);
  await editor(page).dispatchEvent("compositionend", { data: "日本語" });

  await page.getByRole("button", { name: "モバイル ↗", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/mobile/projects/${project.id}/scenes/${scene.id}`, "u"));
  await expectMarkdown(page, firstDraft);
  expect(await page.evaluate(() => localStorage.getItem("scriptorium:ui-mode"))).toBe("mobile");
  await page.goto("/");
  await expect.poll(() => new URL(page.url()).pathname.startsWith("/mobile")).toBe(true);
  await expect(page.locator(".mobile-shell")).toBeVisible();

  await page.goto(`/mobile/projects/${project.id}/scenes/${scene.id}?view=writing`);
  await expectMarkdown(page, firstDraft);
  await page.getByRole("button", { name: "設定を開く", exact: true }).click();
  await page.getByRole("button", { name: "Desktop版へ切り替え", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/desktop/projects/${project.id}/scenes/${scene.id}`, "u"));
  await expectMarkdown(page, firstDraft);
  expect(await page.evaluate(() => localStorage.getItem("scriptorium:ui-mode"))).toBe("desktop");
  await page.goto("/");
  await expect.poll(() => new URL(page.url()).pathname.startsWith("/desktop")).toBe(true);
  await expect(page.locator(".st-desktop-shell")).toBeVisible();

  await page.goto(`/desktop/projects/${project.id}/scenes/${scene.id}`);
  const secondDraft = "保存先が使えなくても移動経路と原稿を保持する。";
  await editor(page).click();
  await editor(page).press("ControlOrMeta+a");
  await page.keyboard.insertText(secondDraft);
  await expectMarkdown(page, secondDraft);
  await expectDeviceDraft(page);
  await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key: string, value: string): void {
      if (key === "scriptorium:ui-mode") throw new DOMException("Storage unavailable", "QuotaExceededError");
      original.call(this, key, value);
    };
  });
  await page.getByRole("button", { name: "モバイル ↗", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/mobile/projects/${project.id}/scenes/${scene.id}`, "u"));
  await expectMarkdown(page, secondDraft);
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
  await expectMarkdown(page, "最初の本文。\n次の文章です。");
  await editor(page).click(); await editor(page).press("ControlOrMeta+a"); await page.keyboard.insertText(text);
  await expectMarkdown(page, text);
  await expectDeviceDraft(page);
  await editor(page).dispatchEvent("compositionstart", { data: "とうきょう" });
  await page.getByRole("button", { name: "モバイル ↗" }).click();
  await expect(page).toHaveURL(/desktop/u); await expectMarkdown(page, text);
  await editor(page).dispatchEvent("compositionend", { data: "東京" });
  await page.getByRole("button", { name: "モバイル ↗" }).click();
  await expect(page).toHaveURL(/mobile/u);
  await page.getByRole("navigation", { name: "モバイル画面" }).getByRole("button", { name: "書く", exact: true }).click();
  await expectMarkdown(page, text);
});


test("desktop author can download a portable work and import it without replacing the source", async ({ page }) => {
  const { project, scene } = await createWritingFixture(page);
  const transfer = page.locator("details").filter({ has: page.locator("summary", { hasText: "作品のエクスポート・インポート" }) });
  await transfer.locator("summary").click();
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    transfer.getByRole("button", { name: "選択中の作品をJSONでエクスポート" }).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/^codexia-.*\.json$/u);
  const location = await download.path();
  expect(location).toBeTruthy();
  const json = await readFile(location!, "utf8");
  const archive = JSON.parse(json) as { format: string; documents: Array<{ id: string; markdown: string }> };
  expect(archive.format).toBe("codexia-work/v1");
  expect(archive.documents.find((item) => item.id === scene.id)?.markdown).toContain("最初の本文。");

  await transfer.locator('input[type="file"]').setInputFiles({
    name: "portable-work.json", mimeType: "application/json", buffer: Buffer.from(json),
  });
  await expect(page.getByText("新しい作品としてJSONを取り込みました。", { exact: false })).toBeVisible();
  const currentProject = await page.getByLabel("作品", { exact: true }).inputValue();
  expect(currentProject).not.toBe(project.id);
  const imported = await page.request.get("/api/v1/persistence/projects/" + currentProject + "/documents");
  expect(imported.ok()).toBe(true);
  const body = await imported.json() as { documents: Array<{ id: string; title: string }> };
  expect(body.documents.some((item) => item.id === scene.id)).toBe(true);
  const original = await page.request.get("/api/v1/persistence/projects/" + project.id + "/documents/" + scene.id);
  expect(original.ok()).toBe(true);
  expect((await original.json() as { revision: { markdown: string } }).revision.markdown).toContain("最初の本文。");
});

test("keeps the manuscript near its scene title with one concise protection status", async ({ page }) => {
  const { project, scene } = await createWritingFixture(page);
  const measured: Array<{ mode: string; width: number; height: number; top: number; protectionCount: number; pageWidth: number }> = [];
  for (const sample of [
    { mode: "desktop" as const, width: 1440, height: 900 },
    { mode: "desktop" as const, width: 1024, height: 768 },
    { mode: "mobile" as const, width: 390, height: 844 },
    { mode: "mobile" as const, width: 320, height: 760 },
  ]) {
    await page.setViewportSize({ width: sample.width, height: sample.height });
    const path = `/${sample.mode}/projects/${project.id}/scenes/${scene.id}${sample.mode === "mobile" ? "?view=writing" : ""}`;
    await page.goto(new URL(path, page.url()).toString());
    await expect(editor(page)).toBeVisible();
    const geometry = await page.evaluate(() => {
      const firstLine = document.querySelector<HTMLElement>(".pg-editor .cm-line");
      if (!firstLine) throw new Error("The first manuscript line is missing");
      const { top, bottom, left, right, height } = firstLine.getBoundingClientRect();
      const visible = (element: Element) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
      };
      return {
        firstLine: { top, bottom, left, right, height },
        actionBounds: [...document.querySelectorAll<HTMLElement>(".pg-editor-actions > *")].map((element) => { const rect = element.getBoundingClientRect(); return { label: element.textContent?.trim(), x: rect.x, y: rect.y, width: rect.width, height: rect.height }; }),
        visibleProtection: [...document.querySelectorAll(".st-studio-durability, .pg-save-state, .mobile-shell-protection, .mobile-shell-reference-durability")]
          .filter(visible).map((element) => element.textContent?.trim()),
        visibleAlerts: [...document.querySelectorAll('[role="alert"]')].filter(visible).map((element) => element.textContent?.trim()),
        pageWidth: document.documentElement.scrollWidth,
      };
    });
    measured.push({ mode: sample.mode, width: sample.width, height: sample.height, top: geometry.firstLine.top, protectionCount: geometry.visibleProtection.length, pageWidth: geometry.pageWidth });
    console.log(`authoring elements ${sample.width}: ${JSON.stringify(geometry.actionBounds)}`);
    await page.screenshot({ path: `/dev/shm/codexia-authoring-after-${sample.mode}-${sample.width}.png` });
  }
  console.log(`authoring after: ${JSON.stringify(measured)}`);
  for (const sample of measured) {
    const target = sample.mode === "desktop" ? sample.height / 3 : sample.height / 4;
    expect(sample.top, `${sample.mode} ${sample.width}x${sample.height}`).toBeLessThanOrEqual(target);
    expect(sample.protectionCount, `${sample.mode} ${sample.width}x${sample.height}`).toBe(1);
    expect(sample.pageWidth, `${sample.mode} ${sample.width}x${sample.height}`).toBe(sample.width);
  }
  await expectServerSaved(page);
  const protection = await openProtectionDetails(page);
  await expect(protection).toContainText("この端末: この原稿に未保存の変更はありません");
  await expect(protection).toContainText("サーバー: PostgreSQLへの保存を確認しました");
  expect(await page.locator(".pg-editor-actions").count()).toBe(1);
});

test("journal writes do not spam live save status while a server receipt remains exact", async ({ page }) => {
  const { scene } = await createWritingFixture(page, "mobile");
  const details = await openProtectionDetails(page);
  await expect(details).toContainText("この端末: この原稿に未保存の変更はありません");
  await expect(details).toContainText("サーバー: PostgreSQLへの保存を確認しました");
  await page.evaluate(() => {
    const summary = document.querySelector(".pg-save-state summary");
    if (!summary) throw new Error("The save status disclosure is missing");
    const probe = window as Window & { __saveStatusChanges?: string[] };
    probe.__saveStatusChanges = [];
    new MutationObserver(() => {
      if (summary.getAttribute("aria-live") === "polite") probe.__saveStatusChanges?.push(summary.textContent?.trim() ?? "");
    })
      .observe(summary, { subtree: true, childList: true, characterData: true });
  });
  await editor(page).fill("");
  await editor(page).pressSequentially("abcdefgh", { delay: 140 });
  await expectDeviceDraft(page);
  const summary = page.locator(".pg-save-state summary");
  await expect(summary).toHaveText("このブラウザーに下書きあり");
  await expect(summary).toHaveAttribute("aria-live", "off");
  expect(await page.evaluate(() => (window as Window & { __saveStatusChanges?: string[] }).__saveStatusChanges ?? [])).toEqual([]);
  await expectServerSaved(page);
  await expect(summary).toHaveAttribute("aria-live", "polite");
  const changes = await page.evaluate(() => (window as Window & { __saveStatusChanges?: string[] }).__saveStatusChanges ?? []);
  expect(changes.length).toBeLessThanOrEqual(3);
  expect(changes).not.toContain("このブラウザーに下書きあり");
  await expect(details).toContainText("サーバー: PostgreSQLへの保存を確認しました");
  await expect(details.locator("summary")).toHaveText("作品に保存済み");
});

test("save details keep the confirmed work version separate from later device input", async ({ page }) => {
  const initial = "A。作品に保存した文。";
  const firstAddition = "\nB。先に送信した文。";
  const secondAddition = "\nC。その後に入力した文。";
  const { project, scene } = await createWritingFixture(page, "mobile", undefined, initial);
  const details = await openProtectionDetails(page);
  const path = `/api/v1/persistence/projects/${project.id}/documents/${scene.id}`;
  let releaseFirst!: () => void;
  let releaseSecond!: () => void;
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const secondGate = new Promise<void>((resolve) => { releaseSecond = resolve; });
  let requests = 0;
  await page.route((url) => url.pathname === path, async (route) => {
    if (route.request().method() !== "PATCH") return route.continue();
    await (++requests === 1 ? firstGate : secondGate);
    await route.continue();
  });

  try {
    await editor(page).fill(initial + firstAddition);
    await expectMarkdown(page, initial + firstAddition);
    await expect.poll(() => requests).toBe(1);
    await editor(page).fill(initial + firstAddition + secondAddition);
    await expectMarkdown(page, initial + firstAddition + secondAddition);
    await expect.poll(async () => (await readPersistenceDrafts(page))
      .find((draft) => draft.documentId === scene.id)?.markdown).toBe(initial + firstAddition + secondAddition);

    await expect(details).toContainText("現在の編集をこのブラウザーに記録しました");
    await expect(details).toContainText("送信後の入力は今回の保存に含まれません");
    await expect.poll(() => persistedMarkdown(page, project.id, scene.id)).toBe(initial);

    releaseFirst();
    await expect.poll(() => persistedMarkdown(page, project.id, scene.id)).toBe(initial + firstAddition);
    await expect(details).toContainText("直前に確認した版は作品に保存されています");
    await expect(details.locator("summary")).not.toHaveText("作品に保存済み");

    releaseSecond();
    await expect.poll(() => persistedMarkdown(page, project.id, scene.id)).toBe(initial + firstAddition + secondAddition);
    await expect(details.locator("summary")).toHaveText("作品に保存済み");
  } finally {
    releaseFirst();
    releaseSecond();
  }
});
