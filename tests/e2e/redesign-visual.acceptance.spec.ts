import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { expectServerSaved, manuscriptEditor, ownerLogin, openRevisionHistory } from "./postgres-fixture";

const prose = [
  "　港町の朝は、潮の匂いと、まだ眠っている街の静けさから始まる。凪は古い灯台の階段を上りながら、昨夜から胸に残っている小さな違和感を、ひとつずつ確かめていた。",
  "　最上階の窓を開けると、海の向こうに薄い金色の線が見えた。水平線は昨日よりも近い。波間に浮かぶ黒い影は、誰も地図に描かなかった島の輪郭に似ていた。",
  "「お父さん、海が少し変だよ」",
  "　返事のかわりに、手の中の羅針盤がかすかな音を立てた。針は北ではなく、街の地下へ向いている。真鍮の縁には、祖母が旅立った年に刻まれた小さな傷が残っていた。",
  "　石段の先にあったのは、海水に満たされた書庫だった。天井まで続く本棚のあいだを、青白い光がゆっくりと流れている。表紙にはどれも、まだ起きていない出来事の日付が記されていた。",
  "　凪は一冊を開いた。そこには、灯台の窓辺で自分が羅針盤を握る姿が、今と同じ服のまま描かれている。最後の一行だけが濡れて読めなかった。ページをめくる音が、遠くの波と重なって響く。",
  "　ここにある記録は、過去ではない。誰かが選ばなかった未来の、静かな目録なのだ。凪は濡れた余白へ指を置き、まだ知らない自分の名前を、ゆっくりと読み上げた。",
].join("\n\n");

const manuscript = [
  "# 潮目の図書館",
  "",
  "## 第一章　灯台守の娘",
  "",
  "### 一　薄明の羅針盤",
  "",
  prose,
  "",
  "### 二　波間の記録",
  "",
  prose.replace("まだ眠っている街", "雨上がりの街").replace("羅針盤がかすかな音", "硝子玉がかすかな音"),
  "",
  "### 三　地下書庫の入口",
  "",
  prose.replace("灯台の階段", "石造りの回廊"),
].join("\n");

interface CreatedDocument { id: string; headRevisionId: string; version: number }

async function createDocument(page: Page, projectId: string, input: {
  kind: "volume" | "chapter" | "scene";
  title: string;
  orderKey: string;
  markdown?: string;
  parentId?: string;
}): Promise<CreatedDocument> {
  const response = await page.request.post(`/api/v1/persistence/projects/${projectId}/documents`, {
    headers: { Origin: new URL(page.url()).origin, "Idempotency-Key": randomUUID() },
    data: { markdown: "", ...input },
  });
  expect(response.status(), await response.text()).toBe(201);
  const result = await response.json() as { document: CreatedDocument };
  return result.document;
}

async function buildManuscript(page: Page, mode: "desktop" | "mobile") {
  await ownerLogin(page, `/${mode}/`);
  const origin = new URL(page.url()).origin;
  const projectResponse = await page.request.post("/api/v1/persistence/projects", {
    headers: { Origin: origin },
    data: { title: `潮目の図書館・視覚確認 ${randomUUID().slice(0, 8)}`, settings: { language: "ja" } },
  });
  expect(projectResponse.status(), await projectResponse.text()).toBe(201);
  const { project } = await projectResponse.json() as { project: { id: string } };
  const volume = await createDocument(page, project.id, { kind: "volume", title: "第一巻　潮が満ちる", orderKey: "01" });
  const firstChapter = await createDocument(page, project.id, { kind: "chapter", parentId: volume.id, title: "第一章　灯台守の娘", orderKey: "01" });
  const secondChapter = await createDocument(page, project.id, { kind: "chapter", parentId: volume.id, title: "第二章　濡れた目録", orderKey: "02" });
  const firstScene = await createDocument(page, project.id, {
    kind: "scene", parentId: firstChapter.id, title: "一　薄明の羅針盤", orderKey: "01", markdown: manuscript,
  });
  await createDocument(page, project.id, { kind: "scene", parentId: firstChapter.id, title: "二　波間の記録", orderKey: "02", markdown: prose });
  await createDocument(page, project.id, { kind: "scene", parentId: firstChapter.id, title: "三　地下書庫の入口", orderKey: "03", markdown: prose });
  await createDocument(page, project.id, { kind: "scene", parentId: secondChapter.id, title: "一　青い目録", orderKey: "01", markdown: prose });
  await createDocument(page, project.id, { kind: "scene", parentId: secondChapter.id, title: "二　選ばれなかった明日", orderKey: "02", markdown: prose });
  await createDocument(page, project.id, { kind: "scene", parentId: secondChapter.id, title: "三　帰港", orderKey: "03", markdown: prose });

  const nodeId = randomUUID();
  const nodeResponse = await page.request.put(`/api/v1/persistence/projects/${project.id}/nodes/${nodeId}`, {
    headers: { Origin: origin },
    data: { type: "object", name: "真鍮の羅針盤", attributes: { owner: "灯台守の家", origin: "海図室" }, status: "confirmed", expectedVersion: null },
  });
  expect(nodeResponse.ok(), await nodeResponse.text()).toBe(true);
  const initial = manuscript;
  const addition = "\n\n　羅針盤の縁には、まだ誰にも読まれていない海図の方角が刻まれていた。";
  const revised = initial + addition;
  const revisionResponse = await page.request.patch(`/api/v1/persistence/projects/${project.id}/documents/${firstScene.id}`, {
    headers: { Origin: origin, "Idempotency-Key": randomUUID(), "X-Client-Id": "visual-redesign-fixture" },
    data: {
      baseRevisionId: firstScene.headRevisionId,
      changes: [{ fromUtf16: initial.length, toUtf16: initial.length, insert: addition }],
      resultingSha256: createHash("sha256").update(revised).digest("hex"),
      clientId: "visual-redesign-fixture",
    },
  });
  expect(revisionResponse.ok(), await revisionResponse.text()).toBe(true);
  const { revision } = await revisionResponse.json() as { revision: { id: string } };
  const anchorStart = revised.indexOf("羅針盤");
  const evidenceResponse = await page.request.post(`/api/v1/persistence/projects/${project.id}/documents/${firstScene.id}/anchors`, {
    headers: { Origin: origin },
    data: { id: randomUUID(), revisionId: revision.id, fromUtf16: anchorStart, toUtf16: anchorStart + "羅針盤".length, status: "confirmed", nodeId },
  });
  expect(evidenceResponse.status(), await evidenceResponse.text()).toBe(201);

  const currentProjectResponse = await page.request.get(`/api/v1/persistence/projects/${project.id}`);
  expect(currentProjectResponse.ok(), await currentProjectResponse.text()).toBe(true);
  const currentProject = await currentProjectResponse.json() as { project: { version: number } };
  const proposalResponse = await page.request.post(`/api/v1/persistence/projects/${project.id}/changesets`, {
    headers: { Origin: origin, "Idempotency-Key": randomUUID() },
    data: {
      projectVersion: currentProject.project.version,
      operations: [{ type: "knowledge.node.save", command: {
        projectId: project.id,
        id: randomUUID(),
        type: "person",
        name: "凪",
        attributes: { role: "灯台守の娘", source: "第二章　濡れた目録" },
        status: "proposed",
        expectedVersion: null,
      } }],
    },
  });
  expect(proposalResponse.status(), await proposalResponse.text()).toBe(201);

  await page.goto(new URL(`/${mode}/projects/${project.id}/scenes/${firstScene.id}${mode === "mobile" ? "?view=writing" : ""}`, page.url()).toString());
  await expect(manuscriptEditor(page)).toBeVisible();
  await expect(page.getByRole("heading", { name: "Database workspace" })).toBeVisible();
  await expectServerSaved(page);
  await expect(manuscriptEditor(page)).toContainText("誰かが選ばなかった未来");
  return { project, firstScene };
}

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

test("renders and exercises the full Quiet Page authoring surfaces", async ({ page }, testInfo) => {
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
  const { project, firstScene } = await buildManuscript(page, "desktop");
  const network = await page.context().newCDPSession(page);
  await network.send("Network.enable");
  await network.send("Network.setCacheDisabled", { cacheDisabled: true });
  await page.goto(new URL(`/desktop/projects/${project.id}/scenes/${firstScene.id}`, page.url()).toString());
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
  await page.goto(new URL(`/mobile/projects/${project.id}/scenes/${firstScene.id}?view=writing`, page.url()).toString());
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

test("mobile manuscript disclosures remain operable at 320 and 390 CSS pixels", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const { project, firstScene } = await buildManuscript(page, "desktop");
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto(new URL(`/mobile/projects/${project.id}/scenes/${firstScene.id}?view=writing`, page.url()).toString());
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
      const response = await page.request.get(`/api/v1/persistence/projects/${project.id}/documents/${firstScene.id}`);
      if (!response.ok()) return "";
      const { revision } = await response.json() as { revision: { markdown: string } };
      return revision.markdown;
    }, { timeout: 15_000 }).toContain(symbol.text);
    await expectServerSaved(page);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  }
});

test("outline preserves database sibling order and reveals a navigated document", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const { project, firstScene } = await buildManuscript(page, "desktop");
  const url = `/api/v1/persistence/projects/${project.id}/documents`;
  const list = async () => {
    const response = await page.request.get(url);
    expect(response.ok()).toBe(true);
    return (await response.json() as { documents: Array<CreatedDocument & { title: string; parentId: string | null; orderKey: string }> }).documents;
  };
  const parentId = (await list()).find(document => document.id === firstScene.id)!.parentId!;
  const a = await createDocument(page, project.id, { kind: "scene", parentId, title: "同順A", orderKey: "04", markdown: "同順の原稿A" });
  const b = await createDocument(page, project.id, { kind: "scene", parentId, title: "同順B", orderKey: "04", markdown: "同順の原稿B" });
  const siblingsBefore = (await list()).filter(document => document.parentId === parentId);
  const ties = siblingsBefore.filter(document => document.id === a.id || document.id === b.id);
  expect(ties).toHaveLength(2);
  const renamed = new Map([[ties[0]!.id, "ZZZ同順"], [ties[1]!.id, "AAA同順"]]);
  for (const document of ties) {
    const response = await page.request.patch(`${url}/${document.id}/metadata`, {
      headers: { Origin: new URL(page.url()).origin },
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
