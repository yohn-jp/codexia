import { expect, test, type Page } from "@playwright/test";
import { createWritingFixture } from "./postgres-fixture";

const databaseUrl = process.env.CODEXIA_E2E_DATABASE_URL;

async function proposeNode(page: Page, projectId: string, label: string, id = crypto.randomUUID()) {
  const projectResponse = await page.request.get(`/api/v1/persistence/projects/${projectId}`);
  expect(projectResponse.ok(), await projectResponse.text()).toBe(true);
  const { project } = await projectResponse.json() as { project: { version: number } };
  const response = await page.request.post(`/api/v1/persistence/projects/${projectId}/changesets`, {
    headers: { Origin: new URL(page.url()).origin, "Idempotency-Key": crypto.randomUUID() },
    data: {
      projectVersion: project.version,
      operations: [{ type: "knowledge.node.save", command: {
        projectId, id, type: "person", name: label, attributes: { source: "acceptance" }, status: "proposed", expectedVersion: null,
      } }],
    },
  });
  expect(response.status(), await response.text()).toBe(201);
  const result = await response.json() as { changeSet: { id: string } };
  return { id, changeSetId: result.changeSet.id };
}

async function proposeMerge(page: Page, projectId: string) {
  const sourceId = crypto.randomUUID();
  const targetId = crypto.randomUUID();
  const origin = new URL(page.url()).origin;
  for (const [id, name] of [[sourceId, "統合元人物"], [targetId, "統合先人物"]]) {
    const saved = await page.request.put(`/api/v1/persistence/projects/${projectId}/nodes/${id}`, {
      headers: { Origin: origin },
      data: { type: "person", name, attributes: { createdFor: "native-merge-review" }, status: "confirmed", expectedVersion: null },
    });
    expect(saved.ok(), await saved.text()).toBe(true);
  }
  const projectResponse = await page.request.get(`/api/v1/persistence/projects/${projectId}`);
  expect(projectResponse.ok(), await projectResponse.text()).toBe(true);
  const { project } = await projectResponse.json() as { project: { version: number } };
  const previewResponse = await page.request.post(`/api/projects/${projectId}/actions/core.knowledge.merge.preview`, {
    headers: { Origin: origin }, data: { input: { sourceId, targetId, projectVersion: project.version } },
  });
  expect(previewResponse.ok(), await previewResponse.text()).toBe(true);
  const preview = await previewResponse.json() as { ok: true; data: { previewDigest: string; projectVersion: number } };
  const proposalResponse = await page.request.post(`/api/projects/${projectId}/actions/core.knowledge.merge.propose`, {
    headers: { Origin: origin },
    data: { input: { sourceId, targetId, projectVersion: preview.data.projectVersion, previewDigest: preview.data.previewDigest, idempotencyKey: crypto.randomUUID() } },
  });
  expect(proposalResponse.ok(), await proposalResponse.text()).toBe(true);
  const proposal = await proposalResponse.json() as { ok: true; data: { changeSet: { id: string; version: number } } };
  return { sourceId, targetId, preview, changeSet: proposal.data.changeSet };
}

async function openReview(page: Page, mode: "desktop" | "mobile") {
  if (mode === "desktop") {
    const menu = page.locator(".st-workspace-panel-menu > summary");
    const show = page.getByRole("button", { name: "Show 提案レビュー" });
    if (!await show.isVisible()) await menu.click();
    if (await show.count()) await show.click();
  } else {
    await page.getByRole("button", { name: /道具/u }).click();
  }
  await expect(page.getByRole("heading", { name: "PostgreSQL ChangeSet" })).toBeVisible();
}

async function returnToEditor(page: Page, mode: "desktop" | "mobile") {
  if (mode === "desktop") await page.getByRole("tab", { name: "原稿" }).click();
  else await page.getByRole("button", { name: /書く/u }).click();
}

for (const mode of ["desktop", "mobile"] as const) {
  test(`${mode} native author review keeps approval separate from apply and preserves the manuscript`, async ({ page }) => {
    expect(databaseUrl, "native review browser checks require the disposable PostgreSQL fixture").toBeTruthy();
    await page.setViewportSize(mode === "desktop" ? { width: 1440, height: 900 } : { width: 390, height: 844 });
    const { project, scene } = await createWritingFixture(page, mode, `Native review ${mode}`);
    const proposal = await proposeNode(page, project.id, `レビュー対象 ${mode}`);

    // Keep the manuscript dirty and recoverable while the native review refreshes projections.
    await page.route(`**/api/v1/persistence/projects/${project.id}/documents/${scene.id}`, async (route) => {
      if (route.request().method() === "PUT") await route.abort();
      else await route.continue();
    });
    const editor = page.getByRole("textbox", { name: "原稿 Markdown" });
    const draft = "提案レビュー中も保持する未保存の原稿😀";
    await editor.fill(draft);
    await expect(page.getByText("IndexedDB回復Journalに保存済み")).toBeVisible();

    await openReview(page, mode);
    await expect(page.locator(".native-changeset-card")).toContainText(proposal.changeSetId);
    await expect(page.locator(".native-changeset-card")).toContainText(proposal.id);
    await expect(page.locator(".native-changeset-card")).toContainText('"expectedVersion": null');
    await page.getByRole("button", { name: "承認する" }).click();
    await expect(page.locator(".native-changeset-card")).toContainText("承認済み・未適用");
    const approved = await page.request.get(`/api/v1/persistence/projects/${project.id}/changesets/${proposal.changeSetId}`);
    expect((await approved.json() as { changeSet: { status: string } }).changeSet.status).toBe("approved");
    const beforeApply = await page.request.get(`/api/v1/persistence/projects/${project.id}/nodes?limit=500`);
    expect((await beforeApply.json() as { nodes: Array<{ id: string }> }).nodes.some((node) => node.id === proposal.id)).toBe(false);

    const applyPath = `**/api/v1/persistence/projects/${project.id}/changesets/${proposal.changeSetId}/apply`;
    const applyVersions: number[] = [];
    let simulatedLoss = true;
    await page.route(applyPath, async (route) => {
      applyVersions.push((JSON.parse(route.request().postData() ?? "{}") as { expectedVersion: number }).expectedVersion);
      if (simulatedLoss) { simulatedLoss = false; await route.abort(); }
      else await route.continue();
    });
    await page.getByRole("button", { name: "承認済み提案を適用" }).click();
    await expect(page.getByRole("alert")).toContainText("同じChangeSet version");
    await page.getByRole("button", { name: "承認済み提案を適用" }).click();
    await expect(page.getByRole("region", { name: "適用receipt" })).toBeVisible();
    expect(applyVersions).toEqual([2, 2]);
    const afterApply = await page.request.get(`/api/v1/persistence/projects/${project.id}/nodes?limit=500`);
    expect((await afterApply.json() as { nodes: Array<{ id: string }> }).nodes.some((node) => node.id === proposal.id)).toBe(true);
    await returnToEditor(page, mode);
    await expect(editor).toBeVisible();
    await expect(editor).toContainText(draft);
    const document = await page.request.get(`/api/v1/persistence/projects/${project.id}/documents/${scene.id}`);
    expect((await document.json() as { revision: { markdown: string } }).revision.markdown).not.toContain(draft);
  });
}

test("native rejection leaves canonical Knowledge unchanged and stale application remains recoverable", async ({ page }) => {
  expect(databaseUrl).toBeTruthy();
  await page.setViewportSize({ width: 1440, height: 900 });
  const { project } = await createWritingFixture(page, "desktop", "Native review decisions");
  const rejected = await proposeNode(page, project.id, "却下される候補");
  const stale = await proposeNode(page, project.id, "競合する候補");
  await openReview(page, "desktop");
  await page.locator(".native-changeset-select").filter({ hasText: rejected.changeSetId }).click();
  await page.getByRole("button", { name: "却下する" }).click();
  await expect(page.locator(".native-changeset-card")).toContainText("却下");
  const unchanged = await page.request.get(`/api/v1/persistence/projects/${project.id}/nodes?limit=500`);
  expect((await unchanged.json() as { nodes: Array<{ id: string }> }).nodes.some((node) => node.id === rejected.id)).toBe(false);

  await page.locator(".native-changeset-select").filter({ hasText: stale.changeSetId }).click();
  const conflictingWrite = await page.request.put(`/api/v1/persistence/projects/${project.id}/nodes/${stale.id}`, {
    headers: { Origin: new URL(page.url()).origin },
    data: { type: "person", name: "別操作で先に確定", attributes: {}, status: "confirmed", expectedVersion: null },
  });
  expect(conflictingWrite.ok(), await conflictingWrite.text()).toBe(true);
  await page.getByRole("button", { name: "承認する" }).click();
  await expect(page.locator(".native-changeset-card")).toContainText("承認済み・未適用");
  await page.getByRole("button", { name: "承認済み提案を適用" }).click();
  await expect(page.getByRole("alert")).toContainText("前提条件が更新されています");
  const authoritative = await page.request.get(`/api/v1/persistence/projects/${project.id}/changesets/${stale.changeSetId}`);
  const latest = await authoritative.json() as { changeSet: { status: string }; receipt?: unknown };
  expect(latest.changeSet.status).toBe("approved");
  expect(latest.receipt).toBeUndefined();
  await expect(page.getByRole("button", { name: "承認済み提案を適用" })).toBeEnabled();
});

for (const mode of ["desktop", "mobile"] as const) {
  test(`${mode} author review presents exact native merge effects and refreshes canonical state after approved apply`, async ({ page }) => {
    expect(databaseUrl, "native merge review browser checks require the disposable PostgreSQL fixture").toBeTruthy();
    await page.setViewportSize(mode === "desktop" ? { width: 1440, height: 900 } : { width: 390, height: 844 });
    const { project } = await createWritingFixture(page, mode, `Native merge review ${mode}`);
    const merge = await proposeMerge(page, project.id);
    const before = await page.request.get(`/api/v1/persistence/projects/${project.id}/nodes/${merge.sourceId}`);
    expect(before.ok(), await before.text()).toBe(true);
    expect((await before.json() as { node: { status: string } }).node.status).toBe("confirmed");
    await openReview(page, mode);
    await page.locator(".native-changeset-select").filter({ hasText: merge.changeSet.id }).click();
    const card = page.locator(".native-changeset-card");
    const mergeRegion = card.getByRole("region", { name: "Knowledge merge proposal" });
    await expect(mergeRegion).toContainText("統合元人物");
    await expect(mergeRegion).toContainText("統合先人物");
    await expect(mergeRegion).toContainText(merge.sourceId);
    await expect(mergeRegion).toContainText(merge.targetId);
    await expect(mergeRegion).toContainText(merge.preview.data.previewDigest);
    await expect(mergeRegion).toContainText("Preview conflicts: なし");
    await expect(mergeRegion).toContainText("実際の書き込み対象: 別名 1 件 · 関係 0 件 · 根拠リンク 0 件 · 命題 0 件");
    await expect(mergeRegion.getByText("統合計画と対象リソースを確認")).toBeVisible();
    await page.getByRole("button", { name: "承認する" }).click();
    await expect(card).toContainText("承認済み・未適用");
    const unchanged = await page.request.get(`/api/v1/persistence/projects/${project.id}/nodes/${merge.sourceId}`);
    expect(unchanged.ok(), await unchanged.text()).toBe(true);
    expect((await unchanged.json() as { node: { status: string } }).node.status).toBe("confirmed");
    await page.getByRole("button", { name: "承認済み提案を適用" }).click();
    const receipt = page.getByRole("region", { name: "適用receipt" });
    await expect(receipt).toBeVisible();
    const [appliedSource, appliedTarget] = await Promise.all([
      page.request.get(`/api/v1/persistence/projects/${project.id}/nodes/${merge.sourceId}`),
      page.request.get(`/api/v1/persistence/projects/${project.id}/nodes/${merge.targetId}`),
    ]);
    expect(appliedSource.ok(), await appliedSource.text()).toBe(true);
    expect(appliedTarget.ok(), await appliedTarget.text()).toBe(true);
    expect((await appliedSource.json() as { node: { status: string } }).node.status).toBe("retired");
    expect((await appliedTarget.json() as { node: { attributes: Record<string, unknown> } }).node.attributes.createdFor).toBe("native-merge-review");
    await expect(receipt).toContainText(merge.changeSet.id);
    const detail = await page.request.get(`/api/v1/persistence/projects/${project.id}/changesets/${merge.changeSet.id}`);
    const final = await detail.json() as { receipt: { results: Array<{ auditId: string }> } };
    expect(final.receipt.results[0]?.auditId).toBeTruthy();
    await expect(receipt).toContainText(final.receipt.results[0]!.auditId);
  });
}

test("project switch fences a late native list response and read-only sessions expose no author controls", async ({ page, browser }) => {
  expect(databaseUrl).toBeTruthy();
  await page.setViewportSize({ width: 1440, height: 900 });
  const { project } = await createWritingFixture(page, "desktop", "Native review response fence");
  const proposal = await proposeNode(page, project.id, "旧作品だけの候補");
  const oldListResponse = await page.request.get(`/api/v1/persistence/projects/${project.id}/changesets?limit=100`);
  const oldList = await oldListResponse.json();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let held = false;
  await page.route(new RegExp(`/api/v1/persistence/projects/${project.id}/changesets\\?limit=100$`), async (route) => {
    held = true;
    await gate;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(oldList) }).catch(() => undefined);
  });
  await openReview(page, "desktop");
  await expect.poll(() => held).toBe(true);
  await page.getByRole("tab", { name: "作品と構成" }).click();
  const targetTitle = `切替先 ${crypto.randomUUID()}`;
  await page.getByLabel("新しい作品").fill(targetTitle);
  await page.getByRole("button", { name: "作品を作成" }).click();
  await expect(page.locator("body")).toContainText(targetTitle);
  release();
  const reviewTab = page.getByRole("tab", { name: "提案レビュー" });
  if (await reviewTab.isVisible()) await reviewTab.click();
  await expect(page.getByRole("heading", { name: "PostgreSQL ChangeSet" })).toBeVisible();
  await expect(page.getByText("この作品にネイティブ提案はありません。", { exact: true })).toBeVisible();
  await expect(page.locator(".native-changeset-card")).toHaveCount(0);

  const readOnlyPage = await browser.newPage();
  await readOnlyPage.route("**/api/session", async (route) => {
    const response = await route.fetch();
    if (!response.ok()) { await route.fulfill({ response }); return; }
    const body = await response.json() as Record<string, unknown>;
    await route.fulfill({ response, body: JSON.stringify({ ...body, permissions: ["read"] }) });
  });
  await readOnlyPage.goto("/desktop/");
  await readOnlyPage.getByLabel("アクセス・トークン").fill(process.env.CODEXIA_E2E_AUTH_TOKEN ?? "");
  await readOnlyPage.getByRole("button", { name: "PostgreSQL作品を開く" }).click();
  await expect(readOnlyPage.getByRole("alert")).toContainText("原稿編集権限がありません");
  await expect(readOnlyPage.getByRole("heading", { name: "Database workspace" })).toHaveCount(0);
  await expect(readOnlyPage.getByRole("button", { name: "承認する" })).toHaveCount(0);
});
