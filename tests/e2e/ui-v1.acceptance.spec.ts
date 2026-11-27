import type { Page, Request } from "@playwright/test";
import { expect, test, type AuthorSession } from "./author-oauth-fixture";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { appendManuscript, createOAuthWritingFixture, expectDeviceDraft, expectServerSaved, openManuscriptScene, openProtectionDetails, openRevisionHistory, readPersistenceDrafts, replaceManuscript, manuscriptEditor as editor, readManuscriptMarkdown as markdown, writingFixturePath } from "./postgres-fixture";

const requirePersistence = createRequire(new URL("../../packages/persistence-postgres/package.json", import.meta.url));
type TestPostgresClient = {
  connect(): Promise<void>;
  query(sql: string, parameters?: unknown[]): Promise<unknown>;
  end(): Promise<void>;
};
const { Client } = requirePersistence("pg") as { Client: new (options: { connectionString: string }) => TestPostgresClient };

// Chromium executes every UI case, including shared and public-surface behavior.
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
async function persistedMarkdown(author: AuthorSession, projectId: string, documentId: string): Promise<string> {
  const response = await author.fetch(`/api/v1/persistence/projects/${projectId}/documents/${documentId}`);
  if (!response.ok()) return "";
  return ((await response.json()) as { revision: { markdown: string } }).revision.markdown;
}
async function seedManuscriptRevisions(author: AuthorSession, documentPath: string, manuscripts: string[]) {
  const clientId = "revision-history-fixture";
  const initial = await author.fetch(documentPath);
  expect(initial.ok()).toBe(true);
  let current = (await initial.json() as { revision: { id: string; markdown: string } }).revision;
  for (const manuscript of manuscripts) {
    const response = await author.fetch(documentPath, {
      method: "PATCH",
      headers: { Origin: author.origin, "Idempotency-Key": randomUUID(), "X-Client-Id": clientId },
      data: {
        baseRevisionId: current.id,
        changes: [{ fromUtf16: 0, toUtf16: current.markdown.length, insert: manuscript }],
        resultingSha256: createHash("sha256").update(manuscript).digest("hex"),
        clientId,
      },
    });
    expect(response.status()).toBe(200);
    current = (await response.json() as { revision: { id: string; markdown: string } }).revision;
    expect(current.markdown).toBe(manuscript);
  }
  return current;
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

test("legacy draft import preserves active input when its journal debounce is pending", { tag: "@author-desktop" }, async ({ page, authorizeAuthor }) => {
  const { scene } = await createOAuthWritingFixture(authorizeAuthor, page); await seedLegacy(page); await previewLegacy(page);
  await page.route("**/api/v1/persistence/projects/*/documents/*", (route) => route.request().method() === "PATCH" ? route.abort("failed") : route.continue());
  const text = "現在入力中の原稿を旧記録で消さない。";
  await editor(page).click(); await editor(page).press("ControlOrMeta+a"); await page.keyboard.insertText(text);
  await page.getByRole("button", { name: "この文書へ取り込む" }).click();
  await expectMarkdown(page, text); expect(await sourceExists(page)).toBe(true);
  await expect.poll(async () => (await readPersistenceDrafts(page)).some((draft) => draft.documentId === scene.id && draft.markdown === text)).toBe(true);
});

test("legacy draft import can be canceled, reloads its source, and removes it only after journal durability", { tag: "@author-desktop" }, async ({ page, authorizeAuthor }) => {
  const { scene } = await createOAuthWritingFixture(authorizeAuthor, page); await seedLegacy(page); await previewLegacy(page);
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
test("keyboard select-all replacement saves exactly the intended manuscript", { tag: "@author-desktop" }, async ({ page, authorizeAuthor }) => {
  const { project, scene, author } = await createOAuthWritingFixture(authorizeAuthor, page);
  const text = "先に確定した本文。";
  await expectMarkdown(page, "最初の本文。\n次の文章です。");
  await editor(page).click();
  await editor(page).press("ControlOrMeta+a");
  await page.keyboard.insertText(text);
  await expectMarkdown(page, text);
  const url = `/api/v1/persistence/projects/${project.id}/documents/${scene.id}`;
  await expect.poll(async () => {
    const response = await author.fetch(url);
    return response.ok() ? ((await response.json()) as { revision: { markdown: string } }).revision.markdown : "";
  }).toBe(text);
});

test("a committed save with a lost response stays unconfirmed until the same operation receives a receipt", { tag: "@author-desktop" }, async ({ page, authorizeAuthor }) => {
  const { project, scene } = await createOAuthWritingFixture(authorizeAuthor, page, "desktop");
  const databaseUrl = process.env.CODEXIA_E2E_DATABASE_URL;
  expect(databaseUrl, "the browser test must use its disposable PostgreSQL database").toBeTruthy();
  const client = new Client({ connectionString: databaseUrl! });
  const documentUrl = `/api/v1/persistence/projects/${project.id}/documents/${scene.id}`;
  const body = "PostgreSQL committed this text before its browser response was lost.";
  const requests: Array<{ idempotencyKey: string | undefined; clientId: string | undefined; data: string | null }> = [];
  let resolveLost!: () => void;
  const lost = new Promise<void>((resolve) => { resolveLost = resolve; });
  const readDatabaseHead = async () => {
    const result = await client.query(
      `SELECT document.head_revision_id::text AS revision_id, revision.markdown,
         (SELECT count(*)::int FROM document_revision AS all_revisions
          WHERE all_revisions.project_id = document.project_id AND all_revisions.document_id = document.id) AS revision_count
       FROM document
       JOIN document_revision AS revision
         ON revision.project_id = document.project_id AND revision.document_id = document.id AND revision.id = document.head_revision_id
       WHERE document.project_id = $1 AND document.id = $2`,
      [project.id, scene.id],
    ) as { rows: Array<{ revision_id: string; markdown: string; revision_count: number | string }> };
    expect(result.rows).toHaveLength(1);
    return { ...result.rows[0]!, revision_count: Number(result.rows[0]!.revision_count) };
  };

  await client.connect();
  try {
    const before = await readDatabaseHead();
    await page.route(`**${documentUrl}`, async (route) => {
      if (route.request().method() !== "PATCH") return route.continue();
      requests.push({
        idempotencyKey: route.request().headers()["idempotency-key"],
        clientId: route.request().headers()["x-client-id"],
        data: route.request().postData(),
      });
      if (requests.length === 1) {
        const committed = await route.fetch();
        expect(committed.ok()).toBe(true);
        await route.abort();
        resolveLost();
        return;
      }
      await route.continue();
    });

    await editor(page).click();
    await editor(page).press("ControlOrMeta+a");
    await page.keyboard.insertText(body);
    await lost;
    const committed = await readDatabaseHead();
    expect(committed.markdown).toBe(body);
    expect(committed.revision_id).not.toBe(before.revision_id);
    expect(committed.revision_count).toBe(before.revision_count + 1);
    await expect(page.locator(".pg-save-state summary")).toHaveText("保存結果を確認できません");
    await expect.poll(async () => (await readPersistenceDrafts(page) as unknown as Array<{ documentId: string; pendingSave?: { markdown: string } }>).find((draft) => draft.documentId === scene.id)?.pendingSave?.markdown).toBe(body);

    await page.reload();
    await authorizeAuthor("desktop", page, { continueCurrentPage: true });
    await expectMarkdown(page, body);
    await expect.poll(() => requests.length).toBe(2);
    await expectServerSaved(page);
    expect(requests[1]).toEqual(requests[0]);
    const reconciled = await readDatabaseHead();
    expect(reconciled).toEqual(committed);
    expect((await readPersistenceDrafts(page)).filter((draft) => draft.documentId === scene.id)).toEqual([]);
  } finally {
    await client.end();
  }
});

test("legacy draft import retains the confirmed PostgreSQL revision and creates a new generation", { tag: "@author-desktop" }, async ({ page, authorizeAuthor }) => {
  const { project, scene, author } = await createOAuthWritingFixture(authorizeAuthor, page); const text = "先に確定した本文。";
  // Use the user-facing replacement path rather than a diagnostic contenteditable fill.
  await editor(page).click();
  await editor(page).press("ControlOrMeta+a");
  await page.keyboard.insertText(text);
  // "Saved" may still describe the previous revision until the async PATCH
  // completes. Pin only a revision whose canonical PostgreSQL body is this text.
  const url = `/api/v1/persistence/projects/${project.id}/documents/${scene.id}`;
  await expect.poll(async () => {
    const response = await author.fetch(url);
    return response.ok() ? ((await response.json()) as { revision: { markdown: string } }).revision.markdown : "";
  }).toBe(text);
  const before = await author.fetch(url); const original = await before.json();
  await seedLegacy(page); await previewLegacy(page); await page.getByRole("button", { name: "この文書へ取り込む" }).click();
  await expect(editor(page)).toHaveText("旧記録の日本語原稿😀");
  await expectServerSaved(page);
  const pinned = await author.fetch(`/api/v1/persistence/projects/${project.id}/documents/${scene.id}?revision=${original.revision.id}`);
  expect((await pinned.json()).revision.markdown).toBe(text); expect(await sourceExists(page)).toBe(false);
});

test("legacy draft import preserves input after its strict journal write fails", { tag: "@author-desktop" }, async ({ page, authorizeAuthor }) => {
  await createOAuthWritingFixture(authorizeAuthor, page); const original = await editor(page).innerText(); await seedLegacy(page); await previewLegacy(page); await denyWrites(page, true);
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

test("legacy draft import reports a rejected composition flush and keeps its source", { tag: "@author-desktop" }, async ({ page, authorizeAuthor }) => {
  await createOAuthWritingFixture(authorizeAuthor, page); await seedLegacy(page); await previewLegacy(page); const text = await editor(page).innerText();
  await editor(page).dispatchEvent("compositionstart", { data: "にほんご" });
  await page.getByRole("button", { name: "この文書へ取り込む" }).click();
  await expectMarkdown(page, text); expect(await sourceExists(page)).toBe(true);
  await expect(page.getByRole("alert").first()).toContainText(/変換|入力/u);
  await editor(page).dispatchEvent("compositionend", { data: "日本語" });
});

test("[TEST-UI-004-001] legacy draft composition cannot write old scene text into a newly selected scene", { tag: "@author-desktop" }, async ({ page, authorizeAuthor }) => {
  const { second } = await createOAuthWritingFixture(authorizeAuthor, page); await seedLegacy(page); await previewLegacy(page);
  await editor(page).dispatchEvent("compositionstart", { data: "にほんご" });
  await page.getByRole("button", { name: "この文書へ取り込む" }).click();
  await editor(page).dispatchEvent("compositionend", { data: "日本語" });
  await page.locator(".pg-document-list").getByRole("treeitem", { name: new RegExp(second.title) }).click();
  await expect(editor(page)).toContainText("最初の本文。"); expect(await sourceExists(page)).toBe(true);
});

test("[TEST-UI-001-001] the launcher opens Desktop for new and legacy choices and rejects retired Mobile routes", async ({ page, authorServer }) => {
  const origin = authorServer.apiOrigin;
  for (const route of ["/mobile", "/mobile/", "/mobile/projects/p/scenes/s"]) {
    const response = await page.request.get(new URL(route, origin).href, { maxRedirects: 0 });
    expect(response.status(), route).toBe(404);
  }
  await page.goto(origin);
  await expect(page.getByRole("button", { name: /mobile|モバイル/iu })).toHaveCount(0);
  await page.getByRole("button", { name: /Desktop/u }).click();
  await expect(page).toHaveURL(url => url.pathname === "/desktop" || url.pathname === "/desktop/");
  expect(await page.evaluate(() => localStorage.getItem("scriptorium:ui-mode"))).toBe("desktop");
  await page.evaluate(() => localStorage.setItem("scriptorium:ui-mode", "mobile"));
  await page.goto(new URL("/?store=legacy&lang=ja#writing", origin).href);
  await expect(page).toHaveURL(url => /^\/desktop\/?$/u.test(url.pathname) && url.search === "?lang=ja" && url.hash === "#writing");
});

test("revision history responses and errors stay bound to the scene that requested them", { tag: "@author-desktop" }, async ({ page, authorizeAuthor }) => {
  const { project, scene, second, author } = await createOAuthWritingFixture(authorizeAuthor, page);
  const aPast = "Aだけにある過去本文。";
  const aCurrent = "Aの現在本文。";
  const bPast = "Bだけにある過去本文。";
  const bCurrent = "Bの現在本文。";
  const sceneApi = `/api/v1/persistence/projects/${project.id}/documents`;
  await seedManuscriptRevisions(author, `${sceneApi}/${scene.id}`, [aPast, aCurrent]);
  await seedManuscriptRevisions(author, `${sceneApi}/${second.id}`, [bPast, bCurrent]);
  await page.reload();
  await authorizeAuthor("desktop", page, { continueCurrentPage: true });
  await expectMarkdown(page, aCurrent);

  const historyUrl = (url: URL) => url.pathname === `${sceneApi}/${scene.id}/revisions`;
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
  await expectMarkdown(page, aCurrent);
  await expect(page).toHaveURL(url => url.pathname === writingFixturePath("desktop", project, scene));
  await expect(page.locator(`.pg-outline-item[data-document-id="${scene.id}"] .pg-outline-document`)).toHaveAttribute("aria-current", "page");
  const initialResponse = page.waitForResponse((response) => historyUrl(new URL(response.url())));
  releaseInitial();
  await initialResponse;
  await expect(page.getByRole("region", { name: "Revision履歴", exact: true })).toHaveCount(0);
  await page.unroute(historyUrl);
  // The previous history entry is B; a failed history read must preserve A.
  const failedHistoryRead = page.waitForResponse(response => failedDocumentRoute(new URL(response.url())) && response.status() === 503);
  await page.goBack();
  await failedHistoryRead;
  await expect(page).toHaveURL(url => url.pathname === writingFixturePath("desktop", project, scene));
  await expect(editorAlert).toHaveText("対象の文書を開けませんでした。");
  await expectMarkdown(page, aCurrent);
  await expect(page.locator(`.pg-outline-item[data-document-id="${scene.id}"] .pg-outline-document`)).toHaveAttribute("aria-current", "page");
  await page.unroute(failedDocumentRoute);
  await openManuscriptScene(page, scene);
  await openRevisionHistory(page);
  await expect(page.getByRole("region", { name: "Revision履歴", exact: true }).getByRole("status")).toHaveCount(0);
});

test("revision history restarts a blocked page after a save on the same scene", { tag: "@author-desktop" }, async ({ page, authorizeAuthor }) => {
  test.setTimeout(90_000);
  const { project, scene, author } = await createOAuthWritingFixture(authorizeAuthor, page);
  const documentPath = `/api/v1/persistence/projects/${project.id}/documents/${scene.id}`;
  const current = await seedManuscriptRevisions(author, documentPath, Array.from({ length: 50 }, (_, index) => `Revision ${index + 2}.`));
  await authorizeAuthor("desktop", page, { path: writingFixturePath("desktop", project, scene) });
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
  await replaceManuscript(page, savedMarkdown);
  await expect.poll(async () => persistedMarkdown(author, project.id, scene.id)).toBe(savedMarkdown);
  await expect(page.getByRole("button", { name: "今すぐ保存", exact: true })).toBeDisabled();
  releasePage();
  await refreshStarted;
  await expect(history.locator("article")).toHaveCount(50);
  await expect(history).toContainText(savedMarkdown);
  await expect(history.getByRole("button", { name: "さらに古いRevisionを読む", exact: true })).toBeEnabled();
});

test("revision history pages tied PostgreSQL revisions through retry, navigation, and restore", async ({ page, authorizeAuthor }) => {
  test.setTimeout(120_000);
  const { project, scene, second, author } = await createOAuthWritingFixture(authorizeAuthor, page);
  const documentPath = `/api/v1/persistence/projects/${project.id}/documents/${scene.id}`;
  const historyUrl = (url: URL) => url.pathname === `${documentPath}/revisions`;
  const documentResponse = await author.fetch(documentPath);
  expect(documentResponse.ok()).toBe(true);
  let revision = (await documentResponse.json() as { revision: { id: string; markdown: string } }).revision;
  const initialRevision = revision;
  let revisionCount = 1;

  async function seedTo(count: number): Promise<void> {
    while (revisionCount < count) {
      const markdown = `Stored revision ${String(revisionCount + 1).padStart(3, "0")}.`;
      const response = await author.fetch(documentPath, {
        method: "PATCH",
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
    await authorizeAuthor("desktop", page, { path: writingFixturePath("desktop", project, scene) });
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
  await authorizeAuthor("desktop", page, { path: writingFixturePath("desktop", project, scene) });
  await expect(editor(page)).toContainText(revision.markdown);
  await openRevisionHistory(page);
  const narrowHistory = page.getByRole("region", { name: "Revision履歴", exact: true });
  const narrowNextPage = narrowHistory.getByRole("button", { name: "さらに古いRevisionを読む", exact: true });
  await expect(narrowNextPage).toBeVisible();
  await narrowNextPage.scrollIntoViewIfNeeded();
  const buttonBounds = await narrowNextPage.boundingBox();
  expect(buttonBounds).toBeTruthy();
  expect(buttonBounds!.x).toBeGreaterThanOrEqual(0);
  expect(buttonBounds!.x + buttonBounds!.width).toBeLessThanOrEqual(360);
  await narrowNextPage.click();
  await expect(narrowHistory.locator("article")).toHaveCount(100);
  await narrowHistory.getByRole("button", { name: "さらに古いRevisionを読む", exact: true }).click();
  await expect(narrowHistory.locator("article")).toHaveCount(150);
  const narrowIds = await narrowHistory.locator("article").evaluateAll((articles) => articles.map((article) => article.getAttribute("data-revision-id")));
  expect(new Set(narrowIds).size).toBe(150);
  const originalRevision = narrowHistory.locator(`article[data-revision-id="${initialRevision.id}"]`);
  await expect(originalRevision).toContainText("最初の本文。");
  await originalRevision.getByRole("button", { name: "このRevisionを新しいRevisionとして復元", exact: true }).click();
  await expect(editor(page)).toContainText("最初の本文。");
  await expect(page.getByRole("region", { name: "Revision履歴", exact: true })).toHaveCount(0);
  const restoredResponse = await author.fetch(documentPath);
  expect(restoredResponse.ok()).toBe(true);
  const restored = (await restoredResponse.json() as { document: { headRevisionId: string }; revision: { id: string; markdown: string } });
  expect(restored.revision.markdown).toBe(initialRevision.markdown);
  expect(restored.document.headRevisionId).toBe(restored.revision.id);
  expect(restored.revision.id).not.toBe(initialRevision.id);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 2)).toBe(true);
});

test("a failed Knowledge list does not block the initial document and can be retried in its panel", { tag: "@author-desktop" }, async ({ page, authorizeAuthor }) => {
  const author = await authorizeAuthor("desktop");
  const headers = { Origin: new URL(page.url()).origin };
  const createdProject = await author.fetch("/api/v1/persistence/projects", { method: "POST", headers, data: { title: `Knowledge failure ${crypto.randomUUID()}` } });
  expect(createdProject.status()).toBe(201);
  const { project } = await createdProject.json() as { project: { id: string } };
  const createdDocument = await author.fetch(`/api/v1/persistence/projects/${project.id}/documents`, {
    method: "POST",
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
  await authorizeAuthor("desktop", page, { path: `/desktop/projects/${project.id}` });
  await documentListResponse;
  await knowledgeRequestStarted;
  const knowledgeFailureResponse = page.waitForResponse((response) =>
    nodesUrl(new URL(response.url())) && response.status() === 503);
  releaseKnowledgeFailure();
  await knowledgeFailureResponse;

  await expect(page.locator(`.pg-document-list [data-document-id="${document.id}"]`)).toBeVisible();
  await expectMarkdown(page, "初期本文。");
  const draft = "Knowledge一覧が使えなくても編集して保存できる。";
  await replaceManuscript(page, draft);
  await expect.poll(() => persistedMarkdown(author, project.id, document.id)).toBe(draft);

  const toolbar = page.getByRole("toolbar", { name: "ワークスペース配置" });
  const panelMenu = toolbar.locator("details");
  if (!await panelMenu.evaluate((element) => (element as HTMLDetailsElement).open)) await panelMenu.locator("summary").click();
  await toolbar.getByRole("button", { name: "知識と根拠を表示", exact: true }).click();
  const knowledge = page.locator('[data-workspace-panel="inspector"] .pg-knowledge');
  await expect(knowledge.getByRole("alert")).toContainText("Knowledge一覧を利用できません。");
  await knowledge.getByRole("button", { name: "再試行", exact: true }).click();
  await expect(knowledge.getByRole("alert")).toHaveCount(0);
  await expectMarkdown(page, draft);
});

test("same-named scenes show their chapter in the Desktop writing header", async ({ page, authorizeAuthor }) => {
  const { project, author } = await createOAuthWritingFixture(authorizeAuthor, page);
  const origin = new URL(page.url()).origin;
  const add = async (data: { kind: "chapter" | "scene"; title: string; orderKey: string; parentId?: string }) => {
    const response = await author.fetch(`/api/v1/persistence/projects/${project.id}/documents`, {
      method: "POST",
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

  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 844 });
    const context = page.locator(".pg-editor-heading .eyebrow");
    for (const [document, chapter] of [[writing, "第三章"], [source, "第一章"]] as const) {
      await authorizeAuthor("desktop", page, { path: writingFixturePath("desktop", project, document) });
      await expect(editor(page)).toBeVisible();
      await expect(context).toBeVisible();
      await expect(context).toHaveText(`${chapter} / ${project.title}`);
    }
  }
});

test("Desktop Knowledge write failures preserve the proposed name for retry", async ({ page, authorizeAuthor }) => {
  const { project } = await createOAuthWritingFixture(authorizeAuthor, page);
  const failure = "Knowledge候補を保存できませんでした。";
  await page.route(`**/api/v1/persistence/projects/${project.id}/nodes/*`, async (route) => {
    if (route.request().method() === "PUT") {
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: failure }) });
      return;
    }
    await route.continue();
  });

  const toolbar = page.getByRole("toolbar", { name: "ワークスペース配置" });
  const panels = toolbar.locator("details");
  if (!await panels.evaluate(element => (element as HTMLDetailsElement).open)) await panels.locator("summary").click();
  await toolbar.getByRole("button", { name: "知識と根拠を表示", exact: true }).click();
  const knowledge = page.locator('[data-workspace-panel="inspector"] .pg-knowledge');
  await knowledge.locator(".pg-knowledge-tools > summary").click();
  const name = knowledge.getByLabel("Knowledge候補を追加");
  await name.fill("失敗する候補");
  await knowledge.getByRole("button", { name: "候補を保存", exact: true }).click();
  await expect(knowledge.getByRole("alert")).toHaveText(failure);
  await expect(name).toHaveValue("失敗する候補");
  await page.unroute(`**/api/v1/persistence/projects/${project.id}/nodes/*`);
  await knowledge.getByRole("button", { name: "候補を保存", exact: true }).click();
  await expect(knowledge.getByRole("alert")).toHaveCount(0);
  await expect(name).toHaveValue("");
});

test("Desktop keeps its breadcrumb and console navigation usable at 320 CSS pixels", async ({ page, authorizeAuthor }) => {
  const title = "320pxでも切れずに参照できる長い作品名".repeat(4);
  await createOAuthWritingFixture(authorizeAuthor, page, "desktop", title);
  const consoleButton = page.getByRole("button", { name: "管理コンソール", exact: true });
  for (const width of [320, 640, 1280, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await expect(page.locator(".st-studio-breadcrumb strong")).toHaveText(title);
    await expect(consoleButton).toBeInViewport();
    await expect(page.getByRole("button", { name: /モバイル/u })).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 2)).toBe(true);
  }
  await consoleButton.focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(url => url.pathname === "/console");
});

test("recovery retry after pagehide retains its exact PostgreSQL draft", { tag: "@author-desktop" }, async ({ page, authorizeAuthor }) => {
  const { project, scene, author } = await createOAuthWritingFixture(authorizeAuthor, page);
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
    const response = await author.fetch(`/api/v1/persistence/projects/${project.id}/documents/${scene.id}`);
    return response.ok() ? ((await response.json()) as { revision: { markdown: string } }).revision.markdown : "";
  }).toBe(text);
  await expectServerSaved(page);
});

test("Desktop preserves the saved Japanese manuscript through reading, editing and reload", async ({ page, authorizeAuthor }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const { project, scene, author } = await createOAuthWritingFixture(authorizeAuthor, page, "desktop", undefined, "");
  const text = "東京《とうきょう》へ向かう。\n日本語😀の本文。";
  await editor(page).click();
  await page.keyboard.insertText(text);
  await expectMarkdown(page, text);
  // "Saved" can reflect the previous revision. The reader must open only
  // after this exact manuscript is durable in PostgreSQL.
  await expect.poll(async () => {
    const response = await author.fetch(`/api/v1/persistence/projects/${project.id}/documents/${scene.id}`);
    return response.ok() ? ((await response.json()) as { revision: { markdown: string } }).revision.markdown : "";
  }).toBe(text);
  await page.getByRole("button", { name: "読む", exact: true }).click();
  await expect(page.getByRole("region", { name: "原稿の閲覧" })).toContainText("東京");
  await page.getByRole("button", { name: "編集へ戻る" }).click(); await expectMarkdown(page, text);
  await page.reload();
  await authorizeAuthor("desktop", page, { continueCurrentPage: true });
  await expectMarkdown(page, text);
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

test("Desktop reader keeps first-to-last Japanese paragraphs visible at narrow viewports and cancels touch gestures", async ({ page, browserName, authorizeAuthor }) => {
  for (const width of [320, 390]) {
    for (const direction of ["horizontal", "vertical"] as const) {
      await page.setViewportSize({ width, height: 844 });
      const text = Array.from({ length: 130 }, (_, index) => `第${index + 1}段落｜日本語の本文を読む。`).join("\n");
      await createOAuthWritingFixture(authorizeAuthor, page, "desktop", undefined, text);
      // The multi-panel Desktop workbench scrolls horizontally below 760px.
      // Read in one panel so the pager and its touch zones fit the viewport.
      const panels = page.getByRole("toolbar", { name: "ワークスペース配置" }).locator("details");
      await panels.locator("summary").click();
      await panels.getByRole("button", { name: "作品と構成を隠す", exact: true }).click();
      await panels.locator("summary").click();
      await page.getByRole("button", { name: "読む", exact: true }).click();
      const displayMenu = page.locator(".pg-editor-display-menu");
      if (!await displayMenu.evaluate((element) => (element as HTMLDetailsElement).open)) await displayMenu.locator("summary").click();
      await page.getByLabel("組方向").selectOption(direction);
      await displayMenu.locator("summary").click();
      await expect.poll(() => visibleReaderParagraphs(page)).toContainEqual(expect.stringContaining("第1段落"));

      const pager = page.locator(".reading-pager");
      await pager.scrollIntoViewIfNeeded();
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

test("profile-selected workspace panels remain discoverable in the PostgreSQL workspace", { tag: "@author-desktop" }, async ({ page, authorizeAuthor }) => {
  const { project, author } = await createOAuthWritingFixture(authorizeAuthor, page);
  const response = await author.fetch(`/api/projects/${project.id}/contributions`); expect(response.ok()).toBe(true);
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

test("UX canon keeps the manuscript visible and stable through PostgreSQL save responses", { tag: "@author-desktop" }, async ({ page, authorizeAuthor }) => {
  await createOAuthWritingFixture(authorizeAuthor, page); await editor(page).evaluate((element) => { element.dataset.originalEditor = "retained"; });
  await replaceManuscript(page, "保存応答でも選択と同じエディタを保持する。");
  await expectServerSaved(page);
  await expect(editor(page)).toHaveAttribute("data-original-editor", "retained");
  await editor(page).press("Control+A");
  await page.locator(".pg-editor-command-menu > summary").click();
  await page.getByRole("button", { name: "選択範囲をText Anchorにする" }).click();
  await expect(page.locator(".pg-notice")).toContainText("Text Anchorを保存しました");
});

test("UX canon puts Japanese prose before optional chrome at narrow and wide Desktop widths", async ({ page, authorizeAuthor }) => {
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: 900 });
    const prose = "本文を中心に読める幅と余白を保つ。".repeat(20);
    await createOAuthWritingFixture(authorizeAuthor, page, "desktop", undefined, prose);
    await expectMarkdown(page, prose);
    const box = await editor(page).boundingBox(); expect(box).not.toBeNull(); expect(box!.width).toBeGreaterThan(200);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 2)).toBe(true);
  }
});

test("UX canon preserves focus and recovery when journal storage fails and returns", { tag: "@author-desktop" }, async ({ page, authorizeAuthor }) => {
  const { project, scene, author } = await createOAuthWritingFixture(authorizeAuthor, page); await denyWrites(page, true);
  const text = "保存領域が戻るまで失わない原稿。";
  await editor(page).click(); await editor(page).press("ControlOrMeta+a"); await page.keyboard.insertText(text); await expect(page.getByRole("alert").first()).toBeVisible(); await expectMarkdown(page, text);
  await denyWrites(page, false); await editor(page).press("End"); await editor(page).press("!");
  const expectedMarkdown = text + "!";
  await expect.poll(async () => {
    const drafts = await readPersistenceDrafts(page);
    if (drafts.some(draft => draft.documentId === scene.id && draft.markdown === expectedMarkdown)) return true;
    return await persistedMarkdown(author, project.id, scene.id) === expectedMarkdown;
  }).toBe(true);
  await expect(editor(page)).toContainText(text);
});

test("UX canon keeps Desktop usable with long Japanese titles and enlarged text", async ({ page, authorizeAuthor }) => {
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 900 });
    const prose = "大きな文字でも読み書きできる。".repeat(10);
    await createOAuthWritingFixture(authorizeAuthor, page, "desktop", "長い日本語の章題".repeat(8), prose);
    await expectMarkdown(page, prose);
    const displayMenu = page.locator(".pg-editor-display-menu");
    if (!await displayMenu.evaluate((element) => (element as HTMLDetailsElement).open)) await displayMenu.locator("summary").click();
    await page.getByLabel("原稿の文字サイズ").fill("24");
    await expect(editor(page)).toHaveCSS("font-size", "24px");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 2)).toBe(true);
    await expect(page.getByRole("button", { name: "今すぐ保存" })).toBeVisible();
  }
});

test("guarded console navigation preserves journaled text when PostgreSQL is unavailable", async ({ page, authorizeAuthor }) => {
  const { project, scene } = await createOAuthWritingFixture(authorizeAuthor, page);
  const documentPath = `/api/v1/persistence/projects/${project.id}/documents/${scene.id}`;
  await page.route(url => url.pathname === documentPath, route => route.request().method() === "PATCH"
    ? route.fulfill({ status: 503, json: { error: "Manuscript saving temporarily unavailable" } })
    : route.continue());
  const draft = "移動後にも回復できる現在の原稿。";
  await replaceManuscript(page, draft);
  await expect.poll(() => readPersistenceDrafts(page).then(records =>
    records.find(record => record.documentId === scene.id)?.markdown)).toBe(draft);
  const consoleButton = page.getByRole("button", { name: "管理コンソール", exact: true });
  await editor(page).dispatchEvent("compositionstart", { data: "にほんご" });
  await consoleButton.click();
  await expect(page.getByRole("alert").filter({ hasText: "管理コンソールへの移動を停止しました" }).first()).toBeVisible();
  await expectMarkdown(page, draft);
  await editor(page).dispatchEvent("compositionend", { data: "日本語" });
  await consoleButton.click();
  await expect(page).toHaveURL(url => url.pathname === "/console");
  await authorizeAuthor("desktop", page, { path: writingFixturePath("desktop", project, scene) });
  await expectMarkdown(page, draft);
});

test("optional terminology cancels work at pagehide and resumes at pageshow", { tag: "@author-desktop" }, async ({ page, authorizeAuthor }) => {
  test.skip(process.env.CODEXIA_PROFILE !== "full", "The terminology resolver is selected by the Full profile.");
  const { project } = await createOAuthWritingFixture(authorizeAuthor, page);
  const resolverPath = `/api/projects/${project.id}/actions/search.terms.resolve`;
  const manuscript = "Lantern Harborの用語を確認する。";
  const targetsManuscript = (request: Request) =>
    new URL(request.url()).pathname === resolverPath && request.postDataJSON()?.input?.text === manuscript;

  let releaseRequest!: () => void;
  const heldRequest = new Promise<void>((resolve) => { releaseRequest = resolve; });
  let blocked = false;
  await page.route((url) => url.pathname === resolverPath, async (route) => {
    if (!blocked && targetsManuscript(route.request())) {
      blocked = true;
      await heldRequest;
      // A cancelled request may already have expired at the browser boundary.
      await route.continue().catch(() => undefined);
      return;
    }
    await route.continue();
  });
  try {
    const started = page.waitForRequest(targetsManuscript);
    await replaceManuscript(page, manuscript);
    const runningRequest = await started;
    const cancelled = page.waitForEvent("requestfailed", (request) => request === runningRequest);
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true })));
    await cancelled;
    releaseRequest();

    const resumed = page.waitForResponse((response) => targetsManuscript(response.request()));
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })));
    expect((await resumed).ok()).toBe(true);
    await expectMarkdown(page, manuscript);
    await editor(page).press("End");
    await editor(page).press("!");
    await expectMarkdown(page, manuscript + "!");
  } finally {
    releaseRequest();
  }
});

test("[TEST-DATA-006-004] desktop author can download a portable work and import it without replacing the source", { tag: "@author-desktop" }, async ({ page, authorizeAuthor }) => {
  const { project, scene, author } = await createOAuthWritingFixture(authorizeAuthor, page);
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

  const [openExport] = await Promise.all([
    page.waitForEvent("download"),
    transfer.getByRole("button", { name: "離脱用 ZIP をダウンロード" }).click(),
  ]);
  expect(openExport.suggestedFilename()).toBe(`codexia-work-${project.id}.zip`);
  const zipPath = await openExport.path();
  expect(zipPath).toBeTruthy();
  expect((await readFile(zipPath!)).subarray(0, 4).toString("hex")).toBe("504b0304");
  await expect(transfer.getByText("ZIP の受信完了", { exact: true })).toBeVisible();

  await transfer.locator('input[type="file"]').setInputFiles({
    name: "portable-work.json", mimeType: "application/json", buffer: Buffer.from(json),
  });
  await expect(page.getByText("新しい作品としてJSONを取り込みました。", { exact: false })).toBeVisible();
  const currentProject = await page.getByLabel("作品", { exact: true }).inputValue();
  expect(currentProject).not.toBe(project.id);
  const imported = await author.fetch("/api/v1/persistence/projects/" + currentProject + "/documents");
  expect(imported.ok()).toBe(true);
  const body = await imported.json() as { documents: Array<{ id: string; title: string }> };
  expect(body.documents.some((item) => item.id === scene.id)).toBe(true);
  const original = await author.fetch("/api/v1/persistence/projects/" + project.id + "/documents/" + scene.id);
  expect(original.ok()).toBe(true);
  expect((await original.json() as { revision: { markdown: string } }).revision.markdown).toContain("最初の本文。");
});

test("leaving the work panel cancels an unfinished open ZIP download", { tag: "@author-desktop" }, async ({ page, authorizeAuthor }) => {
  const { project } = await createOAuthWritingFixture(authorizeAuthor, page);
  const transfer = page.locator("details").filter({ has: page.locator("summary", { hasText: "作品のエクスポート・インポート" }) });
  await transfer.locator("summary").click();
  const path = `/api/v1/persistence/projects/${project.id}/open-export`;
  let releaseRequest!: () => void;
  const heldRequest = new Promise<void>((resolve) => { releaseRequest = resolve; });
  await page.route(url => url.pathname === path, async route => {
    await heldRequest;
    await route.continue().catch(() => undefined);
  });
  let downloads = 0;
  page.on("download", () => { downloads += 1; });
  try {
    const started = page.waitForRequest(request => new URL(request.url()).pathname === path);
    await transfer.getByRole("button", { name: "離脱用 ZIP をダウンロード" }).click();
    const request = await started;
    const cancelled = page.waitForEvent("requestfailed", candidate => candidate === request);
    const panels = page.getByRole("toolbar", { name: "ワークスペース配置" }).locator("details");
    await panels.locator("summary").click();
    await panels.getByRole("button", { name: "作品と構成を隠す", exact: true }).click();
    await expect(transfer).toHaveCount(0);
    await cancelled;
    releaseRequest();
    await expect(panels.getByRole("button", { name: "作品と構成", exact: true })).toBeVisible();
    await panels.getByRole("button", { name: "作品と構成", exact: true }).click();
    await transfer.locator("summary").click();
    await expect(transfer.getByText("ZIP の受信を中止しました。", { exact: true })).toBeVisible();
    await expect(transfer.getByRole("button", { name: "離脱用 ZIP をダウンロード" })).toBeEnabled();
    expect(downloads).toBe(0);
  } finally {
    releaseRequest();
  }
});

test("keeps the manuscript near its scene title with one concise protection status", async ({ page, authorizeAuthor }) => {
  const { project, scene } = await createOAuthWritingFixture(authorizeAuthor, page);
  const measured: Array<{ mode: string; width: number; height: number; top: number; protectionCount: number; pageWidth: number }> = [];
  for (const sample of [
    { mode: "desktop" as const, width: 1440, height: 900 },
    { mode: "desktop" as const, width: 1024, height: 768 },
  ]) {
    await page.setViewportSize({ width: sample.width, height: sample.height });
    await authorizeAuthor("desktop", page, { path: writingFixturePath("desktop", project, scene) });
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
        visibleProtection: [...document.querySelectorAll(".pg-save-state")]
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
    const target = sample.height / 3;
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

test("journal writes do not spam live save status while a server receipt remains exact", async ({ page, authorizeAuthor }) => {
  const { project, scene, author } = await createOAuthWritingFixture(authorizeAuthor, page, "desktop", undefined, "");
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
  await editor(page).pressSequentially("abcdefgh", { delay: 140 });
  await expectMarkdown(page, "abcdefgh");
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
  expect(await persistedMarkdown(author, project.id, scene.id)).toBe("abcdefgh");
  await expect(details).toContainText("サーバー: PostgreSQLへの保存を確認しました");
  await expect(details.locator("summary")).toHaveText("作品に保存済み");
});

test("save details keep the confirmed work version separate from later device input", async ({ page, authorizeAuthor }) => {
  const initial = "A。作品に保存した文。";
  const firstAddition = "\nB。先に送信した文。";
  const secondAddition = "\nC。その後に入力した文。";
  const { project, scene, author } = await createOAuthWritingFixture(authorizeAuthor, page, "desktop", undefined, initial);
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
    await expectMarkdown(page, initial);
    await appendManuscript(page, firstAddition);
    await expectMarkdown(page, initial + firstAddition);
    await expect.poll(() => requests).toBe(1);
    await appendManuscript(page, secondAddition);
    await expectMarkdown(page, initial + firstAddition + secondAddition);
    await expect.poll(async () => (await readPersistenceDrafts(page))
      .find((draft) => draft.documentId === scene.id)?.markdown).toBe(initial + firstAddition + secondAddition);

    await expect(details).toContainText("現在の編集をこのブラウザーに記録しました");
    await expect(details).toContainText("送信後の入力は今回の保存に含まれません");
    await expect(details.locator("summary")).toHaveAttribute("aria-live", "off");
    await expect.poll(() => persistedMarkdown(author, project.id, scene.id)).toBe(initial);

    releaseFirst();
    await expect.poll(() => persistedMarkdown(author, project.id, scene.id)).toBe(initial + firstAddition);
    await expect(details).toContainText("直前に確認した版は作品に保存されています");
    await expect(details.locator("summary")).not.toHaveText("作品に保存済み");

    releaseSecond();
    await expect.poll(() => persistedMarkdown(author, project.id, scene.id)).toBe(initial + firstAddition + secondAddition);
    await expect(details.locator("summary")).toHaveText("作品に保存済み");
  } finally {
    releaseFirst();
    releaseSecond();
  }
});
