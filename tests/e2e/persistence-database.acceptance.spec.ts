import { expect, test } from "@playwright/test";
import { createWritingFixture, openRevisionHistory, ownerLogin, manuscriptEditor } from "./postgres-fixture";

const authToken = process.env.CODEXIA_E2E_AUTH_TOKEN ?? "";
const databaseUrl = process.env.CODEXIA_E2E_DATABASE_URL;

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
