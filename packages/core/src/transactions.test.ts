import assert from "node:assert/strict";
import { randomUUID,createHash } from "node:crypto";
import { before,after,test } from "node:test";
import { createPostgresPersistence,migratePostgresDatabase } from "@codexia/persistence-postgres";
import { CoreStore } from "./index.js";
const connectionString=process.env.CODEXIA_TEST_DATABASE_URL;if(!connectionString)throw new Error("CODEXIA_TEST_DATABASE_URL is required for Core PostgreSQL integration tests");
const persistence=createPostgresPersistence(connectionString);before(()=>migratePostgresDatabase(connectionString));after(()=>persistence.close());
const core = new CoreStore({ persistence });
async function project(){return persistence.transaction(tx=>tx.createProject({title:randomUUID()}));}
async function doc(projectId:Awaited<ReturnType<typeof project>>["id"],title="Document"){return persistence.transaction(tx=>tx.createDocument({projectId,kind:"scene",title,orderKey:"1",markdown:"Text 😀",authorId:"owner",idempotencyKey:randomUUID()}));}
test("metadata CAS rejects stale clients and parent cycles",async()=>{const p=await project(),a=await doc(p.id,"A"),b=await doc(p.id,"B");await persistence.transaction(tx=>tx.updateDocument({projectId:p.id,documentId:b.document.id,parentId:a.document.id,expectedVersion:b.document.version}));await assert.rejects(persistence.transaction(tx=>tx.updateDocument({projectId:p.id,documentId:a.document.id,parentId:b.document.id,expectedVersion:a.document.version})),/cycle/);await persistence.transaction(tx=>tx.updateDocument({projectId:p.id,documentId:a.document.id,title:"Renamed",expectedVersion:a.document.version}));await assert.rejects(persistence.transaction(tx=>tx.updateDocument({projectId:p.id,documentId:a.document.id,title:"Stale",expectedVersion:a.document.version})));});
test("module record CAS and project revision fencing are atomic",async()=>{const p=await project();const record=await persistence.transaction(tx=>tx.saveModuleRecord({projectId:p.id,moduleId:"story",key:"settings",value:{language:"ja"},expectedVersion:null}));assert.equal(record.version,1);await assert.rejects(persistence.transaction(tx=>tx.saveModuleRecord({projectId:p.id,moduleId:"story",key:"settings",value:{},expectedVersion:null})));await assert.rejects(persistence.transaction(async tx=>{await tx.assertProjectVersion(p.id,p.version);await tx.saveModuleRecord({projectId:p.id,moduleId:"story",key:"settings",value:{},expectedVersion:1});}));assert.deepEqual((await persistence.read(r=>r.getModuleRecord(p.id,"story","settings")))?.value,{language:"ja"});});
test("failed multi-resource transactions roll back all writes",async()=>{const p=await project(),a=await doc(p.id);await assert.rejects(persistence.transaction(async tx=>{await tx.updateDocument({projectId:p.id,documentId:a.document.id,title:"Should roll back",expectedVersion:a.document.version});await tx.saveModuleRecord({projectId:p.id,moduleId:"story",key:"memo",value:{text:"Should roll back"},expectedVersion:null});throw new Error("injected failure");}));assert.equal((await persistence.read(r=>r.getDocument(p.id,a.document.id)))?.title,"Document");assert.equal(await persistence.read(r=>r.getModuleRecord(p.id,"story","memo")),undefined);});
test("soft deletion preserves exact body revisions and rejects future saves",async()=>{const p=await project(),a=await doc(p.id);await persistence.transaction(tx=>tx.deleteDocument({projectId:p.id,documentId:a.document.id,expectedVersion:a.document.version}));assert.equal(await persistence.read(r=>r.getDocument(p.id,a.document.id)),undefined);assert.equal((await persistence.read(r=>r.getRevision(p.id,a.document.id,a.revision.id)))?.markdown,"Text 😀");await assert.rejects(persistence.transaction(tx=>tx.saveDocument({projectId:p.id,documentId:a.document.id,baseRevisionId:a.revision.id,changes:[],resultingSha256:createHash("sha256").update("Text 😀").digest("hex"),authorId:"owner",clientId:"client",idempotencyKey:randomUUID()})));});
test("approved ChangeSets atomically include hierarchy metadata and module settings",async()=>{const p=await project(),a=await doc(p.id);let set=await persistence.transaction(tx=>tx.createChangeSet({projectId:p.id,authorId:"owner",idempotencyKey:randomUUID(),operations:[{type:"document.update",command:{projectId:p.id,documentId:a.document.id,title:"Updated",expectedVersion:a.document.version}},{type:"module.record.save",command:{projectId:p.id,moduleId:"story",key:"config",value:{enabled:true},expectedVersion:null}}],readSet:[{resource:"document",id:a.document.id,expectedVersion:a.document.version,expectedRevisionId:a.revision.id}],writeSet:[{resource:"document",id:a.document.id},{resource:"module_record",id:JSON.stringify(["story","config"])}],provenance:{source:"author",actorId:"owner",details:{}}}));const approved=await persistence.transaction(tx=>tx.approveChangeSet({projectId:p.id,changeSetId:set.changeSet.id,expectedVersion:set.changeSet.version,approvedBy:"owner"}));await persistence.transaction(tx=>tx.applyChangeSet({projectId:p.id,changeSetId:approved.id,expectedVersion:approved.version}));assert.equal((await persistence.read(r=>r.getDocument(p.id,a.document.id)))?.title,"Updated");assert.deepEqual((await persistence.read(r=>r.getModuleRecord(p.id,"story","config")))?.value,{enabled:true});});


// Independent lifecycle model. The fixtures are real PostgreSQL records and
// each event starts from an explicitly reached state; never derive the expected
// transition from the implementation's response.
test("ChangeSet transition graph preserves approval, version and durable receipt boundaries", async t => {
  type State = "proposed" | "approved" | "rejected" | "applied";
  type Event = "approve" | "reject" | "apply";
  type Version = "current" | "previous";
  const prefixes: Record<State, readonly Event[]> = {
    proposed: [], approved: ["approve"], rejected: ["reject"], applied: ["approve","apply"],
  };
  const allowed: Record<State, Partial<Record<Event, State>>> = {
    proposed: {approve:"approved",reject:"rejected"},
    approved: {apply:"applied"}, rejected:{}, applied:{},
  };
  const events: readonly Event[] = ["approve","reject","apply"];
  for(const state of Object.keys(prefixes) as State[]) {
    for(const event of events) {
      for(const version of ["current","previous"] as const satisfies readonly Version[]) {
        const trace = [state,event,version].join(" → ");
        await t.test(trace,async()=>{
          const p=await project(),a=await doc(p.id);
          const command: import("@codexia/persistence-contracts").CreateChangeSetCommand = {
            projectId:p.id,authorId:"owner",idempotencyKey:randomUUID(),
            operations:[{type:"document.update",command:{projectId:p.id,documentId:a.document.id,title:"Updated",expectedVersion:a.document.version}}],
            readSet:[{resource:"document",id:a.document.id,expectedVersion:a.document.version,expectedRevisionId:a.revision.id}],
            writeSet:[{resource:"document",id:a.document.id}],
            provenance:{source:"author",actorId:"owner",details:{}},
          };
          const created=await persistence.transaction(tx=>tx.createChangeSet(command));
          let current=created.changeSet;
          assert.equal(current.status,"proposed");
          assert.equal(created.replayed,false);
          const changeSetId=current.id;
          const invoke=(action:Event,expectedVersion:number)=>persistence.transaction(async tx=>{
            const request={projectId:p.id,changeSetId,expectedVersion};
            if(action==="approve") return {changeSet:await tx.approveChangeSet({...request,approvedBy:"owner"}),replayed:false};
            if(action==="reject") return {changeSet:await tx.rejectChangeSet({...request,rejectedBy:"owner"}),replayed:false};
            return tx.applyChangeSet(request);
          });
          for(const step of prefixes[state]) current=(await invoke(step,current.version)).changeSet;
          assert.equal(current.status,state);
          const before=await persistence.read(async r=>({
            document:await r.getDocument(p.id,a.document.id),
            receipt:await r.getChangeSetReceipt(p.id,changeSetId),
          }));
          assert.ok(before.document);
          const replay=state==="applied"&&event==="apply"&&version==="previous";
          const next=version==="current"?allowed[state][event]:undefined;
          if(replay||next) {
            const result=await invoke(event,current.version-(version==="previous"?1:0));
            assert.equal(result.changeSet.status,replay?state:next);
            assert.equal(result.replayed,replay);
            assert.equal(result.changeSet.version,replay?current.version:current.version+1);
          } else {
            await assert.rejects(invoke(event,current.version-(version==="previous"?1:0)),trace);
          }
          const after=await persistence.read(async r=>({
            changeSet:await r.getChangeSet(p.id,changeSetId),
            document:await r.getDocument(p.id,a.document.id),
            receipt:await r.getChangeSetReceipt(p.id,changeSetId),
          }));
          const expected=next??state;
          assert.equal(after.changeSet?.status,expected,trace);
          assert.equal(after.changeSet?.version,next?current.version+1:current.version,trace);
          assert.equal(after.document?.title,expected==="applied"?"Updated":"Document");
          assert.equal(after.document?.headRevisionId,a.revision.id,"metadata transition cannot rewrite manuscript");
          assert.equal(after.document?.version,expected==="applied"?a.document.version+1:a.document.version);
          if(expected==="applied") {
            assert.equal(after.receipt?.changeSet.id,changeSetId);
            assert.equal(after.receipt?.changeSet.status,"applied");
            assert.equal(after.receipt?.results.length,1);
          } else assert.equal(after.receipt,undefined);
          if(!next) assert.deepEqual({document:after.document,receipt:after.receipt},before,"denied or replayed event cannot mutate the canonical records");
          const repeated=await persistence.transaction(tx=>tx.createChangeSet(command));
          assert.equal(repeated.replayed,true);
          assert.equal(repeated.changeSet.id,changeSetId);
          assert.equal(repeated.changeSet.status,expected);
          assert.equal(repeated.changeSet.version,after.changeSet?.version);
        });
      }
    }
  }
});

test("Core author review feed presents durable proposal and ChangeSet lifecycles without flattening their receipts", async () => {
  const p = await project();
  const a = await doc(p.id);
  const coreReceipt = { operationId: "historic-op", generation: 0, projectVersion: p.version, revisions: [] };
  await persistence.transaction(tx => tx.saveModuleRecord({
    projectId: p.id, moduleId: "core.authority.proposals", key: "proposal:historic-proposal",
    value: {
      proposal: { id: "historic-proposal", snapshot: { projectId: p.id, projectVersion: p.version }, operations: [], source: "module" },
      state: "partially_approved", approvedOperationIds: ["historic-op"], applications: [coreReceipt], appliedOperationIds: [], stale: false,
    },
    expectedVersion: null,
  }));
  const created = await persistence.transaction(tx => tx.createChangeSet({
    projectId: p.id, authorId: "owner", idempotencyKey: randomUUID(),
    operations: [{ type: "document.update", command: { projectId: p.id, documentId: a.document.id, title: "Reviewed", expectedVersion: a.document.version } }],
    readSet: [{ resource: "document", id: a.document.id, expectedVersion: a.document.version, expectedRevisionId: a.revision.id }],
    writeSet: [{ resource: "document", id: a.document.id }], provenance: { source: "author", actorId: "owner", details: {} },
  }));
  const approved = await persistence.transaction(tx => tx.approveChangeSet({
    projectId: p.id, changeSetId: created.changeSet.id, expectedVersion: created.changeSet.version, approvedBy: "owner",
  }));
  await persistence.transaction(tx => tx.applyChangeSet({ projectId: p.id, changeSetId: approved.id, expectedVersion: approved.version }));

  const feed = await core.listAuthorReviews(p.id);
  assert.deepEqual(feed.map(item => item.kind).sort(), ["core-proposal", "native-change-set"]);
  assert.deepEqual((await core.listAuthorReviews(p.id, 1)).map(item => item.kind).sort(), ["core-proposal", "native-change-set"], "the limit applies to each bounded authority inventory, so neither proposal family is hidden");
  const legacy = feed.find(item => item.kind === "core-proposal");
  assert.ok(legacy?.kind === "core-proposal");
  assert.equal(legacy.status.state, "partially_approved");
  assert.deepEqual(legacy.receipts, [coreReceipt]);
  const native = feed.find(item => item.kind === "native-change-set");
  assert.ok(native?.kind === "native-change-set");
  assert.equal(native.changeSet.status, "applied");
  assert.equal(native.receipt?.replayed, false);
  assert.equal(native.receipt?.results.length, 1);
});
