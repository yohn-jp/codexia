import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import JSZip from "jszip";
import YAML from "yaml";
import type { ChangeOperation, ChangeProposal, ModuleActionContext, ModuleContext, SnapshotId, SnapshotReader } from "@codexia/contracts";
import { createWorkspaceProducer, proposeMigrationImport, type LegacySourceReader, type MigrationContext, type MigrationInspection } from "@codexia/migration";
import { createModule } from "./index.js";
import { readEpubBibleEntries } from "./bible.js";
import { buildEpubExport, manuscriptBodyToXhtml } from "./epub.js";
import { buildPlaintextExport, stripManuscriptMarkup, toNarouDialect } from "./plaintext.js";
import { composeVerticalPrintText } from "./verticalPrint.js";
import { createPublishingMigrationProducer } from "./migration.js";
import { hashShareToken, SHARE_GRANTS_PATH, type ShareGrant } from "./grants.js";
import { createPublishingHttpContributions } from "./http.js";
import { EPISODES_PATH } from "./episodes.js";
import { readPublishingProject, readPublishingProjectFromCore, type PublishingProject } from "./project.js";

const BASE_VERSION = 1;
const NEXT_VERSION = 2;
const repository = "local-publishing-7";

function makeSnapshot(projectVersion = BASE_VERSION, updatedVersion?: number): SnapshotId {
  return { projectId: repository, projectVersion, ...(updatedVersion ? { projectVersion: updatedVersion } : {}) };
}

class MemoryReader implements SnapshotReader {
  readonly files: Map<string, Buffer>;
  constructor(files: Map<string, Buffer | string>, public snapshot: SnapshotId = makeSnapshot(), readonly documentKinds = new Map<string, string>()) {
    this.files = new Map([...files].map(([path, content]) => [path, Buffer.isBuffer(content) ? Buffer.from(content) : Buffer.from(content, "utf8")]));
  }
  async read(path: string, encoding: "utf8" | "base64" = "utf8") {
    const bytes = this.files.get(path);
    if (!bytes) return null;
    const documentKind = this.documentKinds.get(path);
    return { content: encoding === "base64" ? bytes.toString("base64") : bytes.toString("utf8"), revision: createHash("sha256").update(bytes).digest("hex"), ...(documentKind ? { documentKind } : {}) };
  }
  async list(prefix: string) { return [...this.files.keys()].filter((path) => path.startsWith(prefix)).sort(); }
}

function fixtureFiles(): Map<string, Buffer | string> {
  return new Map([
    ["meta/project.yaml", "title: 星の図書館\nsubtitle: 第二巻\n"],
    ["plot/volumes/vol-1/volume.yaml", "kind: volume\nid: vol-1\ntitle: 第一巻\norder: 1\n"],
    ["plot/volumes/vol-1/chapters/ch-1/chapter.yaml", "kind: chapter\nid: ch-1\ntitle: はじまり\nvolume: vol-1\norder: 1\n"],
    ["plot/volumes/vol-1/chapters/ch-1/scenes/sc-1.yaml", "kind: scene\nid: sc-1\ntitle: 夜の駅\nvolume: vol-1\nchapter: ch-1\norder: 1\nmanuscript: manuscript/vol-1/ch-1/sc-1.md\n"],
    ["plot/volumes/vol-1/chapters/ch-1/scenes/sc-2.yaml", "kind: scene\nid: sc-2\ntitle: 朝の港\nvolume: vol-1\nchapter: ch-1\norder: 2\nmanuscript: manuscript/vol-1/ch-1/sc-2.md\n"],
    ["manuscript/vol-1/ch-1/sc-1.md", "---\ntitle: 夜の駅\nprivateNote: 保持\n---\n|星《ほし》の駅で、《《彼女》》は待った。 & <物語>。\n"],
    ["manuscript/vol-1/ch-1/sc-2.md", "海から朝日が昇った。\n"],
    ["bible/characters/character-ari/profile.yaml", "id: character-ari\nname: アリ\naliases: [あり]\nnotes: 星を読む人\n"],
  ]);
}

const project: PublishingProject = {
  title: "星の図書館",
  subtitle: "第二巻",
  volumes: [{
    id: "vol-1", title: "第一巻", order: 1, chapters: [{
      id: "ch-1", title: "はじまり", order: 1, scenes: [
        { id: "sc-1", title: "夜の駅", body: "|星《ほし》の駅で、《《彼女》》は待った。 & <物語>。", path: "manuscript/vol-1/ch-1/sc-1.md", volumeId: "vol-1", chapterId: "ch-1", order: 1 },
        { id: "sc-2", title: "朝の港", body: "海から朝日が昇った。", path: "manuscript/vol-1/ch-1/sc-2.md", volumeId: "vol-1", chapterId: "ch-1", order: 2 },
      ],
    }],
  }],
};

function actionContext(reader: SnapshotReader, proposals: ChangeProposal[]): ModuleActionContext {
  return {
    projectId: "module-project-1",
    reader,
    invoke: async (actionId) => actionId === "core.tree"
      ? {
        ok: true,
        snapshot: reader.snapshot,
        data: {
          snapshot: reader.snapshot,
          tree: {
            title: project.title,
            volumes: project.volumes.map((volume) => ({
              id: volume.id,
              title: volume.title,
              chapters: volume.chapters.map((chapter) => ({
                id: chapter.id,
                title: chapter.title,
                scenes: chapter.scenes.map(({ id, title }) => ({ id, title })),
              })),
            })),
          },
        },
      }
      : { ok: false, snapshot: reader.snapshot, error: { code: "unused", message: "unused", retryable: false } },
    listActions: async () => [],
    linkedReader: async () => reader,
    signal: new AbortController().signal,
    propose: async (operations, evidence) => {
      const proposal = { id: "proposal-" + (proposals.length + 1), snapshot: reader.snapshot, operations, source: "module" as const, ...(evidence ? { evidence } : {}) };
      proposals.push(proposal);
      return proposal;
    },
    runJob: async () => ({ ok: false, id: "unused", snapshot: reader.snapshot, error: { code: "unused", message: "unused", retryable: false } }),
  };
}

function contextWithCoreTree(reader: SnapshotReader, tree: unknown): ModuleActionContext {
  const context = actionContext(reader, []);
  context.invoke = async (actionId) => actionId === "core.tree"
    ? { ok: true, snapshot: reader.snapshot, data: { snapshot: reader.snapshot, tree } }
    : { ok: false, snapshot: reader.snapshot, error: { code: "unused", message: "unused", retryable: false } };
  return context;
}

async function createPublishing() {
  const moduleContext: ModuleContext = {
    cacheDirectory: "/tmp/publishing-test-cache",
    signal: new AbortController().signal,
    acquireCapability: async () => { throw new Error("no capabilities required"); },
    createWorkerService: async () => { throw new Error("no worker required"); },
  };
  return createModule(moduleContext);
}

async function invokeAction(definition: Awaited<ReturnType<typeof createModule>>, id: string, input: unknown, context: ModuleActionContext) {
  const action = definition.actions.find((candidate) => candidate.id === id);
  assert.ok(action, "expected action " + id);
  const parsed = action.inputSchema.parse(input);
  const result = await action.invoke(parsed, context);
  assert.equal(result.ok, true, result.ok ? "" : result.error.message);
  if (!result.ok) throw new Error("Expected successful result");
  return result.data as Record<string, unknown>;
}

function applyOperation(reader: MemoryReader, operation: ChangeOperation, newCommit: number, overlay = false): MemoryReader {
  const files = new Map([...reader.files].map(([path, content]) => [path, Buffer.from(content)]));
  for (const write of operation.writes) {
    if (write.content === null) files.delete(write.path);
    else files.set(write.path, write.encoding === "base64" ? Buffer.from(write.content, "base64") : Buffer.from(write.content, "utf8"));
  }
  return new MemoryReader(files, makeSnapshot(newCommit), reader.documentKinds);
}

test("source plaintext conversion and vertical print keep Japanese text and scene order", () => {
  const raw = buildPlaintextExport(project, { scope: "chapter", id: "ch-1" });
  assert.equal(raw.filename, "arcadia-第一巻_はじまり-raw.txt");
  assert.match(raw.text, /夜の駅[\s\S]*朝の港/u);
  assert.match(stripManuscriptMarkup(raw.text), /星の駅で、彼女は待った/u);
  assert.match(toNarouDialect("|星《ほし》 《《彼女》》"), /\|星《ほし》/u);
  assert.equal(composeVerticalPrintText([
    { id: "sc-1", title: "夜の駅", body: "|星《ほし》の駅。\n" },
    { id: "empty", title: "空", body: " \n" },
    { id: "sc-2", title: "朝の港", body: "海。\n" },
  ]), "夜の駅\n\n|星《ほし》の駅。\n\n朝の港\n\n海。\n");
});

test("publishing follows Core hierarchy after a scene moves while retaining its manuscript path", async () => {
  const reader = new MemoryReader(new Map([
    ["meta/project.yaml", "title: 移動する作品\n"],
    ["plot/volumes/vol-a/volume.yaml", "kind: volume\nid: vol-a\ntitle: 章Aの巻\norder: 0000000001\n"],
    ["plot/volumes/vol-a/chapters/ch-a/chapter.yaml", "kind: chapter\nid: ch-a\ntitle: 章A\nvolume: vol-a\norder: 0000000001\n"],
    ["plot/volumes/vol-a/chapters/ch-a/scenes/sc-moving.yaml", "kind: scene\nid: sc-moving\ntitle: 移動した場面\nvolume: vol-b\nchapter: ch-b\norder: 0000000001\nmanuscript: manuscript/vol-a/ch-a/sc-moving.md\n"],
    ["plot/volumes/vol-b/volume.yaml", "kind: volume\nid: vol-b\ntitle: 章Bの巻\norder: 0000000002\n"],
    ["plot/volumes/vol-b/chapters/ch-b/chapter.yaml", "kind: chapter\nid: ch-b\ntitle: 章B\nvolume: vol-b\norder: 0000000001\n"],
    ["manuscript/vol-a/ch-a/sc-moving.md", "元のパスに残る本文。\n"],
  ]));
  const tree = {
    title: "移動する作品",
    volumes: [
      { id: "vol-a", title: "章Aの巻", chapters: [{ id: "ch-a", title: "章A", scenes: [] }] },
      { id: "vol-b", title: "章Bの巻", chapters: [{ id: "ch-b", title: "章B", scenes: [{ id: "sc-moving", title: "移動した場面" }] }] },
    ],
  };
  const context = contextWithCoreTree(reader, tree);
  const publishing = await readPublishingProjectFromCore(context);
  const publicPublishing = await readPublishingProject(reader);
  const fromA = buildPlaintextExport(publishing, { scope: "chapter", id: "ch-a" }).text;
  const fromB = buildPlaintextExport(publishing, { scope: "chapter", id: "ch-b" }).text;
  assert.doesNotMatch(fromA, /元のパスに残る本文/u);
  assert.equal(fromB.match(/元のパスに残る本文/gu)?.length, 1);
  assert.equal(publishing.volumes[1]?.chapters[0]?.scenes[0]?.path, "manuscript/vol-a/ch-a/sc-moving.md");
  assert.equal(publicPublishing.volumes[1]?.chapters[0]?.scenes[0]?.id, "sc-moving");

  const exported = await buildEpubExport(publishing, { scope: "all" }, reader, []);
  const zip = await JSZip.loadAsync(exported.buffer);
  assert.equal(await zip.file("OEBPS/scene-sc-moving.xhtml")!.async("string").then((xhtml) => xhtml.match(/元のパスに残る本文/gu)?.length), 1);
  const opf = await zip.file("OEBPS/content.opf")!.async("string");
  assert.equal(opf.match(/idref="item-sc-moving"/gu)?.length, 1);
});

test("the canonical full plaintext export includes project root scenes once in stored order", async () => {
  const files = new Map(fixtureFiles());
  files.set("plot/volumes/root/chapters/root/scenes/root-b.yaml", "kind: scene\nid: root-b\ntitle: Root B\norder: 2\nmanuscript: documents/root-b.md\n");
  files.set("documents/root-b.md", "ROOT BODY B\n");
  files.set("plot/volumes/imported/chapters/legacy/scenes/root-c.yaml", "kind: scene\nid: root-c\ntitle: Root C\norder: 3\nmanuscript: documents/root-c.md\n");
  files.set("documents/root-c.md", "ROOT BODY C\n");
  files.set("plot/volumes/root/chapters/root/scenes/root-a.yaml", "kind: scene\nid: root-a\ntitle: Root A\norder: 1\nmanuscript: documents/root-a.md\n");
  files.set("documents/root-a.md", "ROOT BODY A\n");
  const notePath = "plot/volumes/root/chapters/root/scenes/private-note.yaml";
  files.set(notePath, "kind: scene\nid: private-note\ntitle: Private note\nmanuscript: documents/private-note.md\n");
  files.set("documents/private-note.md", "PRIVATE NOTE BODY\n");
  const invalidParentPath = "plot/volumes/root/chapters/root/scenes/invalid-parent.yaml";
  files.set(invalidParentPath, "kind: scene\nid: invalid-parent\ntitle: Invalid parent\nvolume: ''\nchapter: ''\nmanuscript: documents/invalid-parent.md\n");
  files.set("documents/invalid-parent.md", "INVALID LINK BODY\n");
  const reader = new MemoryReader(files, makeSnapshot(), new Map([[notePath, "note"], [invalidParentPath, "scene"]]));
  const publishing = await createPublishing();
  const mixed = await invokeAction(publishing, "publishing.export.plaintext", { scope: "all" }, contextWithCoreTree(reader, {
    title: project.title,
    volumes: [{ id: "vol-1", title: "第一巻", chapters: [{ id: "ch-1", title: "はじまり", scenes: [{ id: "sc-1", title: "夜の駅" }, { id: "sc-2", title: "朝の港" }] }] }],
  }));
  const mixedText = Buffer.from(String(mixed.contentBase64), "base64").toString("utf8");
  assert.ok(mixedText.indexOf("ROOT BODY A") < mixedText.indexOf("ROOT BODY B"));
  for (const body of ["ROOT BODY A", "ROOT BODY B", "ROOT BODY C", "|星《ほし》の駅", "海から朝日が昇った。"] ) {
    assert.equal(mixedText.split(body).length - 1, 1);
  }
  assert.doesNotMatch(mixedText, /PRIVATE NOTE BODY|Private note|INVALID LINK BODY|Invalid parent/u);

  const mixedEpub = await invokeAction(publishing, "publishing.export.epub", { scope: "all" }, contextWithCoreTree(reader, {
    title: project.title,
    volumes: [{ id: "vol-1", title: "第一巻", chapters: [{ id: "ch-1", title: "はじまり", scenes: [{ id: "sc-1", title: "夜の駅" }, { id: "sc-2", title: "朝の港" }] }] }],
  }));
  const mixedZip = await JSZip.loadAsync(Buffer.from(String(mixedEpub.contentBase64), "base64"));
  const rootXhtml = await mixedZip.file("OEBPS/scene-root-a.xhtml")!.async("string");
  const opf = await mixedZip.file("OEBPS/content.opf")!.async("string");
  assert.match(rootXhtml, /ROOT BODY A/u);
  assert.match(opf, /idref="item-root-a"/u);
  assert.match(opf, /idref="item-root-b"/u);
  assert.match(opf, /idref="item-root-c"/u);
  const nav = await mixedZip.file("OEBPS/nav.xhtml")!.async("string");
  assert.ok(nav.indexOf("scene-root-a.xhtml") < nav.indexOf("scene-root-b.xhtml"));
  assert.ok(nav.indexOf("scene-root-b.xhtml") < nav.indexOf("scene-root-c.xhtml"));
  assert.equal(mixedZip.file("OEBPS/scene-private-note.xhtml"), null);
  for (const filename of ["scene-root-a.xhtml", "scene-root-b.xhtml", "scene-root-c.xhtml"]) {
    assert.equal(await mixedZip.file(`OEBPS/${filename}`)!.async("string").then((xhtml) => xhtml.match(/ROOT BODY [A-C]/gu)?.length), 1);
  }
  const chapterEpub = await invokeAction(publishing, "publishing.export.epub", { scope: "chapter", id: "ch-1" }, contextWithCoreTree(reader, {
    title: project.title,
    volumes: [{ id: "vol-1", title: "第一巻", chapters: [{ id: "ch-1", title: "はじまり", scenes: [{ id: "sc-1", title: "夜の駅" }, { id: "sc-2", title: "朝の港" }] }] }],
  }));
  const chapterZip = await JSZip.loadAsync(Buffer.from(String(chapterEpub.contentBase64), "base64"));
  assert.equal(chapterZip.file("OEBPS/scene-root-a.xhtml"), null, "chapter scope must omit project root scenes");

  const rootOnlyReader = new MemoryReader(new Map([
    ["meta/project.yaml", "title: Root only\n"],
    ["plot/volumes/root/chapters/root/scenes/only.yaml", "kind: scene\nid: only\ntitle: Only scene\norder: 1\nmanuscript: documents/only.md\n"],
    ["documents/only.md", "ONLY ROOT BODY\n"],
  ]));
  const rootOnly = await invokeAction(publishing, "publishing.export.plaintext", { scope: "all" }, contextWithCoreTree(rootOnlyReader, { title: "Root only", volumes: [] }));
  assert.equal(Buffer.from(String(rootOnly.contentBase64), "base64").toString("utf8").match(/ONLY ROOT BODY/gu)?.length, 1);
  const rootOnlyEpub = await invokeAction(publishing, "publishing.export.epub", { scope: "all" }, contextWithCoreTree(rootOnlyReader, { title: "Root only", volumes: [] }));
  const rootOnlyZip = await JSZip.loadAsync(Buffer.from(String(rootOnlyEpub.contentBase64), "base64"));
  assert.match(await rootOnlyZip.file("OEBPS/scene-only.xhtml")!.async("string"), /ONLY ROOT BODY/u);
});

test("plaintext export and public reader preserve manuscript horizontal rules", async () => {
  const files = fixtureFiles();
  const first = "---\r\n普通の回想\r\n---\r\n後半。";
  const second = "---\n続く本文。";
  files.set("manuscript/vol-1/ch-1/sc-1.md", first);
  files.set("manuscript/vol-1/ch-1/sc-2.md", second);
  const reader = new MemoryReader(files);
  const publishing = await createPublishing();
  const result = await invokeAction(publishing, "publishing.export.plaintext", { scope: "all" }, actionContext(reader, []));
  const text = Buffer.from(String(result.contentBase64), "base64").toString("utf8");
  assert.ok(text.includes(first));
  assert.ok(text.includes(second));
  const shared = await readPublishingProject(reader);
  assert.deepEqual(shared.volumes[0]?.chapters[0]?.scenes.map(({ body }) => body), [first, second]);
});

test("the publishing tree exposes titled root scenes without leaking notes or reading manuscript bodies", async () => {
  const files = fixtureFiles();
  files.set("plot/volumes/root/chapters/root/scenes/root.yaml", "kind: scene\nid: root\ntitle: 夜の駅\nmanuscript: documents/root.md\n");
  files.set("plot/volumes/root/chapters/root/scenes/private-note.yaml", "kind: note\nid: private-note\ntitle: Private note\nmanuscript: documents/private-note.md\n");
  files.set("documents/root.md", "Root manuscript body");
  files.set("documents/private-note.md", "Private note body");
  const reader = new MemoryReader(files);
  const bodyReads: string[] = [];
  const read = reader.read.bind(reader);
  reader.read = (path, encoding) => {
    if (path.endsWith(".md")) bodyReads.push(path);
    return read(path, encoding);
  };
  const tree = await invokeAction(await createPublishing(), "publishing.project.tree", {}, actionContext(reader, []));
  assert.deepEqual(bodyReads, []);
  assert.deepEqual(tree, {
    title: project.title, rootSceneCount: 1, rootScenes: [{ id: "root", title: "夜の駅" }], volumes: [{ id: "vol-1", title: "第一巻", chapters: [{
      id: "ch-1", title: "はじまり", scenes: [{ id: "sc-1", title: "夜の駅" }, { id: "sc-2", title: "朝の港" }],
    }] }],
  });
});

test("public share projection excludes author notes in pinned snapshots through immutable reader metadata", async () => {
  const files = fixtureFiles();
  const canonicalKinds = new Map([
    ["plot/volumes/vol-1/volume.yaml", "volume"],
    ["plot/volumes/vol-1/chapters/ch-1/chapter.yaml", "chapter"],
    ["plot/volumes/vol-1/chapters/ch-1/scenes/sc-1.yaml", "scene"],
    ["plot/volumes/vol-1/chapters/ch-1/scenes/sc-2.yaml", "scene"],
  ]);
  for (const path of canonicalKinds.keys()) files.set(path, String(files.get(path)).replace(/^kind: .*\n/u, ""));
  const notePath = "plot/volumes/ch-1/chapters/sc-1/scenes/note-1.yaml";
  files.set(
    notePath,
    "id: note-1\ntitle: Private Author Note\nvolume: ch-1\nchapter: sc-1\nmanuscript: documents/note-1.md\n",
  );
  files.set("documents/note-1.md", "Private note body must not appear.");
  canonicalKinds.set(notePath, "note");
  const publishing = await readPublishingProject(new MemoryReader(files, makeSnapshot(), canonicalKinds));
  assert.deepEqual(publishing.volumes.map((volume) => volume.id), ["vol-1"]);
  assert.deepEqual(publishing.volumes[0]?.chapters.map((chapter) => chapter.id), ["ch-1"]);
  assert.deepEqual(publishing.volumes[0]?.chapters[0]?.scenes.map((scene) => scene.id), ["sc-1", "sc-2"]);
  assert.doesNotMatch(JSON.stringify(publishing), /Private Author Note|Private note body/u);
});

test("public scene and volume shares follow a chapter moved to a later volume", async () => {
  const files = fixtureFiles();
  files.set("plot/volumes/vol-z/volume.yaml", "kind: volume\nid: vol-z\ntitle: 移動先\norder: 2\n");
  const chapterPath = "plot/volumes/vol-1/chapters/ch-1/chapter.yaml";
  files.set(chapterPath, String(files.get(chapterPath)).replace("volume: vol-1", "volume: vol-z"));
  const grants: Array<{ scope: ShareGrant["scope"]; revokedAt?: string }> = [
    { scope: { kind: "scene", id: "sc-1" } },
    { scope: { kind: "volume", id: "vol-1" } },
    { scope: { kind: "volume", id: "vol-z" } },
    { scope: { kind: "scene", id: "sc-1" }, revokedAt: "2026-01-02T00:00:00.000Z" },
  ];
  const tokens = grants.map((_, index) => "share_" + String(index).repeat(43));
  files.set(SHARE_GRANTS_PATH, grants.map((grant, index) => JSON.stringify({
    version: 1, grantVersion: 2, revocationVersion: grant.revokedAt ? 1 : 0,
    id: "grant-" + index, tokenHash: hashShareToken(tokens[index]!), label: "fixture",
    createdAt: "2026-01-01T00:00:00.000Z", expiresAt: "2030-01-01T00:00:00.000Z", ...grant,
  })).join("\n") + "\n");
  const reader = new MemoryReader(files);
  const route = createPublishingHttpContributions().find(({ id }) => id === "publishing.http.public-share-scene")!;
  const context = actionContext(reader, []);
  context.invoke = async () => { throw new Error("Public sharing must use its pinned reader"); };
  const responses = await Promise.all(tokens.map(token => route.handle(
    new Request(`https://codexia.invalid/share/${token}/scenes/sc-1`), context,
  )));
  assert.deepEqual(responses.map(({ status }) => status), [200, 404, 200, 404]);
  assert.match((await responses[0]!.json() as { body: string }).body, /星/);
});

test("publishing keeps Core's string order-key sequence in volume, chapter, text, and EPUB output", async () => {
  const reader = new MemoryReader(new Map([
    ["meta/project.yaml", "title: 順序の作品\n"],
    ["plot/volumes/vol-a/volume.yaml", "id: vol-a\ntitle: Alpha volume\norder: 2\n"],
    ["plot/volumes/vol-a/chapters/ch-alpha/chapter.yaml", "id: ch-alpha\ntitle: Alpha chapter\nvolume: vol-a\norder: 2\n"],
    ["plot/volumes/vol-a/chapters/ch-alpha/scenes/sc-a.yaml", "id: sc-a\ntitle: Alpha scene\nvolume: vol-a\nchapter: ch-alpha\norder: 2\nmanuscript: manuscript/vol-a/ch-alpha/sc-a.md\n"],
    ["plot/volumes/vol-z/volume.yaml", 'id: vol-z\ntitle: Zulu volume\norder: "0000000002"\n'],
    ["plot/volumes/vol-z/chapters/ch-alpha-z/chapter.yaml", 'id: ch-alpha-z\ntitle: Alpha chapter\nvolume: vol-z\norder: "0000000010"\n'],
    ["plot/volumes/vol-z/chapters/ch-z/chapter.yaml", 'id: ch-z\ntitle: Zulu chapter\nvolume: vol-z\norder: "0000000002"\n'],
    ["plot/volumes/vol-z/chapters/ch-z/scenes/sc-alpha.yaml", 'id: sc-alpha\ntitle: Alpha scene\nvolume: vol-z\nchapter: ch-z\norder: "0000000010"\nmanuscript: manuscript/vol-z/ch-z/sc-alpha.md\n'],
    ["plot/volumes/vol-z/chapters/ch-z/scenes/sc-zulu.yaml", 'id: sc-zulu\ntitle: Zulu scene\nvolume: vol-z\nchapter: ch-z\norder: "0000000002"\nmanuscript: manuscript/vol-z/ch-z/sc-zulu.md\n'],
    ["manuscript/vol-a/ch-alpha/sc-a.md", "本文 Alpha。\n"],
    ["manuscript/vol-z/ch-z/sc-alpha.md", "本文 Alpha scene。\n"],
    ["manuscript/vol-z/ch-z/sc-zulu.md", "本文 Zulu。\n"],
  ]));
  const tree = {
    title: "順序の作品",
    volumes: [
      { id: "vol-z", title: "Zulu volume", chapters: [
        { id: "ch-z", title: "Zulu chapter", scenes: [
          { id: "sc-zulu", title: "Zulu scene" },
          { id: "sc-alpha", title: "Alpha scene" },
        ] },
        { id: "ch-alpha-z", title: "Alpha chapter", scenes: [] },
      ] },
      { id: "vol-a", title: "Alpha volume", chapters: [
        { id: "ch-alpha", title: "Alpha chapter", scenes: [{ id: "sc-a", title: "Alpha scene" }] },
      ] },
    ],
  };

  const publishing = await readPublishingProjectFromCore(contextWithCoreTree(reader, tree));
  assert.deepEqual(publishing.volumes.map((volume) => volume.id), ["vol-z", "vol-a"]);
  assert.deepEqual(publishing.volumes[0]?.chapters.map((chapter) => chapter.id), ["ch-z", "ch-alpha-z"]);
  assert.deepEqual(publishing.volumes[0]?.chapters[0]?.scenes.map((scene) => scene.id), ["sc-zulu", "sc-alpha"]);
  assert.equal(publishing.volumes[0]?.order, "0000000002");
  assert.equal(publishing.volumes[1]?.order, 2, "legacy numeric order metadata remains readable");
  assert.equal(publishing.volumes[0]?.chapters[0]?.order, "0000000002");
  assert.equal(publishing.volumes[0]?.chapters[0]?.scenes[0]?.order, "0000000002");

  const plaintext = buildPlaintextExport(publishing, { scope: "all" }).text;
  assert.ok(plaintext.indexOf("# Zulu scene") < plaintext.indexOf("# Alpha scene"));
  assert.ok(plaintext.indexOf("# Alpha chapter") < 0, "chapter titles are not substituted for scenes");
  assert.ok(plaintext.indexOf("本文 Zulu。") < plaintext.indexOf("本文 Alpha scene。"));
  assert.ok(plaintext.indexOf("本文 Alpha scene。") < plaintext.indexOf("本文 Alpha。"));

  const exported = await buildEpubExport(publishing, { scope: "all" }, reader, []);
  const zip = await JSZip.loadAsync(exported.buffer);
  const opf = await zip.file("OEBPS/content.opf")!.async("string");
  const zuluSpine = opf.indexOf('idref="item-sc-zulu"');
  const alphaSceneSpine = opf.indexOf('idref="item-sc-alpha"');
  const alphaVolumeSpine = opf.indexOf('idref="item-sc-a"');
  assert.ok(zuluSpine >= 0 && zuluSpine < alphaSceneSpine && alphaSceneSpine < alphaVolumeSpine);
});

test("EPUB keeps distinct scene bodies reachable from the table of contents and spine", async () => {
  const longPrefix = "x".repeat(80);
  const ids = ["a__b", "a_b", "1", "id-1", longPrefix + "a", longPrefix + "b"];
  const book = structuredClone(project);
  const chapter = book.volumes[0]!.chapters[0]!;
  const template = chapter.scenes[0]!;
  chapter.scenes = ids.map((id) => ({ ...template, id, title: id, body: "本文 " + id }));
  const { buffer } = await buildEpubExport(book, { scope: "all" }, new MemoryReader(new Map()));
  const zip = await JSZip.loadAsync(buffer);
  assert.equal(zip.file(/^OEBPS\/scene-.*\.xhtml$/u).length, ids.length);
  const nav = await zip.file("OEBPS/nav.xhtml")!.async("string");
  const opf = await zip.file("OEBPS/content.opf")!.async("string");
  let previousNav = -1;
  let previousSpine = -1;
  for (const id of ids) {
    const href = `scene-${id}.xhtml`;
    const body = await zip.file("OEBPS/" + href)!.async("string");
    assert.ok(body.includes(`<p>本文 ${id}</p>`));
    assert.ok(opf.includes(`<item id="item-${id}" href="${href}"`));
    const link = nav.indexOf(`<a href="${href}">${id}</a>`);
    const spine = opf.indexOf(`<itemref idref="item-${id}"/>`);
    assert.ok(link > previousNav && spine > previousSpine);
    previousNav = link;
    previousSpine = spine;
  }
});

test("real EPUB ZIP contains EPUB3 manifest, Japanese XHTML, appendix, and binary cover bytes", async () => {
  const cover = Buffer.from([0xff, 0xd8, 0x00, 0x81, 0xfe, 0x00, 0xd9]);
  const files = fixtureFiles();
  files.set("meta/scriptorium/modules/publishing/assets/cover.jpg", cover);
  files.set("bible/characters/character-ari/profile.yaml", YAML.stringify({
    id: "character-ari",
    name: "アリ",
    aliases: ["あり"],
    notes: {
      lead: [{ type: "paragraph", text: "星を読む。" }],
      sections: [{
        heading: "記録",
        body: [{ type: "definitions", items: [{ term: "声紋の核", description: "星の力" }] }],
        children: [{
          heading: "補注",
          body: [{ type: "steps", items: [{ term: "第一の段階", description: "薄明から始める" }] }],
          children: [],
        }],
      }],
    },
  }));
  // The source loader attaches this id-less helper to profile.yaml; it is not
  // a separate character or bibliography entry.
  files.set("bible/characters/character-ari/voice.yaml", "first_person:\n  - name: 我\nduality:\n  outer:\n    tone: 静かな話し方\n");
  const reader = new MemoryReader(files);
  const bibleEntries = await readEpubBibleEntries(reader);
  assert.equal(bibleEntries.length, 1, "profile.yaml contributes one character; voice.yaml is a helper");
  assert.equal(bibleEntries[0]!.id, "character-ari");
  const exported = await buildEpubExport(
    project,
    { scope: "all", coverPath: "meta/scriptorium/modules/publishing/assets/cover.jpg", includeBibleAppendix: true },
    reader,
    bibleEntries,
  );
  assert.equal(exported.filename, "arcadia-all.epub");
  const zip = await JSZip.loadAsync(exported.buffer);
  assert.equal(await zip.file("mimetype")!.async("string"), "application/epub+zip");
  const opf = await zip.file("OEBPS/content.opf")!.async("string");
  assert.match(opf, /version="3\.0"/u);
  assert.match(opf, /properties="cover-image"/u);
  const scene = await zip.file("OEBPS/scene-sc-1.xhtml")!.async("string");
  assert.match(scene, /星/u);
  assert.match(scene, /<ruby>星<rt>ほし<\/rt><\/ruby>/u);
  assert.match(scene, /<span class="bouten">彼女<\/span>/u);
  assert.match(scene, /&amp; &lt;物語&gt;/u);
  const appendix = await zip.file("OEBPS/bible-appendix.xhtml")!.async("string");
  assert.match(appendix, /アリ/u);
  assert.match(appendix, /星を読む/u);
  assert.match(appendix, /声紋の核/u);
  assert.match(appendix, /星の力/u);
  assert.match(appendix, /第一の段階/u);
  assert.match(appendix, /薄明から始める/u);
  assert.doesNotMatch(appendix, /静かな話し方|<h3>voice<\/h3>/u);
  assert.deepEqual(await zip.file("OEBPS/images/cover.jpg")!.async("nodebuffer"), cover);
});

test("EPUB bible reader keeps source flat character entities and typed lore/location YAML", async () => {
  const reader = new MemoryReader(new Map([
    ["bible/characters/char-flat.yaml", "id: char-flat\ntype: character\nname: 古い人物\n"],
    ["bible/characters/char-flat/voice.yaml", "first_person:\n  - name: 我\n"],
    ["bible/lore/lore-1.yaml", "id: lore-1\nname: 星の法則\n"],
    ["bible/locations/location-1.yaml", "id: location-1\nname: 海辺\n"],
  ]));
  const entries = await readEpubBibleEntries(reader);
  assert.deepEqual(entries.map((entry) => entry.id).sort(), ["char-flat", "location-1", "lore-1"]);
  assert.equal(entries.find((entry) => entry.id === "char-flat")!.name, "古い人物");
});

test("episode edits propose metadata operations and preserve unknown YAML and publication dates", async () => {
  const existingMap = YAML.stringify({
    episodes: [{
      id: "ep-1", number: 1, title: "第一話", scope: "chapter", scopeId: "ch-1",
      publishedAt: "2025-05-04T03:02:01Z", sceneIds: ["sc-1"], futureEpisodeField: { retain: "yes" },
    }],
    futureMapField: { provider: "legacy", revision: 3 },
  });
  const reader = new MemoryReader(new Map([...fixtureFiles(), [EPISODES_PATH, existingMap]]));
  const definition = await createPublishing();
  const proposals: ChangeProposal[] = [];
  const context = actionContext(reader, proposals);
  const episodes = (await invokeAction(definition, "publishing.episodes.read", {}, context)).episodes as Array<Record<string, unknown>>;
  const proposalData = await invokeAction(definition, "publishing.episodes.propose", {
    episodes: [{ id: "ep-1", number: 2, title: "改題", scope: "chapter", scopeId: "ch-1" }],
  }, context);
  assert.equal(proposals.length, 1);
  const operation = proposals[0]!.operations[0]!;
  assert.equal(operation.effect, "metadata");
  assert.deepEqual(operation.writes.map((write) => write.path), [EPISODES_PATH]);
  const written = YAML.parse(operation.writes[0]!.content!);
  assert.deepEqual(written.futureMapField, { provider: "legacy", revision: 3 });
  assert.deepEqual(written.episodes[0].futureEpisodeField, { retain: "yes" });
  assert.equal(written.episodes[0].publishedAt, "2025-05-04T03:02:01Z");
  assert.deepEqual(written.episodes[0].sceneIds, ["sc-1"]);
  assert.equal((proposalData.episodes as unknown[]).length, 1);
  assert.equal(episodes.length, 1);
  assert.equal((await reader.read(EPISODES_PATH))!.content, existingMap, "actions never write source files");

  const cleared = await invokeAction(definition, "publishing.episodes.propose", {
    episodes: [{
      id: "ep-1", number: 2, title: "改題", scope: "chapter", scopeId: "ch-1",
      publishedAt: null, sceneIds: null,
    }],
  }, context);
  const clearedEpisode = (cleared.episodes as Array<Record<string, unknown>>)[0]!;
  const clearedYaml = YAML.parse(proposals.at(-1)!.operations[0]!.writes[0]!.content!);
  assert.ok(!Object.hasOwn(clearedEpisode, "publishedAt"), "explicit null clears the date from the action result");
  assert.ok(!Object.hasOwn(clearedEpisode, "sceneIds"), "explicit null clears scene annotations from the action result");
  assert.ok(!Object.hasOwn(clearedYaml.episodes[0], "publishedAt"), "explicit null clears the persisted date");
  assert.ok(!Object.hasOwn(clearedYaml.episodes[0], "sceneIds"), "explicit null clears persisted scene annotations");
  assert.deepEqual(clearedYaml.episodes[0].futureEpisodeField, { retain: "yes" }, "unknown episode fields remain preserved on clear");
});

test("a share activates only after its PostgreSQL apply and revocation is checked on every public read", async () => {
  const definition = await createPublishing();
  const proposals: ChangeProposal[] = [];
  const files = fixtureFiles();
  const notePath = "plot/volumes/vol-1/chapters/ch-1/scenes/note-1.yaml";
  files.set(notePath, "id: note-1\ntitle: Private Author Note\nvolume: vol-1\nchapter: ch-1\nmanuscript: documents/note-1.md\n");
  files.set("documents/note-1.md", "Private note body must not appear.");
  let remote = new MemoryReader(files, makeSnapshot(), new Map([[notePath, "note"]]));
  const context = actionContext(remote, proposals);
  const created = await invokeAction(definition, "publishing.shares.create", {
    kind: "chapter", id: "ch-1", label: "校正用", expiresInHours: 24,
  }, context);
  const token = String(created.token);
  const createOperation = proposals[0]!.operations[0]!;
  const createJson = createOperation.writes[0]!.content!;
  assert.ok(!createJson.includes(token), "raw bearer is never committed");
  assert.equal(JSON.parse(createJson).tokenHash, hashShareToken(token));

  const publicBase = definition.http!.find((item) => item.id === "publishing.http.public-share")!;
  const publicScene = definition.http!.find((item) => item.id === "publishing.http.public-share-scene")!;
  const publicContext = (reader: SnapshotReader) => {
    const context = actionContext(reader, []);
    context.invoke = async () => ({ ok: false, snapshot: reader.snapshot, error: {
      code: "public_action_unavailable", message: "Public routes cannot invoke composed actions", retryable: false,
    } });
    return context;
  };
  const url = "https://codexia.invalid/api/public/projects/local-publishing-7/modules/publishing/share/" + encodeURIComponent(token);
  const beforePublish = await publicBase.handle(new Request(url), publicContext(remote));
  assert.equal(beforePublish.status, 404, "an unpushed checkpoint/proposal is not public");

  assert.equal((await publicBase.handle(new Request(url), publicContext(remote))).status, 404, "proposing a share does not apply it");

  remote = applyOperation(remote, createOperation, NEXT_VERSION);
  const metadataResponse = await publicBase.handle(new Request(url), publicContext(remote));
  assert.equal(metadataResponse.status, 200);
  assert.equal(metadataResponse.headers.get("x-robots-tag"), "noindex, nofollow");
  assert.equal(metadataResponse.headers.get("referrer-policy"), "no-referrer");
  const metadata = await metadataResponse.json() as { sceneCount: number; tree: Array<{ chapters: Array<{ scenes: Array<{ id: string }> }> }> };
  assert.equal(metadata.sceneCount, 2);
  assert.deepEqual(metadata.tree[0]!.chapters[0]!.scenes.map((scene) => scene.id), ["sc-1", "sc-2"]);
  assert.doesNotMatch(JSON.stringify(metadata), /Private Author Note|Private note body/u);
  const sceneUrl = url + "/scenes/sc-1";
  assert.equal((await publicScene.handle(new Request(sceneUrl), publicContext(remote))).status, 200);
  assert.equal((await publicScene.handle(new Request(url + "/scenes/out-of-scope"), publicContext(remote))).status, 404);

  const listed = await invokeAction(definition, "publishing.shares.list", {}, actionContext(remote, []));
  const safeList = listed.shares as Array<Record<string, unknown>>;
  assert.ok(!JSON.stringify(safeList).includes(token));
  assert.ok(!JSON.stringify(safeList).includes(hashShareToken(token)));

  const revoked = await invokeAction(definition, "publishing.shares.revoke", { id: String((created.share as Record<string, unknown>).id) }, actionContext(remote, proposals));
  const revokeOperation = proposals.at(-1)!.operations[0]!;
  assert.ok(revoked.proposalId);
  assert.equal((await publicBase.handle(new Request(url), publicContext(remote))).status, 200, "local revocation does not alter the current remote snapshot");
  remote = applyOperation(remote, revokeOperation, 3);
  assert.equal((await publicBase.handle(new Request(url), publicContext(remote))).status, 404, "confirmed remote revocation blocks the next read");

  const expiredToken = "share_" + "x".repeat(43);
  const expired: ShareGrant = {
    version: 1, grantVersion: 2, revocationVersion: 0, id: "expired-grant",
    tokenHash: hashShareToken(expiredToken), scope: { kind: "scene", id: "sc-1" },
    label: "期限切れ", createdAt: "2024-01-01T00:00:00.000Z", expiresAt: "2024-01-02T00:00:00.000Z",
  };
  const expiredReader = new MemoryReader(new Map<string, Buffer | string>([...remote.files, [SHARE_GRANTS_PATH, JSON.stringify(expired) + "\n"]]), remote.snapshot);
  const expiredUrl = url.slice(0, url.lastIndexOf("/") + 1) + expiredToken;
  assert.equal((await publicBase.handle(new Request(expiredUrl), publicContext(expiredReader))).status, 404);
});

test("project-wide public shares include root scenes in their catalogue and scene route", async () => {
  const files = fixtureFiles();
  files.set("plot/volumes/root/volume.yaml", "kind: volume\nid: root\ntitle: Root\n");
  files.set("plot/volumes/root/chapters/root/chapter.yaml", "kind: chapter\nid: root-chapter\ntitle: Root\nvolume: root\n");
  files.set("plot/volumes/root/chapters/root/scenes/root-scene.yaml", "kind: scene\nid: root-scene\ntitle: 作品直下のシーン\nmanuscript: manuscript/root-scene.md\n");
  files.set("manuscript/root-scene.md", "作品直下の本文。\n");
  const token = "share_" + "r".repeat(43);
  const rootSceneToken = "share_" + "s".repeat(43);
  files.set(SHARE_GRANTS_PATH, [
    { version: 1, grantVersion: 1, revocationVersion: 0, id: "project-share",
      tokenHash: hashShareToken(token), scope: "", label: "Project preview",
      createdAt: "2026-01-01T00:00:00.000Z", expiresAt: "2030-01-01T00:00:00.000Z" },
    { version: 1, grantVersion: 1, revocationVersion: 0, id: "root-scene-share",
      tokenHash: hashShareToken(rootSceneToken), scope: { kind: "scene", id: "root-scene" }, label: "Root scene preview",
      createdAt: "2026-01-01T00:00:00.000Z", expiresAt: "2030-01-01T00:00:00.000Z" },
  ].map((grant) => JSON.stringify(grant)).join("\n") + "\n");
  const reader = new MemoryReader(files);
  const [publicBase, publicScene] = createPublishingHttpContributions();
  const context = actionContext(reader, []);
  const url = `https://codexia.invalid/share/${token}`;

  const catalogueResponse = await publicBase!.handle(new Request(url), context);
  assert.equal(catalogueResponse.status, 200);
  const catalogue = await catalogueResponse.json() as {
    sceneCount: number;
    rootScenes: Array<{ id: string; title: string }>;
  };
  assert.equal(catalogue.sceneCount, 3);
  assert.deepEqual(catalogue.rootScenes, [{ id: "root-scene", title: "作品直下のシーン" }]);

  const sceneResponse = await publicScene!.handle(new Request(`${url}/scenes/root-scene`), context);
  assert.equal(sceneResponse.status, 200);
  assert.equal((await sceneResponse.json() as { body: string }).body, "作品直下の本文。\n");

  const rootSceneCatalogue = await publicBase!.handle(new Request(`https://codexia.invalid/share/${rootSceneToken}`), context);
  assert.equal(rootSceneCatalogue.status, 200);
  const scopedCatalogue = await rootSceneCatalogue.json() as { sceneCount: number; rootScenes: Array<{ id: string }> };
  assert.equal(scopedCatalogue.sceneCount, 1);
  assert.deepEqual(scopedCatalogue.rootScenes, [{ id: "root-scene", title: "作品直下のシーン" }]);
});

test("a proposed root-scene share publishes only the selected same-title manuscript", async () => {
  const files = fixtureFiles();
  const rootScenePath = "plot/volumes/root/chapters/root/scenes/root-scene.yaml";
  files.set(rootScenePath, "kind: scene\nid: root-scene\ntitle: 夜の駅\nmanuscript: documents/root-scene.md\n");
  files.set("documents/root-scene.md", "ROOT-ONLY BODY\n");
  const rootNotePath = "plot/volumes/root/chapters/root/scenes/root-note.yaml";
  files.set(rootNotePath, "id: root-note\ntitle: Private root note\nmanuscript: documents/root-note.md\n");
  files.set("documents/root-note.md", "PRIVATE NOTE BODY\n");
  let remote = new MemoryReader(files, makeSnapshot(), new Map([[rootNotePath, "note"]]));
  const definition = await createPublishing();
  const proposals: ChangeProposal[] = [];
  const created = await invokeAction(definition, "publishing.shares.create", {
    kind: "scene", id: "root-scene", label: "直下シーンの確認", expiresInHours: 24,
  }, actionContext(remote, proposals));
  const token = String(created.token);
  const createOperation = proposals[0]!.operations[0]!;
  assert.deepEqual(JSON.parse(createOperation.writes[0]!.content!).scope, { kind: "scene", id: "root-scene" });

  const publicBase = definition.http!.find((item) => item.id === "publishing.http.public-share")!;
  const publicScene = definition.http!.find((item) => item.id === "publishing.http.public-share-scene")!;
  const publicContext = (reader: SnapshotReader) => {
    const context = actionContext(reader, []);
    context.invoke = async () => ({ ok: false, snapshot: reader.snapshot, error: {
      code: "public_action_unavailable", message: "Public routes cannot invoke composed actions", retryable: false,
    } });
    return context;
  };
  const url = "https://codexia.invalid/api/public/projects/local-publishing-7/modules/publishing/share/" + encodeURIComponent(token);
  assert.equal((await publicBase.handle(new Request(url), publicContext(remote))).status, 404, "the proposed share is not public before apply");

  remote = applyOperation(remote, createOperation, NEXT_VERSION);
  const catalogueResponse = await publicBase.handle(new Request(url), publicContext(remote));
  assert.equal(catalogueResponse.status, 200);
  const catalogue = await catalogueResponse.json() as {
    sceneCount: number;
    rootScenes: Array<{ id: string; title: string }>;
    tree: unknown[];
  };
  assert.equal(catalogue.sceneCount, 1);
  assert.deepEqual(catalogue.rootScenes, [{ id: "root-scene", title: "夜の駅" }]);
  assert.deepEqual(catalogue.tree, []);
  assert.doesNotMatch(JSON.stringify(catalogue), /PRIVATE NOTE BODY/u);

  const rootResponse = await publicScene.handle(new Request(url + "/scenes/root-scene"), publicContext(remote));
  assert.equal(rootResponse.status, 200);
  assert.equal((await rootResponse.json() as { body: string }).body, "ROOT-ONLY BODY\n");
  assert.equal((await publicScene.handle(new Request(url + "/scenes/sc-1"), publicContext(remote))).status, 404,
    "the same-title chapter scene is outside the selected root-scene scope");
});

test("public share refuses a root scene that collides with an existing chapter scene ID", async () => {
  const files = fixtureFiles();
  files.set("plot/volumes/root/chapters/root/scenes/duplicate.yaml",
    "kind: scene\\nid: sc-1\\ntitle: Conflicting root\\nmanuscript: documents/conflict.md\\n".replaceAll("\\n", "\n"));
  files.set("documents/conflict.md", "A distinct manuscript must not be exposed.\n");
  const token = "share_" + "d".repeat(43);
  files.set(SHARE_GRANTS_PATH, JSON.stringify({
    version: 1, grantVersion: 1, revocationVersion: 0, id: "conflict-share",
    tokenHash: hashShareToken(token), scope: { kind: "scene", id: "sc-1" }, label: "Collision",
    createdAt: "2026-01-01T00:00:00.000Z", expiresAt: "2030-01-01T00:00:00.000Z",
  }) + "\n");
  const reader = new MemoryReader(files);
  const [publicBase, publicScene] = createPublishingHttpContributions();
  const context = actionContext(reader, []);
  const url = `https://codexia.invalid/share/${token}`;
  assert.equal((await publicBase!.handle(new Request(url), context)).status, 404);
  assert.equal((await publicScene!.handle(new Request(`${url}/scenes/sc-1`), context)).status, 404);
});

test("publishing migration hook validates the exact-byte episode map and selected hashed share records without duplicate writes", async () => {
  const map = "episodes:\n  - id: ep-old\n    number: 3\n    title: 古い話\n    publishedAt: 2024-02-03\n    scope: chapter\n    scopeId: ch-1\n    legacyNote: keep-me\n";
  const workspace = JSON.stringify([
    { id: "share-1", ownerId: "host-user", projectId: "legacy-project", scope: "ch-1", label: "校正", tokenHash: "d".repeat(64), tokenPrefix: "share_secret", createdAt: "2024-01-01T00:00:00.000Z", expiresAt: "2030-01-01T00:00:00.000Z", revokedAt: "2024-02-01T00:00:00.000Z" },
    { id: "share-nested", ownerId: "host-user", projectId: "legacy-project", scope: { kind: "scene", id: "sc-1", token: "nested-source-scope-secret" }, label: "nested", tokenHash: "c".repeat(64), createdAt: "2024-01-01T00:00:00.000Z", expiresAt: "2030-01-01T00:00:00.000Z" },
    { id: "other-project", ownerId: "host-user", projectId: "other", scope: "ch-9", label: "other", tokenHash: "e".repeat(64), createdAt: "2024-01-01", expiresAt: "2030-01-01" },
  ]);
  const projectFiles = new Map([["meta/publish-episodes.yaml", Buffer.from(map)]]);
  const workspaceFiles = new Map([["app-state/share-tokens.json", Buffer.from(workspace)]]);
  const source = {
    projectRoot: "/synthetic/legacy-project",
    workspaceDataRoot: "/synthetic/workspace",
    readProjectFile: async (path: string) => projectFiles.get(path) ?? null,
    listProjectFiles: async (prefix: string) => [...projectFiles.keys()].filter((path) => path.startsWith(prefix)),
    readWorkspaceFile: async (path: string) => workspaceFiles.get(path) ?? null,
    listWorkspaceFiles: async (prefix: string) => [...workspaceFiles.keys()].filter((path) => path.startsWith(prefix)),
  } as unknown as LegacySourceReader;
  const target = new MemoryReader(new Map());
  const migrationContext: MigrationContext = {
    source,
    target,
    projectId: repository,
    snapshot: target.snapshot,
    enabledModules: new Set(["publishing"]),
    workspaceProjectId: "legacy-project",
  };

  const semantic = await createPublishingMigrationProducer().inspect(migrationContext);
  assert.equal(semantic.operations.length, 0);
  assert.ok(semantic.entries.some((entry) => entry.source === "meta/publish-episodes.yaml" && entry.disposition === "planned"));
  assert.ok(semantic.entries.some((entry) => entry.source === "app-state/share-tokens.json" && entry.recordCount === 1));
  assert.ok(semantic.entries.some((entry) => entry.source === "app-state/share-tokens.json" && entry.disposition === "blocked" && entry.recordCount === 1), "Publishing inspection withholds unsupported nested source scopes");

  const generic = await createWorkspaceProducer().inspect(migrationContext);
  assert.equal(generic.operations.length, 1);
  const migrated = JSON.parse(generic.operations[0]!.writes[0]!.content!.trim());
  assert.equal(migrated.id, "share-1");
  assert.equal(migrated.tokenHash, "d".repeat(64));
  assert.equal(migrated.createdAt, "2024-01-01T00:00:00.000Z");
  assert.equal(migrated.expiresAt, "2030-01-01T00:00:00.000Z");
  assert.equal(migrated.revokedAt, "2024-02-01T00:00:00.000Z");
  assert.ok(!JSON.stringify(migrated).includes("host-user"));
  assert.ok(!JSON.stringify(migrated).includes("share_secret"));
  assert.ok(!JSON.stringify(generic).includes("nested-source-scope-secret"), "unsupported nested legacy scopes are withheld without leaking their fields");
  assert.equal(generic.operations[0]!.writes[0]!.path, SHARE_GRANTS_PATH);

  const exactTarget = new MemoryReader(new Map([[EPISODES_PATH, map]]));
  const roundTrip = await createPublishingMigrationProducer().inspect({ ...migrationContext, target: exactTarget });
  assert.ok(roundTrip.entries.some((entry) => entry.source === "meta/publish-episodes.yaml" && entry.disposition === "unchanged"));
  const module = await createPublishing();
  const episodes = await invokeAction(module, "publishing.episodes.read", {}, actionContext(exactTarget, []));
  const first = (episodes.episodes as Array<Record<string, unknown>>)[0]!;
  assert.equal(first.publishedAt, "2024-02-03");
  assert.equal(first.legacyNote, "keep-me");
});

test("publishing reactivation proposes retained episode bytes and safely merges hashed grants", async () => {
  const episodeBytes = "# author comment stays byte-for-byte\nepisodes:\n  - id: ep-kept\n    number: 4\n    title: 保存された話\n    publishedAt: 2024-05-06\n    scope: chapter\n    scopeId: ch-1\n    vendorField: keep-me\n";
  const grantRows = [
    { id: "grant-z", projectId: repository, scope: { kind: "scene", id: "sc-1", token: "nested-reactivation-scope-secret" }, label: "scene", tokenHash: "f".repeat(64), createdAt: "2024-01-01T00:00:00.000Z", expiresAt: "2030-01-01T00:00:00.000Z", revokedAt: "2024-02-01T00:00:00.000Z", ownerId: "must-not-return", tokenPrefix: "share_never-return", token: "raw-bearer-never-return" },
    { id: "grant-a", projectId: repository, scope: "ch-1", label: "chapter", tokenHash: "e".repeat(64), createdAt: "2024-03-01T00:00:00.000Z", expiresAt: "2030-03-01T00:00:00.000Z", lastUsedAt: "2024-04-01T00:00:00.000Z" },
  ];
  const retainedEpisodePath = "meta/scriptorium/modules/publishing/legacy/files/meta/publish-episodes.yaml";
  const retainedGrantPath = "meta/scriptorium/modules/publishing/legacy/share-grants.jsonl";
  const retainedGrants = grantRows.map((grant) => JSON.stringify(grant)).join("\n") + "\n";
  const target = new MemoryReader(new Map([
    [retainedEpisodePath, episodeBytes],
    [retainedGrantPath, retainedGrants],
  ]));
  const source = {
    projectRoot: "/synthetic/legacy-project-gone",
    workspaceDataRoot: "/synthetic/workspace-gone",
    readProjectFile: async () => null,
    listProjectFiles: async () => [],
    readWorkspaceFile: async () => null,
    listWorkspaceFiles: async () => [],
  } as unknown as LegacySourceReader;
  const migrationContext: MigrationContext = {
    source,
    target,
    projectId: repository,
    snapshot: target.snapshot,
    enabledModules: new Set(["publishing"]),
  };

  const producer = createPublishingMigrationProducer();
  const inspection = await producer.inspect(migrationContext);
  assert.equal(inspection.operations.length, 2);
  const episodeOperation = inspection.operations.find((operation) => operation.writes[0]?.path === EPISODES_PATH)!;
  const grantsOperation = inspection.operations.find((operation) => operation.writes[0]?.path === SHARE_GRANTS_PATH)!;
  assert.equal(episodeOperation.writes[0]!.content, episodeBytes, "episode YAML comments and unknown fields are restored as exact bytes");
  for (const [operation, targetPath, retainedPath] of [
    [episodeOperation, EPISODES_PATH, retainedEpisodePath],
    [grantsOperation, SHARE_GRANTS_PATH, retainedGrantPath],
  ] as const) {
    assert.ok(operation.reads.some((read) => read.path === targetPath && read.revision === null), "new canonical file is guarded as absent");
    assert.equal(operation.reads.find((read) => read.path === retainedPath)?.revision, (await target.read(retainedPath))!.revision, "retained source revision is part of the proposal precondition");
  }
  const mergedRows = grantsOperation.writes[0]!.content!.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.deepEqual(mergedRows.map((grant) => grant.id), ["grant-a", "grant-z"], "new grants are appended in stable ID order");
  assert.equal(mergedRows[0]!.projectId, repository);
  assert.equal(mergedRows[0]!.lastUsedAt, "2024-04-01T00:00:00.000Z");
  assert.equal(mergedRows[1]!.revokedAt, "2024-02-01T00:00:00.000Z");
  assert.deepEqual(mergedRows[1]!.scope, { kind: "scene", id: "sc-1" }, "reactivated object scopes retain only the supported kind and ID");
  const proposalJson = JSON.stringify(inspection);
  for (const secret of ["must-not-return", "share_never-return", "raw-bearer-never-return", "nested-reactivation-scope-secret"]) {
    assert.ok(!proposalJson.includes(secret), `reactivation proposal excludes ${secret}`);
  }
  const repeatedPlan = await producer.inspect(migrationContext);
  assert.deepEqual(repeatedPlan.operations.map((operation) => operation.id), inspection.operations.map((operation) => operation.id), "same retained revisions produce stable operation identities");

  const coreProposal: MigrationInspection = {
    snapshot: target.snapshot,
    entries: inspection.entries,
    operations: inspection.operations,
    recovery: [],
    pendingWorkspace: { repository: false, pendingCommitCount: 0, workingTreePaths: [], untrackedPaths: [], stagedPaths: [], blockers: [] },
  };
  let submitted: ChangeProposal | undefined;
  await proposeMigrationImport({
    async propose(projectId, proposal) {
      assert.equal(projectId, "module-project-1");
      submitted = proposal;
      return proposal;
    },
  }, "module-project-1", coreProposal);
  assert.equal(submitted?.source, "author");
  assert.deepEqual(submitted?.operations.map((operation) => operation.id), inspection.operations.map((operation) => operation.id));
  assert.ok(!JSON.stringify(submitted).includes("nested-reactivation-scope-secret"), "Core proposal payload excludes nested scope secrets");

  const appliedEpisodes = applyOperation(target, episodeOperation, NEXT_VERSION);
  const appliedAll = applyOperation(appliedEpisodes, grantsOperation, NEXT_VERSION);
  const alreadyRestored = await producer.inspect({ ...migrationContext, target: appliedAll, snapshot: appliedAll.snapshot });
  assert.deepEqual(alreadyRestored.operations, [], "reinspection after applying the proposal is idempotent");
  assert.ok(alreadyRestored.entries.some((entry) => entry.target === EPISODES_PATH && entry.disposition === "unchanged"));
  assert.ok(alreadyRestored.entries.some((entry) => entry.target === SHARE_GRANTS_PATH && entry.disposition === "unchanged"));

  const existingGrant = grantRows[0]!;
  const existingContent = JSON.stringify({
    id: existingGrant.id,
    projectId: existingGrant.projectId,
    scope: existingGrant.scope,
    label: existingGrant.label,
    tokenHash: existingGrant.tokenHash,
    createdAt: existingGrant.createdAt,
    expiresAt: existingGrant.expiresAt,
    revokedAt: existingGrant.revokedAt,
  }) + "\n";
  const conflictTarget = new MemoryReader(new Map([
    [retainedGrantPath, retainedGrants],
    [SHARE_GRANTS_PATH, existingContent.replace('"label":"scene"', '"label":"edited"')],
  ]));
  const grantConflict = await producer.inspect({ ...migrationContext, target: conflictTarget, snapshot: conflictTarget.snapshot });
  assert.ok(grantConflict.entries.some((entry) => entry.target === SHARE_GRANTS_PATH && entry.disposition === "conflict"));
  assert.ok(!grantConflict.operations.some((operation) => operation.writes.some((write) => write.path === SHARE_GRANTS_PATH)), "divergent same-ID metadata is never overwritten");

  const episodeConflictTarget = new MemoryReader(new Map([
    [retainedEpisodePath, episodeBytes],
    [EPISODES_PATH, "episodes: []\n"],
  ]));
  const episodeConflict = await producer.inspect({ ...migrationContext, target: episodeConflictTarget, snapshot: episodeConflictTarget.snapshot });
  assert.ok(episodeConflict.entries.some((entry) => entry.target === EPISODES_PATH && entry.disposition === "conflict"));
  assert.ok(!episodeConflict.operations.some((operation) => operation.writes.some((write) => write.path === EPISODES_PATH)), "different canonical episode bytes are never overwritten");
});

test("publishing reactivation defers to live stores and does nothing while disabled", async () => {
  const retainedEpisodePath = "meta/scriptorium/modules/publishing/legacy/files/meta/publish-episodes.yaml";
  const retainedGrantPath = "meta/scriptorium/modules/publishing/legacy/share-grants.jsonl";
  const target = new MemoryReader(new Map([
    [retainedEpisodePath, "episodes: []\n"],
    [retainedGrantPath, JSON.stringify({ id: "grant-1", projectId: repository, scope: "ch-1", label: "chapter", tokenHash: "e".repeat(64), createdAt: "2024-01-01T00:00:00.000Z", expiresAt: "2030-01-01T00:00:00.000Z" }) + "\n"],
  ]));
  const projectFiles = new Map([["meta/publish-episodes.yaml", Buffer.from("episodes: []\n")]]);
  const workspaceFiles = new Map([["share-tokens.json", Buffer.from("[]")]]);
  const source = {
    projectRoot: "/synthetic/live-source",
    workspaceDataRoot: "/synthetic/live-workspace",
    readProjectFile: async (path: string) => projectFiles.get(path) ?? null,
    listProjectFiles: async () => [...projectFiles.keys()],
    readWorkspaceFile: async (path: string) => workspaceFiles.get(path) ?? null,
    listWorkspaceFiles: async () => [...workspaceFiles.keys()],
  } as unknown as LegacySourceReader;
  const producer = createPublishingMigrationProducer();
  const live = await producer.inspect({ source, target, projectId: repository, snapshot: target.snapshot, enabledModules: new Set(["publishing"]) });
  assert.ok(!live.operations.some((operation) => operation.writes.some((write) => write.path === EPISODES_PATH || write.path === SHARE_GRANTS_PATH)));
  assert.ok(!live.entries.some((entry) => entry.source.startsWith("meta/scriptorium/modules/publishing/legacy/")), "live source keeps ownership with its importer");

  const disabled = await producer.inspect({
    source: { ...source, workspaceDataRoot: undefined, readProjectFile: async () => null, readWorkspaceFile: async () => null, listWorkspaceFiles: async () => [] } as LegacySourceReader,
    target,
    projectId: repository,
    snapshot: target.snapshot,
    enabledModules: new Set(),
  });
  assert.deepEqual(disabled.operations, [], "retained values stay unreadable until Publishing is enabled");
  assert.deepEqual(disabled.entries, []);
});

test("EPUB preserves literal placeholder-shaped manuscript text alongside ruby and emphasis", () => {
  assert.equal(manuscriptBodyToXhtml("前@@ARCADIA_MARKUP_0@@後"), "<p>前@@ARCADIA_MARKUP_0@@後</p>");
  assert.equal(manuscriptBodyToXhtml("@@ARCADIA_MARKUP_0@@ |星《ほし》 《《彼女》》 & <"),
    '<p>@@ARCADIA_MARKUP_0@@ <ruby>星<rt>ほし</rt></ruby> <span class="bouten">彼女</span> &amp; &lt;</p>');
});
