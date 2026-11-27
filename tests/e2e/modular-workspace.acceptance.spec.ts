import type { Page } from "@playwright/test";
import { expect, test as base, type AuthorizeAuthor, type AuthorSession } from "./author-oauth-fixture";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { expectNoUnsavedDeviceChanges, expectServerSaveFailure, expectServerSaved, manuscriptEditor, openRevisionHistory } from "./postgres-fixture";

const profile = process.env.CODEXIA_PROFILE ?? "core";
const INITIAL_SCENE_ONE = "# Scene One\n\nThe first line of the story.\nBeacon Quay appears in this scene.\n";
const INITIAL_SCENE_TWO = "# Scene Two\n\nThe second line of the story.\nA submerged brass archive waits below Lantern Harbor.\n";

// Only the Vite server is shared. Each test still gets its own browser context and journal.
const test = base.extend<{}, { transitionURL: string }>({
  transitionURL: [async ({}, use) => {
    const configuredPort = process.env.CODEXIA_WORKSPACE_FIXTURE_PORT;
    const port = configuredPort ? Number(configuredPort) : 0;
    if (configuredPort && (!Number.isInteger(port) || port < 1 || port > 65_535)) {
      throw new Error("Desktop workspace fixture port must be valid");
    }
    const requireFromApp = createRequire(resolve("app/package.json"));
    const { createServer } = await import(pathToFileURL(requireFromApp.resolve("vite")).href);
    const server = await createServer({
      configFile: resolve("tests/e2e/desktop-workspace-fixture/vite.config.mjs"),
      server: { host: "127.0.0.1", port, strictPort: true, hmr: false },
    });
    try {
      await server.listen();
      const address = server.httpServer?.address();
      if (!address || typeof address === "string") throw new Error("Vite did not expose a TCP listener");
      await use(`http://127.0.0.1:${address.port}`);
    } finally {
      await server.close();
    }
  }, { scope: "worker" }],
});

async function openDesktopTabsFixture(page: Page, url: string): Promise<{
  tabs: ReturnType<Page["getByRole"]>;
}> {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`${url}/desktop-tabs`);
  const tabs = page.getByRole("tablist", { name: "パネル" });
  await expect(tabs).toBeVisible();
  await expect(tabs.getByRole("tab")).toHaveCount(2);
  return { tabs };
}

type DesktopTabsFixtureWindow = Window & {
  __desktopTabsFixture?: {
    guardCalls: number;
    arm(outcomes: Array<boolean | "delayed">): void;
    releaseGuard(): void;
    changeScope(scope: string): void;
  };
};

async function armDesktopTabsGuard(page: Page, outcomes: Array<boolean | "delayed">): Promise<void> {
  await page.evaluate((next) => {
    const fixture = (window as DesktopTabsFixtureWindow).__desktopTabsFixture;
    if (!fixture) throw new Error("Desktop tabs fixture was not initialized.");
    fixture.arm(next);
  }, outcomes);
}

async function desktopTabsGuardCalls(page: Page): Promise<number> {
  return page.evaluate(() => (window as DesktopTabsFixtureWindow).__desktopTabsFixture?.guardCalls ?? -1);
}

test("[TEST-UI-005-001] desktop stack tabs use roving focus and keep the rendered panel association valid", async ({ page, transitionURL }) => {
  const { tabs } = await openDesktopTabsFixture(page, transitionURL);
  const inspector = tabs.getByRole("tab", { name: "Inspector", exact: true });
  const outline = tabs.getByRole("tab", { name: "Outline", exact: true });
  const panel = page.getByRole("tabpanel");

  await expect(inspector).toHaveAttribute("aria-selected", "true");
  await expect(inspector).toHaveJSProperty("tabIndex", 0);
  await expect(outline).toHaveJSProperty("tabIndex", -1);
  await expect(tabs.locator('[role="tab"][tabindex="0"]')).toHaveCount(1);
  await expect(tabs.locator("[aria-controls]")).toHaveCount(0);
  await expect(panel).toHaveAttribute("aria-labelledby", await inspector.getAttribute("id") ?? "");
  await expect.poll(() => panel.evaluate((element) => {
    const tab = element.ownerDocument.getElementById(element.getAttribute("aria-labelledby") ?? "");
    return tab?.getAttribute("role") === "tab" && tab.getAttribute("aria-selected") === "true";
  })).toBe(true);

  await inspector.focus();
  await page.keyboard.press("Tab");
  await expect(panel).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(inspector).toBeFocused();

  await page.keyboard.press("ArrowRight");
  await expect(outline).toHaveAttribute("aria-selected", "true");
  await expect(outline).toHaveJSProperty("tabIndex", 0);
  await expect(outline).toBeFocused();
  await expect(page.getByTestId("fixture-outline")).toBeVisible();
  await expect(page.getByTestId("fixture-inspector")).toHaveCount(0);

  await page.keyboard.press("End");
  await expect(inspector).toHaveAttribute("aria-selected", "true");
  await expect(inspector).toBeFocused();
  await page.keyboard.press("Home");
  await expect(outline).toHaveAttribute("aria-selected", "true");
  await expect(outline).toBeFocused();
});

test("[TEST-UI-003-001] desktop tab guard denial retains selection and a delayed transition cannot focus an obsolete tab", async ({ page, transitionURL }) => {
  const { tabs } = await openDesktopTabsFixture(page, transitionURL);
  const inspector = tabs.getByRole("tab", { name: "Inspector", exact: true });
  const outline = tabs.getByRole("tab", { name: "Outline", exact: true });

  await armDesktopTabsGuard(page, [false]);
  await inspector.focus();
  await page.keyboard.press("ArrowLeft");
  await expect(inspector).toHaveAttribute("aria-selected", "true");
  await expect(inspector).toBeFocused();
  await expect(outline).toHaveJSProperty("tabIndex", -1);
  await expect.poll(() => desktopTabsGuardCalls(page)).toBe(1);

  await armDesktopTabsGuard(page, ["delayed"]);
  await page.keyboard.press("ArrowLeft");
  await expect.poll(() => desktopTabsGuardCalls(page)).toBe(1);
  const obsoleteTabId = await outline.getAttribute("id");
  await page.evaluate(() => (window as DesktopTabsFixtureWindow).__desktopTabsFixture?.changeScope("new-scope"));
  await expect(page.getByTestId("desktop-tabs-scope")).toHaveText("new-scope");
  await expect(tabs).toHaveCount(0);
  await page.evaluate(() => (window as DesktopTabsFixtureWindow).__desktopTabsFixture?.releaseGuard());
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(page.getByRole("tablist", { name: "パネル" })).toHaveCount(0);
  expect(await page.evaluate(() => document.activeElement?.id ?? "")).not.toBe(obsoleteTabId);
});

test("a newer browser history selection supersedes a pending guarded popstate", async ({ page, authorizeAuthor }) => {
  await page.addInitScript(() => {
    const descriptor = Object.getOwnPropertyDescriptor(IDBTransaction.prototype, "oncomplete");
    if (!descriptor?.get || !descriptor.set) throw new Error("IndexedDB transaction completion hooks are unavailable.");
    let holdNext = false;
    let heldResolve: (() => void) | undefined;
    const hooks = window as Window & {
      __holdNextPersistenceJournalCompletion?: () => void;
      __waitForHeldPersistenceJournalCompletion?: () => Promise<void>;
      __releasePersistenceJournalCompletion?: () => void;
    };
    const held = new Promise<void>((resolve) => { heldResolve = resolve; });
    let release: (() => void) | undefined;
    hooks.__holdNextPersistenceJournalCompletion = () => { holdNext = true; };
    hooks.__waitForHeldPersistenceJournalCompletion = () => held;
    hooks.__releasePersistenceJournalCompletion = () => release?.();
    Object.defineProperty(IDBTransaction.prototype, "oncomplete", {
      configurable: true,
      enumerable: descriptor.enumerable,
      get() { return descriptor.get!.call(this); },
      set(handler: ((this: IDBTransaction, event: Event) => unknown) | null) {
        if (holdNext && this.mode === "readwrite" && Array.from(this.objectStoreNames).includes("persistenceDrafts")) {
          holdNext = false;
          descriptor.set!.call(this, function (this: IDBTransaction, event: Event) {
            heldResolve?.();
            release = () => handler?.call(this, event);
          });
        } else descriptor.set!.call(this, handler);
      },
    });
  });
  const fixture = await openFixtureScene(page, authorizeAuthor);
  const second = fixture.scenes[1]!;
  const secondRoute = new RegExp(`/desktop/projects/${fixture.project.id}/scenes/${second.document.id}$`);
  const secondSceneButton = page.locator(`.pg-document-list .pg-outline-item[data-document-id="${second.document.id}"] > .pg-outline-row > .pg-outline-document`);
  await secondSceneButton.click();
  await expect(secondSceneButton).toHaveAttribute("aria-current", "page");
  const secondDraft = "The forward history entry must remain the active manuscript.";
  await page.route(`**/api/v1/persistence/projects/${fixture.project.id}/documents/${second.document.id}`, () => new Promise(() => undefined));
  await replaceEditor(page, secondDraft);
  await expectDraft(page, second.document.id, secondDraft);
  await page.evaluate(() => (window as Window & { __holdNextPersistenceJournalCompletion?: () => void }).__holdNextPersistenceJournalCompletion?.());

  await page.evaluate(() => history.back());
  await expect(page).toHaveURL(new RegExp(`/desktop/projects/${fixture.project.id}/scenes/${fixture.scene.document.id}$`));
  await page.evaluate(async () => {
    const hooks = window as Window & { __waitForHeldPersistenceJournalCompletion?: () => Promise<void> };
    await hooks.__waitForHeldPersistenceJournalCompletion?.();
  });
  await page.evaluate(() => history.forward());
  await expect(page).toHaveURL(secondRoute);
  await page.evaluate(() => (window as Window & { __releasePersistenceJournalCompletion?: () => void }).__releasePersistenceJournalCompletion?.());
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));

  await expect(page).toHaveURL(secondRoute);
  await expect(secondSceneButton).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("heading", { name: second.document.title, exact: true })).toBeVisible();
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

async function createWorkspaceFixture(author: AuthorSession): Promise<WorkspaceFixture> {
  const { origin } = author;
  const projectResponse = await author.fetch("/api/v1/persistence/projects", {
    method: "POST",
    headers: { Origin: origin },
    data: { title: `Modular workspace ${randomUUID()}` },
  });
  expect(projectResponse.status()).toBe(201);
  const { project } = await projectResponse.json() as { project: { id: string; title: string } };
  const createDocument = async (input: { parentId?: string; kind: string; title: string; orderKey: string; markdown: string }) => {
    const response = await author.fetch(`/api/v1/persistence/projects/${project.id}/documents`, {
      method: "POST",
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

async function seedTermRegistry(author: AuthorSession, fixture: WorkspaceFixture): Promise<void> {
  const { origin } = author;
  const projectPath = `/api/projects/${fixture.project.id}`;
  const documentId = fixture.scenes[1]!.document.id;
  const snapshotResponse = await author.fetch(`${projectPath}/snapshot?projection=editor&documentId=${encodeURIComponent(documentId)}`);
  expect(snapshotResponse.ok()).toBe(true);
  const snapshotRead = await snapshotResponse.json() as {
    snapshot: { projectId: string; projectVersion: number };
    document: { path: string; revision: string } | null;
  };
  const targetPath = `documents/${documentId}.md`;
  expect(snapshotRead.document?.path).toBe(targetPath);
  const registryPath = "meta/scriptorium/modules/search/terms.json";
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
    reads: [{ path: registryPath, revision: null }],
    writes: [{ path: registryPath, revision: null, content: JSON.stringify(terms) }],
    message: "Acceptance terminology registry",
  };
  const proposalId = `terms-proposal-${randomUUID()}`;
  const proposal = await author.fetch(`${projectPath}/proposals`, {
    method: "POST",
    headers: { Origin: origin },
    data: { id: proposalId, snapshot: snapshotRead.snapshot, operations: [operation] },
  });
  expect(proposal.status()).toBe(201);
  const approval = await author.fetch(`${projectPath}/approvals`, {
    method: "POST",
    headers: { Origin: origin },
    data: { proposalId, operationIds: [operation.id] },
  });
  expect(approval.status()).toBe(204);
  const applied = await author.fetch(`${projectPath}/apply`, { method: "POST", headers: { Origin: origin }, data: operation });
  expect(applied.status()).toBe(201);
}

async function openFixtureScene(
  page: Page, authorizeAuthor: AuthorizeAuthor, sceneIndex = 0, seedTerms = false,
): Promise<WorkspaceFixture & { author: AuthorSession }> {
  const initialAuthor = await authorizeAuthor("desktop", undefined, { apiSetupOnly: true });
  const fixture = await createWorkspaceFixture(initialAuthor);
  if (seedTerms) await seedTermRegistry(initialAuthor, fixture);
  const scene = fixture.scenes[sceneIndex];
  expect(scene).toBeTruthy();
  // Select by canonical project/document IDs. Several fixtures use the same
  // visible "Scene One" title; a stale prior project can otherwise satisfy
  // the heading check before asynchronous guarded navigation commits.
  const route = `/desktop/projects/${fixture.project.id}/scenes/${scene!.document.id}`;
  const author = await authorizeAuthor("desktop", page, { path: route });
  await expect(page).toHaveURL(new RegExp(`/desktop/projects/${fixture.project.id}/scenes/${scene!.document.id}`));
  await expect(page.getByRole("heading", { name: "Database workspace" })).toBeVisible();
  fixture.scene = scene!;
  await expect(page.getByRole("heading", { name: scene!.document.title, exact: true })).toBeVisible();
  await expect(manuscriptEditor(page)).toBeVisible();
  await expect(page.getByLabel("作品", { exact: true })).toHaveValue(fixture.project.id);
  await expect(page.locator(".pg-editor-heading .eyebrow")).toContainText(fixture.project.title);
  await expect.poll(async () => manuscriptEditor(page).locator(".cm-line")
    .evaluateAll((lines) => lines.map((line) => line.textContent ?? "").join("\n").replace(/\n+$/u, "")))
    .toBe(scene!.revision.markdown.replace(/\n+$/u, ""));
  await expectNoUnsavedDeviceChanges(page);
  return { ...fixture, author };
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

async function replaceEditor(page: Page, markdown: string): Promise<void> {
  const editor = manuscriptEditor(page);
  await editor.click();
  await editor.press("ControlOrMeta+a");
  await page.keyboard.insertText(markdown);
}

async function readPersistedDocument(author: AuthorSession, projectId: string, documentId: string): Promise<{ id: string; markdown: string }> {
  const response = await author.fetch(`/api/v1/persistence/projects/${projectId}/documents/${documentId}`);
  expect(response.ok()).toBe(true);
  const value = await response.json() as { revision?: { id: string; markdown: string } };
  expect(value.revision?.markdown).toBeDefined();
  return value.revision!;
}

function workspaceToolbar(page: Page) {
  return page.getByRole("toolbar", { name: "ワークスペース配置" });
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

async function workspaceStorage(page: Page): Promise<{ key: string; raw: string | null }> {
  return page.evaluate(() => {
    const prefix = "scriptorium:workspace:v2:";
    const key = Object.keys(localStorage).find((candidate) => candidate.startsWith(prefix) && candidate.endsWith(":desktop"));
    return { key: key ?? "", raw: key ? localStorage.getItem(key) : null };
  });
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
  await workspaceToolbar(page).getByRole("button", { name: "配置を保存", exact: true }).click();
  const storage = await workspaceStorage(page);
  expect(storage.key).not.toBe("");
  expect(storage.raw).not.toBeNull();
  return (JSON.parse(storage.raw!) as WorkspaceSnapshotRecord).layout;
}

test("desktop workspace presets, arbitrary docking, panel visibility and layout persistence preserve drafts", async ({ page, authorizeAuthor }) => {
  const fixture = await openFixtureScene(page, authorizeAuthor);

  const workspace = page.locator(".st-workspace");
  const toolbar = workspaceToolbar(page);
  await expect(workspace).toBeVisible();
  await expect(workspace.locator('[data-workspace-panel="editor"]')).toBeVisible();

  for (const { label, preset } of [
    { label: "執筆", preset: "writing" },
    { label: "調査", preset: "research" },
    { label: "レビュー", preset: "review" },
  ] as const) {
    await toolbar.getByRole("button", { name: label, exact: true }).click();
    const saved = await saveWorkspace(page);
    expect(saved.version).toBe(1);
    expect(saved.preset).toBe(preset);
    await expect(workspace.locator('[data-workspace-panel="editor"]')).toBeVisible();
  }

  await toolbar.getByRole("button", { name: "執筆", exact: true }).click();
  await saveWorkspace(page);

  await workspace.locator(".st-workspace-move-menu summary").click();
  const moveControls = workspace.locator(".st-workspace-move-controls");
  const movePanel = moveControls.getByLabel("移動するパネル");
  const moveNextTo = moveControls.getByLabel("移動先のパネル");
  const placement = moveControls.getByLabel("配置");
  await movePanel.selectOption("editor");
  await moveNextTo.selectOption("outline");
  await placement.selectOption("right");
  await moveControls.getByRole("button", { name: "パネルを移動", exact: true }).click();
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
  await moveControls.getByRole("button", { name: "パネルを移動", exact: true }).click();
  const tabLayout = await saveWorkspace(page);
  expect(containsLayoutNode(tabLayout.root, "stack", ["editor", "outline"])).toBe(true);

  const draftPrefix = "Workspace changes preserve ";
  const draftSuffix = "the caret across panel state updates.";
  const editor = page.locator(".cm-content");
  await replaceEditor(page, draftPrefix);
  await expect(editor).toHaveText(draftPrefix);
  await editor.pressSequentially(draftSuffix);
  const draft = draftPrefix + draftSuffix;
  await expect(editor).toHaveText(draft);
  await expectDraft(page, fixture.scene.document.id, draft);

  await openPanelMenu(page);
  await toolbar.getByRole("button", { name: "原稿を隠す", exact: true }).click();
  await expect(workspace.locator('[data-workspace-panel="editor"]')).toHaveCount(0);
  await toolbar.getByRole("button", { name: "原稿を表示", exact: true }).click();
  await expect(workspace.locator('[data-workspace-panel="editor"] .cm-content')).toHaveText(draft);
  const savedCustomLayout = await saveWorkspace(page);
  expect(savedCustomLayout.preset).toBe("custom");
  expect(savedCustomLayout.hiddenPanelIds).not.toContain("editor");

  const persisted = await workspaceStorage(page);
  await page.reload();
  await authorizeAuthor("desktop", page, { continueCurrentPage: true });
  await expect(page.locator(".st-workspace")).toBeVisible();
  await expect(page.locator('[data-workspace-panel="editor"] .cm-content')).toHaveText(draft);
  await expect.poll(async () => (await workspaceStorage(page)).raw).toBe(persisted.raw);
});

test("desktop preset sizing updates the live split without replacing the editor or overwriting a saved layout", async ({ page, authorizeAuthor }) => {
  await openFixtureScene(page, authorizeAuthor);

  const workspace = page.locator(".st-workspace");
  const toolbar = workspaceToolbar(page);
  const editorPanel = workspace.locator('[data-workspace-panel="editor"]');
  const editorShare = async (): Promise<number> => editorPanel.evaluate((element) => {
    const group = element.closest<HTMLElement>("[data-group]");
    if (!group) throw new Error("Editor panel is missing its resizable group");
    return element.getBoundingClientRect().width / group.getBoundingClientRect().width;
  });
  await expect(editorPanel).toBeVisible();
  await page.evaluate(() => {
    (window as Window & { __presetEditorNode?: Element }).__presetEditorNode = document.querySelector(".cm-editor") ?? undefined;
  });

  // Save a user-sized Writing layout first. Choosing a preset is an in-memory
  // arrangement until the author explicitly saves it again.
  const resizeHandle = page.getByRole("separator", { name: "Resize horizontal workspace panels" });
  await expect(resizeHandle).toBeVisible();
  await resizeHandle.focus();
  await resizeHandle.press("ArrowRight");
  const savedLayout = await saveWorkspace(page);
  expect(savedLayout.preset).toBe("custom");
  const persistedBeforePreset = await workspaceStorage(page);
  expect(persistedBeforePreset.raw).not.toBeNull();
  const savedEditorShare = await editorShare();

  const layoutMenu = workspace.locator(".st-workspace-move-menu");
  const layoutSummary = layoutMenu.locator("summary");
  const closedEditorPanelTop = await editorPanel.evaluate((element) => element.getBoundingClientRect().top);
  await layoutSummary.click();
  await expect(layoutMenu.locator(".st-workspace-move-controls")).toBeVisible();
  const openGeometry = await page.evaluate(() => {
    const controls = document.querySelector<HTMLElement>(".st-workspace-move-controls");
    const editor = document.querySelector<HTMLElement>('[data-workspace-panel="editor"]');
    if (!controls || !editor) throw new Error("Workspace controls or editor panel are missing");
    return { controlsBottom: controls.getBoundingClientRect().bottom, editorTop: editor.getBoundingClientRect().top };
  });
  expect(openGeometry.editorTop).toBeGreaterThan(closedEditorPanelTop);
  expect(openGeometry.controlsBottom).toBeLessThanOrEqual(openGeometry.editorTop);

  const saveStatus = editorPanel.locator(".pg-save-state");
  await expect(saveStatus).toHaveAttribute("open", "");
  await saveStatus.locator("summary").click();
  await expect(saveStatus).not.toHaveAttribute("open", "");
  await saveStatus.locator("summary").click();
  await expect(saveStatus.locator(".pg-save-state-detail")).toBeVisible();
  await saveStatus.locator("summary").click();
  await expect(saveStatus.locator(".pg-save-state-detail")).not.toBeVisible();
  await layoutSummary.click();
  await expect.poll(() => editorPanel.evaluate((element) => element.getBoundingClientRect().top)).toBe(closedEditorPanelTop);

  const writingPreset = toolbar.getByRole("button", { name: "執筆", exact: true });
  const researchPreset = toolbar.getByRole("button", { name: "調査", exact: true });
  await writingPreset.focus();
  await page.keyboard.press("Tab");
  await expect(researchPreset).toBeFocused();
  const focusGeometry = await researchPreset.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    const workspaceBounds = element.closest<HTMLElement>(".st-workspace")?.getBoundingClientRect();
    if (!workspaceBounds) throw new Error("Workspace clipping bounds are missing");
    const style = getComputedStyle(element);
    const outlineWidth = Number.parseFloat(style.outlineWidth);
    const outlineOffset = Number.parseFloat(style.outlineOffset);
    return {
      visible: element.matches(":focus-visible"),
      outlineStyle: style.outlineStyle,
      outlineWidth,
      outlineOffset,
      outlineTop: bounds.top - outlineWidth - outlineOffset,
      workspaceTop: workspaceBounds.top,
    };
  });
  expect(focusGeometry.visible).toBe(true);
  expect(focusGeometry.outlineStyle).toBe("solid");
  expect(focusGeometry.outlineWidth).toBe(3);
  expect(focusGeometry.outlineOffset).toBe(2);
  expect(focusGeometry.outlineTop).toBeGreaterThanOrEqual(focusGeometry.workspaceTop);

  await researchPreset.click();
  await expect(workspace).toHaveAttribute("data-preset", "research");
  await expect(workspace.locator('[data-workspace-panel="inspector"]')).toBeVisible();
  await expect.poll(editorShare).toBeGreaterThan(0.6);
  await expect.poll(editorShare).toBeLessThan(0.74);
  expect(await page.evaluate(() =>
    (window as Window & { __presetEditorNode?: Element }).__presetEditorNode === document.querySelector(".cm-editor"),
  )).toBe(true);
  expect((await workspaceStorage(page)).raw).toBe(persistedBeforePreset.raw);

  await page.reload();
  await authorizeAuthor("desktop", page, { continueCurrentPage: true });
  await expect(page.locator(".st-workspace")).toHaveAttribute("data-preset", "custom");
  await expect.poll(async () => Math.abs(await editorShare() - savedEditorShare)).toBeLessThan(0.02);
  expect((await workspaceStorage(page)).raw).toBe(persistedBeforePreset.raw);
});

test("narrow Desktop keeps the manuscript internally scrollable while shell and workspace controls stay reachable", async ({ page, authorizeAuthor }) => {
  await page.setViewportSize({ width: 320, height: 760 });
  await openFixtureScene(page, authorizeAuthor);

  const workspace = page.locator(".st-workspace");
  const toolbar = workspaceToolbar(page);
  const editor = manuscriptEditor(page);
  const manuscript = Array.from({ length: 48 }, (_, index) =>
    `第${index + 1}段落。　灯台の下に古い書庫があり、海図の端にはまだ知られていない港の名前が小さく記されていた。`,
  ).join("\n\n");
  await editor.fill(manuscript);
  await expect(editor).toContainText("第48段落");

  const scrollState = await editor.evaluate((content) => {
    let ancestor = content.parentElement;
    let scrollArea: HTMLElement | null = null;
    while (ancestor && ancestor !== document.body) {
      const overflowY = getComputedStyle(ancestor).overflowY;
      if (ancestor.scrollHeight > ancestor.clientHeight + 1 && (overflowY === "auto" || overflowY === "scroll")) {
        scrollArea = ancestor;
        break;
      }
      ancestor = ancestor.parentElement;
    }
    if (!scrollArea) throw new Error("The manuscript has no internal vertical scroll area");
    scrollArea.scrollTop = 0;
    const before = scrollArea.scrollTop;
    const documentScrollBefore = window.scrollY;
    scrollArea.scrollTop = scrollArea.scrollHeight;
    const line = content.querySelectorAll<HTMLElement>(".cm-line").item(content.querySelectorAll(".cm-line").length - 1);
    if (!line) throw new Error("The final manuscript line is missing");
    const areaBounds = scrollArea.getBoundingClientRect();
    const lineBounds = line.getBoundingClientRect();
    return {
      before,
      after: scrollArea.scrollTop,
      documentScrollBefore,
      documentScrollAfter: window.scrollY,
      lastLineVisible: lineBounds.top >= areaBounds.top && lineBounds.bottom <= areaBounds.bottom,
    };
  });
  expect(scrollState.after).toBeGreaterThan(scrollState.before);
  expect(scrollState.documentScrollAfter).toBe(scrollState.documentScrollBefore);
  expect(scrollState.lastLineVisible).toBe(true);

  await expect(toolbar.getByRole("button", { name: "執筆", exact: true })).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320);
  await expect(page).toHaveURL(/\/desktop\//u);
});

test("malformed workspace settings are retained until the owner explicitly saves a replacement", async ({ page, authorizeAuthor }) => {
  await openFixtureScene(page, authorizeAuthor);
  await saveWorkspace(page);

  const storage = await workspaceStorage(page);
  expect(storage.key).not.toBe("");
  const malformed = '{"version":99,"preset":"custom","root":{"type":"leaf","panelId":"untrusted"},"hiddenPanelIds":[]}';
  await page.evaluate(({ key, raw }) => localStorage.setItem(key, raw), { key: storage.key, raw: malformed });
  await page.reload();
  await authorizeAuthor("desktop", page, { continueCurrentPage: true });

  await expect(page.locator(".st-workspace")).toBeVisible();
  await expect(page.locator('[data-workspace-panel="editor"] .cm-content')).toBeVisible();
  expect((await page.evaluate((key) => localStorage.getItem(key), storage.key))).toBe(malformed);

  const replacement = await saveWorkspace(page);
  expect(replacement.version).toBe(1);
  expect((JSON.parse((await workspaceStorage(page)).raw!) as WorkspaceSnapshotRecord).layout)
    .toMatchObject({ version: 1, preset: "writing" });
});

test("editor remains unavailable until delayed browser recovery completes, then reapplies the exact draft", async ({ page, authorizeAuthor }) => {
  const fixture = await openFixtureScene(page, authorizeAuthor);
  const documentUrl = `/api/v1/persistence/projects/${fixture.project.id}/documents/${fixture.scene.document.id}`;
  await page.route(`**${documentUrl}`, async (route) => {
    if (route.request().method() === "PATCH") {
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Synthetic save interruption" }) });
    } else {
      await route.continue();
    }
  });

  const draft = "Recovered after delayed IndexedDB readiness.";
  await replaceEditor(page, draft);
  await expectDraft(page, fixture.scene.document.id, draft);
  await expectServerSaveFailure(page);

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
  const recoveredAuthor = await authorizeAuthor("desktop", page, { continueCurrentPage: true });

  await expect(page.locator(".st-workspace")).toBeVisible();
  await expect(page.locator(".pg-editor")).toHaveCount(0);
  expect((await readPersistedDocument(recoveredAuthor, fixture.project.id, fixture.scene.document.id)).markdown).toBe(INITIAL_SCENE_ONE);
  await expect.poll(() => page.evaluate(() => Boolean((window as Window & { __workspaceRecoveryGate?: { opened: boolean } }).__workspaceRecoveryGate?.opened))).toBe(true);

  await page.evaluate(() => {
    const gate = (window as Window & { __workspaceRecoveryGate?: { release?: () => void } }).__workspaceRecoveryGate;
    if (!gate?.release) throw new Error("IndexedDB readiness was not held.");
    gate.release();
  });
  await expect(page.locator(".cm-content")).toHaveText(draft);
  await expectDraft(page, fixture.scene.document.id, draft);
  await page.unroute(`**${documentUrl}`);
  await page.getByRole("button", { name: /今すぐ保存|保存結果を確認して再試行|作品への保存を再試行/u }).click();
  await expectServerSaved(page);
  expect((await readPersistedDocument(recoveredAuthor, fixture.project.id, fixture.scene.document.id)).markdown).toBe(draft);
});

test("failed IndexedDB open blocks editing and preserves the PostgreSQL manuscript and recovery record", async ({ page, authorizeAuthor }) => {
  const fixture = await openFixtureScene(page, authorizeAuthor);

  const documentUrl = `/api/v1/persistence/projects/${fixture.project.id}/documents/${fixture.scene.document.id}`;
  await page.route(`**${documentUrl}`, (route) => route.request().method() === "PATCH"
    ? route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Synthetic save interruption" }) })
    : route.continue());

  const draft = "Existing recovery record survives an unavailable browser journal.";
  const editor = manuscriptEditor(page);
  await editor.click();
  await editor.press("ControlOrMeta+a");
  await page.keyboard.insertText(draft);
  await expect(editor).toHaveText(draft);
  await expectDraft(page, fixture.scene.document.id, draft);
  await expectServerSaveFailure(page);
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
  const recoveredAuthor = await authorizeAuthor("desktop", page, { continueCurrentPage: true });

  await expect(page.getByRole("heading", { name: "Database workspace" })).toBeVisible();
  await expect(page.getByRole("alert")).toContainText("ブラウザーの保存領域を利用できません");
  await expect(page.locator(".pg-document-list")).toContainText("Scene One");
  await expect(page.locator(".pg-editor")).toHaveCount(0);
  expect((await readPersistedDocument(recoveredAuthor, fixture.project.id, fixture.scene.document.id)).markdown).toBe(INITIAL_SCENE_ONE);
  const retained = await page.evaluate(() => (window as Window & {
    __readNativeRecoveryJournal?: () => Promise<DraftRecord[]>;
  }).__readNativeRecoveryJournal?.());
  expect(retained).toEqual(beforeFailure);
});

test("PostgreSQL API restart preserves canonical content and replays the exact browser draft", async ({ page, authorizeAuthor, authorServer }) => {
  test.setTimeout(180_000);
  const fixture = await openFixtureScene(page, authorizeAuthor);
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

  await replaceEditor(page, authorText);
  await expectDraft(page, fixture.scene.document.id, authorText);
  await saveStarted;
  await authorServer.restartApi();
  expect((await fetch(`${fixture.author.origin}/api/health`)).ok).toBe(true);
  releaseSave();
  await expectServerSaveFailure(page);
  expect((await readPersistedDocument(fixture.author, fixture.project.id, fixture.scene.document.id)).markdown).toBe(INITIAL_SCENE_ONE);

  await page.reload();
  const recoveredAuthor = await authorizeAuthor("desktop", page, { continueCurrentPage: true });
  await expect(page.getByRole("heading", { name: "Database workspace" })).toBeVisible();
  await expect(page.locator(".cm-content")).toHaveText(authorText);
  await expectDraft(page, fixture.scene.document.id, authorText);
  await page.unroute(`**${documentUrl}`);
  await page.getByRole("button", { name: /今すぐ保存|保存結果を確認して再試行|作品への保存を再試行/u }).click();
  await expectServerSaved(page);
  expect((await readPersistedDocument(recoveredAuthor, fixture.project.id, fixture.scene.document.id)).markdown).toBe(authorText);
  expect((await readJournal(page)).some((entry) => entry.documentId === fixture.scene.document.id)).toBe(false);
});

test("[TEST-CORE-001-001] Core-only workspace keeps authoring available without search or terminology panels", async ({ page, authorizeAuthor }) => {
  test.skip(profile !== "core", "Run this acceptance with CODEXIA_PROFILE=core.");
  const fixture = await openFixtureScene(page, authorizeAuthor);

  const contributions = await fixture.author.fetch(`/api/projects/${encodeURIComponent(fixture.project.id)}/contributions`);
  expect(contributions.ok()).toBe(true);
  const contributionIds = (await contributions.json() as Array<{ id: string }>).map((item) => item.id);
  expect(contributionIds.some((id) => id.startsWith("search."))).toBe(false);
  await expect(workspaceToolbar(page).getByRole("button", { name: "全文検索を表示", exact: true })).toHaveCount(0);
  await expect(workspaceToolbar(page).getByRole("button", { name: "用語辞典を表示", exact: true })).toHaveCount(0);

  const draft = "Core authoring works with optional search disabled.";
  // Hold remote acknowledgement so this specifically checks IndexedDB recovery,
  // not a draft already removed after a successful PostgreSQL save.
  await page.route("**/api/v1/persistence/projects/*/documents/*", (route) =>
    route.request().method() === "PATCH" ? route.abort("failed") : route.continue());
  await page.locator(".cm-content").fill(draft);
  await expectDraft(page, fixture.scene.document.id, draft);
});

test("full profile exposes optional lexical search and terminology without changing manuscript source", async ({ page, authorizeAuthor }) => {
  test.skip(profile !== "full", "Run this acceptance with CODEXIA_PROFILE=full.");
  const fixture = await openFixtureScene(page, authorizeAuthor, 0, true);
  const projectId = fixture.project.id;

  const contributionsResponse = await fixture.author.fetch(`/api/projects/${encodeURIComponent(projectId)}/contributions`);
  expect(contributionsResponse.ok()).toBe(true);
  const contributions = await contributionsResponse.json() as Array<{ id: string; module: string }>;
  expect(contributions.some((item) => item.id === "search.panel" && item.module === "search")).toBe(true);
  expect(contributions.some((item) => item.id === "search.terms" && item.module === "search")).toBe(true);

  const modulesResponse = await fixture.author.fetch(`/api/projects/${encodeURIComponent(projectId)}/modules`);
  expect(modulesResponse.ok()).toBe(true);
  const modules = await modulesResponse.json() as Array<{ id: string; availability: string }>;
  expect(modules.find((module) => module.id === "search")?.availability).toMatch(/^(enabled-idle|active)$/u);

  // Exercise the real Search action -> Runtime -> Core -> PostgreSQL proposal boundary.
  const projectPath = `/api/projects/${encodeURIComponent(projectId)}`;
  const origin = new URL(page.url()).origin;
  const registry = await fixture.author.fetch(`${projectPath}/actions/search.terms.list`, {
    method: "POST", headers: { Origin: origin }, data: { input: {} },
  });
  expect(registry.status()).toBe(200);
  const listed = await registry.json() as {
    ok: boolean;
    data: { terms: Array<{ id: string; canonical: string; targetPath: string }> };
  };
  expect(listed.ok).toBe(true);
  const existing = listed.data.terms.find(term => term.canonical === "Beacon Quay");
  if (!existing) throw new Error("The seeded Beacon Quay term was not listed");
  const proposedInputs = [
    { action: "search.terms.propose", input: { canonical: "New Harbor", aliases: [], targetPath: existing.targetPath }, kind: "term_registry_update" },
    { action: "search.terms.propose", input: { ...existing, aliases: ["Updated alias"] }, kind: "term_registry_update" },
    { action: "search.terms.remove", input: { id: existing.id }, kind: "term_registry_remove" },
  ];
  for (const { action, input, kind } of proposedInputs) {
    const response = await fixture.author.fetch(`${projectPath}/actions/${action}`, { method: "POST", headers: { Origin: origin }, data: { input } });
    expect(response.status()).toBe(200);
    const result = await response.json() as { ok: boolean; data?: { proposal: { id: string } } };
    expect(result.ok, JSON.stringify(result)).toBe(true);
    const persisted = await fixture.author.fetch(`${projectPath}/proposals/${result.data!.proposal.id}`);
    expect(persisted.status()).toBe(200);
    expect(await persisted.json()).toMatchObject({ proposal: { id: result.data!.proposal.id, evidence: [{ module: "search", kind }] } });
  }

  const sourceBefore = (await readPersistedDocument(fixture.author, projectId, fixture.scene.document.id)).markdown;
  expect(sourceBefore).toContain("Beacon Quay appears in this scene.");
  expect(sourceBefore).not.toMatch(/\[Beacon Quay\]\(/u);

  const toolbar = workspaceToolbar(page);
  await openPanelMenu(page);
  await toolbar.getByRole("button", { name: "全文検索を表示", exact: true }).click();
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
  const menuSearch = toolbar.getByRole("searchbox", { name: "パネルを検索" });
  await menuSearch.fill("用語辞典");
  await menuSearch.press("Tab");
  await page.keyboard.press("Enter");
  const termsPanel = page.locator('[data-workspace-panel="module:search.terms"]');
  await expect(termsPanel).toBeVisible();
  const selectedResearchTab = page.getByRole("tablist", { name: "パネル" }).getByRole("tab", { name: "用語辞典", exact: true });
  await expect.poll(() => selectedResearchTab.evaluate((element) => {
    const tab = element.getBoundingClientRect();
    const parent = element.parentElement!.getBoundingClientRect();
    return tab.left >= parent.left - 1 && tab.right <= parent.right + 1;
  })).toBe(true);
  await closePanelMenu(page);
  await expect(termsPanel).toContainText("Lantern Harbor");
  await expect(termsPanel).toContainText("Beacon Quay");
  await termsPanel.getByRole("button", { name: "用語「Beacon Quay」の参照先を開く", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Scene Two" })).toBeVisible();

  await page.getByRole("tablist", { name: "パネル" }).getByRole("tab", { name: "作品と構成", exact: true }).click();
  await page.locator(".pg-document-list").getByRole("treeitem", { name: "Scene One シーン", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Scene One" })).toBeVisible();
  await page.getByRole("button", { name: "読む", exact: true }).click();
  const termLink = page.getByRole("button", { name: "Beacon Quay、用語を開く", exact: true });
  await expect(termLink).toBeVisible();
  await termLink.click();
  await expect(page.getByRole("heading", { name: "Scene Two" })).toBeVisible();
  const sourceAfter = (await readPersistedDocument(fixture.author, projectId, fixture.scene.document.id)).markdown;
  expect(sourceAfter).toBe(sourceBefore);
});


test("desktop floating panels preserve drafts and saved layout geometry", async ({ page, authorizeAuthor }) => {
  const fixture = await openFixtureScene(page, authorizeAuthor);

  const workspace = page.locator(".st-workspace");
  await openPanelMenu(page);
  await workspaceToolbar(page).getByRole("button", { name: "知識と根拠を表示", exact: true }).click();
  await closePanelMenu(page);
  const manuscript = workspace.locator('[data-workspace-panel="editor"] .cm-content');
  const draft = "Floating workspace retains the PostgreSQL manuscript.";
  // Force the layout test to preserve an outstanding browser draft across reload
  // instead of racing the normal 900ms PostgreSQL acknowledgement and cleanup.
  await page.route("**/api/v1/persistence/projects/*/documents/*", (route) =>
    route.request().method() === "PATCH" ? route.abort("failed") : route.continue());
  await manuscript.fill(draft);
  await expect(manuscript).toHaveText(draft);
  await expectDraft(page, fixture.scene.document.id, draft);

  await workspace.getByRole("tab", { name: "作品と構成", exact: true }).click();
  await workspace.locator(".st-workspace-move-menu > summary").click();
  await workspace.locator('[data-workspace-panel="outline"]')
    .getByRole("button", { name: "作品と構成を別ウィンドウにする" }).click();
  const floating = workspace.locator('[data-floating-panel="outline"]');
  await expect(floating).toBeVisible();
  await expect(manuscript).toHaveText(draft);

  const moveMenu = workspace.locator(".st-workspace-move-menu");
  if (!await moveMenu.evaluate((element) => (element as HTMLDetailsElement).open)) await moveMenu.locator("summary").click();
  const editorPanel = workspace.locator('[data-workspace-panel="editor"]');
  await editorPanel.getByRole("button", { name: "原稿を最大化" }).click();
  await expect(editorPanel).toHaveClass(/is-maximized/);
  await editorPanel.getByRole("button", { name: "原稿を元に戻す" }).click();
  await expect(editorPanel).not.toHaveClass(/is-maximized/);

  const floatingPlacement = () => floating.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      left: Number.parseFloat(style.left),
      top: Number.parseFloat(style.top),
      width: Number.parseFloat(style.width),
      height: Number.parseFloat(style.height),
    };
  });
  const beforeReload = await floatingPlacement();
  expect(beforeReload.width).toBeGreaterThan(0);
  expect(beforeReload.height).toBeGreaterThan(0);
  await workspaceToolbar(page).getByRole("button", { name: "配置を保存", exact: true }).click();
  const stored = await workspaceStorage(page);
  expect(stored.raw).not.toBeNull();
  const savedRecord = JSON.parse(stored.raw!) as WorkspaceSnapshotRecord;
  expect(savedRecord.floating).toMatchObject([{ panelId: "outline", ...beforeReload }]);
  await page.reload();
  await authorizeAuthor("desktop", page, { continueCurrentPage: true });
  await expect(floating).toBeVisible();
  await expect.poll(floatingPlacement).toEqual(beforeReload);
  await expect(page.locator('[data-workspace-panel="editor"] .cm-content')).toHaveText(draft);

  await page.locator('[data-floating-panel="outline"]')
    .getByRole("button", { name: "パネルをドックへ戻す" }).click();
  await expect(page.locator('[data-workspace-panel="outline"]')).toBeVisible();
  await expect(workspace.locator('[data-workspace-panel="editor"] .cm-content')).toHaveText(draft);
});

test("a failed workspace record write preserves the previous dock and floating layout on reload", async ({ page, authorizeAuthor }) => {
  await openFixtureScene(page, authorizeAuthor);

  const workspace = page.locator(".st-workspace");
  await openPanelMenu(page);
  await workspaceToolbar(page).getByRole("button", { name: "知識と根拠を表示", exact: true }).click();
  await closePanelMenu(page);
  await workspace.getByRole("tab", { name: "作品と構成", exact: true }).click();
  await workspace.locator(".st-workspace-move-menu > summary").click();
  await workspace.locator('[data-workspace-panel="outline"]')
    .getByRole("button", { name: "作品と構成を別ウィンドウにする" }).click();
  const floating = workspace.locator('[data-floating-panel="outline"]');
  await expect(floating).toBeVisible();
  await saveWorkspace(page);
  const oldSnapshot = await workspaceStorage(page);
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
  await workspaceToolbar(page).getByRole("button", { name: "配置を保存", exact: true }).click();
  await expect(page.locator(".st-workspace-message")).toContainText("保存できませんでした");
  await page.evaluate(() => {
    const prototype = Storage.prototype as Storage & { __workspaceOriginalSetItem?: typeof Storage.prototype.setItem };
    if (prototype.__workspaceOriginalSetItem) prototype.setItem = prototype.__workspaceOriginalSetItem;
    delete prototype.__workspaceOriginalSetItem;
  });
  expect(await page.evaluate((key) => localStorage.getItem(key), oldSnapshot.key)).toBe(previousSnapshotBytes);

  await page.reload();
  await authorizeAuthor("desktop", page, { continueCurrentPage: true });
  await expect(page.locator('[data-floating-panel="outline"]')).toBeVisible();
  const afterReloadSnapshot = await page.evaluate((key) => localStorage.getItem(key), oldSnapshot.key);
  expect(afterReloadSnapshot).toBe(previousSnapshotBytes);
  const restored = JSON.parse(afterReloadSnapshot!) as WorkspaceSnapshotRecord;
  expect(restored.layout).toEqual(previousSnapshot.layout);
  expect(restored.floating).toEqual(previousSnapshot.floating);
});


test("desktop activity stays selected on denied navigation and narrow appearance remains operable", async ({ page, authorizeAuthor }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openFixtureScene(page, authorizeAuthor);
  const editor = manuscriptEditor(page);
  await editor.click();
  const navigation = page.getByRole("toolbar", { name: "ワークスペース配置" });
  const writing = navigation.getByRole("button", { name: "執筆", exact: true });
  const review = navigation.getByRole("button", { name: "レビュー", exact: true });
  await expect(writing).toHaveAttribute("aria-pressed", "true");
  await editor.evaluate(element => element.dispatchEvent(new CompositionEvent("compositionstart", { data: "にほんご", bubbles: true })));
  await review.click();
  await expect(page.locator(".st-workspace-message")).toContainText("パネル配置は変更していません");
  await expect(writing).toHaveAttribute("aria-pressed", "true");
  await expect(review).toHaveAttribute("aria-pressed", "false");
  await editor.evaluate(element => element.dispatchEvent(new CompositionEvent("compositionend", { data: "日本語", bubbles: true })));
  await page.setViewportSize({ width: 650, height: 900 });
  const theme = page.getByLabel("外観");
  await expect(theme).toBeVisible();
  await theme.selectOption("paper");
  await expect(page.locator("html")).toHaveAttribute("data-zp-theme", "paper");
});
