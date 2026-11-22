import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import YAML from "yaml";
import { before, after, test } from "node:test";
import { createPostgresPersistence, migratePostgresDatabase } from "@codexia/persistence-postgres";
import type { ChangeOperation, ChangeProposal, SnapshotId } from "@codexia/contracts";
import { CoreError, CoreStore } from "./index.js";
const connectionString=process.env.CODEXIA_TEST_DATABASE_URL;
if(!connectionString)throw new Error("CODEXIA_TEST_DATABASE_URL is required for Core PostgreSQL integration tests");
const persistence=createPostgresPersistence(connectionString),core=new CoreStore({persistence});
before(()=>migratePostgresDatabase(connectionString));after(()=>persistence.close());
async function project(){return core.createProject({title:`Core ${randomUUID()}`});}
async function accept(projectId:string,operation:ChangeOperation,snapshot?:SnapshotId){const proposal:ChangeProposal={id:randomUUID(),snapshot:snapshot??{projectId,projectVersion:operation.baseProjectVersion},source:"author",operations:[operation]};await core.propose(projectId,proposal);await core.approve(projectId,{proposalId:proposal.id,operationIds:[operation.id],authorScope:"author"});return core.apply(projectId,operation);}
async function approve(projectId:string,built:{operation:ChangeOperation;snapshot:SnapshotId}){const proposal:ChangeProposal={id:randomUUID(),snapshot:built.snapshot,source:"author",operations:[built.operation]};await core.propose(projectId,proposal);await core.approve(projectId,{proposalId:proposal.id,operationIds:[built.operation.id],authorScope:"author"});return proposal;}
async function hierarchy(){const p=await project();for(const input of [{kind:"volume",id:"v1",title:"Volume"},{kind:"chapter",id:"c1",title:"Chapter",volumeId:"v1"},{kind:"scene",id:"s1",title:"Scene",volumeId:"v1",chapterId:"c1",manuscriptBody:"Text 😀\n"}] as const){const built=await core.buildCreateHierarchyOperation(p.id,input);await accept(p.id,built.operation,built.snapshot);}return p;}
function operation(snapshot:SnapshotId,path:string,content:string|null,revision:string|null=null):ChangeOperation{return {id:randomUUID(),generation:0,projectId:snapshot.projectId,baseProjectVersion:snapshot.projectVersion,effect:"metadata",reads:[{path,revision}],writes:[{path,revision,content}],message:"Write approved data"};}
function isHierarchyConflict(error: unknown): boolean {
  return error instanceof CoreError && ["hierarchy_parent_changed", "revision_conflict", "scope_conflict"].includes(error.code);
}

test("PostgreSQL is sole project authority, hierarchy creation preserves canonical scene bodies",async()=>{const p=await hierarchy();assert.equal((await core.listProjects()).some(x=>x.id===p.id),true);const tree=await core.tree(p.id);assert.equal(tree.volumes[0]?.chapters[0]?.scenes[0]?.id,"s1");assert.equal((await core.readScene(p.id,"s1")).text,"Text 😀\n");const docs=await persistence.read(r=>r.listDocuments(p.id));assert.equal(docs.length,3);assert.equal((await persistence.read(r=>r.getRevision(p.id,docs.find(d=>d.kind==="scene")!.id,docs.find(d=>d.kind==="scene")!.headRevisionId!)))?.markdown,"Text 😀\n");});
test("PostgreSQL projection labels a note with misleading scene ancestry by its canonical document kind", async () => {
  const p = await hierarchy();
  const documents = await persistence.read((reader) => reader.listDocuments(p.id));
  const scene = documents.find((document) => document.kind === "scene")!;
  const chapter = documents.find((document) => document.kind === "chapter")!;
  const note = await persistence.transaction((transaction) => transaction.createDocument({
    projectId: p.id,
    kind: "note",
    parentId: scene.id,
    title: "Author note",
    orderKey: "0002",
    markdown: "Private note body",
    authorId: "owner",
    idempotencyKey: randomUUID(),
  }));
  const reader = await core.reader(p.id);
  const misleadingPath = `plot/volumes/${chapter.id}/chapters/${scene.id}/scenes/${note.document.id}.yaml`;
  const projectedNote = await reader.read(misleadingPath);
  assert.equal(YAML.parse(projectedNote!.content).kind, undefined, "the immutable projection bytes remain unchanged");
  assert.equal(projectedNote!.documentKind, "note");
  assert.equal((await reader.read(`documents/${note.document.id}.md`))?.documentKind, "note", "native body reads expose their canonical PostgreSQL document kind");
  const pinnedReader = await core.reader(p.id, reader.snapshot);
  assert.equal((await pinnedReader.read(misleadingPath))?.documentKind, "note", "pinned stored snapshots expose their canonical document kind");
  assert.equal((await pinnedReader.read(`documents/${note.document.id}.md`))?.documentKind, "note", "pinned native body reads expose their canonical PostgreSQL document kind");
  const tree = await core.tree(p.id);
  assert.deepEqual(tree.volumes.map((volume) => volume.id), ["v1"]);
  assert.deepEqual(tree.volumes[0]?.chapters.map((chapter) => chapter.id), ["c1"]);
  assert.deepEqual(tree.volumes[0]?.chapters[0]?.scenes.map((item) => item.id), ["s1"]);
});
test("native document snapshots expose authoritative chapter and scene parent identities", async () => {
  const p = await project();
  const create = (kind: string, parentId: import("@codexia/persistence-contracts").DocumentId | null, title: string) =>
    persistence.transaction(tx => tx.createDocument({
      projectId: p.id, kind, parentId, title, orderKey: "0001", markdown: "本文😀",
      authorId: "owner", idempotencyKey: randomUUID(),
    }));
  const volume = (await create("volume", null, "Volume")).document;
  const chapter = (await create("chapter", volume.id, "Chapter")).document;
  const scene = (await create("scene", chapter.id, "Scene")).document;
  const reader = await core.reader(p.id);
  const chapterPath = `plot/volumes/${volume.id}/chapters/${chapter.id}/chapter.yaml`;
  const scenePath = `plot/volumes/${volume.id}/chapters/${chapter.id}/scenes/${scene.id}.yaml`;
  const chapterMeta = YAML.parse((await reader.read(chapterPath))!.content);
  const sceneMeta = YAML.parse((await reader.read(scenePath))!.content);
  assert.equal(chapterMeta.volume, volume.id);
  assert.equal(sceneMeta.volume, volume.id);
  assert.equal(sceneMeta.chapter, chapter.id);
  assert.equal(sceneMeta.manuscript, `documents/${scene.id}.md`);
  assert.equal((await reader.read(sceneMeta.manuscript))?.content, "本文😀");
  assert.equal((await reader.read(sceneMeta.manuscript))?.documentKind, "scene", "native scene body reads expose their canonical PostgreSQL document kind");
  assert.equal((await core.tree(p.id)).volumes[0]?.chapters[0]?.scenes[0]?.id, scene.id);
});

test("mapped hierarchy preserves logical IDs and ignores conflicting stored parent metadata", async () => {
  const p = await hierarchy();
  const first = await core.reader(p.id);
  const path = "plot/volumes/v1/chapters/c1/scenes/s1.yaml";
  const before = (await first.read(path))!;
  const meta = YAML.parse(before.content);
  assert.equal(meta.volume, "v1");
  assert.equal(meta.chapter, "c1");
  await accept(p.id, operation(first.snapshot, path,
    YAML.stringify({ ...meta, volume: "unrelated", chapter: "unrelated" }), before.revision));
  const next = await core.reader(p.id);
  const actual = YAML.parse((await next.read(path))!.content);
  assert.equal(actual.volume, "v1");
  assert.equal(actual.chapter, "c1");
  assert.equal(actual.id, "s1");
  assert.equal(actual.manuscript, "manuscript/v1/c1/s1.md");
  assert.equal(YAML.parse((await next.read("plot/volumes/v1/chapters/c1/chapter.yaml"))!.content).volume, "v1");
  assert.equal(YAML.parse((await first.read(path))!.content).chapter, "c1");
});

test("immutable pinned readers survive edits and Core process replacement",async()=>{const p=await hierarchy(),reader=await core.reader(p.id);const path="manuscript/v1/c1/s1.md",original=await reader.read(path);await accept(p.id,operation(reader.snapshot,path,"Changed",original!.revision));assert.equal((await reader.read(path))?.content,"Text 😀\n");const restarted=new CoreStore({persistence});assert.equal((await (await restarted.reader(p.id,reader.snapshot)).read(path))?.content,"Text 😀\n");assert.equal((await core.readScene(p.id,"s1")).text,"Changed");});
test("pinned Knowledge projection retains original identity and anchored quote after Knowledge and body edits",async()=>{
  const p=await hierarchy(),documents=await persistence.read(r=>r.listDocuments(p.id)),scene=documents.find(document=>document.kind==="scene")!,revision=scene.headRevisionId!;
  const nodeId=randomUUID() as import("@codexia/persistence-contracts").KnowledgeNodeId,evidenceId=randomUUID() as import("@codexia/persistence-contracts").EvidenceId;
  await persistence.transaction(async tx=>{
    await tx.saveKnowledgeNode({projectId:p.id,id:nodeId,type:"lore",name:"Original clue",attributes:{},status:"confirmed",expectedVersion:null});
    await tx.saveEvidenceAnchor({projectId:p.id,id:evidenceId,documentId:scene.id,revisionId:revision,fromUtf16:0,toUtf16:"Text 😀\n".length,quoteSha256:createHash("sha256").update("Text 😀\n").digest("hex"),status:"confirmed",expectedVersion:null});
    await tx.saveMentionLink({projectId:p.id,evidenceId,nodeId,status:"confirmed",source:"author",confidence:1,extractorVersion:null});
  });
  const pinned=await core.reader(p.id),contextPath="meta/scriptorium/knowledge-context/v1.json",original=JSON.parse((await pinned.read(contextPath))!.content);
  await persistence.transaction(tx=>tx.saveKnowledgeNode({projectId:p.id,id:nodeId,type:"lore",name:"Edited clue",attributes:{},status:"confirmed",expectedVersion:1}));
  const knowledgeEdited=await core.reader(p.id),manuscriptPath="manuscript/v1/c1/s1.md",body=(await knowledgeEdited.read(manuscriptPath))!;
  await accept(p.id,operation(knowledgeEdited.snapshot,manuscriptPath,"Edited manuscript",body.revision));
  const current=JSON.parse((await (await core.reader(p.id)).read(contextPath))!.content),pinnedAgain=JSON.parse((await pinned.read(contextPath))!.content);
  assert.equal(original.entries[0].node.name,"Original clue");
  assert.equal(original.entries[0].evidence[0].quote,"Text 😀\n");
  assert.equal(current.entries[0].node.name,"Edited clue");
  assert.notEqual(current.entries[0].evidence[0].sourceRevisionId,revision);
  assert.equal(current.entries[0].evidence[0].quote,"Edited manuscript","the current snapshot resolves only the new exact anchor quote");
  assert.equal(current.entries[0].evidence[0].stale,false);
  assert.deepEqual(pinnedAgain,original);
});
test("proposal approval binds exact payload and durable replay receipts",async()=>{const p=await project(),reader=await core.reader(p.id),op=operation(reader.snapshot,"bible/notes.yaml","name: A\n");await assert.rejects(core.apply(p.id,op),/approved/);const receipt=await accept(p.id,op);assert.deepEqual(await core.apply(p.id,op),receipt);await assert.rejects(core.apply(p.id,{...op,writes:[{...op.writes[0]!,content:"forged"}]}),/approved/);assert.equal((await new CoreStore({persistence}).listProposals(p.id))[0]?.state,"applied");});
test("duplicate proposal identities reject changed envelopes",async()=>{const p=await project(),reader=await core.reader(p.id),op=operation(reader.snapshot,"bible/a.yaml","A");const proposal:ChangeProposal={id:randomUUID(),snapshot:reader.snapshot,operations:[op],source:"author"};await core.propose(p.id,proposal);assert.deepEqual(await core.propose(p.id,proposal),proposal);await assert.rejects(core.propose(p.id,{...proposal,source:"module"}),/different payload/);});
test("proposal registration and approval preserve content project version",async()=>{const p=await project(),snapshot=(await core.observe(p.id)).snapshot,op=operation(snapshot,"bible/a.yaml","A"),proposal:ChangeProposal={id:randomUUID(),snapshot,operations:[op],source:"author"};await core.propose(p.id,proposal);await core.approve(p.id,{proposalId:proposal.id,operationIds:[op.id],authorScope:"owner"});assert.deepEqual((await core.observe(p.id)).snapshot,snapshot);await core.apply(p.id,op);assert.equal((await core.observe(p.id)).snapshot.projectVersion,snapshot.projectVersion+1);});
test("unapproved and cross-project operations cannot change canonical records",async()=>{const p=await project(),other=await project(),reader=await core.reader(p.id),op=operation(reader.snapshot,"bible/a.yaml","A");await assert.rejects(core.apply(other.id,op),/another project/);await assert.rejects(core.reader(other.id,reader.snapshot),/another project/);await assert.rejects(core.approve(p.id,{proposalId:randomUUID(),operationIds:[op.id],authorScope:"owner"}),/not found/);assert.equal(await (await core.reader(p.id)).read("bible/a.yaml"),null);});
test("stale proposal cannot overwrite a newer canonical body",async()=>{const p=await hierarchy(),reader=await core.reader(p.id),path="manuscript/v1/c1/s1.md",old=await reader.read(path),a=operation(reader.snapshot,path,"A",old!.revision),b=operation(reader.snapshot,path,"B",old!.revision);const proposal:ChangeProposal={id:randomUUID(),snapshot:reader.snapshot,operations:[b],source:"author"};await core.propose(p.id,proposal);await core.approve(p.id,{proposalId:proposal.id,operationIds:[b.id],authorScope:"owner"});await accept(p.id,a);await assert.rejects(core.apply(p.id,b));assert.equal((await core.readScene(p.id,"s1")).text,"A");});
test("disjoint operations approved together can apply in sequence",async()=>{const p=await project(),reader=await core.reader(p.id),a=operation(reader.snapshot,"bible/a.yaml","A"),b=operation(reader.snapshot,"bible/b.yaml","B"),proposal:ChangeProposal={id:randomUUID(),snapshot:reader.snapshot,operations:[a,b],source:"author"};await core.propose(p.id,proposal);await core.approve(p.id,{proposalId:proposal.id,operationIds:[a.id,b.id],authorScope:"owner"});await core.apply(p.id,a);await core.apply(p.id,b);assert.equal((await (await core.reader(p.id)).read("bible/b.yaml"))?.content,"B");});
test("binary module artifacts preserve exact bytes and metadata-backed revisions",async()=>{const p=await project(),reader=await core.reader(p.id),op=operation(reader.snapshot,"assets/image.bin",Buffer.from([0,255,128,32]).toString("base64"));op.writes[0]!.encoding="base64";await accept(p.id,op);const next=await core.reader(p.id);assert.equal((await next.read("assets/image.bin","base64"))?.content,op.writes[0]!.content);assert.deepEqual(await next.listRevisions!("assets"),[{path:"assets/image.bin",revision:(await next.read("assets/image.bin"))!.revision}]);});
test("search and writing statistics share immutable Unicode-aware scene data",async()=>{const p=await hierarchy(),reader=await core.reader(p.id),search=await core.searchSnapshot(p.id,"😀",20,reader.snapshot),stats=await core.writingStatsSnapshot(p.id,reader.snapshot);assert.equal(search.results[0]?.offset,5);assert.equal(stats.stats.totalCharCount,5);assert.deepEqual(stats.snapshot,search.snapshot);});
test("reorder and recursive deletion mutate hierarchy while keeping revision history",async()=>{const p=await hierarchy();const second=await core.buildCreateHierarchyOperation(p.id,{kind:"scene",id:"s2",title:"Second",volumeId:"v1",chapterId:"c1",manuscriptBody:"Second"});await accept(p.id,second.operation);const reorder=await core.buildReorderHierarchyOperation(p.id,{kind:"scene",volumeId:"v1",chapterId:"c1",orderedIds:["s2","s1"]});await accept(p.id,reorder.operation);assert.deepEqual((await core.tree(p.id)).volumes[0]?.chapters[0]?.scenes.map(x=>x.id),["s2","s1"]);const docs=await persistence.read(r=>r.listDocuments(p.id));const scene=docs.find(d=>d.title==="Scene")!;const removal=await core.buildDeleteHierarchyOperation(p.id,{kind:"volume",id:"v1"});await accept(p.id,removal.operation);assert.equal((await core.tree(p.id)).volumes.length,0);assert.equal((await persistence.read(r=>r.getRevision(p.id,scene.id,scene.headRevisionId!)))?.markdown,"Text 😀\n");});
test("scene reorder rejects a chapter that belongs to a different volume", async () => {
  const p = await hierarchy();
  const otherVolume = await core.buildCreateHierarchyOperation(p.id, { kind: "volume", id: "v2", title: "Other volume" });
  await accept(p.id, otherVolume.operation);
  await assert.rejects(core.buildReorderHierarchyOperation(p.id, {
    kind: "scene", volumeId: "v2", chapterId: "c1", orderedIds: ["s1"],
  }), (error: unknown) => error instanceof CoreError && error.code === "invalid_hierarchy_parent");
  assert.deepEqual((await core.tree(p.id)).volumes[0]?.chapters[0]?.scenes.map(scene => scene.id), ["s1"]);
});
test("PostgreSQL append keys preserve creation order across digit boundaries and reordered siblings", async () => {
  const p = await project();
  const create = async (input: Parameters<typeof core.buildCreateHierarchyOperation>[1]) => {
    const built = await core.buildCreateHierarchyOperation(p.id, input);
    await accept(p.id, built.operation);
  };
  const volumeIds = Array.from({ length: 10 }, (_, index) => `volume-${index + 1}`);
  for (const [index, id] of volumeIds.entries()) await create({ kind: "volume", id, title: `Volume ${index + 1}` });
  const chapterIds = Array.from({ length: 10 }, (_, index) => `chapter-${index + 1}`);
  for (const [index, id] of chapterIds.entries()) await create({
    kind: "chapter", id, title: `Chapter ${index + 1}`, volumeId: volumeIds[0]!,
  });
  const sceneIds = Array.from({ length: 10 }, (_, index) => `scene-${index + 1}`);
  for (const [index, id] of sceneIds.entries()) await create({
    kind: "scene", id, title: `Scene ${index + 1}`, volumeId: volumeIds[0]!, chapterId: chapterIds[0]!,
  });

  const before = await persistence.read(reader => reader.listDocuments(p.id));
  assert.deepEqual((await core.tree(p.id)).volumes.map(volume => volume.id), volumeIds);
  assert.deepEqual((await core.tree(p.id)).volumes[0]?.chapters.map(chapter => chapter.id), chapterIds);
  assert.deepEqual((await core.tree(p.id)).volumes[0]?.chapters[0]?.scenes.map(scene => scene.id), sceneIds);
  assert.equal(before.find(document => document.kind === "volume" && document.title === "Volume 10")?.orderKey, "0000000010");
  assert.equal(before.find(document => document.kind === "chapter" && document.title === "Chapter 10")?.orderKey, "0000000010");
  assert.equal(before.find(document => document.kind === "scene" && document.title === "Scene 10")?.orderKey, "0000000010");

  const reorder = await core.buildReorderHierarchyOperation(p.id, { kind: "volume", orderedIds: [...volumeIds].reverse() });
  await accept(p.id, reorder.operation);
  const beforeAppend = await persistence.read(reader => reader.listDocuments(p.id));
  const oldVolumeKeys = new Map(beforeAppend.filter(document => document.kind === "volume").map(document => [document.title, document.orderKey]));
  await create({ kind: "volume", id: "volume-11", title: "Volume 11" });
  const afterAppend = await persistence.read(reader => reader.listDocuments(p.id));
  for (const document of afterAppend.filter(document => document.kind === "volume" && document.title !== "Volume 11")) {
    assert.equal(document.orderKey, oldVolumeKeys.get(document.title), "append does not rewrite existing order keys");
  }
  assert.equal(afterAppend.find(document => document.kind === "volume" && document.title === "Volume 11")?.orderKey, "0000000010");
  assert.deepEqual((await core.tree(p.id)).volumes.map(volume => volume.id), [...volumeIds].reverse().concat("volume-11"));
});
test("reordering a moved scene preserves its authoritative PostgreSQL parent", async () => {
  const p = await hierarchy();
  const secondChapter = await core.buildCreateHierarchyOperation(p.id, {
    kind: "chapter", id: "c2", title: "Second chapter", volumeId: "v1",
  });
  await accept(p.id, secondChapter.operation);
  const secondScene = await core.buildCreateHierarchyOperation(p.id, {
    kind: "scene", id: "s2", title: "Second scene", volumeId: "v1", chapterId: "c2",
  });
  await accept(p.id, secondScene.operation);

  const documents = await persistence.read(reader => reader.listDocuments(p.id));
  const scene = documents.find(document => document.kind === "scene" && document.title === "Scene")!;
  const chapter = documents.find(document => document.kind === "chapter" && document.id !== scene.parentId)!;
  await persistence.transaction(tx => tx.updateDocument({
    projectId: p.id, documentId: scene.id, parentId: chapter.id,
    expectedVersion: scene.version,
  }));

  const reorder = await core.buildReorderHierarchyOperation(p.id, {
    kind: "scene", volumeId: "v1", chapterId: "c2", orderedIds: ["s1", "s2"],
  });
  await accept(p.id, reorder.operation);
  const after = await persistence.read(reader => reader.getDocument(p.id, scene.id));
  assert.equal(after?.parentId, chapter.id);
  assert.deepEqual((await core.tree(p.id)).volumes[0]?.chapters.find(item => item.id === "c2")?.scenes.map(item => item.id), ["s1", "s2"]);
});

test("hierarchy create resolves a moved chapter by its current PostgreSQL parent", async () => {
  const p = await hierarchy();
  const volumeCreate = await core.buildCreateHierarchyOperation(p.id, { kind: "volume", id: "v2", title: "Volume 2" });
  await accept(p.id, volumeCreate.operation);
  const documents = await persistence.read(reader => reader.listDocuments(p.id));
  const volume = documents.find(document => document.kind === "volume" && document.title === "Volume 2")!;
  const chapter = documents.find(document => document.kind === "chapter")!;
  await persistence.transaction(tx => tx.updateDocument({
    projectId: p.id, documentId: chapter.id, parentId: volume.id, expectedVersion: chapter.version,
  }));

  const addition = await core.buildCreateHierarchyOperation(p.id, {
    kind: "scene", id: "moved-child", title: "Added after move", volumeId: "v2", chapterId: "c1", manuscriptBody: "New text",
  });
  await accept(p.id, addition.operation);
  const scene = (await persistence.read(reader => reader.listDocuments(p.id))).find(document => document.title === "Added after move")!;
  assert.equal(scene.parentId, chapter.id);
  assert.equal((await core.readScene(p.id, "moved-child")).text, "New text");
});

test("hierarchy create rejects a chapter moved after proposal construction", async () => {
  const p = await hierarchy();
  const volumeCreate = await core.buildCreateHierarchyOperation(p.id, { kind: "volume", id: "v2", title: "Volume 2" });
  await accept(p.id, volumeCreate.operation);
  const documents = await persistence.read(reader => reader.listDocuments(p.id));
  const volume = documents.find(document => document.kind === "volume" && document.title === "Volume 2")!;
  const chapter = documents.find(document => document.kind === "chapter")!;
  await persistence.transaction(tx => tx.updateDocument({
    projectId: p.id, documentId: chapter.id, parentId: volume.id, expectedVersion: chapter.version,
  }));
  const addition = await core.buildCreateHierarchyOperation(p.id, {
    kind: "scene", id: "stale-child", title: "Must not be added", volumeId: "v2", chapterId: "c1",
  });
  await approve(p.id, addition);
  await persistence.transaction(tx => tx.updateDocument({
    projectId: p.id, documentId: chapter.id, parentId: documents.find(document => document.kind === "volume")!.id,
    expectedVersion: chapter.version + 1,
  }));
  await assert.rejects(core.apply(p.id, addition.operation), (error: unknown) =>
    error instanceof CoreError && error.code === "hierarchy_parent_changed");
  assert.equal((await persistence.read(reader => reader.listDocuments(p.id))).some(document => document.title === "Must not be added"), false);
});

test("hierarchy delete validates the requested parent at proposal and apply time", async () => {
  const p = await hierarchy();
  const volumeCreate = await core.buildCreateHierarchyOperation(p.id, { kind: "volume", id: "v2", title: "Volume 2" });
  await accept(p.id, volumeCreate.operation);
  let documents = await persistence.read(reader => reader.listDocuments(p.id));
  const volumeA = documents.find(document => document.kind === "volume")!;
  const volumeB = documents.find(document => document.kind === "volume" && document.title === "Volume 2")!;
  const chapter = documents.find(document => document.kind === "chapter")!;
  const scene = documents.find(document => document.kind === "scene")!;
  await persistence.transaction(tx => tx.updateDocument({
    projectId: p.id, documentId: chapter.id, parentId: volumeB.id, expectedVersion: chapter.version,
  }));
  await assert.rejects(core.buildDeleteHierarchyOperation(p.id, { kind: "chapter", id: "c1", volumeId: "v1" }),
    (error: unknown) => error instanceof CoreError && error.code === "hierarchy_parent_changed");
  const chapterDelete = await core.buildDeleteHierarchyOperation(p.id, { kind: "chapter", id: "c1", volumeId: "v2" });
  await approve(p.id, chapterDelete);
  await persistence.transaction(tx => tx.updateDocument({
    projectId: p.id, documentId: chapter.id, parentId: volumeA.id, expectedVersion: chapter.version + 1,
  }));
  await assert.rejects(core.apply(p.id, chapterDelete.operation), isHierarchyConflict);

  documents = await persistence.read(reader => reader.listDocuments(p.id));
  const chapterA = documents.find(document => document.kind === "chapter")!;
  const otherChapter = (await core.buildCreateHierarchyOperation(p.id, {
    kind: "chapter", id: "c2", title: "Chapter 2", volumeId: "v2",
  }));
  await accept(p.id, otherChapter.operation);
  const chapterB = (await persistence.read(reader => reader.listDocuments(p.id))).find(document => document.title === "Chapter 2")!;
  await persistence.transaction(tx => tx.updateDocument({
    projectId: p.id, documentId: scene.id, parentId: chapterB.id, expectedVersion: scene.version,
  }));
  await assert.rejects(core.buildDeleteHierarchyOperation(p.id, {
    kind: "scene", id: "s1", volumeId: "v2", chapterId: "c1",
  }), (error: unknown) => error instanceof CoreError && error.code === "hierarchy_parent_changed");
  const sceneDelete = await core.buildDeleteHierarchyOperation(p.id, {
    kind: "scene", id: "s1", volumeId: "v2", chapterId: "c2",
  });
  await approve(p.id, sceneDelete);
  await persistence.transaction(tx => tx.updateDocument({
    projectId: p.id, documentId: scene.id, parentId: chapterA.id, expectedVersion: scene.version + 1,
  }));
  await assert.rejects(core.apply(p.id, sceneDelete.operation), isHierarchyConflict);

  const currentSceneDelete = await core.buildDeleteHierarchyOperation(p.id, {
    kind: "scene", id: "s1", volumeId: "v1", chapterId: "c1",
  });
  await accept(p.id, currentSceneDelete.operation);
  assert.equal((await persistence.read(reader => reader.listDocuments(p.id))).some(document => document.id === scene.id), false);
  const currentChapterDelete = await core.buildDeleteHierarchyOperation(p.id, {
    kind: "chapter", id: "c1", volumeId: "v1",
  });
  await accept(p.id, currentChapterDelete.operation);
  assert.equal((await persistence.read(reader => reader.listDocuments(p.id))).some(document => document.id === chapter.id), false);
});

test("approved reorder rejects a changed sibling set atomically", async () => {
  const p = await hierarchy();
  const second = await core.buildCreateHierarchyOperation(p.id, {
    kind: "scene", id: "s2", title: "Second", volumeId: "v1", chapterId: "c1",
  });
  await accept(p.id, second.operation);
  const reorder = await core.buildReorderHierarchyOperation(p.id, {
    kind: "scene", volumeId: "v1", chapterId: "c1", orderedIds: ["s2", "s1"],
  });
  const proposal: ChangeProposal = {
    id: randomUUID(), snapshot: reorder.snapshot, source: "author", operations: [reorder.operation],
  };
  await core.propose(p.id, proposal);
  await core.approve(p.id, { proposalId: proposal.id, operationIds: [reorder.operation.id], authorScope: "owner" });

  const third = await core.buildCreateHierarchyOperation(p.id, {
    kind: "scene", id: "s3", title: "Third", volumeId: "v1", chapterId: "c1",
  });
  await accept(p.id, third.operation);
  const before = await persistence.read(reader => reader.listDocuments(p.id));
  await assert.rejects(core.apply(p.id, reorder.operation), /sibling set changed/);
  const after = await persistence.read(reader => reader.listDocuments(p.id));
  assert.deepEqual(after.map(document => [document.id, document.parentId, document.orderKey]),
    before.map(document => [document.id, document.parentId, document.orderKey]));
});

test("approved reorder detects a sibling moved in from another compatibility path", async () => {
  const p = await hierarchy();
  const secondChapter = await core.buildCreateHierarchyOperation(p.id, {
    kind: "chapter", id: "c2", title: "Second chapter", volumeId: "v1",
  });
  await accept(p.id, secondChapter.operation);
  const second = await core.buildCreateHierarchyOperation(p.id, {
    kind: "scene", id: "s2", title: "Second", volumeId: "v1", chapterId: "c2",
  });
  await accept(p.id, second.operation);
  const fourth = await core.buildCreateHierarchyOperation(p.id, {
    kind: "scene", id: "s4", title: "Fourth", volumeId: "v1", chapterId: "c2",
  });
  await accept(p.id, fourth.operation);
  const third = await core.buildCreateHierarchyOperation(p.id, {
    kind: "scene", id: "s3", title: "Third", volumeId: "v1", chapterId: "c1",
  });
  await accept(p.id, third.operation);

  const reorder = await core.buildReorderHierarchyOperation(p.id, {
    kind: "scene", volumeId: "v1", chapterId: "c2", orderedIds: ["s4", "s2"],
  });
  const proposal: ChangeProposal = {
    id: randomUUID(), snapshot: reorder.snapshot, source: "author", operations: [reorder.operation],
  };
  await core.propose(p.id, proposal);
  await core.approve(p.id, { proposalId: proposal.id, operationIds: [reorder.operation.id], authorScope: "owner" });

  const documents = await persistence.read(reader => reader.listDocuments(p.id));
  const moved = documents.find(document => document.kind === "scene" && document.title === "Third")!;
  const destination = documents.find(document => document.kind === "chapter" && document.title === "Second chapter")!;
  await persistence.transaction(tx => tx.updateDocument({
    projectId: p.id, documentId: moved.id, parentId: destination.id,
    expectedVersion: moved.version,
  }));
  const staleParentPath = "plot/volumes/v1/chapters/c1/scenes/s3.yaml";
  assert.ok(await (await core.reader(p.id)).read(staleParentPath));

  const before = await persistence.read(reader => reader.listDocuments(p.id));
  await assert.rejects(core.apply(p.id, reorder.operation), /sibling set changed/);
  const after = await persistence.read(reader => reader.listDocuments(p.id));
  assert.deepEqual(after.map(document => [document.id, document.parentId, document.orderKey]),
    before.map(document => [document.id, document.parentId, document.orderKey]));
});

test("legacy approved reorders apply only while their exact base version is current", async () => {
  const currentProject = await hierarchy();
  const currentSecond = await core.buildCreateHierarchyOperation(currentProject.id, {
    kind: "scene", id: "s2", title: "Second", volumeId: "v1", chapterId: "c1",
  });
  await accept(currentProject.id, currentSecond.operation);
  const currentReorder = await core.buildReorderHierarchyOperation(currentProject.id, {
    kind: "scene", volumeId: "v1", chapterId: "c1", orderedIds: ["s2", "s1"],
  });
  delete currentReorder.operation.readDocumentSets;
  await accept(currentProject.id, currentReorder.operation);
  assert.deepEqual((await core.tree(currentProject.id)).volumes[0]?.chapters[0]?.scenes.map(scene => scene.id), ["s2", "s1"]);

  const staleProject = await hierarchy();
  const staleSecond = await core.buildCreateHierarchyOperation(staleProject.id, {
    kind: "scene", id: "s2", title: "Second", volumeId: "v1", chapterId: "c1",
  });
  await accept(staleProject.id, staleSecond.operation);
  const staleReorder = await core.buildReorderHierarchyOperation(staleProject.id, {
    kind: "scene", volumeId: "v1", chapterId: "c1", orderedIds: ["s2", "s1"],
  });
  delete staleReorder.operation.readDocumentSets;
  const proposal: ChangeProposal = {
    id: randomUUID(), snapshot: staleReorder.snapshot, source: "author", operations: [staleReorder.operation],
  };
  await core.propose(staleProject.id, proposal);
  await core.approve(staleProject.id, { proposalId: proposal.id, operationIds: [staleReorder.operation.id], authorScope: "owner" });
  const third = await core.buildCreateHierarchyOperation(staleProject.id, {
    kind: "scene", id: "s3", title: "Third", volumeId: "v1", chapterId: "c1",
  });
  await accept(staleProject.id, third.operation);
  const before = await persistence.read(reader => reader.listDocuments(staleProject.id));
  await assert.rejects(core.apply(staleProject.id, staleReorder.operation), /legacy hierarchy reorder/);
  const after = await persistence.read(reader => reader.listDocuments(staleProject.id));
  assert.deepEqual(after.map(document => [document.id, document.parentId, document.orderKey]),
    before.map(document => [document.id, document.parentId, document.orderKey]));
});
test("manuscript history restores by appending an immutable revision",async()=>{const p=await hierarchy(),reader=await core.reader(p.id),path="manuscript/v1/c1/s1.md",old=await reader.read(path);const history=await core.listManuscriptSnapshots(p.id,"s1");await accept(p.id,operation(reader.snapshot,path,"New",old!.revision));const restore=await core.buildRestoreOperation(p.id,{sceneId:"s1",snapshotId:history.snapshots[0]!.id});await accept(p.id,restore.operation);assert.equal((await core.readScene(p.id,"s1")).text,"Text 😀\n");assert.equal((await core.listManuscriptSnapshots(p.id,"s1")).snapshots.length,3);});
test("Core restore preserves confirmed evidence for identical text and reviews changed quotes", async () => {
  const makeAnchoredProject = async (markdown: string) => {
    const p = await project();
    const volume = (await persistence.transaction(tx => tx.createDocument({ projectId:p.id, kind:"volume", title:"Volume", orderKey:"0001", markdown:"", authorId:"author", idempotencyKey:randomUUID() }))).document;
    const chapter = (await persistence.transaction(tx => tx.createDocument({ projectId:p.id, kind:"chapter", parentId:volume.id, title:"Chapter", orderKey:"0001", markdown:"", authorId:"author", idempotencyKey:randomUUID() }))).document;
    const scene = (await persistence.transaction(tx => tx.createDocument({ projectId:p.id, kind:"scene", parentId:chapter.id, title:"Scene", orderKey:"0001", markdown, authorId:"author", idempotencyKey:randomUUID() }))).document;
    return { p, scene };
  };
  const attachConfirmedEvidence = async (p: {id:string}, scene: {id: string}, revisionId: string, fromUtf16: number, toUtf16: number, quote: string) => {
    const nodeId = randomUUID() as import("@codexia/persistence-contracts").KnowledgeNodeId;
    const evidenceId = randomUUID() as import("@codexia/persistence-contracts").EvidenceId;
    await persistence.transaction(async tx => {
      await tx.saveKnowledgeNode({ projectId:p.id as import("@codexia/persistence-contracts").ProjectId, id:nodeId, type:"character", name:"Entity", attributes:{}, status:"confirmed", expectedVersion:null });
      await tx.saveEvidenceAnchor({ projectId:p.id as import("@codexia/persistence-contracts").ProjectId, id:evidenceId, documentId:scene.id as import("@codexia/persistence-contracts").DocumentId, revisionId:revisionId as import("@codexia/persistence-contracts").RevisionId, fromUtf16, toUtf16, quoteSha256:createHash("sha256").update(quote).digest("hex"), status:"confirmed", expectedVersion:null });
      await tx.saveMentionLink({ projectId:p.id as import("@codexia/persistence-contracts").ProjectId, evidenceId, nodeId, status:"confirmed", source:"author", confidence:1, extractorVersion:null });
    });
    return evidenceId;
  };

  const same = await makeAnchoredProject("ABCDEF");
  const sameHead = same.scene.headRevisionId!;
  const sameEvidence = await attachConfirmedEvidence(same.p, same.scene, sameHead, 1, 3, "BC");
  const duplicate = await persistence.transaction(tx => tx.saveDocument({ projectId:same.p.id as import("@codexia/persistence-contracts").ProjectId, documentId:same.scene.id, baseRevisionId:sameHead, changes:[], resultingSha256:createHash("sha256").update("ABCDEF").digest("hex"), authorId:"author", clientId:"test", idempotencyKey:randomUUID() }));
  const originalSame = await core.buildRestoreOperation(same.p.id, { sceneId:same.scene.id, snapshotId:sameHead });
  assert.equal(originalSame.operation.writes[0]?.textChanges, undefined);
  await accept(same.p.id, originalSame.operation, originalSame.snapshot);
  const sameState = await persistence.read(async reader => {
    const head = await reader.getDocument(same.p.id as import("@codexia/persistence-contracts").ProjectId, same.scene.id);
    const revision = head?.headRevisionId ? await reader.getRevision(same.p.id as import("@codexia/persistence-contracts").ProjectId, same.scene.id, head.headRevisionId) : null;
    return { anchor:await reader.getEvidenceAnchor(same.p.id as import("@codexia/persistence-contracts").ProjectId, sameEvidence), links:await reader.listMentionLinks(same.p.id as import("@codexia/persistence-contracts").ProjectId, sameEvidence), head, revision };
  });
  assert.notEqual(sameState.head?.headRevisionId, duplicate.revision.id);
  assert.equal(sameState.revision?.parentRevisionId, duplicate.revision.id);
  assert.equal(sameState.revision?.markdown, "ABCDEF");
  assert.equal(sameState.anchor?.revisionId, sameState.head?.headRevisionId);
  assert.equal(sameState.anchor?.fromUtf16, 1);
  assert.equal(sameState.anchor?.toUtf16, 3);
  assert.equal(sameState.anchor?.quoteSha256, createHash("sha256").update("BC").digest("hex"));
  assert.equal(sameState.anchor?.status, "confirmed");
  assert.equal(sameState.links[0]?.status, "confirmed");

  const changed = await makeAnchoredProject("ABXDEF");
  const sourceRevisionId = changed.scene.headRevisionId!;
  const changedSave = await persistence.transaction(tx => tx.saveDocument({ projectId:changed.p.id as import("@codexia/persistence-contracts").ProjectId, documentId:changed.scene.id, baseRevisionId:sourceRevisionId, changes:[{fromUtf16:2,toUtf16:3,insert:"C"}], resultingSha256:createHash("sha256").update("ABCDEF").digest("hex"), authorId:"author", clientId:"test", idempotencyKey:randomUUID() }));
  const changedEvidence = await attachConfirmedEvidence(changed.p, changed.scene, changedSave.revision.id, 1, 3, "BC");
  const changedRestore = await core.buildRestoreOperation(changed.p.id, { sceneId:changed.scene.id, snapshotId:sourceRevisionId });
  await accept(changed.p.id, changedRestore.operation, changedRestore.snapshot);
  const changedState = await persistence.read(async reader => ({ anchor:await reader.getEvidenceAnchor(changed.p.id as import("@codexia/persistence-contracts").ProjectId, changedEvidence), links:await reader.listMentionLinks(changed.p.id as import("@codexia/persistence-contracts").ProjectId, changedEvidence) }));
  assert.equal(changedState.anchor?.status, "needs_review");
  assert.equal(changedState.links[0]?.status, "proposed");
});
test("unsafe paths and unbound manuscript artifacts cannot bypass canonical documents",async()=>{const p=await project(),reader=await core.reader(p.id);await assert.rejects(reader.read("../secret"));await assert.rejects(accept(p.id,operation(reader.snapshot,"manuscript/unbound.md","illegal")),/canonical document/);assert.equal(await (await core.reader(p.id)).read("manuscript/unbound.md"),null);});
test("independent approved proposals survive unrelated project changes", async () => {
  const projectRecord = await project();
  const reader = await core.reader(projectRecord.id);
  const operations = [
    operation(reader.snapshot, "bible/a.yaml", "A"),
    operation(reader.snapshot, "bible/b.yaml", "B"),
  ];

  for (const currentOperation of operations) {
    const proposal: ChangeProposal = {
      id: randomUUID(),
      snapshot: reader.snapshot,
      operations: [currentOperation],
      source: "author",
    };
    await core.propose(projectRecord.id, proposal);
    await core.approve(projectRecord.id, {
      proposalId: proposal.id,
      operationIds: [currentOperation.id],
      authorScope: "owner",
    });
  }

  await core.apply(projectRecord.id, operations[0]!);
  await core.apply(projectRecord.id, operations[1]!);
  assert.equal((await (await core.reader(projectRecord.id)).read("bible/b.yaml"))?.content, "B");
});

test("concurrent exact Core retries replay one durable approval receipt", async () => {
  const projectRecord = await project();
  const reader = await core.reader(projectRecord.id);
  const currentOperation = operation(reader.snapshot, "bible/a.yaml", "A");
  const proposal: ChangeProposal = {
    id: randomUUID(),
    snapshot: reader.snapshot,
    operations: [currentOperation],
    source: "author",
  };
  await core.propose(projectRecord.id, proposal);
  await core.approve(projectRecord.id, {
    proposalId: proposal.id,
    operationIds: [currentOperation.id],
    authorScope: "owner",
  });

  const receipts = await Promise.all([
    core.apply(projectRecord.id, currentOperation),
    core.apply(projectRecord.id, currentOperation),
  ]);

  assert.deepEqual(receipts[0], receipts[1]);
  assert.equal((await core.observe(projectRecord.id)).snapshot.projectVersion, reader.snapshot.projectVersion + 1);
});

test("scope membership changes reject the entire approved operation", async () => {
  const { snapshotScopeRevision } = await import("@codexia/contracts");
  const projectRecord = await project();
  const reader = await core.reader(projectRecord.id);
  const currentOperation = operation(reader.snapshot, "meta/result.yaml", "computed");
  currentOperation.readScopes = [{
    prefix: "bible",
    revision: await snapshotScopeRevision(reader, "bible"),
  }];
  const proposal: ChangeProposal = {
    id: randomUUID(),
    snapshot: reader.snapshot,
    operations: [currentOperation],
    source: "author",
  };
  await core.propose(projectRecord.id, proposal);
  await core.approve(projectRecord.id, {
    proposalId: proposal.id,
    operationIds: [currentOperation.id],
    authorScope: "owner",
  });
  await accept(projectRecord.id, operation(reader.snapshot, "bible/new.yaml", "new"));

  await assert.rejects(core.apply(projectRecord.id, currentOperation), /scope changed/);
  assert.equal(await (await core.reader(projectRecord.id)).read("meta/result.yaml"), null);
});
test("scope-bound evidence revisions are checked when proposing and applying", async () => {
  const { snapshotScopeRevision } = await import("@codexia/contracts");
  const projectRecord = await project();
  const reader = await core.reader(projectRecord.id);
  const evidencePath = "bible/source.yaml";
  const operationRecord = operation(reader.snapshot, "meta/result.yaml", "computed");
  operationRecord.readScopes = [{ prefix: "bible", revision: await snapshotScopeRevision(reader, "bible") }];
  operationRecord.evidenceIds = ["source-evidence"];

  const proposal: ChangeProposal = {
    id: randomUUID(),
    snapshot: reader.snapshot,
    operations: [operationRecord],
    source: "author",
    evidence: [{
      id: "source-evidence",
      snapshot: reader.snapshot,
      module: "story",
      kind: "source_entity",
      paths: [{ path: evidencePath, revision: "a".repeat(64) }],
      details: {},
    }],
  };
  await assert.rejects(core.propose(projectRecord.id, proposal), /evidence revision changed/);

  proposal.evidence![0]!.paths[0]!.revision = null;
  await core.propose(projectRecord.id, proposal);
  await core.approve(projectRecord.id, {
    proposalId: proposal.id,
    operationIds: [operationRecord.id],
    authorScope: "owner",
  });
  await accept(projectRecord.id, operation(reader.snapshot, evidencePath, "source"));

  await assert.rejects(core.apply(projectRecord.id, operationRecord), /evidence revision changed/);
  assert.equal(await (await core.reader(projectRecord.id)).read("meta/result.yaml"), null);
});

test("partial approvals preserve each actor in immutable PostgreSQL revisions", async () => {
  const p = await project();
  for (const parent of [
    { kind: "volume", id: "vol-actor", title: "Volume" },
    { kind: "chapter", id: "chapter-actor", title: "Chapter", volumeId: "vol-actor" },
  ] as const) {
    const created = await core.buildCreateHierarchyOperation(p.id, parent);
    await accept(p.id, created.operation, created.snapshot);
  }
  const one = await core.buildCreateHierarchyOperation(p.id, {
    kind: "scene", id: "scene-alice", title: "Alice", volumeId: "vol-actor",
    chapterId: "chapter-actor", manuscriptBody: "Alice's manuscript",
  });
  const two = await core.buildCreateHierarchyOperation(p.id, {
    kind: "scene", id: "scene-bob", title: "Bob", volumeId: "vol-actor",
    chapterId: "chapter-actor", manuscriptBody: "Bob's manuscript",
  });
  assert.deepEqual(one.snapshot, two.snapshot);
  const proposal: ChangeProposal = {
    id: randomUUID(), snapshot: one.snapshot, source: "author",
    operations: [one.operation, two.operation],
  };
  await core.propose(p.id, proposal);
  await core.approve(p.id, {
    proposalId: proposal.id, operationIds: [one.operation.id], authorScope: "hosted:alice",
  });
  await core.approve(p.id, {
    proposalId: proposal.id, operationIds: [two.operation.id], authorScope: "hosted:bob",
  });
  await core.apply(p.id, one.operation);
  await core.apply(p.id, two.operation);
  const documents = await persistence.read((reader) => reader.listDocuments(p.id));
  for (const [title, expectedAuthor] of [["Alice", "hosted:alice"], ["Bob", "hosted:bob"]]) {
    const document = documents.find((candidate) => candidate.title === title);
    assert.ok(document?.headRevisionId);
    const revision = await persistence.read((reader) =>
      reader.getRevision(p.id, document.id, document.headRevisionId!));
    assert.equal(revision?.authorId, expectedAuthor);
  }
});


test("re-approving an already applied proposal does not regress its durable status", async () => {
  const p = await project();
  const snapshot = (await core.reader(p.id)).snapshot;
  const op = operation(snapshot, "bible/reapproval.yaml", "preserved");
  const proposal: ChangeProposal = { id: randomUUID(), snapshot, operations: [op], source: "author" };
  await core.propose(p.id, proposal);
  await core.approve(p.id, { proposalId: proposal.id, operationIds: [op.id], authorScope: "owner" });
  const receipt = await core.apply(p.id, op);
  await core.approve(p.id, { proposalId: proposal.id, operationIds: [op.id], authorScope: "owner" });
  const after = await core.getProposal(p.id, proposal.id);
  assert.equal(after?.state, "applied");
  assert.deepEqual(after?.applications, [receipt]);
  assert.equal(after?.approvedByOperationId?.[op.id], "owner");
});

test("approval bookkeeping handles allowed operation IDs that inherit object properties", async () => {
  const p = await project();
  const snapshot = (await core.reader(p.id)).snapshot;
  const op = { ...operation(snapshot, "bible/inherited-key.yaml", "preserved"), id: "constructor" };
  const proposal: ChangeProposal = { id: randomUUID(), snapshot, operations: [op], source: "author" };
  await core.propose(p.id, proposal);
  await core.approve(p.id, { proposalId: proposal.id, operationIds: [op.id], authorScope: "owner" });
  const after = await core.getProposal(p.id, proposal.id);
  assert.equal(Object.hasOwn(after?.approvedByOperationId ?? {}, "constructor"), true);
  assert.equal(after?.approvedByOperationId?.constructor, "owner");
});

test("duplicate approved proposals share one manuscript application and settle on replay", async () => {
  const p = await hierarchy();
  const reader = await core.reader(p.id);
  const path = "manuscript/v1/c1/s1.md";
  const current = (await reader.read(path))!;
  const op: ChangeOperation = { ...operation(reader.snapshot, path, "One new manuscript revision", current.revision), effect: "manuscript" };
  const proposals: ChangeProposal[] = Array.from({ length: 3 }, () => ({
    id: randomUUID(), snapshot: reader.snapshot, operations: [op], source: "author",
  }));
  for (const proposal of proposals) await core.propose(p.id, proposal);
  const approveDuplicate = (proposal: ChangeProposal) => core.approve(p.id, {
    proposalId: proposal.id, operationIds: [op.id], authorScope: "owner",
  });
  await approveDuplicate(proposals[0]!);
  await approveDuplicate(proposals[1]!);
  const [receipt, retried] = await Promise.all([core.apply(p.id, op), core.apply(p.id, op)]);
  assert.deepEqual(retried, receipt);
  assert.equal((await core.getProposal(p.id, proposals[2]!.id))?.state, "proposed");
  for (const proposal of proposals.slice(0, 2)) {
    const status = await core.getProposal(p.id, proposal.id);
    assert.equal(status?.state, "applied");
    assert.deepEqual(status?.applications, [receipt]);
  }
  await approveDuplicate(proposals[2]!);
  assert.deepEqual(await core.apply(p.id, op), receipt);
  assert.deepEqual((await core.getProposal(p.id, proposals[2]!.id))?.applications, [receipt]);
  assert.equal((await core.reader(p.id)).snapshot.projectVersion, receipt.projectVersion);
  const history = await core.listManuscriptSnapshots(p.id, "s1");
  assert.equal(history.snapshots.length, 2, "replay wrote a second manuscript revision");
  assert.equal((await core.readScene(p.id, "s1")).text, "One new manuscript revision");
});

test("pinned manuscript history never includes or restores a future revision", async () => {
  const p = await hierarchy();
  const old = await core.reader(p.id);
  const path = "manuscript/v1/c1/s1.md";
  const initial = (await core.listManuscriptSnapshots(p.id, "s1", undefined, old.snapshot)).snapshots;
  await accept(p.id, operation(old.snapshot, path, "Future revision", (await old.read(path))!.revision));
  const current = await core.listManuscriptSnapshots(p.id, "s1");
  const future = current.snapshots.find(item => !initial.some(previous => previous.id === item.id))!;
  assert.ok(future);
  assert.deepEqual((await core.listManuscriptSnapshots(p.id, "s1", undefined, old.snapshot)).snapshots, initial);
  assert.equal((await core.readManuscriptSnapshot(p.id, initial[0]!.id, "s1", undefined, old.snapshot)).manuscriptSnapshot.body, "Text 😀\n");
  await assert.rejects(core.readManuscriptSnapshot(p.id, future.id, "s1", undefined, old.snapshot), {code:"revision_not_found"});
  await assert.rejects(core.buildRestoreOperation(p.id, {sceneId:"s1",snapshotId:future.id}, undefined, old.snapshot), {code:"revision_not_found"});
  assert.ok(!(await core.history(p.id, old.snapshot)).some(item => item.hash === future.id));
});

test("review queue preserves proposal ordering, scope and stale semantics", async () => {
  const first=await project(), second=await project(), outside=await project();
  for (const p of [first,second,outside]) {
    const snapshot=(await core.observe(p.id)).snapshot;
    for(const id of ["z-review","a-review"]){
      await core.propose(p.id,{id,snapshot,source:"author",operations:[operation(snapshot,`bible/${id}.yaml`,"A")]});
    }
  }
  const secondSnapshot=(await core.observe(second.id)).snapshot;
  await accept(second.id,operation(secondSnapshot,"bible/other.yaml","B"));
  const expected=[];
  for(const p of [second,first]) for(const proposal of await core.listProposals(p.id))
    if(proposal.state!=="applied")expected.push({projectId:p.id,proposal});
  const page=await core.reviewQueue([second.id,first.id]);
  assert.deepEqual(page,{unresolvedCount:expected.length,items:expected});
  assert.equal(page.unresolvedCount,4);
  assert.ok(page.items.filter(item=>item.projectId===second.id).every(item=>item.proposal.stale));
  assert.ok(page.items.filter(item=>item.projectId===first.id).every(item=>!item.proposal.stale));
});

test("literal search maps lowercase expansions to original UTF-16 ranges", async () => {
  const p=await hierarchy(), reader=await core.reader(p.id), path="manuscript/v1/c1/s1.md";
  await accept(p.id,operation(reader.snapshot,path,"İX 😀",(await reader.read(path))!.revision));
  for(const [query,offset,length] of [["x",1,1],["i",0,1],["İX",0,2],["😀",3,2]] as const) {
    const result=(await core.searchSnapshot(p.id,query)).results.find(item=>item.field==="body");
    assert.ok(result);
    assert.equal(result.offset,offset);
    assert.equal(result.length,length);
  }
});
test("proposal detail, list and review queue agree after a content revision", async () => {
  const p=await project(), snapshot=(await core.observe(p.id)).snapshot;
  const proposal:ChangeProposal={id:randomUUID(),snapshot,source:"author",operations:[operation(snapshot,"bible/a.yaml","A")]};
  await core.propose(p.id,proposal);
  assert.equal((await core.getProposal(p.id,proposal.id))?.stale,false);
  await accept(p.id,operation(snapshot,"bible/b.yaml","B"));
  const detail=await core.getProposal(p.id,proposal.id);
  assert.equal(detail?.stale,true);
  assert.deepEqual((await core.listProposals(p.id)).find(item=>item.proposal.id===proposal.id),detail);
  assert.deepEqual((await core.reviewQueue([p.id])).items.find(item=>item.proposal.proposal.id===proposal.id)?.proposal,detail);
});

test("two approved hierarchy creates with the same logical ID cannot both apply", async () => {
  const p = await hierarchy();
  const secondChapter = await core.buildCreateHierarchyOperation(p.id, {
    kind: "chapter", id: "c2", title: "Second chapter", volumeId: "v1",
  });
  await accept(p.id, secondChapter.operation);
  const first = await core.buildCreateHierarchyOperation(p.id, {
    kind: "scene", id: "duplicate-scene", title: "First proposal", volumeId: "v1", chapterId: "c1",
    manuscriptBody: "First body",
  });
  const second = await core.buildCreateHierarchyOperation(p.id, {
    kind: "scene", id: "duplicate-scene", title: "Second proposal", volumeId: "v1", chapterId: "c2",
    manuscriptBody: "Second body",
  });
  await approve(p.id, first);
  await approve(p.id, second);

  await core.apply(p.id, first.operation);
  const before = await persistence.read(async (reader) => {
    const documents = await reader.listDocuments(p.id, undefined, 1000);
    const history: Array<readonly [string, string[]]> = [];
    for (const document of documents) {
      history.push([document.id, (await reader.listRevisions(p.id, document.id, 100)).revisions.map((revision) => revision.id)]);
    }
    return { documents: documents.map((document) => document.id), history };
  });
  await assert.rejects(core.apply(p.id, second.operation), (error: unknown) =>
    error instanceof CoreError && error.code === "hierarchy_id_exists");
  const after = await persistence.read(async (reader) => {
    const documents = await reader.listDocuments(p.id, undefined, 1000);
    const history: Array<readonly [string, string[]]> = [];
    for (const document of documents) {
      history.push([document.id, (await reader.listRevisions(p.id, document.id, 100)).revisions.map((revision) => revision.id)]);
    }
    return { documents: documents.map((document) => document.id), history };
  });
  assert.deepEqual(after, before, "a rejected logical duplicate must leave no document or revision history");
});

test("existing duplicate logical IDs keep their first-match reads", async () => {
  const p = await project();
  await persistence.transaction(async (transaction) => {
    const volume = (await transaction.createDocument({
      projectId: p.id, kind: "volume", title: "Legacy volume", orderKey: "0001", markdown: "",
      authorId: "author", idempotencyKey: randomUUID(),
    })).document;
    const chapter = (await transaction.createDocument({
      projectId: p.id, parentId: volume.id, kind: "chapter", title: "Legacy chapter", orderKey: "0001", markdown: "",
      authorId: "author", idempotencyKey: randomUUID(),
    })).document;
    for (const [suffix, orderKey, markdown] of [["first", "0001", "First legacy body"], ["second", "0002", "Second legacy body"]] as const) {
      const sceneId = randomUUID() as import("@codexia/persistence-contracts").DocumentId;
      const metadataPath = `plot/volumes/v-legacy/chapters/c-legacy/scenes/${suffix}.yaml`;
      const manuscriptPath = `manuscript/v-legacy/c-legacy/${suffix}.md`;
      const scene = (await transaction.createDocument({
        projectId: p.id, documentId: sceneId, parentId: chapter.id, kind: "scene", title: suffix,
        orderKey, markdown, authorId: "author", idempotencyKey: randomUUID(),
      })).document;
      await transaction.saveModuleRecord({
        projectId: p.id,
        moduleId: "core.document-paths",
        key: scene.id,
        value: {
          metadataPath, manuscriptPath,
          metadata: { id: "legacy-duplicate", title: suffix, order: orderKey },
        },
        expectedVersion: null,
      });
    }
    await transaction.saveModuleRecord({
      projectId: p.id, moduleId: "core.document-paths", key: volume.id,
      value: { metadataPath: "plot/volumes/v-legacy/volume.yaml", metadata: { id: "v-legacy", title: "Legacy volume" } },
      expectedVersion: null,
    });
    await transaction.saveModuleRecord({
      projectId: p.id, moduleId: "core.document-paths", key: chapter.id,
      value: { metadataPath: "plot/volumes/v-legacy/chapters/c-legacy/chapter.yaml", metadata: { id: "c-legacy", title: "Legacy chapter" } },
      expectedVersion: null,
    });
  });

  const tree = await core.tree(p.id);
  assert.deepEqual(tree.volumes[0]?.chapters[0]?.scenes.map((scene) => scene.id), ["legacy-duplicate", "legacy-duplicate"]);
  assert.equal((await core.readScene(p.id, "legacy-duplicate")).text, "First legacy body");
});

test("deleted hierarchy paths stay reserved while revisions and evidence remain addressable", async () => {
  const p = await hierarchy();
  const scene = (await persistence.read((reader) => reader.listDocuments(p.id))).find((document) => document.kind === "scene")!;
  const revisionId = scene.headRevisionId!;
  const evidenceId = randomUUID() as import("@codexia/persistence-contracts").EvidenceId;
  await persistence.transaction((transaction) => transaction.saveEvidenceAnchor({
    projectId: p.id, id: evidenceId, documentId: scene.id, revisionId,
    fromUtf16: 0, toUtf16: "Text 😀\n".length,
    quoteSha256: createHash("sha256").update("Text 😀\n").digest("hex"),
    status: "confirmed", expectedVersion: null,
  }));
  const volume = (await persistence.read((reader) => reader.listDocuments(p.id))).find((document) => document.kind === "volume")!;
  const removal = await core.buildDeleteHierarchyOperation(p.id, { kind: "volume", id: "v1" });
  await accept(p.id, removal.operation);

  assert.equal(await persistence.read((reader) => reader.getDocument(p.id, volume.id)), undefined);
  assert.equal((await persistence.read((reader) => reader.getRevision(p.id, scene.id, revisionId)))?.markdown, "Text 😀\n");
  assert.ok((await persistence.read((reader) => reader.listEvidenceDocumentIds(p.id))).includes(scene.id));
  assert.equal((await persistence.read((reader) => reader.getEvidenceAnchor(p.id, evidenceId)))?.documentId, scene.id);
  await assert.rejects(
    core.buildCreateHierarchyOperation(p.id, { kind: "volume", id: "v1", title: "Recreated volume" }),
    (error: unknown) => error instanceof CoreError && error.code === "hierarchy_path_reserved",
  );
});

test("a path deleted after proposal approval is rejected before recreating its retained document row", async () => {
  const p = await project();
  const pending = await core.buildCreateHierarchyOperation(p.id, { kind: "volume", id: "raced-volume", title: "Pending" });
  await approve(p.id, pending);
  const competing = await core.buildCreateHierarchyOperation(p.id, { kind: "volume", id: "raced-volume", title: "Competing" });
  await accept(p.id, competing.operation);
  const existing = (await persistence.read((reader) => reader.listDocuments(p.id))).find((document) => document.kind === "volume")!;
  const removal = await core.buildDeleteHierarchyOperation(p.id, { kind: "volume", id: "raced-volume" });
  await accept(p.id, removal.operation);

  await assert.rejects(core.apply(p.id, pending.operation), (error: unknown) =>
    error instanceof CoreError && error.code === "hierarchy_path_reserved");
  assert.deepEqual(await persistence.read((reader) => reader.listDocuments(p.id)), []);
  assert.ok(await persistence.read((reader) => reader.getRevision(p.id, existing.id, existing.headRevisionId!)));
});
