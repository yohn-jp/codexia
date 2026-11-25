import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, test } from "./author-oauth-fixture";
import { expectServerSaved, manuscriptEditor, openRevisionHistory } from "./postgres-fixture";
import { buildManuscript, createDocument, type CreatedDocument } from "./visual-manuscript-fixture";

async function selectTheme(page: Page, mode: "light" | "dark" | "paper"): Promise<void> {
  await page.getByLabel("外観").selectOption(mode);
}

async function selectMobileTheme(page: Page, mode: "light" | "dark" | "paper"): Promise<void> {
  const returnToWriting = page.getByRole("button", { name: "執筆画面へ戻る" });
  if (await page.getByLabel("外観").count() === 0 || !await page.getByLabel("外観").isVisible()) {
    await page.getByRole("button", { name: "設定を開く" }).click();
    await expect(returnToWriting).toBeVisible();
    await selectTheme(page, mode);
    await returnToWriting.click();
    await expect(manuscriptEditor(page)).toBeVisible();
    return;
  }
  await selectTheme(page, mode);
}

async function openMobileReferenceSheet(page: Page, buttonName: "構成" | "知識・保存", panel: "outline" | "inspector"): Promise<void> {
  await page.evaluate(() => {
    const windowWithSheet = window as Window & { __referenceSheetPresented?: boolean };
    windowWithSheet.__referenceSheetPresented = false;
    document.querySelector("ion-modal.mobile-shell-reference-modal")?.addEventListener("ionModalDidPresent", () => {
      windowWithSheet.__referenceSheetPresented = true;
    }, { once: true });
  });
  await page.getByRole("button", { name: buttonName, exact: true }).click();
  await expect(page.locator("ion-modal.mobile-shell-reference-modal.show-modal")).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as Window & { __referenceSheetPresented?: boolean }).__referenceSheetPresented)).toBe(true);
  await expect(page.locator(`#mobile-reference-tab-${panel}`)).toHaveAttribute("aria-selected", "true");
}

test("renders and exercises the full Quiet Page authoring surfaces", async ({ page, authorizeAuthor }, testInfo) => {
  test.setTimeout(180_000);
  const captureDirectory = process.env.CODEXIA_UI_REVIEW_CAPTURE_DIR ?? testInfo.outputPath("ui-review");
  await mkdir(captureDirectory, { recursive: true });
  await page.addInitScript(() => {
    const windowWithMetrics = window as Window & {
      __codexiaVitals?: {
        lcpMs: number | null;
        cls: number;
        shifts: Array<{
          startTime: number;
          value: number;
          sources: Array<{ node: string; previousRect: DOMRectReadOnly; currentRect: DOMRectReadOnly }>;
          shellState?: Record<string, unknown>;
        }>;
      };
    };
    const vitals = {
      lcpMs: null as number | null,
      cls: 0,
      shifts: [] as Array<{ startTime: number; value: number; sources: Array<{ node: string; previousRect: DOMRectReadOnly; currentRect: DOMRectReadOnly }> }>,
    };
    windowWithMetrics.__codexiaVitals = vitals;
    try {
      new PerformanceObserver((list) => {
        const latest = list.getEntries().at(-1);
        if (latest) vitals.lcpMs = latest.startTime;
      }).observe({ type: "largest-contentful-paint", buffered: true });
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          const shift = entry as PerformanceEntry & {
            hadRecentInput?: boolean;
            value?: number;
            sources?: Array<{ node?: Node; previousRect: DOMRectReadOnly; currentRect: DOMRectReadOnly }>;
          };
          if (!shift.hadRecentInput) {
            const value = shift.value ?? 0;
            vitals.cls += value;
            vitals.shifts.push({
              startTime: Math.round(shift.startTime),
              value: Number(value.toFixed(4)),
              sources: (shift.sources ?? []).map(({ node, previousRect, currentRect }) => {
                let element = node instanceof Element ? node : node?.parentElement;
                const parts: string[] = [];
                for (let depth = 0; element && depth < 4; depth += 1, element = element.parentElement) {
                  parts.push(`${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : ""}${typeof element.className === "string" && element.className.trim() ? `.${element.className.trim().split(/\\s+/u).join(".")}` : ""}`);
                }
                return { node: parts.join(" <- "), previousRect, currentRect };
              }),
              ...(document.querySelector<HTMLElement>(".mobile-shell-footer") ? {
                shellState: (() => {
                  const footer = document.querySelector<HTMLElement>(".mobile-shell-footer")!;
                  const box = (selector: string) => {
                    const element = footer.querySelector<HTMLElement>(selector);
                    if (!element) return null;
                    const style = getComputedStyle(element);
                    return {
                      height: Number(element.getBoundingClientRect().height.toFixed(1)),
                      display: style.display,
                      visibility: style.visibility,
                    };
                  };
                  return {
                    footerHeight: Number(footer.getBoundingClientRect().height.toFixed(1)),
                    keyboardOpen: document.querySelector(".mobile-shell.mobile-shell-keyboard-open") !== null,
                    accessories: box(".mobile-shell-writing-accessories"),
                    status: box(".mobile-shell-status"),
                    navigation: box(".mobile-shell-navigation"),
                    activeView: document.querySelector(".mobile-shell")?.className ?? "",
                    titleHeight: Number(document.querySelector(".mobile-shell-identity-bar")?.getBoundingClientRect().height.toFixed(1) ?? "0"),
                  };
                })(),
              } : {}),
            });
          }
        }
      }).observe({ type: "layout-shift", buffered: true });
    } catch {
      // Unsupported performance entries remain null and are recorded as unavailable.
    }
  });
  const performanceRecords: Array<Record<string, unknown>> = [];
  const interactionMeasurementsMs: Record<string, number> = {};
  const measureSince = async (mark: string): Promise<number> => page.evaluate((name) => {
    const start = performance.getEntriesByName(`${name}:start`, "mark").at(-1);
    return start ? Math.round(performance.now() - start.startTime) : -1;
  }, mark);
  const capturePerformance = async (mode: "desktop" | "mobile") => {
    const record = await page.evaluate((screenMode) => {
      const navigation = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
      const resources = performance.getEntriesByType("resource") as PerformanceResourceTiming[];
      const origin = window.location.origin;
      const ownResources = resources.filter((entry) => entry.name.startsWith(origin));
      const bundle = ownResources.filter((entry) => new URL(entry.name).pathname.includes("/assets/index-"));
      const vitals = (window as Window & {
        __codexiaVitals?: {
          lcpMs: number | null;
          cls: number;
          shifts: Array<{
            startTime: number;
            value: number;
            sources: Array<{ node: string; previousRect: DOMRectReadOnly; currentRect: DOMRectReadOnly }>;
            shellState?: Record<string, unknown>;
          }>;
        };
      }).__codexiaVitals;
      return {
        mode: screenMode,
        viewport: { width: window.innerWidth, height: window.innerHeight },
        domContentLoadedMs: navigation ? Math.round(navigation.domContentLoadedEventEnd) : null,
        loadEventEndMs: navigation ? Math.round(navigation.loadEventEnd) : null,
        responseStartMs: navigation ? Math.round(navigation.responseStart) : null,
        sameOriginTransferBytes: ownResources.reduce((sum, entry) => sum + entry.transferSize, 0),
        mainBundleTransferBytes: bundle.reduce((sum, entry) => sum + entry.transferSize, 0),
        mainBundleCount: bundle.length,
        lcpMs: vitals?.lcpMs === null || vitals?.lcpMs === undefined ? null : Math.round(vitals.lcpMs),
        cls: vitals ? Number(vitals.cls.toFixed(4)) : null,
        layoutShifts: vitals?.shifts ?? [],
      };
    }, mode);
    performanceRecords.push(record);
  };
  await page.setViewportSize({ width: 1440, height: 900 });
  const { project, firstScene } = await buildManuscript(page, "desktop", authorizeAuthor);
  const network = await page.context().newCDPSession(page);
  await network.send("Network.enable");
  await network.send("Network.setCacheDisabled", { cacheDisabled: true });
  await authorizeAuthor("desktop", page, { path: `/desktop/projects/${project.id}/scenes/${firstScene.id}` });
  await expect(manuscriptEditor(page)).toBeVisible();
  await capturePerformance("desktop");

  await selectTheme(page, "light");
  await expect(page.getByRole("button", { name: "執筆" })).toHaveAttribute("aria-pressed", "true");
  await page.screenshot({ path: join(captureDirectory, "after-desktop-writing.png") });
  await page.setViewportSize({ width: 1024, height: 768 });
  await expect(manuscriptEditor(page)).toBeVisible();
  await page.screenshot({ path: join(captureDirectory, "after-desktop-writing-1024.png") });
  await page.setViewportSize({ width: 1440, height: 900 });

  await page.locator(".pg-editor-command-menu > summary").click();
  await openRevisionHistory(page);
  await expect(page.getByRole("region", { name: "Revision履歴" })).toContainText("羅針盤");
  await page.getByText("最新版との違い", { exact: true }).click();
  await expect(page.locator(".pg-revision-diff-preview")).toContainText("まだ誰にも読まれていない海図");
  await page.locator(".pg-revision-diff-preview").scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(captureDirectory, "after-desktop-revisions.png") });
  await openRevisionHistory(page);

  await page.evaluate(() => performance.mark("desktop-research:start"));
  await page.getByRole("button", { name: "調査" }).click();
  await expect(page.locator('.st-workspace[data-preset="research"]')).toBeVisible();
  await expect(page.locator('[data-workspace-panel="inspector"]')).toBeVisible();
  interactionMeasurementsMs.desktopResearchPreset = await measureSince("desktop-research");
  await page.screenshot({ path: join(captureDirectory, "after-desktop-research.png") });
  await selectTheme(page, "dark");
  await page.screenshot({ path: join(captureDirectory, "after-desktop-research-dark.png") });
  await selectTheme(page, "light");

  await page.evaluate(() => performance.mark("desktop-review:start"));
  await page.getByRole("button", { name: "レビュー" }).click();
  await expect(page.locator('.st-workspace[data-preset="review"]')).toBeVisible();
  await expect(page.locator('[data-workspace-panel="review"]')).toBeVisible();
  await expect(page.locator('[data-workspace-panel="review"]')).toContainText("凪");
  interactionMeasurementsMs.desktopReviewPreset = await measureSince("desktop-review");
  await page.screenshot({ path: join(captureDirectory, "after-desktop-review.png") });
  await selectTheme(page, "dark");
  await page.screenshot({ path: join(captureDirectory, "after-desktop-review-dark.png") });
  await selectTheme(page, "light");

  await page.getByRole("button", { name: "執筆" }).click();
  await selectTheme(page, "paper");
  await page.screenshot({ path: join(captureDirectory, "after-desktop-paper.png") });
  await selectTheme(page, "dark");
  await page.screenshot({ path: join(captureDirectory, "after-desktop-dark.png") });

  await page.setViewportSize({ width: 390, height: 844 });
  await authorizeAuthor("mobile", page, { path: `/mobile/projects/${project.id}/scenes/${firstScene.id}?view=writing` });
  await expect(manuscriptEditor(page)).toBeVisible();
  await capturePerformance("mobile");
  await selectMobileTheme(page, "light");
  await page.screenshot({ path: join(captureDirectory, "after-mobile-writing.png") });
  const editor = manuscriptEditor(page);
  await editor.evaluate((element) => { (window as Window & { __redesignEditorNode?: Element }).__redesignEditorNode = element; });
  await page.evaluate(() => performance.mark("mobile-outline-sheet:start"));
  await openMobileReferenceSheet(page, "構成", "outline");
  await expect(page.locator("ion-modal")).toContainText("第二章　濡れた目録");
  interactionMeasurementsMs.mobileOutlineSheet = await measureSince("mobile-outline-sheet");
  await page.screenshot({ path: join(captureDirectory, "after-mobile-reference.png") });
  await page.getByRole("button", { name: "閉じる" }).click();
  await expect(page.locator("ion-modal.mobile-shell-reference-modal")).toBeHidden();
  await expect(editor).toBeVisible();
  expect(await page.evaluate(() => document.querySelector('[aria-labelledby="pg-manuscript-label"]') === (window as Window & { __redesignEditorNode?: Element }).__redesignEditorNode)).toBe(true);

  await openMobileReferenceSheet(page, "知識・保存", "inspector");
  await expect(page.locator("ion-modal")).toContainText("真鍮の羅針盤");
  await expectServerSaved(page);
  await page.screenshot({ path: join(captureDirectory, "after-mobile-knowledge.png") });
  await page.getByRole("button", { name: "閉じる" }).click();
  await expect(page.locator("ion-modal.mobile-shell-reference-modal")).toBeHidden();
  await expect(page.getByRole("button", { name: "構成", exact: true })).toBeVisible();
  await selectMobileTheme(page, "dark");
  await openMobileReferenceSheet(page, "構成", "outline");
  await page.screenshot({ path: join(captureDirectory, "after-mobile-reference-dark.png") });
  await page.getByRole("button", { name: "閉じる" }).click();
  await expect(page.locator("ion-modal.mobile-shell-reference-modal")).toBeHidden();
  await openMobileReferenceSheet(page, "知識・保存", "inspector");
  await expect(page.locator("ion-modal")).toContainText("真鍮の羅針盤");
  await page.screenshot({ path: join(captureDirectory, "after-mobile-knowledge-dark.png") });
  await page.getByRole("button", { name: "閉じる" }).click();
  await expect(page.locator("ion-modal.mobile-shell-reference-modal")).toBeHidden();

  await page.setViewportSize({ width: 320, height: 760 });
  await expect(manuscriptEditor(page)).toBeVisible();
  const pageWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(pageWidth).toBeLessThanOrEqual(320);
  await page.screenshot({ path: join(captureDirectory, "after-mobile-320.png") });
  await selectMobileTheme(page, "dark");
  await page.screenshot({ path: join(captureDirectory, "after-mobile-dark.png") });
  await writeFile(join(captureDirectory, "performance.json"), JSON.stringify({
    method: "Local Chromium headless navigation timing; lab evidence, not field Core Web Vitals.",
    observations: performanceRecords,
    interactions: interactionMeasurementsMs,
  }, null, 2) + "\n");
});

test("mobile manuscript disclosures remain operable at 320 and 390 CSS pixels", async ({ page, authorizeAuthor }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const { project, firstScene, author } = await buildManuscript(page, "desktop", authorizeAuthor);
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await authorizeAuthor("mobile", page, { path: `/mobile/projects/${project.id}/scenes/${firstScene.id}?view=writing` });
    await expect(manuscriptEditor(page)).toBeVisible();
    await expectServerSaved(page);
    const command = page.locator(".pg-editor-command-menu");
    await command.locator("summary").click();
    // A visible DOM node is not necessarily hit-testable when clipped.
    // Use actual clicks (no force, no programmatic scrolling inside the toolbar).
    await command.getByRole("button", { name: "Revision履歴", exact: true }).click();
    await expect(page.getByRole("region", { name: "Revision履歴" })).toBeVisible();
    await command.getByRole("button", { name: "Revision履歴", exact: true }).click();
    await expect(page.getByRole("region", { name: "Revision履歴" })).toHaveCount(0);
    await command.locator("summary").click();
    const display = page.locator(".pg-editor-display-menu");
    await display.locator("summary").click();
    const fontSize = display.getByRole("spinbutton", { name: "原稿の文字サイズ" });
    await fontSize.click();
    await fontSize.fill("18");
    await expect(fontSize).toHaveValue("18");
    if (!await display.evaluate((element) => (element as HTMLDetailsElement).open)) await display.locator("summary").click();
    const symbols = page.locator(".pg-editor-symbol-menu");
    const symbol = width === 390 ? { label: "三点リーダーを挿入", text: "……" } : { label: "ダッシュを挿入", text: "――" };
    await symbols.getByRole("button", { name: symbol.label }).click();
    await expect(manuscriptEditor(page)).toContainText(symbol.text);
    await display.locator("summary").click();
    // The normal autosave may finish before a manual save can be clicked.
    await expect.poll(async () => {
      const response = await author.fetch(`/api/v1/persistence/projects/${project.id}/documents/${firstScene.id}`);
      if (!response.ok()) return "";
      const { revision } = await response.json() as { revision: { markdown: string } };
      return revision.markdown;
    }, { timeout: 15_000 }).toContain(symbol.text);
    await expectServerSaved(page);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  }
});

test("outline preserves database sibling order and reveals a navigated document", async ({ page, authorizeAuthor }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const { project, firstScene, author } = await buildManuscript(page, "desktop", authorizeAuthor);
  const url = `/api/v1/persistence/projects/${project.id}/documents`;
  const list = async () => {
    const response = await author.fetch(url);
    expect(response.ok()).toBe(true);
    return (await response.json() as { documents: Array<CreatedDocument & { title: string; parentId: string | null; orderKey: string }> }).documents;
  };
  const parentId = (await list()).find(document => document.id === firstScene.id)!.parentId!;
  const a = await createDocument(author, project.id, { kind: "scene", parentId, title: "同順A", orderKey: "04", markdown: "同順の原稿A" });
  const b = await createDocument(author, project.id, { kind: "scene", parentId, title: "同順B", orderKey: "04", markdown: "同順の原稿B" });
  const siblingsBefore = (await list()).filter(document => document.parentId === parentId);
  const ties = siblingsBefore.filter(document => document.id === a.id || document.id === b.id);
  expect(ties).toHaveLength(2);
  const renamed = new Map([[ties[0]!.id, "ZZZ同順"], [ties[1]!.id, "AAA同順"]]);
  for (const document of ties) {
    const response = await author.fetch(`${url}/${document.id}/metadata`, {
      method: "PATCH",
      headers: { Origin: author.origin },
      data: { expectedVersion: document.version, title: renamed.get(document.id) },
    });
    expect(response.ok(), await response.text()).toBe(true);
  }
  const persisted = await list();
  expect(persisted.filter(document => document.parentId === parentId).map(document => document.id))
    .toEqual(siblingsBefore.map(document => document.id));
  const expected = siblingsBefore.map(document => renamed.get(document.id) ?? document.title);
  const other = persisted.find(document => document.title === "一　青い目録")!;
  await page.reload();
  await authorizeAuthor("desktop", page, { continueCurrentPage: true });
  await expect(manuscriptEditor(page)).toBeVisible();
  // Bind UI rows to the actual persisted IDs, not whitespace-normalized names.
  const outline = page.locator('[data-workspace-panel="outline"]');
  const rowSelector = (id: string) => `.pg-outline-item[data-document-id="${id}"]`;
  const row = (id: string) => outline.locator(rowSelector(id));
  const select = (id: string) => outline.locator(`${rowSelector(id)} > .pg-outline-row > .pg-outline-document`);
  const toggle = outline.locator(`${rowSelector(parentId)} > .pg-outline-row > .pg-outline-toggle`);
  await expect(row(parentId)).toBeVisible();
  await expect(outline.locator(`${rowSelector(parentId)} > .pg-document-children > li > .pg-outline-row > .pg-outline-document > span`)).toHaveText(expected);
  await select(other.id).click();
  await expect(manuscriptEditor(page)).toBeVisible();
  await expect(select(other.id)).toHaveAttribute("aria-current", "page");
  await toggle.click();
  await expect(select(firstScene.id)).toHaveCount(0);
  await page.goBack();
  await expect(select(firstScene.id)).toHaveAttribute("aria-current", "page");
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(manuscriptEditor(page)).toContainText("誰かが選ばなかった未来");
  // Explicit collapse of the current branch does not change the selected manuscript.
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(manuscriptEditor(page)).toContainText("誰かが選ばなかった未来");
});

test("Core benchmark browser worker measures the redesigned manuscript and persisted receipts", async () => {
  test.skip(process.env.CODEXIA_PROFILE !== "core" || !process.env.CODEXIA_CI_REPORT_DIR,
    "The Core CI browser lane owns the disposable benchmark smoke database.");
  test.setTimeout(240_000);
  const { stdout } = await promisify(execFile)(process.execPath, ["scripts/performance/ci-browser-smoke.mjs"], {
    timeout: 220_000, maxBuffer: 4 * 1024 * 1024,
  });
  expect(stdout).toContain("PostgreSQL browser benchmark smoke passed");
});
