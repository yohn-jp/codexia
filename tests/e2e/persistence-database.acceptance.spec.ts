import { expect, test } from "@playwright/test";

const authToken = process.env.CODEXIA_E2E_AUTH_TOKEN ?? "";
const databaseUrl = process.env.CODEXIA_E2E_DATABASE_URL;


test("Git store selector cannot bypass PostgreSQL-only authoring", async ({ page }) => {
  await page.route("**/api/v1/persistence/status", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ available: false, provider: null }) });
  });
  await page.goto("/desktop/?store=git");
  await page.getByLabel("アクセス・トークン").fill(authToken);
  await page.getByRole("button", { name: "PostgreSQL作品を開く" }).click();
  await expect(page.getByRole("heading", { name: "PostgreSQLへ接続できません" })).toBeVisible();
  await expect(page.getByRole("alert")).toContainText("Gitワークスペースへの切替は提供していません");
  await expect(page.getByRole("heading", { name: "Database workspace" })).toHaveCount(0);
});

test("Hosted permission metadata does not force Git workspace fallback", async ({ page }) => {
  expect(databaseUrl).toBeTruthy();
  await page.route("**/api/session", async (route) => {
    const response = await route.fetch();
    if (!response.ok()) { await route.fulfill({ response }); return; }
    const body = await response.json() as Record<string, unknown>;
    await route.fulfill({ response, body: JSON.stringify({ ...body, authorScope: "hosted:acceptance", permissions: ["write"] }) });
  });
  await page.goto("/mobile/?store=git");
  await page.getByLabel("アクセス・トークン").fill(authToken);
  await page.getByRole("button", { name: "PostgreSQL作品を開く" }).click();
  await expect(page.getByRole("heading", { name: "Database workspace" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Git作品を開く" })).toHaveCount(0);
});

test("PostgreSQL workspace saves, recovers, detects conflicts, and links Knowledge to Text Anchors", async ({ page }) => {
  expect(databaseUrl, "the browser acceptance server must use a disposable PostgreSQL database").toBeTruthy();
  const contentSecurityPolicyViolations: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" && message.text().includes("Content Security Policy")) {
      contentSecurityPolicyViolations.push(message.text());
    }
  });
  const projectTitle = `Database acceptance ${crypto.randomUUID()}`;
  const documentTitle = `Scene ${crypto.randomUUID()}`;
  const firstDraft = "第一稿😀\n人物は青い塔を見た。";

  await page.goto("/desktop/?acceptance=database");
  await page.getByLabel("アクセス・トークン").fill(authToken);
  await page.getByRole("button", { name: "PostgreSQL作品を開く" }).click();
  await expect(page.getByRole("heading", { name: "Database workspace" })).toBeVisible();

  await page.getByLabel("新しい作品").fill(projectTitle);
  await page.getByRole("button", { name: "作品を作成" }).click();
  await expect(page.getByRole("heading", { name: projectTitle })).toBeVisible();
  await page.getByLabel("文書を追加").fill(documentTitle);
  await page.getByRole("button", { name: "文書を作成" }).click();

  const editor = page.getByRole("textbox", { name: "原稿 Markdown" });
  await expect(editor).toBeVisible();
  await editor.fill(firstDraft);
  await expect(page.getByText("PostgreSQLへ保存済み")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("IndexedDB回復Journalに保存済み")).toBeVisible();

  await editor.press("Control+A");
  await page.getByRole("button", { name: "選択範囲をText Anchorにする" }).click();
  await expect(page.locator(".pg-notice")).toContainText("Text Anchorを保存しました");
  const evidence = page.locator(".pg-evidence-list");
  await expect(evidence).toContainText(firstDraft);

  await page.getByLabel("Knowledge候補を追加").fill("青い塔");
  await page.getByRole("button", { name: "候補を保存" }).click();
  const knowledge = page.locator(".pg-knowledge-list").getByRole("listitem").filter({ hasText: "青い塔" });
  await expect(knowledge).toBeVisible();
  await knowledge.getByRole("button", { name: "内容を確認して確定" }).click();
  await expect(knowledge).toContainText("作者確定");
  await evidence.getByRole("button", { name: /第一稿/u }).click();
  await evidence.getByRole("button", { name: "Knowledgeリンクを確定" }).click();
  await expect(page.locator(".pg-notice")).toContainText("Knowledge参照を作者確認済みとして保存しました");
  await expect(evidence).toContainText("確定先: 青い塔");

  await page.getByRole("button", { name: "Revision履歴" }).click();
  const initialRevision = page.locator(".pg-revisions article").filter({ hasText: "（空の原稿）" });
  await expect(initialRevision).toBeVisible();
  await initialRevision.getByRole("button", { name: "このRevisionを新しいRevisionとして復元" }).click();
  await expect(page.locator(".pg-notice")).toContainText("新しいPostgreSQL Revisionとして復元しました");
  await expect(editor).not.toContainText(firstDraft);

  const otherPage = await page.context().newPage();
  otherPage.on("console", (message) => {
    if (message.type() === "error" && message.text().includes("Content Security Policy")) {
      contentSecurityPolicyViolations.push(message.text());
    }
  });
  await otherPage.goto("/desktop/?store=postgres");
  await expect(otherPage.getByRole("heading", { name: "Database workspace" })).toBeVisible();
  await otherPage.getByLabel("開く作品").selectOption({ label: projectTitle });
  const otherDocument = otherPage.locator(".pg-document-list").getByRole("button", { name: new RegExp(documentTitle, "u") });
  await expect(otherDocument).toBeVisible();
  await otherDocument.click();
  const otherEditor = otherPage.getByRole("textbox", { name: "原稿 Markdown" });
  await expect(otherEditor).toBeVisible();
  await expect(otherEditor).not.toContainText(firstDraft);

  const winningDraft = "PostgreSQL側の先行Revision";
  const recoveredDraft = "別タブの回復Draft";
  await editor.fill(winningDraft);
  await expect(page.getByText("PostgreSQLへ保存済み")).toBeVisible({ timeout: 15_000 });
  await otherEditor.fill(recoveredDraft);
  await expect(otherPage.getByRole("heading", { name: "Revision競合" })).toBeVisible({ timeout: 15_000 });
  await expect(otherPage.locator(".pg-conflict")).toContainText(winningDraft);
  await expect(otherPage.locator(".pg-conflict")).toContainText(recoveredDraft);
  await otherPage.getByRole("button", { name: "比較後、この回復Draftを最新版へ適用" }).click();
  await expect(otherPage.getByText("PostgreSQLへ保存済み")).toBeVisible({ timeout: 15_000 });
  await expect(otherEditor).toContainText(recoveredDraft);

  await otherPage.route("**/api/v1/persistence/projects/*/documents/*", async (route) => {
    if (route.request().method() === "PATCH") await route.abort();
    else await route.continue();
  });
  const interruptedDraft = "再読み込み後に復旧するDraft";
  await otherEditor.fill(interruptedDraft);
  await expect(otherPage.getByText("IndexedDB回復Journalに保存済み")).toBeVisible();
  await expect(otherPage.getByText("PostgreSQL保存を確認できません")).toBeVisible({ timeout: 15_000 });
  await otherPage.unroute("**/api/v1/persistence/projects/*/documents/*");
  await otherPage.reload();
  await expect(otherPage.getByRole("heading", { name: "Database workspace" })).toBeVisible();
  await otherPage.getByLabel("開く作品").selectOption({ label: projectTitle });
  await expect(otherPage.locator(".pg-document-list").getByRole("button", { name: new RegExp(documentTitle, "u") })).toBeVisible();
  await otherPage.locator(".pg-document-list").getByRole("button", { name: new RegExp(documentTitle, "u") }).click();
  const recoveredEditor = otherPage.getByRole("textbox", { name: "原稿 Markdown" });
  await expect(recoveredEditor).toContainText(interruptedDraft);
  await expect(otherPage.getByText("PostgreSQLへ保存済み")).toBeVisible({ timeout: 15_000 });
  await otherPage.close();
  expect(contentSecurityPolicyViolations).toEqual([]);
});
