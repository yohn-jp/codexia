import { expect, type APIRequestContext, type Page } from "@playwright/test";

export const authToken = process.env.CODEXIA_E2E_AUTH_TOKEN ?? "";
export interface FixtureProject { id: string; title: string }
export interface FixtureDocument { id: string; title: string; kind: string; headRevisionId: string | null }

export async function ownerLogin(page: Page, path = "/desktop/"): Promise<void> {
  await page.goto(path);
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
