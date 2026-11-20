import { createHash } from "node:crypto";
import { expect, test } from "@playwright/test";
import { createPostgresPersistence } from "@codexia/persistence-postgres";
import type { KnowledgeAliasId, KnowledgeNodeId, ProjectId } from "@codexia/persistence-contracts";
import { createWritingFixture, openRevisionHistory, ownerLogin, manuscriptEditor } from "./postgres-fixture";

const authToken = process.env.CODEXIA_E2E_AUTH_TOKEN ?? "";
const databaseUrl = process.env.CODEXIA_E2E_DATABASE_URL;

test("Knowledge browse searches literal aliases and pages the same project on Desktop and Mobile", async ({ page }) => {
  expect(databaseUrl, "the browser acceptance server must use a disposable PostgreSQL database").toBeTruthy();
  const fixture = await createWritingFixture(page, "desktop", `Knowledge browse ${crypto.randomUUID()}`);
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
  const sameNameResponse = await page.request.get(url("同じ名前"));
  expect(sameNameResponse.ok()).toBe(true);
  const sameName = await sameNameResponse.json() as { nodes: Array<{ id: string }> };
  expect(sameName.nodes.map(node => node.id)).toEqual(duplicateIds);

  await page.reload();
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

  // An older same-epoch server ignores q/type/status and returns its legacy
  // `{nodes}` contract. The new UI must accept the payload without claiming
  // server search or complete coverage.
  const legacyResponse = await page.request.get(new URL(`/api/v1/persistence/projects/${fixture.project.id}/nodes?limit=500`, base).toString());
  const legacyNodes = (await legacyResponse.json() as { nodes: unknown[] }).nodes;
  expect(legacyNodes).toHaveLength(500);
  await search.fill("Browse 0001");
  await expect(page.locator(".pg-knowledge-list li")).toHaveCount(1);
  const oldServerRoute = async (route: import("@playwright/test").Route) => {
    const params = new URL(route.request().url()).searchParams;
    if (params.has("q")) await route.fulfill({ json: { nodes: legacyNodes.slice(0, 50) } });
    else if (params.get("limit") === "500") await route.fulfill({ json: { nodes: legacyNodes } });
    else await route.continue();
  };
  await page.route(nodeRoute, oldServerRoute);
  await search.fill("Browse 0000");
  await expect(page.locator(".pg-knowledge-list li")).toHaveCount(1);
  await expect(page.locator(".pg-knowledge p[role=status]")).toContainText("網羅状況は不明");
  await expect(page.locator(".pg-knowledge p[role=status]")).toContainText("500件");
  await expect(page.locator(".pg-knowledge p[role=status]")).toContainText("別名検索と続きの取得は利用できず");
  await expect(page.getByRole("button", { name: "続きのKnowledgeを読み込む" })).toHaveCount(0);
  await search.fill("Browse 0499");
  await expect(page.locator(".pg-knowledge-list li")).toHaveCount(1);
  await search.fill("Literal%_!Alias");
  await expect(page.locator(".pg-knowledge-list li")).toHaveCount(0);
  await expect(page.locator(".pg-knowledge p[role=status]")).toContainText("網羅状況は不明");
  await page.unroute(nodeRoute, oldServerRoute);
  await search.fill("");
  await expect(page.locator(".pg-knowledge-list li")).toHaveCount(50);
  await expect(page.getByLabel("種類で絞り込み").locator("option[value='my_custom_type']")).toBeAttached();

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(new URL(`/mobile/projects/${fixture.project.id}/scenes/${fixture.scene.id}?view=writing`, base).toString());
  await page.getByRole("navigation", { name: "モバイル画面" }).getByRole("button", { name: "知識", exact: true }).click();
  await expect(page.locator(".pg-knowledge")).toBeVisible();
  await search.fill("literal%_!alias");
  await expect(page.locator(".pg-knowledge-list li")).toHaveCount(1);
  await expect(page.locator(".pg-knowledge-list")).toContainText(longJapaneseName);
  await search.fill("");
  await expect(page.locator(".pg-knowledge-list li")).toHaveCount(50);
  await page.getByRole("button", { name: "続きのKnowledgeを読み込む" }).click();
  await expect(page.getByRole("status").filter({ hasText: "100件取得済み" })).toBeVisible();
});

test("PostgreSQL project pages expose records beyond 200 and deep links retain the requested identity", async ({ page }) => {
  test.setTimeout(120_000);
  expect(databaseUrl, "the browser acceptance server must use a disposable PostgreSQL database").toBeTruthy();
  await ownerLogin(page);
  const origin = new URL(page.url()).origin;
  // Seed more than two complete pages so a small, intentionally preloaded
  // disposable database cannot shrink the second page to a short tail.
  const projects = Array.from({ length: 405 }, (_, index) => ({ title: `Project pagination ${crypto.randomUUID()} ${index}` }));
  const created: Array<{ id: string; title: string }> = [];
  for (let offset = 0; offset < projects.length; offset += 10) {
    const batch = await Promise.all(projects.slice(offset, offset + 10).map(async (project) => {
      const response = await page.request.post(new URL("/api/v1/persistence/projects", origin).toString(), { headers: { Origin: origin }, data: project });
      expect(response.status()).toBe(201);
      return (await response.json() as { project: { id: string; title: string } }).project;
    }));
    created.push(...batch);
  }

  let pageRequests = 0;
  await page.route(/\/api\/v1\/persistence\/projects\?page=/u, async (route) => {
    pageRequests++;
    await route.continue();
  });
  const target = created[0]!;
  await page.goto(new URL(`/desktop/projects/${target.id}`, origin).toString());
  await expect(page.getByRole("heading", { name: "Database workspace" })).toBeVisible();
  await expect(page.getByRole("heading", { name: target.title, exact: true })).toBeVisible();
  await expect(page.getByLabel("作品", { exact: true })).toHaveValue(target.id);
  expect(pageRequests, "a direct project link must request its target without enumerating the project library").toBe(0);

  const library = page.getByLabel("作品と文書");
  const firstPageResponse = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === "/api/v1/persistence/projects" && url.searchParams.get("page") === "1" && !url.searchParams.has("cursor");
  });
  await library.getByRole("button", { name: "作品一覧を読み込む" }).click();
  const firstPage = await (await firstPageResponse).json() as { projects: Array<{ id: string }>; nextCursor: string | null };
  expect(firstPage.projects).toHaveLength(200);
  expect(firstPage.nextCursor).toBeTruthy();
  await expect(library.getByRole("button", { name: "さらに作品を読み込む" })).toBeVisible();
  const secondPageResponse = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === "/api/v1/persistence/projects" && url.searchParams.get("page") === "1" && url.searchParams.has("cursor");
  });
  await library.getByRole("button", { name: "さらに作品を読み込む" }).click();
  const secondPage = await (await secondPageResponse).json() as { projects: Array<{ id: string }>; nextCursor: string | null };
  expect(secondPage.projects).toHaveLength(200);
  expect(secondPage.projects.some((item) => !firstPage.projects.some((first) => first.id === item.id))).toBe(true);
  await expect(page.getByLabel("作品", { exact: true }).locator(`option[value="${target.id}"]`)).toBeAttached();
  await expect(page.getByText(/読み込み済みの作品: 40[0-1]/u)).toBeVisible();
  expect(pageRequests).toBe(2);

  const missingId = crypto.randomUUID();
  await page.goto(new URL(`/desktop/projects/${missingId}`, origin).toString());
  await expect(page.getByRole("main").getByRole("alert")).toContainText(missingId);
  await expect(page.getByLabel("作品", { exact: true })).toHaveValue(missingId);
  expect(pageRequests, "an unavailable direct link must not silently fall back to library enumeration").toBe(2);

});

test("outline supports guarded keyboard navigation, search, zoom and mobile sizing", async ({ page }) => {
  expect(databaseUrl).toBeTruthy();
  const fixture = await createWritingFixture(page, "desktop", `Outline ${crypto.randomUUID()}`);
  const headers = { Origin: new URL(page.url()).origin };
  const create = async (parentId: string | undefined, kind: string, title: string, orderKey: string) => {
    const response = await page.request.post(`/api/v1/persistence/projects/${fixture.project.id}/documents`, { headers: { ...headers, "Idempotency-Key": crypto.randomUUID() }, data: { ...(parentId ? { parentId } : {}), kind, title, orderKey, markdown: "" } });
    expect(response.status()).toBe(201);
    return (await response.json() as { document: { id: string; title: string } }).document;
  };
  const volume = await create(undefined, "volume", "Volume One", "0");
  const chapter = await create(volume.id, "chapter", "Chapter One", "0");
  const nestedScene = await create(chapter.id, "scene", `Outline scene ${crypto.randomUUID()}`, "0");
  await page.goto(`/desktop/projects/${fixture.project.id}/scenes/${nestedScene.id}`);
  const outline = page.locator('[data-workspace-panel="outline"]');
  const rows = outline.locator(".pg-outline-document");
  await rows.first().focus();
  await rows.first().press("ArrowDown");
  await expect(rows.nth(1)).toBeFocused();
  await rows.nth(1).press("Home");
  await expect(rows.first()).toBeFocused();
  const leaf = outline.getByRole("button", { name: `${nestedScene.title} シーン` });
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
  await page.goto(`/mobile/projects/${fixture.project.id}/scenes/${nestedScene.id}?view=writing`);
  await expect(page.getByRole("heading", { name: nestedScene.title, exact: true })).toBeVisible();
  await page.getByRole("button", { name: "構成" }).click();
  await expect(page.locator(".pg-outline-document").first()).toBeVisible();
  await page.evaluate(() => { document.body.style.zoom = "200%"; });
  await expect(page.locator(".pg-outline-document").first()).toBeVisible();
});

async function openResearchInspector(page: import("@playwright/test").Page) {
  const toolbar = page.getByRole("toolbar", { name: "ワークスペース配置" });
  await toolbar.getByRole("button", { name: "調査", exact: true }).click();
  await expect(page.locator('[data-workspace-panel="inspector"]')).toBeVisible();
  const knowledgeTools = page.locator(".pg-knowledge-tools");
  if (await knowledgeTools.count() && !await knowledgeTools.evaluate((element) => (element as HTMLDetailsElement).open)) {
    await knowledgeTools.locator("summary").click();
  }
}

test("replays ambiguous project and document creates with retained client intent", async ({ page }) => {
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
    documentBodies.push(body);
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

  await ownerLogin(page, "/desktop/");
  const outline = page.locator('[data-workspace-panel="outline"]');
  await outline.locator(".pg-library-create > summary").click();
  await outline.getByLabel("作品名").fill(projectTitle);
  await outline.locator(".pg-library-create").getByRole("button", { name: "作成", exact: true }).click();
  await expect(page.getByRole("main", { name: "PostgreSQL原稿編集" }).getByText("synthetic gateway timeout", { exact: true })).toBeVisible();
  expect(projectReadMissed).toBe(true);
  await expect(outline.getByLabel("作品名")).toHaveValue(projectTitle);
  await outline.locator(".pg-library-create").getByRole("button", { name: "作成", exact: true }).click();
  await expect(page.getByRole("heading", { name: projectTitle, exact: true })).toBeVisible();

  const projectsResponse = await page.request.get("/api/v1/persistence/projects");
  expect(projectsResponse.ok()).toBe(true);
  const projects = await projectsResponse.json() as Array<{ id: string; title: string }>;
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
  const projectsAfterSameTitle = await page.request.get("/api/v1/persistence/projects");
  const sameTitleProjects = (await projectsAfterSameTitle.json() as Array<{ id: string; title: string }>).filter((item) => item.title === projectTitle);
  expect(sameTitleProjects).toHaveLength(2);
  expect(projectBodies).toHaveLength(3);
  expect(projectId).not.toBe(projectBodies[0]?.id);

  const createDocument = outline.locator(".pg-library-create-document");
  await createDocument.locator("summary").click();
  await createDocument.getByLabel("文書名").fill(documentTitle);
  await createDocument.getByRole("button", { name: "作成", exact: true }).click();
  await expect(page.getByRole("main", { name: "PostgreSQL原稿編集" }).getByText("synthetic gateway timeout", { exact: true })).toBeVisible();
  expect(documentReadMissed).toBe(true);
  await expect(createDocument.getByLabel("文書名")).toHaveValue(documentTitle);
  await createDocument.getByRole("button", { name: "作成", exact: true }).click();
  await expect(page.getByRole("heading", { name: documentTitle, exact: true })).toBeVisible();

  const documentsResponse = await page.request.get(`/api/v1/persistence/projects/${projectId}/documents`);
  expect(documentsResponse.ok()).toBe(true);
  const documents = (await documentsResponse.json() as { documents: Array<{ id: string; title: string }> }).documents;
  expect(documents.filter((item) => item.title === documentTitle)).toHaveLength(1);
  expect(documentBodies).toHaveLength(2);
  expect(documentBodies[1]).toEqual(documentBodies[0]);

  await createDocument.getByLabel("文書名").fill(documentTitle);
  await createDocument.getByRole("button", { name: "作成", exact: true }).click();
  await expect.poll(async () => {
    const response = await page.request.get(`/api/v1/persistence/projects/${projectId}/documents`);
    const { documents } = await response.json() as { documents: Array<{ id: string; title: string }> };
    return documents.filter((item) => item.title === documentTitle).length;
  }).toBe(2);
  const afterSecondCreate = await page.request.get(`/api/v1/persistence/projects/${projectId}/documents`);
  const allDocuments = (await afterSecondCreate.json() as { documents: Array<{ id: string; title: string }> }).documents;
  expect(allDocuments.filter((item) => item.title === documentTitle)).toHaveLength(2);
  expect(documentBodies).toHaveLength(3);
  expect(documentBodies[2]?.documentId).not.toBe(documentBodies[0]?.documentId);
  expect(documentBodies[2]?.idempotencyKey).not.toBe(documentBodies[0]?.idempotencyKey);
});


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

for (const shell of ["desktop", "mobile"] as const) {
  test(`${shell} standalone authoring opens the first project and document forms from the empty editor`, async ({ page }) => {
    await page.setViewportSize(shell === "desktop" ? { width: 1280, height: 900 } : { width: 390, height: 844 });
    let showProject = false;
    await page.route((url) => url.pathname === "/api/v1/persistence/projects", async (route) => {
      if (!showProject && route.request().method() === "GET") return route.fulfill({ json: [] });
      if (route.request().method() !== "POST") return route.continue();
      const response = await route.fetch();
      showProject = response.ok();
      await route.fulfill({ response });
    });
    await ownerLogin(page, shell === "desktop" ? "/desktop/" : "/mobile/?view=writing");
    const firstProject = page.getByRole("button", { name: "最初の作品を作成" });
    await firstProject.click();
    const projectName = page.getByLabel("作品名", { exact: true });
    await expect(projectName).toBeFocused();
    if (shell === "mobile") {
      await page.getByRole("navigation").getByRole("button", { name: "書く", exact: true }).click();
    } else {
      await page.locator(".pg-library-create > summary").click();
    }
    await expect(firstProject).toBeVisible();
    await firstProject.click();
    await expect(projectName).toBeFocused();
    await projectName.fill(`Empty state ${shell} ${crypto.randomUUID()}`);
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
    await expect(page.getByText("PostgreSQLへ保存済み", { exact: true })).toBeVisible();
  });
}

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

  const outline = page.locator('[data-workspace-panel="outline"]');
  await outline.locator(".pg-library-create > summary").click();
  await outline.getByLabel("作品名").fill(projectTitle);
  await outline.locator(".pg-library-create").getByRole("button", { name: "作成", exact: true }).click();
  await expect(page.getByRole("heading", { name: projectTitle })).toBeVisible();
  const createDocument = outline.locator(".pg-library-create-document");
  await createDocument.locator("summary").click();
  await createDocument.getByLabel("文書名").fill(documentTitle);
  await createDocument.getByRole("button", { name: "作成", exact: true }).click();

  const editor = page.getByRole("textbox", { name: "本文", exact: true });
  await expect(editor).toBeVisible();
  await editor.fill(firstDraft);
  await expect(page.getByText("PostgreSQLへ保存済み")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("IndexedDB回復Journalに保存済み")).toBeVisible();

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
  await otherPage.goto("/desktop/?store=postgres");
  await expect(otherPage.getByRole("heading", { name: "Database workspace" })).toBeVisible();
  await otherPage.getByLabel("作品", { exact: true }).selectOption({ label: projectTitle });
  const otherDocument = otherPage.locator(".pg-document-list").getByRole("button", { name: new RegExp(documentTitle, "u") });
  await expect(otherDocument).toBeVisible();
  await otherDocument.click();
  const otherEditor = otherPage.getByRole("textbox", { name: "本文", exact: true });
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
  await otherPage.getByLabel("作品", { exact: true }).selectOption({ label: projectTitle });
  await expect(otherPage.locator(".pg-document-list").getByRole("button", { name: new RegExp(documentTitle, "u") })).toBeVisible();
  await otherPage.locator(".pg-document-list").getByRole("button", { name: new RegExp(documentTitle, "u") }).click();
  const recoveredEditor = otherPage.getByRole("textbox", { name: "本文", exact: true });
  await expect(recoveredEditor).toContainText(interruptedDraft);
  await expect(otherPage.getByText("PostgreSQLへ保存済み")).toBeVisible({ timeout: 15_000 });
  await otherPage.close();
  expect(contentSecurityPolicyViolations).toEqual([]);
});


test("Knowledge relation pagination keeps the forty-first fetched relation actionable", async ({ page }) => {
  expect(databaseUrl).toBeTruthy();
  const { project } = await createWritingFixture(page);
  const path = `/api/v1/persistence/projects/${project.id}/nodes`;
  const headers = { Origin: new URL(page.url()).origin };
  const source = crypto.randomUUID(), target = crypto.randomUUID();
  for (const [id, name] of [[source, "関係の中心"], [target, "関係先"]]) {
    const response = await page.request.put(`${path}/${id}`, { headers, data: {
      type: "person", name, attributes: {}, status: "confirmed", expectedVersion: null,
    } });
    expect(response.ok(), await response.text()).toBe(true);
  }
  for (let i = 0; i < 41; i++) {
    const response = await page.request.post(`${path}/${source}/relations`, { headers, data: {
      id: crypto.randomUUID(), targetId: target, type: `関係 ${String(i).padStart(2, "0")}`, attributes: {}, validity: {}, status: "proposed", expectedVersion: null,
    } });
    expect(response.status(), await response.text()).toBe(201);
  }
  const data = await page.request.get(`${path}/${source}`);
  const { relations } = await data.json() as { relations: Array<{ id: string; type: string; status: string }> };
  expect(relations).toHaveLength(41);
  const last = relations[40]!;
  await page.reload();
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
    const response = await page.request.get(`${path}/${source}`);
    const result = await response.json() as { relations: Array<{ id: string; status: string }> };
    return result.relations.find(relation => relation.id === last.id)?.status;
  }).toBe("confirmed");
});

for (const shell of ["desktop", "mobile"] as const) {
  test(`${shell} move destinations exclude descendants and identify same-title paths`, async ({ page }) => {
    if (shell === "mobile") await page.setViewportSize({ width: 390, height: 844 });
    await ownerLogin(page, `/${shell}/`);
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
    const archive = await page.request.post("/api/v1/persistence/import", {
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
    await page.goto(`/${shell}/projects/${project.id}/scenes/${volume.id}${shell === "mobile" ? "?view=writing" : ""}`);
    await expect(manuscriptEditor(page)).toContainText(volume.markdown);
    if (shell === "mobile") await page.getByRole("button", { name: "構成", exact: true }).click();
    const scope = shell === "mobile" ? page.locator("ion-modal.mobile-shell-reference-modal") : page.locator('[data-workspace-panel="outline"]');
    await scope.getByText("選択文書の構成を変更", { exact: true }).click();
    const targets = scope.getByLabel("移動先");
    for (const unavailable of [volume, child, grandchild]) await expect(targets.locator(`option[value="${unavailable.id}"]`)).toHaveCount(0);
    await expect(targets.locator(`option[value="${first.id}"]`)).toContainText("別巻甲");
    await expect(targets.locator(`option[value="${second.id}"]`)).toContainText("別巻乙");

    if (shell === "desktop") {
      await targets.selectOption(first.id);
      const candidate = await page.request.get(`${projectRoute}/${first.id}`);
      expect(candidate.ok()).toBe(true);
      const { document: current } = await candidate.json() as { document: { version: number } };
      const reassigned = await page.request.patch(`${projectRoute}/${first.id}/metadata`, {
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
        const response = await page.request.get(`${projectRoute}/${volume.id}`);
        return ((await response.json()) as { document: { parentId: string | null } }).document.parentId;
      }).toBe(second.id);
    }
  });
}

test("revision comparison separates distant manuscript edits", async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  const { project, scene } = await createWritingFixture(page);
  const path = `/api/v1/persistence/projects/${project.id}/documents/${scene.id}`;
  const response = await page.request.get(path);
  expect(response.ok()).toBe(true);
  let { revision } = await response.json() as { revision: { id: string; markdown: string } };
  const middle = Array.from({ length: 200 }, (_, index) => `変わらない第 ${index} 段落には｜青空《あおぞら》が続きます。\n\n`).join("");
  for (const value of [`冒頭は旧稿。\n\n${middle}結末には旧稿。\n`, `冒頭は改稿。\n\n${middle}結末には新しい追加行。\n`]) {
    const saved = await page.request.patch(path, {
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
  for (const shell of ["desktop", "mobile"] as const) {
    if (shell === "mobile") await page.setViewportSize({ width: 320, height: 760 });
    await page.goto(`/${shell}/projects/${project.id}/scenes/${scene.id}${shell === "mobile" ? "?view=writing" : ""}`);
    await expect(manuscriptEditor(page)).toContainText("冒頭は改稿。");
    await openRevisionHistory(page);
    const previous = page.getByRole("region", { name: "Revision履歴" }).locator("article").filter({ hasText: "冒頭は旧稿。" });
    const diff = previous.locator(".pg-revision-diff-preview");
    await expect(diff).toHaveCount(0);
    const workerStarted = page.waitForEvent("worker");
    await previous.getByText("最新版との違い", { exact: true }).click();
    expect(new URL((await workerStarted).url()).origin).toBe(new URL(page.url()).origin);
    const hunks = diff.locator(".pg-revision-diff-hunk");
    await expect(hunks).toHaveCount(2);
    await expect(diff).toContainText(revision.id);
    await expect(diff).toContainText("結末には新しい追加行。");
    await expect(diff).not.toContainText("第 100 段落");
    if (shell === "mobile") {
      expect(await hunks.first().evaluate(element => getComputedStyle(element).gridTemplateColumns.split(" ").length)).toBe(1);
    }
  }
});

test("a 501-document PostgreSQL work opens its final scene through the canonical deep link", async ({page}) => {
  test.setTimeout(90000);
  await ownerLogin(page);
  const title = `Long outline ${crypto.randomUUID()}`;
  const documents = Array.from({length:501},(_,i)=>({
    id:crypto.randomUUID(), parentId:null, kind:"scene", title:`Large scene ${i+1}`,
    orderKey:String(i).padStart(8,"0"), markdown:`本文 ${i+1}`, revisionId:crypto.randomUUID(),
  }));
  const response=await page.request.post(new URL("/api/v1/persistence/import",page.url()).toString(),{
    headers:{Origin:new URL(page.url()).origin},
    data:{format:"codexia-work/v1",project:{title,settings:{}},documents,
      knowledge:{nodes:[],aliases:[],relations:[]},
      evidence:{anchors:[],mentions:[],assertions:[],assertionEvidence:[],unresolved:{anchors:[],mentions:[],assertionEvidence:[]}},
      moduleRecords:[],omittedRecords:[]},
  });
  expect(response.status()).toBe(201);
  const {project}=await response.json() as {project:{id:string}};
  const last=documents[500]!;
  await page.goto(new URL(`/desktop/projects/${project.id}/scenes/${last.id}`,page.url()).toString());
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
