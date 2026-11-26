import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { expect, test, type AuthorSession, type AuthorizeAuthor } from "./author-oauth-fixture";
import { createOAuthWritingFixture, manuscriptEditor, writingFixturePath } from "./postgres-fixture";


async function unusedTcpPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolveListen();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not allocate a loopback port for Chromium CDP");
  const port = address.port;
  await new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
  return port;
}

async function stopBrowserProcess(child: ChildProcess): Promise<void> {
  const hasExited = () => child.exitCode !== null || child.signalCode !== null;
  if (hasExited()) return;

  const waitForExit = (timeoutMs: number) => new Promise<boolean>((resolveExit) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (exited: boolean) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      child.removeListener("exit", onExit);
      resolveExit(exited);
    };
    const onExit = () => finish(true);
    child.once("exit", onExit);
    timer = setTimeout(() => finish(false), timeoutMs);
    if (hasExited()) finish(true);
  });

  const gracefulExit = waitForExit(2_000);
  child.kill("SIGTERM");
  if (await gracefulExit) return;

  const forcedExit = waitForExit(2_000);
  child.kill("SIGKILL");
  if (!(await forcedExit)) throw new Error("Native Chromium did not exit after SIGKILL");
}

async function createNativeHeadfulContext(width: number): Promise<{
  browser: Browser;
  context: BrowserContext;
  page: Page;
  close: () => Promise<void>;
}> {
  const executable = process.env.CODEXIA_E2E_CHROMIUM;
  if (!executable) throw new Error("Native visibility coverage requires CODEXIA_E2E_CHROMIUM");
  const profile = await mkdtemp(join(tmpdir(), "codexia-native-chromium-"));
  const port = await unusedTcpPort();
  const child = spawn(executable, [
    "--no-sandbox",
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${port}`,
    "--remote-allow-origins=*",
    "about:blank",
  ], { env: process.env, stdio: "ignore" });
  let browser: Browser | null = null;
  let spawnError: Error | null = null;
  child.once("error", (error) => { spawnError = error; });

  try {
    const deadline = Date.now() + 10_000;
    let endpointReady = false;
    while (Date.now() < deadline) {
      if (spawnError) throw spawnError;
      if (child.exitCode !== null) throw new Error(`Native Chromium exited before CDP was ready (code ${child.exitCode})`);
      try {
        const response = await fetch(`http://127.0.0.1:${port}/json/version`);
        if (response.ok) {
          endpointReady = true;
          break;
        }
      } catch { /* Wait briefly for the local CDP endpoint. */ }
      await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    }
    if (!endpointReady) throw new Error("Native Chromium CDP endpoint did not start within 10 seconds");
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { noDefaults: true });
    const context = browser.contexts()[0];
    if (!context) throw new Error("Native Chromium did not expose its default browser context");
    const page = context.pages()[0] ?? await context.newPage();
    await page.setViewportSize({ width, height: 900 });
    return {
      browser,
      context,
      page,
      close: async () => {
        await browser?.close().catch(() => undefined);
        await stopBrowserProcess(child);
        await rm(profile, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
      },
    };
  } catch (error) {
    await browser?.close().catch(() => undefined);
    await stopBrowserProcess(child);
    await rm(profile, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    throw error;
  }
}

function requireNativeVisibilityCoverage(): void {
  const missing = [
    process.env.CODEXIA_E2E_NATIVE_VISIBILITY === "1" ? "" : "CODEXIA_E2E_NATIVE_VISIBILITY=1",
    process.env.DISPLAY ? "" : "DISPLAY",
    process.env.CODEXIA_E2E_CHROMIUM ? "" : "CODEXIA_E2E_CHROMIUM",
  ].filter(Boolean);
  if (missing.length === 0) return;
  test.info().annotations.push({
    type: "c39-natural-visibility",
    description: `NOT_CHECKED: native headful coverage requires ${missing.join(", ")}.`,
  });
  test.skip(true, "NOT_CHECKED: native headful visibility environment is not configured.");
}


async function activity(author: AuthorSession, projectId: string) {
  const response = await author.fetch(`/api/projects/${projectId}/recent-activity`);
  expect(response.ok()).toBe(true);
  return response.json() as Promise<{ items: Array<{ sceneId: string; sentenceOffset: number | null; pageIndex?: number | null; deviceType: string; updatedAt: string }> }>;
}
async function remotePosition(
  author: AuthorSession,
  projectId: string,
  sceneId: string,
  sentenceOffset = 2,
  pageIndex = 2,
  deviceType = "mobile",
) {
  const response = await author.fetch(`/api/projects/${projectId}/recent-activity`, {
    method: "PUT", headers: { Origin: author.origin },
    data: { sceneId, sentenceOffset, pageIndex, deviceType },
  });
  expect(response.ok()).toBe(true);
}
const originalMarkdown = "最初の本文。\n次の文章です。";

async function longFixture(authorizeAuthor: AuthorizeAuthor, page: Page) {
  return createOAuthWritingFixture(authorizeAuthor, page, "desktop", undefined,
    "読書位置を別の端末へ引き継ぐための文章です。\n\n".repeat(100));
}
async function nativeFixture() {
  requireNativeVisibilityCoverage();
  return createNativeHeadfulContext(1280);
}

async function openContinuePanel(page: Page) {
  const disclosure = page.locator(".pg-library-continue");
  if (!await disclosure.evaluate((element: HTMLDetailsElement) => element.open)) {
    await disclosure.locator("summary").click();
  }
  return page.getByRole("region", { name: "続きから" });
}

for (const kind of ["writing", "reading", "superseded reading"] as const) {
  test(`a delayed scene handles the chosen remote ${kind} position`, async ({ page, authorizeAuthor }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    const { project, scene, second, author } = await createOAuthWritingFixture(authorizeAuthor, page, "desktop", undefined, originalMarkdown);
    const path = `/api/v1/persistence/projects/${project.id}/documents/${second.id}`;
    const read = await author.fetch(path);
    expect(read.ok()).toBe(true);
    const { revision } = await read.json() as { revision: { id: string; markdown: string } };
    const prefix = "第一文です。第二文です。";
    const body = prefix + "第三文の始めです。\n\n" + "続きの原稿を読書ページへ表示します。\n\n".repeat(120);
    const patched = await author.fetch(path, {
      method: "PATCH",
      headers: { Origin: author.origin, "Idempotency-Key": randomUUID(), "X-Client-Id": "handoff-fixture" },
      data: {
        baseRevisionId: revision.id,
        changes: [{ fromUtf16: 0, toUtf16: revision.markdown.length, insert: body }],
        resultingSha256: createHash("sha256").update(body).digest("hex"),
      },
    });
    expect(patched.ok()).toBe(true);
    await remotePosition(author, project.id, second.id, 3);
    await page.reload();
    await authorizeAuthor("desktop", page, { continueCurrentPage: true });
    await expect(manuscriptEditor(page)).toBeVisible();

    let releaseLoad!: () => void;
    const loadGate = new Promise<void>((resolve) => { releaseLoad = resolve; });
    let observeLoad!: () => void;
    const loadStarted = new Promise<void>((resolve) => { observeLoad = resolve; });
    await page.route((url) => url.pathname === path, async (route) => {
      observeLoad();
      await loadGate;
      await route.continue();
    });
    const panel = await openContinuePanel(page);
    const candidate = panel.locator("p").filter({ hasText: second.title });
    const previousScene = page.locator(`.pg-outline-item[data-document-id="${scene.id}"] .pg-outline-document`);
    const originalUrl = page.url();
    const response = page.waitForResponse((item) => new URL(item.url()).pathname === path && item.request().method() === "GET");
    try {
      await candidate.getByRole("button", { name: kind === "writing" ? "続きを書く" : "読書位置を開く" }).click();
      await loadStarted;
      await expect(manuscriptEditor(page)).toHaveCount(0);
      await expect(page.locator(".reading-pager")).toHaveCount(0);
      await expect(previousScene).toHaveAttribute("aria-current", "page");
      await expect(page).toHaveURL(originalUrl);
      if (kind === "superseded reading") {
        await previousScene.click();
      }
    } finally {
      releaseLoad();
    }
    expect((await response).ok()).toBe(true);
    if (kind === "superseded reading") {
      await expect(page).toHaveURL(new RegExp(`/scenes/${scene.id}(?:\\?|$)`));
      await expect(manuscriptEditor(page)).toContainText("最初の本文。");
      await expect(page.locator(".reading-pager")).toHaveCount(0);
      return;
    }
    await expect(page.getByRole("heading", { name: second.title, exact: true })).toBeVisible();
    if (kind === "reading") {
      await expect(page.locator(".reading-pager")).toHaveAttribute("data-page-index", "2");
    } else {
      await expect.poll(() => manuscriptEditor(page).evaluate((element) => {
        const content = element as HTMLElement & { cmTile?: { root: { view: { state: { selection: { main: { head: number } } } } } } };
        return content.cmTile?.root.view.state.selection.main.head;
      })).toBe(prefix.length);
    }
  });
}

test("recent activity hands off only numeric positions across devices, projects, and API restart", async ({ browser, page, authorizeAuthor, authorServer }) => {
  const f = await longFixture(authorizeAuthor, page);
  const { author } = f;
  const writes: Record<string, unknown>[] = [];
  page.on("request", (request) => { if (request.method() === "PUT" && request.url().endsWith("/recent-activity")) writes.push(request.postDataJSON()); });
  await manuscriptEditor(page).press("Control+End");
  await expect.poll(async () => (await activity(author, f.project.id)).items.some((item) => item.sceneId === f.scene.id && typeof item.sentenceOffset === "number")).toBe(true);
  for (const write of writes) expect(Object.keys(write).every((key) => ["sceneId", "sentenceOffset", "pageIndex", "deviceType"].includes(key))).toBe(true);
  await remotePosition(author, f.project.id, f.scene.id);
  const secondContext = await browser.newContext({ viewport: { width: 390, height: 900 } });
  const secondPage = await secondContext.newPage();
  try {
    const secondAuthor = await authorizeAuthor("desktop", secondPage, { path: writingFixturePath("desktop", f.project, f.scene) });
    await expect(manuscriptEditor(secondPage)).toContainText("読書位置");
    const before = await activity(secondAuthor, f.project.id);
    expect(before.items.some((item) => item.deviceType === "mobile" && item.pageIndex === 2)).toBe(true);
    const another = await author.fetch("/api/v1/persistence/projects", { method: "POST", headers: { Origin: author.origin }, data: { title: `Isolated cursor ${crypto.randomUUID()}` } });
    expect(another.status()).toBe(201);
    const { project } = await another.json(); expect((await activity(author, project.id)).items).toEqual([]);
    await authorServer.restartApi();
    await page.reload();
    await authorizeAuthor("desktop", page, { continueCurrentPage: true });
    expect((await activity(author, f.project.id)).items.some((item) => item.sceneId === f.scene.id && item.deviceType === "mobile")).toBe(true);
    const anonymous = await browser.newContext(); try { const denial = await anonymous.request.get(`${author.origin}/api/projects/${f.project.id}/recent-activity`); expect(denial.status()).toBe(401); } finally { await anonymous.close(); }
  } finally { await secondContext.close(); }
});

test("recent activity polling pauses while naturally hidden and resumes when visible", async ({ authorizeAuthor }) => {
  const native = await nativeFixture(); const { page, context } = native;
  let background: Page | undefined;
  try {
    const f = await longFixture(authorizeAuthor, page);
    const { author } = f; let requests = 0;
    page.on("request", (request) => { if (request.method() === "GET" && request.url().endsWith("/recent-activity")) requests += 1; });
    await page.reload();
    await authorizeAuthor("desktop", page, { continueCurrentPage: true });
    await expect.poll(() => requests).toBeGreaterThan(0);
    const panel = await openContinuePanel(page);
    background = await context.newPage(); await background.goto("about:blank"); await background.bringToFront();
    await expect.poll(() => page.evaluate(() => document.visibilityState)).toBe("hidden");
    const hidden = requests;
    await page.waitForTimeout(15_500); expect(requests).toBe(hidden);
    await remotePosition(author, f.project.id, f.scene.id);
    await page.bringToFront(); await expect.poll(() => page.evaluate(() => document.visibilityState)).toBe("visible");
    await expect.poll(() => requests).toBeGreaterThan(hidden);
    await expect(panel.getByText(/スマホでたった今まで編集していました/u)).toBeVisible();
    const visible = requests;
    await expect.poll(() => requests, { timeout: 20_000 }).toBe(visible + 1);
  } finally { await background?.close(); await native.close(); }
});

test("recent activity ignores a refresh response invalidated by natural hide", async ({ authorizeAuthor }) => {
  const native = await nativeFixture(); const { page, context } = native;
  let background: Page | undefined;
  let release!: () => void;
  try {
    const f = await longFixture(authorizeAuthor, page);
    const { author } = f;
    const path = `/api/projects/${f.project.id}/recent-activity`;
    await remotePosition(author, f.project.id, f.scene.id);
    let started!: () => void;
    const pending = new Promise<void>((resolve) => { started = resolve; });
    const held = new Promise<void>((resolve) => { release = resolve; });
    let first = true;
    await page.route((url) => url.pathname === path, async (route) => {
      if (route.request().method() !== "GET" || !first) return route.continue();
      first = false; started(); await held;
      await route.fulfill({
        headers: { "x-test-activity": "stale" },
        json: { items: [{ sceneId: f.second.id, sentenceOffset: 3, pageIndex: null, deviceType: "mobile", updatedAt: new Date().toISOString() }] },
      });
    });
    await page.reload();
    await authorizeAuthor("desktop", page, { continueCurrentPage: true });
    await pending;
    await expect(manuscriptEditor(page)).toBeVisible();
    const panel = await openContinuePanel(page);
    await expect(panel).not.toContainText(f.second.title);
    await panel.evaluate((element, staleTitle) => {
      const recordStaleEntry = () => {
        if (element.textContent?.includes(staleTitle)) element.setAttribute("data-observed-stale-entry", "true");
      };
      const observer = new MutationObserver(recordStaleEntry);
      observer.observe(element, { childList: true, subtree: true, characterData: true });
      recordStaleEntry();
    }, f.second.title);

    background = await context.newPage();
    await background.goto("about:blank");
    await background.bringToFront();
    await expect.poll(() => page.evaluate(() => document.visibilityState)).toBe("hidden");
    const staleResponse = page.waitForResponse((response) => response.headers()["x-test-activity"] === "stale");
    release();
    expect(await (await staleResponse).finished()).toBeNull();

    const freshResponse = page.waitForResponse((response) =>
      new URL(response.url()).pathname === path && response.request().method() === "GET");
    await page.bringToFront();
    await expect.poll(() => page.evaluate(() => document.visibilityState)).toBe("visible");
    expect((await freshResponse).ok()).toBe(true);
    await expect(panel).toContainText(f.scene.title);
    await expect(panel).not.toHaveAttribute("data-observed-stale-entry", "true");
    await expect(manuscriptEditor(page)).toContainText("読書位置");
  } finally { release?.(); await background?.close(); await native.close(); }
});

test("writing in another document does not inherit the previous reference page", async ({ page, authorizeAuthor }) => {
  await page.setViewportSize({ width: 390, height: 900 });
  const f = await longFixture(authorizeAuthor, page);
  await page.getByRole("button", { name: "読む", exact: true }).click();
  const pager = page.locator(".reading-pager");
  await expect(pager).toBeVisible();
  await expect.poll(async () => Number(await pager.getAttribute("data-page-count"))).toBeGreaterThanOrEqual(8);

  for (let pageIndex = 1; pageIndex <= 7; pageIndex += 1) {
    await pager.getByRole("button", { name: "次のページ" }).click();
    await expect(pager).toHaveAttribute("data-page-index", String(pageIndex));
  }
  await expect.poll(async () => {
    const item = (await activity(f.author, f.project.id)).items.find((candidate) => candidate.sceneId === f.scene.id);
    return item?.pageIndex;
  }).toBe(7);

  const secondDocument = page.locator(`.pg-document-list .pg-outline-item[data-document-id="${f.second.id}"] > .pg-outline-row > .pg-outline-document`);
  await secondDocument.focus();
  await secondDocument.press("Enter");
  await expect(secondDocument).toHaveAttribute("aria-current", "page");
  await expect(manuscriptEditor(page)).toBeVisible();
  await manuscriptEditor(page).press("Control+End");
  await expect.poll(async () => {
    const item = (await activity(f.author, f.project.id)).items.find((candidate) => candidate.deviceType === "mobile");
    return item?.sceneId === f.second.id ? item.pageIndex : "pending";
  }).toBeNull();

  const panel = await openContinuePanel(page);
  const secondCandidate = panel.locator("p").filter({ hasText: f.second.title });
  await expect(secondCandidate).toBeVisible();
  await expect(secondCandidate.getByRole("button", { name: "続きを書く" })).toBeVisible();
  await expect(secondCandidate.getByRole("button", { name: "読書位置を開く" })).toHaveCount(0);
});

test("recent activity ignores a delayed response for a document that is no longer selected", async ({ page, authorizeAuthor }) => {
  const f = await longFixture(authorizeAuthor, page);
  const activityPath = `/api/projects/${f.project.id}/recent-activity`;
  await remotePosition(f.author, f.project.id, f.scene.id, 12, 12, "desktop");

  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let signalStarted!: () => void;
  const started = new Promise<void>((resolve) => { signalStarted = resolve; });
  await page.route(`**${activityPath}`, async (route) => {
    if (route.request().method() !== "PUT" || route.request().postDataJSON().sceneId !== f.scene.id) return route.continue();
    const response = await route.fetch();
    signalStarted();
    await held;
    await route.fulfill({ response });
  });

  try {
    await manuscriptEditor(page).press("Control+End");
    await started;
    await remotePosition(f.author, f.project.id, f.second.id, 4, 4, "desktop");

    const currentSnapshot = page.waitForResponse((response) =>
      new URL(response.url()).pathname === activityPath && response.request().method() === "GET");
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    expect((await currentSnapshot).ok()).toBe(true);

    const panel = await openContinuePanel(page);
    const secondCandidate = panel.locator("p").filter({ hasText: f.second.title });
    await expect(secondCandidate).toBeVisible();
    await expect(secondCandidate.getByRole("button", { name: "読書位置を開く" })).toBeVisible();
    await page.locator(`.pg-outline-item[data-document-id="${f.second.id}"] .pg-outline-document`).click();
    await expect(page.getByRole("heading", { name: f.second.title, exact: true })).toBeVisible();

    const delayedWrite = page.waitForResponse((response) =>
      new URL(response.url()).pathname === activityPath && response.request().method() === "PUT" &&
      response.request().postDataJSON().sceneId === f.scene.id);
    release();
    expect((await delayedWrite).ok()).toBe(true);
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));

    await expect(secondCandidate).toBeVisible();
    await expect(secondCandidate.getByRole("button", { name: "読書位置を開く" })).toBeVisible();
    await expect.poll(async () => {
      const item = (await activity(f.author, f.project.id)).items.find((candidate) => candidate.deviceType === "desktop");
      return item?.sceneId;
    }).toBe(f.second.id);
  } finally {
    release();
    await page.unroute(`**${activityPath}`);
  }
});

test("recent activity ignores a delayed write response from an earlier visit to the same document", async ({ page, authorizeAuthor }) => {
  const f = await longFixture(authorizeAuthor, page);
  const activityPath = `/api/projects/${f.project.id}/recent-activity`;
  const panel = await openContinuePanel(page);

  const editor = manuscriptEditor(page);
  await editor.press("Control+End");
  await expect.poll(async () => (await activity(f.author, f.project.id)).items.some((item) =>
    item.sceneId === f.scene.id && item.deviceType === "desktop" && (item.sentenceOffset ?? 0) > 1)).toBe(true);

  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let responseHeld = false;
  let intercepted = false;
  await page.route(`**${activityPath}`, async (route) => {
    if (intercepted || route.request().method() !== "PUT") return route.continue();
    intercepted = true;
    const response = await route.fetch();
    responseHeld = true;
    await held;
    await route.fulfill({ response });
  });

  try {
    await editor.press("Control+Home");
    await expect.poll(() => responseHeld).toBe(true);
    await remotePosition(f.author, f.project.id, f.second.id, 4, 4, "desktop");

    const select = async (scene: { id: string; title: string }) => {
      await page.locator(`.pg-outline-item[data-document-id="${scene.id}"] .pg-outline-document`).click();
      await expect(page.getByRole("heading", { name: scene.title, exact: true })).toBeVisible();
    };
    await select(f.second);
    await select(f.scene);
    const secondCandidate = panel.locator("p").filter({ hasText: f.second.title });
    await expect(secondCandidate.getByRole("button", { name: "読書位置を開く" })).toBeVisible();

    const delayedWrite = page.waitForResponse((response) =>
      new URL(response.url()).pathname === activityPath && response.request().method() === "PUT" &&
      response.request().postDataJSON().sceneId === f.scene.id);
    release();
    expect((await delayedWrite).ok()).toBe(true);
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(secondCandidate.getByRole("button", { name: "読書位置を開く" })).toBeVisible();
  } finally {
    release();
    await page.unroute(`**${activityPath}`);
  }
});

test("an older refresh failure does not override a successful current refresh", async ({ page, authorizeAuthor }) => {
  const f = await longFixture(authorizeAuthor, page);
  const activityPath = `/api/projects/${f.project.id}/recent-activity`;
  const panel = await openContinuePanel(page);

  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let refreshHeld = false;
  await page.route(`**${activityPath}`, async (route) => {
    if (refreshHeld || route.request().method() !== "GET") return route.continue();
    refreshHeld = true;
    await held;
    await route.fulfill({ status: 500, json: { error: "delayed refresh failure" } });
  });

  const refresh = () => page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  const refreshResponse = (status: number) => page.waitForResponse((response) =>
    new URL(response.url()).pathname === activityPath && response.request().method() === "GET" && response.status() === status);
  try {
    await refresh();
    await expect.poll(() => refreshHeld).toBe(true);
    await remotePosition(f.author, f.project.id, f.second.id, 4, 4, "desktop");

    const current = refreshResponse(200);
    await refresh();
    await current;
    await expect(panel.locator("p").filter({ hasText: f.second.title }).getByRole("button", { name: "読書位置を開く" })).toBeVisible();

    const outdated = refreshResponse(500);
    release();
    await outdated;
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(panel.getByText("再開位置を同期できません:", { exact: false })).toHaveCount(0);
  } finally {
    release();
    await page.unroute(`**${activityPath}`);
  }
});

test("recent activity coalesces repeated positions and records 50 input reports", async ({ page, authorizeAuthor }) => {
  const f = await longFixture(authorizeAuthor, page);
  const { author } = f;
  const initialTime = Date.now();
  await page.clock.install({ time: initialTime });
  await page.clock.pauseAt(initialTime + 60_000);
  const writes: Record<string, unknown>[] = [];
  page.on("request", (request) => { if (request.method() === "PUT" && request.url().endsWith("/recent-activity")) writes.push(request.postDataJSON()); });
  const editor = manuscriptEditor(page); await editor.press("Control+End");
  await page.clock.runFor(5_000);
  await expect.poll(() => writes.length, { timeout: 6_000 }).toBeGreaterThan(0);
  const count = writes.length;
  await page.locator(".cm-scroller").evaluate((element) => { for (let n = 0; n < 50; n += 1) element.dispatchEvent(new Event("scroll")); });
  await page.clock.runFor(5_000);
  await expect.poll(() => writes.length, { timeout: 6_000 }).toBe(count + 1);
  expect(writes.at(-1)).toEqual(writes.at(-2));
  const inputCount = writes.length; await editor.press("End"); await page.keyboard.type("x".repeat(50), { delay: 0 });
  await page.clock.runFor(5_000);
  await expect.poll(() => writes.length, { timeout: 6_000 }).toBe(inputCount + 1);
  expect((await activity(author, f.project.id)).items.some((item) => item.sceneId === f.scene.id)).toBe(true);
});

for (const departure of [false, true]) {
  test(`recent activity rejects reversed PUT delivery${departure ? " during pagehide keepalive" : ""}`, async ({ browser, page, authorizeAuthor }) => {
    const f = await longFixture(authorizeAuthor, page);
    const { author } = f;
    const editor = manuscriptEditor(page);
    await editor.press("Control+End");
    await expect.poll(async () => (await activity(author, f.project.id)).items.some((item) => item.sceneId === f.scene.id && item.deviceType === "desktop" && (item.sentenceOffset ?? 0) > 1)).toBe(true);
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const sent: Array<{ sceneId: string; sentenceOffset: number | null; deviceType: string }> = [];
    const url = `**/api/projects/${f.project.id}/recent-activity`;
    await page.route(url, async (route) => {
      if (route.request().method() !== "PUT") return route.continue();
      sent.push(route.request().postDataJSON());
      if (sent.length === 1) await held;
      await route.continue();
    });
    try {
      await editor.press("Control+Home");
      await expect.poll(() => sent.length, { timeout: 6_000 }).toBe(1);
      expect(sent[0]?.sentenceOffset).toBe(1);
      const newerResponse = page.waitForResponse((response) => response.url().endsWith("/recent-activity") &&
        response.request().method() === "PUT" && (response.request().postDataJSON().sentenceOffset ?? 0) > 1);
      await editor.press("Control+End");
      if (departure) {
        // Observe the real fetch option and trigger the existing lifecycle
        // handler while the first request is still blocked before delivery.
        const keepalive = await page.evaluate(() => {
          const original = window.fetch;
          let observed = false;
          window.fetch = (input, init) => {
            if (String(input).endsWith("/recent-activity") && init?.method === "PUT") observed = init.keepalive === true;
            return original.call(window, input, init);
          };
          try { window.dispatchEvent(new PageTransitionEvent("pagehide")); }
          finally { window.fetch = original; }
          return observed;
        });
        expect(keepalive).toBe(true);
      }
      await expect.poll(() => sent.length, { timeout: 6_000 }).toBeGreaterThanOrEqual(2);
      const latest = sent.at(-1)!;
      expect(latest.sentenceOffset ?? 0).toBeGreaterThan(1);
      // The initial cursor may equal the newer report. Its GET alone cannot
      // establish reversed delivery; require the newer PUT's own completion.
      expect((await newerResponse).ok()).toBe(true);
      await expect.poll(async () => (await activity(author, f.project.id)).items.find((item) => item.deviceType === "desktop")?.sentenceOffset).toBe(latest.sentenceOffset);
      const newer = (await activity(author, f.project.id)).items.find((item) => item.deviceType === "desktop");
      const olderResponse = page.waitForResponse((response) => response.url().endsWith("/recent-activity") &&
        response.request().method() === "PUT" && response.request().postDataJSON().sentenceOffset === 1);
      release();
      expect((await olderResponse).ok()).toBe(true);
      expect((await activity(author, f.project.id)).items.find((item) => item.deviceType === "desktop")).toEqual(newer);
      const secondContext = await browser.newContext({ viewport: { width: 390, height: 900 } });
      try {
        const other = await secondContext.newPage();
        const otherAuthor = await authorizeAuthor("desktop", other, { path: writingFixturePath("desktop", f.project, f.scene) });
        expect((await activity(otherAuthor, f.project.id)).items.find((item) => item.deviceType === "desktop")?.sentenceOffset).toBe(latest.sentenceOffset);
      } finally { await secondContext.close(); }
    } finally {
      release();
      await page.unroute(url);
    }
  });
}
