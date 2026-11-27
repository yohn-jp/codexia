import { test, expect, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import type { AuthorizeAuthor, AuthorSession } from "./author-oauth-fixture";

export interface FixtureProject { id: string; title: string }
export interface FixtureDocument { id: string; title: string; kind: string; headRevisionId: string | null }
export interface WritingFixture { project: FixtureProject; scene: FixtureDocument; second: FixtureDocument }

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
export async function confirmRevisionRestore(page: Page): Promise<void> {
  await page.getByRole("dialog", { name: "Revisionの復元" }).getByRole("button", { name: "新しいRevisionとして復元" }).click();
}
export async function readManuscriptMarkdown(page: Page): Promise<string> {
  return manuscriptEditor(page).evaluate(element => Array.from(element.querySelectorAll(".cm-line"), line => line.textContent ?? "").join("\n"));
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
export async function replaceManuscript(page: Page, text: string): Promise<void> {
  const editor = manuscriptEditor(page);
  const normalized = normalizeManuscriptNewlines(text);
  await clickManuscriptEnd(editor);
  await editor.press("ControlOrMeta+a");
  if (normalized) await page.keyboard.insertText(normalized);
  else await editor.press("Backspace");
  await expect.poll(() => readManuscriptMarkdown(page)).toBe(normalized);
}

export async function appendManuscript(page: Page, text: string): Promise<void> {
  const editor = manuscriptEditor(page);
  const previous = await readManuscriptMarkdown(page);
  const normalized = normalizeManuscriptNewlines(text);
  await clickManuscriptEnd(editor);
  if (normalized) await page.keyboard.insertText(normalized);
  await expect.poll(() => readManuscriptMarkdown(page)).toBe(previous + normalized);
}

function normalizeManuscriptNewlines(text: string): string {
  return text.replace(/\r\n?/gu, "\n");
}

async function clickManuscriptEnd(editor: Locator): Promise<void> {
  const position = await editor.evaluate((element) => {
    const lines = element.querySelectorAll(".cm-line");
    const lastLine = lines.item(lines.length - 1);
    if (!lastLine) return null;

    const walker = element.ownerDocument.createTreeWalker(lastLine, NodeFilter.SHOW_TEXT);
    let lastText: Text | null = null;
    while (walker.nextNode()) lastText = walker.currentNode as Text;
    if (!lastText?.length) return null;

    const range = element.ownerDocument.createRange();
    range.setStart(lastText, lastText.length - 1);
    range.setEnd(lastText, lastText.length);
    const textRect = range.getBoundingClientRect();
    const editorRect = element.getBoundingClientRect();
    return {
      x: Math.max(1, Math.min(editorRect.width - 1, textRect.right - editorRect.left + 1)),
      y: Math.max(1, Math.min(editorRect.height - 1, textRect.top - editorRect.top + textRect.height / 2)),
    };
  });
  if (position) await editor.click({ position });
  else await editor.click();
}

export async function fillDraft(page: Page, text: string): Promise<void> {
  await replaceManuscript(page, text);
  await expectDeviceDraft(page);
}

export async function seedWritingProject(fetch: APIRequestContext["fetch"], origin: string, title = "日本語の原稿", manuscript = "最初の本文。\n次の文章です。"): Promise<WritingFixture> {
  const headers = { Origin: new URL(origin).origin };
  const createdProject = await fetch(new URL("/api/v1/persistence/projects", origin).toString(), { method: "POST", headers, data: { title: `Writing ${crypto.randomUUID()}` } });
  expect(createdProject.status()).toBe(201);
  const { project } = await createdProject.json() as { project: FixtureProject };
  async function create(title: string, orderKey: string, markdown: string): Promise<FixtureDocument> {
    const response = await fetch(new URL(`/api/v1/persistence/projects/${project.id}/documents`, origin).toString(), { method: "POST", headers: { ...headers, "Idempotency-Key": crypto.randomUUID() }, data: { kind: "scene", title, orderKey, markdown } });
    expect(response.status()).toBe(201);
    return (await response.json() as { document: FixtureDocument }).document;
  }
  const scene = await create(title, "a", manuscript);
  const second = await create("次のシーン", "b", "最初の本文。\n次の文章です。");
  return { project, scene, second };
}

export function writingFixturePath(shell: "desktop", project: Pick<FixtureProject, "id">, scene: Pick<FixtureDocument, "id">): string {
  return `/${shell}/projects/${project.id}/scenes/${scene.id}`;
}

export async function openWritingProject(authorizeAuthor: AuthorizeAuthor, page: Page, shell: "desktop", project: FixtureProject, scene: FixtureDocument): Promise<AuthorSession> {
  const author = await authorizeAuthor(shell, page, { path: writingFixturePath(shell, project, scene) });
  await expect(manuscriptEditor(page)).toBeVisible();
  await expect(page.getByRole("heading", { name: scene.title, exact: true })).toBeVisible();
  return author;
}

export async function createOAuthWritingFixture(authorizeAuthor: AuthorizeAuthor, page: Page, shell: "desktop" = "desktop", title?: string, manuscript?: string): Promise<WritingFixture & { author: AuthorSession }> {
  const initial = await authorizeAuthor(shell, undefined, { apiSetupOnly: true });
  const fixture = await test.step("CI phase: seed-writing-project", () => seedWritingProject(initial.fetch, initial.origin, title, manuscript));
  const author = await openWritingProject(authorizeAuthor, page, shell, fixture.project, fixture.scene);
  return { ...fixture, author };
}

export async function readPersistenceDrafts(page: Page): Promise<Array<{ key: string; projectId: string; documentId: string; markdown: string; generation: number }>> {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const open = indexedDB.open("scriptorium-recovery"); open.onsuccess = () => resolve(open.result); open.onerror = () => reject(open.error); });
    try { return await new Promise((resolve, reject) => { const request = db.transaction("persistenceDrafts").objectStore("persistenceDrafts").getAll(); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); }); }
    finally { db.close(); }
  });
}
