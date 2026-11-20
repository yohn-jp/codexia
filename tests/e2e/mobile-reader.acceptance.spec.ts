import { expect, test } from "@playwright/test";
import { createWritingFixture, manuscriptEditor as editor } from "./postgres-fixture";

test.use({ hasTouch: true, viewport: { width: 390, height: 844 } });

async function replaceEditor(page: Parameters<typeof createWritingFixture>[0], text: string): Promise<void> {
  const field = editor(page);
  await field.fill(text);
}

async function visibleParagraphs(page: Parameters<typeof createWritingFixture>[0]): Promise<string[]> {
  return page.locator(".reading-pager-content .ruby-line").evaluateAll((elements) => {
    const viewport = document.querySelector<HTMLElement>(".reading-pager");
    if (!viewport) return [];
    const box = viewport.getBoundingClientRect();
    return elements.filter((element) => {
      const rect = element.getBoundingClientRect();
      return rect.right > box.left && rect.left < box.right && rect.bottom > box.top && rect.top < box.bottom;
    }).map((element) => element.textContent ?? "");
  });
}

test("mobile reader keeps Japanese pages visible in both writing directions", async ({ page }) => {
  const { project, scene } = await createWritingFixture(page, "mobile");
  const text = Array.from({ length: 130 }, (_, index) => `第${index + 1}段落｜日本語の本文を読む。`).join("\n");
  await replaceEditor(page, text);
  await expect.poll(async () => {
    const response = await page.request.get(`/api/v1/persistence/projects/${project.id}/documents/${scene.id}`);
    return response.ok() ? ((await response.json()) as { revision: { markdown: string } }).revision.markdown : "";
  }).toBe(text);
  await page.getByRole("button", { name: "読む", exact: true }).click();
  const displayMenu = page.locator(".pg-editor-display-menu");
  if (!await displayMenu.evaluate((element) => (element as HTMLDetailsElement).open)) await displayMenu.locator("summary").click();
  await page.getByLabel("組方向").selectOption("vertical");
  await expect.poll(() => visibleParagraphs(page)).toContainEqual(expect.stringContaining("第1段落"));
  const before = await page.locator(".reading-pager").getAttribute("data-page-index");
  const beforeChrome = await page.locator(".reading-pager").getAttribute("class");
  await page.locator(".reading-pager").dispatchEvent("pointerdown", { pointerId: 11, pointerType: "touch", clientX: 120, clientY: 120, button: 0 });
  await page.locator(".reading-pager").dispatchEvent("pointercancel", { pointerId: 11, pointerType: "touch", clientX: 120, clientY: 120, button: 0 });
  await expect(page.locator(".reading-pager")).toHaveAttribute("data-page-index", before!);
  await expect(page.locator(".reading-pager")).toHaveAttribute("class", beforeChrome!);
  await page.getByRole("button", { name: "次のページ", exact: true }).click();
  await expect.poll(() => visibleParagraphs(page)).not.toContainEqual(expect.stringContaining("第1段落"));
  await expect.poll(() => page.locator(".reading-pager").getAttribute("data-page-index")).not.toBe(before);
});
