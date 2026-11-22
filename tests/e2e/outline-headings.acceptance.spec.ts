import { expect, test, type Page } from "@playwright/test";
import { createWritingFixture, expectDeviceDraft, manuscriptEditor, readManuscriptMarkdown, readPersistenceDrafts } from "./postgres-fixture";

function duplicateHeadingManuscript(): string {
  return [
    "# Shared",
    "First occurrence.",
    "",
    ...Array.from({ length: 18 }, (_, index) => `Middle paragraph ${index + 1}.`),
    "",
    "# Shared",
    "Second occurrence.",
  ].join("\n");
}

async function expectSelectedDuplicatePosition(page: Page, text: string): Promise<void> {
  await expect.poll(() => page.evaluate(() => {
    const lines = Array.from(document.querySelectorAll(".manuscript-input .cm-line"));
    const selected = lines.findIndex((line) => line.classList.contains("cm-activeLine"));
    return [lines[selected]?.textContent ?? null, lines[selected + 1]?.textContent ?? null];
  })).toEqual(["# Shared", "Second occurrence."]);
  expect(await readManuscriptMarkdown(page)).toBe(text);
}

async function fillExactDraft(page: Page, text: string): Promise<void> {
  const editor = manuscriptEditor(page);
  await editor.press("Control+a");
  await editor.fill(text);
  await expect.poll(() => readManuscriptMarkdown(page)).toBe(text);
  await expectDeviceDraft(page);
}

function observeWrites(page: Page, projectId: string): string[] {
  const writes: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    const method = request.method();
    if (url.pathname.startsWith(`/api/v1/persistence/projects/${projectId}/documents`) &&
        ["POST", "PATCH", "PUT", "DELETE"].includes(method)) writes.push(`${method} ${url.pathname}`);
    if (url.pathname.endsWith("/recent-activity") && ["POST", "PUT", "PATCH", "DELETE"].includes(method)) {
      writes.push(`${method} ${url.pathname}`);
    }
  });
  return writes;
}

async function flushDeferredHeadingEffects(page: Page): Promise<void> {
  // Advance the browser clock so a deferred position report or autosave would be observable.
  await page.clock.runFor(5_000);
}

test("desktop outline keyboard navigation reaches the second duplicate heading without writes", async ({ page }) => {
  expect(process.env.CODEXIA_E2E_DATABASE_URL, "the browser acceptance server must use a disposable PostgreSQL database").toBeTruthy();
  await page.clock.install();
  const markdown = duplicateHeadingManuscript();
  const storedMarkdown = markdown.replaceAll("\n", "\r\n");
  const fixture = await createWritingFixture(page, "desktop", `Outline headings ${crypto.randomUUID()}`, storedMarkdown);
  const path = `/api/v1/persistence/projects/${fixture.project.id}/documents/${fixture.scene.id}`;
  const before = await page.request.get(path);
  expect(before.ok()).toBe(true);
  const revisionId = (await before.json()).revision.id;
  const writes = observeWrites(page, fixture.project.id);
  const headings = page.locator(".pg-outline-heading");
  await headings.nth(0).focus();
  await page.keyboard.press("ArrowDown");
  await expect(headings.nth(1)).toBeFocused();
  await page.keyboard.press("Enter");

  await expectSelectedDuplicatePosition(page, markdown);
  await flushDeferredHeadingEffects(page);
  expect(writes).toEqual([]);
  await page.getByRole("button", { name: "読む", exact: true }).click();
  await expect(page.getByRole("button", { name: "編集へ戻る", exact: true })).toBeVisible();
  await flushDeferredHeadingEffects(page);
  const after = await page.request.get(path);
  expect(after.ok()).toBe(true);
  expect((await after.json()).revision).toMatchObject({ id: revisionId, markdown: storedMarkdown });
});

test("switching documents protects the draft and derives headings from the newly active document", async ({ page }) => {
  expect(process.env.CODEXIA_E2E_DATABASE_URL, "the browser acceptance server must use a disposable PostgreSQL database").toBeTruthy();
  const fixture = await createWritingFixture(page, "desktop", `Outline draft protection ${crypto.randomUUID()}`, "Original first document.");
  const markdown = duplicateHeadingManuscript();
  const created = await page.request.post(
    new URL(`/api/v1/persistence/projects/${fixture.project.id}/documents`, page.url()).toString(),
    {
      headers: { Origin: new URL(page.url()).origin, "Idempotency-Key": crypto.randomUUID() },
      data: { kind: "scene", title: "Another document with headings", orderKey: "c", markdown },
    },
  );
  expect(created.status()).toBe(201);
  const other = (await created.json() as { document: { id: string } }).document;
  // Keep the drafts local while exercising document switching and undo.
  // A successful autosave would correctly clear the IndexedDB draft.
  const documentsPath = `/api/v1/persistence/projects/${fixture.project.id}/documents/`;
  await page.route((url) => url.pathname.startsWith(documentsPath), (route) => {
    if (route.request().method() === "PATCH") {
      return route.fulfill({ status: 503, json: { error: "Manuscript saving temporarily unavailable" } });
    }
    return route.continue();
  });
  await page.goto(new URL(`/desktop/projects/${fixture.project.id}/scenes/${fixture.scene.id}`, page.url()).toString());
  const firstDraft = "Unsaved first document draft.";
  await fillExactDraft(page, firstDraft);
  const otherDocumentButton = page.locator(`.pg-outline-item[data-document-id="${other.id}"] > .pg-outline-row > .pg-outline-document`);
  await otherDocumentButton.click();
  await expect(manuscriptEditor(page)).toContainText("# Shared");
  expect((await readPersistenceDrafts(page)).find((draft) => draft.documentId === fixture.scene.id)?.markdown).toBe(firstDraft);

  await fillExactDraft(page, `${markdown}\nA temporary edit.`);
  const activeHeadings = page.locator(".pg-outline-heading");
  await activeHeadings.nth(0).focus();
  await page.keyboard.press("ArrowDown");
  await expect(activeHeadings.nth(1)).toBeFocused();
  await page.keyboard.press("Enter");
  await expectSelectedDuplicatePosition(page, `${markdown}\nA temporary edit.`);
  await manuscriptEditor(page).press("Control+z");
  await expect.poll(() => readManuscriptMarkdown(page)).toBe(markdown);
  expect((await readPersistenceDrafts(page)).find((draft) => draft.documentId === fixture.scene.id)?.markdown).toBe(firstDraft);
});

test.describe("mobile touch outline heading navigation", () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });

  test("touch selection reaches the second duplicate heading without writes", async ({ page }) => {
    expect(process.env.CODEXIA_E2E_DATABASE_URL, "the browser acceptance server must use a disposable PostgreSQL database").toBeTruthy();
    await page.clock.install();
    const markdown = duplicateHeadingManuscript();
    const fixture = await createWritingFixture(page, "mobile", `Outline headings ${crypto.randomUUID()}`, markdown);
    const writes = observeWrites(page, fixture.project.id);
    await page.getByRole("button", { name: "構成", exact: true }).tap();
    await expect(page.locator("ion-modal.mobile-shell-reference-modal")).toBeVisible();
    const headings = page.locator("ion-modal.mobile-shell-reference-modal .pg-outline-heading");
    await expect(headings).toHaveCount(2);
    await headings.nth(1).tap();
    await expect(page.locator("ion-modal.mobile-shell-reference-modal")).not.toBeVisible();

    await expectSelectedDuplicatePosition(page, markdown);
    await flushDeferredHeadingEffects(page);
    expect(writes).toEqual([]);
  });
});
