import { createHash } from "node:crypto";
import type { Page } from "@playwright/test";
import { expect, test, type AuthorApiFetch } from "./author-oauth-fixture";
import { preparedAuthorTest } from "./prepared-author-session";
import { createPostgresPersistence } from "@codexia/persistence-postgres";
import type { KnowledgeAliasId, KnowledgeNodeId, ProjectId } from "@codexia/persistence-contracts";
import { appendManuscript, createOAuthWritingFixture, expectDeviceDraft, expectNoUnsavedDeviceChanges, expectServerSaveFailure, expectServerSaved, openManuscriptScene, openProtectionDetails, openRevisionHistory, readManuscriptMarkdown, readPersistenceDrafts, manuscriptEditor } from "./postgres-fixture";

// Build the extra entry once for this spec, not once per test or worker transition.
test.use({ preparedAuthorEntries: true });
preparedAuthorTest.use({ preparedAuthorEntries: true });

preparedAuthorTest("preserves unsent Knowledge forms per node while switching A to B and back", async ({ page, authorizeAuthor }) => {
  expect(databaseUrl, "the browser acceptance server must use a disposable PostgreSQL database").toBeTruthy();
  const fixture = await createOAuthWritingFixture(authorizeAuthor, page, "desktop", `Knowledge draft isolation ${crypto.randomUUID()}`);
  const nodeA = crypto.randomUUID() as KnowledgeNodeId;
  const nodeB = crypto.randomUUID() as KnowledgeNodeId;
  const persistence = createPostgresPersistence(databaseUrl!);
  try {
    await persistence.transaction(async transaction => {
      await transaction.saveKnowledgeNode({ projectId: fixture.project.id as ProjectId, id: nodeA, type: "person", name: "Draft A", attributes: {}, status: "confirmed", expectedVersion: null });
      await transaction.saveKnowledgeNode({ projectId: fixture.project.id as ProjectId, id: nodeB, type: "person", name: "Draft B", attributes: {}, status: "confirmed", expectedVersion: null });
    });
  } finally { await persistence.close(); }
  await page.reload();
  await authorizeAuthor("desktop", page, { continueCurrentPage: true });
  await openResearchInspector(page);
  const browse = page.locator(".pg-knowledge-list");
  const detail = page.getByRole("region", { name: "Knowledge詳細" });
  const relationTarget = detail.locator("form.kci__form--relation select");
  const assertionStatement = detail.getByRole("textbox", { name: "命題", exact: true });
  const assertionModality = detail.locator('section[aria-labelledby="kci-assertions-heading"] form select');
  const selectNode = async (name: string) => {
    const row = browse.locator("li").filter({ hasText: name });
    await expect(row).toHaveCount(1);
    await row.getByRole("button").first().click();
    await expect(detail.getByRole("heading", { name, exact: true })).toBeVisible();
    for (const label of ["別名を追加", "関係を追加", "命題候補を作成"]) {
      await detail.locator("summary").filter({ hasText: label }).click();
    }
  };
  await selectNode("Draft A");
  await detail.getByLabel("別名候補").fill("A alias unsent");
  await detail.getByLabel("関係の種類", { exact: true }).fill("knows unsent");
  await relationTarget.selectOption(nodeB);
  await assertionStatement.fill("A statement unsent");
  await detail.getByLabel("視点", { exact: true }).fill("A perspective unsent");
  await assertionModality.selectOption("hypothesis");

  await selectNode("Draft B");
  await expect(detail.getByLabel("別名候補", { exact: true })).toHaveValue("");
  await expect(detail.getByLabel("関係の種類", { exact: true })).toHaveValue("");
  await expect(relationTarget).toHaveValue("");
  await expect(assertionStatement).toHaveValue("");
  await expect(detail.getByLabel("視点", { exact: true })).toHaveValue("author");
  await expect(assertionModality).toHaveValue("fact");
  await selectNode("Draft A");
  await expect(detail.getByLabel("別名候補", { exact: true })).toHaveValue("A alias unsent");
  await expect(detail.getByLabel("関係の種類", { exact: true })).toHaveValue("knows unsent");
  await expect(relationTarget).toHaveValue(nodeB);
  await expect(assertionStatement).toHaveValue("A statement unsent");
  await expect(detail.getByLabel("視点", { exact: true })).toHaveValue("A perspective unsent");
  await expect(assertionModality).toHaveValue("hypothesis");
});

preparedAuthorTest("browser quota failure blocks remote writes until explicit draft re-protection succeeds", async ({ page, authorizeAuthor }) => {
  const original = "Before.";
  const appendedText = " After local quota failure.";
  const draft = original + appendedText;
  const fixture = await createOAuthWritingFixture(authorizeAuthor, page, "desktop", `Draft re-protection ${crypto.randomUUID()}`, original);
  const editor = manuscriptEditor(page);
  await expect(editor).toHaveText(original);
  await expect(page.getByRole("status").filter({ hasText: "根拠を確認中" })).toHaveCount(0);
  await page.clock.install();
  let remoteWrites = 0;
  const documentPath = `/api/v1/persistence/projects/${fixture.project.id}/documents/${fixture.scene.id}`;
  async function readSavedManuscript() {
    const response = await fixture.author.fetch(documentPath);
    expect(response.ok()).toBe(true);
    return (await response.json()).revision.markdown;
  }
  page.on("request", (request) => {
    if (request.method() === "PATCH" && new URL(request.url()).pathname === documentPath) remoteWrites += 1;
  });
  await setPersistenceDraftWritesFailing(page, true);
  await editor.press("Control+End");
  await page.keyboard.insertText(appendedText);
  await expect(editor).toHaveText(draft);
  await expect(page.locator(".pg-save-state summary")).toHaveText("この入力はまだ保護されていません");
  await expect(page.locator(".pg-editor").getByRole("alert")).toContainText("復旧用の記録を作れていません");
  await expect(page.getByRole("button", { name: "下書きを再保護" })).toBeEnabled();
  await page.clock.runFor(1_500);
  expect(await readSavedManuscript()).toBe(original);
  expect(remoteWrites).toBe(0);
  expect((await readPersistenceDrafts(page)).find((item) => item.documentId === fixture.scene.id)).toBeUndefined();

  await setPersistenceDraftWritesFailing(page, false);
  await page.getByRole("button", { name: "下書きを再保護" }).click();
  await expectServerSaved(page);
  expect(remoteWrites).toBeGreaterThan(0);
  expect(await readSavedManuscript()).toBe(draft);
  expect(await readManuscriptMarkdown(page)).toBe(draft);
});

preparedAuthorTest("scene activation protects input added while the next manuscript loads", async ({ page, authorizeAuthor }) => {
  const { project, scene, second } = await createOAuthWritingFixture(authorizeAuthor, page, "desktop", undefined, "Before.");
  const originalUrl = page.url();
  const nextPath = `/api/v1/persistence/projects/${project.id}/documents/${second.id}`;
  let release!: () => void;
  let started!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const seen = new Promise<void>((resolve) => { started = resolve; });
  await page.route((url) => url.pathname === nextPath, async (route) => {
    started();
    await gate;
    await route.continue();
  });
  const destination = page.locator(`.pg-outline-item[data-document-id="${second.id}"] .pg-outline-document`);
  const draft = "Before. Input during the pending scene read.";
  try {
    await destination.click();
    await seen;
    await setPersistenceDraftWritesFailing(page, true);
    await manuscriptEditor(page).press("Control+End");
    await page.keyboard.insertText(" Input during the pending scene read.");
    await expect(manuscriptEditor(page)).toHaveText(draft);
    const loaded = page.waitForResponse((response) => new URL(response.url()).pathname === nextPath);
    release();
    expect((await loaded).ok()).toBe(true);
    await expect(page.locator('.pg-editor-column > p[role="alert"]')).toContainText("復旧用の記録を作れていません");
    await expect(page).toHaveURL(originalUrl);
    await expect(manuscriptEditor(page)).toHaveText(draft);
    await expect(page.locator(`.pg-outline-item[data-document-id="${scene.id}"] .pg-outline-document`)).toHaveAttribute("aria-current", "page");
    expect((await readPersistenceDrafts(page)).some((item) => item.documentId === scene.id)).toBe(false);
  } finally {
    release();
    await setPersistenceDraftWritesFailing(page, false);
  }
  await destination.click();
  await expect(page.getByRole("heading", { name: second.title, exact: true })).toBeVisible();
  expect((await readPersistenceDrafts(page)).find((item) => item.documentId === scene.id)?.markdown).toBe(draft);
});

const databaseUrl = process.env.CODEXIA_E2E_DATABASE_URL;

preparedAuthorTest("mixed line endings preserve source offsets for edits and selected evidence", async ({ page, authorizeAuthor }) => {
  const original = "First.\r\nSecond.\nThird.\rLast.";
  const fixture = await createOAuthWritingFixture(authorizeAuthor, page, "desktop", `Source offsets ${crypto.randomUUID()}`, original);
  const path = `/api/v1/persistence/projects/${fixture.project.id}/documents/${fixture.scene.id}`;
  const editor = manuscriptEditor(page);
  await editor.press("Control+End");
  await editor.press("A");
  const saved = `${original}A`;
  await expect.poll(async () => (await (await fixture.author.fetch(path)).json()).revision.markdown).toBe(saved);
  await editor.press("Shift+Home");
  await page.locator(".pg-editor-command-menu > summary").click();
  await page.getByRole("button", { name: "選択範囲をText Anchorにする" }).click();
  await expect(page.locator(".pg-notice")).toContainText("Text Anchorを保存しました: Last.A");
  await expect(editor.locator(".cm-text-anchor-current")).toHaveText("Last.A");
  await openResearchInspector(page);
  await page.getByLabel("Knowledge候補を追加").fill("Last");
  await page.getByRole("button", { name: "候補を保存" }).click();
  const knowledge = page.locator(".pg-knowledge-list").getByRole("listitem").filter({ hasText: "Last" });
  await knowledge.getByRole("button", { name: "内容を確認して確定" }).click();
  const evidence = page.locator(".pg-evidence-list");
  await evidence.getByRole("button", { name: /Last\.A/u }).click();
  await evidence.getByRole("button", { name: "Knowledgeリンクを確定" }).click();
  const backlinks = page.getByRole("region", { name: "Knowledgeの根拠" });
  await backlinks.getByRole("button", { name: /Last\.A/u }).click();
  await expect(page.locator(".pg-notice")).toContainText("現在のRevisionの根拠箇所を選択しました");
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toBe("Last.A");
});

preparedAuthorTest("an unavailable explicit scene route stays non-editable until the author selects a document", async ({ page, authorizeAuthor }) => {
  // Each document navigation creates a fresh runtime; restore the real test-scoped token through the isolated entry.
  test.setTimeout(180_000);
  expect(databaseUrl, "the browser acceptance server must use a disposable PostgreSQL database").toBeTruthy();
  const original = "Untouched manuscript.";
  const addition = " Unrelated draft.";
  const fixture = await createOAuthWritingFixture(authorizeAuthor, page, "desktop", `Missing route desktop ${crypto.randomUUID()}`, original);
  const editor = manuscriptEditor(page);
  await expect(editor).toHaveText(original);
  await appendManuscript(page, addition);
  await expect(editor).toHaveText(original + addition);
  await expectDeviceDraft(page);
  const missingSceneId = crypto.randomUUID();
  const route = (projectId: string, sceneId?: string) => {
    const suffix = sceneId ? `/scenes/${sceneId}` : "";
    return new URL(`/desktop/projects/${projectId}${suffix}`, page.url()).toString();
  };

  await authorizeAuthor("desktop", page, { path: route(fixture.project.id, missingSceneId) });
  await expect(page.getByRole("heading", { name: "指定された文書が見つかりません" })).toBeVisible();
  await expect(manuscriptEditor(page)).toHaveCount(0);
  expect(new URL(page.url()).pathname).toContain(`/projects/${fixture.project.id}/scenes/${missingSceneId}`);
  const storedDraft = (await readPersistenceDrafts(page)).find(draft => draft.projectId === fixture.project.id && draft.documentId === fixture.scene.id);
  expect(storedDraft?.markdown).toBe(original + addition);

  await openManuscriptScene(page, fixture.second);
  await expect(manuscriptEditor(page)).toBeVisible();
  expect(new URL(page.url()).pathname).toContain(`/projects/${fixture.project.id}/scenes/${fixture.second.id}`);
  await expect(manuscriptEditor(page)).toContainText("最初の本文。");

  await authorizeAuthor("desktop", page, { path: route(fixture.project.id, fixture.scene.id) });
  await expect(manuscriptEditor(page)).toBeVisible();
  await expect(page.getByRole("heading", { name: fixture.scene.title, exact: true })).toBeVisible();
  expect(new URL(page.url()).pathname).toContain(`/projects/${fixture.project.id}/scenes/${fixture.scene.id}`);

  await authorizeAuthor("desktop", page, { path: route(fixture.project.id) });
  await expect(manuscriptEditor(page)).toBeVisible();
  expect(new URL(page.url()).pathname).toMatch(new RegExp(`/projects/${fixture.project.id}/scenes/[^/]+$`));

  const missingProjectId = crypto.randomUUID();
  await authorizeAuthor("desktop", page, { path: route(missingProjectId, missingSceneId) });
  await expect(manuscriptEditor(page)).toHaveCount(0);
  expect(new URL(page.url()).pathname).toContain(`/projects/${missingProjectId}/scenes/${missingSceneId}`);
  await expect(page.getByRole("alert")).toContainText("を読み込めませんでした");
  await expect(page.getByRole("heading", { name: "指定された文書が見つかりません" })).toHaveCount(0);
});

preparedAuthorTest("an anchor read failure leaves the confirmed manuscript readable and can be retried", async ({ page, authorizeAuthor }) => {
  expect(databaseUrl, "the browser acceptance server must use a disposable PostgreSQL database").toBeTruthy();
  const fixture = await createOAuthWritingFixture(authorizeAuthor, page, "desktop", `Anchor read recovery desktop ${crypto.randomUUID()}`, "Readable manuscript while evidence is unavailable.");
  const writingUrl = page.url();
  const anchorUrl = new URL(`/api/v1/persistence/projects/${fixture.project.id}/documents/${fixture.scene.id}/anchors*`, writingUrl).toString();
  // The fixture renders its editor before its own anchor request completes.
  await page.goto("about:blank");
  let anchorReads = 0;
  await page.route(anchorUrl, async (route) => {
    anchorReads += 1;
    if (anchorReads === 1) return route.fulfill({ status: 503, json: { error: "Evidence temporarily unavailable" } });
    return route.continue();
  });

  await authorizeAuthor("desktop", page, { path: writingUrl });
  await expect(manuscriptEditor(page)).toContainText("Readable manuscript while evidence is unavailable.");
  await expect(page.getByRole("alert")).toContainText("根拠");
  await openResearchInspector(page);
  const evidence = page.locator(".pg-knowledge section").filter({ has: page.getByRole("heading", { name: "本文の根拠", exact: true }) });
  await expect(evidence.getByText("このRevisionにText Anchorはありません。", { exact: false })).toHaveCount(0);
  await expect(evidence.getByText("Text Anchorを取得できませんでした。", { exact: false })).toBeVisible();
  await evidence.getByRole("button", { name: "Text Anchorを再試行" }).click();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(evidence.getByText("このRevisionにText Anchorはありません。", { exact: false })).toBeVisible();
  expect(anchorReads).toBe(2);
  await expect(manuscriptEditor(page)).toContainText("Readable manuscript while evidence is unavailable.");
});

preparedAuthorTest("the manuscript opens and remains editable while its anchor read is pending", async ({ page, authorizeAuthor }) => {
  expect(databaseUrl, "the browser acceptance server must use a disposable PostgreSQL database").toBeTruthy();
  const original = "Readable while anchors are pending.";
  const addition = " Typed while anchors are pending.";
  const fixture = await createOAuthWritingFixture(authorizeAuthor, page, "desktop", `Pending anchor read desktop ${crypto.randomUUID()}`, original);
  let releaseAnchors!: () => void;
  let reportAnchorRequest!: () => void;
  const anchorsReleased = new Promise<void>((resolve) => { releaseAnchors = resolve; });
  const anchorRequestStarted = new Promise<void>((resolve) => { reportAnchorRequest = resolve; });
  const anchorUrl = new URL(`/api/v1/persistence/projects/${fixture.project.id}/documents/${fixture.scene.id}/anchors*`, page.url()).toString();
  await page.route(anchorUrl, async (route) => {
    const response = await route.fetch();
    reportAnchorRequest();
    await anchorsReleased;
    await route.fulfill({ response });
  });

  try {
    await authorizeAuthor("desktop", page, { path: `/desktop/projects/${fixture.project.id}/scenes/${fixture.scene.id}` });
    await anchorRequestStarted;
    const editor = manuscriptEditor(page);
    await expect(editor).toHaveText(original);
    await expect(page.locator(".pg-editor-column").getByRole("status").filter({ hasText: "根拠を確認中" })).toBeVisible();
    await openResearchInspector(page);
    const evidence = page.locator(".pg-knowledge section").filter({ has: page.getByRole("heading", { name: "本文の根拠", exact: true }) });
    await expect(evidence.getByText("このRevisionにText Anchorはありません。", { exact: false })).toHaveCount(0);
    await expect(evidence.getByText("Text Anchorを読み込んでいます。", { exact: false })).toBeVisible();
    const commands = page.locator(".pg-editor-command-menu");
    if (!await commands.evaluate((element) => (element as HTMLDetailsElement).open)) await commands.locator("summary").click();
    await expect(commands.getByRole("button", { name: "選択範囲をText Anchorにする" })).toBeDisabled();
    await commands.locator("summary").click();
    await appendManuscript(page, addition);
    await expect(editor).toHaveText(original + addition);
    await expectDeviceDraft(page);
    releaseAnchors();
    await expect(page.locator(".pg-editor-column").getByRole("status").filter({ hasText: "根拠を確認中" })).toHaveCount(0);
    await expect(evidence.getByText("このRevisionにText Anchorはありません。", { exact: false })).toBeVisible();
    await expect(editor).toHaveText(original + addition);
  } finally {
    releaseAnchors();
  }
});

preparedAuthorTest("a pending anchor read from the previous scene cannot replace the selected manuscript", async ({ page, authorizeAuthor }) => {
  expect(databaseUrl, "the browser acceptance server must use a disposable PostgreSQL database").toBeTruthy();
  const fixture = await createOAuthWritingFixture(authorizeAuthor, page, "desktop", `Stale anchor read ${crypto.randomUUID()}`, "First scene manuscript.");
  let releaseAnchors!: () => void;
  let reportAnchorRequest!: () => void;
  const anchorsReleased = new Promise<void>((resolve) => { releaseAnchors = resolve; });
  const anchorRequestStarted = new Promise<void>((resolve) => { reportAnchorRequest = resolve; });
  const anchorUrl = new URL(`/api/v1/persistence/projects/${fixture.project.id}/documents/${fixture.scene.id}/anchors*`, page.url()).toString();
  await page.route(anchorUrl, async (route) => {
    const response = await route.fetch();
    reportAnchorRequest();
    await anchorsReleased;
    await route.fulfill({ response }).catch(() => undefined);
  });

  try {
    await authorizeAuthor("desktop", page, { path: `/desktop/projects/${fixture.project.id}/scenes/${fixture.scene.id}` });
    await anchorRequestStarted;
    const secondScene = page.locator(`.pg-document-list .pg-outline-item[data-document-id="${fixture.second.id}"] > .pg-outline-row > .pg-outline-document`);
    await secondScene.click();
    await expect(manuscriptEditor(page)).toContainText("最初の本文。");
    await expect(page.getByRole("heading", { name: fixture.second.title, exact: true })).toBeVisible();
    releaseAnchors();
    await expect(manuscriptEditor(page)).toContainText("最初の本文。");
    await expect(page.getByRole("heading", { name: fixture.second.title, exact: true })).toBeVisible();
  } finally {
    releaseAnchors();
  }
});

test("Knowledge browse searches literal aliases and pages the same project at wide and narrow Desktop widths", async ({ page, authorizeAuthor }) => {
  expect(databaseUrl, "the browser acceptance server must use a disposable PostgreSQL database").toBeTruthy();
  const fixture = await createOAuthWritingFixture(authorizeAuthor, page, "desktop", `Knowledge browse ${crypto.randomUUID()}`);
  const persistence = createPostgresPersistence(databaseUrl!);
  const ids = Array.from({ length: 501 }, () => crypto.randomUUID() as KnowledgeNodeId);
  const duplicateIds = [ids[10]!, ids[11]!].sort();
  const longJapaneseName = "長い日本語のKnowledge名".repeat(30);
  try {
    await persistence.transaction(async transaction => {
      for (let index = 0; index < ids.length; index += 1) {
        await transaction.saveKnowledgeNode({ projectId: fixture.project.id as ProjectId, id: ids[index]!, type: index === 0 ? "my_custom_type" : index % 2 ? "person" : "place",
          name: index === 10 || index === 11 ? "同じ名前" : index === 500 ? longJapaneseName : `Browse ${String(index).padStart(4, "0")}`,
          attributes: {}, status: index % 2 ? "confirmed" : "proposed", expectedVersion: null });
      }
      await transaction.saveKnowledgeAlias({ projectId: fixture.project.id as ProjectId, id: crypto.randomUUID() as KnowledgeAliasId,
        nodeId: ids[500]!, surface: "Literal%_!Alias", normalized: "literal%_!alias", scope: null, status: "confirmed" });
      const unrelatedProject = await transaction.createProject({ title: `Knowledge browse unrelated ${crypto.randomUUID()}` });
      const unrelatedNode = crypto.randomUUID() as KnowledgeNodeId;
      await transaction.saveKnowledgeNode({ projectId: unrelatedProject.id, id: unrelatedNode, type: "person", name: "unrelated decoy", attributes: {}, status: "confirmed", expectedVersion: null });
      await transaction.saveKnowledgeAlias({ projectId: unrelatedProject.id, id: crypto.randomUUID() as KnowledgeAliasId,
        nodeId: unrelatedNode, surface: "Literal%_!Alias", normalized: "literal%_!alias", scope: null, status: "confirmed" });
    });
  } finally { await persistence.close(); }

  const base = new URL(page.url()).origin;
  const url = (query: string) => {
    const params = new URLSearchParams({ limit: "50", q: query, type: "", status: "" });
    return new URL(`/api/v1/persistence/projects/${fixture.project.id}/nodes?${params}`, base).toString();
  };
  const sameNameResponse = await fixture.author.fetch(url("同じ名前"));
  expect(sameNameResponse.ok()).toBe(true);
  const sameName = await sameNameResponse.json() as { nodes: Array<{ id: string }> };
  expect(sameName.nodes.map(node => node.id)).toEqual(duplicateIds);

  await page.reload();
  await authorizeAuthor("desktop", page, { continueCurrentPage: true });
  await openResearchInspector(page);
  await expect(page.locator(".pg-knowledge-list li")).toHaveCount(50);
  await expect(page.getByRole("button", { name: "続きのKnowledgeを読み込む" })).toBeVisible();
  await page.getByRole("button", { name: "続きのKnowledgeを読み込む" }).click();
  await expect(page.getByRole("status").filter({ hasText: "100件取得済み" })).toBeVisible();
  await expect(page.locator(".pg-knowledge-list")).toContainText("Browse 0050");

  const search = page.getByLabel("名前または別名で検索");
  let releaseContinuation!: () => void;
  let continuationStarted!: () => void;
  const continuationGate = new Promise<void>(resolve => { releaseContinuation = resolve; });
  const started = new Promise<void>(resolve => { continuationStarted = resolve; });
  const nodeRoute = new RegExp(`/api/v1/persistence/projects/${fixture.project.id}/nodes\\?`);
  const holdContinuation = async (route: import("@playwright/test").Route) => {
    const requestedUrl = new URL(route.request().url());
    if (requestedUrl.searchParams.has("cursor") && requestedUrl.searchParams.get("q") === "") {
      const response = await route.fetch();
      continuationStarted();
      await continuationGate;
      await route.fulfill({ response });
    } else await route.continue();
  };
  await page.route(nodeRoute, holdContinuation);
  await page.getByRole("button", { name: "続きのKnowledgeを読み込む" }).click();
  await started;
  await search.fill("Browse 0100");
  await expect(page.locator(".pg-knowledge-list li")).toHaveCount(1);
  releaseContinuation();
  await expect(page.locator(".pg-knowledge-list li")).toHaveCount(1);
  await expect(page.getByRole("button", { name: "続きのKnowledgeを読み込む" })).toHaveCount(0);
  await page.unroute(nodeRoute, holdContinuation);

  await search.fill("literal%_!alias");
  await expect(page.locator(".pg-knowledge-list li")).toHaveCount(1);
  await expect(page.locator(".pg-knowledge-list")).toContainText(longJapaneseName);
  await expect(page.getByText("すべての絞り込み結果を取得済み（1件）。")).toBeVisible();

  await search.fill("not present in this project");
  await expect(page.getByText("該当するKnowledgeはありません。", { exact: true })).toBeVisible();
  const failBrowse = async (route: import("@playwright/test").Route) => {
    if (new URL(route.request().url()).searchParams.get("q") === "unavailable") await route.fulfill({ status: 503, body: "unavailable" });
    else await route.continue();
  };
  await page.route(nodeRoute, failBrowse);
  await search.fill("unavailable");
  await expect(page.getByRole("alert")).toContainText("Knowledge一覧を読み込めませんでした");
  await expect(page.locator(".pg-knowledge p[role=status]")).toContainText("Knowledgeの取得に失敗しました");
  await page.unroute(nodeRoute, failBrowse);

  await search.fill("");
  await expect(page.locator(".pg-knowledge-list li")).toHaveCount(50);
  const selectedNode = page.locator(".pg-knowledge-list li").filter({ hasText: "Browse 0000" }).getByRole("button").first();
  await selectedNode.click();
  const detail = page.getByRole("region", { name: "Knowledge詳細" });
  const relationDisclosure = detail.locator("details").filter({ hasText: "関係を追加" });
  await relationDisclosure.locator("summary").click();
  const targetSelect = relationDisclosure.locator("select");
  const targetNodeId = ids[1]!;
  await targetSelect.selectOption(targetNodeId);
  await search.fill("Browse 0000");
  await expect(targetSelect).toHaveValue(targetNodeId);
  await expect(targetSelect.locator(`option[value="${targetNodeId}"]`)).toContainText("選択中");
  await search.fill("");
  await expect(page.locator(".pg-knowledge-list li")).toHaveCount(50);
  const textAnchorTarget = page.locator("#pg-knowledge-target");
  await textAnchorTarget.selectOption(ids[2]!);
  await search.fill("Browse 0000");
  await expect(page.locator(".pg-knowledge-list li")).toHaveCount(1);
  await expect(textAnchorTarget).toHaveValue(ids[2]!);
  await expect(textAnchorTarget.locator(`option[value="${ids[2]}"]`)).toContainText("選択中");

  const retryQuery = "Browse 0001";
  const canonicalPage = await fixture.author.fetch(url(retryQuery));
  expect(canonicalPage.ok()).toBe(true);
  const { nodes: unpagedNodes } = await canonicalPage.json() as { nodes: unknown[] };
  expect(unpagedNodes).toHaveLength(1);

  const browseLimits: Array<string | null> = [];
  const unpagedResponse = async (route: import("@playwright/test").Route) => {
    const request = new URL(route.request().url());
    browseLimits.push(request.searchParams.get("limit"));
    await route.fulfill({ json: { nodes: unpagedNodes } });
  };
  await page.route(nodeRoute, unpagedResponse);
  await search.fill(retryQuery);
  const browseError = page.locator(".pg-knowledge").getByRole("alert").filter({ hasText: "Knowledge一覧を読み込めませんでした" });
  await expect(browseError).toBeVisible();
  await expect(page.locator(".pg-knowledge p[role=status]")).toContainText("Knowledgeの取得に失敗しました");
  await expect(page.locator(".pg-knowledge-list")).not.toContainText(retryQuery);
  expect(browseLimits).toEqual(["50"]);
  await page.unroute(nodeRoute, unpagedResponse);

  const retryResponse = page.waitForResponse((response) => {
    const request = new URL(response.url());
    return nodeRoute.test(response.url()) && request.searchParams.get("q") === retryQuery && request.searchParams.get("limit") === "50";
  });
  await browseError.getByRole("button", { name: "再試行" }).click();
  expect((await retryResponse).ok()).toBe(true);
  await expect(browseError).toHaveCount(0);
  await expect(page.locator(".pg-knowledge-list li")).toHaveCount(1);
  await expect(page.locator(".pg-knowledge-list")).toContainText(retryQuery);
  await expect(page.getByText("すべての絞り込み結果を取得済み（1件）。", { exact: true })).toBeVisible();
  await search.fill("");
  await expect(page.locator(".pg-knowledge-list li")).toHaveCount(50);
  await expect(page.getByLabel("種類で絞り込み").locator("option[value='my_custom_type']")).toBeAttached();

  // A mutation from a later page must restart the active filtered browse from
  // page one without injecting the now nonmatching node into the result set.
  const statusFilter = page.getByLabel("状態で絞り込み");
  await statusFilter.selectOption("proposed");
  await expect(page.locator(".pg-knowledge-list li")).toHaveCount(50);
  for (const expectedCount of [100, 150]) {
    await page.getByRole("button", { name: "続きのKnowledgeを読み込む" }).click();
    await expect(page.locator(".pg-knowledge-list li")).toHaveCount(expectedCount);
  }
  const mutationTarget = page.locator(".pg-knowledge-list li").filter({ hasText: "Browse 0200" });
  await expect(mutationTarget).toHaveCount(1);
  await mutationTarget.getByRole("button").first().click();
  const anchorTarget = page.locator("#pg-knowledge-target");
  const selectedId = await anchorTarget.inputValue();
  expect(selectedId).toBeTruthy();
  await mutationTarget.getByRole("button", { name: "内容を確認して確定" }).click();
  await expect(page.locator(".pg-knowledge-list li")).toHaveCount(50);
  await expect(mutationTarget).toHaveCount(0);
  await expect(page.getByRole("button", { name: "続きのKnowledgeを読み込む" })).toBeVisible();
  await expect(anchorTarget).toHaveValue(selectedId);
  await expect(anchorTarget.locator(`option[value="${selectedId}"]`)).toContainText("選択中");

  await page.setViewportSize({ width: 390, height: 844 });
  await statusFilter.selectOption("");
  await expect(page.locator(".pg-knowledge")).toBeVisible();
  await search.fill("literal%_!alias");
  await expect(page.locator(".pg-knowledge-list li")).toHaveCount(1);
  await expect(page.locator(".pg-knowledge-list")).toContainText(longJapaneseName);
  await search.fill("");
  await expect(page.locator(".pg-knowledge-list li")).toHaveCount(50);
  await page.getByRole("button", { name: "続きのKnowledgeを読み込む" }).click();
  await expect(page.getByRole("status").filter({ hasText: "100件取得済み" })).toBeVisible();
});

preparedAuthorTest("a committed delete response for B preserves edited C, its selection, route, and recovery status", async ({ page, authorizeAuthor }) => {
  expect(databaseUrl, "the browser acceptance server must use a disposable PostgreSQL database").toBeTruthy();
  const a = await createOAuthWritingFixture(authorizeAuthor, page, "desktop", `Delete response A ${crypto.randomUUID()}`, "A manuscript.");
  const c = await createAdditionalScene(a.author.fetch, a.project.id, "Scene C", "c", "C manuscript.");
  await page.reload();
  await authorizeAuthor("desktop", page, { continueCurrentPage: true });
  await openManuscriptScene(page, c);
  await openManuscriptScene(page, a.second);

  const heldDelete = await holdNextDocumentDelete(page, a.project.id, a.second.id);
  try {
    page.once("dialog", (dialog) => dialog.accept());
    await page.getByText("選択文書の構成を変更", { exact: true }).click();
    await page.getByRole("button", { name: "文書を削除" }).click();
    expect(await heldDelete.committed).toBe(200);

    const committedDocuments = await readProjectDocuments(a.author.fetch, a.project.id);
    expect(committedDocuments.some((document) => document.id === a.second.id)).toBe(false);

    await openManuscriptScene(page, c);
    await failPersistenceDraftWrites(page);
    const editor = manuscriptEditor(page);
    const added = "追加入力C";
    await editor.focus();
    await editor.press("Control+End");
    await editor.pressSequentially(added);
    await expect(page.locator(".pg-editor").getByRole("alert")).toContainText(/Browser storage is full|quota|容量|回復|journal/i);
    const expectedMarkdown = `C manuscript.${added}`;
    await expect(editor).toContainText(added);
    expect(await readManuscriptMarkdown(page)).toBe(expectedMarkdown);
    await editor.press("Shift+ArrowLeft");
    const selectionBefore = await editor.evaluate(() => window.getSelection()?.toString() ?? "");
    expect(selectionBefore).toBe("C");
    const routeBefore = new URL(page.url()).pathname;
    expect(routeBefore).toContain(`/projects/${a.project.id}/scenes/${c.id}`);
    await expect(page.locator(`.pg-outline-item[data-document-id="${c.id}"] > .pg-outline-row > .pg-outline-document`)).toHaveAttribute("aria-current", "page");

    heldDelete.release();

    await expect(page.getByRole("heading", { name: c.title, exact: true })).toBeVisible();
    await expect(page.locator(`.pg-outline-item[data-document-id="${a.second.id}"]`)).toHaveCount(0);
    await expect.soft(page.locator(`.pg-outline-item[data-document-id="${c.id}"] > .pg-outline-row > .pg-outline-document`)).toHaveAttribute("aria-current", "page");
    expect.soft(new URL(page.url()).pathname).toBe(routeBefore);
    expect.soft(await readManuscriptMarkdown(page)).toBe(expectedMarkdown);
    expect.soft(await editor.evaluate(() => window.getSelection()?.toString() ?? "")).toBe(selectionBefore);
    const protection = await openProtectionDetails(page);
    await expect.soft(protection.locator("summary")).toHaveText("この入力はまだ保護されていません");
    await expect.soft(protection).toContainText("現在の編集の回復記録を確認できません");
    expect.soft((await storedDocumentMarkdown(a.author.fetch, a.project.id, c.id)).markdown).toBe("C manuscript.");
  } finally {
    heldDelete.release();
    await heldDelete.remove();
  }
});

preparedAuthorTest("a delayed import keeps unprotected intervening input available and lists the committed work", async ({ page, authorizeAuthor }) => {
  expect(databaseUrl, "the browser acceptance server must use a disposable PostgreSQL database").toBeTruthy();
  const fixture = await createOAuthWritingFixture(authorizeAuthor, page, "desktop", `Import quota ${crypto.randomUUID()}`, "Source manuscript.");
  const archiveResponse = await fixture.author.fetch(`/api/v1/persistence/projects/${fixture.project.id}/archive`);
  expect(archiveResponse.ok(), await archiveResponse.text()).toBe(true);
  const archive = await archiveResponse.json();
  const heldImport = await holdNextWorkImport(page);
  try {
    await page.locator("details").filter({ has: page.locator("summary", { hasText: "作品のエクスポート・インポート" }) })
      .locator('input[type="file"]').setInputFiles({ name: "portable-work.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(archive)) });
    expect(await heldImport.committed).toBe(201);

    await setPersistenceDraftWritesFailing(page, true);
    const editor = manuscriptEditor(page);
    await editor.focus();
    await editor.press("Control+End");
    await editor.pressSequentially("追加入力");
    const expectedMarkdown = "Source manuscript.追加入力";
    await expect(editor).toContainText("追加入力");
    await expect(page.locator(".pg-editor").getByRole("alert")).toContainText(/Browser storage is full|quota|容量|回復|journal/i);
    heldImport.release();

    await expect(page.getByRole("heading", { name: fixture.scene.title, exact: true })).toBeVisible();
    await expect(editor).toHaveText(expectedMarkdown);
    expect(new URL(page.url()).pathname).toContain(`/projects/${fixture.project.id}/scenes/${fixture.scene.id}`);
    const transfer = page.locator("details").filter({ has: page.locator("summary", { hasText: "作品のエクスポート・インポート" }) });
    await transfer.locator("summary").click();
    await expect(transfer.getByRole("status").filter({ hasText: "元の原稿を保持しました" })).toBeVisible();

    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    await editor.press("Control+A");
    await editor.press("Control+C");
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(expectedMarkdown);

    await setPersistenceDraftWritesFailing(page, false);
    await editor.press("End");
    await editor.press("!");
    await editor.press("Backspace");
    await expectDeviceDraft(page);
    await page.getByRole("button", { name: /今すぐ保存|PostgreSQLへ再試行/ }).click();
    await expectServerSaved(page);
    expect((await storedDocumentMarkdown(fixture.author.fetch, fixture.project.id, fixture.scene.id)).markdown).toBe(expectedMarkdown);

    const projects = await fixture.author.fetch("/api/v1/persistence/projects?limit=100");
    expect(projects.ok()).toBe(true);
    const importedId = heldImport.projectId;
    expect(importedId).toBeTruthy();
    const { projects: listedProjects } = await projects.json() as { projects: Array<{ id: string }> };
    expect(listedProjects.some((item) => item.id === importedId)).toBe(true);
    await page.getByLabel("作品", { exact: true }).selectOption(importedId);
    const importedDocuments = await readProjectDocuments(fixture.author.fetch, importedId);
    await openManuscriptScene(page, importedDocuments.find((item) => item.title === fixture.scene.title)!);
  } finally {
    heldImport.release();
    await heldImport.remove();
  }
});

preparedAuthorTest("a delayed import protects intervening input before the normal transition", async ({ page, authorizeAuthor }) => {
  expect(databaseUrl, "the browser acceptance server must use a disposable PostgreSQL database").toBeTruthy();
  const fixture = await createOAuthWritingFixture(authorizeAuthor, page, "desktop", `Import protected ${crypto.randomUUID()}`, "Source manuscript.");
  const archiveResponse = await fixture.author.fetch(`/api/v1/persistence/projects/${fixture.project.id}/archive`);
  expect(archiveResponse.ok(), await archiveResponse.text()).toBe(true);
  const archive = await archiveResponse.json();
  const heldImport = await holdNextWorkImport(page);
  try {
    await page.locator("details").filter({ has: page.locator("summary", { hasText: "作品のエクスポート・インポート" }) })
      .locator('input[type="file"]').setInputFiles({ name: "portable-work.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(archive)) });
    expect(await heldImport.committed).toBe(201);
    const expectedMarkdown = "Source manuscript.保護される追加入力";
    const editor = manuscriptEditor(page);
    await editor.focus();
    await editor.press("Control+End");
    await editor.pressSequentially("保護される追加入力");
    await expectDeviceDraft(page);
    expect((await readPersistenceDrafts(page)).some((draft) => draft.documentId === fixture.scene.id && draft.markdown === expectedMarkdown)).toBe(true);
    heldImport.release();
    const transfer = page.locator("details").filter({ has: page.locator("summary", { hasText: "作品のエクスポート・インポート" }) });
    await transfer.locator("summary").click();
    await expect(transfer.getByRole("status").filter({ hasText: "新しい作品としてJSONを取り込みました。" })).toBeVisible();
    expect(new URL(page.url()).pathname).not.toContain(`/projects/${fixture.project.id}/`);
    expect((await readPersistenceDrafts(page)).some((draft) => draft.documentId === fixture.scene.id && draft.markdown === expectedMarkdown)).toBe(true);
  } finally {
    heldImport.release();
    await heldImport.remove();
  }
});

preparedAuthorTest("deleting the still-selected document safely selects the first remaining scene", async ({ page, authorizeAuthor }) => {
  expect(databaseUrl, "the browser acceptance server must use a disposable PostgreSQL database").toBeTruthy();
  const a = await createOAuthWritingFixture(authorizeAuthor, page, "desktop", `Delete transition A ${crypto.randomUUID()}`, "A manuscript.");
  await openManuscriptScene(page, a.second);
  const heldDelete = await holdNextDocumentDelete(page, a.project.id, a.second.id);
  try {
    page.once("dialog", (dialog) => dialog.accept());
    await page.getByText("選択文書の構成を変更", { exact: true }).click();
    await page.getByRole("button", { name: "文書を削除" }).click();
    expect(await heldDelete.committed).toBe(200);
    heldDelete.release();

    await expect(page.getByRole("heading", { name: a.scene.title, exact: true })).toBeVisible();
    await expect(page.locator(`.pg-outline-item[data-document-id="${a.scene.id}"] > .pg-outline-row > .pg-outline-document`)).toHaveAttribute("aria-current", "page");
    await expect(page.locator(`.pg-outline-item[data-document-id="${a.second.id}"]`)).toHaveCount(0);
    expect(new URL(page.url()).pathname).toContain(`/projects/${a.project.id}/scenes/${a.scene.id}`);
    expect(await readManuscriptMarkdown(page)).toBe("A manuscript.");
    expect((await readProjectDocuments(a.author.fetch, a.project.id)).some((document) => document.id === a.second.id)).toBe(false);
  } finally {
    heldDelete.release();
    await heldDelete.remove();
  }
});

preparedAuthorTest("input added to B while deletion is pending stays visible when IndexedDB protection fails", async ({ page, authorizeAuthor }) => {
  expect(databaseUrl, "the browser acceptance server must use a disposable PostgreSQL database").toBeTruthy();
  const fixture = await createOAuthWritingFixture(authorizeAuthor, page, "desktop", `Delete pending input ${crypto.randomUUID()}`, "A manuscript.");
  await openManuscriptScene(page, fixture.second);
  const heldDelete = await holdNextDocumentDelete(page, fixture.project.id, fixture.second.id);
  try {
    page.once("dialog", (dialog) => dialog.accept());
    await page.getByText("選択文書の構成を変更", { exact: true }).click();
    await page.getByRole("button", { name: "文書を削除" }).click();
    expect(await heldDelete.committed).toBe(200);

    await failPersistenceDraftWrites(page);
    const editor = manuscriptEditor(page);
    await editor.focus();
    await editor.press("Control+End");
    await editor.pressSequentially("追加入力B");
    await expect(page.locator(".pg-editor").getByRole("alert")).toContainText(/Browser storage is full|quota|容量|回復|journal/i);
    const expectedMarkdown = "最初の本文。\n次の文章です。追加入力B";
    expect(await readManuscriptMarkdown(page)).toBe(expectedMarkdown);

    heldDelete.release();

    await expect(page.getByRole("heading", { name: fixture.second.title, exact: true })).toBeVisible();
    expect.soft(new URL(page.url()).pathname).toContain(`/projects/${fixture.project.id}/scenes/${fixture.second.id}`);
    expect.soft(await readManuscriptMarkdown(page)).toBe(expectedMarkdown);
    const protection = await openProtectionDetails(page);
    await expect.soft(protection.locator("summary")).toHaveText("この入力はまだ保護されていません");
    await expect.soft(protection).toContainText("現在の編集の回復記録を確認できません");
    expect.soft((await readProjectDocuments(fixture.author.fetch, fixture.project.id)).some((document) => document.id === fixture.second.id)).toBe(false);
  } finally {
    heldDelete.release();
    await heldDelete.remove();
  }
});

preparedAuthorTest("input added to B while deletion is pending is protected before the safe transition", async ({ page, authorizeAuthor }) => {
  expect(databaseUrl, "the browser acceptance server must use a disposable PostgreSQL database").toBeTruthy();
  const fixture = await createOAuthWritingFixture(authorizeAuthor, page, "desktop", `Delete protected pending input ${crypto.randomUUID()}`, "A manuscript.");
  await openManuscriptScene(page, fixture.second);
  const heldDelete = await holdNextDocumentDelete(page, fixture.project.id, fixture.second.id);
  try {
    page.once("dialog", (dialog) => dialog.accept());
    await page.getByText("選択文書の構成を変更", { exact: true }).click();
    await page.getByRole("button", { name: "文書を削除" }).click();
    expect(await heldDelete.committed).toBe(200);

    const editor = manuscriptEditor(page);
    await editor.focus();
    await editor.press("Control+End");
    await editor.pressSequentially("追加入力B");
    const expectedMarkdown = "最初の本文。\n次の文章です。追加入力B";
    await expect(editor).toContainText("追加入力B");
    await expectDeviceDraft(page);
    expect((await readPersistenceDrafts(page)).some((draft) => draft.documentId === fixture.second.id && draft.markdown === expectedMarkdown)).toBe(true);

    heldDelete.release();

    await expect(page.getByRole("heading", { name: fixture.scene.title, exact: true })).toBeVisible();
    await expect(page.locator(`.pg-outline-item[data-document-id="${fixture.second.id}"]`)).toHaveCount(0);
    await expect(page.locator(`.pg-outline-item[data-document-id="${fixture.scene.id}"] > .pg-outline-row > .pg-outline-document`)).toHaveAttribute("aria-current", "page");
    expect(new URL(page.url()).pathname).toContain(`/projects/${fixture.project.id}/scenes/${fixture.scene.id}`);
    expect(await readManuscriptMarkdown(page)).toBe("A manuscript.");
    expect((await readPersistenceDrafts(page)).some((draft) => draft.documentId === fixture.second.id && draft.markdown === expectedMarkdown)).toBe(true);
    expect((await readProjectDocuments(fixture.author.fetch, fixture.project.id)).some((document) => document.id === fixture.second.id)).toBe(false);
  } finally {
    heldDelete.release();
    await heldDelete.remove();
  }
});

preparedAuthorTest("a failed outline refresh after committed deletion keeps the selected editor and route", async ({ page, authorizeAuthor }) => {
  expect(databaseUrl, "the browser acceptance server must use a disposable PostgreSQL database").toBeTruthy();
  const fixture = await createOAuthWritingFixture(authorizeAuthor, page, "desktop", `Delete outline failure ${crypto.randomUUID()}`, "A manuscript.");
  await openManuscriptScene(page, fixture.second);
  const heldDelete = await holdNextDocumentDelete(page, fixture.project.id, fixture.second.id);
  const outlinePath = `/api/v1/persistence/projects/${fixture.project.id}/documents`;
  const isOutlineRoute = (url: URL): boolean => url.pathname === outlinePath;
  const failOutlineRefresh = async (route: import("@playwright/test").Route): Promise<void> => {
    const url = new URL(route.request().url());
    if (route.request().method() === "GET" && url.searchParams.get("limit") === "1000") {
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "temporary outline failure" }) });
    } else await route.continue();
  };
  try {
    page.once("dialog", (dialog) => dialog.accept());
    await page.getByText("選択文書の構成を変更", { exact: true }).click();
    await page.getByRole("button", { name: "文書を削除" }).click();
    expect(await heldDelete.committed).toBe(200);
    await page.route(isOutlineRoute, failOutlineRefresh);
    heldDelete.release();

    await expect(page.locator(".pg-alert").filter({ hasText: "目次を再取得できませんでした" })).toBeVisible();
    await expect.soft(page.getByRole("heading", { name: fixture.second.title, exact: true })).toBeVisible();
    expect.soft(new URL(page.url()).pathname).toContain(`/projects/${fixture.project.id}/scenes/${fixture.second.id}`);
    const editorCount = await manuscriptEditor(page).count();
    expect.soft(editorCount).toBe(1);
    if (editorCount === 1) expect.soft(await readManuscriptMarkdown(page)).toBe("最初の本文。\n次の文章です。");
    expect.soft((await readProjectDocuments(fixture.author.fetch, fixture.project.id)).some((document) => document.id === fixture.second.id)).toBe(false);
  } finally {
    heldDelete.release();
    await heldDelete.remove();
    try { await page.unroute(isOutlineRoute, failOutlineRefresh); } catch { /* Browser teardown already removed the route. */ }
  }
});

preparedAuthorTest("an unknown delete response after PostgreSQL commit does not clear the selected manuscript", async ({ page, authorizeAuthor }) => {
  expect(databaseUrl, "the browser acceptance server must use a disposable PostgreSQL database").toBeTruthy();
  const fixture = await createOAuthWritingFixture(authorizeAuthor, page, "desktop", `Delete response unknown ${crypto.randomUUID()}`, "A manuscript.");
  await openManuscriptScene(page, fixture.second);
  const heldDelete = await holdNextDocumentDelete(page, fixture.project.id, fixture.second.id);
  try {
    page.once("dialog", (dialog) => dialog.accept());
    await page.getByText("選択文書の構成を変更", { exact: true }).click();
    await page.getByRole("button", { name: "文書を削除" }).click();
    expect(await heldDelete.committed).toBe(200);
    heldDelete.abort();

    await expect(page.getByRole("alert").filter({ hasText: "Failed to fetch" })).toBeVisible();
    await expect(page.getByRole("heading", { name: fixture.second.title, exact: true })).toBeVisible();
    expect(new URL(page.url()).pathname).toContain(`/projects/${fixture.project.id}/scenes/${fixture.second.id}`);
    expect(await readManuscriptMarkdown(page)).toBe("最初の本文。\n次の文章です。");
    expect((await readProjectDocuments(fixture.author.fetch, fixture.project.id)).some((document) => document.id === fixture.second.id)).toBe(false);
  } finally {
    heldDelete.release();
    await heldDelete.remove();
  }
});

preparedAuthorTest("a Knowledge save error stays with the visible form across Desktop layouts", async ({ page, authorizeAuthor }) => {
  const { project } = await createOAuthWritingFixture(authorizeAuthor, page);
  const error = "Knowledge candidate temporarily unavailable";
  await page.route(url => url.pathname.startsWith(`/api/v1/persistence/projects/${project.id}/nodes/`), async route => {
    if (route.request().method() === "PUT") await route.fulfill({ status: 503, json: { error } });
    else await route.continue();
  });
  const alert = page.getByRole("alert").filter({ hasText: error });
  const submit = async () => {
    const name = page.getByLabel("Knowledge候補を追加");
    if (!await name.isVisible()) await page.locator(".pg-knowledge-tools > summary").click();
    await expect(name).toBeVisible();
    await name.fill("入力を保持する候補");
    await page.getByRole("button", { name: "候補を保存", exact: true }).click();
    await expect(alert).toHaveCount(1);
    await expect(alert).toBeVisible();
    await expect(page.getByLabel("Knowledge候補を追加")).toHaveValue("入力を保持する候補");
  };

  await openResearchInspector(page);
  const panelMenu = page.locator(".st-workspace-panel-menu > summary");
  await panelMenu.click();
  await page.getByRole("button", { name: "原稿を隠す", exact: true }).click();
  await expect(page.locator('[data-workspace-panel="editor"]')).toHaveCount(0);
  await panelMenu.click();
  await submit();
  await panelMenu.click();
  await page.getByRole("button", { name: "原稿を表示", exact: true }).click();
  await expect(page.locator('[data-workspace-panel="editor"]')).toBeVisible();
  await panelMenu.click();
  await expect(alert).toHaveCount(0);
  await page.getByRole("tab", { name: "知識と根拠", exact: true }).click();
  await expect(alert).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await submit();
});

preparedAuthorTest("Knowledge candidate retries reconcile uncertain creates without blocking deliberate same-name candidates", async ({ page, authorizeAuthor }) => {
  expect(databaseUrl, "the browser acceptance server must use a disposable PostgreSQL database").toBeTruthy();
  const fixture = await createOAuthWritingFixture(authorizeAuthor, page, "desktop", `Knowledge create retry ${crypto.randomUUID()}`);
  const persistence = createPostgresPersistence(databaseUrl!);
  const projectId = fixture.project.id as ProjectId;
  const readNodes = () => persistence.read(reader => reader.listKnowledgeNodes(projectId, 100));
  const existingIds = new Set((await readNodes()).map(node => node.id));
  const lostName = `応答だけ喪失 ${crypto.randomUUID()}`;
  const preCommitName = `確定前失敗 ${crypto.randomUUID()}`;
  const normalName = `正常作成 ${crypto.randomUUID()}`;
  const duplicateName = `同名別候補 ${crypto.randomUUID()}`;
  let loseResponseFor: string | null = null;
  let failBeforeCommitFor: string | null = null;
  let blockReconciliationFor: string | null = null;
  let lostId: string | null = null;
  let preCommitId: string | null = null;
  const lostReconciliationIds: string[] = [];
  const lostPutIds: string[] = [];
  const nodeRoute = new RegExp(`/api/v1/persistence/projects/${fixture.project.id}/nodes/[^/?]+$`);
  const interceptNodeSave = async (route: import("@playwright/test").Route) => {
    const request = route.request();
    const nodeId = new URL(request.url()).pathname.split("/").at(-1)!;
    if (request.method() === "GET" && nodeId === lostId) lostReconciliationIds.push(nodeId);
    if (request.method() === "GET" && blockReconciliationFor === nodeId) {
      blockReconciliationFor = null;
      await route.fulfill({ status: 503, json: { error: "temporary reconciliation failure" } });
      return;
    }
    if (request.method() !== "PUT") {
      await route.continue();
      return;
    }
    const body = request.postDataJSON() as { name: string };
    if (body.name === lostName) lostPutIds.push(nodeId);
    if (body.name === failBeforeCommitFor) {
      failBeforeCommitFor = null;
      preCommitId = nodeId;
      await route.fulfill({ status: 503, json: { error: "temporary save failure" } });
      return;
    }
    if (body.name === loseResponseFor) {
      loseResponseFor = null;
      lostId = nodeId;
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      blockReconciliationFor = nodeId;
      await route.abort();
      return;
    }
    await route.continue();
  };

  try {
    await page.route(nodeRoute, interceptNodeSave);
    await openResearchInspector(page);
    const name = page.getByLabel("Knowledge候補を追加");
    if (!await name.isVisible()) await page.locator(".pg-knowledge-tools > summary").click();
    const submit = page.locator(".pg-knowledge-tools form button[type=submit]");
    const save = async (value: string) => {
      await name.fill(value);
      await submit.click();
    };

    await save(normalName);
    await expect(page.locator(".pg-notice")).toContainText("Knowledge候補を保存しました");
    await expect(name).toHaveValue("");
    let nodes = await readNodes();
    expect(nodes).toHaveLength(existingIds.size + 1);
    expect(nodes.filter(node => node.name === normalName)).toMatchObject([{ type: "person", status: "proposed", attributes: {} }]);

    loseResponseFor = lostName;
    await save(lostName);
    await expect(page.getByRole("alert")).toContainText("結果を確認できません");
    await expect(name).toHaveValue(lostName);
    expect(lostId).toBeTruthy();
    nodes = await readNodes();
    expect(nodes).toHaveLength(existingIds.size + 2);
    expect(nodes.filter(node => node.name === lostName)).toMatchObject([{ id: lostId, type: "person", name: lostName, status: "proposed", attributes: {} }]);

    const lostReadsBeforeRetry = lostReconciliationIds.length;
    await submit.click();
    await expect(page.locator(".pg-notice")).toContainText("Knowledge候補を保存しました");
    await expect(name).toHaveValue("");
    expect(lostReconciliationIds.length).toBeGreaterThan(lostReadsBeforeRetry);
    expect(lostReconciliationIds.every(id => id === lostId)).toBe(true);
    expect(lostPutIds).toEqual([lostId]);
    nodes = await readNodes();
    expect(nodes).toHaveLength(existingIds.size + 2);
    expect(nodes.filter(node => node.name === lostName)).toMatchObject([{ id: lostId, type: "person", name: lostName, status: "proposed", attributes: {} }]);

    failBeforeCommitFor = preCommitName;
    await save(preCommitName);
    await expect(page.getByRole("alert")).toContainText("temporary save failure");
    await expect(name).toHaveValue(preCommitName);
    expect(preCommitId).toBeTruthy();
    nodes = await readNodes();
    expect(nodes).toHaveLength(existingIds.size + 2);
    expect(nodes.some(node => node.id === preCommitId)).toBe(false);

    await submit.click();
    await expect(page.locator(".pg-notice")).toContainText("Knowledge候補を保存しました");
    await expect(name).toHaveValue("");
    nodes = await readNodes();
    expect(nodes).toHaveLength(existingIds.size + 3);
    expect(nodes.filter(node => node.name === preCommitName)).toMatchObject([{ id: preCommitId, type: "person", name: preCommitName, status: "proposed", attributes: {} }]);

    await save(duplicateName);
    await expect(page.locator(".pg-notice")).toContainText("Knowledge候補を保存しました");
    await expect(name).toHaveValue("");
    await save(duplicateName);
    await expect(page.locator(".pg-notice")).toContainText("Knowledge候補を保存しました");
    await expect(name).toHaveValue("");
    nodes = await readNodes();
    const sameNameNodes = nodes.filter(node => node.name === duplicateName);
    expect(sameNameNodes).toHaveLength(2);
    expect(new Set(sameNameNodes.map(node => node.id)).size).toBe(2);
    expect(nodes).toHaveLength(existingIds.size + 5);
  } finally {
    await page.unroute(nodeRoute, interceptNodeSave);
    await persistence.close();
  }
});

preparedAuthorTest("PostgreSQL project pages expose records beyond 200 and deep links retain the requested identity", async ({ page, authorizeAuthor }) => {
  test.setTimeout(120_000);
  expect(databaseUrl, "the browser acceptance server must use a disposable PostgreSQL database").toBeTruthy();
  const author = await authorizeAuthor("desktop");
  const origin = new URL(page.url()).origin;
  // Seed more than two complete pages so a small, intentionally preloaded
  // disposable database cannot shrink the second page to a short tail.
  const projects = Array.from({ length: 405 }, (_, index) => ({ title: `Project pagination ${crypto.randomUUID()} ${index}` }));
  const created: Array<{ id: string; title: string }> = [];
  for (let offset = 0; offset < projects.length; offset += 10) {
    const batch = await Promise.all(projects.slice(offset, offset + 10).map(async (project) => {
      const response = await author.fetch(new URL("/api/v1/persistence/projects", origin).toString(), { method: "POST", headers: { Origin: origin }, data: project });
      expect(response.status()).toBe(201);
      return (await response.json() as { project: { id: string; title: string } }).project;
    }));
    created.push(...batch);
  }

  let pageRequests = 0;
  await page.route((url) => url.pathname === "/api/v1/persistence/projects", async (route) => {
    if (route.request().method() === "GET") pageRequests++;
    await route.continue();
  });
  const target = created[0]!;
  await authorizeAuthor("desktop", page, { path: `/desktop/projects/${target.id}` });
  await expect(page.getByRole("heading", { name: "Database workspace" })).toBeVisible();
  await expect(page.getByRole("heading", { name: target.title, exact: true })).toBeVisible();
  await expect(page.getByLabel("作品", { exact: true })).toHaveValue(target.id);
  expect(pageRequests, "a direct project link must request its target without enumerating the project library").toBe(0);

  const library = page.getByLabel("作品と文書");
  const firstPageResponse = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return response.request().method() === "GET" && url.pathname === "/api/v1/persistence/projects" && !url.searchParams.has("cursor");
  });
  await library.getByRole("button", { name: "作品一覧を読み込む" }).click();
  const firstPage = await (await firstPageResponse).json() as { projects: Array<{ id: string }>; nextCursor: string | null };
  expect(firstPage.projects).toHaveLength(200);
  expect(firstPage.nextCursor).toBeTruthy();
  await expect(library.getByRole("button", { name: "さらに作品を読み込む" })).toBeVisible();
  const secondPageResponse = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return response.request().method() === "GET" && url.pathname === "/api/v1/persistence/projects" && url.searchParams.has("cursor");
  });
  await library.getByRole("button", { name: "さらに作品を読み込む" }).click();
  const secondPage = await (await secondPageResponse).json() as { projects: Array<{ id: string }>; nextCursor: string | null };
  expect(secondPage.projects).toHaveLength(200);
  expect(secondPage.projects.some((item) => !firstPage.projects.some((first) => first.id === item.id))).toBe(true);
  await expect(page.getByLabel("作品", { exact: true }).locator(`option[value="${target.id}"]`)).toBeAttached();
  await expect(page.getByText(/読み込み済みの作品: 40[0-1]/u)).toBeVisible();
  expect(pageRequests).toBe(2);

  const missingId = crypto.randomUUID();
  await authorizeAuthor("desktop", page, { path: `/desktop/projects/${missingId}` });
  const editorAlert = page.locator(".pg-editor-column").getByRole("alert");
  await expect(editorAlert).toContainText(missingId);
  await expect(editorAlert).toHaveCount(1);
  await expect(page.getByRole("alert")).toHaveCount(1);
  await expect(page.getByLabel("作品", { exact: true })).toHaveValue(missingId);
  expect(pageRequests, "an unavailable direct link must not silently fall back to library enumeration").toBe(2);

});

preparedAuthorTest("outline supports guarded keyboard navigation, search, zoom and narrow Desktop sizing", async ({ page, authorizeAuthor }) => {
  expect(databaseUrl).toBeTruthy();
  const fixture = await createOAuthWritingFixture(authorizeAuthor, page, "desktop", `Outline ${crypto.randomUUID()}`);
  const headers = { Origin: new URL(page.url()).origin };
  const create = async (parentId: string | undefined, kind: string, title: string, orderKey: string) => {
    const response = await fixture.author.fetch(`/api/v1/persistence/projects/${fixture.project.id}/documents`, { method: "POST", headers: { ...headers, "Idempotency-Key": crypto.randomUUID() }, data: { ...(parentId ? { parentId } : {}), kind, title, orderKey, markdown: "" } });
    expect(response.status()).toBe(201);
    return (await response.json() as { document: { id: string; title: string } }).document;
  };
  const volume = await create(undefined, "volume", "Volume One", "0");
  const chapter = await create(volume.id, "chapter", "Chapter One", "0");
  const nestedScene = await create(chapter.id, "scene", `Outline scene ${crypto.randomUUID()}`, "0");
  await authorizeAuthor("desktop", page, { path: `/desktop/projects/${fixture.project.id}/scenes/${nestedScene.id}` });
  const outline = page.locator('[data-workspace-panel="outline"]');
  const rows = outline.locator(".pg-outline-document");
  await rows.first().focus();
  await rows.first().press("ArrowDown");
  await expect(rows.nth(1)).toBeFocused();
  await rows.nth(1).press("Home");
  await expect(rows.first()).toBeFocused();
  const leaf = outline.getByRole("treeitem", { name: `${nestedScene.title} シーン` });
  await leaf.focus();
  await leaf.press("ArrowRight");
  await expect(leaf).toBeFocused();
  await outline.getByLabel("構成を検索").fill(nestedScene.title);
  await expect(outline.locator(".pg-outline-document")).toHaveCount(3);
  await expect(leaf).toBeVisible();
  const chapterRow = outline.locator(".pg-outline-document").filter({ hasText: "Chapter One" });
  await chapterRow.focus();
  await chapterRow.press("Tab");
  await expect(outline.getByRole("button", { name: "Chapter Oneを拡大" })).toBeFocused();
  await outline.getByRole("button", { name: "Chapter Oneを拡大" }).press("Enter");
  await expect(outline.getByRole("navigation", { name: "構成の階層" })).toContainText("Chapter One");
  await outline.getByLabel("構成を検索").fill("no matching outline item");
  await expect(outline.locator(".pg-outline-document")).toHaveCount(0);
  await page.setViewportSize({ width: 320, height: 900 });
  await authorizeAuthor("desktop", page, { path: `/desktop/projects/${fixture.project.id}/scenes/${nestedScene.id}` });
  await expect(page.getByRole("heading", { name: nestedScene.title, exact: true })).toBeVisible();
  await expect(page.locator(".pg-outline-document").first()).toBeVisible();
  await page.evaluate(() => { document.body.style.zoom = "200%"; });
  await expect(page.locator(".pg-outline-document").first()).toBeVisible();
});

preparedAuthorTest("Headless Tree reparent drag moves an unselected document through the canonical API", async ({ page, authorizeAuthor }) => {
  expect(databaseUrl).toBeTruthy();
  const { project, scene, second, author } = await createOAuthWritingFixture(authorizeAuthor, page, "desktop", `Headless DnD ${crypto.randomUUID()}`);
  const outline = page.locator('[data-workspace-panel="outline"]');
  const source = outline.locator(`.pg-outline-item[data-document-id="${second.id}"] > .pg-outline-row > .pg-outline-drag`);
  const target = outline.locator(`.pg-outline-item[data-document-id="${scene.id}"] > .pg-outline-row > .pg-outline-document`);
  await expect(source).toBeVisible();
  await source.dragTo(target);
  await expect.poll(async () => {
    const response = await author.fetch(`/api/v1/persistence/projects/${project.id}/documents/${second.id}`);
    return response.ok() ? ((await response.json()) as { document: { parentId: string | null } }).document.parentId : null;
  }).toBe(scene.id);
  await expect(outline.locator(`.pg-outline-item[data-document-id="${scene.id}"] .pg-outline-item[data-document-id="${second.id}"]`)).toBeVisible();
  await expect(target).toHaveAttribute("aria-current", "page");
});

preparedAuthorTest("Headless Tree renames an unselected document without replacing the active manuscript", async ({ page, authorizeAuthor }) => {
  expect(databaseUrl).toBeTruthy();
  const { project, scene, second, author } = await createOAuthWritingFixture(authorizeAuthor, page, "desktop", `Headless rename ${crypto.randomUUID()}`);
  const outline = page.locator('[data-workspace-panel="outline"]');
  await expect(outline.getByRole("tree", { name: "作品の構成" })).toBeVisible();
  const row = outline.locator(`.pg-outline-item[data-document-id="${second.id}"] > .pg-outline-row`);
  const item = row.getByRole("treeitem", { name: new RegExp(second.title, "u") });
  await item.focus();
  await item.press("F2");
  const editor = row.getByRole("textbox", { name: `${second.title}の名前を変更` });
  await expect(editor).toBeVisible();
  const title = "アウトライン名称変更";
  await editor.fill(title);
  await editor.press("Enter");
  await expect.poll(async () => {
    const response = await author.fetch(`/api/v1/persistence/projects/${project.id}/documents/${second.id}`);
    return response.ok() ? ((await response.json()) as { document: { title: string } }).document.title : "";
  }).toBe(title);
  await expect(row.getByRole("treeitem", { name: new RegExp(title, "u") })).toBeVisible();
  await expect(page.getByRole("heading", { name: scene.title, exact: true })).toBeVisible();
  await expect(outline.locator(`.pg-outline-item[data-document-id="${scene.id}"] .pg-outline-document`)).toHaveAttribute("aria-current", "page");
});

async function moveEditorIntoDesktopStack(page: Page): Promise<void> {
  await page.getByRole("toolbar", { name: "ワークスペース配置" }).getByRole("button", { name: "調査", exact: true }).click();
  const menu = page.locator(".st-workspace-move-menu");
  if (!await menu.evaluate((element) => (element as HTMLDetailsElement).open)) await menu.locator("summary").click();
  const controls = menu.locator(".st-workspace-move-controls");
  await controls.locator("select").nth(0).selectOption("editor");
  await controls.locator("select").nth(1).selectOption("outline");
  await controls.locator("select").nth(2).selectOption("tab");
  await controls.getByRole("button", { name: "パネルを移動" }).click();
  await expect(page.getByRole("tablist", { name: "パネル" }).getByRole("tab", { name: "原稿", exact: true })).toBeVisible();
}

async function holdNextDocumentSave(page: Page, projectId: string, documentId: string) {
  let release!: () => void;
  let reached!: () => void;
  let captureBody!: (body: unknown) => void;
  let closing = false;
  let requestBodySettled = false;
  const released = new Promise<void>((resolve) => { release = resolve; });
  const requestReached = new Promise<void>((resolve) => { reached = resolve; });
  const requestBody = new Promise<unknown>((resolve) => { captureBody = resolve; });
  const url = new URL(`/api/v1/persistence/projects/${projectId}/documents/${documentId}`, page.url()).toString();
  const handler = async (route: import("@playwright/test").Route): Promise<void> => {
    if (route.request().method() !== "PATCH") { await route.continue(); return; }
    const body = route.request().postDataJSON();
    if (requestBodySettled) { await route.continue(); return; }
    requestBodySettled = true;
    reached();
    captureBody(body);
    await released;
    if (!closing) await route.continue();
  };
  await page.route(url, handler);
  return {
    requestReached,
    requestBody,
    release,
    async remove() {
      closing = true;
      if (!page.isClosed()) {
        try { await page.unroute(url, handler); } catch { /* Browser teardown already removed the route. */ }
      }
    },
  };
}

async function createAdditionalScene(fetch: AuthorApiFetch, projectId: string, title: string, orderKey: string, markdown: string): Promise<{ id: string; title: string }> {
  const response = await fetch(`/api/v1/persistence/projects/${projectId}/documents`, {
    method: "POST", headers: { "Idempotency-Key": crypto.randomUUID() },
    data: { kind: "scene", title, orderKey, markdown },
  });
  expect(response.status(), await response.text()).toBe(201);
  return (await response.json() as { document: { id: string; title: string } }).document;
}

async function readProjectDocuments(fetch: AuthorApiFetch, projectId: string): Promise<Array<{ id: string; title: string }>> {
  const response = await fetch(`/api/v1/persistence/projects/${projectId}/documents`);
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json() as { documents: Array<{ id: string; title: string }> }).documents;
}

async function failPersistenceDraftWrites(page: Page): Promise<void> {
  await page.evaluate(() => {
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
      if (this.name === "persistenceDrafts") throw new DOMException("Acceptance quota failure", "QuotaExceededError");
      return key === undefined ? put.call(this, value) : put.call(this, value, key);
    };
  });
}

async function setPersistenceDraftWritesFailing(page: Page, fail: boolean): Promise<void> {
  await page.evaluate((shouldFail) => {
    const state = window as Window & { __acceptanceDraftPut?: typeof IDBObjectStore.prototype.put; __acceptanceDraftFail?: boolean };
    if (!state.__acceptanceDraftPut) {
      state.__acceptanceDraftPut = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function (this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
        const current = window as Window & { __acceptanceDraftPut?: typeof IDBObjectStore.prototype.put; __acceptanceDraftFail?: boolean };
        if (this.name === "persistenceDrafts" && current.__acceptanceDraftFail) throw new DOMException("Acceptance quota failure", "QuotaExceededError");
        const put = current.__acceptanceDraftPut!;
        return key === undefined ? put.call(this, value) : put.call(this, value, key);
      };
    }
    state.__acceptanceDraftFail = shouldFail;
  }, fail);
}

async function holdNextWorkImport(page: Page): Promise<{
  committed: Promise<number>;
  projectId: string;
  release(): void;
  remove(): Promise<void>;
}> {
  let openGate!: () => void;
  let resolveCommitted!: (status: number) => void;
  let rejectCommitted!: (error: unknown) => void;
  let projectId = "";
  let released = false;
  const gate = new Promise<void>((resolve) => { openGate = resolve; });
  const committed = new Promise<number>((resolve, reject) => { resolveCommitted = resolve; rejectCommitted = reject; });
  const url = new URL("/api/v1/persistence/import", page.url()).toString();
  const handler = async (route: import("@playwright/test").Route): Promise<void> => {
    if (route.request().method() !== "POST") { await route.continue(); return; }
    try {
      const response = await route.fetch();
      const body = await response.json() as { project?: { id?: string } };
      projectId = body.project?.id ?? "";
      resolveCommitted(response.status());
      await gate;
      await route.fulfill({ response });
    } catch (error) {
      rejectCommitted(error);
      throw error;
    }
  };
  await page.route(url, handler);
  return {
    committed,
    get projectId() { return projectId; },
    release() { if (released) return; released = true; openGate(); },
    async remove() { try { await page.unroute(url, handler); } catch { /* Browser teardown already removed the route. */ } },
  };
}

async function holdNextDocumentDelete(page: Page, projectId: string, documentId: string): Promise<{
  committed: Promise<number>;
  release(): void;
  abort(): void;
  remove(): Promise<void>;
}> {
  let openGate!: () => void;
  let resolveCommitted!: (status: number) => void;
  let rejectCommitted!: (error: unknown) => void;
  let released = false;
  let abortResponse = false;
  const gate = new Promise<void>((resolve) => { openGate = resolve; });
  const committed = new Promise<number>((resolve, reject) => { resolveCommitted = resolve; rejectCommitted = reject; });
  const url = new URL(`/api/v1/persistence/projects/${projectId}/documents/${documentId}`, page.url()).toString();
  const handler = async (route: import("@playwright/test").Route): Promise<void> => {
    if (route.request().method() !== "DELETE") { await route.continue(); return; }
    try {
      const response = await route.fetch();
      resolveCommitted(response.status());
      await gate;
      if (abortResponse) await route.abort("failed");
      else await route.fulfill({ response });
    } catch (error) {
      rejectCommitted(error);
      throw error;
    }
  };
  await page.route(url, handler);
  const release = (): void => {
    if (released) return;
    released = true;
    openGate();
  };
  return {
    committed,
    release,
    abort() { abortResponse = true; release(); },
    async remove() {
      try { await page.unroute(url, handler); } catch { /* Browser teardown already removed the route. */ }
    },
  };
}

function waitForDocumentSaveResponse(page: Page, projectId: string, documentId: string, markdown: string) {
  const expectedHash = createHash("sha256").update(markdown).digest("hex");
  const expectedPath = `/api/v1/persistence/projects/${projectId}/documents/${documentId}`;
  return page.waitForResponse((response) => {
    const request = response.request();
    if (request.method() !== "PATCH" || new URL(request.url()).pathname !== expectedPath) return false;
    return (request.postDataJSON() as { resultingSha256?: string } | null)?.resultingSha256 === expectedHash;
  }, { timeout: 15_000 });
}

async function storedDocumentMarkdown(fetch: AuthorApiFetch, projectId: string, documentId: string): Promise<{ markdown: string; revisionId: string }> {
  const response = await fetch(`/api/v1/persistence/projects/${projectId}/documents/${documentId}`);
  expect(response.ok(), await response.text()).toBe(true);
  const result = await response.json() as { revision: { id: string; markdown: string } };
  return { markdown: result.revision.markdown, revisionId: result.revision.id };
}

async function installMoveBeforeProbe(page: Page, forceAppendFallback: boolean): Promise<boolean> {
  const supported = await page.evaluate(() => typeof (HTMLElement.prototype as HTMLElement & { moveBefore?: unknown }).moveBefore === "function");
  await page.addInitScript((forceFallback) => {
    const prototype = HTMLElement.prototype as HTMLElement & { moveBefore?: (this: HTMLElement, node: Node, child: Node | null) => void };
    const nativeMoveBefore = prototype.moveBefore;
    const probeWindow = window as Window & { __codexiaMoveBeforeCount?: number };
    probeWindow.__codexiaMoveBeforeCount = 0;
    if (forceFallback || typeof nativeMoveBefore !== "function") {
      Object.defineProperty(prototype, "moveBefore", { configurable: true, value: undefined });
      return;
    }
    Object.defineProperty(prototype, "moveBefore", {
      configurable: true,
      value(this: HTMLElement, node: Node, child: Node | null) {
        probeWindow.__codexiaMoveBeforeCount = (probeWindow.__codexiaMoveBeforeCount ?? 0) + 1;
        return nativeMoveBefore.call(this, node, child);
      },
    });
  }, forceAppendFallback);
  return supported && !forceAppendFallback;
}

for (const forceAppendFallback of [false, true]) {
  preparedAuthorTest(`CodeMirror undo, redo, selection, and scroll survive a guarded desktop panel switch during save (${forceAppendFallback ? "append fallback" : "moveBefore when supported"})`, async ({ page, authorizeAuthor }) => {
    expect(databaseUrl, "the browser acceptance server must use a disposable PostgreSQL database").toBeTruthy();
    const usesMoveBefore = await installMoveBeforeProbe(page, forceAppendFallback);
    await page.setViewportSize({ width: 1280, height: 900 });
    const original = Array.from({ length: 72 }, (_, index) => `第${index + 1}行。作者が同じ文章を読み戻せます。`).join("\n");
    const { project, scene, author } = await createOAuthWritingFixture(authorizeAuthor, page, "desktop", `Editor lifetime ${crypto.randomUUID()}`, original);
    await moveEditorIntoDesktopStack(page);

    const editor = manuscriptEditor(page);
    const inserted = "X";
    const heldSave = await holdNextDocumentSave(page, project.id, scene.id);
    const changePanel = async (showEditor: boolean): Promise<void> => {
      const tabs = page.getByRole("tablist", { name: "パネル" });
      const tab = tabs.getByRole("tab", { name: showEditor ? "原稿" : "知識と根拠", exact: true });
      await tab.click();
      if (!showEditor) await expect(editor).toHaveCount(0);
      else await expect(editor).toBeVisible();
    };
    await changePanel(true);
    const retainedContent = await page.locator(".cm-content").elementHandle();
    expect(retainedContent).not.toBeNull();

    try {
      const initialRevision = await storedDocumentMarkdown(author.fetch, project.id, scene.id);
      expect(initialRevision.markdown).toBe(original);
      await editor.click();
      const caret = await editor.evaluate((element) => {
        const selection = element.ownerDocument.getSelection();
        const focus = selection?.focusNode;
        const line = (focus instanceof Element ? focus : focus?.parentElement)?.closest(".cm-line");
        if (!selection?.isCollapsed || !focus || !line?.textContent || !element.contains(line)) {
          throw new Error("Click must place a single caret within a rendered manuscript line");
        }
        const prefix = document.createRange();
        prefix.selectNodeContents(line);
        prefix.setEnd(focus, selection.focusOffset);
        return { text: line.textContent, prefixLength: prefix.toString().length };
      });
      // Infer the expected position from the browser caret and the input fixture,
      // independently of the save command built by the editor.
      const lineStart = original.indexOf(caret.text);
      expect(lineStart).toBeGreaterThanOrEqual(0);
      const offset = lineStart + caret.prefixLength;
      const beforeCaret = original.slice(0, offset);
      const afterCaret = original.slice(offset);
      const editedMarkdown = beforeCaret + inserted + afterCaret;
      await editor.pressSequentially(inserted);
      await expectDeviceDraft(page);
      await heldSave.requestReached;
      const saveBody = await heldSave.requestBody as { changes: Array<{ fromUtf16: number; toUtf16: number; insert: string }>; resultingSha256: string };
      expect(saveBody.changes).toEqual([{ fromUtf16: offset, toUtf16: offset, insert: inserted }]);
      expect(createHash("sha256").update(editedMarkdown).digest("hex")).toBe(saveBody.resultingSha256);

      const scroller = page.locator(".cm-scroller");
      const scrollTop = await scroller.evaluate((element) => {
        element.scrollTop = Math.min(300, element.scrollHeight - element.clientHeight);
        return element.scrollTop;
      });
      const switchingAway = changePanel(false);
      heldSave.release();
      await switchingAway;
      expect(await retainedContent!.evaluate((element) => {
        const container = element.closest<HTMLElement>(".pg-preserved-editor-container");
        return { connected: element.isConnected, parked: container?.parentElement?.classList.contains("pg-preserved-editor-parking"), parkingHidden: container?.parentElement instanceof HTMLElement ? container.parentElement.hidden : false, hidden: container?.hidden, inert: container?.inert, ariaHidden: container?.getAttribute("aria-hidden") };
      })).toEqual({ connected: true, parked: true, parkingHidden: true, hidden: true, inert: true, ariaHidden: "true" });
      await expect.poll(async () => (await storedDocumentMarkdown(author.fetch, project.id, scene.id)).markdown).toBe(editedMarkdown);
      const firstSaved = await storedDocumentMarkdown(author.fetch, project.id, scene.id);
      expect(firstSaved.revisionId).not.toBe(initialRevision.revisionId);

      await changePanel(true);
      await expect.poll(() => retainedContent!.evaluate((element) => element.isConnected)).toBe(true);
      expect(await page.locator(".cm-content").evaluate((element, previous) => element === previous, retainedContent)).toBe(true);
      expect(await retainedContent!.evaluate((element) => {
        const container = element.closest<HTMLElement>(".pg-preserved-editor-container");
        return { hidden: container?.hidden, inert: container?.inert, ariaHidden: container?.getAttribute("aria-hidden") };
      })).toEqual({ hidden: false, inert: false, ariaHidden: null });
      const moveBeforeCalls = await page.evaluate(() => (window as Window & { __codexiaMoveBeforeCount?: number }).__codexiaMoveBeforeCount ?? 0);
      if (usesMoveBefore) expect(moveBeforeCalls).toBeGreaterThan(0);
      else expect(moveBeforeCalls).toBe(0);
      await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBe(scrollTop);
      const undoResponse = waitForDocumentSaveResponse(page, project.id, scene.id, original);
      await editor.press("Control+z");
      await expect(editor).toBeFocused();
      const focusContext = await editor.evaluate((element) => ({
        active: document.activeElement === element,
        inert: Boolean(element.closest("[inert]")),
        ariaHidden: Boolean(element.closest('[aria-hidden="true"]')),
        modalCount: document.querySelectorAll('[role="dialog"][aria-modal="true"]').length,
      }));
      expect(focusContext).toEqual({ active: true, inert: false, ariaHidden: false, modalCount: 0 });
      expect((await undoResponse).ok()).toBe(true);
      await expect.poll(async () => (await storedDocumentMarkdown(author.fetch, project.id, scene.id)).markdown).toBe(original);
      const undone = await storedDocumentMarkdown(author.fetch, project.id, scene.id);
      expect(undone.revisionId).not.toBe(firstSaved.revisionId);

      await changePanel(false);
      await changePanel(true);
      const redoResponse = waitForDocumentSaveResponse(page, project.id, scene.id, editedMarkdown);
      await editor.press("Control+Shift+z");
      expect((await redoResponse).ok()).toBe(true);
      await expect.poll(async () => (await storedDocumentMarkdown(author.fetch, project.id, scene.id)).markdown).toBe(editedMarkdown);
      const redone = await storedDocumentMarkdown(author.fetch, project.id, scene.id);
      expect(redone.revisionId).not.toBe(undone.revisionId);
      const nextEdit = `${beforeCaret}${inserted}……${afterCaret}`;
      const displayMenu = page.locator(".pg-editor-display-menu");
      if (!await displayMenu.evaluate((element) => (element as HTMLDetailsElement).open)) await displayMenu.locator("summary").click();
      const symbolMenu = page.locator(".pg-editor-symbol-menu");
      const symbolResponse = waitForDocumentSaveResponse(page, project.id, scene.id, nextEdit);
      await symbolMenu.getByRole("button", { name: "三点リーダーを挿入" }).click();
      expect((await symbolResponse).ok()).toBe(true);
      await expect.poll(async () => (await storedDocumentMarkdown(author.fetch, project.id, scene.id)).markdown).toBe(nextEdit);
      await expect(editor).toBeFocused();
      const typedEdit = `${beforeCaret}${inserted}……y${afterCaret}`;
      const typingResponse = page.waitForResponse((response) => response.request().method() === "PATCH" && new URL(response.url()).pathname === `/api/v1/persistence/projects/${project.id}/documents/${scene.id}`, { timeout: 15_000 });
      await page.keyboard.press("y");
      const typedSave = await typingResponse;
      expect(typedSave.ok()).toBe(true);
      expect((typedSave.request().postDataJSON() as { resultingSha256: string }).resultingSha256).toBe(createHash("sha256").update(typedEdit).digest("hex"));
      await expect.poll(async () => (await storedDocumentMarkdown(author.fetch, project.id, scene.id)).markdown).toBe(typedEdit);
      await displayMenu.locator("summary").click();

      await openRevisionHistory(page);
      const revisionsResponse = await author.fetch(new URL(`/api/v1/persistence/projects/${project.id}/documents/${scene.id}/revisions?limit=50`, page.url()).toString());
      expect(revisionsResponse.ok(), await revisionsResponse.text()).toBe(true);
      const revisions = (await revisionsResponse.json() as { revisions: Array<{ id: string }> }).revisions;
      const originalRevisionIndex = revisions.findIndex((revision) => revision.id === initialRevision.revisionId);
      expect(originalRevisionIndex).toBeGreaterThanOrEqual(0);
      const originalRevision = page.locator(".pg-revisions article").nth(originalRevisionIndex);
      await originalRevision.getByRole("button", { name: "このRevisionを新しいRevisionとして復元" }).click();
      await expect(page.locator(".pg-notice")).toContainText("新しいPostgreSQL Revisionとして復元しました");
      const restoredRevision = await storedDocumentMarkdown(author.fetch, project.id, scene.id);
      expect(restoredRevision.markdown).toBe(original);
      await changePanel(false);
      await changePanel(true);
      await editor.focus();
      await editor.press("Control+z");
      await expect.poll(async () => (await storedDocumentMarkdown(author.fetch, project.id, scene.id)).revisionId).toBe(restoredRevision.revisionId);
    } finally {
      await heldSave.remove();
      heldSave.release();
    }
  });
}


async function openResearchInspector(page: import("@playwright/test").Page) {
  // A visible contenteditable can precede the CodeMirror EditorView being
  // connected after reload. Focusing and observing CodeMirror's focus class
  // proves the editor is ready before its navigation guard runs.
  await manuscriptEditor(page).focus();
  await expect(page.locator(".cm-editor")).toHaveClass(/cm-focused/u);
  const toolbar = page.getByRole("toolbar", { name: "ワークスペース配置" });
  await toolbar.getByRole("button", { name: "調査", exact: true }).click();
  await expect(page.locator('[data-workspace-panel="inspector"]')).toBeVisible();
  const knowledgeTools = page.locator(".pg-knowledge-tools");
  if (await knowledgeTools.count() && !await knowledgeTools.evaluate((element) => (element as HTMLDetailsElement).open)) {
    await knowledgeTools.locator("summary").click();
  }
}

preparedAuthorTest("replays ambiguous project and document creates with retained client intent", async ({ page, authorizeAuthor }) => {
  expect(databaseUrl, "the browser acceptance server must use a disposable PostgreSQL database").toBeTruthy();
  const projectTitle = `Replay project ${crypto.randomUUID()}`;
  const documentTitle = `Replay scene ${crypto.randomUUID()}`;
  let projectTimeoutInjected = false;
  let documentTimeoutInjected = false;
  const projectBodies: Array<{ id?: string; title: string }> = [];
  const documentBodies: Array<{ documentId?: string; idempotencyKey?: string; title: string }> = [];
  await page.route("**/api/v1/persistence/projects", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    const body = route.request().postDataJSON() as { id?: string; title: string };
    projectBodies.push(body);
    if (!projectTimeoutInjected) {
      projectTimeoutInjected = true;
      const response = await route.fetch();
      expect(response.status()).toBe(201);
      await route.fulfill({ status: 504, contentType: "application/json", body: JSON.stringify({ error: "synthetic gateway timeout" }) });
      return;
    }
    await route.continue();
  });
  await page.route("**/api/v1/persistence/projects/*/documents", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    const body = route.request().postDataJSON() as { documentId?: string; idempotencyKey?: string; title: string };
    expect(body).not.toHaveProperty("idempotencyKey");
    const idempotencyKey = await route.request().headerValue("idempotency-key");
    expect(idempotencyKey).toBeTruthy();
    documentBodies.push({ ...body, idempotencyKey: idempotencyKey! });
    if (!documentTimeoutInjected) {
      documentTimeoutInjected = true;
      const response = await route.fetch();
      expect(response.status()).toBe(201);
      await route.fulfill({ status: 504, contentType: "application/json", body: JSON.stringify({ error: "synthetic gateway timeout" }) });
      return;
    }
    await route.continue();
  });

  let projectReadMissed = false;
  await page.route("**/api/v1/persistence/projects/*", async (route) => {
    const id = projectBodies[0]?.id;
    if (projectTimeoutInjected && !projectReadMissed && route.request().method() === "GET" &&
        new URL(route.request().url()).pathname === `/api/v1/persistence/projects/${id}`) {
      projectReadMissed = true;
      await route.fulfill({ status: 404, contentType: "application/json", body: "{}" });
      return;
    }
    await route.continue();
  });
  let documentReadMissed = false;
  await page.route("**/api/v1/persistence/projects/*/documents/*", async (route) => {
    const id = documentBodies[0]?.documentId;
    if (documentTimeoutInjected && !documentReadMissed && route.request().method() === "GET" &&
        new URL(route.request().url()).pathname.endsWith(`/documents/${id}`)) {
      documentReadMissed = true;
      await route.fulfill({ status: 404, contentType: "application/json", body: "{}" });
      return;
    }
    await route.continue();
  });

  const author = await authorizeAuthor("desktop");
  const outline = page.locator('[data-workspace-panel="outline"]');
  await outline.locator(".pg-library-create > summary").click();
  await outline.getByLabel("作品名").fill(projectTitle);
  await outline.locator(".pg-library-create").getByRole("button", { name: "作成", exact: true }).click();
  const editorAlert = page.getByRole("main", { name: "PostgreSQL原稿編集" }).getByRole("alert");
  await expect(editorAlert).toHaveText("synthetic gateway timeout");
  await expect(editorAlert).toHaveCount(1);
  await expect(page.getByRole("alert")).toHaveCount(1);
  expect(projectReadMissed).toBe(true);
  await expect(outline.getByLabel("作品名")).toHaveValue(projectTitle);
  await outline.locator(".pg-library-create").getByRole("button", { name: "作成", exact: true }).click();
  await expect(page.getByRole("heading", { name: projectTitle, exact: true })).toBeVisible();

  const projectsResponse = await author.fetch("/api/v1/persistence/projects?limit=100");
  expect(projectsResponse.ok()).toBe(true);
  const { projects } = await projectsResponse.json() as { projects: Array<{ id: string; title: string }> };
  expect(projects.filter((item) => item.title === projectTitle)).toHaveLength(1);
  expect(projectBodies).toHaveLength(2);
  expect(projectBodies[1]).toEqual(projectBodies[0]);

  // A completed intent is cleared, so an independent same-title submission
  // must allocate a fresh project id rather than replaying the prior create.
  await outline.getByLabel("作品名").fill(projectTitle);
  await outline.locator(".pg-library-create").getByRole("button", { name: "作成", exact: true }).click();
  await expect.poll(() => projectBodies.length).toBe(3);
  const projectId = projectBodies[2]?.id;
  expect(projectId).toBeTruthy();
  await expect(outline.getByLabel("作品", { exact: true })).toHaveValue(projectId!);
  const projectsAfterSameTitle = await author.fetch("/api/v1/persistence/projects?limit=100");
  expect(projectsAfterSameTitle.ok()).toBe(true);
  const afterSameTitle = await projectsAfterSameTitle.json() as { projects: Array<{ id: string; title: string }> };
  expect(afterSameTitle.projects.filter((item) => item.title === projectTitle)).toHaveLength(2);
  expect(projectBodies).toHaveLength(3);
  expect(projectId).not.toBe(projectBodies[0]?.id);

  const createDocument = outline.locator(".pg-library-create-document");
  await createDocument.locator("summary").click();
  await createDocument.getByLabel("文書名").fill(documentTitle);
  await createDocument.getByRole("button", { name: "作成", exact: true }).click();
  await expect(editorAlert).toHaveText("synthetic gateway timeout");
  await expect(editorAlert).toHaveCount(1);
  expect(documentReadMissed).toBe(true);
  await expect(createDocument.getByLabel("文書名")).toHaveValue(documentTitle);
  await createDocument.getByRole("button", { name: "作成", exact: true }).click();
  await expect(page.getByRole("heading", { name: documentTitle, exact: true })).toBeVisible();

  const documentsResponse = await author.fetch(`/api/v1/persistence/projects/${projectId}/documents`);
  expect(documentsResponse.ok()).toBe(true);
  const documents = (await documentsResponse.json() as { documents: Array<{ id: string; title: string }> }).documents;
  expect(documents.filter((item) => item.title === documentTitle)).toHaveLength(1);
  expect(documentBodies).toHaveLength(2);
  expect(documentBodies[1]).toEqual(documentBodies[0]);

  await createDocument.getByLabel("文書名").fill(documentTitle);
  await createDocument.getByRole("button", { name: "作成", exact: true }).click();
  await expect.poll(async () => {
    const response = await author.fetch(`/api/v1/persistence/projects/${projectId}/documents`);
    const { documents } = await response.json() as { documents: Array<{ id: string; title: string }> };
    return documents.filter((item) => item.title === documentTitle).length;
  }).toBe(2);
  const afterSecondCreate = await author.fetch(`/api/v1/persistence/projects/${projectId}/documents`);
  const allDocuments = (await afterSecondCreate.json() as { documents: Array<{ id: string; title: string }> }).documents;
  expect(allDocuments.filter((item) => item.title === documentTitle)).toHaveLength(2);
  expect(documentBodies).toHaveLength(3);
  expect(documentBodies[2]?.documentId).not.toBe(documentBodies[0]?.documentId);
  expect(documentBodies[2]?.idempotencyKey).not.toBe(documentBodies[0]?.idempotencyKey);

  // A response proving that the requested ID belongs to another document
  // must release the old creation intent; ambiguous 504 + 404 above must not.
  const collisionTitle = `Collision scene ${crypto.randomUUID()}`;
  const existingReadResponse = await author.fetch(`/api/v1/persistence/projects/${projectId}/documents/${allDocuments[0]!.id}`);
  expect(existingReadResponse.ok()).toBe(true);
  const existingRead = await existingReadResponse.json() as {
    document: { id: string; title: string; [key: string]: unknown };
    revision: ({ documentId?: string; [key: string]: unknown }) | null;
  };
  let collidingAttempt: { documentId: string; idempotencyKey: string; title: string } | undefined;
  let collisionReadCount = 0;
  await page.route("**/api/v1/persistence/projects/*/documents", async (route) => {
    if (route.request().method() === "POST" && !collidingAttempt) {
      const body = route.request().postDataJSON() as { documentId: string; title: string };
      expect(body).not.toHaveProperty("idempotencyKey");
      const idempotencyKey = await route.request().headerValue("idempotency-key");
      expect(idempotencyKey).toBeTruthy();
      collidingAttempt = { ...body, idempotencyKey: idempotencyKey! };
      await route.fulfill({ status: 409, json: { error: "synthetic document ID collision" } });
      return;
    }
    await route.fallback();
  });
  await page.route("**/api/v1/persistence/projects/*/documents/*", async (route) => {
    if (route.request().method() === "GET" && collidingAttempt && collisionReadCount === 0 &&
        new URL(route.request().url()).pathname.endsWith(`/documents/${collidingAttempt.documentId}`)) {
      collisionReadCount += 1;
      await route.fulfill({
        status: 200,
        json: {
          ...existingRead,
          document: { ...existingRead.document, id: collidingAttempt.documentId },
          revision: existingRead.revision ? { ...existingRead.revision, documentId: collidingAttempt.documentId } : null,
        },
      });
      return;
    }
    await route.fallback();
  });
  await createDocument.getByLabel("文書名").fill(collisionTitle);
  await createDocument.getByRole("button", { name: "作成", exact: true }).click();
  await expect(editorAlert).toContainText("同じ文書IDに別の文書が存在");
  expect(collisionReadCount).toBe(1);
  expect(collidingAttempt?.documentId).toBeTruthy();
  await createDocument.getByRole("button", { name: "作成", exact: true }).click();
  await expect.poll(() => documentBodies.length).toBe(4);
  expect(documentBodies[3]?.documentId).not.toBe(collidingAttempt?.documentId);
  expect(documentBodies[3]?.idempotencyKey).not.toBe(collidingAttempt?.idempotencyKey);
  await expect(page.getByRole("heading", { name: collisionTitle, exact: true })).toBeVisible();
});


test("Git store selector cannot bypass PostgreSQL-only authoring", async ({ page, authorizeAuthor }) => {
  await page.route("**/api/v1/persistence/status", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ available: false, provider: null }) });
  });
  await authorizeAuthor("desktop", page, { path: "/desktop/?store=git", expectedView: page.getByRole("heading", { name: "PostgreSQLへ接続できません" }) });
  await expect(page.getByRole("heading", { name: "PostgreSQLへ接続できません" })).toBeVisible();
  await expect(page.getByRole("alert")).toContainText("PostgreSQL保存基盤が利用できません");
  await expect(page.getByRole("heading", { name: "Database workspace" })).toHaveCount(0);
});

preparedAuthorTest("desktop standalone authoring opens the first project and document forms from the empty editor", async ({ page, authorizeAuthor }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  let showProject = false;
  await page.route((url) => url.pathname === "/api/v1/persistence/projects", async (route) => {
    if (!showProject && route.request().method() === "GET") return route.fulfill({ json: { projects: [], nextCursor: null } });
    if (route.request().method() !== "POST") return route.continue();
    const response = await route.fetch();
    showProject = response.ok();
    await route.fulfill({ response });
  });
  await authorizeAuthor("desktop", page, { path: "/desktop/" });
  const firstProject = page.getByRole("button", { name: "最初の作品を作成" });
  await firstProject.click();
  const projectName = page.getByLabel("作品名", { exact: true });
  await expect(projectName).toBeFocused();
  await page.locator(".pg-library-create > summary").click();
  await expect(firstProject).toBeVisible();
  await firstProject.click();
  await expect(projectName).toBeFocused();
  await projectName.fill(`Empty state desktop ${crypto.randomUUID()}`);
  await page.locator(".pg-library-create").getByRole("button", { name: "作成", exact: true }).click();
  await expect(page.getByText("編集を始める文書を作成してください。", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "最初の文書を作成" }).click();
  const documentName = page.getByLabel("文書名", { exact: true });
  await expect(documentName).toBeFocused();
  await documentName.fill("最初のシーン");
  await page.locator(".pg-library-create-document").getByRole("button", { name: "作成", exact: true }).click();
  const editor = manuscriptEditor(page);
  await expect(editor).toBeVisible();
  await editor.click();
  await page.keyboard.insertText("はじめの本文。");
  await expect(editor).toHaveText("はじめの本文。");
  await expectServerSaved(page);
});

test("PostgreSQL workspace saves, recovers, detects conflicts, and links Knowledge to Text Anchors", async ({ page, authorizeAuthor }) => {
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

  await authorizeAuthor("desktop", page, { path: "/desktop/?acceptance=database" });
  await expect(page.getByRole("heading", { name: "Database workspace" })).toBeVisible();

  const outline = page.locator('[data-workspace-panel="outline"]');
  await outline.locator(".pg-library-create > summary").click();
  await outline.getByLabel("作品名").fill(projectTitle);
  await outline.locator(".pg-library-create").getByRole("button", { name: "作成", exact: true }).click();
  await expect(page.getByRole("heading", { name: projectTitle })).toBeVisible();
  const createDocument = outline.locator(".pg-library-create-document");
  await createDocument.locator("summary").click();
  await createDocument.getByLabel("文書名").fill(documentTitle);
  await createDocument.getByRole("button", { name: "作成", exact: true }).click();

  const editor = manuscriptEditor(page);
  await expect(editor).toBeVisible();
  await editor.fill(firstDraft);
  await expectServerSaved(page);
  await expectNoUnsavedDeviceChanges(page);

  await editor.press("Control+A");
  await page.locator(".pg-editor-command-menu > summary").click();
  await page.getByRole("button", { name: "選択範囲をText Anchorにする" }).click();
  await expect(page.locator(".pg-notice")).toContainText("Text Anchorを保存しました");
  await openResearchInspector(page);
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
  const context = page.getByRole("region", { name: "Knowledge詳細" });
  await context.locator(".kci__edit-disclosure").filter({ hasText: "別名を追加" }).locator("summary").click();
  await context.getByLabel("別名候補").fill("塔");
  await context.getByRole("button", { name: "別名候補を追加" }).click();
  await expect(context).toContainText("塔 · proposed");
  await context.getByRole("button", { name: "別名を確定" }).click();
  await expect(context).toContainText("塔 · confirmed");
  await context.locator(".kci__edit-disclosure").filter({ hasText: "命題候補を作成" }).locator("summary").click();
  await context.getByLabel("命題", { exact: true }).fill("塔は青い。");
  await context.getByRole("button", { name: "命題候補を保存" }).click();
  await expect(context).toContainText("塔は青い。 · fact · author · proposed");
  await context.getByRole("button", { name: "命題を確定" }).click();
  await expect(context).toContainText("塔は青い。 · fact · author · confirmed");
  const backlinks = page.getByRole("region", { name: "Knowledgeの根拠" });
  await expect(backlinks).toContainText(documentTitle);
  await expect(backlinks).toContainText(firstDraft);
  await expect(backlinks).toContainText("確定リンク · 確認済みの根拠");
  await backlinks.getByRole("button", { name: /第一稿/u }).click();
  await expect(page.locator(".pg-notice")).toContainText("現在のRevisionの根拠箇所を選択しました");
  // CodeMirror represents line breaks as separate DOM nodes, not textContent.
  const readEditor = () => editor.locator(".cm-line").evaluateAll(lines => lines.map(line => { const copy = line.cloneNode(true) as Element; copy.querySelectorAll(".cm-placeholder").forEach(node => node.remove()); return copy.textContent ?? ""; }).join("\n"));
  await expect.poll(readEditor).toBe(firstDraft);


  await openRevisionHistory(page);
  const initialRevision = page.locator(".pg-revisions article").filter({ hasText: "（空の原稿）" });
  await expect(initialRevision).toBeVisible();
  await initialRevision.getByRole("button", { name: "このRevisionを新しいRevisionとして復元" }).click();
  await expect(page.locator(".pg-notice")).toContainText("新しいPostgreSQL Revisionとして復元しました");
  await expect.poll(readEditor).not.toContain(firstDraft);
  await openResearchInspector(page);
  await expect(backlinks).toContainText("本文から削除");
  await expect(backlinks).toContainText(firstDraft);
  await backlinks.getByRole("button", { name: /第一稿/u }).click();
  await expect(page.locator(".pg-notice")).toContainText("現在位置が未確定の根拠です");
  await expect.poll(readEditor).toBe("");


  const otherPage = await page.context().newPage();
  otherPage.on("console", (message) => {
    if (message.type() === "error" && message.text().includes("Content Security Policy")) {
      contentSecurityPolicyViolations.push(message.text());
    }
  });
  await authorizeAuthor("desktop", otherPage, { path: "/desktop/?store=postgres" });
  await expect(otherPage.getByRole("heading", { name: "Database workspace" })).toBeVisible();
  await otherPage.getByLabel("作品", { exact: true }).selectOption({ label: projectTitle });
  const otherDocument = otherPage.locator(".pg-document-list").getByRole("treeitem", { name: new RegExp(documentTitle, "u") });
  await expect(otherDocument).toBeVisible();
  await otherDocument.click();
  const otherEditor = manuscriptEditor(otherPage);
  await expect(otherEditor).toBeVisible();
  await expect(otherEditor).not.toContainText(firstDraft);

  const winningDraft = "PostgreSQL側の先行Revision";
  const recoveredDraft = "別タブの回復Draft";
  await editor.fill(winningDraft);
  await expectServerSaved(page);
  await otherEditor.fill(recoveredDraft);
  await expect(otherPage.getByRole("heading", { name: "Revision競合" })).toBeVisible({ timeout: 15_000 });
  await expect(otherPage.locator(".pg-conflict")).toContainText(winningDraft);
  await expect(otherPage.locator(".pg-conflict")).toContainText(recoveredDraft);
  await otherPage.getByRole("button", { name: "比較後、この回復Draftを最新版へ適用" }).click();
  await expectServerSaved(otherPage);
  await expect(otherEditor).toContainText(recoveredDraft);

  await otherPage.route("**/api/v1/persistence/projects/*/documents/*", async (route) => {
    if (route.request().method() === "PATCH") await route.abort();
    else await route.continue();
  });
  const interruptedDraft = "再読み込み後に復旧するDraft";
  await otherEditor.fill(interruptedDraft);
  await expectDeviceDraft(otherPage);
  await expectServerSaveFailure(otherPage);
  await otherPage.unroute("**/api/v1/persistence/projects/*/documents/*");
  await otherPage.reload();
  await authorizeAuthor("desktop", otherPage, { continueCurrentPage: true });
  await expect(otherPage.getByRole("heading", { name: "Database workspace" })).toBeVisible();
  await otherPage.getByLabel("作品", { exact: true }).selectOption({ label: projectTitle });
  await expect(otherPage.locator(".pg-document-list").getByRole("treeitem", { name: new RegExp(documentTitle, "u") })).toBeVisible();
  await otherPage.locator(".pg-document-list").getByRole("treeitem", { name: new RegExp(documentTitle, "u") }).click();
  const recoveredEditor = manuscriptEditor(otherPage);
  await expect(recoveredEditor).toContainText(interruptedDraft);
  await expectServerSaved(otherPage);
  await otherPage.close();
  expect(contentSecurityPolicyViolations).toEqual([]);
});


test("Knowledge relation pagination keeps the forty-first fetched relation actionable", async ({ page, authorizeAuthor }) => {
  expect(databaseUrl).toBeTruthy();
  const { project, author } = await createOAuthWritingFixture(authorizeAuthor, page);
  const path = `/api/v1/persistence/projects/${project.id}/nodes`;
  const headers = { Origin: new URL(page.url()).origin };
  const source = crypto.randomUUID(), target = crypto.randomUUID();
  for (const [id, name] of [[source, "関係の中心"], [target, "関係先"]]) {
    const response = await author.fetch(`${path}/${id}`, { method: "PUT", headers, data: {
      type: "person", name, attributes: {}, status: "confirmed", expectedVersion: null,
    } });
    expect(response.ok(), await response.text()).toBe(true);
  }
  for (let i = 0; i < 41; i++) {
    const response = await author.fetch(`${path}/${source}/relations`, { method: "POST", headers, data: {
      id: crypto.randomUUID(), targetId: target, type: `関係 ${String(i).padStart(2, "0")}`, attributes: {}, validity: {}, status: "proposed", expectedVersion: null,
    } });
    expect(response.status(), await response.text()).toBe(201);
  }
  const data = await author.fetch(`${path}/${source}`);
  const { relations } = await data.json() as { relations: Array<{ id: string; type: string; status: string }> };
  expect(relations).toHaveLength(41);
  const last = relations[40]!;
  await page.reload();
  await authorizeAuthor("desktop", page, { continueCurrentPage: true });
  // Wait for the persisted document and recovery journal to finish activation
  // before requesting a guarded workspace layout transition.
  await expect(manuscriptEditor(page)).toBeVisible();
  await expect(page.getByRole("heading", { name: "日本語の原稿", exact: true })).toBeVisible();
  await openResearchInspector(page);
  await page.getByLabel("Text AnchorのKnowledge先").selectOption(source);
  const context = page.getByRole("region", { name: "Knowledge詳細" });
  await expect(context.locator(".kci__graph-row")).toHaveCount(40);
  await context.getByRole("button", { name: "次の関係", exact: true }).click();
  const row = context.locator(".kci__graph-row");
  await expect(row).toHaveCount(1);
  await expect(row).toContainText(last.type);
  await row.getByRole("button", { name: "関係を確定" }).click();
  await expect.poll(async () => {
    const response = await author.fetch(`${path}/${source}`);
    const result = await response.json() as { relations: Array<{ id: string; status: string }> };
    return result.relations.find(relation => relation.id === last.id)?.status;
  }).toBe("confirmed");
});

preparedAuthorTest("desktop move destinations exclude descendants and identify same-title paths", async ({ page, authorizeAuthor }) => {
  const author = await authorizeAuthor("desktop");
  const origin = new URL(page.url()).origin;
  const document = (title: string, kind: string, parentId: string | null) => ({
    id: crypto.randomUUID(), revisionId: crypto.randomUUID(), title, kind, parentId, orderKey: title, markdown: title,
  });
  const volume = document("移動する巻", "volume", null);
  const child = document("子章", "chapter", volume.id);
  const grandchild = document("孫シーン", "scene", child.id);
  const firstParent = document("別巻甲", "volume", null);
  const secondParent = document("別巻乙", "volume", null);
  const first = document("同名の章", "chapter", firstParent.id);
  const second = document("同名の章", "chapter", secondParent.id);
  const archive = await author.fetch("/api/v1/persistence/import", { method: "POST",
    headers: { Origin: origin },
    data: { format: "codexia-work/v1", project: { title: `Move ${crypto.randomUUID()}`, settings: {} },
      documents: [volume, child, grandchild, firstParent, secondParent, first, second],
      knowledge: { nodes: [], aliases: [], relations: [] },
      evidence: { anchors: [], mentions: [], assertions: [], assertionEvidence: [], unresolved: { anchors: [], mentions: [], assertionEvidence: [] } },
      moduleRecords: [], omittedRecords: [] },
  });
  expect(archive.status()).toBe(201);
  const { project } = await archive.json() as { project: { id: string } };
  const projectRoute = `/api/v1/persistence/projects/${project.id}/documents`;
  await authorizeAuthor("desktop", page, { path: `/desktop/projects/${project.id}/scenes/${volume.id}` });
  await expect(manuscriptEditor(page)).toContainText(volume.markdown);
  const scope = page.locator('[data-workspace-panel="outline"]');
  await scope.getByText("選択文書の構成を変更", { exact: true }).click();
  const targets = scope.getByLabel("移動先");
  for (const unavailable of [volume, child, grandchild]) await expect(targets.locator(`option[value="${unavailable.id}"]`)).toHaveCount(0);
  await expect(targets.locator(`option[value="${first.id}"]`)).toContainText("別巻甲");
  await expect(targets.locator(`option[value="${second.id}"]`)).toContainText("別巻乙");

  await targets.selectOption(first.id);
  const candidate = await author.fetch(`${projectRoute}/${first.id}`);
  expect(candidate.ok()).toBe(true);
  const { document: current } = await candidate.json() as { document: { version: number } };
  const reassigned = await author.fetch(`${projectRoute}/${first.id}/metadata`, { method: "PATCH",
    headers: { Origin: origin },
    data: { parentId: child.id, expectedVersion: current.version },
  });
  expect(reassigned.ok()).toBe(true);
  await scope.getByRole("button", { name: "文書を移動" }).click();
  await expect(page.getByText("Document hierarchy cannot contain a cycle", { exact: true }).first()).toBeVisible();
  await expect(targets).toHaveValue(first.id);
  await targets.selectOption(second.id);
  await scope.getByRole("button", { name: "文書を移動" }).click();
  await expect.poll(async () => {
    const response = await author.fetch(`${projectRoute}/${volume.id}`);
    return ((await response.json()) as { document: { parentId: string | null } }).document.parentId;
  }).toBe(second.id);
});

preparedAuthorTest("revision comparison separates distant manuscript edits", async ({ page, authorizeAuthor }) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  const { project, scene, author } = await createOAuthWritingFixture(authorizeAuthor, page);
  const path = `/api/v1/persistence/projects/${project.id}/documents/${scene.id}`;
  const response = await author.fetch(path);
  expect(response.ok()).toBe(true);
  let { revision } = await response.json() as { revision: { id: string; markdown: string } };
  const middle = Array.from({ length: 200 }, (_, index) => `変わらない第 ${index} 段落には｜青空《あおぞら》が続きます。\n\n`).join("");
  for (const value of [`冒頭は旧稿。\n\n${middle}結末には旧稿。\n`, `冒頭は改稿。\n\n${middle}結末には新しい追加行。\n`]) {
    const saved = await author.fetch(path, { method: "PATCH",
      headers: { Origin: new URL(page.url()).origin, "Idempotency-Key": crypto.randomUUID(), "X-Client-Id": "revision-diff-fixture" },
      data: {
        baseRevisionId: revision.id,
        changes: [{ fromUtf16: 0, toUtf16: revision.markdown.length, insert: value }],
        resultingSha256: createHash("sha256").update(value).digest("hex"),
      },
    });
    expect(saved.ok()).toBe(true);
    ({ revision } = await saved.json() as { revision: typeof revision });
  }
  await authorizeAuthor("desktop", page, { path: `/desktop/projects/${project.id}/scenes/${scene.id}` });
  await expect(manuscriptEditor(page)).toContainText("冒頭は改稿。");
  await openRevisionHistory(page);
  const previous = page.getByRole("region", { name: "Revision履歴" }).locator("article").filter({ hasText: "冒頭は旧稿。" });
  const diff = previous.locator(".pg-revision-diff-preview");
  await expect(diff).toHaveCount(0);
  await previous.getByText("最新版との違い", { exact: true }).click();
  const hunks = diff.locator(".pg-revision-diff-hunk");
  await expect(hunks).toHaveCount(2);
  await expect(diff).toContainText(revision.id);
  await expect(diff).toContainText("結末には新しい追加行。");
  await expect(diff).not.toContainText("第 100 段落");
  await page.setViewportSize({ width: 320, height: 760 });
  expect(await hunks.first().evaluate(element => getComputedStyle(element).gridTemplateColumns.split(" ").length)).toBe(1);
});

preparedAuthorTest("a 501-document PostgreSQL work opens its final scene through the canonical deep link", async ({ page, authorizeAuthor }) => {
  test.setTimeout(90000);
  const author = await authorizeAuthor("desktop");
  const title = `Long outline ${crypto.randomUUID()}`;
  const documents = Array.from({length:501},(_,i)=>({
    id:crypto.randomUUID(), parentId:null, kind:"scene", title:`Large scene ${i+1}`,
    orderKey:String(i).padStart(8,"0"), markdown:`本文 ${i+1}`, revisionId:crypto.randomUUID(),
  }));
  const response=await author.fetch(new URL("/api/v1/persistence/import",page.url()).toString(), { method: "POST",
    headers:{Origin:new URL(page.url()).origin},
    data:{format:"codexia-work/v1",project:{title,settings:{}},documents,
      knowledge:{nodes:[],aliases:[],relations:[]},
      evidence:{anchors:[],mentions:[],assertions:[],assertionEvidence:[],unresolved:{anchors:[],mentions:[],assertionEvidence:[]}},
      moduleRecords:[],omittedRecords:[]},
  });
  expect(response.status()).toBe(201);
  const {project}=await response.json() as {project:{id:string}};
  const last=documents[500]!;
  await authorizeAuthor("desktop", page, { path: `/desktop/projects/${project.id}/scenes/${last.id}` });
  await expect(manuscriptEditor(page)).toHaveText(last.markdown);
  const outline=page.locator('[data-workspace-panel="outline"]');
  await expect(outline.locator(".pg-outline-item")).toHaveCount(501);
  await expect(outline.locator(`[data-document-id="${last.id}"] .pg-outline-document`)).toHaveAttribute("aria-current","page");
  const create=outline.locator(".pg-library-create-document");
  await create.locator("summary").click();
  await create.getByLabel("文書名").fill("Large scene 502");
  await create.getByLabel("種類").selectOption("scene");
  await create.getByRole("button",{name:"作成",exact:true}).click();
  await expect(outline.locator(".pg-outline-item")).toHaveCount(502);
  await expect(page.getByRole("heading",{name:"Large scene 502",exact:true})).toBeVisible();
});

test("an evidence link opens Knowledge outside the current filter and ignores a late selection", async ({ page, authorizeAuthor }) => {
  const { project, scene, author } = await createOAuthWritingFixture(authorizeAuthor, page);
  const origin = new URL(page.url()).origin;
  const headers = { Origin: origin };
  const path = `/api/v1/persistence/projects/${project.id}`;
  const hidden = crypto.randomUUID();
  const visible = crypto.randomUUID();
  for (const [id, name] of [[hidden, "絞り込み外の知識"], [visible, "一覧に表示する知識"]] as const) {
    const response = await author.fetch(`${path}/nodes/${id}`, { method: "PUT", headers, data: {
      type: "person", name, attributes: {}, status: "confirmed", expectedVersion: null,
    } });
    expect(response.ok()).toBe(true);
  }
  const anchorId = crypto.randomUUID();
  const anchorPath = `${path}/documents/${scene.id}/anchors`;
  const anchor = await author.fetch(anchorPath, { method: "POST", headers, data: {
    id: anchorId, revisionId: scene.headRevisionId, fromUtf16: 0, toUtf16: 7, status: "confirmed",
  } });
  expect(anchor.ok()).toBe(true);
  const mention = await author.fetch(`${anchorPath}/${anchorId}/mentions`, { method: "POST", headers, data: { nodeId: hidden, status: "confirmed" } });
  expect(mention.ok()).toBe(true);
  await page.reload();
  await authorizeAuthor("desktop", page, { continueCurrentPage: true });
  await openResearchInspector(page);
  await page.getByLabel("名前または別名で検索").fill("一覧に表示する知識");
  const results = page.locator(".pg-knowledge-list li");
  await expect(results).toHaveCount(1);
  await expect(results).toContainText("一覧に表示する知識");
  const evidenceLink = page.getByRole("button", { name: "Knowledgeの根拠を表示", exact: true });
  const detail = page.getByRole("region", { name: "Knowledge詳細" });

  const detailPath = (url: URL) => url.pathname === `${path}/nodes/${hidden}`;
  const requestedDetail = page.waitForRequest(request => detailPath(new URL(request.url())));
  await evidenceLink.click();
  await requestedDetail;
  await expect(detail.getByRole("heading", { name: "絞り込み外の知識" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Knowledgeの根拠" })).toContainText("最初の本文。");
  await results.getByRole("button", { name: /一覧に表示する知識/ }).click();

  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route(detailPath, async route => {
    const response = await route.fetch();
    await gate;
    await route.fulfill({ response }).catch(() => undefined);
  });
  const lateRequest = page.waitForRequest(request => detailPath(new URL(request.url())));
  try {
    await evidenceLink.click();
    await lateRequest;
    await results.getByRole("button", { name: /一覧に表示する知識/ }).click();
    await expect(detail.getByRole("heading", { name: "一覧に表示する知識" })).toBeVisible();
  } finally { release(); }
  await page.unrouteAll({ behavior: "wait" });
  await expect(detail.getByRole("heading", { name: "一覧に表示する知識" })).toBeVisible();
  await expect(detail.getByRole("heading", { name: "絞り込み外の知識" })).toHaveCount(0);
});
