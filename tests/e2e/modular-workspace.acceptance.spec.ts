import { expect, test, type Page } from "@playwright/test";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { authToken, ownerLogin } from "./postgres-fixture";

const profile = process.env.CODEXIA_PROFILE ?? "core";
const INITIAL_SCENE_ONE = "# Scene One\n\nThe first line of the story.\nBeacon Quay appears in this scene.\n";
const INITIAL_SCENE_TWO = "# Scene Two\n\nThe second line of the story.\nA submerged brass archive waits below Lantern Harbor.\n";

async function startMobileTransitionFixture(): Promise<{ url: string; stop(): Promise<void> }> {
  const configuredPort = process.env.CODEXIA_MOBILE_TRANSITION_PORT;
  const port = configuredPort ? Number.parseInt(configuredPort, 10) : await findAvailablePort();
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("Mobile transition fixture port must be valid");
  const url = `http://127.0.0.1:${port}`;
  const server = spawn(resolve("app/node_modules/.bin/vite"), [
    resolve("tests/e2e/mobile-transition-fixture"),
    "--config", resolve("tests/e2e/mobile-transition-fixture/vite.config.mjs"),
    "--host", "127.0.0.1", "--port", String(port), "--strictPort",
  ], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  server.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  server.stderr.on("data", (chunk: Buffer) => { output += chunk.toString(); });

  try {
    const startedAt = Date.now();
    while (Date.now() - startedAt < 30_000) {
      if (server.exitCode !== null) throw new Error(`Mobile transition Vite fixture exited early: ${output}`);
      try {
        const response = await fetch(url);
        if (response.ok) {
          return {
            url,
            async stop() {
              if (server.exitCode !== null) return;
              const exited = new Promise<void>((resolveExit) => server.once("exit", () => resolveExit()));
              server.kill("SIGTERM");
              await Promise.race([exited, new Promise<void>((resolveExit) => setTimeout(resolveExit, 5_000))]);
            },
          };
        }
      } catch {
        // The Vite server is still starting.
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
    }
    throw new Error(`Timed out waiting for the mobile transition Vite fixture: ${output}`);
  } catch (error) {
    server.kill("SIGTERM");
    throw error;
  }
}

async function findAvailablePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolveListen, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolveListen);
  });
  const address = probe.address();
  if (!address || typeof address === "string") throw new Error("Could not allocate a mobile transition fixture port.");
  const { port } = address;
  await new Promise<void>((resolveClose, reject) => probe.close((error) => error ? reject(error) : resolveClose()));
  return port;
}

async function openMobileTransitionFixture(page: Page): Promise<{
  server: { url: string; stop(): Promise<void> };
  navigation: ReturnType<Page["getByRole"]>;
  editor: ReturnType<Page["getByTestId"]>;
}> {
  const fixture = await startMobileTransitionFixture();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(fixture.url);
  const navigation = page.getByRole("navigation", { name: "モバイル画面" });
  const editor = page.getByTestId("fixture-editor");
  await expect(navigation).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__mobileTransitionFixture?.journalReady ?? false)).toBe(true);
  await expect(page.locator('[data-workspace-panel="editor"]')).toBeVisible();
  return { server: fixture, navigation, editor };
}

async function armMobileTransitionFixture(page: Page, outcomes: Array<boolean | "delayed">): Promise<void> {
  await page.evaluate((nextOutcomes) => window.__mobileTransitionFixture?.arm(nextOutcomes), outcomes);
}

async function mobileTransitionMetrics(page: Page): Promise<{
  guardCalls: number;
  journalCalls: number;
  journalWrites: number;
  unusedOutcomes: number;
}> {
  const metrics = await page.evaluate(() => {
    const fixture = window.__mobileTransitionFixture;
    return fixture ? {
      guardCalls: fixture.guardCalls,
      journalCalls: fixture.journalCalls,
      journalWrites: fixture.journalWrites,
      unusedOutcomes: fixture.outcomes.length,
    } : null;
  });
  if (!metrics) throw new Error("Mobile transition fixture metrics were not exposed.");
  return metrics;
}

test("mobile route navigation commits the URL, panel and focus as one guarded transition", async ({ page }) => {
  const fixture = await openMobileTransitionFixture(page);
  try {
    const { navigation, editor } = fixture;
    await editor.focus();
    await expect(editor).toBeFocused();
    await armMobileTransitionFixture(page, [true, false]);

    await navigation.getByRole("button", { name: "作品", exact: true }).click();
    await expect(page.getByTestId("fixture-route")).toHaveText("library");
    await expect(page.locator(".mobile-shell-workspace-view")).toHaveAttribute("data-active-view", "library");
    const metrics = await mobileTransitionMetrics(page);
    console.log(`mobile transition fixture metrics ${JSON.stringify(metrics)}`);

    await expect(page.locator('[data-workspace-panel="outline"]')).toBeVisible();
    await expect(editor).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.workspacePanel ?? ""))
      .toBe("outline");
    expect(metrics).toEqual({ guardCalls: 1, journalCalls: 1, journalWrites: 1, unusedOutcomes: 1 });
  } finally {
    await fixture.server.stop();
  }
});

test("mobile denials retain the current route and panel, and app back is guarded with the target panel", async ({ page }) => {
  const fixture = await openMobileTransitionFixture(page);
  try {
    const { navigation, editor } = fixture;
    const editorPanel = page.locator('[data-workspace-panel="editor"]');
    const outlinePanel = page.locator('[data-workspace-panel="outline"]');
    await editor.focus();
    await armMobileTransitionFixture(page, [false]);
    await navigation.getByRole("button", { name: "作品", exact: true }).click();
    await expect(page.getByTestId("fixture-route")).toHaveText("writing");
    await expect(editorPanel).toBeVisible();
    await expect(navigation.getByRole("button", { name: "作品", exact: true })).toBeFocused();
    expect(await mobileTransitionMetrics(page)).toEqual({ guardCalls: 1, journalCalls: 1, journalWrites: 1, unusedOutcomes: 0 });

    await armMobileTransitionFixture(page, [true]);
    await navigation.getByRole("button", { name: "作品", exact: true }).click();
    await expect(page.getByTestId("fixture-route")).toHaveText("library");
    await expect(outlinePanel).toBeVisible();
    const historyLength = await page.evaluate(() => history.length);

    await armMobileTransitionFixture(page, [true]);
    await page.getByRole("button", { name: "前の画面に戻る" }).click();
    await expect(page.getByTestId("fixture-route")).toHaveText("writing");
    await expect(editorPanel).toBeVisible();
    await expect.poll(() => page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.workspacePanel ?? ""))
      .toBe("editor");
    expect(await page.evaluate(() => history.length)).toBe(historyLength);
    expect(await mobileTransitionMetrics(page)).toEqual({ guardCalls: 1, journalCalls: 1, journalWrites: 1, unusedOutcomes: 0 });

    await page.getByRole("tablist", { name: "Workspace panels" }).getByRole("tab", { name: "Outline", exact: true }).click();
    await expect(outlinePanel).toBeVisible();
    const sameViewHistoryLength = await page.evaluate(() => history.length);
    await armMobileTransitionFixture(page, [true]);
    await navigation.getByRole("button", { name: "書く", exact: true }).click();
    await expect(editorPanel).toBeVisible();
    await expect(page.getByTestId("fixture-route")).toHaveText("writing");
    expect(await page.evaluate(() => history.length)).toBe(sameViewHistoryLength);
    expect(await mobileTransitionMetrics(page)).toEqual({ guardCalls: 1, journalCalls: 1, journalWrites: 1, unusedOutcomes: 0 });
  } finally {
    await fixture.server.stop();
  }
});

test("mobile browser back and forward synchronize guarded routes and workspace panels", async ({ page }) => {
  const fixture = await openMobileTransitionFixture(page);
  try {
    const { navigation } = fixture;
    const editorPanel = page.locator('[data-workspace-panel="editor"]');
    const outlinePanel = page.locator('[data-workspace-panel="outline"]');
    await armMobileTransitionFixture(page, [true]);
    await navigation.getByRole("button", { name: "作品", exact: true }).click();
    await expect(page.getByTestId("fixture-route")).toHaveText("library");
    await expect(outlinePanel).toBeVisible();

    await armMobileTransitionFixture(page, [true]);
    await page.goBack();
    await expect(page.getByTestId("fixture-route")).toHaveText("writing");
    await expect(editorPanel).toBeVisible();
    await expect.poll(() => page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.workspacePanel ?? ""))
      .toBe("editor");
    expect(await mobileTransitionMetrics(page)).toEqual({ guardCalls: 1, journalCalls: 1, journalWrites: 1, unusedOutcomes: 0 });

    await armMobileTransitionFixture(page, [true]);
    await page.goForward();
    await expect(page.getByTestId("fixture-route")).toHaveText("library");
    await expect(outlinePanel).toBeVisible();

    await armMobileTransitionFixture(page, [false, true]);
    await page.goBack();
    await expect(page.getByTestId("fixture-route")).toHaveText("library");
    await expect(outlinePanel).toBeVisible();
    await expect(editorPanel).toHaveCount(0);
    expect(await mobileTransitionMetrics(page)).toEqual({ guardCalls: 2, journalCalls: 2, journalWrites: 2, unusedOutcomes: 0 });
  } finally {
    await fixture.server.stop();
  }
});

test("mobile late panel requests are fenced by route and author-scope changes", async ({ page }) => {
  const fixture = await openMobileTransitionFixture(page);
  try {
    const { navigation, editor } = fixture;
    const editorPanel = page.locator('[data-workspace-panel="editor"]');
    await editor.focus();
    await armMobileTransitionFixture(page, ["delayed", true]);
    await navigation.getByRole("button", { name: "作品", exact: true }).click();
    await expect.poll(() => page.evaluate(() => window.__mobileTransitionFixture?.release !== undefined)).toBe(true);
    await expect(page.getByTestId("fixture-route")).toHaveText("writing");
    await expect(editorPanel).toBeVisible();
    await expect(editor).toBeAttached();

    await page.evaluate(() => window.__mobileTransitionFixture?.changeRoute("tools"));
    await expect(page.getByTestId("fixture-route")).toHaveText("tools");
    await page.evaluate(() => window.__mobileTransitionFixture?.changeScope("fixture-author-next"));
    await expect(page.getByTestId("fixture-scope")).toHaveText("fixture-author-next");
    await page.evaluate(() => window.__mobileTransitionFixture?.releaseGuard());

    await expect(page.getByTestId("fixture-route")).toHaveText("tools");
    await expect(page.getByTestId("fixture-scope")).toHaveText("fixture-author-next");
    await expect.poll(async () => (await mobileTransitionMetrics(page)).guardCalls).toBe(2);
    await expect(page.locator('[data-workspace-panel="review"]')).toBeVisible();
    await expect(editorPanel).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.workspacePanel ?? ""))
      .toBe("review");
    expect(await mobileTransitionMetrics(page)).toEqual({ guardCalls: 2, journalCalls: 2, journalWrites: 2, unusedOutcomes: 0 });
  } finally {
    await fixture.server.stop();
  }
});

test("mobile same-view panel requests cannot suppress a newer route and scope selection", async ({ page }) => {
  const fixture = await openMobileTransitionFixture(page);
  try {
    const { navigation } = fixture;
    const editorPanel = page.locator('[data-workspace-panel="editor"]');
    await page.getByRole("tablist", { name: "Workspace panels" }).getByRole("tab", { name: "Outline", exact: true }).click();
    await expect(page.locator('[data-workspace-panel="outline"]')).toBeVisible();

    await armMobileTransitionFixture(page, ["delayed"]);
    await navigation.getByRole("button", { name: "書く", exact: true }).click();
    await expect.poll(() => page.evaluate(() => window.__mobileTransitionFixture?.release !== undefined)).toBe(true);

    await page.evaluate(() => window.__mobileTransitionFixture?.changeRoute("tools"));
    await expect(page.getByTestId("fixture-route")).toHaveText("tools");
    await page.evaluate(() => window.__mobileTransitionFixture?.changeScope("fixture-author-next"));
    await expect(page.getByTestId("fixture-scope")).toHaveText("fixture-author-next");
    await page.evaluate(() => window.__mobileTransitionFixture?.releaseGuard());

    await expect(page.getByTestId("fixture-route")).toHaveText("tools");
    await expect(page.getByTestId("fixture-scope")).toHaveText("fixture-author-next");
    await expect.poll(async () => (await mobileTransitionMetrics(page)).guardCalls).toBe(2);
    await expect(page.locator('[data-workspace-panel="review"]')).toBeVisible();
    await expect(editorPanel).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.workspacePanel ?? ""))
      .toBe("review");
    expect(await mobileTransitionMetrics(page)).toEqual({ guardCalls: 2, journalCalls: 2, journalWrites: 2, unusedOutcomes: 0 });
  } finally {
    await fixture.server.stop();
  }
});

interface DraftRecord {
  key: string;
  projectId: string;
  documentId: string;
  authorScope: string;
  baseRevisionId: string;
  baseMarkdown: string;
  markdown: string;
  generation: number;
  updatedAt: number;
}

interface WorkspaceDocument {
  id: string;
  title: string;
  kind: string;
  headRevisionId: string | null;
}

interface WorkspaceFixture {
  project: { id: string; title: string };
  scenes: Array<{ document: WorkspaceDocument; revision: { id: string; markdown: string } }>;
  scene: { document: WorkspaceDocument; revision: { id: string; markdown: string } };
}

interface WorkspaceState {
  version: number;
  preset: string;
  root: unknown;
  hiddenPanelIds: string[];
}

interface WorkspaceSnapshotRecord {
  version: 2;
  layout: WorkspaceState;
  floating: Array<{ panelId: string; left: number; top: number; width: number; height: number }>;
}

async function signIn(page: Page, mode: "desktop" | "mobile"): Promise<void> {
  await ownerLogin(page, `/${mode}/`);
}

async function createWorkspaceFixture(page: Page): Promise<WorkspaceFixture> {
  const origin = new URL(page.url()).origin;
  const projectResponse = await page.request.post("/api/v1/persistence/projects", {
    headers: { Origin: origin },
    data: { title: `Modular workspace ${randomUUID()}` },
  });
  expect(projectResponse.status()).toBe(201);
  const { project } = await projectResponse.json() as { project: { id: string; title: string } };
  const createDocument = async (input: { parentId?: string; kind: string; title: string; orderKey: string; markdown: string }) => {
    const response = await page.request.post(`/api/v1/persistence/projects/${project.id}/documents`, {
      headers: { Origin: origin, "Idempotency-Key": randomUUID() },
      data: input,
    });
    expect(response.status(), `create ${input.title}`).toBe(201);
    return response.json() as Promise<{ document: WorkspaceDocument; revision: { id: string; markdown: string } }>;
  };
  const volume = await createDocument({ kind: "volume", title: "Volume One", orderKey: "a", markdown: "" });
  const chapter = await createDocument({ parentId: volume.document.id, kind: "chapter", title: "Chapter One", orderKey: "a", markdown: "" });
  const one = await createDocument({ parentId: chapter.document.id, kind: "scene", title: "Scene One", orderKey: "a", markdown: INITIAL_SCENE_ONE });
  const two = await createDocument({ parentId: chapter.document.id, kind: "scene", title: "Scene Two", orderKey: "b", markdown: INITIAL_SCENE_TWO });
  return { project, scenes: [one, two], scene: one };
}

async function seedTermRegistry(page: Page, fixture: WorkspaceFixture): Promise<void> {
  const origin = new URL(page.url()).origin;
  const projectPath = `/api/projects/${fixture.project.id}`;
  const snapshotResponse = await page.request.get(`${projectPath}/snapshot`);
  expect(snapshotResponse.ok()).toBe(true);
  const snapshotRead = await snapshotResponse.json() as {
    snapshot: { projectId: string; projectVersion: number };
    files: Array<{ path: string; revision: string; content: string }>;
  };
  const targetPath = `documents/${fixture.scenes[1]!.document.id}.md`;
  expect(snapshotRead.files.some((file) => file.path === targetPath)).toBe(true);
  const registryPath = "meta/scriptorium/modules/search/terms.json";
  const existing = snapshotRead.files.find((file) => file.path === registryPath);
  const terms = {
    schemaVersion: 1,
    terms: [
      { id: `beacon-${randomUUID()}`, canonical: "Beacon Quay", aliases: ["The Quay"], targetPath },
      { id: `lantern-${randomUUID()}`, canonical: "Lantern Harbor", aliases: ["Lantern Bay"], targetPath },
    ],
  };
  const operation = {
    id: `terms-${randomUUID()}`,
    generation: 1,
    projectId: fixture.project.id,
    baseProjectVersion: snapshotRead.snapshot.projectVersion,
    effect: "metadata",
    reads: [{ path: registryPath, revision: existing?.revision ?? null }],
    writes: [{ path: registryPath, revision: existing?.revision ?? null, content: JSON.stringify(terms) }],
    message: "Acceptance terminology registry",
  };
  const proposalId = `terms-proposal-${randomUUID()}`;
  const proposal = await page.request.post(`${projectPath}/proposals`, {
    headers: { Origin: origin },
    data: { id: proposalId, snapshot: snapshotRead.snapshot, operations: [operation] },
  });
  expect(proposal.status()).toBe(201);
  const approval = await page.request.post(`${projectPath}/approvals`, {
    headers: { Origin: origin },
    data: { proposalId, operationIds: [operation.id] },
  });
  expect(approval.status()).toBe(204);
  const applied = await page.request.post(`${projectPath}/apply`, { headers: { Origin: origin }, data: operation });
  expect(applied.status()).toBe(201);
}

async function openFixtureScene(page: Page, mode: "desktop" | "mobile", sceneIndex = 0, seedTerms = false): Promise<WorkspaceFixture> {
  const fixture = await createWorkspaceFixture(page);
  if (seedTerms) await seedTermRegistry(page, fixture);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Database workspace" })).toBeVisible();
  if (mode === "mobile") {
    await page.getByRole("navigation", { name: "モバイル画面" }).getByRole("button", { name: "作品", exact: true }).click();
  }
  await page.getByLabel("開く作品").selectOption(fixture.project.id);
  const scene = fixture.scenes[sceneIndex];
  expect(scene).toBeTruthy();
  await page.locator(".pg-document-list").getByRole("button", { name: new RegExp(scene!.document.title) }).click();
  if (mode === "mobile") {
    await page.getByRole("navigation", { name: "モバイル画面" }).getByRole("button", { name: "書く", exact: true }).click();
    await page.getByRole("tablist", { name: "Workspace panels" }).getByRole("tab", { name: "原稿", exact: true }).click();
  }
  fixture.scene = scene!;
  await expect(page.getByRole("heading", { name: scene!.document.title, exact: true })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "原稿 Markdown" })).toBeVisible();
  await expect(page.getByText("IndexedDB回復Journalに保存済み", { exact: true })).toBeVisible();
  return fixture;
}

async function readJournal(page: Page): Promise<DraftRecord[]> {
  return page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("scriptorium-recovery");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("IndexedDB open failed"));
    });
    try {
      const transaction = database.transaction("persistenceDrafts", "readonly");
      const records = await new Promise<DraftRecord[]>((resolve, reject) => {
        const request = transaction.objectStore("persistenceDrafts").getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error("IndexedDB journal read failed"));
      });
      return records;
    } finally {
      database.close();
    }
  });
}

async function expectDraft(page: Page, documentId: string, text: string): Promise<void> {
  await expect.poll(async () => (await readJournal(page)).some((entry) =>
    entry.documentId === documentId && entry.markdown === text,
  )).toBe(true);
}

async function readPersistedDocument(page: Page, projectId: string, documentId: string): Promise<{ id: string; markdown: string }> {
  const response = await page.request.get(`/api/v1/persistence/projects/${projectId}/documents/${documentId}`);
  expect(response.ok()).toBe(true);
  const value = await response.json() as { revision?: { id: string; markdown: string } };
  expect(value.revision?.markdown).toBeDefined();
  return value.revision!;
}

async function restartApi(): Promise<void> {
  const e2ePort = Number.parseInt(process.env.CODEXIA_E2E_PORT ?? "4173", 10);
  const origin = `http://127.0.0.1:${e2ePort}`;
  const response = await fetch(`http://127.0.0.1:${e2ePort + 1}/__e2e/restart-api`, { method: "POST" });
  expect(response.status).toBe(204);
  expect((await fetch(`${origin}/api/health`)).ok).toBe(true);
}

function workspaceToolbar(page: Page) {
  return page.getByRole("toolbar", { name: "Workspace layout controls" });
}

async function openPanelMenu(page: Page): Promise<void> {
  const details = workspaceToolbar(page).locator("details");
  if (!await details.evaluate((element) => (element as HTMLDetailsElement).open)) {
    await details.locator("summary").click();
  }
}

async function closePanelMenu(page: Page): Promise<void> {
  const details = workspaceToolbar(page).locator("details");
  if (await details.evaluate((element) => (element as HTMLDetailsElement).open)) {
    await details.locator("summary").click();
  }
  await expect.poll(() => details.evaluate((element) => (element as HTMLDetailsElement).open)).toBe(false);
}

async function workspaceStorage(page: Page, mode: "desktop" | "mobile"): Promise<{ key: string; raw: string | null }> {
  return page.evaluate((expectedMode) => {
    const prefix = "scriptorium:workspace:v2:";
    const key = Object.keys(localStorage).find((candidate) => candidate.startsWith(prefix) && candidate.endsWith(`:${expectedMode}`));
    return { key: key ?? "", raw: key ? localStorage.getItem(key) : null };
  }, mode);
}

function containsLayoutNode(root: unknown, type: string, panelIds: string[]): boolean {
  if (!root || typeof root !== "object") return false;
  const node = root as { type?: unknown; panelId?: unknown; activePanelId?: unknown; children?: unknown };
  if (node.type === type) {
    const contained = new Set<string>();
    const collect = (value: unknown): void => {
      if (!value || typeof value !== "object") return;
      const current = value as { panelId?: unknown; children?: unknown };
      if (typeof current.panelId === "string") contained.add(current.panelId);
      if (Array.isArray(current.children)) for (const child of current.children) collect(child);
    };
    collect(root);
    if (panelIds.every((panelId) => contained.has(panelId))) return true;
  }
  return Array.isArray(node.children) && node.children.some((child) => containsLayoutNode(child, type, panelIds));
}

function firstSplitSizes(root: unknown): number[] | null {
  if (!root || typeof root !== "object") return null;
  const node = root as { type?: unknown; sizes?: unknown; children?: unknown };
  if (node.type === "split" && Array.isArray(node.sizes) && node.sizes.every((size) => typeof size === "number")) {
    return node.sizes as number[];
  }
  if (Array.isArray(node.children)) {
    for (const child of node.children) {
      const sizes = firstSplitSizes(child);
      if (sizes) return sizes;
    }
  }
  return null;
}

async function saveWorkspace(page: Page): Promise<WorkspaceState> {
  await workspaceToolbar(page).getByRole("button", { name: "Save layout", exact: true }).click();
  const storage = await workspaceStorage(page, "desktop");
  expect(storage.key).not.toBe("");
  expect(storage.raw).not.toBeNull();
  return (JSON.parse(storage.raw!) as WorkspaceSnapshotRecord).layout;
}

test("desktop workspace presets, arbitrary docking, panel visibility and layout persistence preserve drafts", async ({ page }) => {
  expect(authToken.length).toBeGreaterThanOrEqual(32);
  await signIn(page, "desktop");
  const fixture = await openFixtureScene(page, "desktop");

  const workspace = page.locator(".st-workspace");
  const toolbar = workspaceToolbar(page);
  await expect(workspace).toBeVisible();
  await expect(workspace.locator('[data-workspace-panel="editor"]')).toBeVisible();

  for (const preset of ["Writing", "Research", "Review"] as const) {
    await toolbar.getByRole("button", { name: preset, exact: true }).click();
    const saved = await saveWorkspace(page);
    expect(saved.version).toBe(1);
    expect(saved.preset).toBe(preset.toLowerCase());
    await expect(workspace.locator('[data-workspace-panel="editor"]')).toBeVisible();
  }

  await toolbar.getByRole("button", { name: "Writing", exact: true }).click();
  await saveWorkspace(page);

  await workspace.locator(".st-workspace-move-menu summary").click();
  const moveControls = workspace.locator(".st-workspace-move-controls");
  const movePanel = moveControls.getByLabel("Panel to move");
  const moveNextTo = moveControls.getByLabel("Move next to");
  const placement = moveControls.getByLabel("Placement");
  await movePanel.selectOption("editor");
  await moveNextTo.selectOption("outline");
  await placement.selectOption("right");
  await moveControls.getByRole("button", { name: "Move panel", exact: true }).click();
  const splitLayout = await saveWorkspace(page);
  expect(containsLayoutNode(splitLayout.root, "split", ["editor", "outline"])).toBe(true);
  const beforeResize = firstSplitSizes(splitLayout.root);
  expect(beforeResize).not.toBeNull();
  const resizeHandle = page.getByRole("separator", { name: "Resize horizontal workspace panels" });
  await expect(resizeHandle).toBeVisible();
  await resizeHandle.focus();
  await resizeHandle.press("ArrowRight");
  const resizedLayout = await saveWorkspace(page);
  expect(firstSplitSizes(resizedLayout.root)).not.toEqual(beforeResize);

  await movePanel.selectOption("editor");
  await moveNextTo.selectOption("outline");
  await placement.selectOption("tab");
  await moveControls.getByRole("button", { name: "Move panel", exact: true }).click();
  const tabLayout = await saveWorkspace(page);
  expect(containsLayoutNode(tabLayout.root, "stack", ["editor", "outline"])).toBe(true);

  const draftPrefix = "Workspace changes preserve ";
  const draftSuffix = "the caret across panel state updates.";
  const editor = page.locator(".cm-content");
  await editor.fill(draftPrefix);
  await editor.pressSequentially(draftSuffix);
  const draft = draftPrefix + draftSuffix;
  await expect(editor).toHaveText(draft);
  await expectDraft(page, fixture.scene.document.id, draft);

  await openPanelMenu(page);
  await toolbar.getByRole("button", { name: "Hide 原稿", exact: true }).click();
  await expect(workspace.locator('[data-workspace-panel="editor"]')).toHaveCount(0);
  await toolbar.getByRole("button", { name: "Show 原稿", exact: true }).click();
  await expect(workspace.locator('[data-workspace-panel="editor"] .cm-content')).toHaveText(draft);
  const savedCustomLayout = await saveWorkspace(page);
  expect(savedCustomLayout.preset).toBe("custom");
  expect(savedCustomLayout.hiddenPanelIds).not.toContain("editor");

  const persisted = await workspaceStorage(page, "desktop");
  await page.reload();
  await expect(page.locator(".st-workspace")).toBeVisible();
  await expect(page.locator('[data-workspace-panel="editor"] .cm-content')).toHaveText(draft);
  await expect.poll(async () => (await workspaceStorage(page, "desktop")).raw).toBe(persisted.raw);
});

test("malformed workspace settings are retained until the owner explicitly saves a replacement", async ({ page }) => {
  expect(authToken.length).toBeGreaterThanOrEqual(32);
  await signIn(page, "desktop");
  await openFixtureScene(page, "desktop");
  await saveWorkspace(page);

  const storage = await workspaceStorage(page, "desktop");
  expect(storage.key).not.toBe("");
  const malformed = '{"version":99,"preset":"custom","root":{"type":"leaf","panelId":"untrusted"},"hiddenPanelIds":[]}';
  await page.evaluate(({ key, raw }) => localStorage.setItem(key, raw), { key: storage.key, raw: malformed });
  await page.reload();

  await expect(page.locator(".st-workspace")).toBeVisible();
  await expect(page.locator('[data-workspace-panel="editor"] .cm-content')).toBeVisible();
  expect((await page.evaluate((key) => localStorage.getItem(key), storage.key))).toBe(malformed);

  const replacement = await saveWorkspace(page);
  expect(replacement.version).toBe(1);
  expect((JSON.parse((await workspaceStorage(page, "desktop")).raw!) as WorkspaceSnapshotRecord).layout)
    .toMatchObject({ version: 1, preset: "writing" });
});

test("mobile workspace tabs support keyboard navigation and preserve the editor draft", async ({ page }) => {
  expect(authToken.length).toBeGreaterThanOrEqual(32);
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page, "mobile");
  const fixture = await openFixtureScene(page, "mobile");

  const tabs = page.getByRole("tablist", { name: "Workspace panels" });
  const editorTab = tabs.getByRole("tab", { name: "原稿", exact: true });
  await expect(tabs).toBeVisible();
  await expect(editorTab).toHaveAttribute("aria-selected", "true");

  const draft = "Mobile panel keyboard navigation keeps this draft.";
  await page.locator('[data-workspace-panel="editor"] .cm-content').fill(draft);
  await expectDraft(page, fixture.scene.document.id, draft);
  await editorTab.focus();
  await editorTab.press("ArrowRight");
  await expect(editorTab).not.toHaveAttribute("aria-selected", "true");
  const activeTab = tabs.locator('[role="tab"][aria-selected="true"]');
  await expect(activeTab).toHaveCount(1);
  await expect(page.locator('[data-workspace-panel="editor"]')).toHaveCount(0);
  await activeTab.press("Home");
  await expect(tabs.getByRole("tab").first()).toHaveAttribute("aria-selected", "true");
  if (await editorTab.getAttribute("aria-selected") !== "true") await editorTab.click();
  await expect(editorTab).toHaveAttribute("aria-selected", "true");
  await expect(page.locator('[data-workspace-panel="editor"] .cm-content')).toHaveText(draft);

  await page.locator(".st-workspace-configuration > summary").click();
  const mobileToolbar = workspaceToolbar(page);
  await mobileToolbar.getByRole("button", { name: "Save layout", exact: true }).click();
  const mobileStorage = await workspaceStorage(page, "mobile");
  const desktopStorage = await workspaceStorage(page, "desktop");
  expect(mobileStorage.key).not.toBe("");
  expect(mobileStorage.key).not.toBe(desktopStorage.key);
  expect((JSON.parse(mobileStorage.raw!) as WorkspaceSnapshotRecord).layout.version).toBe(1);
});

test("mobile route buttons restore their workspace panel without adding duplicate history entries", async ({ page }) => {
  expect(authToken.length).toBeGreaterThanOrEqual(32);
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page, "mobile");
  await openFixtureScene(page, "mobile");

  const navigation = page.getByRole("navigation", { name: "モバイル画面" });
  const editorPanel = page.locator('[data-workspace-panel="editor"]');
  const historyLengthAtWriting = await page.evaluate(() => history.length);
  const writingUrl = page.url();
  expect(new URL(writingUrl).searchParams.get("view")).toBe("writing");
  await editorPanel.getByRole("button", { name: "履歴", exact: true }).click();
  await expect(page.locator('[data-workspace-panel="history"]')).toBeVisible();
  await expect(page).toHaveURL(writingUrl);
  await navigation.getByRole("button", { name: "書く", exact: true }).click();
  await expect(editorPanel).toBeVisible();
  await expect(page).toHaveURL(writingUrl);
  expect(await page.evaluate(() => history.length)).toBe(historyLengthAtWriting);

  await navigation.getByRole("button", { name: "作品", exact: true }).click();
  await expect(page.locator('[data-workspace-panel="outline"]')).toBeVisible();
  const libraryUrl = page.url();
  const historyLengthAtLibrary = await page.evaluate(() => history.length);
  expect(new URL(libraryUrl).searchParams.get("view")).toBe("library");
  const panelTabs = page.getByRole("tablist", { name: "Workspace panels" });
  await panelTabs.getByRole("tab", { name: "KnowledgeとEvidence", exact: true }).click();
  await expect(page.locator('[data-workspace-panel="inspector"]')).toBeVisible();
  await navigation.getByRole("button", { name: "作品", exact: true }).click();
  await expect(page.locator('[data-workspace-panel="outline"]')).toBeVisible();
  await expect(page).toHaveURL(libraryUrl);
  expect(await page.evaluate(() => history.length)).toBe(historyLengthAtLibrary);
});

test("editor remains unavailable until delayed browser recovery completes, then reapplies the exact draft", async ({ page }) => {
  expect(authToken.length).toBeGreaterThanOrEqual(32);
  await signIn(page, "desktop");
  const fixture = await openFixtureScene(page, "desktop");
  const documentUrl = `/api/v1/persistence/projects/${fixture.project.id}/documents/${fixture.scene.document.id}`;
  await page.route(`**${documentUrl}`, async (route) => {
    if (route.request().method() === "PATCH") {
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Synthetic save interruption" }) });
    } else {
      await route.continue();
    }
  });

  const draft = "Recovered after delayed IndexedDB readiness.";
  await page.locator(".cm-content").fill(draft);
  await expectDraft(page, fixture.scene.document.id, draft);
  await expect(page.getByText("PostgreSQL保存を確認できません", { exact: true })).toBeVisible();

  await page.addInitScript(() => {
    type RecoveryGate = { opened: boolean; release?: () => void };
    type GatedWindow = Window & { __workspaceRecoveryGate?: RecoveryGate };
    const gate: RecoveryGate = { opened: false };
    (window as GatedWindow).__workspaceRecoveryGate = gate;

    const descriptor = Object.getOwnPropertyDescriptor(IDBRequest.prototype, "onsuccess");
    if (!descriptor?.get || !descriptor.set) throw new Error("IndexedDB success hooks are unavailable in this browser.");
    Object.defineProperty(IDBRequest.prototype, "onsuccess", {
      configurable: true,
      enumerable: descriptor.enumerable,
      get() { return descriptor.get!.call(this); },
      set(handler: ((this: IDBRequest, event: Event) => unknown) | null) {
        if (!handler) {
          descriptor.set!.call(this, handler);
          return;
        }
        const request = this;
        descriptor.set!.call(this, function (this: IDBRequest, event: Event) {
          const currentGate = (window as GatedWindow).__workspaceRecoveryGate;
          const database = request.result as IDBDatabase | undefined;
          if (database?.name === "scriptorium-recovery" && currentGate && !currentGate.opened) {
            currentGate.opened = true;
            currentGate.release = () => handler.call(request, event);
            return;
          }
          return handler.call(this, event);
        });
      },
    });
  });
  await page.reload();

  await expect(page.locator(".st-workspace")).toBeVisible();
  await expect(page.locator(".pg-editor")).toHaveCount(0);
  expect((await readPersistedDocument(page, fixture.project.id, fixture.scene.document.id)).markdown).toBe(INITIAL_SCENE_ONE);
  await expect.poll(() => page.evaluate(() => Boolean((window as Window & { __workspaceRecoveryGate?: { opened: boolean } }).__workspaceRecoveryGate?.opened))).toBe(true);

  await page.evaluate(() => {
    const gate = (window as Window & { __workspaceRecoveryGate?: { release?: () => void } }).__workspaceRecoveryGate;
    if (!gate?.release) throw new Error("IndexedDB readiness was not held.");
    gate.release();
  });
  await expect(page.locator(".cm-content")).toHaveText(draft);
  await expectDraft(page, fixture.scene.document.id, draft);
  await page.unroute(`**${documentUrl}`);
  await page.getByRole("button", { name: /今すぐ保存|PostgreSQLへ再試行/u }).click();
  await expect(page.getByText("PostgreSQLへ保存済み", { exact: true })).toBeVisible();
  expect((await readPersistedDocument(page, fixture.project.id, fixture.scene.document.id)).markdown).toBe(draft);
});

test("failed IndexedDB open blocks editing and preserves the PostgreSQL manuscript and recovery record", async ({ page }) => {
  expect(authToken.length).toBeGreaterThanOrEqual(32);
  await signIn(page, "desktop");
  const fixture = await openFixtureScene(page, "desktop");

  const draft = "Existing recovery record survives an unavailable browser journal.";
  await page.locator(".cm-content").fill(draft);
  await expectDraft(page, fixture.scene.document.id, draft);
  const beforeFailure = await readJournal(page);
  expect(beforeFailure.some((entry) => entry.documentId === fixture.scene.document.id && entry.markdown === draft)).toBe(true);

  await page.getByRole("button", { name: "ログアウト" }).click();
  await expect(page.getByRole("heading", { name: "作品を開く" })).toBeVisible();
  await page.addInitScript(() => {
    const nativeOpen = IDBFactory.prototype.open;
    type RecoveryWindow = Window & { __readNativeRecoveryJournal?: () => Promise<DraftRecord[]> };
    (window as RecoveryWindow).__readNativeRecoveryJournal = async () => {
      const request = Reflect.apply(nativeOpen, indexedDB, ["scriptorium-recovery"]) as IDBOpenDBRequest;
      const database = await new Promise<IDBDatabase>((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error("Native IndexedDB journal open failed"));
      });
      try {
        const records = await new Promise<DraftRecord[]>((resolve, reject) => {
          const read = database.transaction("persistenceDrafts", "readonly").objectStore("persistenceDrafts").getAll();
          read.onsuccess = () => resolve(read.result);
          read.onerror = () => reject(read.error ?? new Error("Native IndexedDB journal read failed"));
        });
        return records;
      } finally {
        database.close();
      }
    };
    Object.defineProperty(IDBFactory.prototype, "open", {
      configurable: true,
      writable: true,
      value: function (this: IDBFactory, name: string, version?: number) {
        if (name === "scriptorium-recovery") throw new DOMException("Synthetic IndexedDB open denial", "SecurityError");
        return version === undefined ? nativeOpen.call(this, name) : nativeOpen.call(this, name, version);
      },
    });
  });
  await page.reload();
  await expect(page.getByRole("heading", { name: "作品を開く" })).toBeVisible();

  await page.getByLabel("アクセス・トークン").fill(authToken);
  await page.getByRole("button", { name: "PostgreSQL作品を開く" }).click();
  await expect(page.getByRole("heading", { name: "Database workspace" })).toBeVisible();
  await expect(page.getByRole("alert")).toContainText("Browser storage is unavailable");
  await expect(page.locator(".pg-document-list")).toContainText("Scene One");
  await expect(page.locator(".pg-editor")).toHaveCount(0);
  expect((await readPersistedDocument(page, fixture.project.id, fixture.scene.document.id)).markdown).toBe(INITIAL_SCENE_ONE);
  const retained = await page.evaluate(() => (window as Window & {
    __readNativeRecoveryJournal?: () => Promise<DraftRecord[]>;
  }).__readNativeRecoveryJournal?.());
  expect(retained).toEqual(beforeFailure);
});

test("PostgreSQL API restart preserves canonical content and replays the exact browser draft", async ({ page }) => {
  expect(authToken.length).toBeGreaterThanOrEqual(32);
  await signIn(page, "desktop");
  const fixture = await openFixtureScene(page, "desktop");
  const authorText = "Exact browser recovery draft survives an API restart.";
  const documentUrl = `/api/v1/persistence/projects/${fixture.project.id}/documents/${fixture.scene.document.id}`;
  let releaseSave!: () => void;
  let signalSave!: () => void;
  const saveGate = new Promise<void>((resolve) => { releaseSave = resolve; });
  const saveStarted = new Promise<void>((resolve) => { signalSave = resolve; });
  await page.route(`**${documentUrl}`, async (route) => {
    if (route.request().method() !== "PATCH") return route.continue();
    signalSave();
    await saveGate;
    await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Synthetic interrupted save" }) });
  });

  await page.locator(".cm-content").fill(authorText);
  await expectDraft(page, fixture.scene.document.id, authorText);
  await saveStarted;
  await restartApi();
  // Owner sessions are process-local and deliberately expire across API replacement.
  // Reauthenticate before asserting canonical PostgreSQL data and journal replay.
  const login = await page.request.post("/api/login", {
    headers: { Origin: new URL(page.url()).origin }, data: { token: authToken },
  });
  expect(login.status()).toBe(200);
  releaseSave();
  await expect(page.getByText("PostgreSQL保存を確認できません", { exact: true })).toBeVisible();
  expect((await readPersistedDocument(page, fixture.project.id, fixture.scene.document.id)).markdown).toBe(INITIAL_SCENE_ONE);

  await page.reload();
  await expect(page.getByRole("heading", { name: "Database workspace" })).toBeVisible();
  await expect(page.locator(".cm-content")).toHaveText(authorText);
  await expectDraft(page, fixture.scene.document.id, authorText);
  await page.unroute(`**${documentUrl}`);
  await page.getByRole("button", { name: /今すぐ保存|PostgreSQLへ再試行/u }).click();
  await expect(page.getByText("PostgreSQLへ保存済み", { exact: true })).toBeVisible();
  expect((await readPersistedDocument(page, fixture.project.id, fixture.scene.document.id)).markdown).toBe(authorText);
  expect((await readJournal(page)).some((entry) => entry.documentId === fixture.scene.document.id)).toBe(false);
});

test("Core-only workspace keeps authoring available without search or terminology panels", async ({ page }) => {
  test.skip(profile !== "core", "Run this acceptance with CODEXIA_PROFILE=core.");
  expect(authToken.length).toBeGreaterThanOrEqual(32);
  await signIn(page, "desktop");
  const fixture = await openFixtureScene(page, "desktop");

  const contributions = await page.request.get(`/api/projects/${encodeURIComponent(fixture.project.id)}/contributions`);
  expect(contributions.ok()).toBe(true);
  const contributionIds = (await contributions.json() as Array<{ id: string }>).map((item) => item.id);
  expect(contributionIds.some((id) => id.startsWith("search."))).toBe(false);
  await expect(workspaceToolbar(page).getByRole("button", { name: "Show 全文検索", exact: true })).toHaveCount(0);
  await expect(workspaceToolbar(page).getByRole("button", { name: "Show 用語辞典", exact: true })).toHaveCount(0);

  const draft = "Core authoring works with optional search disabled.";
  await page.locator(".cm-content").fill(draft);
  await expectDraft(page, fixture.scene.document.id, draft);
});

test("full profile exposes optional lexical search and terminology without changing manuscript source", async ({ page }) => {
  test.skip(profile !== "full", "Run this acceptance with CODEXIA_PROFILE=full.");
  expect(authToken.length).toBeGreaterThanOrEqual(32);
  await signIn(page, "desktop");
  const fixture = await openFixtureScene(page, "desktop", 0, true);
  const projectId = fixture.project.id;

  const contributionsResponse = await page.request.get(`/api/projects/${encodeURIComponent(projectId)}/contributions`);
  expect(contributionsResponse.ok()).toBe(true);
  const contributions = await contributionsResponse.json() as Array<{ id: string; module: string }>;
  expect(contributions.some((item) => item.id === "search.panel" && item.module === "search")).toBe(true);
  expect(contributions.some((item) => item.id === "search.terms" && item.module === "search")).toBe(true);

  const modulesResponse = await page.request.get(`/api/projects/${encodeURIComponent(projectId)}/modules`);
  expect(modulesResponse.ok()).toBe(true);
  const modules = await modulesResponse.json() as Array<{ id: string; availability: string }>;
  expect(modules.find((module) => module.id === "search")?.availability).toMatch(/^(enabled-idle|active)$/u);

  const sourceBefore = (await readPersistedDocument(page, projectId, fixture.scene.document.id)).markdown;
  expect(sourceBefore).toContain("Beacon Quay appears in this scene.");
  expect(sourceBefore).not.toMatch(/\[Beacon Quay\]\(/u);

  const toolbar = workspaceToolbar(page);
  await openPanelMenu(page);
  await toolbar.getByRole("button", { name: "Show 全文検索", exact: true }).click();
  const searchPanel = page.locator('[data-workspace-panel="module:search.panel"]');
  await expect(searchPanel).toBeVisible();
  await closePanelMenu(page);
  const query = searchPanel.getByLabel("検索語");
  await query.fill("submerged brass archive");
  await query.press("Enter");
  await expect(searchPanel.getByRole("list")).toContainText("Scene Two");
  const sceneTwoPath = `documents/${fixture.scenes[1]!.document.id}.md`;
  await searchPanel.getByRole("button", { name: `この文書を開く: ${sceneTwoPath}`, exact: true }).click();
  await expect(page.getByRole("heading", { name: "Scene Two" })).toBeVisible();

  await openPanelMenu(page);
  await toolbar.getByRole("button", { name: "Show 用語辞典", exact: true }).click();
  const termsPanel = page.locator('[data-workspace-panel="module:search.terms"]');
  await expect(termsPanel).toBeVisible();
  await closePanelMenu(page);
  await expect(termsPanel).toContainText("Lantern Harbor");
  await expect(termsPanel).toContainText("Beacon Quay");
  await termsPanel.getByRole("button", { name: "用語「Beacon Quay」の参照先を開く", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Scene Two" })).toBeVisible();

  await page.locator(".pg-document-list").getByRole("button", { name: "Scene One", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Scene One" })).toBeVisible();
  await page.getByRole("button", { name: "読む", exact: true }).click();
  const termLink = page.getByRole("button", { name: "Beacon Quay、用語を開く", exact: true });
  await expect(termLink).toBeVisible();
  await termLink.click();
  await expect(page.getByRole("heading", { name: "Scene Two" })).toBeVisible();
  const sourceAfter = (await readPersistedDocument(page, projectId, fixture.scene.document.id)).markdown;
  expect(sourceAfter).toBe(sourceBefore);
});


test("desktop floating panels preserve drafts and saved layout geometry", async ({ page }) => {
  expect(authToken.length).toBeGreaterThanOrEqual(32);
  await signIn(page, "desktop");
  const fixture = await openFixtureScene(page, "desktop");

  const workspace = page.locator(".st-workspace");
  const manuscript = workspace.locator('[data-workspace-panel="editor"] .cm-content');
  const draft = "Floating workspace retains the PostgreSQL manuscript.";
  await manuscript.fill(draft);
  await expectDraft(page, fixture.scene.document.id, draft);

  await workspace.locator('[data-workspace-panel="outline"]')
    .getByRole("button", { name: "Float 作品と構成" }).click();
  const floating = workspace.locator('[data-floating-panel="outline"]');
  await expect(floating).toBeVisible();
  await expect(manuscript).toHaveText(draft);

  const editorPanel = workspace.locator('[data-workspace-panel="editor"]');
  await editorPanel.getByRole("button", { name: "Maximize 原稿" }).click();
  await expect(editorPanel).toHaveClass(/is-maximized/);
  await editorPanel.getByRole("button", { name: "Restore 原稿" }).click();
  await expect(editorPanel).not.toHaveClass(/is-maximized/);

  await workspaceToolbar(page).getByRole("button", { name: "Save layout", exact: true }).click();
  const stored = await workspaceStorage(page, "desktop");
  expect(stored.raw).not.toBeNull();
  const savedRecord = JSON.parse(stored.raw!) as WorkspaceSnapshotRecord;
  expect(savedRecord.floating).toHaveLength(1);
  expect(savedRecord.floating[0]).toMatchObject({ panelId: "outline", width: 350, height: 410 });
  const savedGeometry = savedRecord.floating[0]!;
  await page.reload();
  await expect(page.locator('[data-floating-panel="outline"]')).toBeVisible();
  expect(await page.locator('[data-floating-panel="outline"]').evaluate((element) => {
    const style = (element as HTMLElement).style;
    return { left: Number.parseInt(style.left, 10), top: Number.parseInt(style.top, 10), width: Number.parseInt(style.width, 10), height: Number.parseInt(style.height, 10) };
  })).toEqual({ left: savedGeometry.left, top: savedGeometry.top, width: savedGeometry.width, height: savedGeometry.height });
  await expect(page.locator('[data-workspace-panel="editor"] .cm-content')).toHaveText(draft);

  await page.locator('[data-floating-panel="outline"]')
    .getByRole("button", { name: "パネルをドックへ戻す" }).click();
  await expect(page.locator('[data-workspace-panel="outline"]')).toBeVisible();
  await page.getByRole("tab", { name: "原稿", exact: true }).click();
  await expect(page.locator(".cm-content")).toHaveText(draft);
});

test("a failed workspace record write preserves the previous dock and floating layout on reload", async ({ page }) => {
  expect(authToken.length).toBeGreaterThanOrEqual(32);
  await signIn(page, "desktop");
  await openFixtureScene(page, "desktop");

  const workspace = page.locator(".st-workspace");
  await workspace.locator('[data-workspace-panel="outline"]')
    .getByRole("button", { name: "Float 作品と構成" }).click();
  const floating = workspace.locator('[data-floating-panel="outline"]');
  await expect(floating).toBeVisible();
  await saveWorkspace(page);
  const oldSnapshot = await workspaceStorage(page, "desktop");
  expect(oldSnapshot.key).not.toBe("");
  expect(oldSnapshot.raw).not.toBeNull();
  const previousSnapshotBytes = oldSnapshot.raw;
  const previousSnapshot = JSON.parse(previousSnapshotBytes!) as WorkspaceSnapshotRecord;
  expect(previousSnapshot.floating).toHaveLength(1);

  const resizeHandle = page.getByRole("separator", { name: "Resize horizontal workspace panels" });
  await expect(resizeHandle).toBeVisible();
  await resizeHandle.focus();
  await resizeHandle.press("ArrowRight");
  await floating.locator(".st-workspace-float-handle").press("ArrowRight");

  await page.evaluate((workspaceKey) => {
    const prototype = Storage.prototype as Storage & { __workspaceOriginalSetItem?: typeof Storage.prototype.setItem };
    prototype.__workspaceOriginalSetItem = prototype.setItem;
    Storage.prototype.setItem = function (key: string, value: string): void {
      if (key === workspaceKey) throw new DOMException("quota exceeded", "QuotaExceededError");
      prototype.__workspaceOriginalSetItem!.call(this, key, value);
    };
  }, oldSnapshot.key);
  await workspaceToolbar(page).getByRole("button", { name: "Save layout", exact: true }).click();
  await expect(page.locator(".st-workspace-message")).toContainText("could not be saved");
  await page.evaluate(() => {
    const prototype = Storage.prototype as Storage & { __workspaceOriginalSetItem?: typeof Storage.prototype.setItem };
    if (prototype.__workspaceOriginalSetItem) prototype.setItem = prototype.__workspaceOriginalSetItem;
    delete prototype.__workspaceOriginalSetItem;
  });
  expect(await page.evaluate((key) => localStorage.getItem(key), oldSnapshot.key)).toBe(previousSnapshotBytes);

  await page.reload();
  await expect(page.locator('[data-floating-panel="outline"]')).toBeVisible();
  const afterReloadSnapshot = await page.evaluate((key) => localStorage.getItem(key), oldSnapshot.key);
  expect(afterReloadSnapshot).toBe(previousSnapshotBytes);
  const restored = JSON.parse(afterReloadSnapshot!) as WorkspaceSnapshotRecord;
  expect(restored.layout).toEqual(previousSnapshot.layout);
  expect(restored.floating).toEqual(previousSnapshot.floating);
});


test("mobile writing reference sheet keeps the editor mounted and preserves the real draft", async ({ page }) => {
  expect(authToken.length).toBeGreaterThanOrEqual(32);
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page, "mobile");
  const fixture = await openFixtureScene(page, "mobile");

  const editor = page.locator('[data-workspace-panel="editor"] .cm-content');
  const manuscript = page.locator(".manuscript-input");
  const draft = "シートを開いても、この原稿と入力の文脈は残る。";
  await editor.fill(draft);
  await expectDraft(page, fixture.scene.document.id, draft);
  await manuscript.evaluate((node) => { node.setAttribute("data-stable-editor", "present"); });
  const currentUrl = page.url();

  await page.getByRole("button", { name: "構成を参照" }).click();
  const sheet = page.locator("ion-modal.mobile-shell-reference-modal");
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole("tab", { name: "構成" })).toHaveAttribute("aria-selected", "true");
  await expect(sheet.locator('[data-mobile-reference-panel="outline"] .scene-button').first()).toBeVisible();
  await expect(manuscript).toHaveAttribute("data-stable-editor", "present");
  await expect(editor).toHaveText(draft);
  await expect(page).toHaveURL(currentUrl);

  await sheet.getByRole("tab", { name: "構成" }).press("ArrowRight");
  await expect(sheet.getByRole("tab", { name: "保存状態" })).toHaveAttribute("aria-selected", "true");
  await expect(sheet.locator('[data-mobile-reference-panel="inspector"]')).toBeVisible();
  await expect(sheet.getByRole("status", { name: "原稿の保存状態" })).toContainText("Draft");
  await expect(manuscript).toHaveAttribute("data-stable-editor", "present");
  await sheet.getByRole("button", { name: "閉じる" }).click();
  await expect(sheet).not.toBeVisible();
  await expect(editor).toHaveText(draft);
  await expect(page).toHaveURL(currentUrl);
  await expectDraft(page, fixture.scene.document.id, draft);
});

test("mobile reference sheet scene selection uses the existing guarded navigation", async ({ page }) => {
  expect(authToken.length).toBeGreaterThanOrEqual(32);
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page, "mobile");
  const fixture = await openFixtureScene(page, "mobile");

  const draft = "シーンを変更しても回復できる下書き。";
  await page.locator('[data-workspace-panel="editor"] .cm-content').fill(draft);
  await expectDraft(page, fixture.scene.document.id, draft);

  await page.getByRole("button", { name: "構成を参照" }).click();
  const sheet = page.locator("ion-modal.mobile-shell-reference-modal");
  await expect(sheet).toBeVisible();
  await sheet.locator('[data-mobile-reference-panel="outline"] .pg-document-list')
    .getByRole("button", { name: "Scene Two", exact: true }).click();

  await expect(sheet).not.toBeVisible();
  await expect(page.getByRole("heading", { name: "Scene Two" })).toBeVisible();
  await expect(page.locator('[data-workspace-panel="editor"] .cm-content')).toBeVisible();
  await expectDraft(page, fixture.scene.document.id, draft);
});


test("mobile contextual reference refuses to cover a composing manuscript", async ({ page }) => {
  expect(authToken.length).toBeGreaterThanOrEqual(32);
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page, "mobile");
  const fixture = await openFixtureScene(page, "mobile");

  const editor = page.locator('[data-workspace-panel="editor"] .cm-content');
  const draft = "変換中でも原稿を失わない";
  await editor.fill(draft);
  await expectDraft(page, fixture.scene.document.id, draft);
  await editor.evaluate((element) => element.dispatchEvent(
    new CompositionEvent("compositionstart", { data: "へんかん", bubbles: true }),
  ));

  const urlBefore = page.url();
  await page.getByRole("button", { name: "構成を参照" }).click();
  await expect(page.locator("ion-modal.mobile-shell-reference-modal")).not.toBeVisible();
  await expect(page.locator(".mobile-shell-status").getByRole("alert").filter({ hasText: "下書きの回復状態" })).toBeVisible();
  await expect(page).toHaveURL(urlBefore);
  await expect(editor).toHaveText(draft);
  await expectDraft(page, fixture.scene.document.id, draft);
  await editor.evaluate((element) => element.dispatchEvent(
    new CompositionEvent("compositionend", { data: "変換", bubbles: true }),
  ));
});
