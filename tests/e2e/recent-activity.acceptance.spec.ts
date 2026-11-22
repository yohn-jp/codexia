import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { createWritingFixture, expectServerSaved, manuscriptEditor, ownerLogin } from "./postgres-fixture";
const configuredBaseURL = process.env.CODEXIA_E2E_BASE_URL ?? process.env.CODEXIA_BASE_URL ?? `http://127.0.0.1:${process.env.CODEXIA_E2E_PORT ?? "4173"}`;
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


async function activity(page: Page, projectId: string) {
  const response = await page.request.get(new URL(`/api/projects/${projectId}/recent-activity`, page.url()).toString());
  expect(response.ok()).toBe(true);
  return response.json() as Promise<{ items: Array<{ sceneId: string; sentenceOffset: number | null; pageIndex?: number | null; deviceType: string; updatedAt: string }> }>;
}
async function remotePosition(page: Page, projectId: string, sceneId: string, sentenceOffset = 2) {
  const response = await page.request.put(new URL(`/api/projects/${projectId}/recent-activity`, page.url()).toString(), { headers: { Origin: new URL(page.url()).origin }, data: { sceneId, sentenceOffset, pageIndex: 2, deviceType: "mobile" } });
  expect(response.ok()).toBe(true);
}
async function longFixture(page: Page) {
  const f = await createWritingFixture(page);
  const editor = manuscriptEditor(page);
  await editor.fill("読書位置を別の端末へ引き継ぐための文章です。\n\n".repeat(100));
  await expectServerSaved(page);
  return f;
}
async function nativeFixture() {
  requireNativeVisibilityCoverage();
  const native = await createNativeHeadfulContext(1280);
  // Native CDP contexts need an absolute app entry for ownerLogin's relative URL.
  await native.page.goto(`${configuredBaseURL}/desktop/`);
  const authToken = process.env.CODEXIA_E2E_AUTH_TOKEN ?? "";
  await native.page.getByLabel("アクセス・トークン").fill(authToken);
  await native.page.getByRole("button", { name: "PostgreSQL作品を開く" }).click();
  return native;
}

for (const kind of ["writing", "reading", "superseded reading"] as const) {
  test(`a delayed scene handles the chosen remote ${kind} position`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const { project, scene, second } = await createWritingFixture(page, "mobile");
    const path = `/api/v1/persistence/projects/${project.id}/documents/${second.id}`;
    const read = await page.request.get(path);
    expect(read.ok()).toBe(true);
    const { revision } = await read.json() as { revision: { id: string; markdown: string } };
    const prefix = "第一文です。第二文です。";
    const body = prefix + "第三文の始めです。\n\n" + "続きの原稿を読書ページへ表示します。\n\n".repeat(120);
    const patched = await page.request.patch(path, {
      headers: { Origin: new URL(page.url()).origin, "Idempotency-Key": randomUUID(), "X-Client-Id": "handoff-fixture" },
      data: {
        baseRevisionId: revision.id,
        changes: [{ fromUtf16: 0, toUtf16: revision.markdown.length, insert: body }],
        resultingSha256: createHash("sha256").update(body).digest("hex"),
      },
    });
    expect(patched.ok()).toBe(true);
    await remotePosition(page, project.id, second.id, 3);
    await page.reload();
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
    await page.getByRole("button", { name: "構成", exact: true }).click();
    const sheet = page.locator("ion-modal.mobile-shell-reference-modal");
    await sheet.locator(".pg-library-continue summary").click();
    const candidate = sheet.getByRole("region", { name: "続きから" }).locator("p").filter({ hasText: second.title });
    try {
      await candidate.getByRole("button", { name: kind === "writing" ? "続きを書く" : "読書位置を開く" }).click();
      await loadStarted;
      await expect(manuscriptEditor(page)).toHaveCount(0);
      if (kind === "superseded reading") {
        await expect(sheet).toBeHidden();
        await page.getByRole("button", { name: "作品", exact: true }).click();
        await page.locator(`.pg-outline-item[data-document-id="${scene.id}"] .pg-outline-document`).click();
        await page.getByRole("button", { name: "書く", exact: true }).click();
      }
    } finally {
      releaseLoad();
    }
    await expect(sheet).toBeHidden();
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
      // The editor stays unfocused on mobile to keep the soft keyboard closed.
      // Read its logical selection instead of focusing the contenteditable from the test.
      await expect.poll(() => manuscriptEditor(page).evaluate((element) => {
        const content = element as HTMLElement & { cmTile?: { root: { view: { state: { selection: { main: { head: number } } } } } } };
        return content.cmTile?.root.view.state.selection.main.head;
      })).toBe(prefix.length);
    }
  });
}

test("recent activity hands off only numeric positions across devices, projects, and API restart", async ({ browser, page }) => {
  const f = await longFixture(page);
  const writes: Record<string, unknown>[] = [];
  page.on("request", (request) => { if (request.method() === "PUT" && request.url().endsWith("/recent-activity")) writes.push(request.postDataJSON()); });
  await manuscriptEditor(page).press("Control+End");
  await expect.poll(async () => (await activity(page, f.project.id)).items.some((item) => item.sceneId === f.scene.id && typeof item.sentenceOffset === "number")).toBe(true);
  for (const write of writes) expect(Object.keys(write).every((key) => ["sceneId", "sentenceOffset", "pageIndex", "deviceType"].includes(key))).toBe(true);
  await remotePosition(page, f.project.id, f.scene.id);
  const mobile = await browser.newContext({ viewport: { width: 390, height: 900 }, isMobile: true, hasTouch: true });
  const secondPage = await mobile.newPage();
  try {
    await ownerLogin(secondPage, `/mobile/projects/${f.project.id}/scenes/${f.scene.id}?view=writing`);
    await expect(manuscriptEditor(secondPage)).toContainText("読書位置");
    const before = await activity(page, f.project.id);
    expect(before.items.some((item) => item.deviceType === "mobile" && item.pageIndex === 2)).toBe(true);
    const another = await page.request.post("/api/v1/persistence/projects", { headers: { Origin: new URL(page.url()).origin }, data: { title: `Isolated cursor ${crypto.randomUUID()}` } });
    expect(another.status()).toBe(201);
    const { project } = await another.json(); expect((await activity(page, project.id)).items).toEqual([]);
    const control = new URL(page.url()); control.port = String(Number(control.port) + 1); control.pathname = "/__e2e/restart-api";
    expect((await fetch(control, { method: "POST" })).status).toBe(204);
    await ownerLogin(page);
    expect((await activity(page, f.project.id)).items.some((item) => item.sceneId === f.scene.id && item.deviceType === "mobile")).toBe(true);
    const anonymous = await browser.newContext(); try { const denial = await anonymous.request.get(`${new URL(page.url()).origin}/api/projects/${f.project.id}/recent-activity`); expect(denial.status()).toBe(401); } finally { await anonymous.close(); }
  } finally { await mobile.close(); }
});

test("recent activity polling pauses while naturally hidden and resumes when visible", async () => {
  const native = await nativeFixture(); const { page, context } = native;
  let background: Page | undefined;
  try {
    const f = await longFixture(page); let requests = 0;
    page.on("request", (request) => { if (request.method() === "GET" && request.url().endsWith("/recent-activity")) requests += 1; });
    await page.reload(); await expect.poll(() => requests).toBeGreaterThan(0);
    background = await context.newPage(); await background.goto("about:blank"); await background.bringToFront();
    await expect.poll(() => page.evaluate(() => document.visibilityState)).toBe("hidden");
    const hidden = requests;
    await page.waitForTimeout(15_500); expect(requests).toBe(hidden);
    await remotePosition(page, f.project.id, f.scene.id);
    await page.bringToFront(); await expect.poll(() => page.evaluate(() => document.visibilityState)).toBe("visible");
    await expect.poll(() => requests).toBeGreaterThan(hidden);
    await expect(page.getByText(/スマホでたった今まで編集していました/u)).toBeVisible();
    const visible = requests; await page.waitForTimeout(15_500); expect(requests).toBe(visible + 1);
  } finally { await background?.close(); await native.close(); }
});

test("recent activity ignores a refresh response invalidated by natural hide", async () => {
  const native = await nativeFixture(); const { page, context } = native;
  let background: Page | undefined;
  let release!: () => void;
  try {
    const f = await longFixture(page); let started!: () => void;
    const pending = new Promise<void>((resolve) => { started = resolve; });
    const held = new Promise<void>((resolve) => { release = resolve; });
    let first = true;
    await page.route(`**/api/projects/${f.project.id}/recent-activity`, async (route) => {
      if (route.request().method() !== "GET" || !first) return route.continue();
      first = false; started(); await held;
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ items: [{ sceneId: f.second.id, sentenceOffset: 999, pageIndex: null, deviceType: "mobile", updatedAt: new Date().toISOString() }] }) }).catch(() => undefined);
    });
    await page.evaluate(() => window.dispatchEvent(new Event("focus"))); await pending;
    background = await context.newPage(); await background.goto("about:blank"); await background.bringToFront();
    await expect.poll(() => page.evaluate(() => document.visibilityState)).toBe("hidden");
    release(); await page.waitForTimeout(100);
    await page.bringToFront(); await expect.poll(() => page.evaluate(() => document.visibilityState)).toBe("visible");
    await expect(page.locator(".continue-panel")).not.toContainText("999");
    await expect(manuscriptEditor(page)).toContainText("読書位置");
  } finally { release?.(); await background?.close(); await native.close(); }
});

test("recent activity coalesces repeated positions and records 50 input reports", async ({ page }) => {
  const f = await longFixture(page); const writes: Record<string, unknown>[] = [];
  page.on("request", (request) => { if (request.method() === "PUT" && request.url().endsWith("/recent-activity")) writes.push(request.postDataJSON()); });
  const editor = manuscriptEditor(page); await editor.press("Control+End");
  await expect.poll(() => writes.length, { timeout: 6_000 }).toBeGreaterThan(0);
  await page.waitForTimeout(2_100); const count = writes.length;
  await page.locator(".cm-scroller").evaluate((element) => { for (let n = 0; n < 50; n += 1) element.dispatchEvent(new Event("scroll")); });
  await expect.poll(() => writes.length, { timeout: 6_000 }).toBe(count + 1);
  expect(writes.at(-1)).toEqual(writes.at(-2));
  const inputCount = writes.length; await editor.press("End"); await page.keyboard.type("x".repeat(50), { delay: 0 });
  await expect.poll(() => writes.length, { timeout: 6_000 }).toBe(inputCount + 1);
  expect((await activity(page, f.project.id)).items.some((item) => item.sceneId === f.scene.id)).toBe(true);
});

for (const departure of [false, true]) {
  test(`recent activity rejects reversed PUT delivery${departure ? " during pagehide keepalive" : ""}`, async ({ browser, page }) => {
    const f = await longFixture(page);
    const editor = manuscriptEditor(page);
    await editor.press("Control+End");
    await expect.poll(async () => (await activity(page, f.project.id)).items.some((item) => item.sceneId === f.scene.id && item.deviceType === "desktop" && (item.sentenceOffset ?? 0) > 1)).toBe(true);
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
      await expect.poll(async () => (await activity(page, f.project.id)).items.find((item) => item.deviceType === "desktop")?.sentenceOffset).toBe(latest.sentenceOffset);
      const newer = (await activity(page, f.project.id)).items.find((item) => item.deviceType === "desktop");
      const olderResponse = page.waitForResponse((response) => response.url().endsWith("/recent-activity") &&
        response.request().method() === "PUT" && response.request().postDataJSON().sentenceOffset === 1);
      release();
      expect((await olderResponse).ok()).toBe(true);
      expect((await activity(page, f.project.id)).items.find((item) => item.deviceType === "desktop")).toEqual(newer);
      const mobile = await browser.newContext({ viewport: { width: 390, height: 900 }, isMobile: true, hasTouch: true });
      try {
        const other = await mobile.newPage();
        await ownerLogin(other, `/mobile/projects/${f.project.id}/scenes/${f.scene.id}?view=writing`);
        expect((await activity(other, f.project.id)).items.find((item) => item.deviceType === "desktop")?.sentenceOffset).toBe(latest.sentenceOffset);
      } finally { await mobile.close(); }
    } finally {
      release();
      await page.unroute(url);
    }
  });
}
