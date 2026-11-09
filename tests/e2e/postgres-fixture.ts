import { expect, type APIRequestContext, type Page } from "@playwright/test";

export const authToken = process.env.CODEXIA_E2E_AUTH_TOKEN ?? "";
export interface FixtureProject { id: string; title: string }
export interface FixtureDocument { id: string; title: string; kind: string; headRevisionId: string | null }

export async function ownerLogin(page: Page, path = "/desktop/"): Promise<void> {
  await page.goto(new URL(path, process.env.CODEXIA_E2E_BASE_URL ?? process.env.CODEXIA_BASE_URL ?? `http://127.0.0.1:${process.env.CODEXIA_E2E_PORT ?? "4173"}`).toString());
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

export async function openFixtureScene(page: Page, index = 0): Promise<{ project: FixtureProject; scene: FixtureDocument }> {
  await ownerLogin(page);
  const { project, scenes } = await fixtureProject(page.request);
  const scene = scenes[index];
  expect(scene).toBeTruthy();
  await page.getByLabel("開く作品").selectOption(project.id);
  if (!await page.locator(".pg-document-list").getByRole("button", { name: new RegExp(scene!.title) }).isVisible()) {
    const library = page.getByRole("button", { name: /ライブラリ/u });
    if (await library.count()) await library.first().click();
  }
  await page.locator(".pg-document-list").getByRole("button", { name: new RegExp(scene!.title) }).click();
  await expect(page.getByRole("textbox", { name: "原稿 Markdown" })).toBeVisible();
  return { project, scene: scene! };
}

export async function fillDraft(page: Page, text: string): Promise<void> {
  const editor = page.getByRole("textbox", { name: "原稿 Markdown" });
  await editor.fill(text);
  await expect(editor).toHaveText(text);
  await expect(page.getByText("IndexedDB回復Journalに保存済み", { exact: true })).toBeVisible();
}

export async function createWritingFixture(page: Page, mode: "desktop" | "mobile" = "desktop", title = "日本語の原稿"): Promise<{ project: FixtureProject; scene: FixtureDocument; second: FixtureDocument }> {
  await ownerLogin(page, `/${mode}/`);
  const headers = { Origin: new URL(page.url()).origin };
  const createdProject = await page.request.post(new URL("/api/v1/persistence/projects", page.url()).toString(), { headers, data: { title: `Writing ${crypto.randomUUID()}` } });
  expect(createdProject.status()).toBe(201);
  const { project } = await createdProject.json() as { project: FixtureProject };
  async function create(title: string, orderKey: string): Promise<FixtureDocument> {
    const response = await page.request.post(new URL(`/api/v1/persistence/projects/${project.id}/documents`, page.url()).toString(), { headers: { ...headers, "Idempotency-Key": crypto.randomUUID() }, data: { kind: "scene", title, orderKey, markdown: "最初の本文。\n次の文章です。" } });
    expect(response.status()).toBe(201);
    return (await response.json() as { document: FixtureDocument }).document;
  }
  const scene = await create(title, "a");
  const second = await create("次のシーン", "b");
  await page.reload();
  if (mode === "mobile") await page.getByRole("navigation", { name: "モバイル画面" }).getByRole("button", { name: "作品", exact: true }).click();
  await page.getByLabel("開く作品").selectOption(project.id);
  await page.locator(".pg-document-list").getByRole("button", { name: new RegExp(title) }).click();
  if (mode === "mobile") await page.getByRole("navigation", { name: "モバイル画面" }).getByRole("button", { name: "書く", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "原稿 Markdown" })).toBeVisible();
  return { project, scene, second };
}

export async function readPersistenceDrafts(page: Page): Promise<Array<{ key: string; projectId: string; documentId: string; markdown: string; generation: number }>> {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const open = indexedDB.open("scriptorium-recovery"); open.onsuccess = () => resolve(open.result); open.onerror = () => reject(open.error); });
    try { return await new Promise((resolve, reject) => { const request = db.transaction("persistenceDrafts").objectStore("persistenceDrafts").getAll(); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); }); }
    finally { db.close(); }
  });
}
