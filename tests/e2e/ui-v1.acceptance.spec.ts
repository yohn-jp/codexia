import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { createWritingFixture, openManuscriptScene, openRevisionHistory, ownerLogin, readPersistenceDrafts, manuscriptEditor as editor, readManuscriptMarkdown as markdown } from "./postgres-fixture";

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

test("legacy draft import retains the confirmed PostgreSQL revision and creates a new generation", async ({ page }, testInfo) => {
  const { project, scene } = await createWritingFixture(page); const text = "先に確定した本文。";
  const beforeFill = await markdown(page);
  await editor(page).evaluate(element => {
    const probe = window as Window & { __codexiaFillProbe?: Array<{ type: string; inputType: string | null; selection: string; text: string }> };
    const events: NonNullable<typeof probe.__codexiaFillProbe> = [];
    probe.__codexiaFillProbe = events;
    const record = (event: Event) => {
      const selection = window.getSelection();
      events.push({ type: event.type, inputType: event instanceof InputEvent ? event.inputType : null,
        selection: selection?.toString() ?? "", text: element.textContent ?? "" });
    };
    for (const type of ["beforeinput", "input", "keydown", "keyup", "compositionstart", "compositionend"]) {
      element.addEventListener(type, record, { capture: true });
    }
    document.addEventListener("selectionchange", record);
  });
  try {
    await editor(page).fill(text);
  } finally {
    const afterFill = await markdown(page);
    const events = await page.evaluate(() => (window as Window & { __codexiaFillProbe?: unknown }).__codexiaFillProbe ?? []);
    await testInfo.attach("manuscript-fill-probe", { body: JSON.stringify({ beforeFill, afterFill, events }, null, 2), contentType: "application/json" });
  }
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
  await expect(page.getByText("PostgreSQLへ保存済み", { exact: true })).toBeVisible();
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
  await expect(page.getByText("PostgreSQLへ保存済み", { exact: true })).toBeVisible();
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
  await expect.poll(async () => (await readPersistenceDrafts(page)).some((draft) => draft.documentId === scene.id && draft.markdown.includes(text)) || page.getByText("PostgreSQLへ保存済み", { exact: true }).isVisible()).toBeTruthy();
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
  await expect(page.getByText("IndexedDB回復Journalに保存済み", { exact: true })).toBeVisible();
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
