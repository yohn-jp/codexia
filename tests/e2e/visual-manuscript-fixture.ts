import { createHash, randomUUID } from "node:crypto";
import type { Page } from "@playwright/test";
import { expect, type AuthorizeAuthor, type AuthorSession } from "./author-oauth-fixture";
import { expectServerSaved, manuscriptEditor } from "./postgres-fixture";

const prose = [
  "　港町の朝は、潮の匂いと、まだ眠っている街の静けさから始まる。凪は古い灯台の階段を上りながら、昨夜から胸に残っている小さな違和感を、ひとつずつ確かめていた。",
  "　最上階の窓を開けると、海の向こうに薄い金色の線が見えた。水平線は昨日よりも近い。波間に浮かぶ黒い影は、誰も地図に描かなかった島の輪郭に似ていた。",
  "「お父さん、海が少し変だよ」",
  "　返事のかわりに、手の中の羅針盤がかすかな音を立てた。針は北ではなく、街の地下へ向いている。真鍮の縁には、祖母が旅立った年に刻まれた小さな傷が残っていた。",
  "　石段の先にあったのは、海水に満たされた書庫だった。天井まで続く本棚のあいだを、青白い光がゆっくりと流れている。表紙にはどれも、まだ起きていない出来事の日付が記されていた。",
  "　凪は一冊を開いた。そこには、灯台の窓辺で自分が羅針盤を握る姿が、今と同じ服のまま描かれている。最後の一行だけが濡れて読めなかった。ページをめくる音が、遠くの波と重なって響く。",
  "　ここにある記録は、過去ではない。誰かが選ばなかった未来の、静かな目録なのだ。凪は濡れた余白へ指を置き、まだ知らない自分の名前を、ゆっくりと読み上げた。",
].join("\n\n");

export const visualManuscript = [
  "# 潮目の図書館", "", "## 第一章　灯台守の娘", "", "### 一　薄明の羅針盤", "", prose, "",
  "### 二　波間の記録", "", prose.replace("まだ眠っている街", "雨上がりの街").replace("羅針盤がかすかな音", "硝子玉がかすかな音"),
  "", "### 三　地下書庫の入口", "", prose.replace("灯台の階段", "石造りの回廊"),
].join("\n");

interface CreatedDocument { id: string; headRevisionId: string; version: number }
interface VisualProject { id: string; title: string }
export interface VisualManuscript { project: VisualProject; firstScene: CreatedDocument & { title: string } }

async function createDocument(author: AuthorSession, projectId: string, input: {
  kind: "volume" | "chapter" | "scene";
  title: string;
  orderKey: string;
  markdown?: string;
  parentId?: string;
}): Promise<CreatedDocument> {
  const response = await author.fetch(`/api/v1/persistence/projects/${projectId}/documents`, {
    method: "POST",
    headers: { Origin: author.origin, "Idempotency-Key": randomUUID() },
    data: { markdown: "", ...input },
  });
  expect(response.status(), await response.text()).toBe(201);
  return (await response.json() as { document: CreatedDocument }).document;
}

/** Shared deterministic synthetic data for the Desktop visual E2E and VCP. */
export async function seedVisualManuscript(author: AuthorSession): Promise<VisualManuscript> {
  const { origin } = author;
  const title = "潮目の図書館・視覚確認";
  const projectResponse = await author.fetch("/api/v1/persistence/projects", {
    method: "POST", headers: { Origin: origin },
    data: { title, settings: { language: "ja" } },
  });
  expect(projectResponse.status(), await projectResponse.text()).toBe(201);
  const { project } = await projectResponse.json() as { project: VisualProject };
  const volume = await createDocument(author, project.id, { kind: "volume", title: "第一巻　潮が満ちる", orderKey: "01" });
  const firstChapter = await createDocument(author, project.id, { kind: "chapter", parentId: volume.id, title: "第一章　灯台守の娘", orderKey: "01" });
  const secondChapter = await createDocument(author, project.id, { kind: "chapter", parentId: volume.id, title: "第二章　濡れた目録", orderKey: "02" });
  const firstScene = await createDocument(author, project.id, {
    kind: "scene", parentId: firstChapter.id, title: "一　薄明の羅針盤", orderKey: "01", markdown: visualManuscript,
  });
  await createDocument(author, project.id, { kind: "scene", parentId: firstChapter.id, title: "二　波間の記録", orderKey: "02", markdown: prose });
  await createDocument(author, project.id, { kind: "scene", parentId: firstChapter.id, title: "三　地下書庫の入口", orderKey: "03", markdown: prose });
  await createDocument(author, project.id, { kind: "scene", parentId: secondChapter.id, title: "一　青い目録", orderKey: "01", markdown: prose });
  await createDocument(author, project.id, { kind: "scene", parentId: secondChapter.id, title: "二　選ばれなかった明日", orderKey: "02", markdown: prose });
  await createDocument(author, project.id, { kind: "scene", parentId: secondChapter.id, title: "三　帰港", orderKey: "03", markdown: prose });

  const nodeId = randomUUID();
  const nodeResponse = await author.fetch(`/api/v1/persistence/projects/${project.id}/nodes/${nodeId}`, {
    method: "PUT", headers: { Origin: origin },
    data: { type: "object", name: "真鍮の羅針盤", attributes: { owner: "灯台守の家", origin: "海図室" }, status: "confirmed", expectedVersion: null },
  });
  expect(nodeResponse.ok(), await nodeResponse.text()).toBe(true);
  const addition = "\n\n　羅針盤の縁には、まだ誰にも読まれていない海図の方角が刻まれていた。";
  const revised = visualManuscript + addition;
  const revisionResponse = await author.fetch(`/api/v1/persistence/projects/${project.id}/documents/${firstScene.id}`, {
    method: "PATCH",
    headers: { Origin: origin, "Idempotency-Key": randomUUID(), "X-Client-Id": "visual-redesign-fixture" },
    data: {
      baseRevisionId: firstScene.headRevisionId,
      changes: [{ fromUtf16: visualManuscript.length, toUtf16: visualManuscript.length, insert: addition }],
      resultingSha256: createHash("sha256").update(revised).digest("hex"),
      clientId: "visual-redesign-fixture",
    },
  });
  expect(revisionResponse.ok(), await revisionResponse.text()).toBe(true);
  const { revision } = await revisionResponse.json() as { revision: { id: string } };
  const anchorStart = revised.indexOf("羅針盤");
  const evidenceResponse = await author.fetch(`/api/v1/persistence/projects/${project.id}/documents/${firstScene.id}/anchors`, {
    method: "POST", headers: { Origin: origin },
    data: { id: randomUUID(), revisionId: revision.id, fromUtf16: anchorStart, toUtf16: anchorStart + "羅針盤".length, status: "confirmed", nodeId },
  });
  expect(evidenceResponse.status(), await evidenceResponse.text()).toBe(201);

  const currentProjectResponse = await author.fetch(`/api/v1/persistence/projects/${project.id}`);
  expect(currentProjectResponse.ok(), await currentProjectResponse.text()).toBe(true);
  const currentProject = await currentProjectResponse.json() as { project: { version: number } };
  const proposalResponse = await author.fetch(`/api/v1/persistence/projects/${project.id}/changesets`, {
    method: "POST", headers: { Origin: origin, "Idempotency-Key": randomUUID() },
    data: {
      projectVersion: currentProject.project.version,
      operations: [{ type: "knowledge.node.save", command: {
        projectId: project.id, id: randomUUID(), type: "person", name: "凪",
        attributes: { role: "灯台守の娘", source: "第二章　濡れた目録" }, status: "proposed", expectedVersion: null,
      } }],
    },
  });
  expect(proposalResponse.status(), await proposalResponse.text()).toBe(201);
  return { project, firstScene: { ...firstScene, title: "一　薄明の羅針盤" } };
}

export async function buildManuscript(page: Page, mode: "desktop" | "mobile", authorizeAuthor: AuthorizeAuthor) {
  const initial = await authorizeAuthor(mode, undefined, { apiSetupOnly: true });
  const fixture = await seedVisualManuscript(initial);
  const author = await authorizeAuthor(mode, page, { path: `/${mode}/projects/${fixture.project.id}/scenes/${fixture.firstScene.id}${mode === "mobile" ? "?view=writing" : ""}` });
  await expect(manuscriptEditor(page)).toBeVisible();
  await expect(page.getByRole("heading", { name: "Database workspace" })).toBeVisible();
  await expectServerSaved(page);
  await expect(manuscriptEditor(page)).toContainText("誰かが選ばなかった未来");
  return { ...fixture, author };
}
