import { expect, test, type Page } from "@playwright/test";
import { createHash, randomUUID } from "node:crypto";

const authToken = process.env.CODEXIA_E2E_AUTH_TOKEN ?? "";
const rootPath = "/api/v1/persistence/projects";
interface Draft { key: string; projectId: string; documentId: string; authorScope: string; markdown: string; generation: number; baseRevisionId: string; baseMarkdown: string; version: number; updatedAt: number }
interface Read { document: { id: string; title: string; headRevisionId: string }; revision: { id: string; markdown: string } }
interface Fixture { projectId: string; one: Read; two: Read }
const editor = (page: Page) => page.getByRole("textbox", { name: "原稿 Markdown" });
const documentPath = (fixture: Fixture, documentId = fixture.one.document.id) => `${rootPath}/${fixture.projectId}/documents/${documentId}`;

async function signIn(page: Page, mode = "desktop"): Promise<void> {
  await page.goto(`/${mode}/`);
  if (await page.getByLabel("アクセス・トークン").isVisible()) {
    await page.getByLabel("アクセス・トークン").fill(authToken);
    await page.getByRole("button", { name: "PostgreSQL作品を開く" }).click();
  }
  await expect(page.getByRole("heading", { name: "Database workspace" })).toBeVisible();
}

async function fixture(page: Page): Promise<Fixture> {
  const login = await page.request.post("/api/login", { data: { token: authToken } });
  expect(login.ok()).toBe(true);
  const projectResponse = await page.request.post(rootPath, { data: { title: `Core acceptance ${randomUUID()}` } });
  expect(projectResponse.status()).toBe(201);
  const { project } = await projectResponse.json() as { project: { id: string } };
  const createDocument = async (title: string, orderKey: string): Promise<Read> => {
    const response = await page.request.post(`${rootPath}/${project.id}/documents`, { headers: { "Idempotency-Key": randomUUID() }, data: { title, kind: "scene", orderKey, markdown: `# ${title}\n\nInitial ${title} text.\n` } });
    expect(response.status()).toBe(201);
    return response.json() as Promise<Read>;
  };
  const one = await createDocument("Scene One", "a");
  const two = await createDocument("Scene Two", "b");
  await signIn(page);
  await page.getByLabel("開く作品").selectOption(project.id);
  await page.locator(".pg-document-list").getByRole("button", { name: /Scene One/ }).click();
  await expect(editor(page)).toHaveText(one.revision.markdown.trimEnd());
  return { projectId: project.id, one, two };
}

async function read(page: Page, f: Fixture, documentId = f.one.document.id): Promise<Read> {
  const response = await page.request.get(documentPath(f, documentId));
  expect(response.ok()).toBe(true);
  return response.json() as Promise<Read>;
}
async function replace(page: Page, f: Fixture, markdown: string, base?: Read): Promise<Read> {
  const current = base ?? await read(page, f);
  const response = await page.request.patch(documentPath(f), { headers: { "Idempotency-Key": randomUUID(), "X-Client-Id": "acceptance-external" }, data: { baseRevisionId: current.revision.id, changes: [{ fromUtf16: 0, toUtf16: current.revision.markdown.length, insert: markdown }], resultingSha256: createHash("sha256").update(markdown).digest("hex"), clientId: "acceptance-external" } });
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
  await expect(page.getByText("PostgreSQLへ保存済み", { exact: true })).toBeVisible();
}
async function reopen(page: Page, f: Fixture): Promise<void> {
  await page.reload();
  await page.getByLabel("開く作品").selectOption(f.projectId);
  await page.locator(".pg-document-list").getByRole("button", { name: /Scene One/ }).click();
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

test("appearance modes follow system preference initially and persist explicit light, dark, and paper choices", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" }); await signIn(page);
  await expect(page.locator("html")).toHaveAttribute("data-zp-theme", "light");
  for (const theme of ["dark", "paper", "light"]) {
    await page.getByLabel("外観").selectOption(theme);
    await expect(page.locator("html")).toHaveAttribute("data-zp-theme", theme);
    await page.reload(); await expect(page.getByLabel("外観")).toHaveValue(theme);
  }
});

test("revision history keeps immutable content through a foreground refresh", async ({ page }) => {
  const f = await fixture(page); const text = "Saved immutable version.";
  await editor(page).fill(text); await saved(page, f, text);
  await page.getByRole("button", { name: "Revision履歴", exact: true }).click();
  await expect(page.getByRole("region", { name: "Revision履歴" })).toContainText(f.one.revision.markdown.trim());
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect(page.getByRole("region", { name: "Revision履歴" })).toContainText(text);
  expect((await page.request.get(`${documentPath(f)}?revision=${f.one.revision.id}`)).ok()).toBe(true);
});

test("same-origin stale tabs cannot replace an equal-generation journal draft", async ({ page, context }) => {
  const f = await fixture(page); const gate = await holdSaves(page, f);
  const second = await context.newPage(); await second.goto(page.url());
  await second.getByLabel("開く作品").selectOption(f.projectId); await second.locator(".pg-document-list").getByRole("button", { name: /Scene One/ }).click();
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
  await page.evaluate(() => { window.print = () => { document.documentElement.dataset.printedManuscript = document.querySelector(".print-manuscript")?.textContent ?? ""; }; });
  const text = "Printed from the newest editor input."; await editor(page).fill(text);
  await editor(page).evaluate((element) => element.dispatchEvent(new CompositionEvent("compositionstart", { data: "にほんご", bubbles: true })));
  await page.locator(".pg-document-list").getByRole("button", { name: /Scene Two/ }).click();
  await expect(page.getByRole("heading", { name: "Scene One", exact: true })).toBeVisible();
  await expect(page.getByRole("alert")).toContainText("日本語入力の変換が完了していません");
  await editor(page).evaluate((element) => element.dispatchEvent(new CompositionEvent("compositionend", { data: "日本語", bubbles: true })));
  const composedText = `${text} 日本語入力`;
  await editor(page).fill(composedText);
  await page.getByRole("button", { name: "印刷", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-printed-manuscript", composedText);
  await saved(page, f, composedText); await page.getByRole("button", { name: "Revision履歴", exact: true }).click();
  await expect(page.getByRole("region", { name: "Revision履歴" })).toContainText(composedText);
});

test("exact revision acknowledgement removes its draft without reviving deleted recovery on reload", async ({ page }) => {
  const f = await fixture(page); const text = "Acknowledged durable draft.";
  await editor(page).fill(text); await saved(page, f, text);
  await expect.poll(async () => (await drafts(page)).filter((d) => d.documentId === f.one.document.id)).toEqual([]);
  await reopen(page, f); await expect(editor(page)).toHaveText(text);
  expect((await drafts(page)).filter((d) => d.documentId === f.one.document.id)).toEqual([]);
});

test("writing UI protects multiple document drafts separately from PostgreSQL revision durability", async ({ page }) => {
  const f = await fixture(page); const gate = await holdSaves(page, f);
  try {
    await editor(page).fill("Scene One protected draft.");
    await page.locator(".pg-document-list").getByRole("button", { name: /Scene Two/ }).click();
    await editor(page).fill("Scene Two independent draft.");
    await expect.poll(async () => (await drafts(page)).some((d) => d.documentId === f.one.document.id && d.markdown === "Scene One protected draft.")).toBe(true);
    await page.locator(".pg-document-list").getByRole("button", { name: /Scene One/ }).click();
    await expect(editor(page)).toHaveText("Scene One protected draft.");
  } finally { gate.release(); }
});

test("new typing survives an older in-flight PostgreSQL save and exact acknowledgement", async ({ page }) => {
  const f = await fixture(page); const gate = await holdSaves(page, f);
  try {
    await editor(page).fill("First generation awaiting acknowledgement."); await gate.seen;
    await editor(page).fill("Newer generation while save is in flight.");
    await expect.poll(async () => (await drafts(page)).some((d) => d.markdown === "Newer generation while save is in flight.")).toBe(true);
    gate.release(); await saved(page, f, "Newer generation while save is in flight.");
    await expect(editor(page)).toHaveText("Newer generation while save is in flight.");
  } finally { gate.release(); }
});

test("new typing survives recovery against a newer PostgreSQL base revision", async ({ page }) => {
  const f = await fixture(page); const gate = await holdSaves(page, f);
  try {
    await editor(page).fill("Recovered draft before competing revision."); await gate.seen;
    await replace(page, f, "Competing PostgreSQL revision.");
    await editor(page).fill("Newest input before conflict arrives."); gate.release();
    await expect(page.getByRole("heading", { name: "Revision競合" })).toBeVisible();
    await expect(editor(page)).toHaveText("Newest input before conflict arrives.");
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
    await reopen(page, f); await expect(editor(page)).toHaveText("Valid protected draft after malformed entry.");
    expect((await drafts(page)).some((d) => d.key === "malformed-legacy-key")).toBe(true);
  } finally { gate.release(); }
});

async function submitProposal(page: Page, f: Fixture): Promise<{ id: string; operation: Record<string, unknown>; generated: string }> {
  const observationResponse = await page.request.get(`/api/projects/${f.projectId}/observation`); expect(observationResponse.ok()).toBe(true);
  const { snapshot } = await observationResponse.json() as { snapshot: { projectId: string; projectVersion: number } };
  const current = await read(page, f); const generated = `${current.revision.markdown}\nMCP proposal requires explicit author approval.\n`;
  const path = `documents/${f.one.document.id}.md`;
  const operation = { id: `mcp-op-${randomUUID()}`, generation: 1, projectId: f.projectId, baseProjectVersion: snapshot.projectVersion, effect: "manuscript", reads: [{ path, revision: current.revision.id }], writes: [{ path, revision: current.revision.id, content: generated }], message: "MCP acceptance proposal" };
  const id = `mcp-${randomUUID()}`;
  const response = await page.request.post(`/api/projects/${f.projectId}/proposals`, { headers: { Authorization: `Bearer ${authToken}` }, data: { id, snapshot, operations: [operation] } });
  expect(response.status()).toBe(201); expect(await response.json()).toMatchObject({ id, source: "mcp" });
  return { id, operation, generated };
}

test("external MCP proposals require owner approval before PostgreSQL application", async ({ page }) => {
  const f = await fixture(page); const proposal = await submitProposal(page, f);
  const before = await page.request.get(`/api/projects/${f.projectId}/proposals/${proposal.id}`);
  expect(await before.json()).toMatchObject({ state: "proposed", approvedOperationIds: [] });
  const denied = await page.request.post(`/api/projects/${f.projectId}/apply`, { data: proposal.operation }); expect(denied.ok()).toBe(false);
  expect((await read(page, f)).revision.id).toBe(f.one.revision.id);
  const approval = await page.request.post(`/api/projects/${f.projectId}/approvals`, { data: { proposalId: proposal.id, operationIds: [proposal.operation.id] } }); expect(approval.status()).toBe(204);
  const applied = await page.request.post(`/api/projects/${f.projectId}/apply`, { data: proposal.operation }); expect(applied.status()).toBe(201);
  expect((await read(page, f)).revision.markdown).toBe(proposal.generated);
  await reopen(page, f); await expect(editor(page)).toHaveText(proposal.generated.trimEnd());
});

test("full MCP proposal payload and approval state survive Core process and cache loss", async ({ page }) => {
  const f = await fixture(page); const proposal = await submitProposal(page, f);
  const path = `/api/projects/${f.projectId}/proposals/${proposal.id}`;
  const before = await (await page.request.get(path)).json(); await restart(page);
  const after = await page.request.get(path); expect(after.ok()).toBe(true); expect(await after.json()).toEqual(before);
  expect((await read(page, f)).revision.id).toBe(f.one.revision.id);
  await reopen(page, f); await expect(editor(page)).toHaveText(f.one.revision.markdown.trimEnd());
});

test("a PostgreSQL update during author approval keeps the conflicting editor draft visible", async ({ page }) => {
  const f = await fixture(page); const proposal = await submitProposal(page, f); const gate = await holdSaves(page, f);
  try {
    await editor(page).fill("Author input must survive rejected approval."); await gate.seen;
    await replace(page, f, "Another writer advanced the project.");
    const approval = await page.request.post(`/api/projects/${f.projectId}/approvals`, { data: { proposalId: proposal.id, operationIds: [proposal.operation.id] } }); expect(approval.ok()).toBe(false);
    gate.release(); await expect(page.getByRole("heading", { name: "Revision競合" })).toBeVisible();
    await expect(editor(page)).toHaveText("Author input must survive rejected approval.");
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
  await expect(editor(page)).toHaveText("Unsaved text must remain visible after quota failure.");
});

test("project reconstruction retains PostgreSQL revisions and removed Git lifecycle has no fallback", async ({ page }) => {
  const f = await fixture(page); const text = "Survives process reconstruction.";
  await editor(page).fill(text); await saved(page, f, text); const revision = (await read(page, f)).revision.id;
  await restart(page); await reopen(page, f); await expect(editor(page)).toHaveText(text);
  expect((await read(page, f)).revision.id).toBe(revision);
  for (const suffix of ["publish", "reconcile", "checkpoints"]) {
    const result = await page.request.post(`/api/projects/${f.projectId}/${suffix}`, { data: {} }); expect(result.ok()).toBe(false);
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
    const tab = page.getByRole("tab", { name: "EPUB 書き出し", exact: true });
    await tab.click(); const request = await seen; const failed = page.waitForEvent("requestfailed", (candidate) => candidate === request);
    await page.getByRole("button", { name: "ログアウト" }).click();
    await expect(page.getByRole("heading", { name: "作品を開く" })).toBeVisible(); expect((await failed).failure()).not.toBeNull();
  } finally { release(); }
});

async function delayImages(page: Page): Promise<void> {
  await page.addInitScript(() => { const original = FileReader.prototype.readAsDataURL; FileReader.prototype.readAsDataURL = function (this: FileReader, blob: Blob) { const reader = this; window.setTimeout(() => original.call(reader, blob), 700); }; });
}

test("a pending scratch image read is flushed to its captured document before navigation", async ({ page }) => {
  await delayImages(page); const f = await fixture(page); await scratch(page);
  await memo(page).fill("Attachment belongs to Scene One."); await image(page).setInputFiles(png);
  await page.locator(".pg-document-list").getByRole("button", { name: /Scene Two/ }).click();
  await expect(page.getByRole("heading", { name: "Scene Two", exact: true })).toBeVisible();
  await expect.poll(async () => (await scratchRecords(page)).some((r) => r.key.includes(f.one.document.id) && r.text.includes("Attachment belongs to Scene One.") && r.text.includes("data:image/png;base64"))).toBe(true);
  expect((await scratchRecords(page)).some((r) => r.key.includes(f.two.document.id) && r.text.includes("Attachment belongs to Scene One."))).toBe(false);
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

test("scratch text and image selection pause while recovery is being resumed", async ({ page }) => {
  await delayImages(page); await fixture(page); await scratch(page);
  await memo(page).fill("Protected scratch."); await editor(page).click();
  await expect.poll(async () => (await scratchRecords(page)).some((r) => r.text.includes("Protected scratch."))).toBe(true);
  await image(page).setInputFiles(png);
  const resume = page.locator(".scratch-panel").getByRole("button", { name: "続ける", exact: true }); await resume.click();
  await expect(memo(page)).toBeDisabled(); await expect(image(page)).toBeDisabled();
  await expect(memo(page)).toBeEnabled(); await expect(image(page)).toBeEnabled();
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

test("late document activation cannot replace explicit scene navigation", async ({ page }) => {
  const f = await fixture(page); let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; }); let observed!: () => void; const seen = new Promise<void>((resolve) => { observed = resolve; });
  await page.route(`**${documentPath(f)}`, async (route) => { if (route.request().method() !== "GET") return route.continue(); const response = await route.fetch(); observed(); await gate; await route.fulfill({ response }); });
  try {
    await page.locator(".pg-document-list").getByRole("button", { name: /Scene Two/ }).click();
    await page.locator(".pg-document-list").getByRole("button", { name: /Scene One/ }).click(); await seen;
    await page.locator(".pg-document-list").getByRole("button", { name: /Scene Two/ }).click();
    await expect(page.getByRole("heading", { name: "Scene Two", exact: true })).toBeVisible(); release();
    await expect(editor(page)).toHaveText(f.two.revision.markdown.trimEnd());
  } finally { release(); }
});

test("Issue 42: an updated PostgreSQL revision cannot supersede explicit navigation during draft flush", async ({ page }) => {
  const f = await fixture(page); const gate = await holdSaves(page, f);
  try {
    await editor(page).fill("Pending Scene One draft before explicit navigation."); await gate.seen; await replace(page, f, "External PostgreSQL version.");
    await page.locator(".pg-document-list").getByRole("button", { name: /Scene Two/ }).click();
    await expect(editor(page)).toHaveText(f.two.revision.markdown.trimEnd()); gate.release();
    await expect(page.getByRole("heading", { name: "Scene Two", exact: true })).toBeVisible();
    await expect.poll(async () => (await drafts(page)).some((d) => d.documentId === f.one.document.id && d.markdown === "Pending Scene One draft before explicit navigation.")).toBe(true);
  } finally { gate.release(); }
});

test("Issue 42: an unchanged PostgreSQL observation leaves explicit scene selection alone", async ({ page }) => {
  const f = await fixture(page);
  await page.locator(".pg-document-list").getByRole("button", { name: /Scene Two/ }).click();
  for (const name of ["online", "focus", "visibilitychange"]) await page.evaluate((event) => window.dispatchEvent(new Event(event)), name);
  await expect(page.getByRole("heading", { name: "Scene Two", exact: true })).toBeVisible();
  await expect(editor(page)).toHaveText(f.two.revision.markdown.trimEnd());
  expect((await read(page, f)).revision.id).toBe(f.one.revision.id);
});

test("Issue 42: failed PostgreSQL availability preserves the author session and offers explicit retry", async ({ page }) => {
  const f = await fixture(page); let unavailable = true; let reauthCalls = 0;
  await page.route("**/api/v1/persistence/status", (route) => unavailable ? route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "PostgreSQL unavailable" }) }) : route.continue());
  await page.route("**/_platform/reauth", (route) => { reauthCalls += 1; return route.abort(); });
  await page.reload(); await expect(page.getByRole("heading", { name: "PostgreSQLへ接続できません" })).toBeVisible();
  expect((await page.request.get("/api/session")).status()).toBe(200); expect(reauthCalls).toBe(0);
  unavailable = false; await page.getByRole("button", { name: "再試行" }).click();
  await page.getByLabel("開く作品").selectOption(f.projectId); await page.locator(".pg-document-list").getByRole("button", { name: /Scene One/ }).click();
  await expect(editor(page)).toHaveText(f.one.revision.markdown.trimEnd());
});
