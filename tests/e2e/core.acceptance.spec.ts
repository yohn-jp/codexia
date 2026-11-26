import type { Page, Response } from "@playwright/test";
import type { ChangeOperation } from "@codexia/contracts";
import type { ChangeSet } from "@codexia/persistence-contracts";
import { createPostgresPersistence } from "@codexia/persistence-postgres";
import { expect, test, type AuthorApiFetch, type AuthorizeAuthor } from "./author-oauth-fixture";
import { preparedAuthorTest } from "./prepared-author-session";
import { createHash, randomUUID } from "node:crypto";
import { text as readStreamText } from "node:stream/consumers";
import { CoreStore } from "../../packages/core/src/index.js";
import { expectDeviceDraft, expectNoUnsavedDeviceChanges, expectServerSaved, manuscriptEditor as editor, readManuscriptMarkdown, openRevisionHistory } from "./postgres-fixture";

// Share the same worker build for opted-in and ordinary author scenarios.
test.use({ preparedAuthorEntries: true });
preparedAuthorTest.use({ preparedAuthorEntries: true });

const rootPath = "/api/v1/persistence/projects";
interface Draft { key: string; projectId: string; documentId: string; authorScope: string; markdown: string; generation: number; baseRevisionId: string; baseMarkdown: string; pendingSave?: { markdown: string }; version: number; updatedAt: number }
interface Read { document: { id: string; title: string; headRevisionId: string }; revision: { id: string; markdown: string } }
interface Fixture { projectId: string; one: Read; two: Read; fetch: AuthorApiFetch; authorizeAuthor: AuthorizeAuthor }
const documentPath = (fixture: Fixture, documentId = fixture.one.document.id) => `${rootPath}/${fixture.projectId}/documents/${documentId}`;
async function editorMarkdown(page: Page): Promise<string> {
  return (await readManuscriptMarkdown(page)).replace(/\n+$/u, "");
}
async function expectEditor(page: Page, markdown: string): Promise<void> {
  await expect.poll(() => editorMarkdown(page)).toBe(markdown.replace(/\n+$/u, ""));
}
async function pauseAutosaveClock(page: Page): Promise<void> {
  const startTime = Date.now();
  await page.clock.install({ time: startTime });
  // The browser clock runs between install and pause, including on a busy CI worker.
  await page.clock.pauseAt(startTime + 60_000);
}

async function replaceEditor(page: Page, markdown: string): Promise<void> {
  await editor(page).click();
  await editor(page).press("ControlOrMeta+a");
  await page.keyboard.insertText(markdown);
}

async function fixture(page: Page, authorizeAuthor: AuthorizeAuthor): Promise<Fixture> {
  const author = await authorizeAuthor("desktop", undefined, { apiSetupOnly: true });
  const projectResponse = await author.fetch(rootPath, { method: "POST", data: { title: `Core acceptance ${randomUUID()}` } });
  expect(projectResponse.status()).toBe(201);
  const { project } = await projectResponse.json() as { project: { id: string } };
  const createDocument = async (title: string, orderKey: string): Promise<Read> => {
    const response = await author.fetch(`${rootPath}/${project.id}/documents`, { method: "POST", headers: { "Idempotency-Key": randomUUID() }, data: { title, kind: "scene", orderKey, markdown: `# ${title}\n\nInitial ${title} text.\n` } });
    expect(response.status()).toBe(201);
    return response.json() as Promise<Read>;
  };
  const one = await createDocument("Scene One", "a");
  const two = await createDocument("Scene Two", "b");
  await authorizeAuthor("desktop", page, { path: `/desktop/projects/${project.id}/scenes/${one.document.id}` });
  await expect(page.getByRole("heading", { name: "Database workspace" })).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/desktop/projects/${project.id}/scenes/${one.document.id}`));
  await expectEditor(page, one.revision.markdown);
  return { projectId: project.id, one, two, fetch: author.fetch, authorizeAuthor };
}

async function read(f: Fixture, documentId = f.one.document.id): Promise<Read> {
  const response = await f.fetch(documentPath(f, documentId));
  expect(response.ok()).toBe(true);
  return response.json() as Promise<Read>;
}
async function replace(f: Fixture, markdown: string, base?: Read): Promise<Read> {
  const current = base ?? await read(f);
  const response = await f.fetch(documentPath(f), { method: "PATCH", headers: { "Idempotency-Key": randomUUID(), "X-Client-Id": "acceptance-external" }, data: { baseRevisionId: current.revision.id, changes: [{ fromUtf16: 0, toUtf16: current.revision.markdown.length, insert: markdown }], resultingSha256: createHash("sha256").update(markdown).digest("hex"), clientId: "acceptance-external" } });
  expect(response.status()).toBe(200);
  return response.json() as Promise<Read>;
}
async function drafts(page: Page, store = "persistenceDrafts"): Promise<Draft[]> {
  return page.evaluate(async (storeName) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open("scriptorium-recovery"); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    try { return await new Promise<Draft[]>((resolve, reject) => { const request = database.transaction(storeName).objectStore(storeName).getAll(); request.onsuccess = () => resolve(request.result as Draft[]); request.onerror = () => reject(request.error); }); }
    finally { database.close(); }
  }, store);
}
async function writeRecords(page: Page, records: unknown[], store = "persistenceDrafts"): Promise<void> {
  await page.evaluate(async ({ records, store }) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open("scriptorium-recovery"); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    try { await new Promise<void>((resolve, reject) => { const tx = database.transaction(store, "readwrite"); for (const record of records) tx.objectStore(store).put(record); tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); }); }
    finally { database.close(); }
  }, { records, store });
}
async function saved(page: Page, f: Fixture, text: string): Promise<void> {
  await expect.poll(async () => (await read(f)).revision.markdown).toBe(text);
  await expectServerSaved(page);
}
async function reopen(page: Page, f: Fixture): Promise<void> {
  await f.authorizeAuthor("desktop", page, { path: `/desktop/projects/${f.projectId}/scenes/${f.one.document.id}` });
  await expect(page).toHaveURL(new RegExp(`/desktop/projects/${f.projectId}/scenes/${f.one.document.id}`));
  await expect(editor(page)).toBeVisible();
}
async function holdSaves(page: Page, f: Fixture): Promise<{ seen: Promise<void>; release(): void }> {
  let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
  let observed!: () => void; const seen = new Promise<void>((resolve) => { observed = resolve; });
  await page.route(`**${documentPath(f)}`, async (route) => { if (route.request().method() !== "PATCH") return route.continue(); observed(); await gate; await route.continue(); });
  return { seen, release };
}
async function scratch(page: Page): Promise<void> { await page.locator(".scratch-panel summary").click(); }
const memo = (page: Page) => page.getByLabel("本文に含まれないメモ");
const image = (page: Page) => page.getByLabel("スクラッチ画像を添付");
const png = { name: "capture.png", mimeType: "image/png", buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5RkAAAAASUVORK5CYII=", "base64") };
async function scratchRecords(page: Page): Promise<Array<{ key: string; text: string }>> { return drafts(page, "pgScratch") as unknown as Promise<Array<{ key: string; text: string }>>; }
async function scratchPayloads(page: Page): Promise<Array<{ key: string; scratchKey: string; kind: string; id: string; value: string }>> { return drafts(page, "pgScratchPayloads") as unknown as Promise<Array<{ key: string; scratchKey: string; kind: string; id: string; value: string }>>; }

preparedAuthorTest("scoped CSS preserves desktop pseudo elements under reduced motion", async ({ page, authorizeAuthor }) => {
  await fixture(page, authorizeAuthor);
  const wordmark = page.locator(".st-studio-shell .st-studio-wordmark");
  await expect(wordmark).toBeVisible();
  await page.emulateMedia({ reducedMotion: "reduce" });
  const durations = await wordmark.evaluate((element) => {
    const seconds = (value: string) => Number.parseFloat(value) / (value.endsWith("ms") ? 1000 : 1);
    return ["::before", "::after"].map((pseudo) => seconds(getComputedStyle(element, pseudo).animationDuration));
  });
  for (const duration of durations) expect(duration).toBeCloseTo(0.00001, 8);
  await page.emulateMedia({ reducedMotion: "no-preference" });
});

test("creation actions reveal and focus Outline from the Review workspace", async ({ page, authorizeAuthor }) => {
  let createdProject = false;
  await page.route((url) => url.pathname === rootPath, async (route) => {
    if (!createdProject && route.request().method() === "GET") {
      return route.fulfill({ json: { projects: [], nextCursor: null } });
    }
    if (route.request().method() !== "POST") return route.continue();
    const response = await route.fetch();
    createdProject = response.ok();
    await route.fulfill({ response });
  });
  await authorizeAuthor("desktop", page);
  const outline = page.locator('[data-workspace-panel="outline"]');
  const review = page.getByRole("toolbar", { name: "ワークスペース配置" }).getByRole("button", { name: "レビュー", exact: true });

  await review.click();
  await expect(outline).toHaveCount(0);
  await page.getByRole("button", { name: "最初の作品を作成" }).click();
  const title = outline.getByLabel("作品名", { exact: true });
  await expect(title).toBeFocused();
  await title.fill(`Review creation ${randomUUID()}`);
  await outline.locator(".pg-library-create").getByRole("button", { name: "作成", exact: true }).click();

  const createDocument = page.getByRole("button", { name: "最初の文書を作成" });
  await expect(createDocument).toBeVisible();
  await review.click();
  await expect(outline).toHaveCount(0);
  await createDocument.click();
  await expect(outline.getByLabel("文書名", { exact: true })).toBeFocused();
});

// Each former Git lifecycle scenario below now exercises the corresponding PostgreSQL
// revision, browser recovery, or explicit removal boundary. No Git fixture is created.

for (const recoverPendingSave of [false, true]) {
  test(`a save protects a confirmed quote between separate editor changes${recoverPendingSave ? " after recovering a lost save response" : ""}`, async ({ page, authorizeAuthor }) => {
    const f = await fixture(page, authorizeAuthor);
    const { revision } = await replace(f, "A引用Z");
    const anchorPath = `${documentPath(f)}/anchors`;
    const anchor = await f.fetch(anchorPath, {
      method: "POST",
      data: { revisionId: revision.id, fromUtf16: 1, toUtf16: 3, status: "confirmed" },
    });
    expect(anchor.status()).toBe(201);
    await reopen(page, f);
    await expectEditor(page, "A引用Z");

    let releaseResponse!: () => void;
    const responseGate = new Promise<void>((resolve) => { releaseResponse = resolve; });
    if (recoverPendingSave) {
      let markCommitted!: () => void;
      const committed = new Promise<void>((resolve) => { markCommitted = resolve; });
      await page.route(`**${documentPath(f)}`, async (route) => {
        if (route.request().method() !== "PATCH") return route.continue();
        const response = await route.fetch();
        expect(response.ok()).toBe(true);
        markCommitted();
        await responseGate;
        await route.fulfill({ status: 504, json: { error: "応答を受信できませんでした", code: "TEST_GATEWAY_ERROR" } });
      });
      await editor(page).press("Home");
      await editor(page).press("Shift+ArrowRight");
      await page.keyboard.insertText("P");
      await committed;
    }

    await editor(page).press("Home");
    await editor(page).press("Shift+ArrowRight");
    await page.keyboard.insertText("X");
    await editor(page).press("End");
    await editor(page).press("Shift+ArrowLeft");
    await page.keyboard.insertText("Y");
    if (recoverPendingSave) {
      await expect.poll(async () => (await drafts(page)).find((draft) => draft.documentId === f.one.document.id)?.markdown).toBe("X引用Y");
      releaseResponse();
      await expect(page.getByText("応答を受信できませんでした", { exact: true }).first()).toBeVisible();
      await page.unroute(`**${documentPath(f)}`);
      await page.reload(); await authorizeAuthor("desktop", page, { continueCurrentPage: true });
    }
    await saved(page, f, "X引用Y");

    const response = await f.fetch(anchorPath);
    expect(response.ok()).toBe(true);
    expect((await response.json()).anchors).toMatchObject([
      { anchor: { fromUtf16: 1, toUtf16: 3, status: "confirmed" }, quote: "引用" },
    ]);
  });
}

test("appearance modes follow system preference initially and persist explicit light, dark, and paper choices", async ({ page, authorizeAuthor }) => {
  await page.emulateMedia({ colorScheme: "light" }); await authorizeAuthor("desktop");
  await expect(page.locator("html")).toHaveAttribute("data-zp-theme", "light");
  for (const theme of ["dark", "paper", "light"]) {
    await page.getByLabel("外観").selectOption(theme);
    await expect(page.locator("html")).toHaveAttribute("data-zp-theme", theme);
    await page.reload(); await authorizeAuthor("desktop", page, { continueCurrentPage: true }); await expect(page.getByLabel("外観")).toHaveValue(theme);
  }
});

preparedAuthorTest("revision history keeps immutable content through a foreground refresh", async ({ page, authorizeAuthor }) => {
  const f = await fixture(page, authorizeAuthor); const text = "Saved immutable version.";
  await editor(page).click();
  await editor(page).press("ControlOrMeta+a");
  await page.keyboard.insertText(text);
  await saved(page, f, text);
  await openRevisionHistory(page);
  await expect(page.getByRole("region", { name: "Revision履歴" })).toContainText(f.one.revision.markdown.trim());
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect(page.getByRole("region", { name: "Revision履歴" })).toContainText(text);
  expect((await f.fetch(`${documentPath(f)}?revision=${f.one.revision.id}`)).ok()).toBe(true);
});

preparedAuthorTest("a confirmed external revision keeps its single ellipsis in the open editor", async ({ page, authorizeAuthor }) => {
  const f = await fixture(page, authorizeAuthor);
  const confirmed = "以前…の原稿";
  const external = await replace(f, confirmed);
  expect(external.revision.markdown).toBe(confirmed);
  const latest = await replace(f, "編集後の原稿", external);
  await reopen(page, f);
  await expectEditor(page, latest.revision.markdown);

  await openRevisionHistory(page);
  const revision = page.getByRole("region", { name: "Revision履歴" }).locator(`article[data-revision-id="${external.revision.id}"]`);
  await revision.getByRole("button", { name: "このRevisionを新しいRevisionとして復元" }).click();
  await expectEditor(page, confirmed);
  await expectNoUnsavedDeviceChanges(page);
  const restored = (await read(f)).revision;
  expect(restored.markdown).toBe(confirmed);
  expect(restored.id).not.toBe(external.revision.id);
});

test("same-origin stale tabs cannot replace an equal-generation journal draft", async ({ page, context, authorizeAuthor }) => {
  const f = await fixture(page, authorizeAuthor); const gate = await holdSaves(page, f);
  const second = await context.newPage();
  await authorizeAuthor("desktop", second, { path: new URL(page.url()).pathname });
  await expectEditor(second, f.one.revision.markdown);
  try {
    await replaceEditor(page, "First tab protected draft.");
    await expect.poll(async () => (await drafts(page)).some((d) => d.markdown === "First tab protected draft.")).toBe(true);
    await replaceEditor(second, "Stale tab different draft.");
    await expect(second.getByRole("alert")).toContainText("別タブ");
    expect((await drafts(page)).find((d) => d.documentId === f.one.document.id)?.markdown).toBe("First tab protected draft.");
    // The stale tab's manuscript surface is read-only, including formatting
    // toolbar actions; the recovery draft must not be mutated.
    const staleEditor = editor(second);
    await staleEditor.focus();
    await second.keyboard.type("x");
    await expect(staleEditor).toHaveText("Stale tab different draft.");
    const displayMenu = second.locator(".pg-editor-display-menu");
    if (!await displayMenu.evaluate((element) => (element as HTMLDetailsElement).open)) await displayMenu.locator("summary").click();
    const staleSymbol = displayMenu.getByRole("button", { name: "三点リーダーを挿入" });
    await staleSymbol.evaluate((button: HTMLButtonElement) => button.click());
    await expectEditor(second, "Stale tab different draft.");
    await expect(staleSymbol).toBeDisabled();
    expect((await drafts(page)).find((d) => d.documentId === f.one.document.id)?.markdown).toBe("First tab protected draft.");
  } finally { gate.release(); await second.close(); }
});

preparedAuthorTest("IME composition blocks navigation while coalesced editor state stays current for print and history", async ({ page, authorizeAuthor }) => {
  const f = await fixture(page, authorizeAuthor);
  await editor(page).evaluate((element) => element.dispatchEvent(new CompositionEvent("compositionstart", { data: "にほんご", bubbles: true })));
  const blockedUnload = await page.evaluate(() => {
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  });
  expect(blockedUnload).toBe(true);
  await editor(page).evaluate((element) => element.dispatchEvent(new CompositionEvent("compositionend", { data: "", bubbles: true })));
  await page.evaluate(() => {
    window.print = () => {
      document.documentElement.dataset.printedManuscript = document.querySelector(".pg-print-manuscript")?.textContent ?? "";
    };
  });
  const text = "Printed from the newest editor input."; await replaceEditor(page, text);
  await editor(page).evaluate((element) => element.dispatchEvent(new CompositionEvent("compositionstart", { data: "にほんご", bubbles: true })));
  await page.locator(".pg-document-list").getByRole("treeitem", { name: "Scene Two シーン", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Scene One", exact: true })).toBeVisible();
  const editorAlert = page.locator(".pg-editor-column").getByRole("alert");
  await expect(editorAlert).toContainText("日本語入力の変換が完了していません");
  await expect(editorAlert).toHaveCount(1);
  await expect(page.getByRole("alert")).toHaveCount(1);
  await editor(page).evaluate((element) => element.dispatchEvent(new CompositionEvent("compositionend", { data: "日本語", bubbles: true })));
  const composedText = `${text} 日本語入力`;
  await replaceEditor(page, composedText);
  await page.locator(".pg-editor-command-menu > summary").click();
  await page.getByRole("button", { name: "印刷", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-printed-manuscript", composedText);
  await page.emulateMedia({ media: "print" });
  await expect(page.locator(".pg-print-manuscript")).toBeVisible();
  await expect(editor(page)).toBeHidden();
  await expect(page.locator(".pg-editor-command-menu")).toBeHidden();
  await page.emulateMedia({ media: "screen" });
  await saved(page, f, composedText); await openRevisionHistory(page);
  await expect(page.getByRole("region", { name: "Revision履歴" })).toContainText(composedText);
});

test("exact revision acknowledgement removes its draft without reviving deleted recovery on reload", async ({ page, authorizeAuthor }) => {
  const f = await fixture(page, authorizeAuthor); const text = "Acknowledged durable draft.";
  await replaceEditor(page, text);
  await expectEditor(page, text);
  await saved(page, f, text);
  await expect.poll(async () => (await drafts(page)).filter((d) => d.documentId === f.one.document.id)).toEqual([]);
  await reopen(page, f); await expectEditor(page, text);
  expect((await drafts(page)).filter((d) => d.documentId === f.one.document.id)).toEqual([]);
});

test("a committed save with a lost response is reconciled after reload with the same operation identity", async ({ page, authorizeAuthor }) => {
  const f = await fixture(page, authorizeAuthor);
  const text = "Committed before its response was lost.";
  const before = await read(f);
  let resolveLost!: () => void;
  const lost = new Promise<void>((resolve) => { resolveLost = resolve; });
  const requests: Array<{ idempotencyKey: string | undefined; clientId: string | undefined; body: string | null }> = [];
  await page.route(`**${documentPath(f)}`, async (route) => {
    if (route.request().method() !== "PATCH") return route.continue();
    requests.push({
      idempotencyKey: route.request().headers()["idempotency-key"],
      clientId: route.request().headers()["x-client-id"],
      body: route.request().postData(),
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

  await replaceEditor(page, text);
  await lost;
  await expect.poll(async () => (await drafts(page)).find((draft) => draft.documentId === f.one.document.id)?.pendingSave).toMatchObject({ markdown: text });
  await page.reload(); await authorizeAuthor("desktop", page, { continueCurrentPage: true });
  await expectEditor(page, text);
  await expect.poll(() => requests.length).toBe(2);
  await saved(page, f, text);
  expect(requests[1]).toEqual(requests[0]);
  const after = await read(f);
  expect(after.revision.id).not.toBe(before.revision.id);
  expect((await drafts(page)).filter((draft) => draft.documentId === f.one.document.id)).toEqual([]);
});

test("replaying a saved operation after a newer remote revision shows the current head", async ({ page, authorizeAuthor }) => {
  const f = await fixture(page, authorizeAuthor);
  const submitted = "B committed before its response was lost.";
  const remote = "Remote D became the current head.";
  const requests: Array<{ idempotencyKey: string | undefined; clientId: string | undefined; body: string | null }> = [];
  let resolveLost!: () => void;
  const lost = new Promise<void>((resolve) => { resolveLost = resolve; });
  await page.route(`**${documentPath(f)}`, async (route) => {
    if (route.request().method() !== "PATCH") return route.continue();
    requests.push({ idempotencyKey: route.request().headers()["idempotency-key"], clientId: route.request().headers()["x-client-id"], body: route.request().postData() });
    if (requests.length === 1) {
      const committed = await route.fetch();
      expect(committed.ok()).toBe(true);
      await route.abort();
      resolveLost();
      return;
    }
    const replay = await route.fetch();
    expect(replay.ok()).toBe(true);
    expect((await replay.json() as Read).revision.markdown).toBe(submitted);
    await route.fulfill({ response: replay });
  });

  await replaceEditor(page, submitted);
  await lost;
  await replace(f, remote);
  await page.reload(); await authorizeAuthor("desktop", page, { continueCurrentPage: true });
  await expectEditor(page, remote);
  await expectServerSaved(page);
  expect(requests).toHaveLength(2);
  expect(requests[1]).toEqual(requests[0]);
  const latest = await read(f);
  expect(latest.revision.markdown).toBe(remote);
  expect((await drafts(page)).filter((draft) => draft.documentId === f.one.document.id)).toEqual([]);
});

test("a lost save response survives newer input, reloads, and rebases the newer draft after acknowledgement", async ({ page, authorizeAuthor }) => {
  const f = await fixture(page, authorizeAuthor);
  const submitted = "Submitted B before newer input.";
  const newer = "Newer C entered while B was saving.";
  const before = await read(f);
  let committed!: () => void;
  let release!: () => void;
  let lost!: () => void;
  const committedPromise = new Promise<void>((resolve) => { committed = resolve; });
  const responseGate = new Promise<void>((resolve) => { release = resolve; });
  const lostPromise = new Promise<void>((resolve) => { lost = resolve; });
  const requests: Array<{ idempotencyKey: string | undefined; clientId: string | undefined; body: string | null }> = [];
  await page.route(`**${documentPath(f)}`, async (route) => {
    if (route.request().method() !== "PATCH") return route.continue();
    requests.push({
      idempotencyKey: route.request().headers()["idempotency-key"],
      clientId: route.request().headers()["x-client-id"],
      body: route.request().postData(),
    });
    if (requests.length === 1) {
      const committedResponse = await route.fetch();
      expect(committedResponse.ok()).toBe(true);
      committed();
      await responseGate;
      await route.abort();
      lost();
      return;
    }
    await route.continue();
  });

  await replaceEditor(page, submitted);
  await committedPromise;
  await replaceEditor(page, newer);
  await expect.poll(async () => {
    const draft = (await drafts(page)).find((entry) => entry.documentId === f.one.document.id);
    return { markdown: draft?.markdown, pending: draft?.pendingSave?.markdown };
  }).toEqual({ markdown: newer, pending: submitted });
  release();
  await lostPromise;
  await page.reload(); await authorizeAuthor("desktop", page, { continueCurrentPage: true });
  await expectEditor(page, newer);
  await saved(page, f, newer);
  expect(requests).toHaveLength(3);
  expect(requests[1]).toEqual(requests[0]);
  expect(requests[2]?.idempotencyKey).not.toBe(requests[0]?.idempotencyKey);
  expect(requests[2]?.body).not.toBe(requests[0]?.body);
  const after = await read(f);
  expect(after.revision.markdown).toBe(newer);
  const revisionResponse = await f.fetch(`${documentPath(f)}/revisions?limit=50`);
  expect(revisionResponse.ok()).toBe(true);
  const revisionPage = await revisionResponse.json() as { revisions: Array<{ id: string; markdown: string }> };
  expect(revisionPage.revisions).toHaveLength(3);
  expect(revisionPage.revisions.map((revision) => revision.markdown)).toContain(submitted);
  expect(revisionPage.revisions.map((revision) => revision.markdown)).toContain(newer);
  expect((await drafts(page)).filter((draft) => draft.documentId === f.one.document.id)).toEqual([]);
  expect(after.revision.id).not.toBe(before.revision.id);
});

test("a newer draft stays protected when a replayed save is already superseded remotely", async ({ page, authorizeAuthor }) => {
  const f = await fixture(page, authorizeAuthor);
  const submitted = "B committed before its response was lost.";
  const newer = "Newer local C stays recoverable.";
  const remote = "Remote D became the current head.";
  let committed!: () => void;
  let release!: () => void;
  let lost!: () => void;
  const committedPromise = new Promise<void>((resolve) => { committed = resolve; });
  const responseGate = new Promise<void>((resolve) => { release = resolve; });
  const lostPromise = new Promise<void>((resolve) => { lost = resolve; });
  const requests: Array<{ idempotencyKey: string | undefined; clientId: string | undefined; body: string | null }> = [];
  await page.route(`**${documentPath(f)}`, async (route) => {
    if (route.request().method() !== "PATCH") return route.continue();
    requests.push({ idempotencyKey: route.request().headers()["idempotency-key"], clientId: route.request().headers()["x-client-id"], body: route.request().postData() });
    if (requests.length === 1) {
      const committedResponse = await route.fetch();
      expect(committedResponse.ok()).toBe(true);
      committed();
      await responseGate;
      await route.abort();
      lost();
      return;
    }
    const replay = await route.fetch();
    expect(replay.ok()).toBe(true);
    expect((await replay.json() as Read).revision.markdown).toBe(submitted);
    await route.fulfill({ response: replay });
  });

  await replaceEditor(page, submitted);
  await committedPromise;
  await replaceEditor(page, newer);
  await expect.poll(async () => {
    const draft = (await drafts(page)).find((entry) => entry.documentId === f.one.document.id);
    return { markdown: draft?.markdown, pending: draft?.pendingSave?.markdown };
  }).toEqual({ markdown: newer, pending: submitted });
  await replace(f, remote);
  release();
  await lostPromise;
  await page.reload(); await authorizeAuthor("desktop", page, { continueCurrentPage: true });
  await expect(page.getByRole("heading", { name: "Revision競合" })).toBeVisible();
  await expectEditor(page, newer);
  await expect.poll(async () => (await drafts(page)).find((draft) => draft.documentId === f.one.document.id)?.pendingSave).toBeUndefined();
  expect(requests).toHaveLength(2);
  expect(requests[1]).toEqual(requests[0]);
  expect((await read(f)).revision.markdown).toBe(remote);
  const draft = (await drafts(page)).find((entry) => entry.documentId === f.one.document.id);
  expect(draft).toMatchObject({ markdown: newer, baseRevisionId: f.one.revision.id, baseMarkdown: f.one.revision.markdown });
});

test("undoing an autosave draft back to the saved revision removes only that draft and never sends it", async ({ page, authorizeAuthor }) => {
  const f = await fixture(page, authorizeAuthor);
  await pauseAutosaveClock(page);
  const savedMarkdown = f.one.revision.markdown;
  const patchBodies: string[] = [];
  await page.route(`**${documentPath(f)}`, async (route) => {
    if (route.request().method() === "PATCH") patchBodies.push(route.request().postData() ?? "");
    await route.continue();
  });

  await replaceEditor(page, "Temporary draft that must be undone.");
  await expect.poll(async () => (await drafts(page)).find((d) => d.documentId === f.one.document.id)?.markdown).toBe("Temporary draft that must be undone.");
  await expectDeviceDraft(page);
  await replaceEditor(page, savedMarkdown);
  await expectEditor(page, savedMarkdown);
  await expect.poll(async () => (await drafts(page)).filter((d) => d.documentId === f.one.document.id)).toEqual([]);
  await expectServerSaved(page);
  await expectNoUnsavedDeviceChanges(page);
  await editor(page).press("Control+A");
  await page.locator(".pg-editor-command-menu > summary").click();
  await expect(page.getByRole("button", { name: "選択範囲をText Anchorにする" })).toBeEnabled();
  await page.locator(".pg-document-list").getByRole("treeitem", { name: "Scene Two シーン", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Scene Two", exact: true })).toBeVisible();
  await page.locator(".pg-document-list").getByRole("treeitem", { name: "Scene One シーン", exact: true }).click();
  await expectEditor(page, savedMarkdown);
  await expect.poll(async () => (await drafts(page)).filter((d) => d.documentId === f.one.document.id)).toEqual([]);
  await page.clock.fastForward(1_100);
  expect(patchBodies).toEqual([]);
  await page.reload(); await authorizeAuthor("desktop", page, { continueCurrentPage: true });
  await expectEditor(page, savedMarkdown);
  expect((await drafts(page)).filter((d) => d.documentId === f.one.document.id)).toEqual([]);
  await page.clock.fastForward(1_100);
  expect(patchBodies).toEqual([]);
  expect((await read(f)).revision).toEqual(f.one.revision);
});

test("undo cleanup cannot remove a higher-generation draft written by another tab", async ({ page, context, authorizeAuthor }) => {
  const f = await fixture(page, authorizeAuthor);
  await pauseAutosaveClock(page);
  const savedMarkdown = f.one.revision.markdown;
  await replaceEditor(page, "First tab temporary draft.");
  await expect.poll(async () => (await drafts(page)).find((d) => d.documentId === f.one.document.id)?.markdown).toBe("First tab temporary draft.");

  // The Playwright clock belongs to the browser context, so the second
  // tab inherits it without advancing the first tab's pending autosave.
  const second = await context.newPage();
  await authorizeAuthor("desktop", second, { path: new URL(page.url()).pathname });
  await expectEditor(second, "First tab temporary draft.");
  await replaceEditor(second, "Newer second-tab draft.");
  await expect.poll(async () => (await drafts(second)).find((d) => d.documentId === f.one.document.id)?.markdown).toBe("Newer second-tab draft.");

  await replaceEditor(page, savedMarkdown);
  await expectEditor(page, savedMarkdown);
  await expect.poll(async () => (await drafts(page)).find((d) => d.documentId === f.one.document.id)?.markdown).toBe("Newer second-tab draft.");
  await expect(page.locator(".pg-save-state")).toContainText("別タブに下書きがあります");
  await second.close();
});

preparedAuthorTest("undo during an in-flight save preserves the request and saves the restored text afterward", async ({ page, authorizeAuthor }) => {
  const f = await fixture(page, authorizeAuthor);
  const savedMarkdown = f.one.revision.markdown;
  const gate = await holdSaves(page, f);
  try {
    await replaceEditor(page, "B sent before undo.");
    await gate.seen;
    await replaceEditor(page, savedMarkdown);
    await expect.poll(async () => (await drafts(page)).find((d) => d.documentId === f.one.document.id)?.markdown).toBe(savedMarkdown);
    gate.release();
    await saved(page, f, savedMarkdown);
    await expectEditor(page, savedMarkdown);
    await expect.poll(async () => (await drafts(page)).filter((d) => d.documentId === f.one.document.id)).toEqual([]);
  } finally { gate.release(); }
});

preparedAuthorTest("writing UI protects multiple document drafts separately from PostgreSQL revision durability", async ({ page, authorizeAuthor }) => {
  const f = await fixture(page, authorizeAuthor); const gate = await holdSaves(page, f);
  try {
    await replaceEditor(page, "Scene One protected draft.");
    await expectEditor(page, "Scene One protected draft.");
    // Establish the exact durable recovery record and an in-flight, unacknowledged
    // PostgreSQL save before switching documents.
    await expect.poll(async () => (await drafts(page)).some((d) => d.documentId === f.one.document.id && d.markdown === "Scene One protected draft.")).toBe(true);
    await gate.seen;
    await page.locator(".pg-document-list").getByRole("treeitem", { name: "Scene Two シーン", exact: true }).click();
    // The guarded selection is asynchronous: do not type until Scene Two owns
    // the mounted editor, otherwise the test edits Scene One again.
    await expect(page.getByRole("heading", { name: "Scene Two", exact: true })).toBeVisible();
    await replaceEditor(page, "Scene Two independent draft.");
    await expectEditor(page, "Scene Two independent draft.");
    await expect.poll(async () => {
      const records = await drafts(page);
      return records.find((entry) => entry.documentId === f.one.document.id)?.markdown
        ?? `Missing Scene One draft (present: ${records.map((entry) => entry.documentId).join(", ")})`;
    }).toBe("Scene One protected draft.");
    await page.locator(".pg-document-list").getByRole("treeitem", { name: "Scene One シーン", exact: true }).click();
    await expectEditor(page, "Scene One protected draft.");
  } finally { gate.release(); }
});

preparedAuthorTest("new typing survives an older in-flight PostgreSQL save and exact acknowledgement", async ({ page, authorizeAuthor }) => {
  const f = await fixture(page, authorizeAuthor); const gate = await holdSaves(page, f);
  try {
    expect((await drafts(page)).filter(draft => draft.documentId === f.one.document.id)).toEqual([]);
    await expectNoUnsavedDeviceChanges(page);
    await editor(page).fill("First generation awaiting acknowledgement."); await gate.seen;
    await editor(page).fill("Newer generation while save is in flight.");
    await expect.poll(async () => (await drafts(page)).some((d) => d.markdown === "Newer generation while save is in flight.")).toBe(true);
    await expectDeviceDraft(page);
    gate.release(); await saved(page, f, "Newer generation while save is in flight.");
    await expectEditor(page, "Newer generation while save is in flight.");
    await expect.poll(async () => (await drafts(page)).filter(draft => draft.documentId === f.one.document.id)).toEqual([]);
    await expectNoUnsavedDeviceChanges(page);
  } finally { gate.release(); }
});

test("new typing survives recovery against a newer PostgreSQL base revision", async ({ page, authorizeAuthor }) => {
  const f = await fixture(page, authorizeAuthor); const gate = await holdSaves(page, f);
  const writes: string[] = [];
  page.on("request", (request) => { if (request.method() === "PATCH" && request.url().includes(documentPath(f))) writes.push(request.url()); });
  try {
    await editor(page).fill("Recovered draft before competing revision."); await gate.seen;
    await replace(f, "Competing PostgreSQL revision.");
    await editor(page).fill("Newest input before conflict arrives."); gate.release();
    await expect(page.getByRole("heading", { name: "Revision競合" })).toBeVisible();
    await expectEditor(page, "Newest input before conflict arrives.");
    await expect.poll(async () => (await drafts(page)).find((draft) => draft.documentId === f.one.document.id)?.pendingSave).toBeUndefined();
    const writesBeforeReload = writes.length;
    await page.reload(); await authorizeAuthor("desktop", page, { continueCurrentPage: true });
    await expect(page.getByRole("heading", { name: "Revision競合" })).toBeVisible();
    await expectEditor(page, "Newest input before conflict arrives.");
    expect(writes).toHaveLength(writesBeforeReload);
    await page.getByRole("button", { name: "比較後、この回復Draftを最新版へ適用" }).click();
    await saved(page, f, "Newest input before conflict arrives.");
  } finally { gate.release(); }
});

test("browser recovery is author-scoped and foreign records remain untouched", async ({ page, authorizeAuthor }) => {
  const f = await fixture(page, authorizeAuthor); const foreign: Draft = { version: 1, key: JSON.stringify(["foreign-author", f.projectId, f.one.document.id]), projectId: f.projectId, documentId: f.one.document.id, authorScope: "foreign-author", baseRevisionId: f.one.revision.id, baseMarkdown: f.one.revision.markdown, markdown: "Foreign private draft.", generation: 100, updatedAt: Date.now() };
  await writeRecords(page, [foreign]); await reopen(page, f);
  await expect(editor(page)).not.toHaveText(foreign.markdown);
  expect((await drafts(page)).find((d) => d.key === foreign.key)).toEqual(foreign);
});

test("one malformed legacy key does not hide later recoverable PostgreSQL drafts", async ({ page, authorizeAuthor }) => {
  const f = await fixture(page, authorizeAuthor); const gate = await holdSaves(page, f);
  try {
    await editor(page).fill("Valid protected draft after malformed entry.");
    await expect.poll(async () => (await drafts(page)).some((d) => d.markdown === "Valid protected draft after malformed entry.")).toBe(true);
    await writeRecords(page, [{ key: "malformed-legacy-key", version: 0, markdown: "Untrusted legacy content" }]);
    await reopen(page, f); await expectEditor(page, "Valid protected draft after malformed entry.");
    expect((await drafts(page)).some((d) => d.key === "malformed-legacy-key")).toBe(true);
  } finally { gate.release(); }
});

async function submitProposal(f: Fixture): Promise<{ id: string; operation: ChangeOperation; generated: string }> {
  const databaseUrl = process.env.CODEXIA_E2E_DATABASE_URL;
  if (!databaseUrl) throw new Error("Browser acceptance requires its disposable PostgreSQL database");
  const persistence = createPostgresPersistence(databaseUrl);
  try {
    // Seed a real pending MCP proposal for author review. The OAuth MCP transport has separate API coverage.
    const store = new CoreStore({ persistence });
    const reader = await store.reader(f.projectId);
    const path = `documents/${f.one.document.id}.md`;
    const current = await reader.read(path);
    if (!current) throw new Error(`PostgreSQL snapshot omitted the document path ${path}`);
    const generated = `${current.content}\nMCP proposal requires explicit author approval.\n`;
    const operation: ChangeOperation = { id: `mcp-op-${randomUUID()}`, generation: 1, projectId: f.projectId, baseProjectVersion: reader.snapshot.projectVersion, effect: "manuscript", reads: [{ path, revision: current.revision }], writes: [{ path, revision: current.revision, content: generated }], message: "MCP acceptance proposal" };
    const id = `mcp-${randomUUID()}`;
    const stored = await store.propose(f.projectId, { id, snapshot: reader.snapshot, operations: [operation], source: "mcp" });
    expect(stored).toMatchObject({ id, source: "mcp" });
    return { id, operation, generated };
  } finally { await persistence.close(); }
}

test("external MCP proposals require owner approval before PostgreSQL application", async ({ page, authorizeAuthor }) => {
  const f = await fixture(page, authorizeAuthor); const proposal = await submitProposal(f);
  const before = await f.fetch(`/api/projects/${f.projectId}/proposals/${proposal.id}`);
  expect(await before.json()).toMatchObject({ state: "proposed", approvedOperationIds: [] });
  const denied = await f.fetch(`/api/projects/${f.projectId}/apply`, { method: "POST", data: proposal.operation }); expect(denied.ok()).toBe(false);
  expect((await read(f)).revision.id).toBe(f.one.revision.id);
  const approval = await f.fetch(`/api/projects/${f.projectId}/approvals`, { method: "POST", data: { proposalId: proposal.id, operationIds: [proposal.operation.id] } }); expect(approval.status()).toBe(204);
  const applied = await f.fetch(`/api/projects/${f.projectId}/apply`, { method: "POST", data: proposal.operation }); expect(applied.status()).toBe(201);
  expect((await read(f)).revision.markdown).toBe(proposal.generated);
  await reopen(page, f); await expectEditor(page, proposal.generated);
});

test("full MCP proposal payload and approval state survive Core process and cache loss", async ({ page, authorizeAuthor, authorServer }) => {
  const f = await fixture(page, authorizeAuthor); const proposal = await submitProposal(f);
  const path = `/api/projects/${f.projectId}/proposals/${proposal.id}`;
  const approval = await f.fetch(`/api/projects/${f.projectId}/approvals`, { method: "POST", data: { proposalId: proposal.id, operationIds: [proposal.operation.id] } });
  expect(approval.status()).toBe(204);
  const before = await (await f.fetch(path)).json();
  expect(before).toMatchObject({ state: "approved", approvedOperationIds: [proposal.operation.id] });
  await authorServer.restartApi();
  const after = await f.fetch(path); expect(after.ok()).toBe(true); expect(await after.json()).toEqual(before);
  expect((await read(f)).revision.id).toBe(f.one.revision.id);
  await reopen(page, f); await expectEditor(page, f.one.revision.markdown);
});

test("a PostgreSQL update during author approval keeps the conflicting editor draft visible", async ({ page, authorizeAuthor }) => {
  const f = await fixture(page, authorizeAuthor); const proposal = await submitProposal(f); const gate = await holdSaves(page, f);
  try {
    await replaceEditor(page, "Author input must survive rejected approval."); await gate.seen;
    await replace(f, "Another writer advanced the project.");
    const approval = await f.fetch(`/api/projects/${f.projectId}/approvals`, { method: "POST", data: { proposalId: proposal.id, operationIds: [proposal.operation.id] } }); expect(approval.status()).toBe(204);
    const applied = await f.fetch(`/api/projects/${f.projectId}/apply`, { method: "POST", data: proposal.operation }); expect(applied.status()).toBe(409);
    gate.release(); await expect(page.getByRole("heading", { name: "Revision競合" })).toBeVisible();
    await expectEditor(page, "Author input must survive rejected approval.");
    expect((await read(f)).revision.markdown).toBe("Another writer advanced the project.");
  } finally { gate.release(); }
});

preparedAuthorTest("IndexedDB quota failures remain visible and block PostgreSQL writes", async ({ page, authorizeAuthor }) => {
  await page.addInitScript(() => {
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
      if (this.name === "persistenceDrafts") throw new DOMException("Acceptance quota failure", "QuotaExceededError");
      return key === undefined ? put.call(this, value) : put.call(this, value, key);
    };
  });
  const f = await fixture(page, authorizeAuthor); let remoteWrites = 0;
  page.on("request", (request) => { if (request.method() === "PATCH" && new URL(request.url()).pathname === documentPath(f)) remoteWrites += 1; });
  await replaceEditor(page, "Unsaved text must remain visible after quota failure.");
  await expect(page.getByRole("alert")).toContainText(/quota|容量|保存|database draft/i);
  await expect(page.getByRole("button", { name: /今すぐ保存|保存結果を確認して再試行|作品への保存を再試行/ })).toBeDisabled();
  expect(remoteWrites).toBe(0); expect((await read(f)).revision.id).toBe(f.one.revision.id);
  await expectEditor(page, "Unsaved text must remain visible after quota failure.");
});

test("project reconstruction retains PostgreSQL revisions and removed Git lifecycle has no fallback", async ({ page, authorizeAuthor, authorServer }) => {
  const f = await fixture(page, authorizeAuthor); const text = "Survives process reconstruction.";
  await replaceEditor(page, text);
  await expectEditor(page, text);
  await saved(page, f, text);
  const revision = (await read(f)).revision.id;
  await authorServer.restartApi(); await reopen(page, f); await expectEditor(page, text);
  expect((await read(f)).revision.id).toBe(revision);
  for (const suffix of ["publish", "reconcile", "checkpoints"]) {
    const result = await f.fetch(`/api/projects/${f.projectId}/${suffix}`, { method: "POST", data: {} }); expect(result.ok()).toBe(false);
  }
  await expect(page.getByRole("button", { name: "Save to GitHub" })).toHaveCount(0);
  await expect(page.getByLabel("GitHub リポジトリ URL")).toHaveCount(0);
});

test("unmounting a contribution aborts its in-flight action request", async ({ page, authorizeAuthor }) => {
  test.skip(process.env.CODEXIA_PROFILE !== "full", "The publishing contribution is selected by the full profile.");
  const f = await fixture(page, authorizeAuthor); let observed!: (request: import("@playwright/test").Request) => void;
  const seen = new Promise<import("@playwright/test").Request>((resolve) => { observed = resolve; });
  let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/projects/*/actions/publishing.project.tree", async (route) => { observed(route.request()); await gate; try { await route.abort(); } catch { /* already cancelled on unmount */ } });
  try {
    // The PostgreSQL workspace mounts optional modules through its panel menu,
    // not the retired Git workspace tab strip.
    const menu = page.locator(".st-workspace-panel-menu");
    await menu.locator("summary").click();
    await menu.getByRole("button", { name: "EPUB 書き出しを表示", exact: true }).click();
    await expect(page.locator('[data-workspace-panel="module:publishing.export.epub"]')).toBeVisible();
    const request = await seen;
    const failed = page.waitForEvent("requestfailed", (candidate) => candidate === request);
    await page.getByRole("button", { name: "ログアウト" }).click();
    await expect(page.getByRole("button", { name: "OAuthでサインイン" })).toBeVisible(); expect((await failed).failure()).not.toBeNull();
  } finally { release(); }
});

async function delayImages(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const original = FileReader.prototype.readAsDataURL;
    const state = window as Window & { __scratchImageReadStarted?: boolean };
    state.__scratchImageReadStarted = false;
    FileReader.prototype.readAsDataURL = function (this: FileReader, blob: Blob) {
      const reader = this;
      state.__scratchImageReadStarted = true;
      window.setTimeout(() => original.call(reader, blob), 700);
    };
  });
}

preparedAuthorTest("a pending scratch image read is flushed to its captured document before navigation", async ({ page, authorizeAuthor }) => {
  await delayImages(page); const f = await fixture(page, authorizeAuthor); await scratch(page);
  await memo(page).fill("Attachment belongs to Scene One."); await image(page).setInputFiles(png);
  await page.locator(".pg-document-list").getByRole("treeitem", { name: "Scene Two シーン", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Scene Two", exact: true })).toBeVisible();
  await expect.poll(async () => (await scratchRecords(page)).some((r) => r.key.includes(f.one.document.id) && r.text.includes("Attachment belongs to Scene One."))).toBe(true);
  await expect.poll(async () => (await scratchPayloads(page)).some((r) => r.scratchKey.includes(f.one.document.id) && r.kind === "image" && r.value.startsWith("data:image/png;base64,"))).toBe(true);
  expect((await scratchRecords(page)).some((r) => r.key.includes(f.two.document.id) && r.text.includes("Attachment belongs to Scene One."))).toBe(false);
});

preparedAuthorTest("typing beside a scratch image writes compact metadata without serializing or rewriting its payload", async ({ page, authorizeAuthor }) => {
  await page.addInitScript(() => {
    type MetricWindow = Window & { __scratchPerf?: { metadataWrites: number; metadataBytes: number; imageWrites: number; imageBytes: number; imageStringifyCount: number; imageStringifyChars: number; imageStringifyMs: number } };
    const state = window as MetricWindow;
    const metrics = state.__scratchPerf = { metadataWrites: 0, metadataBytes: 0, imageWrites: 0, imageBytes: 0, imageStringifyCount: 0, imageStringifyChars: 0, imageStringifyMs: 0 };
    const originalStringify = JSON.stringify.bind(JSON);
    JSON.stringify = ((value: unknown, replacer?: ((this: unknown, key: string, value: unknown) => unknown) | (number | string)[] | null, space?: string | number) => {
      const started = performance.now();
      const result = originalStringify(value, replacer as never, space);
      if (result?.includes("data:image/")) {
        metrics.imageStringifyCount += 1;
        metrics.imageStringifyChars += result.length;
        metrics.imageStringifyMs += performance.now() - started;
      }
      return result;
    }) as typeof JSON.stringify;
    const originalPut = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
      if (value && typeof value === "object" && "text" in value && typeof value.text === "string" && this.name === "pgScratch") {
        metrics.metadataWrites += 1;
        metrics.metadataBytes += new TextEncoder().encode(value.text).byteLength;
      }
      if (value && typeof value === "object" && "value" in value && typeof value.value === "string" && this.name === "pgScratchPayloads" && (value as { kind?: unknown }).kind === "image") {
        metrics.imageWrites += 1;
        metrics.imageBytes += new TextEncoder().encode(value.value).byteLength;
      }
      return key === undefined ? originalPut.call(this, value) : originalPut.call(this, value, key);
    };
  });
  const f = await fixture(page, authorizeAuthor);
  await scratch(page);
  const attached = { name: "large-capture.png", mimeType: "image/png", buffer: Buffer.alloc(1024 * 1024, 37) };
  await image(page).setInputFiles(attached);
  await expect.poll(async () => (await scratchPayloads(page)).find((record) => record.kind === "image")?.value.length).toBeGreaterThan(1_300_000);
  const attachmentMetrics = await page.evaluate(() => (window as Window & { __scratchPerf?: { imageWrites: number; imageBytes: number } }).__scratchPerf);
  expect(attachmentMetrics?.imageWrites).toBe(1);
  expect(attachmentMetrics?.imageBytes).toBeGreaterThan(1_300_000);
  await page.evaluate(() => {
    const metrics = (window as Window & { __scratchPerf?: { metadataWrites: number; metadataBytes: number; imageWrites: number; imageBytes: number; imageStringifyCount: number; imageStringifyChars: number; imageStringifyMs: number } }).__scratchPerf!;
    metrics.metadataWrites = 0; metrics.metadataBytes = 0; metrics.imageWrites = 0; metrics.imageBytes = 0; metrics.imageStringifyCount = 0; metrics.imageStringifyChars = 0; metrics.imageStringifyMs = 0;
  });
  const typed = "0123456789abcdefghijklmnopqr";
  await memo(page).pressSequentially(typed, { delay: 0 });
  await expect.poll(async () => (await scratchRecords(page)).find((record) => record.key.includes(f.one.document.id))?.text).toContain(typed);
  const metrics = await page.evaluate(() => (window as Window & { __scratchPerf?: { metadataWrites: number; metadataBytes: number; imageWrites: number; imageBytes: number; imageStringifyCount: number; imageStringifyChars: number; imageStringifyMs: number } }).__scratchPerf);
  expect(metrics?.metadataWrites).toBeGreaterThan(0);
  expect(metrics?.imageWrites).toBe(0);
  expect(metrics?.imageStringifyCount).toBe(0);
  expect(metrics?.metadataBytes).toBeLessThan(1024 * 1024);
});

preparedAuthorTest("saving a scratch note replays the same request after its committed response is lost", async ({ page, authorizeAuthor }) => {
  const f = await fixture(page, authorizeAuthor);
  await scratch(page);
  await memo(page).fill("Scratch text survives an ambiguous note save.");
  await image(page).setInputFiles(png);
  await expect.poll(async () => (await scratchRecords(page)).find((record) => record.key.includes(f.one.document.id))?.text).toContain(png.name);

  type NoteReceipt = { document: { id: string }; revision: { id: string }; replayed: boolean };
  const collectionPath = documentPath(f).slice(0, documentPath(f).lastIndexOf("/"));
  const isNoteResponse = (response: Response) => response.request().method() === "POST" &&
    new URL(response.url()).pathname === collectionPath;
  let firstCommit: NoteReceipt | undefined;
  let attempts = 0;
  const requests: Array<{ key: string | undefined; body: unknown }> = [];
  await page.route(`**${collectionPath}`, async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    attempts += 1;
    requests.push({ key: route.request().headers()["idempotency-key"], body: route.request().postDataJSON() });
    if (attempts === 1) {
      const response = await route.fetch();
      expect(response.status()).toBe(201);
      firstCommit = await response.json() as NoteReceipt;
      await route.abort("failed");
      return;
    }
    await route.continue();
  });

  const save = page.locator(".scratch-panel").getByRole("button", { name: "ノートとしてPostgreSQLへ保存" });
  await save.click();
  await expect(page.locator(".scratch-panel").getByRole("alert")).toBeVisible();
  await expect(memo(page)).toHaveValue("Scratch text survives an ambiguous note save.");
  await expect(page.locator(".scratch-panel").getByRole("img", { name: png.name })).toBeVisible();
  await memo(page).fill("A newer scratch draft stays separate from the pending note.");
  const reconcile = page.locator(".scratch-panel").getByRole("button", { name: "前のノート保存を照合", exact: true });
  const [replayResponse] = await Promise.all([page.waitForResponse(isNoteResponse), reconcile.click()]);
  expect(replayResponse.status()).toBe(201);
  if (!firstCommit) throw new Error("The intercepted note was never committed");
  expect(firstCommit.replayed).toBe(false);
  expect(await replayResponse.json()).toMatchObject({
    document: { id: firstCommit.document.id }, revision: { id: firstCommit.revision.id }, replayed: true,
  });
  await expect(page.locator(".scratch-panel").getByRole("alert")).toHaveCount(0);
  expect(attempts).toBe(2);
  expect(requests[1]).toEqual(requests[0]);
  await expect(memo(page)).toHaveValue("A newer scratch draft stays separate from the pending note.");

  const [newResponse] = await Promise.all([page.waitForResponse(isNoteResponse), save.click()]);
  expect(newResponse.status()).toBe(201);
  const newCommit = await newResponse.json() as NoteReceipt;
  expect(newCommit.replayed).toBe(false);
  expect(newCommit.document.id).not.toBe(firstCommit.document.id);
  await expect(memo(page)).toBeEnabled();
  expect(attempts).toBe(3);
  await expect(page.locator(".scratch-panel").getByRole("alert")).toHaveCount(0);
  expect(requests[2]?.key).not.toBe(requests[0]?.key);
  expect((requests[2]?.body as { markdown: string }).markdown).toContain("A newer scratch draft stays separate from the pending note.");

  const documents = await f.fetch(`${collectionPath}?limit=1000&parentId=${f.one.document.id}`);
  expect(documents.ok()).toBe(true);
  const children = await documents.json() as { documents: Array<{ id: string; kind: string; title: string }> };
  const notes = children.documents.filter((document) => document.kind === "note" && document.title === "スクラッチ");
  expect(notes).toHaveLength(2);
  expect(notes.map(note => note.id).sort()).toEqual([firstCommit.document.id, newCommit.document.id].sort());
  const noteBodies = await Promise.all(notes.map(async (item) => {
    const note = await f.fetch(`${collectionPath}/${item.id}`);
    expect(note.ok()).toBe(true);
    const noteRead = await note.json() as { revision: { markdown: string } };
    return noteRead.revision.markdown;
  }));
  expect(noteBodies.some((markdown) => markdown.includes("Scratch text survives an ambiguous note save.") && markdown.includes("data:image/png;base64"))).toBe(true);
  expect(noteBodies.some((markdown) => markdown.includes("A newer scratch draft stays separate from the pending note."))).toBe(true);
});

preparedAuthorTest("a pending scratch note remains reconcilable after its editable draft is cleared", async ({ page, authorizeAuthor }) => {
  const f = await fixture(page, authorizeAuthor);
  await scratch(page);
  await memo(page).fill("The pending note payload remains durable after editing the scratch.");
  let attempts = 0;
  const requests: Array<{ key: string | undefined; body: unknown }> = [];
  const collectionPath = documentPath(f).slice(0, documentPath(f).lastIndexOf("/"));
  await page.route(`**${collectionPath}`, async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    attempts += 1;
    requests.push({ key: route.request().headers()["idempotency-key"], body: route.request().postDataJSON() });
    if (attempts === 1) {
      const response = await route.fetch();
      expect(response.status()).toBe(201);
      await route.abort("failed");
      return;
    }
    await route.continue();
  });

  await page.locator(".scratch-panel").getByRole("button", { name: "ノートとしてPostgreSQLへ保存" }).click();
  await expect(page.locator(".scratch-panel").getByRole("alert")).toBeVisible();
  await memo(page).fill("");
  const reconcile = page.locator(".scratch-panel").getByRole("button", { name: "前のノート保存を照合", exact: true });
  await expect(reconcile).toBeEnabled();
  await expect(page.locator(".scratch-panel").getByRole("status")).toContainText("現在のスクラッチを保持します");
  await reconcile.click();
  await expect.poll(() => attempts).toBe(2);
  await expect(page.locator(".scratch-panel").getByRole("alert")).toHaveCount(0);
  expect(requests[1]).toEqual(requests[0]);
  await expect(memo(page)).toHaveValue("");

  const documents = await f.fetch(`${collectionPath}?limit=1000&parentId=${f.one.document.id}`);
  const children = await documents.json() as { documents: Array<{ kind: string; title: string }> };
  expect(children.documents.filter((document) => document.kind === "note" && document.title === "スクラッチ")).toHaveLength(1);
});

preparedAuthorTest("scratch still protects text and accepts a new image after an oversized attachment", async ({ page, authorizeAuthor }) => {
  const f = await fixture(page, authorizeAuthor);
  await scratch(page);
  await image(page).setInputFiles(png);
  const attachment = page.locator(".scratch-panel").getByRole("img", { name: png.name });
  await expect(attachment).toBeVisible();
  await image(page).setInputFiles({ name: "too-large.png", mimeType: "image/png", buffer: Buffer.alloc(3 * 1024 * 1024 + 1) });
  await expect(page.locator(".scratch-panel").getByRole("alert")).toContainText("3MB以下");
  await memo(page).fill("Scratch remains usable after a rejected attachment.");
  await page.locator(".pg-document-list").getByRole("treeitem", { name: "Scene Two シーン", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Scene Two", exact: true })).toBeVisible();
  await page.locator(".pg-document-list").getByRole("treeitem", { name: "Scene One シーン", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Scene One", exact: true })).toBeVisible();
  await scratch(page);
  await expect(memo(page)).toHaveValue("Scratch remains usable after a rejected attachment.");
  await expect(attachment).toBeVisible();
  await image(page).setInputFiles({ ...png, name: "replacement.png" });
  await expect(page.locator(".scratch-panel").getByRole("img", { name: "replacement.png" })).toBeVisible();
  await expect.poll(async () => (await scratchRecords(page)).find((r) => r.key.includes(f.one.document.id))?.text).toContain("replacement.png");
});

test("an untouched or stale tab cannot overwrite protected scratch text and images", async ({ page, context, authorizeAuthor }) => {
  const f = await fixture(page, authorizeAuthor);
  const second = await context.newPage();
  try {
    await authorizeAuthor("desktop", second, { path: new URL(page.url()).pathname });
    await expectEditor(second, f.one.revision.markdown);
    await scratch(second);
    await expect(memo(second)).toBeEnabled();
    await scratch(page);
    await memo(page).fill("First tab's protected text.");
    await image(page).setInputFiles(png);
    await expect.poll(async () => (await scratchRecords(page)).find((r) => r.key.includes(f.one.document.id))?.text).toContain(png.name);
    await second.getByRole("button", { name: "読む", exact: true }).click();
    await expect(second.getByRole("region", { name: "原稿の閲覧" })).toBeVisible();
    await second.reload(); await authorizeAuthor("desktop", second, { continueCurrentPage: true });
    await expectEditor(second, f.one.revision.markdown);
    await scratch(second);
    await expect(memo(second)).toHaveValue("First tab's protected text.");
    await expect(second.locator(".scratch-panel").getByRole("img", { name: png.name })).toBeVisible();

    await memo(page).fill("First tab's newer protected text.");
    await expect.poll(async () => (await scratchRecords(page)).find((r) => r.key.includes(f.one.document.id))?.text).toContain("newer protected text");
    await memo(second).fill("Second tab's stale edit.");
    await expect(second.locator(".scratch-panel").getByRole("alert")).toContainText("別タブ");
    await expect(memo(second)).toHaveValue("Second tab's stale edit.");
    await page.reload(); await authorizeAuthor("desktop", page, { continueCurrentPage: true });
    await expectEditor(page, f.one.revision.markdown);
    await scratch(page);
    await expect(memo(page)).toHaveValue("First tab's newer protected text.");
    await expect(page.locator(".scratch-panel").getByRole("img", { name: png.name })).toBeVisible();
  } finally {
    await second.close();
  }
});

test("an unprotected scratch warns before reload and the protected other-tab value remains recoverable", async ({ page, context, authorizeAuthor }) => {
  const f = await fixture(page, authorizeAuthor);
  const second = await context.newPage();
  let pageDialogs = 0;
  let secondDialogs = 0;
  let secondDialogAction: "dismiss" | "accept" = "dismiss";
  page.on("dialog", async (dialog) => {
    if (dialog.type() !== "beforeunload") return dialog.dismiss();
    pageDialogs++;
    await dialog.accept();
  });
  second.on("dialog", async (dialog) => {
    if (dialog.type() !== "beforeunload") return dialog.dismiss();
    secondDialogs++;
    if (secondDialogAction === "dismiss") await dialog.dismiss();
    else await dialog.accept();
  });
  try {
    await authorizeAuthor("desktop", second, { path: new URL(page.url()).pathname });
    await expectEditor(second, f.one.revision.markdown);
    await scratch(page);
    await scratch(second);
    await memo(page).fill("Tab A protected scratch.");
    await expect.poll(async () => (await scratchRecords(page)).find((record) => record.key.includes(f.one.document.id))?.text).toContain("Tab A protected scratch.");

    await page.reload(); await authorizeAuthor("desktop", page, { continueCurrentPage: true });
    expect(pageDialogs).toBe(0);
    await scratch(page);
    await expect(memo(page)).toHaveValue("Tab A protected scratch.");

    await memo(second).fill("Tab B conflicting scratch.");
    await expect(second.locator(".scratch-panel").getByRole("alert")).toContainText("別タブ");
    expect((await scratchRecords(second)).find((record) => record.key.includes(f.one.document.id))?.text).toContain("Tab A protected scratch.");

    await second.reload({ timeout: 5_000 }).catch(() => undefined);
    expect(secondDialogs).toBe(1);
    await expect(memo(second)).toHaveValue("Tab B conflicting scratch.");
    expect((await scratchRecords(second)).find((record) => record.key.includes(f.one.document.id))?.text).toContain("Tab A protected scratch.");

    secondDialogAction = "accept";
    await second.reload({ timeout: 5_000 }).catch(() => undefined);
    expect(secondDialogs).toBe(2);
    await authorizeAuthor("desktop", second, { continueCurrentPage: true });
    await scratch(second);
    await expect(memo(second)).toHaveValue("Tab A protected scratch.");
    await second.reload(); await authorizeAuthor("desktop", second, { continueCurrentPage: true });
    expect(secondDialogs).toBe(2);
    await scratch(second);
    await expect(memo(second)).toHaveValue("Tab A protected scratch.");
  } finally {
    await second.close();
  }
});

test("scratch storage failure warns before reload and keeps the last protected record", async ({ page, authorizeAuthor }) => {
  const f = await fixture(page, authorizeAuthor);
  await scratch(page);
  await memo(page).fill("Last protected scratch.");
  await expect.poll(async () => (await scratchRecords(page)).find((record) => record.key.includes(f.one.document.id))?.text).toContain("Last protected scratch.");
  await page.evaluate(() => {
    const original = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
      if (this.name === "pgScratch") throw new DOMException("Scratch quota failure", "QuotaExceededError");
      return key === undefined ? original.call(this, value) : original.call(this, value, key);
    };
  });
  await memo(page).fill("Unprotected scratch during storage failure.");
  await expect(page.locator(".scratch-panel [role=alert]")).toBeVisible();
  let dialogs = 0;
  page.on("dialog", async (dialog) => {
    if (dialog.type() !== "beforeunload") return dialog.dismiss();
    dialogs++;
    await dialog.dismiss();
  });

  await page.reload({ timeout: 5_000 }).catch(() => undefined);
  expect(dialogs).toBe(1);
  await expect(memo(page)).toHaveValue("Unprotected scratch during storage failure.");
  expect((await scratchRecords(page)).find((record) => record.key.includes(f.one.document.id))?.text).toContain("Last protected scratch.");
});

test("navigation does not replace a scratch record while it is loading or unreadable", async ({ page, authorizeAuthor }) => {
  const f = await fixture(page, authorizeAuthor);
  await scratch(page);
  await memo(page).fill("Protected scratch before simulating read failure.");
  const record = () => scratchRecords(page).then((records) => records.find((item) => item.key.includes(f.one.document.id)));
  await expect.poll(async () => (await record())?.text).toContain("Protected scratch");
  const original = await record();
  await page.addInitScript(() => {
    if (sessionStorage.getItem("hold-scratch-read") !== "1") return;
    const get = IDBObjectStore.prototype.get;
    IDBObjectStore.prototype.get = function (query) {
      const request = get.call(this, query);
      if (this.name === "pgScratch") Object.defineProperty(request, "onsuccess", { set() {} });
      return request;
    };
  });
  await page.evaluate(() => sessionStorage.setItem("hold-scratch-read", "1"));
  await page.reload(); await authorizeAuthor("desktop", page, { continueCurrentPage: true });
  await expectEditor(page, f.one.revision.markdown);
  await scratch(page);
  await expect(memo(page)).toBeDisabled();
  await page.locator(".pg-document-list").getByRole("treeitem", { name: "Scene Two シーン", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Scene Two", exact: true })).toBeVisible();
  expect(await record()).toMatchObject(original!);
  await page.evaluate(() => sessionStorage.removeItem("hold-scratch-read"));
  const unreadable = { ...original, text: "Malformed original recovery bytes" };
  await writeRecords(page, [unreadable], "pgScratch");
  await f.authorizeAuthor("desktop", page, { path: `/desktop/projects/${f.projectId}/scenes/${f.one.document.id}` });
  await expectEditor(page, f.one.revision.markdown);
  await scratch(page);
  await expect(page.locator(".scratch-panel").getByRole("alert")).toBeVisible();
  await page.locator(".pg-document-list").getByRole("treeitem", { name: "Scene Two シーン", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Scene Two", exact: true })).toBeVisible();
  expect(await record()).toMatchObject(unreadable);
});

preparedAuthorTest("resuming an older scratch generation cannot replace newer unprotected input", async ({ page, authorizeAuthor }) => {
  await fixture(page, authorizeAuthor); await scratch(page); await memo(page).fill("Protected older scratch generation.");
  await editor(page).click(); await expect.poll(async () => (await scratchRecords(page)).some((r) => r.text.includes("Protected older scratch generation."))).toBe(true);
  await memo(page).fill("Newer scratch input still inside debounce.");
  await page.locator(".scratch-panel").getByRole("button", { name: "続ける", exact: true }).click();
  await expect(memo(page)).toHaveValue("Newer scratch input still inside debounce.");
  await expect.poll(async () => (await scratchRecords(page)).some((r) => r.text.includes("Newer scratch input still inside debounce."))).toBe(true);
});

preparedAuthorTest("failed scratch protection refuses recovery selection and keeps the current error visible", async ({ page, authorizeAuthor }) => {
  await fixture(page, authorizeAuthor); await scratch(page); await memo(page).fill("Older protected scratch."); await editor(page).click();
  await expect.poll(async () => (await scratchRecords(page)).some((r) => r.text.includes("Older protected scratch."))).toBe(true);
  await page.evaluate(() => {
    const original = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (this: IDBObjectStore, value: unknown, key?: IDBValidKey) { if (this.name === "pgScratch") throw new DOMException("Scratch quota failure", "QuotaExceededError"); return key === undefined ? original.call(this, value) : original.call(this, value, key); };
  });
  await memo(page).fill("Current unprotected scratch.");
  await page.locator(".scratch-panel").getByRole("button", { name: "続ける", exact: true }).click();
  await expect(memo(page)).toHaveValue("Current unprotected scratch."); await expect(page.locator(".scratch-panel [role=alert]")).toBeVisible();
  expect((await scratchRecords(page)).some((r) => r.text.includes("Older protected scratch."))).toBe(true);
});

preparedAuthorTest("resuming an older scratch entry waits for its pending image read and keeps the latest draft", async ({ page, authorizeAuthor }) => {
  await delayImages(page); await fixture(page, authorizeAuthor); await scratch(page);
  await memo(page).fill("Protected scratch before attachment."); await editor(page).click();
  await expect.poll(async () => (await scratchRecords(page)).some((r) => r.text.includes("Protected scratch before attachment."))).toBe(true);
  await memo(page).fill("Latest scratch with attachment."); await image(page).setInputFiles(png);
  await page.locator(".scratch-panel").getByRole("button", { name: "続ける", exact: true }).click();
  await expect(memo(page)).toHaveValue("Latest scratch with attachment.");
  await expect.poll(async () => (await scratchRecords(page)).some((r) => r.text.includes("Latest scratch with attachment."))).toBe(true);
  await expect.poll(async () => (await scratchPayloads(page)).some((r) => r.kind === "image" && r.value.startsWith("data:image/png;base64,"))).toBe(true);
});

preparedAuthorTest("scratch text and image input survive while navigation waits for protection", async ({ page, authorizeAuthor }) => {
  await delayImages(page);
  await page.addInitScript(() => {
    type Gate = { armed: boolean; started: boolean; target?: IDBTransaction; release?: () => void };
    type GateWindow = Window & { __scratchProtectionGate?: Gate };
    (window as GateWindow).__scratchProtectionGate = { armed: false, started: false };
    const descriptor = Object.getOwnPropertyDescriptor(IDBTransaction.prototype, "oncomplete");
    if (!descriptor?.get || !descriptor.set) throw new Error("IndexedDB completion hooks are unavailable.");
    Object.defineProperty(IDBTransaction.prototype, "oncomplete", {
      configurable: true,
      enumerable: descriptor.enumerable,
      get() { return descriptor.get!.call(this); },
      set(handler: ((this: IDBTransaction, event: Event) => unknown) | null) {
        if (!handler) { descriptor.set!.call(this, handler); return; }
        const transaction = this;
        descriptor.set!.call(this, function (this: IDBTransaction, event: Event) {
          const gate = (window as GateWindow).__scratchProtectionGate;
          if (gate && gate.target === transaction) {
            gate.started = true;
            gate.release = () => { gate.target = undefined; handler.call(transaction, event); };
            return;
          }
          return handler.call(this, event);
        });
      },
    });
    const originalPut = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (this: IDBObjectStore, value: unknown, key?: IDBValidKey): IDBRequest<IDBValidKey> {
      const gate = (window as GateWindow).__scratchProtectionGate;
      const text = value && typeof value === "object" && "text" in value && typeof value.text === "string" ? value.text : "";
      if (this.name === "pgScratch" && gate?.armed && text.includes("Scratch write held during navigation.")) {
        gate.armed = false;
        gate.target = this.transaction;
      }
      return key === undefined ? originalPut.call(this, value) : originalPut.call(this, value, key);
    };
  });
  await fixture(page, authorizeAuthor); await scratch(page);
  await memo(page).fill("Previously protected scratch."); await editor(page).click();
  await expect.poll(async () => (await scratchRecords(page)).some((r) => r.text.includes("Previously protected scratch."))).toBe(true);
  await page.evaluate(() => { (window as Window & { __scratchProtectionGate?: { armed: boolean } }).__scratchProtectionGate!.armed = true; });
  await memo(page).fill("Scratch write held during navigation.");
  await page.waitForFunction(() => (window as Window & { __scratchProtectionGate?: { started: boolean } }).__scratchProtectionGate?.started === true);

  const sceneTwo = page.locator(".pg-document-list").getByRole("treeitem", { name: "Scene Two シーン", exact: true });
  await sceneTwo.click();
  await expect(page.getByRole("heading", { name: "Scene One", exact: true })).toBeVisible();
  await memo(page).fill("Latest scratch input during protection.");
  await image(page).setInputFiles(png);
  await page.waitForFunction(() => (window as Window & { __scratchImageReadStarted?: boolean }).__scratchImageReadStarted === true);
  await page.evaluate(() => (window as Window & { __scratchProtectionGate?: { release?: () => void } }).__scratchProtectionGate!.release?.());
  await expect.poll(async () => (await scratchRecords(page)).some((r) => r.text.includes("Latest scratch input during protection."))).toBe(true);
  await expect.poll(async () => (await scratchPayloads(page)).some((r) => r.kind === "image" && r.value.startsWith("data:image/png;base64,"))).toBe(true);
  await sceneTwo.click();
  await expect(page.getByRole("heading", { name: "Scene Two", exact: true })).toBeVisible();
});

test("public publishing route mounts its source reader without an owner session", async ({ page, authorServer }) => {
  test.skip(process.env.CODEXIA_PROFILE !== "full", "The publishing browser module is selected by the full profile.");
  const ownerSessionRequests: string[] = []; const publicReadRequests: string[] = [];
  page.on("request", (request) => { const pathname = new URL(request.url()).pathname; if (pathname === "/api/session") ownerSessionRequests.push(pathname); if (pathname.startsWith("/api/public/projects/")) publicReadRequests.push(pathname); });
  const projectId = randomUUID(); await page.goto(new URL(`/r/publishing/${projectId}/e2e-invalid-token`, authorServer.apiOrigin).href);
  await expect(page.getByRole("heading", { name: "共有された原稿" })).toBeVisible();
  await expect(page.getByRole("alert")).toContainText("共有リンクは無効か、期限切れです。"); expect(ownerSessionRequests).toEqual([]);
  expect(publicReadRequests).toEqual([`/api/public/projects/${projectId}/modules/publishing/share/e2e-invalid-token`]);
});

test("a root-only public share renders selectable scenes without an owner session", async ({ page, authorServer }) => {
  test.skip(process.env.CODEXIA_PROFILE !== "full", "The publishing browser module is selected by the full profile.");
  const projectId = randomUUID();
  const token = "share_" + "r".repeat(43);
  const base = `/api/public/projects/${projectId}/modules/publishing/share/${token}`;
  const requests: string[] = [];
  const publicRequestHeaders: Record<string, string>[] = [];
  const ownerSessionRequests: string[] = [];
  page.on("request", (request) => {
    const pathname = new URL(request.url()).pathname;
    if (pathname === "/api/session") ownerSessionRequests.push(pathname);
  });
  await page.route(`**${base}**`, async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    requests.push(pathname);
    publicRequestHeaders.push(await route.request().allHeaders());
    if (pathname === base) {
      await route.fulfill({ status: 200, json: {
        label: "Root scene preview", expiresAt: "2030-01-01T00:00:00Z",
        snapshot: { projectId, projectVersion: 1 }, scope: { kind: "project", id: projectId },
        sceneCount: 1, rootScenes: [{ id: "root-scene", title: "作品直下のシーン" }], tree: [],
      } });
    } else if (pathname === `${base}/scenes/root-scene`) {
      await route.fulfill({ status: 200, json: {
        snapshot: { projectId, projectVersion: 1 },
        id: "root-scene", title: "作品直下のシーン", body: "作品直下の本文を表示します。",
      } });
    } else {
      await route.fulfill({ status: 404, json: { error: "Share link is unavailable" } });
    }
  });
  await page.goto(new URL(`/r/publishing/${projectId}/${token}`, authorServer.apiOrigin).href);
  await expect(page.getByRole("heading", { name: "Root scene preview" })).toBeVisible();
  await expect(page.getByRole("button", { name: "作品直下のシーン" })).toBeVisible();
  await page.getByRole("button", { name: "作品直下のシーン" }).click();
  await expect(page.getByText("作品直下の本文を表示します。")).toBeVisible();
  expect(requests).toEqual([base, `${base}/scenes/root-scene`]);
  expect(publicRequestHeaders.every((headers) => !headers.cookie && !headers.authorization)).toBe(true);
  expect(ownerSessionRequests).toEqual([]);
});

preparedAuthorTest("late document activation cannot replace explicit scene navigation", async ({ page, authorizeAuthor }) => {
  const f = await fixture(page, authorizeAuthor);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let observed!: () => void;
  const seen = new Promise<void>((resolve) => { observed = resolve; });
  const targetPath = documentPath(f);
  await page.route(`**${targetPath}`, async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const response = await route.fetch();
    observed();
    await gate;
    await route.fulfill({ response });
  });
  try {
    const sceneTwo = page.locator(".pg-document-list").getByRole("treeitem", { name: "Scene Two シーン", exact: true });
    await sceneTwo.click();
    await expect(page.getByRole("heading", { name: "Scene Two", exact: true })).toBeVisible();
    const confirmedUrl = page.url();
    const sceneOne = page.locator(".pg-document-list").getByRole("treeitem", { name: "Scene One シーン", exact: true });
    await sceneOne.click();
    await seen;
    await expect(sceneTwo).toHaveAttribute("aria-current", "page");
    await expect(sceneOne).not.toHaveAttribute("aria-current", "page");
    await expect(page).toHaveURL(confirmedUrl);
    await expectEditor(page, f.two.revision.markdown);
    await sceneTwo.click();
    const lateResponse = page.waitForResponse(response => new URL(response.url()).pathname === targetPath && response.request().method() === "GET");
    release();
    expect((await lateResponse).ok()).toBe(true);
    await expect(page.getByRole("heading", { name: "Scene Two", exact: true })).toBeVisible();
    await expect(sceneTwo).toHaveAttribute("aria-current", "page");
    await expect(page).toHaveURL(confirmedUrl);
    await expectEditor(page, f.two.revision.markdown);
  } finally { release(); }
});

preparedAuthorTest("Issue 42: an updated PostgreSQL revision cannot supersede explicit navigation during draft flush", async ({ page, authorizeAuthor }) => {
  const f = await fixture(page, authorizeAuthor); const gate = await holdSaves(page, f);
  const draft = "Pending Scene One draft before explicit navigation.";
  try {
    await replaceEditor(page, draft);
    await expectEditor(page, draft);
    await gate.seen;
    await replace(f, "External PostgreSQL version.");
    await page.locator(".pg-document-list").getByRole("treeitem", { name: "Scene Two シーン", exact: true }).click();
    await expectEditor(page, f.two.revision.markdown); gate.release();
    await expect(page.getByRole("heading", { name: "Scene Two", exact: true })).toBeVisible();
    await expect.poll(async () => (await drafts(page)).some((d) => d.documentId === f.one.document.id && d.markdown === draft)).toBe(true);
  } finally { gate.release(); }
});

preparedAuthorTest("Issue 42: an unchanged PostgreSQL observation leaves explicit scene selection alone", async ({ page, authorizeAuthor }) => {
  const f = await fixture(page, authorizeAuthor);
  await page.locator(".pg-document-list").getByRole("treeitem", { name: "Scene Two シーン", exact: true }).click();
  for (const name of ["online", "focus", "visibilitychange"]) await page.evaluate((event) => window.dispatchEvent(new Event(event)), name);
  await expect(page.getByRole("heading", { name: "Scene Two", exact: true })).toBeVisible();
  await expectEditor(page, f.two.revision.markdown);
  expect((await read(f)).revision.id).toBe(f.one.revision.id);
});

test("Issue 42: failed PostgreSQL availability preserves the author session and offers explicit retry", async ({ page, authorizeAuthor }) => {
  const f = await fixture(page, authorizeAuthor); let unavailable = true; let authorizationRequests = 0;
  await page.route("**/api/v1/persistence/status", (route) => unavailable ? route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "PostgreSQL unavailable" }) }) : route.continue());
  await page.reload();
  const author = await authorizeAuthor("desktop", page, { continueCurrentPage: true, expectedView: page.getByRole("heading", { name: "PostgreSQLへ接続できません" }) });
  expect((await author.fetch("/api/session")).status()).toBe(200);
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/auth/oauth2/authorize") authorizationRequests += 1;
  });
  unavailable = false; await page.getByRole("button", { name: "再試行" }).click();
  await expect(page).toHaveURL(new RegExp(`/desktop/projects/${f.projectId}/scenes/${f.one.document.id}`));
  await expectEditor(page, f.one.revision.markdown);
  expect(authorizationRequests, "PostgreSQL recovery reuses the signed-in OAuth session").toBe(0);
});

preparedAuthorTest("a project containing only root scenes can export its full text from the publishing panel", async ({ page, authorizeAuthor }) => {
  test.skip(process.env.CODEXIA_PROFILE !== "full", "The publishing contribution is selected by the full profile.");
  const { one, two } = await fixture(page, authorizeAuthor);
  const menu = page.locator(".st-workspace-panel-menu");
  await menu.locator("summary").click();
  await menu.getByRole("button", { name: "プレーンテキスト書き出しを表示", exact: true }).click();
  const panel = page.locator('[data-workspace-panel="module:publishing.export.plaintext"]');
  const download = panel.getByRole("button", { name: "テキストをダウンロード" });
  await expect(download).toBeEnabled();
  const scopeRadio = panel.getByRole("radio", { name: "章", exact: true });
  expect(await scopeRadio.evaluate((element) => element.getBoundingClientRect().width)).toBeLessThan(28);
  await expect(panel.getByRole("status")).toContainText("保存済みの本文");
  await panel.getByRole("radio", { name: "章", exact: true }).check();
  await expect(download).toBeDisabled();
  await panel.getByRole("radio", { name: "全文", exact: true }).check();
  page.once("dialog", (dialog) => dialog.accept());
  const downloaded = page.waitForEvent("download");
  await download.click();
  const stream = await (await downloaded).createReadStream();
  const text = await readStreamText(stream);
  for (const scene of [one, two]) expect(text).toContain(scene.revision.markdown.trim());
});

test("Desktop publishing preserves proposal, scope, expiration, reader isolation, and revocation", async ({ page, browser, authorizeAuthor }) => {
  test.skip(process.env.CODEXIA_PROFILE !== "full", "The publishing contribution is selected by the full profile.");
  const author = await authorizeAuthor("desktop");
  const origin = new URL(page.url()).origin;
  const publicReaderOrigin = new URL(origin);
  const projectResponse = await author.fetch(`${origin}${rootPath}`, {
    method: "POST",
    data: { title: `Publishing root share ${randomUUID()}` },
  });
  expect(projectResponse.status(), await projectResponse.text()).toBe(201);
  const { project } = await projectResponse.json() as { project: { id: string } };
  const projectId = project.id;
  const createDocument = async (input: { kind: string; title: string; orderKey: string; markdown: string; parentId?: string | null }) => {
    const response = await author.fetch(`${origin}${rootPath}/${projectId}/documents`, {
      method: "POST", headers: { "Idempotency-Key": randomUUID() },
      data: input,
    });
    expect(response.status(), await response.text()).toBe(201);
    return response.json() as Promise<{ document: { id: string } }>;
  };
  const volume = await createDocument({ kind: "volume", title: "第一巻", orderKey: "a", markdown: "" });
  const chapter = await createDocument({ kind: "chapter", title: "第二章", orderKey: "a", markdown: "", parentId: volume.document.id });
  const chapterScene = await createDocument({
    kind: "scene", title: "同じタイトル", orderKey: "a", markdown: "CHAPTER-ONLY BODY\n", parentId: chapter.document.id,
  });
  const otherChapterScene = await createDocument({ kind: "scene", title: "別の節", orderKey: "b", markdown: "ANOTHER CHAPTER BODY\n", parentId: chapter.document.id });
  const rootScene = await createDocument({ kind: "scene", title: "同じタイトル", orderKey: "a", markdown: "ROOT-ONLY BODY\n", parentId: null });
  await createDocument({ kind: "note", title: "PRIVATE NOTE", orderKey: "b", markdown: "PRIVATE NOTE BODY\n", parentId: null });
  await authorizeAuthor("desktop", page, { path: `/desktop/projects/${projectId}/scenes/${chapterScene.document.id}` });
  await expect(editor(page)).toBeVisible();

  const menu = page.locator(".st-workspace-panel-menu");
  await menu.locator("summary").click();
  await menu.getByRole("button", { name: "読み取り専用共有リンクを表示", exact: true }).click();
  const panel = page.locator('[data-workspace-panel="module:publishing.share-links"]');
  const scope = panel.getByRole("combobox", { name: "範囲", exact: true });
  const target = panel.getByRole("combobox", { name: "対象", exact: true });
  type ShareProposal = { proposalId: string; changeSet: Pick<ChangeSet, "id" | "projectId"> };
  const shareChangeSetPath = (id: string) =>
    `${origin}${rootPath}/${projectId}/changesets/${encodeURIComponent(id)}`;
  const approveAndApply = async (proposal: ShareProposal, verifyApprovalOnly?: () => Promise<void>) => {
    expect(proposal.changeSet).toEqual({ id: proposal.proposalId, projectId });
    const path = shareChangeSetPath(proposal.proposalId);
    const proposedResponse = await author.fetch(path);
    expect(proposedResponse.status(), await proposedResponse.text()).toBe(200);
    const { changeSet } = await proposedResponse.json() as { changeSet: ChangeSet };
    expect(changeSet).toMatchObject({ id: proposal.proposalId, projectId, status: "proposed" });
    expect(changeSet.operations).toHaveLength(1);
    expect(changeSet.operations[0]).toMatchObject({
      type: "module.record.save", command: { projectId, moduleId: "publishing", key: "share-grants" },
    });

    const approval = await author.fetch(`${path}/approve`, {
      method: "POST", data: { expectedVersion: changeSet.version },
    });
    expect(approval.status(), await approval.text()).toBe(200);
    const { changeSet: approved } = await approval.json() as { changeSet: ChangeSet };
    expect(approved).toMatchObject({ id: changeSet.id, projectId, status: "approved" });
    await verifyApprovalOnly?.();
    const applied = await author.fetch(`${path}/apply`, {
      method: "POST", data: { expectedVersion: approved.version },
    });
    expect(applied.status(), await applied.text()).toBe(200);
    expect(await applied.json()).toMatchObject({ changeSet: { id: changeSet.id, projectId, status: "applied" } });
  };
  await scope.selectOption("volume");
  await expect(target).toHaveValue(volume.document.id);
  await scope.selectOption("chapter");
  await expect(target).toHaveValue(chapter.document.id);
  await scope.selectOption("scene");
  await expect(target).toHaveValue(rootScene.document.id);
  await expect(target.locator("option")).toHaveText([
    "作品直下 / 同じタイトル",
    "第一巻 / 第二章 / 同じタイトル",
    "第一巻 / 第二章 / 別の節",
  ]);
  await target.selectOption(rootScene.document.id);
  await panel.getByLabel("表示名").fill("作品直下リンク");
  const shareResponse = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return response.request().method() === "POST" && url.pathname.endsWith("/actions/publishing.shares.create");
  });
  await panel.getByRole("button", { name: "リンク発行の提案を作成", exact: true }).click();
  const actionResponse = await shareResponse;
  expect(actionResponse.ok(), await actionResponse.text()).toBe(true);
  const actionBody = await actionResponse.json() as {
    ok: boolean;
    data: ShareProposal & { token: string; share: { id: string } };
  };
  expect(actionBody.ok).toBe(true);
  expect(actionResponse.request().postDataJSON()).toMatchObject({ input: { kind: "scene", id: rootScene.document.id } });
  await expect(panel).toContainText("発行提案中：作品直下 / 同じタイトル");
  await expect(panel).toContainText("提案作成時点では読者はまだ開けません");
  await expect(panel).toContainText(`提案 ${actionBody.data.proposalId}`);

  const issuedUrl = new URL(await panel.locator("code").innerText());
  expect(issuedUrl.origin).toBe(publicReaderOrigin.origin);
  expect(issuedUrl.pathname).toBe(`/r/publishing/${projectId}/${actionBody.data.token}`);
  const readerContext = await browser.newContext();
  const readerPage = await readerContext.newPage();
  const publicReaderRequests: string[] = [];
  readerPage.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname.startsWith("/api/public/projects/")) publicReaderRequests.push(url.origin);
  });
  try {
    await readerPage.goto(issuedUrl.toString());
    await expect(readerPage.getByRole("heading", { name: "共有された原稿" })).toBeVisible();
    await expect(readerPage.getByRole("alert")).toContainText("共有リンクは無効か、期限切れです。");

    expect((await readerContext.request.get(shareChangeSetPath(actionBody.data.proposalId))).status()).toBe(401);
    const publicBase = `${origin}/api/public/projects/${projectId}/modules/publishing/share/${encodeURIComponent(actionBody.data.token)}`;
    await approveAndApply(actionBody.data, async () => {
      expect((await readerContext.request.get(publicBase)).status()).toBe(404);
    });

    const catalogueResponse = await readerContext.request.get(publicBase);
    expect(catalogueResponse.ok(), await catalogueResponse.text()).toBe(true);
    const catalogue = await catalogueResponse.json() as {
      sceneCount: number;
      rootScenes: Array<{ id: string; title: string }>;
      tree: unknown[];
    };
    expect(catalogue.sceneCount).toBe(1);
    expect(catalogue.rootScenes).toEqual([{ id: rootScene.document.id, title: "同じタイトル" }]);
    expect(catalogue.tree).toEqual([]);
    await expect.poll(() => publicReaderRequests.length).toBeGreaterThan(0);
    expect(publicReaderRequests.every((requestOrigin) => requestOrigin === publicReaderOrigin.origin)).toBe(true);
    await readerPage.goto(issuedUrl.toString());
    const selected = await readerContext.request.get(`${publicBase}/scenes/${encodeURIComponent(rootScene.document.id)}`);
    expect(selected.ok(), await selected.text()).toBe(true);
    expect(await selected.json()).toMatchObject({ id: rootScene.document.id, body: "ROOT-ONLY BODY\n" });
    const other = await readerContext.request.get(`${publicBase}/scenes/${encodeURIComponent(chapterScene.document.id)}`);
    expect(other.status()).toBe(404);
    const secondChapterScene = await readerContext.request.get(`${publicBase}/scenes/${encodeURIComponent(otherChapterScene.document.id)}`);
    expect(secondChapterScene.status()).toBe(404);
    await expect(readerPage.getByRole("region", { name: "作品直下のシーン" }).getByRole("button")).toHaveText("同じタイトル");
    await readerPage.getByRole("button", { name: "同じタイトル", exact: true }).click();
    await expect(readerPage.getByText("ROOT-ONLY BODY")).toBeVisible();
    await expect(readerPage.getByText("CHAPTER-ONLY BODY")).toHaveCount(0);

    const shortExpiryResponse = await author.fetch(`${origin}/api/projects/${projectId}/actions/publishing.shares.create`, {
      method: "POST",
      data: { input: { kind: "scene", id: rootScene.document.id, label: "短時間リンク", expiresInHours: 0.005 } },
    });
    expect(shortExpiryResponse.ok(), await shortExpiryResponse.text()).toBe(true);
    const shortExpiryAction = await shortExpiryResponse.json() as {
      data: ShareProposal & { token: string; share: { id: string; expiresAt: string } };
    };
    await approveAndApply(shortExpiryAction.data);
    const shortExpiryUrl = new URL(`/r/publishing/${projectId}/${shortExpiryAction.data.token}`, publicReaderOrigin.origin);
    const shortExpiryBase = `${origin}/api/public/projects/${projectId}/modules/publishing/share/${encodeURIComponent(shortExpiryAction.data.token)}`;
    expect((await readerContext.request.get(shortExpiryBase)).ok()).toBe(true);
    await page.waitForTimeout(Math.max(0, Date.parse(shortExpiryAction.data.share.expiresAt) - Date.now() + 100));
    await readerPage.goto(shortExpiryUrl.toString());
    await expect(readerPage.getByRole("alert")).toContainText("共有リンクは無効か、期限切れです。");
    const expiredListResponse = await author.fetch(`${origin}/api/projects/${projectId}/actions/publishing.shares.list`, {
      method: "POST", data: { input: {} },
    });
    expect(expiredListResponse.ok(), await expiredListResponse.text()).toBe(true);
    const expiredList = await expiredListResponse.json() as { data: { shares: Array<{ id: string; active: boolean }> } };
    expect(expiredList.data.shares.find((share) => share.id === shortExpiryAction.data.share.id)?.active).toBe(false);

    const revokeResponse = await author.fetch(`${origin}/api/projects/${projectId}/actions/publishing.shares.revoke`, {
      method: "POST", data: { input: { id: actionBody.data.share.id } },
    });
    expect(revokeResponse.ok(), await revokeResponse.text()).toBe(true);
    const revokeAction = await revokeResponse.json() as { data: ShareProposal };
    expect((await readerContext.request.get(publicBase)).ok(), "proposed revocation does not affect the published snapshot").toBe(true);
    await approveAndApply(revokeAction.data, async () => {
      expect((await readerContext.request.get(publicBase)).ok()).toBe(true);
    });
    await readerPage.goto(issuedUrl.toString());
    await expect(readerPage.getByRole("alert")).toContainText("共有リンクは無効か、期限切れです。");
    const revokedListResponse = await author.fetch(`${origin}/api/projects/${projectId}/actions/publishing.shares.list`, {
      method: "POST", data: { input: {} },
    });
    expect(revokedListResponse.ok(), await revokedListResponse.text()).toBe(true);
    const revokedList = await revokedListResponse.json() as { data: { shares: Array<{ id: string; active: boolean; revokedAt?: string }> } };
    const revokedShare = revokedList.data.shares.find((share) => share.id === actionBody.data.share.id);
    expect(revokedShare?.active).toBe(false);
    expect(revokedShare?.revokedAt).toBeTruthy();
  } finally {
    await readerContext.close();
  }
});
