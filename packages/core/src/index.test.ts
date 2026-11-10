import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { before, after, test } from "node:test";
import { createPostgresPersistence, migratePostgresDatabase } from "@codexia/persistence-postgres";
import type { ChangeOperation, ChangeProposal, SnapshotId } from "@codexia/contracts";
import { CoreStore } from "./index.js";
const connectionString=process.env.CODEXIA_TEST_DATABASE_URL;
if(!connectionString)throw new Error("CODEXIA_TEST_DATABASE_URL is required for Core PostgreSQL integration tests");
const persistence=createPostgresPersistence(connectionString),core=new CoreStore({persistence});
before(()=>migratePostgresDatabase(connectionString));after(()=>persistence.close());
async function project(){return core.createProject({title:`Core ${randomUUID()}`});}
async function accept(projectId:string,operation:ChangeOperation,snapshot?:SnapshotId){const proposal:ChangeProposal={id:randomUUID(),snapshot:snapshot??{projectId,projectVersion:operation.baseProjectVersion},source:"author",operations:[operation]};await core.propose(projectId,proposal);await core.approve(projectId,{proposalId:proposal.id,operationIds:[operation.id],authorScope:"author"});return core.apply(projectId,operation);}
async function hierarchy(){const p=await project();for(const input of [{kind:"volume",id:"v1",title:"Volume"},{kind:"chapter",id:"c1",title:"Chapter",volumeId:"v1"},{kind:"scene",id:"s1",title:"Scene",volumeId:"v1",chapterId:"c1",manuscriptBody:"Text 😀\n"}] as const){const built=await core.buildCreateHierarchyOperation(p.id,input);await accept(p.id,built.operation,built.snapshot);}return p;}
function operation(snapshot:SnapshotId,path:string,content:string|null,revision:string|null=null):ChangeOperation{return {id:randomUUID(),generation:0,projectId:snapshot.projectId,baseProjectVersion:snapshot.projectVersion,effect:"metadata",reads:[{path,revision}],writes:[{path,revision,content}],message:"Write approved data"};}

test("PostgreSQL is sole project authority, hierarchy creation preserves canonical scene bodies",async()=>{const p=await hierarchy();assert.equal((await core.listProjects()).some(x=>x.id===p.id),true);const tree=await core.tree(p.id);assert.equal(tree.volumes[0]?.chapters[0]?.scenes[0]?.id,"s1");assert.equal((await core.readScene(p.id,"s1")).text,"Text 😀\n");const docs=await persistence.read(r=>r.listDocuments(p.id));assert.equal(docs.length,3);assert.equal((await persistence.read(r=>r.getRevision(p.id,docs.find(d=>d.kind==="scene")!.id,docs.find(d=>d.kind==="scene")!.headRevisionId!)))?.markdown,"Text 😀\n");});
test("immutable pinned readers survive edits and Core process replacement",async()=>{const p=await hierarchy(),reader=await core.reader(p.id);const path="manuscript/v1/c1/s1.md",original=await reader.read(path);await accept(p.id,operation(reader.snapshot,path,"Changed",original!.revision));assert.equal((await reader.read(path))?.content,"Text 😀\n");const restarted=new CoreStore({persistence});assert.equal((await (await restarted.reader(p.id,reader.snapshot)).read(path))?.content,"Text 😀\n");assert.equal((await core.readScene(p.id,"s1")).text,"Changed");});
test("proposal approval binds exact payload and durable replay receipts",async()=>{const p=await project(),reader=await core.reader(p.id),op=operation(reader.snapshot,"bible/notes.yaml","name: A\n");await assert.rejects(core.apply(p.id,op),/approved/);const receipt=await accept(p.id,op);assert.deepEqual(await core.apply(p.id,op),receipt);await assert.rejects(core.apply(p.id,{...op,writes:[{...op.writes[0]!,content:"forged"}]}),/approved/);assert.equal((await new CoreStore({persistence}).listProposals(p.id))[0]?.state,"applied");});
test("duplicate proposal identities reject changed envelopes",async()=>{const p=await project(),reader=await core.reader(p.id),op=operation(reader.snapshot,"bible/a.yaml","A");const proposal:ChangeProposal={id:randomUUID(),snapshot:reader.snapshot,operations:[op],source:"author"};await core.propose(p.id,proposal);assert.deepEqual(await core.propose(p.id,proposal),proposal);await assert.rejects(core.propose(p.id,{...proposal,source:"module"}),/different payload/);});
test("proposal registration and approval preserve content project version",async()=>{const p=await project(),snapshot=(await core.observe(p.id)).snapshot,op=operation(snapshot,"bible/a.yaml","A"),proposal:ChangeProposal={id:randomUUID(),snapshot,operations:[op],source:"author"};await core.propose(p.id,proposal);await core.approve(p.id,{proposalId:proposal.id,operationIds:[op.id],authorScope:"owner"});assert.deepEqual((await core.observe(p.id)).snapshot,snapshot);await core.apply(p.id,op);assert.equal((await core.observe(p.id)).snapshot.projectVersion,snapshot.projectVersion+1);});
test("unapproved and cross-project operations cannot change canonical records",async()=>{const p=await project(),other=await project(),reader=await core.reader(p.id),op=operation(reader.snapshot,"bible/a.yaml","A");await assert.rejects(core.apply(other.id,op),/another project/);await assert.rejects(core.reader(other.id,reader.snapshot),/another project/);await assert.rejects(core.approve(p.id,{proposalId:randomUUID(),operationIds:[op.id],authorScope:"owner"}),/not found/);assert.equal(await (await core.reader(p.id)).read("bible/a.yaml"),null);});
test("stale proposal cannot overwrite a newer canonical body",async()=>{const p=await hierarchy(),reader=await core.reader(p.id),path="manuscript/v1/c1/s1.md",old=await reader.read(path),a=operation(reader.snapshot,path,"A",old!.revision),b=operation(reader.snapshot,path,"B",old!.revision);const proposal:ChangeProposal={id:randomUUID(),snapshot:reader.snapshot,operations:[b],source:"author"};await core.propose(p.id,proposal);await core.approve(p.id,{proposalId:proposal.id,operationIds:[b.id],authorScope:"owner"});await accept(p.id,a);await assert.rejects(core.apply(p.id,b));assert.equal((await core.readScene(p.id,"s1")).text,"A");});
test("disjoint operations approved together can apply in sequence",async()=>{const p=await project(),reader=await core.reader(p.id),a=operation(reader.snapshot,"bible/a.yaml","A"),b=operation(reader.snapshot,"bible/b.yaml","B"),proposal:ChangeProposal={id:randomUUID(),snapshot:reader.snapshot,operations:[a,b],source:"author"};await core.propose(p.id,proposal);await core.approve(p.id,{proposalId:proposal.id,operationIds:[a.id,b.id],authorScope:"owner"});await core.apply(p.id,a);await core.apply(p.id,b);assert.equal((await (await core.reader(p.id)).read("bible/b.yaml"))?.content,"B");});
test("binary module artifacts preserve exact bytes and metadata-backed revisions",async()=>{const p=await project(),reader=await core.reader(p.id),op=operation(reader.snapshot,"assets/image.bin",Buffer.from([0,255,128,32]).toString("base64"));op.writes[0]!.encoding="base64";await accept(p.id,op);const next=await core.reader(p.id);assert.equal((await next.read("assets/image.bin","base64"))?.content,op.writes[0]!.content);assert.deepEqual(await next.listRevisions!("assets"),[{path:"assets/image.bin",revision:(await next.read("assets/image.bin"))!.revision}]);});
test("search and writing statistics share immutable Unicode-aware scene data",async()=>{const p=await hierarchy(),reader=await core.reader(p.id),search=await core.searchSnapshot(p.id,"😀",20,reader.snapshot),stats=await core.writingStatsSnapshot(p.id,reader.snapshot);assert.equal(search.results[0]?.offset,5);assert.equal(stats.stats.totalCharCount,5);assert.deepEqual(stats.snapshot,search.snapshot);});
test("reorder and recursive deletion mutate hierarchy while keeping revision history",async()=>{const p=await hierarchy();const second=await core.buildCreateHierarchyOperation(p.id,{kind:"scene",id:"s2",title:"Second",volumeId:"v1",chapterId:"c1",manuscriptBody:"Second"});await accept(p.id,second.operation);const reorder=await core.buildReorderHierarchyOperation(p.id,{kind:"scene",volumeId:"v1",chapterId:"c1",orderedIds:["s2","s1"]});await accept(p.id,reorder.operation);assert.deepEqual((await core.tree(p.id)).volumes[0]?.chapters[0]?.scenes.map(x=>x.id),["s2","s1"]);const docs=await persistence.read(r=>r.listDocuments(p.id));const scene=docs.find(d=>d.title==="Scene")!;const removal=await core.buildDeleteHierarchyOperation(p.id,{kind:"volume",id:"v1"});await accept(p.id,removal.operation);assert.equal((await core.tree(p.id)).volumes.length,0);assert.equal((await persistence.read(r=>r.getRevision(p.id,scene.id,scene.headRevisionId!)))?.markdown,"Text 😀\n");});
test("manuscript history restores by appending an immutable revision",async()=>{const p=await hierarchy(),reader=await core.reader(p.id),path="manuscript/v1/c1/s1.md",old=await reader.read(path);const history=await core.listManuscriptSnapshots(p.id,"s1");await accept(p.id,operation(reader.snapshot,path,"New",old!.revision));const restore=await core.buildRestoreOperation(p.id,{sceneId:"s1",snapshotId:history.snapshots[0]!.id});await accept(p.id,restore.operation);assert.equal((await core.readScene(p.id,"s1")).text,"Text 😀\n");assert.equal((await core.listManuscriptSnapshots(p.id,"s1")).snapshots.length,3);});
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
