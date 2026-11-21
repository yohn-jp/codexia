import { expect, request, test, type Page } from "@playwright/test";
import { createHash, randomUUID } from "node:crypto";
import { text as readStreamText } from "node:stream/consumers";
import { authToken, expectDeviceDraft, expectNoUnsavedDeviceChanges, expectServerSaved, ownerLogin, manuscriptEditor as editor, readManuscriptMarkdown, openRevisionHistory } from "./postgres-fixture";

const rootPath = "/api/v1/persistence/projects";
const appBaseURL = process.env.CODEXIA_E2E_BASE_URL ?? process.env.CODEXIA_BASE_URL ?? `http://127.0.0.1:${process.env.CODEXIA_E2E_PORT ?? "4173"}`;
const appOrigin = new URL(appBaseURL).origin;
interface Draft { key: string; projectId: string; documentId: string; authorScope: string; markdown: string; generation: number; baseRevisionId: string; baseMarkdown: string; pendingSave?: { markdown: string }; version: number; updatedAt: number }
interface Read { document: { id: string; title: string; headRevisionId: string }; revision: { id: string; markdown: string } }
interface Fixture { projectId: string; one: Read; two: Read }
const documentPath = (fixture: Fixture, documentId = fixture.one.document.id) => `${rootPath}/${fixture.projectId}/documents/${documentId}`;
const mutationHeaders = (headers: Record<string, string> = {}): Record<string, string> => ({ Origin: appOrigin, ...headers });
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

async function fixture(page: Page): Promise<Fixture> {
  const login = await page.request.post("/api/login", { headers: mutationHeaders(), data: { token: authToken } });
  expect(login.ok()).toBe(true);
  const projectResponse = await page.request.post(rootPath, { headers: mutationHeaders(), data: { title: `Core acceptance ${randomUUID()}` } });
  expect(projectResponse.status()).toBe(201);
  const { project } = await projectResponse.json() as { project: { id: string } };
  const createDocument = async (title: string, orderKey: string): Promise<Read> => {
    const response = await page.request.post(`${rootPath}/${project.id}/documents`, { headers: mutationHeaders({ "Idempotency-Key": randomUUID() }), data: { title, kind: "scene", orderKey, markdown: `# ${title}\n\nInitial ${title} text.\n` } });
    expect(response.status()).toBe(201);
    return response.json() as Promise<Read>;
  };
  const one = await createDocument("Scene One", "a");
  const two = await createDocument("Scene Two", "b");
  await ownerLogin(page);
  await page.goto(`/desktop/projects/${project.id}/scenes/${one.document.id}`);
  await expect(page).toHaveURL(new RegExp(`/desktop/projects/${project.id}/scenes/${one.document.id}`));
  await expectEditor(page, one.revision.markdown);
  return { projectId: project.id, one, two };
}

async function read(page: Page, f: Fixture, documentId = f.one.document.id): Promise<Read> {
  const response = await page.request.get(documentPath(f, documentId));
  expect(response.ok()).toBe(true);
  return response.json() as Promise<Read>;
}
async function replace(page: Page, f: Fixture, markdown: string, base?: Read): Promise<Read> {
  const current = base ?? await read(page, f);
  const response = await page.request.patch(documentPath(f), { headers: mutationHeaders({ "Idempotency-Key": randomUUID(), "X-Client-Id": "acceptance-external" }), data: { baseRevisionId: current.revision.id, changes: [{ fromUtf16: 0, toUtf16: current.revision.markdown.length, insert: markdown }], resultingSha256: createHash("sha256").update(markdown).digest("hex"), clientId: "acceptance-external" } });
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
  await expect.poll(async () => (await read(page, f)).revision.markdown).toBe(text);
  await expectServerSaved(page);
}
async function reopen(page: Page, f: Fixture): Promise<void> {
  await page.goto(`/desktop/projects/${f.projectId}/scenes/${f.one.document.id}`);
  await expect(page).toHaveURL(new RegExp(`/desktop/projects/${f.projectId}/scenes/${f.one.document.id}`));
  await expect(editor(page)).toBeVisible();
}
async function restart(page: Page): Promise<void> {
  const control = new URL(page.url()); control.port = String(Number(control.port) + 1); control.pathname = "/__e2e/restart-api";
  const response = await fetch(control, { method: "POST" }); expect(response.status).toBe(204);
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

// Each former Git lifecycle scenario below now exercises the corresponding PostgreSQL
// revision, browser recovery, or explicit removal boundary. No Git fixture is created.

for (const recoverPendingSave of [false, true]) {
  test(`a save protects a confirmed quote between separate editor changes${recoverPendingSave ? " after recovering a lost save response" : ""}`, async ({ page }) => {
    const f = await fixture(page);
    const { revision } = await replace(page, f, "A引用Z");
    const anchorPath = `${documentPath(f)}/anchors`;
    const anchor = await page.request.post(anchorPath, {
      headers: mutationHeaders(),
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
      await page.reload();
    }
    await saved(page, f, "X引用Y");

    const response = await page.request.get(anchorPath);
    expect(response.ok()).toBe(true);
    expect((await response.json()).anchors).toMatchObject([
      { anchor: { fromUtf16: 1, toUtf16: 3, status: "confirmed" }, quote: "引用" },
    ]);
  });
}

test("appearance modes follow system preference initially and persist explicit light, dark, and paper choices", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" }); await ownerLogin(page);
  await expect(page.locator("html")).toHaveAttribute("data-zp-theme", "light");
  for (const theme of ["dark", "paper", "light"]) {
    await page.getByLabel("外観").selectOption(theme);
    await expect(page.locator("html")).toHaveAttribute("data-zp-theme", theme);
    await page.reload(); await expect(page.getByLabel("外観")).toHaveValue(theme);
  }
});

test("revision history keeps immutable content through a foreground refresh", async ({ page }) => {
  const f = await fixture(page); const text = "Saved immutable version.";
  await editor(page).click();
  await editor(page).press("ControlOrMeta+a");
  await page.keyboard.insertText(text);
  await saved(page, f, text);
  await openRevisionHistory(page);
  await expect(page.getByRole("region", { name: "Revision履歴" })).toContainText(f.one.revision.markdown.trim());
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect(page.getByRole("region", { name: "Revision履歴" })).toContainText(text);
  expect((await page.request.get(`${documentPath(f)}?revision=${f.one.revision.id}`)).ok()).toBe(true);
});

test("same-origin stale tabs cannot replace an equal-generation journal draft", async ({ page, context }) => {
  const f = await fixture(page); const gate = await holdSaves(page, f);
  const second = await context.newPage(); await second.goto(page.url());
  await second.getByLabel("作品", { exact: true }).selectOption(f.projectId); await second.locator(".pg-document-list").getByRole("treeitem", { name: /Scene One/ }).click();
  try {
    await editor(page).fill("First tab protected draft.");
    await expect.poll(async () => (await drafts(page)).some((d) => d.markdown === "First tab protected draft.")).toBe(true);
    await editor(second).fill("Stale tab different draft.");
    await expect(second.getByRole("alert")).toContainText("別タブ");
    expect((await drafts(page)).find((d) => d.documentId === f.one.document.id)?.markdown).toBe("First tab protected draft.");
  } finally { gate.release(); await second.close(); }
});

test("IME composition blocks navigation while coalesced editor state stays current for print and history", async ({ page }) => {
  const f = await fixture(page);
  await page.evaluate(() => {
    window.print = () => {
      document.documentElement.dataset.printedManuscript = document.querySelector(".pg-print-manuscript")?.textContent ?? "";
    };
  });
  const text = "Printed from the newest editor input."; await replaceEditor(page, text);
  await editor(page).evaluate((element) => element.dispatchEvent(new CompositionEvent("compositionstart", { data: "にほんご", bubbles: true })));
  await page.locator(".pg-document-list").getByRole("treeitem", { name: /Scene Two/ }).click();
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

test("exact revision acknowledgement removes its draft without reviving deleted recovery on reload", async ({ page }) => {
  const f = await fixture(page); const text = "Acknowledged durable draft.";
  await replaceEditor(page, text);
  await expectEditor(page, text);
  await saved(page, f, text);
  await expect.poll(async () => (await drafts(page)).filter((d) => d.documentId === f.one.document.id)).toEqual([]);
  await reopen(page, f); await expectEditor(page, text);
  expect((await drafts(page)).filter((d) => d.documentId === f.one.document.id)).toEqual([]);
});

test("a committed save with a lost response is reconciled after reload with the same operation identity", async ({ page }) => {
  const f = await fixture(page);
  const text = "Committed before its response was lost.";
  const before = await read(page, f);
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
  await page.reload();
  await expectEditor(page, text);
  await expect.poll(() => requests.length).toBe(2);
  await saved(page, f, text);
  expect(requests[1]).toEqual(requests[0]);
  const after = await read(page, f);
  expect(after.revision.id).not.toBe(before.revision.id);
  expect((await drafts(page)).filter((draft) => draft.documentId === f.one.document.id)).toEqual([]);
});

test("replaying a saved operation after a newer remote revision shows the current head", async ({ page }) => {
  const f = await fixture(page);
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
  await replace(page, f, remote);
  await page.reload();
  await expectEditor(page, remote);
  await expectServerSaved(page);
  expect(requests).toHaveLength(2);
  expect(requests[1]).toEqual(requests[0]);
  const latest = await read(page, f);
  expect(latest.revision.markdown).toBe(remote);
  expect((await drafts(page)).filter((draft) => draft.documentId === f.one.document.id)).toEqual([]);
});

test("a lost save response survives newer input, reloads, and rebases the newer draft after acknowledgement", async ({ page }) => {
  const f = await fixture(page);
  const submitted = "Submitted B before newer input.";
  const newer = "Newer C entered while B was saving.";
  const before = await read(page, f);
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
  await page.reload();
  await expectEditor(page, newer);
  await saved(page, f, newer);
  expect(requests).toHaveLength(3);
  expect(requests[1]).toEqual(requests[0]);
  expect(requests[2]?.idempotencyKey).not.toBe(requests[0]?.idempotencyKey);
  expect(requests[2]?.body).not.toBe(requests[0]?.body);
  const after = await read(page, f);
  expect(after.revision.markdown).toBe(newer);
  const revisionResponse = await page.request.get(`${documentPath(f)}/revisions?limit=50`);
  expect(revisionResponse.ok()).toBe(true);
  const revisionPage = await revisionResponse.json() as { revisions: Array<{ id: string; markdown: string }> };
  expect(revisionPage.revisions).toHaveLength(3);
  expect(revisionPage.revisions.map((revision) => revision.markdown)).toContain(submitted);
  expect(revisionPage.revisions.map((revision) => revision.markdown)).toContain(newer);
  expect((await drafts(page)).filter((draft) => draft.documentId === f.one.document.id)).toEqual([]);
  expect(after.revision.id).not.toBe(before.revision.id);
});

test("a newer draft stays protected when a replayed save is already superseded remotely", async ({ page }) => {
  const f = await fixture(page);
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
  await replace(page, f, remote);
  release();
  await lostPromise;
  await page.reload();
  await expect(page.getByRole("heading", { name: "Revision競合" })).toBeVisible();
  await expectEditor(page, newer);
  await expect.poll(async () => (await drafts(page)).find((draft) => draft.documentId === f.one.document.id)?.pendingSave).toBeUndefined();
  expect(requests).toHaveLength(2);
  expect(requests[1]).toEqual(requests[0]);
  expect((await read(page, f)).revision.markdown).toBe(remote);
  const draft = (await drafts(page)).find((entry) => entry.documentId === f.one.document.id);
  expect(draft).toMatchObject({ markdown: newer, baseRevisionId: f.one.revision.id, baseMarkdown: f.one.revision.markdown });
});

test("undoing an autosave draft back to the saved revision removes only that draft and never sends it", async ({ page }) => {
  const f = await fixture(page);
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
  await page.locator(".pg-document-list").getByRole("treeitem", { name: /Scene Two/ }).click();
  await expect(page.getByRole("heading", { name: "Scene Two", exact: true })).toBeVisible();
  await page.locator(".pg-document-list").getByRole("treeitem", { name: /Scene One/ }).click();
  await expectEditor(page, savedMarkdown);
  await expect.poll(async () => (await drafts(page)).filter((d) => d.documentId === f.one.document.id)).toEqual([]);
  await page.clock.fastForward(1_100);
  expect(patchBodies).toEqual([]);
  await page.reload();
  await expectEditor(page, savedMarkdown);
  expect((await drafts(page)).filter((d) => d.documentId === f.one.document.id)).toEqual([]);
  await page.clock.fastForward(1_100);
  expect(patchBodies).toEqual([]);
  expect((await read(page, f)).revision).toEqual(f.one.revision);
});

test("undo cleanup cannot remove a higher-generation draft written by another tab", async ({ page, context }) => {
  const f = await fixture(page);
  await pauseAutosaveClock(page);
  const savedMarkdown = f.one.revision.markdown;
  await replaceEditor(page, "First tab temporary draft.");
  await expect.poll(async () => (await drafts(page)).find((d) => d.documentId === f.one.document.id)?.markdown).toBe("First tab temporary draft.");

  // The Playwright clock belongs to the browser context, so the second
  // tab inherits it without advancing the first tab's pending autosave.
  const second = await context.newPage();
  await second.goto(page.url());
  await expectEditor(second, "First tab temporary draft.");
  await replaceEditor(second, "Newer second-tab draft.");
  await expect.poll(async () => (await drafts(second)).find((d) => d.documentId === f.one.document.id)?.markdown).toBe("Newer second-tab draft.");

  await replaceEditor(page, savedMarkdown);
  await expectEditor(page, savedMarkdown);
  await expect.poll(async () => (await drafts(page)).find((d) => d.documentId === f.one.document.id)?.markdown).toBe("Newer second-tab draft.");
  await expect(page.locator(".pg-save-state")).toContainText("別タブに下書きがあります");
  await second.close();
});

test("undo during an in-flight save preserves the request and saves the restored text afterward", async ({ page }) => {
  const f = await fixture(page);
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

test("writing UI protects multiple document drafts separately from PostgreSQL revision durability", async ({ page }) => {
  const f = await fixture(page); const gate = await holdSaves(page, f);
  try {
    await replaceEditor(page, "Scene One protected draft.");
    await expectEditor(page, "Scene One protected draft.");
    // Establish the exact durable recovery record and an in-flight, unacknowledged
    // PostgreSQL save before switching documents.
    await expect.poll(async () => (await drafts(page)).some((d) => d.documentId === f.one.document.id && d.markdown === "Scene One protected draft.")).toBe(true);
    await gate.seen;
    await page.locator(".pg-document-list").getByRole("treeitem", { name: /Scene Two/ }).click();
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
    await page.locator(".pg-document-list").getByRole("treeitem", { name: /Scene One/ }).click();
    await expectEditor(page, "Scene One protected draft.");
  } finally { gate.release(); }
});

test("new typing survives an older in-flight PostgreSQL save and exact acknowledgement", async ({ page }) => {
  const f = await fixture(page); const gate = await holdSaves(page, f);
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

test("new typing survives recovery against a newer PostgreSQL base revision", async ({ page }) => {
  const f = await fixture(page); const gate = await holdSaves(page, f);
  const writes: string[] = [];
  page.on("request", (request) => { if (request.method() === "PATCH" && request.url().includes(documentPath(f))) writes.push(request.url()); });
  try {
    await editor(page).fill("Recovered draft before competing revision."); await gate.seen;
    await replace(page, f, "Competing PostgreSQL revision.");
    await editor(page).fill("Newest input before conflict arrives."); gate.release();
    await expect(page.getByRole("heading", { name: "Revision競合" })).toBeVisible();
    await expectEditor(page, "Newest input before conflict arrives.");
    await expect.poll(async () => (await drafts(page)).find((draft) => draft.documentId === f.one.document.id)?.pendingSave).toBeUndefined();
    const writesBeforeReload = writes.length;
    await page.reload();
    await expect(page.getByRole("heading", { name: "Revision競合" })).toBeVisible();
    await expectEditor(page, "Newest input before conflict arrives.");
    expect(writes).toHaveLength(writesBeforeReload);
    await page.getByRole("button", { name: "比較後、この回復Draftを最新版へ適用" }).click();
    await saved(page, f, "Newest input before conflict arrives.");
  } finally { gate.release(); }
});

test("browser recovery is author-scoped and foreign records remain untouched", async ({ page }) => {
  const f = await fixture(page); const foreign: Draft = { version: 1, key: JSON.stringify(["foreign-author", f.projectId, f.one.document.id]), projectId: f.projectId, documentId: f.one.document.id, authorScope: "foreign-author", baseRevisionId: f.one.revision.id, baseMarkdown: f.one.revision.markdown, markdown: "Foreign private draft.", generation: 100, updatedAt: Date.now() };
  await writeRecords(page, [foreign]); await reopen(page, f);
  await expect(editor(page)).not.toHaveText(foreign.markdown);
  expect((await drafts(page)).find((d) => d.key === foreign.key)).toEqual(foreign);
});

test("one malformed legacy key does not hide later recoverable PostgreSQL drafts", async ({ page }) => {
  const f = await fixture(page); const gate = await holdSaves(page, f);
  try {
    await editor(page).fill("Valid protected draft after malformed entry.");
    await expect.poll(async () => (await drafts(page)).some((d) => d.markdown === "Valid protected draft after malformed entry.")).toBe(true);
    await writeRecords(page, [{ key: "malformed-legacy-key", version: 0, markdown: "Untrusted legacy content" }]);
    await reopen(page, f); await expectEditor(page, "Valid protected draft after malformed entry.");
    expect((await drafts(page)).some((d) => d.key === "malformed-legacy-key")).toBe(true);
  } finally { gate.release(); }
});

async function submitProposal(page: Page, f: Fixture): Promise<{ id: string; operation: Record<string, unknown>; generated: string }> {
  const snapshotResponse = await page.request.get(`/api/projects/${f.projectId}/snapshot`); expect(snapshotResponse.ok()).toBe(true);
  const { snapshot, files } = await snapshotResponse.json() as { snapshot: { projectId: string; projectVersion: number }; files: Array<{ path: string; revision: string; content: string }> };
  const path = `documents/${f.one.document.id}.md`;
  const current = files.find((file) => file.path === path);
  if (!current) throw new Error(`PostgreSQL snapshot omitted the document path ${path}`);
  const generated = `${current.content}\nMCP proposal requires explicit author approval.\n`;
  const operation = { id: `mcp-op-${randomUUID()}`, generation: 1, projectId: f.projectId, baseProjectVersion: snapshot.projectVersion, effect: "manuscript", reads: [{ path, revision: current.revision }], writes: [{ path, revision: current.revision, content: generated }], message: "MCP acceptance proposal" };
  const id = `mcp-${randomUUID()}`;
  const external = await request.newContext({ baseURL: appBaseURL });
  let responseBody: unknown;
  let status: number;
  try {
    const response = await external.post(`/api/projects/${f.projectId}/proposals`, { headers: mutationHeaders({ Authorization: `Bearer ${authToken}` }), data: { id, snapshot, operations: [operation] } });
    status = response.status(); responseBody = await response.json();
  } finally { await external.dispose(); }
  expect(status!, JSON.stringify(responseBody)).toBe(201); expect(responseBody).toMatchObject({ id, source: "mcp" });
  return { id, operation, generated };
}

test("external MCP proposals require owner approval before PostgreSQL application", async ({ page }) => {
  const f = await fixture(page); const proposal = await submitProposal(page, f);
  const before = await page.request.get(`/api/projects/${f.projectId}/proposals/${proposal.id}`);
  expect(await before.json()).toMatchObject({ state: "proposed", approvedOperationIds: [] });
  const denied = await page.request.post(`/api/projects/${f.projectId}/apply`, { headers: mutationHeaders(), data: proposal.operation }); expect(denied.ok()).toBe(false);
  expect((await read(page, f)).revision.id).toBe(f.one.revision.id);
  const approval = await page.request.post(`/api/projects/${f.projectId}/approvals`, { headers: mutationHeaders(), data: { proposalId: proposal.id, operationIds: [proposal.operation.id] } }); expect(approval.status()).toBe(204);
  const applied = await page.request.post(`/api/projects/${f.projectId}/apply`, { headers: mutationHeaders(), data: proposal.operation }); expect(applied.status()).toBe(201);
  expect((await read(page, f)).revision.markdown).toBe(proposal.generated);
  await reopen(page, f); await expectEditor(page, proposal.generated);
});

test("full MCP proposal payload and approval state survive Core process and cache loss", async ({ page }) => {
  const f = await fixture(page); const proposal = await submitProposal(page, f);
  const path = `/api/projects/${f.projectId}/proposals/${proposal.id}`;
  const approval = await page.request.post(`/api/projects/${f.projectId}/approvals`, { headers: mutationHeaders(), data: { proposalId: proposal.id, operationIds: [proposal.operation.id] } });
  expect(approval.status()).toBe(204);
  const before = await (await page.request.get(path)).json();
  expect(before).toMatchObject({ state: "approved", approvedOperationIds: [proposal.operation.id] });
  await restart(page); await ownerLogin(page);
  const after = await page.request.get(path); expect(after.ok()).toBe(true); expect(await after.json()).toEqual(before);
  expect((await read(page, f)).revision.id).toBe(f.one.revision.id);
  await reopen(page, f); await expectEditor(page, f.one.revision.markdown);
});

test("a PostgreSQL update during author approval keeps the conflicting editor draft visible", async ({ page }) => {
  const f = await fixture(page); const proposal = await submitProposal(page, f); const gate = await holdSaves(page, f);
  try {
    await replaceEditor(page, "Author input must survive rejected approval."); await gate.seen;
    await replace(page, f, "Another writer advanced the project.");
    const approval = await page.request.post(`/api/projects/${f.projectId}/approvals`, { headers: mutationHeaders(), data: { proposalId: proposal.id, operationIds: [proposal.operation.id] } }); expect(approval.status()).toBe(204);
    const applied = await page.request.post(`/api/projects/${f.projectId}/apply`, { headers: mutationHeaders(), data: proposal.operation }); expect(applied.status()).toBe(409);
    gate.release(); await expect(page.getByRole("heading", { name: "Revision競合" })).toBeVisible();
    await expectEditor(page, "Author input must survive rejected approval.");
    expect((await read(page, f)).revision.markdown).toBe("Another writer advanced the project.");
  } finally { gate.release(); }
});

test("IndexedDB quota failures remain visible and block PostgreSQL writes", async ({ page }) => {
  await page.addInitScript(() => {
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
      if (this.name === "persistenceDrafts") throw new DOMException("Acceptance quota failure", "QuotaExceededError");
      return key === undefined ? put.call(this, value) : put.call(this, value, key);
    };
  });
  const f = await fixture(page); let remoteWrites = 0;
  page.on("request", (request) => { if (request.method() === "PATCH" && new URL(request.url()).pathname === documentPath(f)) remoteWrites += 1; });
  await editor(page).fill("Unsaved text must remain visible after quota failure.");
  await expect(page.getByRole("alert")).toContainText(/quota|容量|保存|database draft/i);
  await expect(page.getByRole("button", { name: /今すぐ保存|PostgreSQLへ再試行/ })).toBeDisabled();
  expect(remoteWrites).toBe(0); expect((await read(page, f)).revision.id).toBe(f.one.revision.id);
  await expectEditor(page, "Unsaved text must remain visible after quota failure.");
});

test("project reconstruction retains PostgreSQL revisions and removed Git lifecycle has no fallback", async ({ page }) => {
  const f = await fixture(page); const text = "Survives process reconstruction.";
  await editor(page).fill(text); await saved(page, f, text); const revision = (await read(page, f)).revision.id;
  await restart(page); await ownerLogin(page); await reopen(page, f); await expectEditor(page, text);
  expect((await read(page, f)).revision.id).toBe(revision);
  for (const suffix of ["publish", "reconcile", "checkpoints"]) {
    const result = await page.request.post(`/api/projects/${f.projectId}/${suffix}`, { headers: mutationHeaders(), data: {} }); expect(result.ok()).toBe(false);
  }
  await expect(page.getByRole("button", { name: "Save to GitHub" })).toHaveCount(0);
  await expect(page.getByLabel("GitHub リポジトリ URL")).toHaveCount(0);
});

test("unmounting a contribution aborts its in-flight action request", async ({ page }) => {
  test.skip(process.env.CODEXIA_PROFILE !== "full", "The publishing contribution is selected by the full profile.");
  const f = await fixture(page); let observed!: (request: import("@playwright/test").Request) => void;
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
    await expect(page.getByRole("heading", { name: "作品を開く" })).toBeVisible(); expect((await failed).failure()).not.toBeNull();
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

test("a pending scratch image read is flushed to its captured document before navigation", async ({ page }) => {
  await delayImages(page); const f = await fixture(page); await scratch(page);
  await memo(page).fill("Attachment belongs to Scene One."); await image(page).setInputFiles(png);
  await page.locator(".pg-document-list").getByRole("treeitem", { name: /Scene Two/ }).click();
  await expect(page.getByRole("heading", { name: "Scene Two", exact: true })).toBeVisible();
  await expect.poll(async () => (await scratchRecords(page)).some((r) => r.key.includes(f.one.document.id) && r.text.includes("Attachment belongs to Scene One.") && r.text.includes("data:image/png;base64"))).toBe(true);
  expect((await scratchRecords(page)).some((r) => r.key.includes(f.two.document.id) && r.text.includes("Attachment belongs to Scene One."))).toBe(false);
});

test("saving a scratch note replays the same request after its committed response is lost", async ({ page }) => {
  const f = await fixture(page);
  await scratch(page);
  await memo(page).fill("Scratch text survives an ambiguous note save.");
  await image(page).setInputFiles(png);
  await expect.poll(async () => (await scratchRecords(page)).find((record) => record.key.includes(f.one.document.id))?.text).toContain(png.name);

  let attempts = 0;
  const requests: Array<{ key: string | undefined; body: unknown }> = [];
  await page.route(`**${documentPath(f).slice(0, documentPath(f).lastIndexOf("/"))}`, async (route) => {
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

  const save = page.locator(".scratch-panel").getByRole("button", { name: "ノートとしてPostgreSQLへ保存" });
  await save.click();
  await expect(page.locator(".scratch-panel").getByRole("alert")).toBeVisible();
  await expect(memo(page)).toHaveValue("Scratch text survives an ambiguous note save.");
  await expect(page.locator(".scratch-panel").getByRole("img", { name: png.name })).toBeVisible();
  await memo(page).fill("A newer scratch draft stays separate from the pending note.");
  await page.locator(".scratch-panel").getByRole("button", { name: "前のノート保存を照合", exact: true }).click();
  await expect(page.locator(".scratch-panel").getByRole("alert")).toHaveCount(0);
  expect(attempts).toBe(2);
  expect(requests[1]).toEqual(requests[0]);
  await expect(memo(page)).toHaveValue("A newer scratch draft stays separate from the pending note.");

  await save.click();
  await expect.poll(() => attempts).toBe(3);
  await expect(page.locator(".scratch-panel").getByRole("alert")).toHaveCount(0);
  expect(requests[2]?.key).not.toBe(requests[0]?.key);
  expect((requests[2]?.body as { markdown: string }).markdown).toContain("A newer scratch draft stays separate from the pending note.");

  const documents = await page.request.get(`${documentPath(f).slice(0, documentPath(f).lastIndexOf("/"))}?limit=1000&parentId=${f.one.document.id}`);
  expect(documents.ok()).toBe(true);
  const children = await documents.json() as { documents: Array<{ id: string; kind: string; title: string }> };
  const notes = children.documents.filter((document) => document.kind === "note" && document.title === "スクラッチ");
  expect(notes).toHaveLength(2);
  const noteBodies = await Promise.all(notes.map(async (item) => {
    const note = await page.request.get(`${documentPath(f).slice(0, documentPath(f).lastIndexOf("/"))}/${item.id}`);
    expect(note.ok()).toBe(true);
    const noteRead = await note.json() as { revision: { markdown: string } };
    return noteRead.revision.markdown;
  }));
  expect(noteBodies.some((markdown) => markdown.includes("Scratch text survives an ambiguous note save.") && markdown.includes("data:image/png;base64"))).toBe(true);
  expect(noteBodies.some((markdown) => markdown.includes("A newer scratch draft stays separate from the pending note."))).toBe(true);
});

test("a pending scratch note remains reconcilable after its editable draft is cleared", async ({ page }) => {
  const f = await fixture(page);
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

  const documents = await page.request.get(`${collectionPath}?limit=1000&parentId=${f.one.document.id}`);
  const children = await documents.json() as { documents: Array<{ kind: string; title: string }> };
  expect(children.documents.filter((document) => document.kind === "note" && document.title === "スクラッチ")).toHaveLength(1);
});

test("scratch still protects text and accepts a new image after an oversized attachment", async ({ page }) => {
  const f = await fixture(page);
  await scratch(page);
  await image(page).setInputFiles(png);
  const attachment = page.locator(".scratch-panel").getByRole("img", { name: png.name });
  await expect(attachment).toBeVisible();
  await image(page).setInputFiles({ name: "too-large.png", mimeType: "image/png", buffer: Buffer.alloc(3 * 1024 * 1024 + 1) });
  await expect(page.locator(".scratch-panel").getByRole("alert")).toContainText("3MB以下");
  await memo(page).fill("Scratch remains usable after a rejected attachment.");
  await page.locator(".pg-document-list").getByRole("treeitem", { name: /Scene Two/ }).click();
  await expect(page.getByRole("heading", { name: "Scene Two", exact: true })).toBeVisible();
  await page.locator(".pg-document-list").getByRole("treeitem", { name: /Scene One/ }).click();
  await expect(page.getByRole("heading", { name: "Scene One", exact: true })).toBeVisible();
  await scratch(page);
  await expect(memo(page)).toHaveValue("Scratch remains usable after a rejected attachment.");
  await expect(attachment).toBeVisible();
  await image(page).setInputFiles({ ...png, name: "replacement.png" });
  await expect(page.locator(".scratch-panel").getByRole("img", { name: "replacement.png" })).toBeVisible();
  await expect.poll(async () => (await scratchRecords(page)).find((r) => r.key.includes(f.one.document.id))?.text).toContain("replacement.png");
});

test("an untouched or stale tab cannot overwrite protected scratch text and images", async ({ page, context }) => {
  const f = await fixture(page);
  const second = await context.newPage();
  try {
    await second.goto(page.url());
    await expectEditor(second, f.one.revision.markdown);
    await scratch(second);
    await expect(memo(second)).toBeEnabled();
    await scratch(page);
    await memo(page).fill("First tab's protected text.");
    await image(page).setInputFiles(png);
    await expect.poll(async () => (await scratchRecords(page)).find((r) => r.key.includes(f.one.document.id))?.text).toContain(png.name);
    await second.getByRole("button", { name: "読む", exact: true }).click();
    await expect(second.getByRole("region", { name: "原稿の閲覧" })).toBeVisible();
    await second.reload();
    await expectEditor(second, f.one.revision.markdown);
    await scratch(second);
    await expect(memo(second)).toHaveValue("First tab's protected text.");
    await expect(second.locator(".scratch-panel").getByRole("img", { name: png.name })).toBeVisible();

    await memo(page).fill("First tab's newer protected text.");
    await expect.poll(async () => (await scratchRecords(page)).find((r) => r.key.includes(f.one.document.id))?.text).toContain("newer protected text");
    await memo(second).fill("Second tab's stale edit.");
    await expect(second.locator(".scratch-panel").getByRole("alert")).toContainText("別タブ");
    await expect(memo(second)).toHaveValue("Second tab's stale edit.");
    await page.reload();
    await expectEditor(page, f.one.revision.markdown);
    await scratch(page);
    await expect(memo(page)).toHaveValue("First tab's newer protected text.");
    await expect(page.locator(".scratch-panel").getByRole("img", { name: png.name })).toBeVisible();
  } finally {
    await second.close();
  }
});

test("an unprotected scratch warns before reload and the protected other-tab value remains recoverable", async ({ page, context }) => {
  const f = await fixture(page);
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
    await second.goto(page.url());
    await expectEditor(second, f.one.revision.markdown);
    await scratch(page);
    await scratch(second);
    await memo(page).fill("Tab A protected scratch.");
    await expect.poll(async () => (await scratchRecords(page)).find((record) => record.key.includes(f.one.document.id))?.text).toContain("Tab A protected scratch.");

    await page.reload();
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
    await scratch(second);
    await expect(memo(second)).toHaveValue("Tab A protected scratch.");
    await second.reload();
    expect(secondDialogs).toBe(2);
    await scratch(second);
    await expect(memo(second)).toHaveValue("Tab A protected scratch.");
  } finally {
    await second.close();
  }
});

test("scratch storage failure warns before reload and keeps the last protected record", async ({ page }) => {
  const f = await fixture(page);
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

test("navigation does not replace a scratch record while it is loading or unreadable", async ({ page }) => {
  const f = await fixture(page);
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
  await page.reload();
  await expectEditor(page, f.one.revision.markdown);
  await scratch(page);
  await expect(memo(page)).toBeDisabled();
  await page.locator(".pg-document-list").getByRole("treeitem", { name: /Scene Two/ }).click();
  await expect(page.getByRole("heading", { name: "Scene Two", exact: true })).toBeVisible();
  expect(await record()).toMatchObject(original!);
  await page.evaluate(() => sessionStorage.removeItem("hold-scratch-read"));
  const unreadable = { ...original, text: "Malformed original recovery bytes" };
  await writeRecords(page, [unreadable], "pgScratch");
  await page.goto(`/desktop/projects/${f.projectId}/scenes/${f.one.document.id}`);
  await expectEditor(page, f.one.revision.markdown);
  await scratch(page);
  await expect(page.locator(".scratch-panel").getByRole("alert")).toBeVisible();
  await page.locator(".pg-document-list").getByRole("treeitem", { name: /Scene Two/ }).click();
  await expect(page.getByRole("heading", { name: "Scene Two", exact: true })).toBeVisible();
  expect(await record()).toMatchObject(unreadable);
});

test("resuming an older scratch generation cannot replace newer unprotected input", async ({ page }) => {
  await fixture(page); await scratch(page); await memo(page).fill("Protected older scratch generation.");
  await editor(page).click(); await expect.poll(async () => (await scratchRecords(page)).some((r) => r.text.includes("Protected older scratch generation."))).toBe(true);
  await memo(page).fill("Newer scratch input still inside debounce.");
  await page.locator(".scratch-panel").getByRole("button", { name: "続ける", exact: true }).click();
  await expect(memo(page)).toHaveValue("Newer scratch input still inside debounce.");
  await expect.poll(async () => (await scratchRecords(page)).some((r) => r.text.includes("Newer scratch input still inside debounce."))).toBe(true);
});

test("failed scratch protection refuses recovery selection and keeps the current error visible", async ({ page }) => {
  await fixture(page); await scratch(page); await memo(page).fill("Older protected scratch."); await editor(page).click();
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

test("resuming an older scratch entry waits for its pending image read and keeps the latest draft", async ({ page }) => {
  await delayImages(page); await fixture(page); await scratch(page);
  await memo(page).fill("Protected scratch before attachment."); await editor(page).click();
  await expect.poll(async () => (await scratchRecords(page)).some((r) => r.text.includes("Protected scratch before attachment."))).toBe(true);
  await memo(page).fill("Latest scratch with attachment."); await image(page).setInputFiles(png);
  await page.locator(".scratch-panel").getByRole("button", { name: "続ける", exact: true }).click();
  await expect(memo(page)).toHaveValue("Latest scratch with attachment.");
  await expect.poll(async () => (await scratchRecords(page)).some((r) => r.text.includes("Latest scratch with attachment.") && r.text.includes("data:image/png;base64"))).toBe(true);
});

test("scratch text and image input survive while navigation waits for protection", async ({ page }) => {
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
  await fixture(page); await scratch(page);
  await memo(page).fill("Previously protected scratch."); await editor(page).click();
  await expect.poll(async () => (await scratchRecords(page)).some((r) => r.text.includes("Previously protected scratch."))).toBe(true);
  await page.evaluate(() => { (window as Window & { __scratchProtectionGate?: { armed: boolean } }).__scratchProtectionGate!.armed = true; });
  await memo(page).fill("Scratch write held during navigation.");
  await page.waitForFunction(() => (window as Window & { __scratchProtectionGate?: { started: boolean } }).__scratchProtectionGate?.started === true);

  const sceneTwo = page.locator(".pg-document-list").getByRole("treeitem", { name: /Scene Two/ });
  await sceneTwo.click();
  await expect(page.getByRole("heading", { name: "Scene One", exact: true })).toBeVisible();
  await memo(page).fill("Latest scratch input during protection.");
  await image(page).setInputFiles(png);
  await page.waitForFunction(() => (window as Window & { __scratchImageReadStarted?: boolean }).__scratchImageReadStarted === true);
  await page.evaluate(() => (window as Window & { __scratchProtectionGate?: { release?: () => void } }).__scratchProtectionGate!.release?.());
  await expect.poll(async () => (await scratchRecords(page)).some((r) => r.text.includes("Latest scratch input during protection.") && r.text.includes("data:image/png;base64"))).toBe(true);
  await sceneTwo.click();
  await expect(page.getByRole("heading", { name: "Scene Two", exact: true })).toBeVisible();
});

test("public publishing route mounts its source reader without an owner session", async ({ page }) => {
  test.skip(process.env.CODEXIA_PROFILE !== "full", "The publishing browser module is selected by the full profile.");
  const ownerSessionRequests: string[] = []; const publicReadRequests: string[] = [];
  page.on("request", (request) => { const pathname = new URL(request.url()).pathname; if (pathname === "/api/session") ownerSessionRequests.push(pathname); if (pathname.startsWith("/api/public/projects/")) publicReadRequests.push(pathname); });
  const projectId = randomUUID(); await page.goto(`/r/publishing/${projectId}/e2e-invalid-token`);
  await expect(page.getByRole("heading", { name: "共有された原稿" })).toBeVisible();
  await expect(page.getByRole("alert")).toContainText("共有リンクは無効か、期限切れです。"); expect(ownerSessionRequests).toEqual([]);
  expect(publicReadRequests).toEqual([`/api/public/projects/${projectId}/modules/publishing/share/e2e-invalid-token`]);
});

test("a root-only public share renders selectable scenes without an owner session", async ({ page }) => {
  test.skip(process.env.CODEXIA_PROFILE !== "full", "The publishing browser module is selected by the full profile.");
  const projectId = randomUUID();
  const token = "share_" + "r".repeat(43);
  const base = `/api/public/projects/${projectId}/modules/publishing/share/${token}`;
  const requests: string[] = [];
  const ownerSessionRequests: string[] = [];
  page.on("request", (request) => {
    const pathname = new URL(request.url()).pathname;
    if (pathname === "/api/session") ownerSessionRequests.push(pathname);
  });
  await page.route(`**${base}**`, async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    requests.push(pathname);
    if (pathname === base) {
      await route.fulfill({ status: 200, json: {
        label: "Root scene preview", expiresAt: "2030-01-01T00:00:00Z",
        sceneCount: 1, rootScenes: [{ id: "root-scene", title: "作品直下のシーン" }], tree: [],
      } });
    } else if (pathname === `${base}/scenes/root-scene`) {
      await route.fulfill({ status: 200, json: {
        id: "root-scene", title: "作品直下のシーン", body: "作品直下の本文を表示します。",
      } });
    } else {
      await route.fulfill({ status: 404, json: { error: "Share link is unavailable" } });
    }
  });
  await page.goto(`/r/publishing/${projectId}/${token}`);
  await expect(page.getByRole("heading", { name: "Root scene preview" })).toBeVisible();
  await expect(page.getByRole("button", { name: "作品直下のシーン" })).toBeVisible();
  await page.getByRole("button", { name: "作品直下のシーン" }).click();
  await expect(page.getByText("作品直下の本文を表示します。")).toBeVisible();
  expect(requests).toEqual([base, `${base}/scenes/root-scene`]);
  expect(ownerSessionRequests).toEqual([]);
});

test("late document activation cannot replace explicit scene navigation", async ({ page }) => {
  const f = await fixture(page); let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; }); let observed!: () => void; const seen = new Promise<void>((resolve) => { observed = resolve; });
  await page.route(`**${documentPath(f)}`, async (route) => { if (route.request().method() !== "GET") return route.continue(); const response = await route.fetch(); observed(); await gate; await route.fulfill({ response }); });
  try {
    await page.locator(".pg-document-list").getByRole("treeitem", { name: /Scene Two/ }).click();
    await expect(page.getByRole("heading", { name: "Scene Two", exact: true })).toBeVisible();
    const sceneOne = page.locator(".pg-document-list").getByRole("treeitem", { name: /Scene One/ });
    await sceneOne.click(); await seen;
    await expect(sceneOne).toHaveAttribute("aria-current", "page");
    await page.locator(".pg-document-list").getByRole("treeitem", { name: /Scene Two/ }).click();
    await expect(page.getByRole("heading", { name: "Scene Two", exact: true })).toBeVisible(); release();
    await expectEditor(page, f.two.revision.markdown);
  } finally { release(); }
});

test("Issue 42: an updated PostgreSQL revision cannot supersede explicit navigation during draft flush", async ({ page }) => {
  const f = await fixture(page); const gate = await holdSaves(page, f);
  try {
    await editor(page).fill("Pending Scene One draft before explicit navigation."); await gate.seen; await replace(page, f, "External PostgreSQL version.");
    await page.locator(".pg-document-list").getByRole("treeitem", { name: /Scene Two/ }).click();
    await expectEditor(page, f.two.revision.markdown); gate.release();
    await expect(page.getByRole("heading", { name: "Scene Two", exact: true })).toBeVisible();
    await expect.poll(async () => (await drafts(page)).some((d) => d.documentId === f.one.document.id && d.markdown === "Pending Scene One draft before explicit navigation.")).toBe(true);
  } finally { gate.release(); }
});

test("Issue 42: an unchanged PostgreSQL observation leaves explicit scene selection alone", async ({ page }) => {
  const f = await fixture(page);
  await page.locator(".pg-document-list").getByRole("treeitem", { name: /Scene Two/ }).click();
  for (const name of ["online", "focus", "visibilitychange"]) await page.evaluate((event) => window.dispatchEvent(new Event(event)), name);
  await expect(page.getByRole("heading", { name: "Scene Two", exact: true })).toBeVisible();
  await expectEditor(page, f.two.revision.markdown);
  expect((await read(page, f)).revision.id).toBe(f.one.revision.id);
});

test("Issue 42: failed PostgreSQL availability preserves the author session and offers explicit retry", async ({ page }) => {
  const f = await fixture(page); let unavailable = true; let reauthCalls = 0;
  await page.route("**/api/v1/persistence/status", (route) => unavailable ? route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "PostgreSQL unavailable" }) }) : route.continue());
  await page.route("**/_platform/reauth", (route) => { reauthCalls += 1; return route.abort(); });
  await page.reload(); await expect(page.getByRole("heading", { name: "PostgreSQLへ接続できません" })).toBeVisible();
  expect((await page.request.get("/api/session")).status()).toBe(200); expect(reauthCalls).toBe(0);
  unavailable = false; await page.getByRole("button", { name: "再試行" }).click();
  await page.getByLabel("作品", { exact: true }).selectOption(f.projectId); await page.locator(".pg-document-list").getByRole("treeitem", { name: /Scene One/ }).click();
  await expectEditor(page, f.one.revision.markdown);
});

test("a project containing only root scenes can export its full text from the publishing panel", async ({ page }) => {
  test.skip(process.env.CODEXIA_PROFILE !== "full", "The publishing contribution is selected by the full profile.");
  const { one, two } = await fixture(page);
  const menu = page.locator(".st-workspace-panel-menu");
  await menu.locator("summary").click();
  await menu.getByRole("button", { name: "プレーンテキスト書き出しを表示", exact: true }).click();
  const panel = page.locator('[data-workspace-panel="module:publishing.export.plaintext"]');
  const download = panel.getByRole("button", { name: "テキストをダウンロード" });
  await expect(download).toBeEnabled();
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

test("publishing lists link states and chapter names independently of the new link selection", async ({ page }) => {
  test.skip(process.env.CODEXIA_PROFILE !== "full", "The publishing contribution is selected by the full profile.");
  const { projectId } = await fixture(page);
  const volumeId = randomUUID();
  const chapterId = randomUUID();
  const sceneId = randomUUID();
  const tree = { title: "潮待ち", volumes: [{ id: volumeId, title: "第一巻", chapters: [{
    id: chapterId, title: "第二章", scenes: [{ id: sceneId, title: "出港" }],
  }] }] };
  const shares = [
    { label: "現行リンク", active: true, expiresAt: "2099-02-01T00:00:00Z" },
    { label: "期限切れのリンク", active: false, expiresAt: "2000-02-01T00:00:00Z" },
    { label: "失効したリンク", active: false, expiresAt: "2099-02-01T00:00:00Z", revokedAt: "2000-01-02T00:00:00Z" },
  ].map((share) => ({ ...share, id: randomUUID(), scope: { kind: "chapter", id: chapterId }, createdAt: "2000-01-01T00:00:00Z" }));

  for (const [action, data] of Object.entries({ "publishing.project.tree": tree, "publishing.shares.list": { shares } })) {
    await page.route(`**/api/projects/${projectId}/actions/${action}`, async (route) => {
      const response = await route.fetch();
      const result = await response.json();
      await route.fulfill({ response, json: { ...result, data } });
    });
  }
  const menu = page.locator(".st-workspace-panel-menu");
  await menu.locator("summary").click();
  await menu.getByRole("button", { name: "読み取り専用共有リンクを表示", exact: true }).click();
  const panel = page.locator('[data-workspace-panel="module:publishing.share-links"]');
  await expect(panel.getByRole("combobox", { name: "対象", exact: true })).toHaveValue(chapterId);
  await panel.getByRole("combobox", { name: "範囲", exact: true }).selectOption("volume");
  await expect(panel.getByRole("combobox", { name: "対象", exact: true })).toHaveValue(volumeId);

  for (const [label, state] of [["現行リンク", "公開済み"], ["期限切れのリンク", "期限切れ"], ["失効したリンク", "失効済み"]]) {
    const row = panel.getByRole("listitem").filter({ has: page.getByText(label, { exact: true }) });
    await expect(row).toContainText("第一巻 / 第二章");
    await expect(row.getByText(state, { exact: true })).toBeVisible();
  }
});
