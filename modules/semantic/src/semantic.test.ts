import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { assertChangeOperation, snapshotScopeRevision } from "@codexia/contracts";
import type { ChangeOperation, ModuleActionContext, ModuleContext, ModuleManifest, SnapshotId } from "@codexia/contracts";
import type { CandidateTerm, CanonicalSnapshotEntity } from "@codexia/module-nlp";
import { ModuleRuntime, WorkerSupervisor } from "@codexia/module-runtime";
import type { StoryEntity } from "@codexia/module-story";
import {
  EMBEDDING_DIMENSIONS,
  EMBEDDING_MODEL_ID,
  EMBEDDING_MODEL_VERSION,
  type SemanticEmbeddingCapability,
} from "./contracts.js";
import { collectMentionGroups, detectSourceRuleContradictions, embeddingContradictionsToCandidates } from "./contradictions.js";
import { createSemanticActions } from "./actions.js";
import { buildSemanticPassages } from "./passages.js";
import { buildSearchDocuments, combineHybridScores, searchSnapshotLexically } from "./search.js";
import { clusterSimilarTerms } from "./termClustering.js";

const snapshot: SnapshotId = {
  projectId: "semantic-production-fixture",
  projectVersion: 11,
};

test("source sentence rows preserve embeddable types, body/description/notes order, and trimmed indexes", () => {
  const entities: CanonicalSnapshotEntity[] = [
    { id: "sc-1", type: "scene", filePath: "plot/scene.yaml", name: "Station", aliases: [], raw: { description: " description. ", notes: " note." }, body: " First sentence. Second sentence." },
    { id: "arc-1", type: "arc", filePath: "plot/arc.yaml", raw: {}, body: "must not be embedded" },
    { id: "char-1", type: "character", filePath: "bible/characters/a.yaml", raw: { notes: "Alone." } },
  ];
  const rows = buildSemanticPassages(entities);
  assert.deepEqual(rows.map(({ entityId, sentenceIndex, text }) => ({ entityId, sentenceIndex, text })), [
    { entityId: "sc-1", sentenceIndex: 0, text: "First sentence." },
    { entityId: "sc-1", sentenceIndex: 1, text: "Second sentence." },
    { entityId: "sc-1", sentenceIndex: 2, text: "description." },
    { entityId: "sc-1", sentenceIndex: 3, text: "note." },
    { entityId: "char-1", sentenceIndex: 0, text: "Alone." },
  ]);
});

test("legacy note list parsing retains numbered steps and definition entries", () => {
  const documents = buildSearchDocuments([{
    id: "note-owner", type: "character", filePath: "bible/characters/a.yaml", name: "A", aliases: [],
    raw: { notes: { lead: [], sections: [{ heading: "Notes", body: [{ text: "  1. First step\n* Term: Description" }], children: [] }] } },
  }]);
  const notes = documents.find((item) => item.field === "notes");
  assert.equal(notes?.content, "First step\nTerm\nDescription");
});

test("snapshot lexical projection supplies source field weighting and classic RRF ranks", () => {
  const entities: CanonicalSnapshotEntity[] = [
    { id: "scene-direct", type: "scene", filePath: "plot/a.yaml", name: "Blue harbor", aliases: [], raw: {}, body: "The blue harbor glows." },
    { id: "scene-body", type: "scene", filePath: "plot/b.yaml", name: "Quiet", aliases: [], raw: {}, body: "A blue harbor appears here." },
  ];
  const lexical = searchSnapshotLexically(entities, "blue harbor", 10);
  assert.equal(lexical[0]?.id, "scene-direct");
  assert.equal(lexical[0]?.field, "name");
  assert.equal(combineHybridScores(1, 1), 2 / 61);
  assert.equal(combineHybridScores(1, null), 1 / 61);
});

test("semantic search caps vector overfetch at the provider's 100-hit contract", async () => {
  const requestedLimits: number[] = [];
  const embedding: SemanticEmbeddingCapability = {
    model: { id: EMBEDDING_MODEL_ID, version: EMBEDDING_MODEL_VERSION, dimensions: EMBEDDING_DIMENSIONS },
    async index(): Promise<never> { throw new Error("unused"); },
    async nearest(_query, readerSnapshot, options) {
      requestedLimits.push(options.limit ?? 0);
      return { snapshot: readerSnapshot, model: EMBEDDING_MODEL_ID, modelVersion: EMBEDDING_MODEL_VERSION, dimensions: EMBEDDING_DIMENSIONS, hits: [] };
    },
    async status(): Promise<never> { throw new Error("unused"); },
    async contradictionPairs(): Promise<never> { throw new Error("unused"); },
    async embed(): Promise<never> { throw new Error("unused"); },
    async rerank(): Promise<never> { throw new Error("unused"); },
  };
  const moduleContext = {
    async acquireCapability(id: string) {
      assert.equal(id, "semantic.embedding");
      return { value: embedding, async release() {} };
    },
  } as unknown as ModuleContext;
  const search = createSemanticActions(moduleContext).find((action) => action.id === "semantic.search")!;
  for (const limit of [34, 100]) {
    const context = {
      reader: makeSemanticReader(snapshot, new Map()),
      signal: new AbortController().signal,
    } as unknown as ModuleActionContext;
    const result = await search.invoke({ query: "駅", mode: "scene", limit }, context);
    assert.equal(result.ok, true);
  }
  assert.deepEqual(requestedLimits, [100, 100]);
});

test("expression search orders indexed passages without scanning the manuscript", async (t) => {
  const reader = makeSemanticReader(snapshot, new Map([["manuscript/a.md", "波が走る。"]]));
  const list = t.mock.method(reader, "list");
  const read = t.mock.method(reader, "read");
  const hits = ["波", "走る"].map((text, i) => ({
    entityId: "sea", sceneId: "sea", sentenceIndex: i, text, score: 1 - i / 2, filePath: "manuscript/a.md",
  }));
  const moduleContext = {
    async acquireCapability(id: string) {
      if (id === "nlp.tokenizer") return {
        value: { async analyze(text: string) { return { tokens: [{ pos: text === "走る" ? "動詞" : "名詞" }] }; } },
        async release() {},
      };
      assert.equal(id, "semantic.embedding");
      return {
        value: { async nearest(_query: string, indexSnapshot: SnapshotId) {
          assert.deepEqual(indexSnapshot, snapshot);
          return { hits };
        } },
        async release() {},
      };
    },
  } as unknown as ModuleContext;
  const search = createSemanticActions(moduleContext).find((item) => item.id === "semantic.expressions.search")!;
  const context = { reader, signal: new AbortController().signal } as unknown as ModuleActionContext;
  const result = await search.invoke(search.inputSchema.parse({ query: "波", limit: 2 }), context);
  assert.ok(result.ok);
  const { results } = result.data as { results: Array<{ text: string; sentenceIndex: number }> };
  assert.deepEqual(results.map(({ text, sentenceIndex }) => [text, sentenceIndex]), [["走る", 1], ["波", 0]]);
  assert.equal(list.mock.callCount(), 0);
  assert.equal(read.mock.calls.some(({ arguments: [path] }) => path === "manuscript/a.md"), false);
});

test("semantic search scopes lexical and vector results to files and path segments", async () => {
  const receivedScopes: Array<string | undefined> = [];
  const embedding: SemanticEmbeddingCapability = {
    model: { id: EMBEDDING_MODEL_ID, version: EMBEDDING_MODEL_VERSION, dimensions: EMBEDDING_DIMENSIONS },
    async index(): Promise<never> { throw new Error("unused"); },
    async nearest(_query, readerSnapshot, options) {
      receivedScopes.push(options.scope);
      const hits = [
        { entityId: "outside", sceneId: "outside", sentenceIndex: 0, text: "harbor", score: 1, filePath: "plot/volumes/chapter-1-extra/scenes/outside.yaml" },
        { entityId: "inside", sceneId: "inside", sentenceIndex: 0, text: "harbor", score: 0.5, filePath: "plot/volumes/chapter-1/scenes/inside.yaml" },
      ];
      return { snapshot: readerSnapshot, model: EMBEDDING_MODEL_ID, modelVersion: EMBEDDING_MODEL_VERSION, dimensions: EMBEDDING_DIMENSIONS, hits };
    },
    async status(): Promise<never> { throw new Error("unused"); },
    async contradictionPairs(): Promise<never> { throw new Error("unused"); },
    async embed(): Promise<never> { throw new Error("unused"); },
    async rerank(): Promise<never> { throw new Error("unused"); },
  };
  const moduleContext = { async acquireCapability() { return { value: embedding, async release() {} }; } } as unknown as ModuleContext;
  const search = createSemanticActions(moduleContext).find((action) => action.id === "semantic.search")!;
  const reader = makeSemanticReader(snapshot, new Map([
    ["plot/volumes/chapter-1/scenes/inside.yaml", "id: inside\ntype: scene\nname: Harbor\ndescription: harbor\n"],
    ["plot/volumes/chapter-1-extra/scenes/outside.yaml", "id: outside\ntype: scene\nname: Harbor\ndescription: harbor\n"],
  ]));
  const context = { reader, signal: new AbortController().signal } as unknown as ModuleActionContext;
  for (const scope of ["plot/volumes/chapter-1", "plot/volumes/chapter-1/scenes/inside.yaml"]) {
    const result = await search.invoke({ query: "harbor", mode: "scene", limit: 1, scope }, context);
    assert.equal(result.ok, true);
    if (result.ok) {
      const results = (result.data as { results: Array<{ filePath?: string }> }).results;
      assert.ok(results.every((hit) => hit.filePath === "plot/volumes/chapter-1/scenes/inside.yaml"));
    }
  }
  assert.deepEqual(receivedScopes, ["plot/volumes/chapter-1", "plot/volumes/chapter-1/scenes/inside.yaml"]);
});

test("malformed persisted semantic cache is treated as unavailable", async () => {
  const workerEntry = fileURLToPath(new URL("../dist/worker.js", import.meta.url));
  const modelId = EMBEDDING_MODEL_ID;
  const modelVersion = EMBEDDING_MODEL_VERSION;
  const supervisor = new WorkerSupervisor({ maxJobDurationMs: 5_000 });
  const cacheDirectory = await mkdtemp(path.join(os.tmpdir(), "codexia-semantic-corrupt-cache-"));
  try {
    const malformedMemberships = [
      () => ({ passages: {}, updatedAt: "2026-11-21T00:00:00.000Z" }),
      (projectId: string) => ({
        snapshot: { projectId, projectVersion: 11 },
        passages: [{
          entityId: "scene-1", sceneId: "scene-1", sentenceIndex: 0, text: "A scene.",
          reference: { key: "not-a-real-passage-key" },
        }],
        updatedAt: "2026-11-21T00:00:00.000Z",
      }),
    ];

    for (const [index, makeMembership] of malformedMemberships.entries()) {
      const projectId = `semantic-corrupt-cache-${index}`;
      const membership = makeMembership(projectId);
      const key = JSON.stringify([projectId, 11]);
      const cacheFile = path.join(
        cacheDirectory, "semantic", "indexes",
        `${createHash("sha256").update(projectId).digest("hex")}-${createHash("sha256").update(`${modelId}@${modelVersion}`).digest("hex").slice(0, 24)}.json`,
      );
      await mkdir(path.dirname(cacheFile), { recursive: true });
      await writeFile(cacheFile, JSON.stringify({
        format: 2, model: modelId, modelVersion, dimensions: EMBEDDING_DIMENSIONS,
        snapshots: { [key]: membership }, passages: {},
      }));

      const status = await supervisor.run({
        id: `semantic-corrupt-status-${index}`,
        module: "semantic",
        task: "semantic.status",
        snapshot: { projectId, projectVersion: 11 },
        model: modelId,
        modelVersion,
        moduleVersion: "0.1.0",
        deadline: Date.now() + 5_000,
        input: { cacheDirectory, key },
      }, workerEntry);
      assert.equal(status.ok, true);
      if (status.ok) assert.equal((status.result.output as { indexAvailable: boolean }).indexAvailable, false);
    }
  } finally {
    await supervisor.shutdown();
    await rm(cacheDirectory, { recursive: true, force: true });
  }
});

test("a worker-written empty semantic index remains available after worker restart", async () => {
  const workerEntry = fileURLToPath(new URL("../dist/worker.js", import.meta.url));
  const supervisor = new WorkerSupervisor({ maxJobDurationMs: 5_000 });
  const cacheDirectory = await mkdtemp(path.join(os.tmpdir(), "codexia-semantic-valid-cache-"));
  const projectId = "semantic-valid-empty-cache";
  const snapshot = { projectId, projectVersion: 11 };
  const key = JSON.stringify([projectId, snapshot.projectVersion]);
  const signal = new AbortController().signal;
  const request = (id: string, task: string, input: Record<string, unknown>) => ({
    id, module: "semantic" as const, task, snapshot,
    model: EMBEDDING_MODEL_ID, modelVersion: EMBEDDING_MODEL_VERSION,
    moduleVersion: "0.1.0", deadline: Date.now() + 5_000, input,
  });
  let service: Awaited<ReturnType<typeof supervisor.createService>> | undefined;
  try {
    service = await supervisor.createService("semantic", "0.1.0", workerEntry);
    const begin = await service.request(request("semantic-empty-begin", "semantic.index.begin", {
      cacheDirectory, indexId: "semantic-empty-build", key, total: 0,
    }), signal);
    assert.equal(begin.ok, true);
    const commit = await service.request(request("semantic-empty-commit", "semantic.index.commit", {
      indexId: "semantic-empty-build",
    }), signal);
    assert.equal(commit.ok, true);
    await service.dispose();
    service = await supervisor.createService("semantic", "0.1.0", workerEntry);

    const status = await service.request(request("semantic-empty-status", "semantic.status", { cacheDirectory, key }), signal);
    assert.equal(status.ok, true);
    if (status.ok) {
      assert.equal((status.result.output as { indexAvailable: boolean; passageCount: number }).indexAvailable, true);
      assert.equal((status.result.output as { passageCount: number }).passageCount, 0);
    }
  } finally {
    await service?.dispose();
    await supervisor.shutdown();
    await rm(cacheDirectory, { recursive: true, force: true });
  }
});

test("term expansion uses NLP rules and preserves the source short-token LIKE behavior", () => {
  const lexical = searchSnapshotLexically([
    { id: "station", type: "location", filePath: "bible/locations/station.yaml", name: "stations", aliases: [], raw: {} },
  ], "station", 10, ["stations"]);
  assert.equal(lexical[0]?.id, "station");

  const short = searchSnapshotLexically([
    { id: "nearby", type: "location", filePath: "bible/locations/nearby.yaml", name: "駅前", aliases: [], raw: {}, body: "駅前に着く" },
  ], "駅前", 10, ["駅前夜"]);
  assert.deepEqual(short, []);
});

test("snapshot lexical notes follow source normalization and do not index malformed legacy strings", () => {
  const base = { id: "char-a", type: "character", filePath: "bible/characters/a.yaml", name: "A", raw: {} };
  const structured = { ...base, raw: { notes: {
    lead: [{ type: "paragraph", text: "Lead phrase" }],
    sections: [{ heading: "ignored heading", body: [{ type: "definitions", items: [{ term: "key", description: "definition phrase" }] }], children: [] }],
  } } };
  const legacyString = { ...base, id: "char-b", raw: { notes: "source normalization ignores a bare notes string" } };
  const notes = buildSearchDocuments([structured, legacyString]).filter((document) => document.field === "notes");
  assert.deepEqual(notes.map(({ id, content }) => ({ id, content })), [{ id: "char-a", content: "Lead phrase\nkey\ndefinition phrase" }]);
});

test("semantic reranker setting is returned as a revision-guarded author proposal", async () => {
  let proposed: ChangeOperation[] = [];
  let proposalSignal: AbortSignal | undefined;
  const controller = new AbortController();
  const context = {
    projectId: "project-semantic",
    reader: {
      snapshot,
      async read(path: string) {
        return path === "meta/scriptorium/modules/semantic/settings.json"
          ? { content: '{"schemaVersion":1,"rerankerEnabled":false}\n', revision: "settings-rev-1" }
          : null;
      },
      async list() { return []; },
    },
    signal: controller.signal,
    async propose(operations: ChangeOperation[], _evidence: unknown, _proposalId?: string, signal?: AbortSignal) {
      proposed = operations;
      proposalSignal = signal;
      return { id: "proposal-semantic-1", snapshot, operations, source: "module" as const };
    },
  } as unknown as ModuleActionContext;
  const actions = createSemanticActions({} as ModuleContext);
  const update = actions.find((action) => action.id === "semantic.settings.update");
  assert.equal(update?.effect, "propose");
  const result = await update!.invoke({ rerankerEnabled: true }, context);
  assert.equal(result.ok, true);
  assert.equal(proposed.length, 1);
  assert.equal(proposed[0]?.effect, "settings");
  assert.deepEqual(proposed[0]?.reads, [{ path: "meta/scriptorium/modules/semantic/settings.json", revision: "settings-rev-1" }]);
  assert.equal(proposed[0]?.writes[0]?.path, "meta/scriptorium/modules/semantic/settings.json");
  assert.equal(proposed[0]?.writes[0]?.revision, "settings-rev-1");
  assert.equal(JSON.parse(proposed[0]!.writes[0]!.content!).rerankerEnabled, true);
  assert.equal(proposalSignal, controller.signal);
});

test("contradiction dismissal binds Bible and plot source scopes to its proposal", async () => {
  const files = new Map([
    ["bible/characters/owner/profile.yaml", "id: char-owner\ntype: character\nname: Owner\naliases: [Owner]",],
    ["bible/characters/thief/profile.yaml", "id: char-thief\ntype: character\nname: Thief\naliases: [Thief]",],
    ["plot/volumes/v/volume.yaml", "id: vol-v\ntype: volume\norder: 0",],
    ["plot/volumes/v/chapters/c/chapter.yaml", "id: ch-c\ntype: chapter\nvolume: vol-v\norder: 0",],
    ["plot/volumes/v/chapters/c/scenes/one.yaml", "id: sc-one\ntype: scene\nchapter: ch-c\norder: 0\neffects:\n  - action: acquire_item\n    itemId: sword\n    characterId: char-owner",],
    ["plot/volumes/v/chapters/c/scenes/two.yaml", "id: sc-two\ntype: scene\nchapter: ch-c\norder: 1\neffects:\n  - action: use_item\n    itemId: sword\n    characterId: char-thief",],
  ]);
  const reader = makeSemanticReader(snapshot, files);
  const embedding: SemanticEmbeddingCapability = {
    model: { id: EMBEDDING_MODEL_ID, version: EMBEDDING_MODEL_VERSION, dimensions: EMBEDDING_DIMENSIONS },
    async index(): Promise<never> { throw new Error("unused"); },
    async nearest(): Promise<never> { throw new Error("unused"); },
    async status(readerSnapshot) {
      return { snapshot: readerSnapshot, model: EMBEDDING_MODEL_ID, modelVersion: EMBEDDING_MODEL_VERSION, dimensions: EMBEDDING_DIMENSIONS,
        indexAvailable: false, passageCount: 0, modelLoaded: false, rerankerLoaded: false, indexUpdatedAt: null };
    },
    async contradictionPairs(): Promise<never> { throw new Error("unused"); },
    async embed(): Promise<never> { throw new Error("unused"); },
    async rerank(): Promise<never> { throw new Error("unused"); },
  };
  const moduleContext = {
    async acquireCapability(id: string) {
      assert.equal(id, "semantic.embedding");
      return { value: embedding, async release() {} };
    },
  } as unknown as ModuleContext;
  let proposed: ChangeOperation[] = [];
  const actionContext = {
    projectId: "semantic-scope-fixture",
    reader,
    signal: new AbortController().signal,
    async propose(operations: ChangeOperation[]) {
      proposed = operations;
      return { id: "semantic-dismissal-scope", snapshot, operations, source: "module" as const };
    },
  } as unknown as ModuleActionContext;
  const actions = createSemanticActions(moduleContext);
  const rebuilt = await actions.find((action) => action.id === "semantic.contradictions.rebuild")!.invoke({}, actionContext);
  assert.equal(rebuilt.ok, true);
  const candidates = (rebuilt.data as { candidates: Array<{ id: string }> }).candidates;
  assert.equal(candidates.length, 1);
  const dismissed = await actions.find((action) => action.id === "semantic.contradictions.dismiss")!.invoke({ candidateId: candidates[0]!.id }, actionContext);
  assert.equal(dismissed.ok, true);
  assert.equal(proposed.length, 1);
  assertChangeOperation(proposed[0]);
  const scopes = proposed[0]!.readScopes ?? [];
  assert.deepEqual(scopes.map((scope) => scope.prefix).sort(), ["bible", "plot"]);
  assert.deepEqual(await Promise.all(scopes.map(async ({ prefix, revision }) => [prefix, revision, await snapshotScopeRevision(reader, prefix)])), [
    ["bible", scopes.find((scope) => scope.prefix === "bible")!.revision, scopes.find((scope) => scope.prefix === "bible")!.revision],
    ["plot", scopes.find((scope) => scope.prefix === "plot")!.revision, scopes.find((scope) => scope.prefix === "plot")!.revision],
  ]);
  const changedFiles = new Map(files);
  changedFiles.set("bible/characters/owner/profile.yaml", "id: char-owner\ntype: character\nname: Owner\naliases: [Old Owner]");
  assert.notEqual(await snapshotScopeRevision(makeSemanticReader(snapshot, changedFiles), "bible"), scopes.find((scope) => scope.prefix === "bible")!.revision,
    "a canonical alias change must invalidate the dismissal's source scope");
});

test("term clustering retains source reading, edit distance, canonical ordering, and opt-in semantic edges", async () => {
  const candidates: CandidateTerm[] = [
    { term: "駅前", reading: "エキマエ", sourceEntityIds: ["a"], occurrenceCount: 2 },
    { term: "駅前広場", reading: "エキマエヒロバ", sourceEntityIds: ["b", "c"], occurrenceCount: 9 },
    { term: "海岸", reading: null, sourceEntityIds: ["d"], occurrenceCount: 4 },
  ];
  const lexical = await clusterSimilarTerms(candidates);
  assert.deepEqual(lexical, [{ canonical: "駅前広場", variants: ["駅前"] }]);

  const vectors = new Map([["海岸", [1, 0]], ["浜辺", [0.999, 0.01]]]);
  const embedding: SemanticEmbeddingCapability = {
    model: { id: EMBEDDING_MODEL_ID, version: EMBEDDING_MODEL_VERSION, dimensions: EMBEDDING_DIMENSIONS },
    async index(): Promise<never> { throw new Error("unused"); },
    async nearest(): Promise<never> { throw new Error("unused"); },
    async status(): Promise<never> { throw new Error("unused"); },
    async contradictionPairs(): Promise<never> { throw new Error("unused"); },
    async rerank(): Promise<never> { throw new Error("unused"); },
    async embed(texts) { return { snapshot, model: EMBEDDING_MODEL_ID, modelVersion: EMBEDDING_MODEL_VERSION, dimensions: EMBEDDING_DIMENSIONS, vectors: texts.map((text) => vectors.get(text) ?? [0, 1]) }; },
  };
  const semantic = await clusterSimilarTerms([
    candidates[2]!, { term: "浜辺", reading: null, sourceEntityIds: ["e"], occurrenceCount: 3 },
  ], { useEmbedding: true, embedding, snapshot, signal: new AbortController().signal });
  assert.deepEqual(semantic, [{ canonical: "海岸", variants: ["浜辺"], semanticOnly: true }]);
});

test("mention groups use the source name trie and only retain prose entity mentions", () => {
  const char: StoryEntity = { id: "char-1", type: "character", name: "青い騎士", aliases: ["騎士"], filePath: "bible/characters/knight.yaml", raw: {} };
  const scene: StoryEntity = { id: "sc-1", type: "scene", name: "Scene", filePath: "plot/scene.yaml", raw: {} };
  const groups = collectMentionGroups(new Map([[char.id, char], [scene.id, scene]]), [
    { entityId: "sc-1", sceneId: "sc-1", sentenceIndex: 0, text: "青い騎士は東へ歩いた。", type: "scene" },
    { entityId: "char-1", sceneId: "char-1", sentenceIndex: 0, text: "青い騎士は赤い。", type: "character" },
  ]);
  assert.deepEqual(groups, [{ entityId: "char-1", anchors: [{ sceneId: "sc-1", sentenceIndex: 0, text: "青い騎士は東へ歩いた。" }] }]);
  const candidate = embeddingContradictionsToCandidates([{ entityId: "char-1", evidenceA: { sceneId: "sc-1", sentenceIndex: 0, text: "A" }, evidenceB: { sceneId: "sc-2", sentenceIndex: 1, text: "B" }, score: 0.5 }])[0]!;
  assert.equal(candidate.id, "embed:char-1:sc-1:0:sc-2:1");
  assert.equal(candidate.evidenceA.quote, "A");
});

test("source rule contradictions preserve pre-scene ownership boundaries and validated empty-string effects", () => {
  const entities: StoryEntity[] = [
    { id: "vol-1", type: "volume", filePath: "plot/volumes/v/volume.yaml", raw: { order: 0 } },
    { id: "ch-1", type: "chapter", filePath: "plot/volumes/v/chapter.yaml", raw: { volume: "vol-1", order: 0 } },
    { id: "sc-1", type: "scene", filePath: "plot/volumes/v/scenes/a.yaml", raw: { chapter: "ch-1", order: 0, effects: [{ action: "acquire_item", itemId: "", characterId: "owner" }] } },
    { id: "sc-2", type: "scene", filePath: "plot/volumes/v/scenes/b.yaml", raw: { chapter: "ch-1", order: 1, effects: [{ action: "use_item", itemId: "", characterId: "thief" }] } },
  ];
  const contradictions = detectSourceRuleContradictions({ snapshot, entities: new Map(entities.map((entity) => [entity.id, entity])), links: [] });
  assert.equal(contradictions.length, 1);
  assert.equal(contradictions[0]?.reason, "item-owner-mismatch");
  assert.equal(contradictions[0]?.itemId, "");
  assert.equal(contradictions[0]?.previousSceneId, "sc-1");
});

test("default ModuleRuntime composes semantic status, real CPU rebuild/search/rerank, and cache recovery", {
  skip: !process.env.CODEXIA_SEMANTIC_MODEL_CACHE,
  timeout: 300_000,
}, async () => {
  const modelCache = process.env.CODEXIA_SEMANTIC_MODEL_CACHE!;
  const cacheDirectory = await mkdtemp(path.join(os.tmpdir(), "codexia-semantic-p09-"));
  const modelDirectory = path.join(cacheDirectory, "semantic", "semantic", "models");
  await mkdir(path.dirname(modelDirectory), { recursive: true });
  await symlink(modelCache, modelDirectory, "dir");
  const [storyPackage, nlpPackage, semanticPackage] = await Promise.all([
    readFile(new URL("../../story/package.json", import.meta.url), "utf8").then((value) => JSON.parse(value) as { codexiaModule: ModuleManifest }),
    readFile(new URL("../../nlp/package.json", import.meta.url), "utf8").then((value) => JSON.parse(value) as { codexiaModule: ModuleManifest }),
    readFile(new URL("../package.json", import.meta.url), "utf8").then((value) => JSON.parse(value) as { codexiaModule: ModuleManifest }),
  ]);
  const storyEntry = new URL("../../story/dist/index.js", import.meta.url).href;
  const nlpEntry = new URL("../../nlp/dist/index.js", import.meta.url).href;
  const semanticEntry = new URL("../dist/index.js", import.meta.url).href;
  const runtime = new ModuleRuntime({
    manifests: [storyPackage.codexiaModule, nlpPackage.codexiaModule, semanticPackage.codexiaModule],
    enabled: ["semantic"],
    cacheDirectory,
    workerEntries: {
      nlp: fileURLToPath(new URL("../../nlp/dist/worker.js", import.meta.url)),
      semantic: fileURLToPath(new URL("../dist/worker.js", import.meta.url)),
    },
    loaders: {
      story: async (context) => (await import(storyEntry)).createModule(context),
      nlp: async (context) => (await import(nlpEntry)).createModule(context),
      semantic: async (context) => (await import(semanticEntry)).createModule(context),
    },
  });
  try {
    const initialFiles = new Map([
      ["plot/volumes/v/scenes/station.yaml", "id: sc-station\ntype: scene\nname: Station\ndescription: 夜遅く駅に着き、青い切符を握りしめた。\n"],
      ["plot/volumes/v/scenes/sea.yaml", "id: sc-sea\ntype: scene\nname: Sea\ndescription: 昼の海で泳ぎ、白い波を眺めた。\n"],
      ["plot/volumes/v/scenes/market.yaml", "id: sc-market\ntype: scene\nname: Market\ndescription: 朝の市場で赤い林檎を買った。\n"],
      ["plot/volumes/v/scenes/book.yaml", "id: sc-book\ntype: scene\nname: Book\ndescription: 静かな部屋で小説を読んだ。\n"],
    ]);
    const initialReader = makeSemanticReader(snapshot, initialFiles);
    const initialHost = semanticActionHost(initialReader);
    assert.equal(runtime.status("semantic").availability, "enabled-idle");
    assert.deepEqual(runtime.workerSupervisor.activeWorkerPids, [], "enabling semantic must not start a worker or import a model");

    const before = await runtime.invokeAction("semantic", "semantic.index.status", {}, initialHost);
    assert.equal(before.ok, true, `semantic.index.status failed: ${JSON.stringify(before.ok ? null : before.error)}`);
    const beforeData = before.data as { modelVersion: string; indexAvailable: boolean; modelLoaded: boolean };
    assert.equal(before.snapshot.projectVersion, snapshot.projectVersion);
    assert.equal(beforeData.modelVersion, EMBEDDING_MODEL_VERSION);
    assert.equal(beforeData.indexAvailable, false);
    assert.equal(beforeData.modelLoaded, false);

    const indexed = await runtime.invokeAction("semantic", "semantic.index.rebuild", { taskId: "runtime-index" }, initialHost);
    assert.equal(indexed.ok, true, `semantic.index.rebuild failed: ${JSON.stringify(indexed.ok ? null : indexed.error)}`);
    const indexedData = indexed.data as { model: string; modelVersion: string; scanned: number; embedded: number; reused: number };
    assert.equal(indexedData.model, EMBEDDING_MODEL_ID);
    assert.equal(indexedData.modelVersion, EMBEDDING_MODEL_VERSION);
    assert.equal(indexedData.scanned, 4);
    assert.equal(indexedData.embedded, 4);
    assert.equal(indexedData.reused, 0);

    const searched = await runtime.invokeAction("semantic", "semantic.search", { query: "夜遅く 駅", mode: "scene", limit: 5 }, initialHost);
    assert.equal(searched.ok, true, `semantic.search failed: ${JSON.stringify(searched.ok ? null : searched.error)}`);
    const searchData = searched.data as { modelVersion: string; results: Array<{ sceneId: string; snippet?: string; scores: { vectorRank?: number } }> };
    assert.equal(searchData.modelVersion, EMBEDDING_MODEL_VERSION);
    assert.equal(searchData.results[0]?.sceneId, "sc-station");
    assert.equal(searchData.results[0]?.scores.vectorRank, 1);
    assert.match(searchData.results[0]?.snippet ?? "", /青い切符/);

    const reranked = await runtime.invokeAction("semantic", "semantic.search", {
      query: "夜の駅の情景", mode: "scene", limit: 5, rerank: true,
    }, initialHost);
    assert.equal(reranked.ok, true, `semantic.search with reranker failed: ${JSON.stringify(reranked.ok ? null : reranked.error)}`);
    const rerankedData = reranked.data as { reranker: { id: string; version: string } | null; results: Array<{ scores: { rerank?: number } }> };
    assert.equal(rerankedData.reranker?.id, "mogolloni/bge-reranker-v2-m3-onnx");
    assert.ok(rerankedData.results.length > 1);
    assert.ok(rerankedData.results.every((result) => Number.isFinite(result.scores.rerank)));
    assert.ok(rerankedData.results[0]!.scores.rerank! > rerankedData.results[1]!.scores.rerank!);

    const nextSnapshot: SnapshotId = { ...snapshot, projectVersion: 12 };
    const nextFiles = new Map(initialFiles);
    nextFiles.set("plot/volumes/v/scenes/station.yaml", "id: sc-station\ntype: scene\nname: Updated Station\ndescription: 夜明けに駅から遠ざかり、白い切符を手放した。\n");
    const nextReader = makeSemanticReader(nextSnapshot, nextFiles);
    const changed = await runtime.invokeAction("semantic", "semantic.index.rebuild", { taskId: "runtime-index-next" }, semanticActionHost(nextReader));
    assert.equal(changed.ok, true, `second semantic.index.rebuild failed: ${JSON.stringify(changed.ok ? null : changed.error)}`);
    const changedData = changed.data as { embedded: number; reused: number };
    assert.equal(changedData.embedded, 1);
    assert.equal(changedData.reused, 3);
    const oldSnapshotHit = await runtime.invokeAction("semantic", "semantic.search", { query: "駅の切符", mode: "scene", limit: 10 }, initialHost);
    const newSnapshotHit = await runtime.invokeAction("semantic", "semantic.search", { query: "駅の切符", mode: "scene", limit: 10 }, semanticActionHost(nextReader));
    assert.equal(oldSnapshotHit.ok, true, `old snapshot search failed: ${JSON.stringify(oldSnapshotHit.ok ? null : oldSnapshotHit.error)}`);
    assert.equal(newSnapshotHit.ok, true, `new snapshot search failed: ${JSON.stringify(newSnapshotHit.ok ? null : newSnapshotHit.error)}`);
    const oldStation = (oldSnapshotHit.data as { results: Array<{ sceneId: string; snippet?: string; name?: string }> }).results.find((hit) => hit.sceneId === "sc-station");
    const newStation = (newSnapshotHit.data as { results: Array<{ sceneId: string; snippet?: string; name?: string }> }).results.find((hit) => hit.sceneId === "sc-station");
    assert.equal(oldStation?.snippet, "夜遅く駅に着き、青い切符を握りしめた。");
    assert.equal(oldStation?.name, "Station");
    assert.equal(newStation?.snippet, "夜明けに駅から遠ざかり、白い切符を手放した。");
    assert.equal(newStation?.name, "Updated Station");

    const { createHash } = await import("node:crypto");
    const repositoryKey = createHash("sha256").update(snapshot.projectId).digest("hex");
    const modelKey = createHash("sha256").update(`${EMBEDDING_MODEL_ID}@${EMBEDDING_MODEL_VERSION}`).digest("hex").slice(0, 24);
    await rm(path.join(cacheDirectory, "semantic", "semantic", "indexes", `${repositoryKey}-${modelKey}.json`));
    const missing = await runtime.invokeAction("semantic", "semantic.index.status", {}, initialHost);
    assert.equal(missing.ok, true, `semantic.index.status after cache deletion failed: ${JSON.stringify(missing.ok ? null : missing.error)}`);
    assert.equal((missing.data as { indexAvailable: boolean }).indexAvailable, false);
    const rebuilt = await runtime.invokeAction("semantic", "semantic.index.rebuild", { taskId: "runtime-index-recovered" }, initialHost);
    assert.equal(rebuilt.ok, true, `semantic.index.rebuild after cache deletion failed: ${JSON.stringify(rebuilt.ok ? null : rebuilt.error)}`);
    assert.equal((rebuilt.data as { embedded: number }).embedded, 4);
    const restored = await runtime.invokeAction("semantic", "semantic.index.status", {}, initialHost);
    assert.equal(restored.ok, true);
    assert.equal((restored.data as { indexAvailable: boolean }).indexAvailable, true);
  } finally {
    await runtime.shutdown();
    await rm(cacheDirectory, { recursive: true, force: true });
  }
});

function makeSemanticReader(readerSnapshot: SnapshotId, files: Map<string, string>) {
  return {
    snapshot: readerSnapshot,
    async list(prefix: string) { return [...files.keys()].filter((file) => file.startsWith(`${prefix}/`)); },
    async read(filePath: string) {
      const content = files.get(filePath);
      return content === undefined ? null : { content, revision: createHash("sha256").update(content).digest("hex") };
    },
  };
}

function semanticActionHost(reader: ReturnType<typeof makeSemanticReader>) {
  return {
    projectId: "semantic-production-fixture",
    reader,
    signal: new AbortController().signal,
    access: "owner" as const,
    async propose() { throw new Error("unexpected proposal"); },
  };
}

test("semantic lexical snippets map lowercase expansion to original text", () => {
  const body = "İ".repeat(100) + "検索対象";
  const hits = searchSnapshotLexically([
    { id: "sc-unicode", type: "scene", filePath: "plot/scene.yaml", raw: {}, body },
  ], "検索対象", 10);
  assert.equal(hits[0]?.id, "sc-unicode");
  assert.match(hits[0]?.snippet ?? "", /検索対象/u);
});
