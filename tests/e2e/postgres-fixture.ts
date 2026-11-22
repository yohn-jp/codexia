import { expect, type APIRequestContext, type Locator, type Page } from "@playwright/test";

export const authToken = process.env.CODEXIA_E2E_AUTH_TOKEN ?? "";
export const appBaseURL = process.env.CODEXIA_E2E_BASE_URL ?? process.env.CODEXIA_BASE_URL ?? `http://127.0.0.1:${process.env.CODEXIA_E2E_PORT ?? "4173"}`;
export interface FixtureProject { id: string; title: string }
export interface FixtureDocument { id: string; title: string; kind: string; headRevisionId: string | null }

/** Shared manuscript operator; callers own the scenario and text assertions. */
export const manuscriptEditor = (page: Page) => page.getByRole("textbox", { name: "本文", exact: true });
export async function openProtectionDetails(page: Page): Promise<Locator> {
  const details = page.locator(".pg-save-state");
  if (!await details.evaluate((element) => (element as HTMLDetailsElement).open)) await details.locator("summary").click();
  return details;
}
export async function expectDeviceDraft(page: Page): Promise<void> {
  const details = await openProtectionDetails(page);
  await expect(details).toContainText("この端末: 現在の編集をこのブラウザーに記録しました");
}
export async function expectNoUnsavedDeviceChanges(page: Page): Promise<void> {
  const details = await openProtectionDetails(page);
  await expect(details).toContainText("この端末: この原稿に未保存の変更はありません");
}
export async function expectServerSaved(page: Page): Promise<void> {
  await expect(page.locator(".pg-save-state")).toHaveAttribute("data-state", "saved", { timeout: 15_000 });
}
export async function expectServerSaveFailure(page: Page): Promise<void> {
  const details = await openProtectionDetails(page);
  await expect(details.locator("summary")).toHaveText(/保存結果を確認できません|作品への保存を確認できません/, { timeout: 15_000 });
  await expect(details).toContainText("今回の保存結果を確認できません");
}
export async function openRevisionHistory(scope: Page | Locator): Promise<void> {
  const menu = scope.locator(".pg-editor-command-menu");
  if (!await menu.evaluate((element) => (element as HTMLDetailsElement).open)) await menu.locator("summary").click();
  await scope.getByRole("button", { name: "Revision履歴", exact: true }).click();
}
export async function readManuscriptMarkdown(page: Page): Promise<string> {
  return manuscriptEditor(page).evaluate(element => Array.from(element.querySelectorAll(".cm-line"), line => line.textContent ?? "").join("\n"));
}

export async function ownerLogin(page: Page, path = "/desktop/"): Promise<void> {
  await page.goto(new URL(path, appBaseURL).toString());
  await expect(page.getByLabel("アクセス・トークン").or(page.getByRole("heading", { name: "Database workspace" }))).toBeVisible();
  if (await page.getByLabel("アクセス・トークン").isVisible()) {
    await page.getByLabel("アクセス・トークン").fill(authToken);
    await page.getByRole("button", { name: "PostgreSQL作品を開く" }).click();
  }
  await expect(page.getByRole("heading", { name: "Database workspace" })).toBeVisible();
}

export async function fixtureProject(request: APIRequestContext): Promise<{ project: FixtureProject; scenes: FixtureDocument[] }> {
  const response = await request.get("/api/v1/persistence/projects");
  expect(response.ok()).toBe(true);
  const projects = await response.json() as FixtureProject[];
  const project = projects.find((item) => item.title === process.env.CODEXIA_E2E_PROJECT_TITLE) ?? projects.find((item) => item.title.startsWith("Acceptance manuscript"));
  expect(project, "disposable browser project must exist").toBeTruthy();
  const documentsResponse = await request.get(`/api/v1/persistence/projects/${project!.id}/documents`);
  expect(documentsResponse.ok()).toBe(true);
  const { documents } = await documentsResponse.json() as { documents: FixtureDocument[] };
  return { project: project!, scenes: documents.filter((item) => item.kind === "scene") };
}

/** Shared canonical UI operators for acceptance and performance probes. */
export async function selectManuscriptProject(page: Page, projectId: string): Promise<void> {
  await page.getByLabel("作品", { exact: true }).selectOption(projectId);
}
export async function openManuscriptScene(page: Page, scene: Pick<FixtureDocument, "id" | "title">): Promise<void> {
  const button = page.locator(`.pg-document-list .pg-outline-item[data-document-id="${scene.id}"] > .pg-outline-row > .pg-outline-document`);
  if (!await button.isVisible()) {
    const library = page.getByRole("button", { name: /ライブラリ/u });
    if (await library.count()) await library.first().click();
  }
  await button.click();
  await expect(button).toHaveAttribute("aria-current", "page");
  await expect(manuscriptEditor(page)).toBeVisible();
  await expect(page.getByRole("heading", { name: scene.title, exact: true })).toBeVisible();
}
export async function openFixtureScene(page: Page, index = 0): Promise<{ project: FixtureProject; scene: FixtureDocument }> {
  await ownerLogin(page);
  const { project, scenes } = await fixtureProject(page.request);
  const scene = scenes[index];
  expect(scene).toBeTruthy();
  await selectManuscriptProject(page, project.id);
  await openManuscriptScene(page, scene!);
  return { project, scene: scene! };
}

export async function fillDraft(page: Page, text: string): Promise<void> {
  const editor = manuscriptEditor(page);
  await editor.fill(text);
  await expect(editor).toHaveText(text);
  await expectDeviceDraft(page);
}

export async function createWritingFixture(page: Page, mode: "desktop" | "mobile" = "desktop", title = "日本語の原稿", manuscript = "最初の本文。\n次の文章です。"): Promise<{ project: FixtureProject; scene: FixtureDocument; second: FixtureDocument }> {
  const headers = { Origin: new URL(appBaseURL).origin };
  const session = await page.request.get(new URL("/api/session", appBaseURL).href);
  if (session.status() === 401) {
    const login = await page.request.post(new URL("/api/login", appBaseURL).href, { headers, data: { token: authToken } });
    expect(login.status()).toBe(200);
  } else {
    expect(session.status()).toBe(200);
  }
  const createdProject = await page.request.post(new URL("/api/v1/persistence/projects", appBaseURL).toString(), { headers, data: { title: `Writing ${crypto.randomUUID()}` } });
  expect(createdProject.status()).toBe(201);
  const { project } = await createdProject.json() as { project: FixtureProject };
  async function create(title: string, orderKey: string, markdown: string): Promise<FixtureDocument> {
    const response = await page.request.post(new URL(`/api/v1/persistence/projects/${project.id}/documents`, appBaseURL).toString(), { headers: { ...headers, "Idempotency-Key": crypto.randomUUID() }, data: { kind: "scene", title, orderKey, markdown } });
    expect(response.status()).toBe(201);
    return (await response.json() as { document: FixtureDocument }).document;
  }
  const scene = await create(title, "a", manuscript);
  const second = await create("次のシーン", "b", "最初の本文。\n次の文章です。");
  // Fixture setup must not race an unrelated prior project's guarded selector.
  // Exercise the supported canonical deep link instead of mutating UI selection.
  const writingRoute = `/${mode}/projects/${project.id}/scenes/${scene.id}${mode === "mobile" ? "?view=writing" : ""}`;
  await page.goto(new URL(writingRoute, appBaseURL).toString());
  await expect(page.getByRole("heading", { name: "Database workspace" })).toBeVisible();
  await expect(manuscriptEditor(page)).toBeVisible();
  await expect(page.getByRole("heading", { name: title, exact: true })).toBeVisible();
  return { project, scene, second };
}

export async function readPersistenceDrafts(page: Page): Promise<Array<{ key: string; projectId: string; documentId: string; markdown: string; generation: number }>> {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const open = indexedDB.open("scriptorium-recovery"); open.onsuccess = () => resolve(open.result); open.onerror = () => reject(open.error); });
    try { return await new Promise((resolve, reject) => { const request = db.transaction("persistenceDrafts").objectStore("persistenceDrafts").getAll(); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); }); }
    finally { db.close(); }
  });
}
