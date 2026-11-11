import { expect, test, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import type { ProposalStatus } from "@codexia/contracts";

const authToken = process.env.CODEXIA_E2E_AUTH_TOKEN ?? "";
const zukanPath = "meta/scriptorium/modules/story/zukan-suggestions.jsonl";
const scenePath = "plot/volumes/vol-review/chapters/ch-review/scenes/scene-review.yaml";
const manuscriptPath = "manuscript/vol-review/ch-review/scene-review.md";

interface Project {
  id: string;
  title: string;
}

interface ProposalActionResult {
  ok: boolean;
  snapshot: unknown;
  data?: Record<string, unknown>;
  proposals?: Array<{ id: string; operations: Array<{ id: string; writes: Array<{ path: string; content: string | null }> }> }>;
  error?: { code: string; message: string };
}

async function createReviewProject(page: Page): Promise<Project> {
  const origin = new URL(page.url()).origin;
  const title = `Review Contributions ${randomUUID()}`;
  const projectResponse = await page.request.post(`${origin}/api/projects`, { headers: { Origin: origin }, data: { title } });
  expect(projectResponse.status(), await projectResponse.text()).toBe(201);
  const project = await projectResponse.json() as Project;
  const snapshotResponse = await page.request.get(`${origin}/api/projects/${encodeURIComponent(project.id)}/snapshot`);
  expect(snapshotResponse.ok(), await snapshotResponse.text()).toBe(true);
  const current = await snapshotResponse.json() as { snapshot: { projectId: string; projectVersion: number } };
  expect(current.snapshot.projectId).toBe(project.id);
  const suggestion = {
    id: "zukan-review-queue-item",
    entityId: "char-akari",
    blockPath: "lead.0",
    proposedText: "Akari collects old maps.",
    evidence: [{ quote: "『この古地図を探している。』", sceneId: "scene-review" }],
    status: "pending",
    source: "manuscript",
    kind: "habit",
    sourceSessionId: null,
    sourceTurnRange: null,
    confidence: "high",
    createdAt: "2026-10-17T00:00:00.000Z",
    updatedAt: "2026-10-17T00:00:00.000Z",
  };
  const fixtureFiles = {
    "bible/characters/char-akari/profile.yaml": [
      "id: char-akari",
      "type: character",
      "name: Akari",
      "aliases: [Akari]",
      "notes:",
      "  lead: []",
      "  sections: []",
      "voicePatterns:",
      "  firstPerson: [私]",
      "",
    ].join("\n"),
    "bible/characters/char-sumi/profile.yaml": [
      "id: char-sumi",
      "type: character",
      "name: Sumi",
      "aliases: [Sumi]",
      "notes:",
      "  lead: []",
      "  sections: []",
      "voicePatterns:",
      "  firstPerson: [僕]",
      "",
    ].join("\n"),
    [manuscriptPath]: "# Review Scene\n\n『この古地図を探している。』\n",
    [zukanPath]: `${JSON.stringify(suggestion)}\n`,
  } satisfies Record<string, string>;
  const writes = [
    { path: "plot/volumes/vol-review/volume.yaml", revision: null, content: "id: vol-review\ntype: volume\nname: Review Volume\norder: 1\n" },
    { path: "plot/volumes/vol-review/chapters/ch-review/chapter.yaml", revision: null, content: "id: ch-review\ntype: chapter\nname: Review Chapter\nvolume: vol-review\norder: 1\n" },
    { path: scenePath, revision: null, content: [
      "id: scene-review",
      "type: scene",
      "name: Review Scene",
      "volume: vol-review",
      "chapter: ch-review",
      "order: 1",
      "appears: [char-akari, char-sumi]",
      "speakerCount: 2",
      `manuscript: ${manuscriptPath}`,
      "",
    ].join("\n") },
    ...Object.entries(fixtureFiles).map(([path, content]) => ({ path, revision: null, content })),
  ];
  const operation = {
    id: randomUUID(),
    generation: 0,
    projectId: project.id,
    baseProjectVersion: current.snapshot.projectVersion,
    effect: "structure",
    reads: writes.map(({ path, revision }) => ({ path, revision })),
    writes,
    message: "Seed Story and Speaker review data in PostgreSQL",
  };
  const proposalResponse = await page.request.post(`${origin}/api/projects/${encodeURIComponent(project.id)}/proposals`, {
    headers: { Origin: origin },
    data: { id: randomUUID(), snapshot: current.snapshot, operations: [operation] },
  });
  expect(proposalResponse.status(), await proposalResponse.text()).toBe(201);
  const proposal = await proposalResponse.json() as { id: string };
  const approvalResponse = await page.request.post(`${origin}/api/projects/${encodeURIComponent(project.id)}/approvals`, {
    headers: { Origin: origin },
    data: { proposalId: proposal.id, operationIds: [operation.id] },
  });
  expect(approvalResponse.status(), await approvalResponse.text()).toBe(204);
  const applyResponse = await page.request.post(`${origin}/api/projects/${encodeURIComponent(project.id)}/apply`, { headers: { Origin: origin }, data: operation });
  expect(applyResponse.status(), await applyResponse.text()).toBe(201);
  const seededSnapshot = await page.request.get(`${origin}/api/projects/${encodeURIComponent(project.id)}/snapshot`);
  expect(seededSnapshot.ok(), await seededSnapshot.text()).toBe(true);
  const seeded = await seededSnapshot.json() as { files: Array<{ path: string; content: string }> };
  const seededFiles = new Map(seeded.files.map((file) => [file.path, file.content]));
  expect(seededFiles.get(zukanPath)).toContain("zukan-review-queue-item");
  expect(seededFiles.get(scenePath)).toContain("char-akari");
  expect(seededFiles.get(manuscriptPath)).toContain("この古地図を探している");
  return project;
}

async function signIn(page: Page): Promise<void> {
  await page.goto("/desktop/");
  await page.getByLabel("アクセス・トークン").fill(authToken);
  await page.getByRole("button", { name: "PostgreSQL作品を開く" }).click();
  await expect(page.getByRole("heading", { name: "Database workspace" })).toBeVisible();
}

function actionResponse(response: { url(): string; request(): { method(): string } }, actionId: string): boolean {
  const url = new URL(response.url());
  return response.request().method() === "POST" && url.pathname.endsWith(`/actions/${actionId}`);
}

async function openWorkspaceContributionPanel(page: Page, id: string, title: string): Promise<ReturnType<Page["locator"]>> {
  const toolbar = page.getByRole("toolbar", { name: "Workspace layout controls" });
  await toolbar.getByRole("button", { name: "Research", exact: true }).click();
  await page.getByRole("tablist", { name: "Panel tabs" }).getByRole("tab", { name: title, exact: true }).click();
  const panel = page.locator('[data-workspace-panel="module:' + id + '"]');
  await expect(panel).toBeVisible();
  return panel;
}

async function openWorkspaceReviewPanel(page: Page): Promise<void> {
  const toolbar = page.getByRole("toolbar", { name: "Workspace layout controls" });
  await toolbar.getByRole("button", { name: "Review", exact: true }).click();
  await page.getByRole("tablist", { name: "Panel tabs" }).getByRole("tab", { name: "提案レビュー", exact: true }).click();
  await expect(page.locator('[data-workspace-panel="review"]')).toBeVisible();
}

async function readProposalStatus(page: Page, projectId: string, proposalId: string): Promise<ProposalStatus> {
  const origin = new URL(page.url()).origin;
  const response = await page.request.get(
    `${origin}/api/projects/${encodeURIComponent(projectId)}/proposals/${encodeURIComponent(proposalId)}`,
  );
  expect(response.ok(), await response.text()).toBe(true);
  return await response.json() as ProposalStatus;
}

test("full profile renders Story and Speaker review queues and turns both author decisions into unapproved Core proposals", async ({ page }) => {
  test.setTimeout(180_000);
  test.skip(process.env.CODEXIA_PROFILE !== "full", "Story and Speaker review contributions are selected by the full profile.");
  expect(authToken.length).toBeGreaterThanOrEqual(32);
  await signIn(page);
  const project = await createReviewProject(page);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Database workspace" })).toBeVisible();
  await page.locator("#pg-project").selectOption(project.id);
  await expect(page.getByRole("heading", { name: "Review Volume" })).toBeVisible({ timeout: 30_000 });

    const zukanListResponse = page.waitForResponse((response) => actionResponse(response, "story.zukan-suggestions.list"), { timeout: 60_000 });
    const zukanPanel = await openWorkspaceContributionPanel(page, "story.zukan-review", "Zukan suggestions");
    const zukanResponse = await zukanListResponse;
    expect(zukanResponse.ok()).toBe(true);
    const zukanResult = await zukanResponse.json() as { ok: boolean; data?: { pendingCount?: number; suggestions?: Array<Record<string, unknown>> } };
    expect(zukanResult.ok).toBe(true);
    expect(zukanResult.data?.pendingCount).toBe(1);
    expect(zukanResult.data?.suggestions?.some((item) => item.id === "zukan-review-queue-item" && item.status === "pending")).toBe(true);
    await expect(zukanPanel.locator('[data-contribution="story.zukan-review"]')).toBeVisible();
    await expect(zukanPanel.locator('[data-contribution="story.zukan-review"]').getByRole("heading", { name: "Zukan suggestions" })).toBeVisible();
    await expect(zukanPanel.getByText("1 pending suggestion(s)")).toBeVisible();
    await expect(zukanPanel.getByText("Akari collects old maps.")).toBeVisible();

    const zukanProposalResponse = page.waitForResponse((response) => actionResponse(response, "story.zukan-suggestions.reject"), { timeout: 30_000 });
    await zukanPanel.getByRole("button", { name: "Propose rejection" }).click();
    const zukanAction = await zukanProposalResponse;
    expect(zukanAction.ok()).toBe(true);
    const zukanProposalResult = await zukanAction.json() as ProposalActionResult;
    expect(zukanProposalResult.ok).toBe(true);
    expect(zukanProposalResult.data?.suggestion).toMatchObject({ id: "zukan-review-queue-item", status: "rejected" });
    const zukanProposalId = zukanProposalResult.proposals?.[0]?.id;
    expect(zukanProposalId).toBeTruthy();
    const zukanStatus = await readProposalStatus(page, project.id, zukanProposalId!);
    expect(zukanStatus.state).toBe("proposed");
    expect(zukanStatus.approvedOperationIds).toEqual([]);
    expect(zukanStatus.applications).toEqual([]);
    expect(zukanStatus.appliedOperationIds).toEqual([]);
    expect(zukanStatus.proposal.operations[0]?.writes.map((write) => write.path)).toContain(zukanPath);
    // A profile refresh may remount the module and clear its transient notice.
    // The proposal must still leave the canonical suggestion pending until approval.
    await expect(zukanPanel.getByText("1 pending suggestion(s)")).toBeVisible();
    await expect(zukanPanel.getByText("Akari collects old maps.")).toBeVisible();

    const speakerQueueResponse = page.waitForResponse((response) => actionResponse(response, "speaker.review.queue"), { timeout: 120_000 });
    const speakerPanel = await openWorkspaceContributionPanel(page, "speaker.review", "話者確認キュー");
    const speakerResponse = await speakerQueueResponse;
    expect(speakerResponse.ok()).toBe(true);
    const speakerResult = await speakerResponse.json() as { ok: boolean; data?: { rows?: Array<{ sceneId?: string; attribution?: { text?: string; confidence?: string } }> } };
    expect(speakerResult.ok).toBe(true);
    const unresolved = speakerResult.data?.rows?.filter((row) => row.sceneId === "scene-review" && row.attribution?.confidence !== "high") ?? [];
    expect(unresolved.length).toBeGreaterThan(0);
    expect(unresolved.some((row) => row.attribution?.text === "『この古地図を探している。』")).toBe(true);

    await expect(speakerPanel.locator('[data-contribution="speaker.review"]')).toBeVisible();
    await expect(speakerPanel.getByRole("heading", { name: "未確定・低信頼の話者帰属" })).toBeVisible();
    await expect(speakerPanel.getByText("『この古地図を探している。』")).toBeVisible();
    await expect(speakerPanel.getByText(new RegExp(`${unresolved.length} 件。`))).toBeVisible();

    const speakerRow = speakerPanel.locator("article").filter({ hasText: "『この古地図を探している。』" }).first();
    await speakerRow.getByLabel("話者").selectOption("char-akari");
    const speakerProposalResponse = page.waitForResponse((response) => actionResponse(response, "speaker.override"), { timeout: 30_000 });
    await speakerRow.getByRole("button", { name: "この話者をレビュー案として確定" }).click();
    const speakerAction = await speakerProposalResponse;
    expect(speakerAction.ok()).toBe(true);
    const speakerProposalResult = await speakerAction.json() as ProposalActionResult;
    expect(speakerProposalResult.ok).toBe(true);
    const speakerProposalId = speakerProposalResult.proposals?.[0]?.id;
    expect(speakerProposalId).toBeTruthy();
    const speakerStatus = await readProposalStatus(page, project.id, speakerProposalId!);
    expect(speakerStatus.state).toBe("proposed");
    expect(speakerStatus.approvedOperationIds).toEqual([]);
    expect(speakerStatus.applications).toEqual([]);
    expect(speakerStatus.appliedOperationIds).toEqual([]);
    expect(speakerStatus.proposal.operations[0]?.writes.map((write) => write.path)).toEqual(expect.arrayContaining([
      scenePath,
      "meta/scriptorium/modules/speaker/corrections.jsonl",
    ]));
    await expect(speakerPanel.getByText("確定案をレビューキューに作成しました。承認後に正本へ反映されます。")).toBeVisible();

    const origin = new URL(page.url()).origin;
    const proposedSnapshotResponse = await page.request.get(`${origin}/api/projects/${encodeURIComponent(project.id)}/snapshot`);
    expect(proposedSnapshotResponse.ok(), await proposedSnapshotResponse.text()).toBe(true);
    const proposedSnapshot = await proposedSnapshotResponse.json() as { files: Array<{ path: string; content: string }> };
    const proposedFiles = new Map(proposedSnapshot.files.map((file) => [file.path, file.content]));
    expect(JSON.parse(proposedFiles.get(zukanPath)!.trim()).status).toBe("pending");
    expect(proposedFiles.get(scenePath)).not.toMatch(/^speakerOverrides:/mu);
    expect(proposedFiles.has("meta/scriptorium/modules/speaker/corrections.jsonl")).toBe(false);

    await page.getByRole("tablist", { name: "Panel tabs" }).getByRole("tab", { name: "作品と構成", exact: true }).click();
    await page.locator(".pg-document-list")
      .getByRole("button", { name: /Review Scene/u }).click();
    await expect(page.getByRole("heading", { name: "Review Scene" })).toBeVisible();
    await page.getByRole("button", { name: "モバイルUIへ" }).click();
    await expect(page).toHaveURL(new RegExp("/mobile/projects/" + encodeURIComponent(project.id) + "/scenes/scene-review"));
    await page.getByRole("navigation", { name: "モバイル画面" }).getByRole("button", { name: "道具", exact: true }).click();
    await expect(page.locator(".proposal-review").getByRole("heading", { name: "確認待ちの提案" })).toBeVisible();
    await page.reload();
    await page.getByRole("navigation", { name: "モバイル画面" }).getByRole("button", { name: "道具", exact: true }).click();
    const mobileZukanCard = page.locator(".proposal-card").filter({ hasText: zukanProposalId! });
    const mobileSpeakerCard = page.locator(".proposal-card").filter({ hasText: speakerProposalId! });
    await expect(mobileZukanCard).toContainText("承認待ち");
    await expect(mobileSpeakerCard).toContainText("承認待ち");
    await mobileZukanCard.getByRole("button", { name: "承認して PostgreSQL Revision" }).click();
    await expect(mobileZukanCard).toContainText("PostgreSQL 保存済み");
    const mobileApprovedZukanStatus = await readProposalStatus(page, project.id, zukanProposalId!);
    const mobileZukanOperationIds = zukanProposalResult.proposals?.[0]?.operations.map((operation) => operation.id) ?? [];
    expect(mobileApprovedZukanStatus.approvedOperationIds).toEqual(mobileZukanOperationIds);
    expect(mobileApprovedZukanStatus.appliedOperationIds).toEqual(mobileZukanOperationIds);
    expect(mobileApprovedZukanStatus.applications).toHaveLength(mobileZukanOperationIds.length);

    await page.getByRole("navigation", { name: "モバイル画面" }).getByRole("button", { name: "設定", exact: true }).click();
    await page.getByRole("button", { name: "Desktop版へ切り替え" }).click();
    await expect(page).toHaveURL(new RegExp("/desktop/projects/" + encodeURIComponent(project.id) + "/scenes/scene-review"));
    await openWorkspaceReviewPanel(page);
    await expect(page.locator(".proposal-card").filter({ hasText: zukanProposalId! })).toContainText("PostgreSQL 保存済み");
    await expect(page.locator(".proposal-card").filter({ hasText: speakerProposalId! })).toContainText("承認待ち");
    const finalSnapshotResponse = await page.request.get(`${origin}/api/projects/${encodeURIComponent(project.id)}/snapshot`);
    expect(finalSnapshotResponse.ok(), await finalSnapshotResponse.text()).toBe(true);
    const finalSnapshot = await finalSnapshotResponse.json() as { files: Array<{ path: string; content: string }> };
    const finalFiles = new Map(finalSnapshot.files.map((file) => [file.path, file.content]));
    expect(JSON.parse(finalFiles.get(zukanPath)!.trim()).status).toBe("rejected");
    expect(finalFiles.get(scenePath)).not.toMatch(/^speakerOverrides:/mu);
    expect(finalFiles.has("meta/scriptorium/modules/speaker/corrections.jsonl")).toBe(false);
});
