import assert from "node:assert/strict";
import { test } from "node:test";
import { assertChangeOperation, type ChangeOperation, type ModuleAction, type ModuleActionContext, type ModuleContext, type SnapshotId, type SnapshotReader } from "@codexia/contracts";
import { createSearchDefinition, createSearchActions } from "./actions.js";
import { SnapshotIndexCache } from "./index-cache.js";
import { TERM_REGISTRY_PATH } from "./terminology.js";

const snapshot: SnapshotId = {
  projectId: "search-fixture",
  projectVersion: 11,
};

function revision(value: string): string {
  let hash = 0x811c9dc5;
  for (const character of value) { hash ^= character.codePointAt(0)!; hash = Math.imul(hash, 0x01000193); }
  return (hash >>> 0).toString(16).padStart(8, "0").repeat(8);
}

function makeReader(values: Record<string, string>, options: { blockReads?: boolean } = {}): SnapshotReader {
  const files = new Map(Object.entries(values).map(([path, content]) => [path, { content, revision: revision(content) }]));
  return {
    snapshot,
    async read(path) { return files.get(path) ?? null; },
    async list(prefix) { return [...files.keys()].filter((path) => path === prefix || path.startsWith(`${prefix}/`)); },
    async listRevisions(prefix) { return [...files].filter(([path]) => path === prefix || path.startsWith(`${prefix}/`)).map(([path, file]) => ({ path, revision: file.revision })); },
  };
}

function actionContext(reader: SnapshotReader, options: {
  invoke?: ModuleActionContext["invoke"];
  propose?: ModuleActionContext["propose"];
} = {}): ModuleActionContext {
  return {
    projectId: "search-fixture", reader, signal: new AbortController().signal,
    async invoke(id, input, signal) { return options.invoke ? options.invoke(id, input, signal) : { ok: false, snapshot, error: { code: "missing_action", message: "missing", retryable: false } }; },
    async listActions() { return []; }, async linkedReader() { throw new Error("unused"); },
    async propose(operations, evidence, proposalId) {
      if (options.propose) return options.propose(operations, evidence, proposalId);
      throw new Error("unexpected proposal");
    }, async runJob() { throw new Error("unused"); },
  };
}

function findAction(actions: ModuleAction[], id: string): ModuleAction {
  const action = actions.find((candidate) => candidate.id === id);
  assert.ok(action, `expected action ${id}`);
  return action;
}

function moduleContext(onAcquire: ModuleContext["acquireCapability"]): ModuleContext {
  return { cacheDirectory: "/tmp/search-test", signal: new AbortController().signal, acquireCapability: onAcquire, async createWorkerService() { throw new Error("search is model-free"); } };
}

test("lexical search does not activate optional NLP or Semantic providers unless requested", async () => {
  let capabilityRequests = 0;
  const module = createSearchDefinition(moduleContext(async () => { capabilityRequests += 1; throw new Error("provider is disabled"); }));
  assert.equal(capabilityRequests, 0, "module registration must not load optional capabilities");
  assert.deepEqual(module.manifest.dependencies, []);
  assert.deepEqual(module.manifest.optionalRequires, ["nlp.tokenizer", "semantic.embedding"]);
  assert.equal(module.ui.find(({ id }) => id === "search.terms")?.contexts?.includes("workspace"), true);
  assert.equal(module.ui.find(({ id }) => id === "search.terms.adornment")?.kind, "editor-adornment");
  let semanticRequests = 0;
  const context = actionContext(makeReader({ "manuscript/vol-main/ch-main-1/sc-1.md": "The moonlit harbor is quiet." }), {
    async invoke(id, input, signal) {
      semanticRequests += 1;
      assert.equal(id, "semantic.search");
      assert.equal((input as { query: string }).query, "moonlit harbor");
      assert.equal(signal?.aborted, false);
      return { ok: false, snapshot, error: { code: "missing_action", message: "disabled", retryable: false } };
    },
  });
  const query = findAction(module.actions, "search.query");
  assert.throws(() => query.inputSchema.parse({ query: "harbor", scope: " ../outside" }), /Unsafe project path/u);
  const basic = await query.invoke(query.inputSchema.parse({ query: "moonlit harbor" }), context);
  assert.equal(basic.ok, true);
  if (basic.ok) assert.equal((basic.data as { results: unknown[] }).results.length, 1);
  assert.equal(capabilityRequests, 0);
  assert.equal(semanticRequests, 0);

  const enhanced = await query.invoke(query.inputSchema.parse({ query: "moonlit harbor", useNlp: true }), context);
  assert.equal(enhanced.ok, true);
  if (enhanced.ok) assert.deepEqual((enhanced.data as { warnings: string[] }).warnings, ["nlp_tokenizer_unavailable"]);
  assert.equal(capabilityRequests, 1);
  assert.equal(semanticRequests, 0);

  const semantic = await query.invoke(query.inputSchema.parse({ query: "moonlit harbor", includeSemantic: true }), context);
  assert.equal(semantic.ok, true);
  if (semantic.ok) assert.deepEqual((semantic.data as { warnings: string[] }).warnings, ["semantic_unavailable:missing_action"]);
  assert.equal(semanticRequests, 1);
  await module.dispose();
});

test("terminology changes are emitted only as revision-guarded dictionary proposals", async () => {
  const reader = makeReader({ "manuscript/vol-main/ch-main-1/sc-1.md": "A blue harbor." });
  let proposed: ChangeOperation[] = [];
  let evidence: Parameters<ModuleActionContext["propose"]>[1];
  const context = actionContext(reader, { propose: async (operations, rows) => {
    proposed = operations;
    evidence = rows;
    return { id: "proposal-1", snapshot, operations, source: "module" };
  } });
  const actions = createSearchActions(moduleContext(async () => { throw new Error("unused"); }), new SnapshotIndexCache());
  const proposal = await findAction(actions, "search.terms.propose").invoke(findAction(actions, "search.terms.propose").inputSchema.parse({
    canonical: "Blue Harbor", aliases: ["Harbor"], targetPath: "manuscript/vol-main/ch-main-1/sc-1.md",
  }), context);
  assert.equal(proposal.ok, true);
  assert.equal(proposed.length, 1);
  assert.deepEqual(proposed[0]!.writes.map(({ path }) => path), [TERM_REGISTRY_PATH]);
  assert.deepEqual(proposed[0]!.reads, [
    { path: TERM_REGISTRY_PATH, revision: null },
    { path: "manuscript/vol-main/ch-main-1/sc-1.md", revision: revision("A blue harbor.") },
  ]);
  assert.equal(proposed[0]!.effect, "settings");
  assert.doesNotThrow(() => assertChangeOperation(proposed[0]));
  assert.match(proposed[0]!.writes[0]!.content ?? "", /Blue Harbor/u);
  assert.equal(evidence?.[0]?.paths.some(({ path }) => path === "manuscript/vol-main/ch-main-1/sc-1.md"), true);
});

test("module disposal aborts and invalidates active index work", async () => {
  let release!: () => void;
  let started!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const readStarted = new Promise<void>((resolve) => { started = resolve; });
  const reader = makeReader({ "manuscript/vol-main/ch-main-1/sc-1.md": "A blue harbor." });
  const originalReadMany = reader.read.bind(reader);
  reader.read = async (path) => {
    if (path.startsWith("manuscript/")) { started(); await blocked; }
    return originalReadMany(path);
  };
  const definition = createSearchDefinition(moduleContext(async () => { throw new Error("unused"); }));
  const query = findAction(definition.actions, "search.query");
  const pending = query.invoke(query.inputSchema.parse({ query: "harbor" }), actionContext(reader));
  await readStarted;
  await definition.dispose();
  release();
  await assert.rejects(pending, (error: unknown) => (error as { code?: string }).code === "job_cancelled");
});

test("native Knowledge references store only identity and path, resolve aliases from pinned snapshot, and retain ambiguity",async()=>{
  const a="11111111-1111-4111-8111-111111111111",b="22222222-2222-4222-8222-222222222222",retired="33333333-3333-4333-8333-333333333333";
  const path="documents/scene.md",projection="meta/scriptorium/knowledge-context/v1.json";
  const node=(id:string,name:string,status="confirmed",aliases:Array<{surface:string;status:string;scope:null|string}>=[])=>({node:{id,name,status,deletedAt:null},aliases:aliases.map(alias=>({...alias,nodeId:id}))});
  const entries=[node(a,"青い塔","confirmed",[{surface:"塔",status:"confirmed",scope:null},{surface:"北塔",status:"ambiguous",scope:null},{surface:"司令塔",status:"confirmed",scope:"chapter"}]),node(b,"赤い塔","confirmed",[{surface:"塔",status:"confirmed",scope:null}]),node(retired,"退役","retired")];
  const registry={schemaVersion:1,terms:[],knowledgeReferences:[{knowledgeId:a,targetPath:path}]};
  const values={[path]:"青い塔", [TERM_REGISTRY_PATH]:JSON.stringify(registry),[projection]:JSON.stringify({version:1,projectId:snapshot.projectId,entries,nodeLimitReached:false})};
  const actions=createSearchActions(moduleContext(async()=>{throw Error("unused")}),new SnapshotIndexCache());
  let proposed:ChangeOperation[]=[];
  const reader=makeReader(values);
  const context=actionContext(reader,{async propose(operations){proposed=operations;return {id:"link",snapshot,operations,source:"module"}}});
  const resolve=findAction(actions,"search.terms.resolve");
  const out=await resolve.invoke(resolve.inputSchema.parse({text:"😀青い塔、塔、北塔、司令塔、赤い塔、退役"}),context);
  assert.equal(out.ok,true);
  if(out.ok){
    const result=out.data as {spans:Array<{start:number;end:number;termId:string}>;ambiguities:Array<{alias:string;termIds:string[]}>;candidates:Array<{termId:string}>};
    assert.deepEqual(result.spans.map(s=>s.termId),["knowledge-"+a]);
    assert.equal(result.spans[0]!.start,2);
    assert.equal(result.ambiguities.find(x=>x.alias==="塔")?.termIds.length,2);
    assert.ok(result.ambiguities.some(x=>x.alias==="北塔"));
    assert.ok(result.ambiguities.some(x=>x.alias==="司令塔"));
    assert.deepEqual(result.candidates.map(x=>x.termId),["knowledge-"+b]);
  }
  const link=findAction(actions,"search.terms.linkKnowledge");
  const linked=await link.invoke(link.inputSchema.parse({knowledgeId:b,targetPath:path}),context);
  assert.equal(linked.ok,true);
  const stored=JSON.parse(proposed[0]!.writes[0]!.content!);
  assert.deepEqual(stored.knowledgeReferences,[{knowledgeId:a,targetPath:path},{knowledgeId:b,targetPath:path}]);
  assert.doesNotMatch(JSON.stringify(stored),/青い塔|赤い塔|aliases/);
  assert.ok(proposed[0]!.reads.some(read=>read.path===projection&&read.revision===revision(values[projection]!)));
  assert.doesNotThrow(()=>assertChangeOperation(proposed[0]));
  await assert.rejects(()=>link.invoke(link.inputSchema.parse({knowledgeId:retired,targetPath:path}),context),/Confirmed Knowledge unavailable/);
  // New snapshot changes the authoritative aliases; the reference stays unchanged.
  const changed=makeReader({...values,[projection]:JSON.stringify({version:1,projectId:snapshot.projectId,entries:[node(a,"新しい塔"),entries[1]],nodeLimitReached:false})});
  const result=await resolve.invoke(resolve.inputSchema.parse({text:"青い塔、新しい塔"}),actionContext(changed));
  assert.equal(result.ok,true);
  if(result.ok)assert.equal((result.data as {spans:unknown[]}).spans.length,1);
});

test("incomplete bounded alias inventory fails closed for automatic Knowledge links", async () => {
  const a="11111111-1111-4111-8111-111111111111",b="22222222-2222-4222-8222-222222222222";
  const path="documents/scene.md",projection="meta/scriptorium/knowledge-context/v1.json";
  const entry=(id:string,name:string,aliases:Array<{surface:string;status:string;scope:null|string}>,aliasLimitReached=false)=>({
    node:{id,name,status:"confirmed",deletedAt:null},aliases:aliases.map(alias=>({...alias,nodeId:id})),aliasLimitReached,
  });
  // The bounded read of B stopped at 500 aliases; its next alias is "塔", which collides with A.
  const values={[path]:"塔",[TERM_REGISTRY_PATH]:JSON.stringify({schemaVersion:1,terms:[],knowledgeReferences:[{knowledgeId:a,targetPath:path}]}),
    [projection]:JSON.stringify({version:1,projectId:snapshot.projectId,entries:[entry(a,"青い塔",[{surface:"塔",status:"confirmed",scope:null}]),entry(b,"赤い塔",[],true)],nodeLimitReached:false})};
  const actions=createSearchActions(moduleContext(async()=>{throw Error("unused")}),new SnapshotIndexCache());
  const resolve=findAction(actions,"search.terms.resolve");
  let proposed:ChangeOperation[]=[];
  const context=actionContext(makeReader(values),{async propose(operations){proposed=operations;return {id:"link",snapshot,operations,source:"module"};}});
  const out=await resolve.invoke(resolve.inputSchema.parse({text:"塔"}),context);
  assert.equal(out.ok,true);
  if(out.ok){
    const result=out.data as {spans:Array<unknown>;candidates:Array<{termId:string}>};
    assert.deepEqual(result.spans,[]);
    assert.deepEqual(result.candidates.map(term=>term.termId),["knowledge-"+a]);
  }
  const link=findAction(actions,"search.terms.linkKnowledge");
  const linked=await link.invoke(link.inputSchema.parse({knowledgeId:b,targetPath:path}),context);
  assert.equal(linked.ok,true,"explicit UUID linking remains available when only aliases are truncated");
  assert.equal(proposed.length,1);
});

test("legacy v1 Knowledge snapshots fail closed at the original alias cap", async () => {
  const a="11111111-1111-4111-8111-111111111111",b="22222222-2222-4222-8222-222222222222";
  const path="documents/scene.md",projection="meta/scriptorium/knowledge-context/v1.json";
  const entry=(id:string,name:string,aliases:string[])=>({
    node:{id,name,status:"confirmed",deletedAt:null},
    aliases:aliases.map(surface=>({nodeId:id,surface,status:"confirmed",scope:null})),
  });
  const actions=createSearchActions(moduleContext(async()=>{throw Error("unused")}),new SnapshotIndexCache());
  const resolve=findAction(actions,"search.terms.resolve");
  for(const count of [499,500]){
    const values={[path]:"塔",[TERM_REGISTRY_PATH]:JSON.stringify({schemaVersion:1,terms:[],knowledgeReferences:[{knowledgeId:a,targetPath:path}]}),
      [projection]:JSON.stringify({version:1,projectId:snapshot.projectId,entries:[entry(a,"青い塔",["塔"]),entry(b,"赤い塔",Array.from({length:count},(_,i)=>"別名"+i))],nodeLimitReached:false})};
    const out=await resolve.invoke(resolve.inputSchema.parse({text:"塔"}),actionContext(makeReader(values)));
    assert.equal(out.ok,true);
    if(out.ok){
      const result=out.data as {spans:unknown[];candidates?:Array<{termId:string}>;warning?:string};
      assert.equal(result.spans.length,count===499?1:0);
      if(count===500){
        assert.deepEqual(result.candidates?.map(term=>term.termId),["knowledge-"+a]);
        assert.equal(result.warning,"knowledge_inventory_truncated");
      }
    }
  }
});
