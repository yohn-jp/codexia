import type { Page } from "@playwright/test";
import { expect, test, type AuthorSession } from "./author-oauth-fixture";
import { createOAuthWritingFixture, expectDeviceDraft, manuscriptEditor } from "./postgres-fixture";

const databaseUrl = process.env.CODEXIA_E2E_DATABASE_URL;
const originalMarkdown = "最初の本文。\n次の文章です。";

async function proposeNode(author: AuthorSession, projectId: string, label: string, id = crypto.randomUUID()) {
  const projectResponse = await author.fetch(`/api/v1/persistence/projects/${projectId}`);
  expect(projectResponse.ok(), await projectResponse.text()).toBe(true);
  const { project } = await projectResponse.json() as { project: { version: number } };
  const response = await author.fetch(`/api/v1/persistence/projects/${projectId}/changesets`, {
    method: "POST",
    headers: { Origin: author.origin, "Idempotency-Key": crypto.randomUUID() },
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

async function proposeCoreMetadata(author: AuthorSession, projectId: string, message: string) {
  const snapshotResponse = await author.fetch(`/api/projects/${projectId}/snapshot?projection=editor`);
  expect(snapshotResponse.ok(), await snapshotResponse.text()).toBe(true);
  const { snapshot } = await snapshotResponse.json() as { snapshot: { projectId: string; projectVersion: number } };
  const id = crypto.randomUUID();
  const operation = {
    id: crypto.randomUUID(), generation: 0, projectId, baseProjectVersion: snapshot.projectVersion,
    effect: "metadata", reads: [], writes: [{ path: `meta/review-feed/${id}.yaml`, revision: null, content: "status: proposed\n" }], message,
  };
  const response = await author.fetch(`/api/projects/${projectId}/proposals`, {
    method: "POST",
    headers: { Origin: author.origin }, data: { id, snapshot, operations: [operation] },
  });
  expect(response.status(), await response.text()).toBe(201);
  return id;
}

async function proposeMerge(author: AuthorSession, projectId: string) {
  const sourceId = crypto.randomUUID();
  const targetId = crypto.randomUUID();
  const origin = author.origin;
  for (const [id, name] of [[sourceId, "統合元人物"], [targetId, "統合先人物"]]) {
    const saved = await author.fetch(`/api/v1/persistence/projects/${projectId}/nodes/${id}`, {
      method: "PUT",
      headers: { Origin: origin },
      data: { type: "person", name, attributes: { createdFor: "native-merge-review" }, status: "confirmed", expectedVersion: null },
    });
    expect(saved.ok(), await saved.text()).toBe(true);
  }
  const projectResponse = await author.fetch(`/api/v1/persistence/projects/${projectId}`);
  expect(projectResponse.ok(), await projectResponse.text()).toBe(true);
  const { project } = await projectResponse.json() as { project: { version: number } };
  const previewResponse = await author.fetch(`/api/projects/${projectId}/actions/core.knowledge.merge.preview`, {
    method: "POST",
    headers: { Origin: origin }, data: { input: { sourceId, targetId, projectVersion: project.version } },
  });
  expect(previewResponse.ok(), await previewResponse.text()).toBe(true);
  const preview = await previewResponse.json() as { ok: true; data: { previewDigest: string; projectVersion: number } };
  const proposalResponse = await author.fetch(`/api/projects/${projectId}/actions/core.knowledge.merge.propose`, {
    method: "POST",
    headers: { Origin: origin },
    data: { input: { sourceId, targetId, projectVersion: preview.data.projectVersion, previewDigest: preview.data.previewDigest, idempotencyKey: crypto.randomUUID() } },
  });
  expect(proposalResponse.ok(), await proposalResponse.text()).toBe(true);
  const proposal = await proposalResponse.json() as { ok: true; data: { changeSet: { id: string; version: number } } };
  return { sourceId, targetId, preview, changeSet: proposal.data.changeSet };
}

async function openReview(page: Page) {
  const menu = page.locator(".st-workspace-panel-menu > summary");
  const panelMenu = page.locator(".st-workspace-panel-menu");
  const show = page.getByRole("button", { name: "提案レビューを表示" });
  if (!await show.isVisible()) await menu.click();
  if (await show.count()) await show.click();
  if (await panelMenu.evaluate((element: HTMLDetailsElement) => element.open)) await menu.click();
  await expect(panelMenu).not.toHaveAttribute("open", "");
  await expect(page.getByRole("heading", { name: "変更提案" })).toBeVisible();
}

async function returnToEditor(page: Page) {
  await page.getByRole("toolbar", { name: "ワークスペース配置" }).getByRole("button", { name: "執筆", exact: true }).click();
}

async function openProjectCreator(page: Page) {
  const outline = page.locator('[data-workspace-panel="outline"]');
  const disclosure = outline.locator(".pg-library-create");
  if (!await disclosure.evaluate((element) => (element as HTMLDetailsElement).open)) await disclosure.locator("summary").click();
  return outline.getByLabel("作品名");
}

test("desktop native author review keeps approval separate from apply and preserves the manuscript", async ({ page, authorizeAuthor }) => {
  expect(databaseUrl, "native review browser checks require the disposable PostgreSQL fixture").toBeTruthy();
  await page.setViewportSize({ width: 1440, height: 900 });
  const { project, scene, author } = await createOAuthWritingFixture(authorizeAuthor, page, "desktop", "Native review desktop", originalMarkdown);
  const proposal = await proposeNode(author, project.id, "レビュー対象 desktop");

  // Keep the manuscript dirty and recoverable while the native review refreshes projections.
  await page.route(`**/api/v1/persistence/projects/${project.id}/documents/${scene.id}`, async (route) => {
    if (route.request().method() === "PATCH") await route.abort();
    else await route.continue();
  });
  const editor = manuscriptEditor(page);
  const draft = "提案レビュー中も保持する未保存の原稿😀";
  await editor.fill(draft);
  await expectDeviceDraft(page);

  await openReview(page);
  await expect(page.locator(".native-changeset-card")).toContainText(proposal.changeSetId);
  await expect(page.locator(".native-changeset-card")).toContainText(proposal.id);
  await expect(page.locator(".native-changeset-card")).toContainText('"expectedVersion": null');
  await page.getByRole("button", { name: "承認する" }).click();
  await expect(page.locator(".native-changeset-card")).toContainText("承認済み・未適用");
  const approved = await author.fetch(`/api/v1/persistence/projects/${project.id}/changesets/${proposal.changeSetId}`);
  expect(approved.ok()).toBe(true);
  const { changeSet: approvedChangeSet } = await approved.json() as { changeSet: { status: string; version: number } };
  expect(approvedChangeSet.status).toBe("approved");
  expect(Number.isInteger(approvedChangeSet.version)).toBe(true);
  const beforeApply = await author.fetch(`/api/v1/persistence/projects/${project.id}/nodes?limit=500`);
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
  await expect(page.locator(".native-review-message")).toContainText("適用receiptはまだ確認できません。再試行は同じChangeSet versionで行います。");
  await page.getByRole("button", { name: "承認済み提案を適用" }).click();
  await expect(page.getByRole("region", { name: "適用receipt" })).toBeVisible();
  expect(applyVersions).toEqual([approvedChangeSet.version, approvedChangeSet.version]);
  const afterApply = await author.fetch(`/api/v1/persistence/projects/${project.id}/nodes?limit=500`);
  expect((await afterApply.json() as { nodes: Array<{ id: string }> }).nodes.some((node) => node.id === proposal.id)).toBe(true);
  await returnToEditor(page);
  await expect(editor).toBeVisible();
  await expect(editor).toContainText(draft);
  const document = await author.fetch(`/api/v1/persistence/projects/${project.id}/documents/${scene.id}`);
  expect((await document.json() as { revision: { markdown: string } }).revision.markdown).not.toContain(draft);
});

test("native rejection leaves canonical Knowledge unchanged and stale application remains recoverable", async ({ page, authorizeAuthor }) => {
  expect(databaseUrl).toBeTruthy();
  await page.setViewportSize({ width: 1440, height: 900 });
  const { project, author } = await createOAuthWritingFixture(authorizeAuthor, page, "desktop", "Native review decisions", originalMarkdown);
  const rejected = await proposeNode(author, project.id, "却下される候補");
  const stale = await proposeNode(author, project.id, "競合する候補");
  await openReview(page);
  await page.locator(".native-changeset-select").filter({ hasText: rejected.changeSetId }).click();
  await page.getByRole("button", { name: "却下する" }).click();
  await expect(page.locator(".native-changeset-card")).toContainText("却下");
  const unchanged = await author.fetch(`/api/v1/persistence/projects/${project.id}/nodes?limit=500`);
  expect((await unchanged.json() as { nodes: Array<{ id: string }> }).nodes.some((node) => node.id === rejected.id)).toBe(false);

  await page.locator(".native-changeset-select").filter({ hasText: stale.changeSetId }).click();
  await page.getByRole("button", { name: "承認する" }).click();
  await expect(page.locator(".native-changeset-card")).toContainText("承認済み・未適用");
  const conflictingWrite = await author.fetch(`/api/v1/persistence/projects/${project.id}/nodes/${stale.id}`, {
    method: "PUT",
    headers: { Origin: author.origin },
    data: { type: "person", name: "別操作で先に確定", attributes: {}, status: "confirmed", expectedVersion: null },
  });
  expect(conflictingWrite.ok(), await conflictingWrite.text()).toBe(true);
  await page.getByRole("button", { name: "承認済み提案を適用" }).click();
  await expect(page.getByRole("alert")).toContainText("前提条件が更新されています");
  const authoritative = await author.fetch(`/api/v1/persistence/projects/${project.id}/changesets/${stale.changeSetId}`);
  const latest = await authoritative.json() as { changeSet: { status: string }; receipt?: unknown };
  expect(latest.changeSet.status).toBe("approved");
  expect(latest.receipt).toBeUndefined();
  await expect(page.getByRole("button", { name: "承認済み提案を適用" })).toBeDisabled();
  await page.getByRole("button", { name: "最新状態を再確認" }).click();
  await expect(page.getByRole("button", { name: "承認済み提案を適用" })).toBeEnabled();
});

test("native apply reconciles a response lost after the database committed", async ({ page, authorizeAuthor }) => {
  expect(databaseUrl).toBeTruthy();
  await page.setViewportSize({ width: 1440, height: 900 });
  const { project, author } = await createOAuthWritingFixture(authorizeAuthor, page, "desktop", "Committed apply with lost response", originalMarkdown);
  const proposal = await proposeNode(author, project.id, "応答断後に照合する候補");
  await openReview(page);
  await page.locator(".native-changeset-select").filter({ hasText: proposal.changeSetId }).click();
  await page.getByRole("button", { name: "承認する" }).click();
  await expect(page.locator(".native-changeset-card")).toContainText("承認済み・未適用");

  let applyRequests = 0;
  await page.route(`**/api/v1/persistence/projects/${project.id}/changesets/${proposal.changeSetId}/apply`, async (route) => {
    applyRequests += 1;
    const committedResponse = await route.fetch();
    expect(committedResponse.ok()).toBe(true);
    await committedResponse.body();
    await route.abort("connectionreset");
  });
  await page.getByRole("button", { name: "承認済み提案を適用" }).click();
  const receipt = page.getByRole("region", { name: "適用receipt" });
  await expect(receipt).toBeVisible();
  expect(applyRequests).toBe(1);
  const [detail, nodes] = await Promise.all([
    author.fetch(`/api/v1/persistence/projects/${project.id}/changesets/${proposal.changeSetId}`),
    author.fetch(`/api/v1/persistence/projects/${project.id}/nodes?limit=500`),
  ]);
  const applied = await detail.json() as { changeSet: { status: string }; receipt?: { changeSet: { id: string } } };
  expect(applied.changeSet.status).toBe("applied");
  expect(applied.receipt?.changeSet.id).toBe(proposal.changeSetId);
  expect((await nodes.json() as { nodes: Array<{ id: string }> }).nodes.some((node) => node.id === proposal.id)).toBe(true);
});

test("author review reads native ChangeSets from the unified feed and keeps one actionable Core card", async ({ page, authorizeAuthor }) => {
  expect(databaseUrl).toBeTruthy();
  await page.setViewportSize({ width: 1440, height: 900 });
  const { project, author } = await createOAuthWritingFixture(authorizeAuthor, page, "desktop", "Unified author review feed", originalMarkdown);
  const coreProposalId = await proposeCoreMetadata(author, project.id, "Core feed proposal");
  const native = await proposeNode(author, project.id, "Native feed proposal");
  await page.reload();
  await authorizeAuthor("desktop", page, { continueCurrentPage: true });
  await expect(manuscriptEditor(page)).toBeVisible();
  let feedReads = 0;
  let nativeListReads = 0;
  page.on("request", request => {
    const path = new URL(request.url()).pathname;
    if (path.endsWith("/review-feed")) feedReads += 1;
    if (/\/changesets$/u.test(path)) nativeListReads += 1;
  });
  await openReview(page);
  await expect(page.getByRole("region", { name: "Core提案の承認と適用状況" })).toHaveCount(0);
  const coreCard = page.locator(".proposal-card").filter({ hasText: coreProposalId });
  await expect(coreCard).toHaveCount(1);
  await expect(coreCard).toContainText("Core feed proposal");
  await expect(coreCard.getByRole("button", { name: "承認して PostgreSQL Revision" })).toBeEnabled();
  const nativeCard = page.locator(".native-changeset-card");
  await expect(nativeCard).toContainText(native.changeSetId);
  await expect(nativeCard).toContainText("提案");
  await expect(page.getByRole("button", { name: "承認する" })).toBeEnabled();
  expect(feedReads).toBe(1);
  expect(nativeListReads).toBe(0);
});

test("author review shows durable Core status once when IndexedDB journal is unavailable", async ({ page, authorizeAuthor }) => {
  expect(databaseUrl).toBeTruthy();
  await page.setViewportSize({ width: 1440, height: 900 });
  const { project, author } = await createOAuthWritingFixture(authorizeAuthor, page, "desktop", "Unavailable review journal", originalMarkdown);
  const coreProposalId = await proposeCoreMetadata(author, project.id, "Server-only Core review");
  await page.addInitScript(() => Object.defineProperty(window, "indexedDB", { configurable: true, get() { throw new Error("IndexedDB unavailable in acceptance test"); } }));
  await page.reload();
  await authorizeAuthor("desktop", page, { continueCurrentPage: true });
  await openReview(page);
  const feed = page.getByRole("region", { name: "Core提案の承認と適用状況" });
  await expect(feed).toContainText("Server-only Core review");
  await expect(feed).toContainText(coreProposalId);
  expect(await page.locator(".proposal-card").filter({ hasText: coreProposalId }).count()).toBe(1);
});

test("author review surfaces a missing feed without requesting the native ChangeSet list", async ({ page, authorizeAuthor }) => {
  expect(databaseUrl).toBeTruthy();
  await page.setViewportSize({ width: 1440, height: 900 });
  const { project, author } = await createOAuthWritingFixture(authorizeAuthor, page, "desktop", "Unavailable author review feed", originalMarkdown);
  await proposeNode(author, project.id, "Proposal behind unavailable feed");
  let listReads = 0;
  await page.route(`**/api/v1/persistence/projects/${project.id}/review-feed**`, route => route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "Not found", code: "NOT_FOUND" }) }));
  page.on("request", request => { if (/\/changesets$/u.test(new URL(request.url()).pathname)) listReads += 1; });
  await openReview(page);
  const review = page.getByRole("region", { name: "変更提案" });
  await expect(review.getByRole("alert")).toHaveText("Not found");
  await expect(review.getByRole("button", { name: "承認する" })).toHaveCount(0);
  expect(listReads).toBe(0);
});

test("desktop author review presents exact native merge effects and refreshes canonical state after approved apply", async ({ page, authorizeAuthor }) => {
  expect(databaseUrl, "native merge review browser checks require the disposable PostgreSQL fixture").toBeTruthy();
  await page.setViewportSize({ width: 1440, height: 900 });
  const { project, author } = await createOAuthWritingFixture(authorizeAuthor, page, "desktop", "Native merge review desktop", originalMarkdown);
  const merge = await proposeMerge(author, project.id);
  const before = await author.fetch(`/api/v1/persistence/projects/${project.id}/nodes/${merge.sourceId}`);
  expect(before.ok(), await before.text()).toBe(true);
  expect((await before.json() as { node: { status: string } }).node.status).toBe("confirmed");
  await openReview(page);
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
  const unchanged = await author.fetch(`/api/v1/persistence/projects/${project.id}/nodes/${merge.sourceId}`);
  expect(unchanged.ok(), await unchanged.text()).toBe(true);
  expect((await unchanged.json() as { node: { status: string } }).node.status).toBe("confirmed");
  await page.getByRole("button", { name: "承認済み提案を適用" }).click();
  const receipt = page.getByRole("region", { name: "適用receipt" });
  await expect(receipt).toBeVisible();
  const [appliedSource, appliedTarget] = await Promise.all([
    author.fetch(`/api/v1/persistence/projects/${project.id}/nodes/${merge.sourceId}`),
    author.fetch(`/api/v1/persistence/projects/${project.id}/nodes/${merge.targetId}`),
  ]);
  expect(appliedSource.ok(), await appliedSource.text()).toBe(true);
  expect(appliedTarget.ok(), await appliedTarget.text()).toBe(true);
  expect((await appliedSource.json() as { node: { status: string } }).node.status).toBe("retired");
  expect((await appliedTarget.json() as { node: { attributes: Record<string, unknown> } }).node.attributes.createdFor).toBe("native-merge-review");
  await expect(receipt).toContainText(merge.changeSet.id);
  const detail = await author.fetch(`/api/v1/persistence/projects/${project.id}/changesets/${merge.changeSet.id}`);
  const final = await detail.json() as { receipt: { results: Array<{ auditId: string }> } };
  expect(final.receipt.results[0]?.auditId).toBeTruthy();
  await expect(receipt).toContainText(final.receipt.results[0]!.auditId);
});

test("project switch fences a late unified-feed response and withdrawn author scope hides controls", async ({ page, authorizeAuthor }) => {
  expect(databaseUrl).toBeTruthy();
  await page.setViewportSize({ width: 1440, height: 900 });
  const { project, author } = await createOAuthWritingFixture(authorizeAuthor, page, "desktop", "Native review response fence", originalMarkdown);
  const proposal = await proposeNode(author, project.id, "旧作品だけの候補");
  const oldFeedResponse = await author.fetch(`/api/v1/persistence/projects/${project.id}/review-feed?limit=100`);
  const oldFeed = await oldFeedResponse.json();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let held = false;
  await page.route(new RegExp(`/api/v1/persistence/projects/${project.id}/review-feed\\?limit=100$`), async (route) => {
    held = true;
    await gate;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(oldFeed) }).catch(() => undefined);
  });
  await openReview(page);
  await expect.poll(() => held).toBe(true);
  await page.getByRole("tab", { name: "作品と構成" }).click();
  const targetTitle = `切替先 ${crypto.randomUUID()}`;
  await (await openProjectCreator(page)).fill(targetTitle);
  await page.locator('[data-workspace-panel="outline"]').locator(".pg-library-create").getByRole("button", { name: "作成", exact: true }).click();
  await expect(page.locator("body")).toContainText(targetTitle);
  release();
  const reviewTab = page.getByRole("tab", { name: "提案レビュー" });
  if (await reviewTab.isVisible()) await reviewTab.click();
  await expect(page.getByRole("heading", { name: "変更提案" })).toBeVisible();
  await expect(page.getByText("この作品にネイティブ提案はありません。", { exact: true })).toBeVisible();
  await expect(page.locator(".native-changeset-card")).toHaveCount(0);

  // The standalone session DTO authorizes editing through authorScope.
  // A permissions array was a retired Hosted contract and never affected this UI.
  // Recheck the already-authorized author after simulating scope withdrawal,
  // without starting a second OAuth flow or relaxing the approval boundary.
  await page.route("**/api/session", async (route) => {
    const response = await route.fetch();
    if (!response.ok()) { await route.fulfill({ response }); return; }
    const body = await response.json() as Record<string, unknown>;
    await route.fulfill({ response, body: JSON.stringify({ ...body, authorScope: "" }) });
  });
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })));
  const missingAuthorControls = page.getByRole("alert").filter({ hasText: "原稿編集権限がありません" });
  await expect(missingAuthorControls).toBeVisible();
  await expect(page.getByRole("heading", { name: "Database workspace" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "承認する" })).toHaveCount(0);
});


test("native assertion review exposes modality in the primary change fields", async ({ page, authorizeAuthor }) => {
  expect(databaseUrl).toBeTruthy();
  await page.setViewportSize({ width: 1440, height: 900 });
  const { project, author } = await createOAuthWritingFixture(authorizeAuthor, page, "desktop", undefined, originalMarkdown);
  const projectResponse = await author.fetch(`/api/v1/persistence/projects/${project.id}`);
  expect(projectResponse.ok()).toBe(true);
  const { project: current } = await projectResponse.json() as { project: { version: number } };
  const response = await author.fetch(`/api/v1/persistence/projects/${project.id}/changesets`, {
    method: "POST",
    headers: { Origin: author.origin, "Idempotency-Key": crypto.randomUUID() },
    data: { projectVersion: current.version, operations: [{ type: "evidence.assertion.save", command: {
      projectId: project.id, id: crypto.randomUUID(), proposition: { statement: "未確認の推測" },
      modality: "hypothesis", perspective: "author", narrativeTime: {}, confidence: null, status: "proposed", expectedVersion: null,
    } }] },
  });
  expect(response.status(), await response.text()).toBe(201);
  await openReview(page);
  const fields = page.locator(".native-review-fields");
  await expect(fields.getByText("種別", { exact: true })).toBeVisible();
  await expect(fields.getByText("仮説", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "承認する" })).toBeVisible();
});
