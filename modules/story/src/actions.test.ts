import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import YAML from "yaml";
import type {
  ActionResult,
  ChangeOperation,
  ChangeProposal,
  KnowledgeProjectionData,
  KnowledgeProjectionEntry,
  KnowledgeProjectionEvidence,
  ModuleActionContext,
  ModuleContext,
  ProposalStatus,
  SnapshotId,
  SnapshotReader,
} from "@codexia/contracts";
import type { StoryVolumeTree } from "./domain/graph.js";

import { createStoryActions } from "./actions.js";
import { readStorySnapshot } from "./snapshot.js";

interface ZukanSuggestion { id: string; entityRevision?: string }

const SERIES_PATH = "meta/scriptorium/modules/story/v1/series.json";
const STATE_PROPOSALS_PATH = "meta/scriptorium/modules/story/state-proposals.jsonl";
const ZUKAN_SUGGESTIONS_PATH = "meta/scriptorium/modules/story/zukan-suggestions.jsonl";

function revision(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function yaml(value: unknown): string { return YAML.stringify(value); }

function repository(projectId: string): string {
  return projectId;
}

function fixtureFiles(extra: Record<string, string> = {}): Map<string, string> {
  return new Map(Object.entries({
    "bible/characters/char-uma/profile.yaml": yaml({
      id: "char-uma", name: "Uma", type: "character", aliases: ["U"], tags: ["lead"],
      notes: { daily: ["Keep the promise"] }, relations: [],
    }),
    "bible/characters/char-uma/voice.yaml": yaml({ cadence: "short" }),
    "bible/locations/loc-cafe.yaml": yaml({ id: "loc-cafe", name: "Cafe", type: "location" }),
    "plot/volumes/vol-main/volume.yaml": yaml({ id: "vol-main", title: "Main", type: "volume", order: 1 }),
    "plot/volumes/vol-main/chapters/ch-main-1/chapter.yaml": yaml({ id: "ch-main-1", title: "Arrival", type: "chapter", volume: "vol-main", order: 1 }),
    "plot/volumes/vol-main/chapters/ch-main-1/scenes/sc-1.yaml": yaml({ id: "sc-1", title: "Door", type: "scene", volume: "vol-main", chapter: "ch-main-1", order: 1, location: "loc-cafe", appears: ["char-uma"], manuscript: "manuscript/vol-main/ch-main-1/sc-1.md" }),
    "plot/volumes/vol-main/chapters/ch-main-1/scenes/sc-2.yaml": yaml({ id: "sc-2", title: "Table", type: "scene", volume: "vol-main", chapter: "ch-main-1", order: 2, manuscript: "manuscript/vol-main/ch-main-1/sc-2.md" }),
    "manuscript/vol-main/ch-main-1/sc-1.md": "---\ntitle: Door\n---\nUma enters the cafe.\n",
    "manuscript/vol-main/ch-main-1/sc-2.md": "---\ntitle: Table\n---\nUma sits down.\n",
    ...extra,
  }));
}

function makeReader(files: Map<string, string>, repositoryId = "repo-work", documentKinds: Record<string, string> = {}): SnapshotReader {
  const snapshot: SnapshotId = { projectId: repository(repositoryId), projectVersion: 11 };
  return {
    snapshot,
    async read(path) {
      const content = files.get(path);
      return content === undefined ? null : {
        content,
        revision: revision(content),
        ...(documentKinds[path] ? { documentKind: documentKinds[path] } : {}),
      };
    },
    async list(prefix) { return [...files.keys()].filter((path) => path === prefix || path.startsWith(`${prefix}/`)).sort(); },
  };
}

test("Story keeps native notes as manuscripts and preserves native and mapped scenes", async () => {
  const nativeSceneId = "11111111-1111-4111-8111-111111111111";
  const nativeNoteId = "22222222-2222-4222-8222-222222222222";
  const scenePath = `plot/volumes/vol-main/chapters/ch-main-1/scenes/${nativeSceneId}.yaml`;
  const notePath = `plot/volumes/vol-main/chapters/ch-main-1/scenes/${nativeNoteId}.yaml`;
  const files = fixtureFiles({
    [scenePath]: yaml({ id: nativeSceneId, title: "Native scene", chapter: "ch-main-1", order: "0003" }),
    [notePath]: yaml({ id: nativeNoteId, title: "Author note", chapter: "ch-main-1", order: "0004" }),
    [`documents/${nativeSceneId}.md`]: "Native scene body.",
    [`documents/${nativeNoteId}.md`]: "Private note body.",
  });
  const reader = makeReader(files, "repo-story-note-filter", {
    [scenePath]: "scene",
    [notePath]: "note",
    [`documents/${nativeNoteId}.md`]: "note",
  });
  const context = makeActionContext(reader);

  const scenes = (await invoke<Array<{ id: string }>>("story.entities.list", { type: "scene" }, context)).data;
  assert.deepEqual(new Set(scenes.map((entity) => entity.id)), new Set(["sc-1", "sc-2", nativeSceneId]));

  const allEntities = (await invoke<Array<{ id: string; type: string; body?: string }>>("story.entities.list", {}, context)).data;
  assert.equal(allEntities.some((entity) => entity.id === nativeNoteId), false);
  const note = allEntities.find((entity) => entity.id === `doc-ms-${nativeNoteId}`);
  assert.equal(note?.type, "manuscript");
  assert.equal(note?.body, "Private note body.");
  assert.ok(allEntities.some((entity) => entity.id === "sc-1"));

  const snapshot = await readStorySnapshot(reader);
  assert.equal(snapshot.files.get(notePath)?.documentKind, "note");
  assert.equal(snapshot.files.get(scenePath)?.documentKind, "scene");
});

test("Story consumes the pinned typed native hierarchy while preserving its file adapter metadata", async () => {
  const metadataPath = "plot/imported/s1.yaml";
  const bodyPath = "documents/11111111-1111-4111-8111-111111111111.md";
  const missingPath = "documents/00000000-0000-4000-8000-000000000000.md";
  const locationPath = "bible/locations/cafe.yaml";
  const metadata = { id: "s1", title: "Typed scene", order: "0001", chapter: "c1", volume: "v1", manuscript: bodyPath, importedFields: { translation: "草稿" } };
  const metadataContent = yaml(metadata);
  const nativeScene = {
    id: "s1", kind: "scene", title: "Typed scene", orderKey: "0001", metadataPath,
    metadataRevision: revision(metadataContent), metadataContent, documentOrder: 2, metadata,
  };
  const reader: SnapshotReader = {
    snapshot: { projectId: "native-story", projectVersion: 17 },
    nativeStoryDocuments: [nativeScene],
    async read() { assert.fail("the pinned file selection uses the available batch reader"); },
    async readMany(paths: readonly string[]) {
      assert.deepEqual(paths, [locationPath, missingPath, bodyPath]);
      return [
        { content: "id: cafe\nname: Café\n", revision: "cafe-revision" },
        null,
        { content: "Scene body", revision: revision("Scene body"), documentKind: "scene", documentOrder: 2 },
      ];
    },
    async list(prefix) {
      if (prefix === "documents") return [bodyPath, missingPath];
      return prefix === "bible" ? [locationPath] : [];
    },
  };
  const story = await readStorySnapshot(reader);
  assert.equal(story.snapshot, reader.snapshot);
  assert.equal(story.entities.get("s1")?.type, "scene", "native kind is independent of the adapter path convention");
  assert.equal(story.documentOrderByEntityId?.get("s1"), 2, "hierarchy ordering comes from the selected native projection");
  assert.equal(story.entities.get("s1")?.name, undefined, "native and YAML readers preserve the same optional name field");
  assert.equal(story.entities.get("s1")?.raw.title, "Typed scene");
  assert.equal(story.entities.get("s1")?.raw.chapter, "c1");
  assert.deepEqual(story.entities.get("s1")?.raw.importedFields, { translation: "草稿" });
  assert.equal(story.files.get(metadataPath)?.revision, revision(metadataContent));
  assert.equal(story.files.get(metadataPath)?.content, metadataContent, "the adapter retains exact file bytes for existing Story change-set consumers");
  assert.equal(story.files.get(metadataPath)?.documentOrder, 2);
  assert.deepEqual([...story.files.keys()], [locationPath, bodyPath, metadataPath]);
  assert.equal(story.files.get(bodyPath)?.revision, revision("Scene body"));
  assert.equal(story.entities.get("doc-ms-11111111-1111-4111-8111-111111111111")?.body, "Scene body");
});

function makeModuleContext(): ModuleContext {
  return {
    cacheDirectory: "/unused/story-cache",
    signal: new AbortController().signal,
    async acquireCapability() { throw new Error("capability unavailable"); },
    async createWorkerService() { throw new Error("Story has no worker"); },
  };
}

function makeActionContext(reader: SnapshotReader, options: {
  proposals?: Array<{ id: string; operations: ChangeOperation[] }>;
  linkedReader?: (projectId: string) => Promise<SnapshotReader>;
  projectId?: string;
} = {}): ModuleActionContext {
  return {
    projectId: options.projectId ?? "transient-registry-project-id",
    reader,
    async invoke() { return { ok: false, snapshot: reader.snapshot, error: { code: "missing_action", message: "not wired", retryable: false } }; },
    async listActions() { return []; },
    async linkedReader(repositoryId) {
      if (!options.linkedReader) throw new Error(`Unexpected linked projectId: ${repositoryId}`);
      return options.linkedReader(repositoryId);
    },
    signal: new AbortController().signal,
    async propose(operations, evidence, proposalId) {
      const proposal: ChangeProposal = { id: proposalId ?? `proposal-${(options.proposals?.length ?? 0) + 1}`, snapshot: reader.snapshot, operations, source: "module", ...(evidence ? { evidence } : {}) };
      options.proposals?.push(proposal);
      return proposal;
    },
    async runJob() { throw new Error("Story has no worker jobs"); },
  };
}

function actionById(id: string) {
  const action = createStoryActions(makeModuleContext()).find((candidate) => candidate.id === id);
  assert.ok(action, `missing Story action ${id}`);
  return action;
}

async function invoke<T>(id: string, input: unknown, context: ModuleActionContext): Promise<Extract<ActionResult<T>, { ok: true }>> {
  const result = await actionById(id).invoke(input, context);
  assert.equal(result.ok, true, result.ok ? undefined : `${result.error.code}: ${result.error.message}`);
  return result as Extract<ActionResult<T>, { ok: true }>;
}

test("scenario save reuses proposal and operation identities for the same operation ID", async () => {
  const reader = makeReader(fixtureFiles());
  const proposals: Array<{ id: string; operations: ChangeOperation[] }> = [];
  const context = makeActionContext(reader, { proposals });
  const alternatives = [{ label: "A", events: [] }, { label: "B", events: [] }];
  const comparison = await invoke<{ sourceFingerprint: string }>("story.scenario.compare", {
    sceneId: "sc-1", alternatives,
  }, context);
  const input = {
    sceneId: "sc-1", label: "Replay", alternatives,
    sourceFingerprint: comparison.data.sourceFingerprint,
    operation_id: "scenario-save-replay-1",
  };

  const first = await invoke<{ id: string }>("story.scenario.save", input, context);
  const replay = await invoke<{ id: string }>("story.scenario.save", {
    ...input,
    operation_id: `story-${input.operation_id}`,
  }, context);

  assert.equal(first.data.id, replay.data.id);
  assert.equal(proposals.length, 2, "the test host records both calls before Core deduplicates them");
  assert.equal(proposals[0]!.id, proposals[1]!.id, "a replay must use the same Core proposal ID");
  assert.deepEqual(proposals[0]!.operations, proposals[1]!.operations, "a replay must submit the same operation payload");
  assert.equal(proposals[0]!.operations[0]!.id, proposals[1]!.operations[0]!.id);

  const changed = await invoke<{ id: string }>("story.scenario.save", { ...input, label: "Changed" }, context);
  assert.equal(changed.data.id, first.data.id, "one operation ID must retain its scenario identity");
  assert.equal(proposals[2]!.id, proposals[0]!.id, "one operation ID must retain its proposal identity");
  assert.notDeepEqual(proposals[2]!.operations, proposals[0]!.operations, "changed content must remain distinguishable for Core conflict detection");

  const independent = await invoke<{ id: string }>("story.scenario.save", { ...input, operation_id: "scenario-save-replay-2" }, context);
  assert.notEqual(independent.data.id, first.data.id, "different operations must not share a scenario identity");
  assert.notEqual(proposals[3]!.id, proposals[0]!.id, "different operations must have independent Core proposals");
});

test("entity reads expose source revision and preserve nested notes and character voice", async () => {
  const reader = makeReader(fixtureFiles());
  const context = makeActionContext(reader);
  const entities = await invoke<Array<{ id: string; revision: string; raw: Record<string, unknown> }>>("story.entities.list", {}, context);
  const character = entities.data.find((entity) => entity.id === "char-uma");
  assert.ok(character);
  assert.equal(character.revision.length, 73);
  assert.deepEqual(character.raw.notes, { daily: ["Keep the promise"] });
  assert.deepEqual(character.raw.voice, { cadence: "short" });
  assert.equal((await invoke<{ revision: string }>("story.entities.collection-revision", {}, context)).data.revision.length, 73);
  assert.equal((await invoke<{ revision: string } | null>("story.entities.get", { id: "char-uma" }, context)).data?.revision, character.revision);
});

test("native PostgreSQL manuscript projections are visible to scene context alongside legacy manuscripts", async () => {
  const id = "11111111-1111-4111-8111-111111111111";
  const manuscriptPath = `documents/${id}.md`;
  const markdown = "三日後、扉が開いた。😀\n";
  const files = fixtureFiles({
    [`plot/volumes/vol-main/chapters/ch-main-1/scenes/${id}.yaml`]: yaml({
      id, title: "Native scene", order: "0003", manuscript: manuscriptPath,
    }),
    [manuscriptPath]: markdown,
    "documents/not-a-document.md": "must not be included",
    "documents/hidden.yaml": yaml({ id: "hidden", type: "character" }),
  });
  const reader = makeReader(files);
  const context = makeActionContext(reader);
  const result = await invoke<{
    manuscript?: { id: string; filePath: string };
    manuscriptBody?: string;
    manuscriptPath: string | null;
    manuscriptFileRevision: string | null;
  }>("story.scene.context", { sceneId: id }, context);
  assert.equal(result.data.manuscript?.id, `doc-ms-${id}`);
  assert.equal(result.data.manuscript?.filePath, manuscriptPath);
  assert.equal(result.data.manuscriptBody, markdown.trim());
  assert.equal(result.data.manuscriptPath, manuscriptPath);
  assert.equal(result.data.manuscriptFileRevision, revision(markdown));
  assert.deepEqual(result.snapshot, reader.snapshot);

  const legacy = await invoke<{ manuscript?: { id: string }; manuscriptBody?: string }>(
    "story.scene.context", { sceneId: "sc-1" }, context,
  );
  assert.equal(legacy.data.manuscript?.id, "ms-vol-main-ch-main-1-sc-1");
  assert.equal(legacy.data.manuscriptBody, "Uma enters the cafe.");

  const full = await readStorySnapshot(reader);
  assert.equal(full.files.get(manuscriptPath)?.content, markdown);
  assert.equal(full.files.has("documents/not-a-document.md"), false);
  assert.equal(full.files.has("documents/hidden.yaml"), false);
  const metadataOnly = await readStorySnapshot(reader, { includeManuscripts: false });
  assert.equal(metadataOnly.files.has(manuscriptPath), false);
  assert.equal(metadataOnly.files.has("manuscript/vol-main/ch-main-1/sc-1.md"), false);
  assert.equal(metadataOnly.entities.has(id), true);
});

test("native scene context preserves Markdown horizontal rules and parses explicit YAML frontmatter", async () => {
  const ordinaryId = "33333333-3333-4333-8333-333333333333";
  const unclosedRuleId = "44444444-4444-4444-8444-444444444444";
  const frontmatterId = "55555555-5555-4555-8555-555555555555";
  const ordinaryMarkdown = "---\n普通の回想\n---\n「すぐに戻ります。」";
  const unclosedRuleMarkdown = "---\n\n水平線の後に続く本文です。";
  const frontmatterMarkdown = "---\ntitle: Explicit title\nstatus: draft\n---\n本文です。";
  const scenePath = (id: string) => `plot/volumes/vol-main/chapters/ch-main-1/scenes/${id}.yaml`;
  const documentPath = (id: string) => `documents/${id}.md`;
  const files = fixtureFiles({
    [scenePath(ordinaryId)]: yaml({ id: ordinaryId, title: "Ordinary Markdown", manuscript: documentPath(ordinaryId) }),
    [scenePath(unclosedRuleId)]: yaml({ id: unclosedRuleId, title: "Unclosed rule", manuscript: documentPath(unclosedRuleId) }),
    [scenePath(frontmatterId)]: yaml({ id: frontmatterId, title: "Explicit frontmatter", manuscript: documentPath(frontmatterId) }),
    [documentPath(ordinaryId)]: ordinaryMarkdown,
    [documentPath(unclosedRuleId)]: unclosedRuleMarkdown,
    [documentPath(frontmatterId)]: frontmatterMarkdown,
  });
  const reader = makeReader(files);
  const context = makeActionContext(reader);

  for (const [id, markdown] of [
    [ordinaryId, ordinaryMarkdown],
    [unclosedRuleId, unclosedRuleMarkdown],
  ] as const) {
    const result = await invoke<{ manuscript?: { id: string }; manuscriptBody?: string }>(
      "story.scene.context", { sceneId: id }, context,
    );
    assert.equal(result.data.manuscript?.id, `doc-ms-${id}`);
    assert.equal(result.data.manuscriptBody, markdown);
    assert.deepEqual(result.snapshot, reader.snapshot);
  }

  const explicit = await invoke<{ manuscript?: { id: string; name?: string; status?: string }; manuscriptBody?: string }>(
    "story.scene.context", { sceneId: frontmatterId }, context,
  );
  assert.equal(explicit.data.manuscript?.id, `doc-ms-${frontmatterId}`);
  assert.equal(explicit.data.manuscript?.name, "Explicit title");
  assert.equal(explicit.data.manuscript?.status, "draft");
  assert.equal(explicit.data.manuscriptBody, "本文です。");
});

test("a Story proposal edits prose between Markdown rules at the original UTF-16 offsets", async () => {
  const path = "manuscript/vol-main/ch-main-1/sc-1.md";
  const content = "---\r\n回想。\r\n---\r\n現在。\r\n";
  const reader = makeReader(fixtureFiles({ [path]: content }));
  const context = makeActionContext(reader);
  context.invoke = async () => ({
    ok: false, snapshot: reader.snapshot,
    error: { code: "PROPOSAL_NOT_FOUND", message: "missing", retryable: false },
  });
  const assessment = { confidence: 1, risk: "low" };
  const start = content.indexOf("回想");
  const proposal = await invoke("story.changes.propose", {
    schemaVersion: 1, id: "horizontal-rule-edit", projectId: context.projectId,
    goal: "Correct the opening scene", status: "proposed", assessment, evidence: [],
    diagnostics: { before: null, after: null },
    operations: [{
      id: "replace-opening", kind: "manuscript.replace-range", assessment, evidenceIds: [],
      target: { manuscriptId: "ms-vol-main-ch-main-1-sc-1", sceneId: "sc-1" },
      precondition: { kind: "content-hash", value: "243b44ad" },
      range: { start, end: start + 2 }, replacement: "記憶",
    }],
  }, context);
  const write = proposal.proposals?.[0]?.operations[0]?.writes.find((entry) => entry.path === path);
  assert.equal(write?.content, content.replace("回想", "記憶"));
  assert.deepEqual(write?.textChanges, [{ fromUtf16: start, toUtf16: start + 2, insert: "記憶" }]);
});

test("thread status follows a root scene into the next chapter scene in document order", async () => {
  const rootId = "11111111-1111-4111-8111-111111111111";
  const files = fixtureFiles({
    [`plot/volumes/root/chapters/root/scenes/${rootId}.yaml`]: yaml({
      id: rootId, type: "scene", order: 0, manuscript: `documents/${rootId}.md`,
    }),
    [`documents/${rootId}.md`]: "An unopened door.",
    "plot/threads/thread-door.yaml": yaml({ id: "thread-door", type: "thread", planted: [rootId], payoff: ["sc-2"] }),
  });
  const context = makeActionContext(makeReader(files));
  for (const [at, expected] of [[rootId, "planted"], ["sc-1", "planted"], ["sc-2", "resolved"]]) {
    const result = await invoke<{ threads: Array<{ status: string; plantedSceneId: string }> }>(
      "story.threads.status", { at, threadId: "thread-door" }, context,
    );
    assert.equal(result.data.threads[0]?.status, expected);
    assert.equal(result.data.threads[0]?.plantedSceneId, rootId);
  }
  const lifecycle = await invoke<{ snapshots: Array<{ state: string; plantedSceneId: string }> }>(
    "story.threads.lifecycle", { threadId: "thread-door" }, context,
  );
  assert.equal(lifecycle.data.snapshots[0]?.state, "resolved");
  assert.equal(lifecycle.data.snapshots[0]?.plantedSceneId, rootId);
});

test("snapshot materialization reads each pinned Story snapshot without proposing writes", async () => {
  const counted = (files: Map<string, string>, projectId: string, projectVersion: number) => {
    const base = makeReader(files, projectId);
    const counts = { reads: 0, lists: 0 };
    const reader: SnapshotReader = {
      ...base,
      snapshot: { ...base.snapshot, projectVersion },
      async read(path, encoding) { counts.reads += 1; return base.read(path, encoding); },
      async list(prefix) { counts.lists += 1; return base.list(prefix); },
    };
    return { reader, counts };
  };
  const firstFiles = fixtureFiles();
  const first = counted(firstFiles, "repo-materialize", 11);
  const firstProposals: Array<{ id: string; operations: ChangeOperation[] }> = [];
  const firstContext = makeActionContext(first.reader, { proposals: firstProposals });
  const materialize = actionById("story.snapshot.materialize");
  assert.equal(materialize.effect, "read");
  const firstResult = await invoke<{ entities: number; links: number }>("story.snapshot.materialize", {}, firstContext);
  assert.deepEqual(firstResult.data, { entities: 8, links: 3 });
  assert.deepEqual(firstResult.snapshot, first.reader.snapshot);
  assert.ok(first.counts.lists > 0 && first.counts.reads > 0);
  assert.deepEqual(firstProposals, []);

  const secondFiles = fixtureFiles({
    "bible/items/item-key.yaml": yaml({ id: "item-key", name: "Key", type: "item", related: ["loc-cafe"] }),
  });
  const second = counted(secondFiles, "repo-materialize", 12);
  const secondProposals: Array<{ id: string; operations: ChangeOperation[] }> = [];
  const secondContext = makeActionContext(second.reader, { proposals: secondProposals });
  const secondResult = await invoke<{ entities: number; links: number }>("story.snapshot.materialize", {}, secondContext);
  assert.deepEqual(secondResult.data, { entities: 9, links: 4 });
  assert.deepEqual(secondResult.snapshot, second.reader.snapshot);
  assert.notDeepEqual(secondResult.snapshot, firstResult.snapshot);
  assert.ok(second.counts.lists > 0 && second.counts.reads > 0);
  assert.deepEqual(secondProposals, []);
});

test("graph query keeps native documents for manuscript graphs and skips them for explicit non-manuscript types", async () => {
  const noteId = "22222222-2222-4222-8222-222222222222";
  const notePath = `documents/${noteId}.md`;
  const reader = makeReader(fixtureFiles({
    [notePath]: "---\ntitle: Author note\n---\nAn editable author document.\n",
    "manuscript/source-entity.yaml": yaml({ id: "char-source", type: "character", name: "Source character" }),
  }), "repo-graph", { [notePath]: "note" });
  const documentsRead: string[] = [];
  const context = makeActionContext({
    ...reader,
    async list(prefix) {
      if (prefix === "documents") documentsRead.push(prefix);
      return reader.list(prefix);
    },
    async read(path) {
      if (path.startsWith("documents/")) documentsRead.push(path);
      return reader.read(path);
    },
  });
  type Graph = { nodes: Array<{ id: string; type: string; name: string }>; edges: Array<{ from: string; to: string; kind: string }> };
  const graph = await invoke<Graph>("story.graph.query", { types: ["character"] }, context);
  assert.deepEqual(graph.data.nodes, [
    { id: "char-uma", type: "character", name: "Uma" },
    { id: "char-source", type: "character", name: "Source character" },
  ]);
  assert.deepEqual(graph.snapshot, reader.snapshot);
  const empty = await invoke<Graph>("story.graph.query", { types: [] }, context);
  assert.deepEqual(empty.data, { nodes: [], edges: [] });
  assert.equal(documentsRead.length, 0, "a graph with these explicit types does not need native document bodies");

  const defaults = await invoke<Graph>("story.graph.query", {}, context);
  assert.deepEqual(defaults.data.nodes.map(({ id }) => id), ["char-uma", "loc-cafe", "char-source"]);
  const manuscripts = await invoke<Graph>("story.graph.query", { types: ["scene", "manuscript"] }, context);
  assert.ok(manuscripts.data.nodes.some(({ id, name }) => id === `doc-ms-${noteId}` && name === "Author note"));
  assert.ok(manuscripts.data.nodes.some(({ id }) => id === "ms-vol-main-ch-main-1-sc-1"));
  assert.ok(manuscripts.data.edges.some(({ from, to, kind }) =>
    from === "sc-1" && to === "ms-vol-main-ch-main-1-sc-1" && kind === "manuscript"));
  assert.ok(documentsRead.includes(notePath));
  const invalid = await actionById("story.graph.query").invoke({ types: "character" }, context);
  assert.equal(invalid.ok, false);
  if (!invalid.ok) {
    assert.equal(invalid.error.code, "invalid_input");
    assert.match(invalid.error.message, /types must be a string array/u);
  }
});

test("entity updates validate source revisions and return a reviewable Core proposal", async () => {
  const files = fixtureFiles();
  const reader = makeReader(files);
  const proposals: Array<{ id: string; operations: ChangeOperation[] }> = [];
  const context = makeActionContext(reader, { proposals });
  const entity = (await invoke<{ revision: string }>("story.entities.get", { id: "char-uma" }, context)).data;
  const updated = await invoke<{ raw: Record<string, unknown> }>("story.entities.update", {
    id: "char-uma", patch: { name: "Uma Kato" }, base_revision: entity.revision, operation_id: "update-uma-1",
  }, context);
  assert.equal(updated.data.raw.name, "Uma Kato");
  assert.equal(updated.proposals?.[0]?.id, "proposal-1");
  assert.equal(updated.proposals?.[0]?.operations[0]?.id, "story-update-uma-1");
  assert.equal(updated.proposals?.[0]?.operations[0]?.writes[0]?.path, "bible/characters/char-uma/profile.yaml");
  assert.equal(YAML.parse(files.get("bible/characters/char-uma/profile.yaml")!).name, "Uma", "proposing does not write the snapshot");

  const stale = await actionById("story.entities.update").invoke({
    id: "char-uma", patch: { name: "Stale" }, base_revision: "stale-revision", operation_id: "update-uma-stale",
  }, context);
  assert.equal(stale.ok, false);
  if (!stale.ok) assert.equal(stale.error.code, "operation_precondition_conflict");
  assert.equal(proposals.length, 1);
});

test("entity relationship proposals pin referenced entity revisions and participate in thread lifecycle reads", async () => {
  const files = fixtureFiles({
    "plot/threads/thread-promise.yaml": yaml({ id: "thread-promise", name: "Promise", type: "thread", keywords: ["promise"], relations: [] }),
  });
  const reader = makeReader(files);
  const proposals: Array<{ id: string; operations: ChangeOperation[] }> = [];
  const context = makeActionContext(reader, { proposals });
  const thread = (await invoke<{ revision: string }>("story.entities.get", { id: "thread-promise" }, context)).data;
  const planted = await invoke("story.entities.update", {
    id: "thread-promise", patch: { relations: [{ target: "sc-1", kind: "planted" }] },
    base_revision: thread.revision, operation_id: "plant-promise",
  }, context);
  const plantOperation = planted.proposals![0]!.operations[0]!;
  const scenePath = "plot/volumes/vol-main/chapters/ch-main-1/scenes/sc-1.yaml";
  assert.ok(plantOperation.reads.some((item) => item.path === scenePath && item.revision === revision(files.get(scenePath)!)));
  files.set(plantOperation.writes[0]!.path, plantOperation.writes[0]!.content!);

  const scene = (await invoke<{ revision: string }>("story.entities.get", { id: "sc-2" }, makeActionContext(makeReader(files)))).data;
  const advanced = await invoke("story.entities.update", {
    id: "sc-2", patch: { relations: [{ target: "thread-promise", kind: "advances" }] },
    base_revision: scene.revision, operation_id: "advance-promise",
  }, makeActionContext(makeReader(files), { proposals }));
  const advanceOperation = advanced.proposals![0]!.operations[0]!;
  const threadPath = "plot/threads/thread-promise.yaml";
  assert.ok(advanceOperation.reads.some((item) => item.path === threadPath && item.revision === revision(files.get(threadPath)!)));
  files.set(advanceOperation.writes[0]!.path, advanceOperation.writes[0]!.content!);

  const lifecycle = await invoke<{ snapshots: Array<{ threadId: string; state: string; plantedSceneId?: string; recalledSceneIds: string[] }> }>(
    "story.threads.lifecycle", { threadId: "thread-promise" }, makeActionContext(makeReader(files)),
  );
  assert.equal(lifecycle.data.snapshots[0]?.state, "recalled");
  assert.equal(lifecycle.data.snapshots[0]?.plantedSceneId, "sc-1");
  assert.deepEqual(lifecycle.data.snapshots[0]?.recalledSceneIds, ["sc-2"]);

  const unsupported = await actionById("story.entities.update").invoke({
    id: "thread-promise", patch: { relations: [{ target: "sc-1", kind: "advances" }] }, operation_id: "bad-thread-direction",
  }, makeActionContext(makeReader(files), { proposals }));
  assert.equal(unsupported.ok, false);
  if (!unsupported.ok) assert.equal(unsupported.error.code, "invalid_input");
  const unsupportedScene = await actionById("story.entities.update").invoke({
    id: "sc-2", patch: { relations: [{ target: "thread-promise", kind: "planted" }] }, operation_id: "bad-scene-direction",
  }, makeActionContext(makeReader(files), { proposals }));
  assert.equal(unsupportedScene.ok, false);
  if (!unsupportedScene.ok) assert.equal(unsupportedScene.error.code, "invalid_input");
});

function zukanRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "suggestion-1", entity_id: "char-uma", block_path: "lead.0", proposed_text: "A newly approved fact.",
    evidence_json: JSON.stringify([{ quote: "verified in the story", sceneId: "sc-1" }]), status: "pending",
    source: "manuscript", kind: "fact", source_session_id: null, source_turn_range_json: null,
    confidence: "high", created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-02T00:00:00.000Z",
    future_field: { preserve: true }, migrationSource: { databaseSources: [{ databaseId: "project-arcadia", table: "zukan_suggestions" }] },
    ...overrides,
  };
}

test("Zukan suggestions list by status and approve/reject as snapshot-bound proposals", async () => {
  const profilePath = "bible/characters/char-uma/profile.yaml";
  const original = YAML.parse(fixtureFiles().get(profilePath)!);
  original.notes = {
    lead: [{ type: "paragraph", text: "Existing lead." }],
    sections: [{ heading: "History", body: [{ type: "paragraph", text: "Earlier detail." }], children: [{ heading: "Family", body: [], children: [] }] }],
  };
  const suggestionsPath = ZUKAN_SUGGESTIONS_PATH;
  const rows = [
    zukanRow(),
    zukanRow({ id: "suggestion-2", status: "rejected" }),
    zukanRow({ id: "suggestion-same-block", proposed_text: "Another note from this block." }),
  ];
  const files = fixtureFiles({
    [profilePath]: yaml(original),
    [suggestionsPath]: rows.map((row) => JSON.stringify(row)).join("\n") + "\n",
  });
  const proposals: Array<{ id: string; operations: ChangeOperation[] }> = [];
  const context = makeActionContext(makeReader(files), { proposals });
  const listed = await invoke<{ pendingCount: number; suggestions: Array<ZukanSuggestion> }>("story.zukan-suggestions.list", {}, context);
  assert.equal(listed.data.pendingCount, 2);
  assert.deepEqual(listed.data.suggestions.map((item) => item.id), ["suggestion-1", "suggestion-same-block"]);
  assert.equal(listed.data.suggestions[0]?.entityRevision?.length, 73);

  const approved = await invoke<{ suggestion: ZukanSuggestion; entityRevision: string }>("story.zukan-suggestions.approve", {
    id: "suggestion-1", entityRevision: listed.data.suggestions[0]!.entityRevision, operation_id: "approve-suggestion-1",
  }, context);
  const approval = approved.proposals![0]!.operations[0]!;
  assert.deepEqual(approval.writes.map((write) => write.path).sort(), [profilePath, suggestionsPath].sort());
  assert.ok(approval.reads.some((item) => item.path === profilePath && item.revision === revision(files.get(profilePath)!)));
  assert.ok(approval.reads.some((item) => item.path === suggestionsPath && item.revision === revision(files.get(suggestionsPath)!)));
  const updatedEntity = YAML.parse(approval.writes.find((write) => write.path === profilePath)!.content!);
  assert.equal(updatedEntity.notes.lead[0].text, "Existing lead.\nA newly approved fact.");
  assert.equal(updatedEntity.notes.sections[0].body[0].text, "Earlier detail.");
  assert.equal(updatedEntity.notes.sections[0].children[0].heading, "Family");
  const approvedRow = JSON.parse(approval.writes.find((write) => write.path === suggestionsPath)!.content!.split("\n")[0]!) as Record<string, unknown>;
  assert.equal(approvedRow.status, "approved");
  assert.equal(approvedRow.updated_at, "2026-01-02T00:00:00.001Z");
  assert.deepEqual(approvedRow.future_field, { preserve: true });
  assert.deepEqual(approvedRow.migrationSource, zukanRow().migrationSource);
  const approvedRows = approval.writes.find((write) => write.path === suggestionsPath)!.content!.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.equal(approvedRows.find((row) => row.id === "suggestion-same-block")?.status, "stale", "approving an edit invalidates other pending suggestions based on the same changed note block");
  assert.equal(YAML.parse(files.get(profilePath)!).notes.lead[0].text, "Existing lead.", "proposing does not mutate the selected snapshot");

  const rejected = await invoke<{ suggestion: ZukanSuggestion }>("story.zukan-suggestions.reject", {
    id: "suggestion-1", operation_id: "reject-suggestion-1",
  }, context);
  const rejection = rejected.proposals![0]!.operations[0]!;
  assert.deepEqual(rejection.writes.map((write) => write.path), [suggestionsPath]);
  const rejectedRow = JSON.parse(rejection.writes[0]!.content!.split("\n")[0]!) as Record<string, unknown>;
  assert.equal(rejectedRow.status, "rejected");
});

test("Zukan creation validates manuscript provenance and proposes a stable pending JSONL row", async () => {
  const oldRow = zukanRow({ sourceHash: "a".repeat(64) });
  const files = fixtureFiles({
    [ZUKAN_SUGGESTIONS_PATH]: `${JSON.stringify(oldRow)}\n`,
  });
  const proposals: Array<{ id: string; operations: ChangeOperation[]; evidence?: ChangeProposal["evidence"] }> = [];
  const context = makeActionContext(makeReader(files), { proposals });
  const input = {
    entityId: "char-uma",
    blockPath: "lead.0",
    proposedText: "Uma enters the cafe.",
    evidence: [{ quote: "Uma enters the cafe.", sceneId: "sc-1" }],
    source: "manuscript",
    kind: null,
    confidence: "high",
    operation_id: "zukan-create-uma",
  };
  const created = await invoke<{ suggestion: Record<string, unknown>; created: boolean; staledPendingCount: number }>(
    "story.zukan-suggestions.create", input, context,
  );
  assert.equal(created.data.created, true);
  assert.equal(created.data.staledPendingCount, 1, "a pending row with changed source freshness is staled atomically");
  const suggestion = created.data.suggestion;
  assert.match(String(suggestion.id), /^zukan-[a-f0-9]{64}$/u);
  assert.equal(suggestion.status, "pending", "creation only proposes a pending row and does not auto-approve it");
  assert.equal(suggestion.entityId, "char-uma");
  assert.equal(suggestion.entityName, "Uma");
  assert.equal(suggestion.sourceSnapshot, 11);
  assert.match(String(suggestion.sourceHash), /^[a-f0-9]{64}$/u);
  assert.equal(suggestion.createdAt, suggestion.updatedAt);

  const operation = created.proposals![0]!.operations[0]!;
  const profilePath = "bible/characters/char-uma/profile.yaml";
  const scenePath = "plot/volumes/vol-main/chapters/ch-main-1/scenes/sc-1.yaml";
  const manuscriptPath = "manuscript/vol-main/ch-main-1/sc-1.md";
  assert.deepEqual(operation.writes.map((write) => write.path), [ZUKAN_SUGGESTIONS_PATH]);
  for (const path of [profilePath, scenePath, manuscriptPath, ZUKAN_SUGGESTIONS_PATH]) {
    assert.ok(operation.reads.some((read) => read.path === path && read.revision === (files.has(path) ? revision(files.get(path)!) : null)), `missing current revision for ${path}`);
  }
  assert.equal(operation.id, "story-zukan-create-46624dfb54a3896a89895f153ed759abdb93bf85cacdfdfc15ec723ec6dd41cc");
  const proposedRows = operation.writes[0]!.content!.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.equal(proposedRows[0]?.status, "stale");
  assert.deepEqual(proposedRows[0]?.future_field, { preserve: true });
  assert.equal(proposedRows[1]?.id, suggestion.id);
  assert.equal(proposedRows[1]?.sourceHash, suggestion.sourceHash);
  assert.equal(files.get(ZUKAN_SUGGESTIONS_PATH), `${JSON.stringify(oldRow)}\n`, "proposing does not mutate the selected snapshot");

  files.set(ZUKAN_SUGGESTIONS_PATH, operation.writes[0]!.content!);
  const duplicate = await invoke<{ suggestion: Record<string, unknown>; created: boolean }>("story.zukan-suggestions.create", input, context);
  assert.equal(duplicate.data.created, false);
  assert.equal(duplicate.data.suggestion.id, suggestion.id);
  assert.equal(duplicate.proposals, undefined, "an already persisted stable suggestion is not proposed again");
  assert.equal(proposals.length, 1);
});

test("Zukan retries across an unrelated snapshot return the stored status without rebasing, while a new operation ID gets a new proposal identity", async () => {
  const files = fixtureFiles();
  const reader = makeReader(files);
  const firstProposals: ChangeProposal[] = [];
  const firstContext = makeActionContext(reader, { proposals: firstProposals });
  firstContext.listActions = async () => [{ id: "core.proposals.get" } as Awaited<ReturnType<ModuleActionContext["listActions"]>>[number]];
  let storedStatus: ProposalStatus | undefined;
  firstContext.invoke = async (_actionId, input) => {
    const proposalId = (input as { proposalId: string }).proposalId;
    return storedStatus
      ? { ok: true, snapshot: reader.snapshot, data: { proposal: storedStatus } }
      : { ok: false, snapshot: reader.snapshot, error: { code: "PROPOSAL_NOT_FOUND", message: `missing ${proposalId}`, retryable: false } };
  };
  const input = {
    entityId: "char-uma",
    blockPath: "lead.0",
    proposedText: "Uma enters the cafe.",
    evidence: [{ quote: "Uma enters the cafe.", sceneId: "sc-1" }],
    source: "manuscript",
    kind: "fact",
    confidence: "high",
    operation_id: "logical-zukan-creation-1",
  };
  const first = await invoke<{ suggestion: Record<string, unknown>; created: boolean }>(
    "story.zukan-suggestions.create", input, firstContext,
  );
  assert.equal(first.data.created, true);
  assert.equal(first.proposals?.length, 1);
  const proposal = first.proposals![0]!;
  storedStatus = {
    proposal,
    payloadComplete: true,
    state: "proposed",
    approvedOperationIds: [],
    applications: [],
    appliedOperationIds: [],
    stale: true,
  };

  const advancedReader: SnapshotReader = {
    ...makeReader(files),
    snapshot: { ...reader.snapshot, projectVersion: 12 },
  };
  const advancedProposals: ChangeProposal[] = [];
  const advancedContext = makeActionContext(advancedReader, { proposals: advancedProposals });
  advancedContext.listActions = firstContext.listActions;
  advancedContext.invoke = async (_actionId, inputValue) => {
    assert.equal((inputValue as { proposalId: string }).proposalId, proposal.id);
    return { ok: true, snapshot: advancedReader.snapshot, data: { proposal: storedStatus! } };
  };
  const retried = await invoke<{
    suggestion: Record<string, unknown>;
    created: boolean;
    replayed: boolean;
    proposalStatus: ProposalStatus;
  }>("story.zukan-suggestions.create", input, advancedContext);
  assert.equal(retried.data.created, false);
  assert.equal(retried.data.replayed, true);
  assert.equal(retried.data.proposalStatus.proposal.id, proposal.id);
  assert.equal(retried.data.proposalStatus.proposal.snapshot.projectVersion, reader.snapshot.projectVersion);
  assert.equal(retried.data.proposalStatus.stale, true);
  assert.equal(retried.proposals, undefined, "an old-snapshot proposal is read back without proposing it against the newer snapshot");
  assert.equal(advancedProposals.length, 0);

  const changedMeaning = await actionById("story.zukan-suggestions.create").invoke({
    ...input, proposedText: "A changed fact under the same operation ID.",
  }, advancedContext);
  assert.equal(changedMeaning.ok, false);
  if (!changedMeaning.ok) assert.equal(changedMeaning.error.code, "suggestion_identity_conflict");
  assert.equal(advancedProposals.length, 0);

  const newIntentProposals: ChangeProposal[] = [];
  const newIntentContext = makeActionContext(reader, { proposals: newIntentProposals });
  newIntentContext.listActions = firstContext.listActions;
  newIntentContext.invoke = async (_actionId, inputValue) => {
    assert.notEqual((inputValue as { proposalId: string }).proposalId, proposal.id);
    return { ok: false, snapshot: reader.snapshot, error: { code: "PROPOSAL_NOT_FOUND", message: "missing", retryable: false } };
  };
  const newIntent = await invoke<{ suggestion: Record<string, unknown>; created: boolean }>(
    "story.zukan-suggestions.create", { ...input, operation_id: "logical-zukan-creation-2" }, newIntentContext,
  );
  assert.equal(newIntent.data.created, true);
  assert.equal(newIntent.proposals?.length, 1);
  assert.notEqual(newIntent.proposals?.[0]?.id, proposal.id);
  assert.notEqual(newIntent.data.suggestion.id, first.data.suggestion.id);
});

test("Zukan creation rejects stale manuscript quotes and validates sandbox source ranges", async () => {
  const files = fixtureFiles({
    "bible/dialogue_sketches/ds-uma.yaml": yaml({
      id: "ds-uma", type: "dialogue_sketch", participantEntityIds: ["char-uma"],
      lines: [{ speakerEntityId: "char-uma", text: "Uma likes tea." }],
    }),
  });
  const proposals: Array<{ id: string; operations: ChangeOperation[] }> = [];
  const context = makeActionContext(makeReader(files), { proposals });
  const stale = await actionById("story.zukan-suggestions.create").invoke({
    entityId: "char-uma", proposedText: "Uma visits the station.", source: "manuscript",
    evidence: [{ quote: "Uma visits the station.", sceneId: "sc-1" }], operation_id: "stale-zukan-quote",
  }, context);
  assert.equal(stale.ok, false);
  if (!stale.ok) assert.equal(stale.error.code, "operation_precondition_conflict");
  assert.equal(proposals.length, 0);

  const sandbox = await invoke<{ suggestion: Record<string, unknown>; created: boolean }>("story.zukan-suggestions.create", {
    entityId: "char-uma", proposedText: "Uma likes tea.", source: "sandbox", sourceSessionId: "ds-uma",
    sourceTurnRange: { start: 0, end: 0 }, evidence: [{ quote: "likes tea" }], kind: "habit", confidence: "high",
    operation_id: "sandbox-zukan-uma",
  }, context);
  const sandboxOperation = sandbox.proposals![0]!.operations[0]!;
  assert.equal(sandbox.data.suggestion.sourceSessionId, "ds-uma");
  assert.deepEqual(sandbox.data.suggestion.sourceTurnRange, { start: 0, end: 0 });
  assert.ok(sandboxOperation.reads.some((read) => read.path === "bible/dialogue_sketches/ds-uma.yaml" && read.revision === revision(files.get("bible/dialogue_sketches/ds-uma.yaml")!)));
  const staleRange = await actionById("story.zukan-suggestions.create").invoke({
    entityId: "char-uma", proposedText: "Uma likes tea.", source: "sandbox", sourceSessionId: "ds-uma",
    sourceTurnRange: { start: 0, end: 2 }, evidence: [{ quote: "likes tea" }], operation_id: "stale-zukan-range",
  }, context);
  assert.equal(staleRange.ok, false);
  if (!staleRange.ok) assert.equal(staleRange.error.code, "operation_precondition_conflict");
  assert.equal(proposals.length, 1);
});

test("manual note edits stale matching pending Zukan rows in the same Story proposal", async () => {
  const profilePath = "bible/characters/char-uma/profile.yaml";
  const sourceEntity = YAML.parse(fixtureFiles().get(profilePath)!);
  sourceEntity.notes = {
    lead: [
      { type: "paragraph", text: "Original lead." },
      { type: "paragraph", text: "Unchanged lead." },
    ],
    sections: [],
  };
  const rows = [
    zukanRow({ id: "stale-matching-block", block_path: "lead.0" }),
    zukanRow({ id: "keep-other-block", block_path: "lead.1" }),
    zukanRow({ id: "keep-other-entity", entity_id: "loc-cafe", block_path: "lead.0" }),
    zukanRow({ id: "keep-rejected", status: "rejected", block_path: "lead.0" }),
  ];
  const suggestionsContent = rows.map((row) => JSON.stringify(row)).join("\n") + "\n";
  const files = fixtureFiles({
    [profilePath]: yaml(sourceEntity),
    [ZUKAN_SUGGESTIONS_PATH]: suggestionsContent,
  });
  const proposals: Array<{ id: string; operations: ChangeOperation[] }> = [];
  const context = makeActionContext(makeReader(files), { proposals });
  const updated = await invoke("story.entities.update", {
    id: "char-uma",
    patch: { notes: { lead: [
      { type: "paragraph", text: "Rewritten lead." },
      { type: "paragraph", text: "Unchanged lead." },
    ], sections: [] } },
  }, context);
  const operation = updated.proposals![0]!.operations[0]!;
  assert.deepEqual(operation.writes.map((write) => write.path).sort(), [profilePath, ZUKAN_SUGGESTIONS_PATH].sort());
  assert.ok(operation.reads.some((read) => read.path === ZUKAN_SUGGESTIONS_PATH && read.revision === revision(suggestionsContent)));
  const rewrittenRows = JSON.parse(`[${operation.writes.find((write) => write.path === ZUKAN_SUGGESTIONS_PATH)!.content!.trim().split("\n").join(",")}]`) as Array<Record<string, unknown>>;
  const statusById = new Map(rewrittenRows.map((row) => [row.id, row.status]));
  assert.equal(statusById.get("stale-matching-block"), "stale");
  assert.equal(statusById.get("keep-other-block"), "pending");
  assert.equal(statusById.get("keep-other-entity"), "pending");
  assert.equal(statusById.get("keep-rejected"), "rejected");
  assert.equal(files.get(ZUKAN_SUGGESTIONS_PATH), suggestionsContent, "proposing does not mutate the selected snapshot");
});

test("scene creation inserts by position in one proposal and includes every changed file precondition", async () => {
  const files = fixtureFiles();
  const reader = makeReader(files);
  const proposals: Array<{ id: string; operations: ChangeOperation[] }> = [];
  const context = makeActionContext(reader, { proposals });
  const tree = (await invoke<{ tree: StoryVolumeTree; revision: string }>("story.volumes.tree", {}, context)).data;
  const result = await invoke<{ id: string; filePath: string }>("story.entities.create", {
    type: "scene", slug: "new-entry", title: "New entry", chapter: "ch-main-1", volume: "vol-main",
    position: 2, characters: ["char-uma"], location: "loc-cafe", base_revision: tree.revision, operation_id: "insert-scene-1",
  }, context);
  assert.equal(result.data.id, "sc-new-entry");
  assert.equal(result.proposals?.length, 1);
  const operation = result.proposals![0]!.operations[0]!;
  assert.equal(operation.id, "story-insert-scene-1");
  assert.deepEqual(operation.writes.map((write) => write.path).sort(), [
    "manuscript/vol-main/ch-main-1/sc-new-entry.md",
    "plot/volumes/vol-main/chapters/ch-main-1/scenes/sc-new-entry.yaml",
    "plot/volumes/vol-main/chapters/ch-main-1/scenes/sc-2.yaml",
  ].sort());
  const newScene = YAML.parse(operation.writes.find((write) => write.path.endsWith("/sc-new-entry.yaml"))!.content!);
  const shiftedSibling = YAML.parse(operation.writes.find((write) => write.path.endsWith("sc-2.yaml"))!.content!);
  assert.equal(newScene.order, 2);
  assert.deepEqual(newScene.relations, [{ target: "char-uma", kind: "appears" }]);
  assert.equal(shiftedSibling.order, 3);
  assert.ok(operation.reads.some((item) => item.path.endsWith("sc-2.yaml") && item.revision === revision(files.get("plot/volumes/vol-main/chapters/ch-main-1/scenes/sc-2.yaml")!)));
  assert.deepEqual(operation.readScopes?.map((scope) => scope.prefix).sort(), ["bible", "plot"]);
  assert.ok(operation.readScopes?.every((scope) => /^[a-f0-9]{64}$/.test(scope.revision)));
  assert.equal(proposals.length, 1);
});

test("Story creation appends string order keys under the selected parent without rewriting siblings", async () => {
  const files = fixtureFiles();
  const chapterPath = "plot/volumes/vol-main/chapters/ch-main-1/chapter.yaml";
  const firstScenePath = "plot/volumes/vol-main/chapters/ch-main-1/scenes/sc-1.yaml";
  const secondScenePath = "plot/volumes/vol-main/chapters/ch-main-1/scenes/sc-2.yaml";
  for (const [path, order] of [[chapterPath, "0000000009"], [firstScenePath, "0000000009"], [secondScenePath, "0000000010"]] as const) {
    const metadata = YAML.parse(files.get(path)!) as Record<string, unknown>;
    metadata.order = order;
    files.set(path, yaml(metadata));
  }
  const originalSiblings = new Map([chapterPath, firstScenePath, secondScenePath].map(path => [path, files.get(path)!]));
  const proposals: Array<{ id: string; operations: ChangeOperation[] }> = [];
  const context = makeActionContext(makeReader(files), { proposals });

  const chapter = await invoke<{ id: string; filePath: string }>("story.entities.create", {
    type: "chapter", id: "ch-appended", title: "Appended chapter", volume: "vol-main",
  }, context);
  const chapterWrite = proposals[0]!.operations[0]!.writes.find(write => write.path.endsWith("/ch-appended/chapter.yaml"))!;
  assert.equal(chapter.data.filePath, "plot/volumes/vol-main/chapters/ch-appended/chapter.yaml");
  assert.equal(YAML.parse(chapterWrite.content!).order, "0000000010");

  const scene = await invoke<{ id: string; filePath: string }>("story.entities.create", {
    type: "scene", id: "sc-appended", title: "Appended scene", chapter: "ch-main-1", volume: "vol-main",
  }, context);
  const sceneOperation = proposals[1]!.operations[0]!;
  const sceneWrite = sceneOperation.writes.find(write => write.path.endsWith("/sc-appended.yaml"))!;
  assert.equal(scene.data.filePath, "plot/volumes/vol-main/chapters/ch-main-1/scenes/sc-appended.yaml");
  assert.equal(YAML.parse(sceneWrite.content!).order, "0000000011");
  assert.deepEqual(sceneOperation.writes.map(write => write.path).sort(), [
    "manuscript/vol-main/ch-main-1/sc-appended.md",
    "plot/volumes/vol-main/chapters/ch-main-1/scenes/sc-appended.yaml",
  ].sort());
  for (const [path, content] of originalSiblings) assert.equal(files.get(path), content);
});

test("NarrativeChangeSet defaults chapter and scene order from projected string keys", async () => {
  const files = fixtureFiles();
  const chapterPath = "plot/volumes/vol-main/chapters/ch-main-1/chapter.yaml";
  const firstScenePath = "plot/volumes/vol-main/chapters/ch-main-1/scenes/sc-1.yaml";
  const secondScenePath = "plot/volumes/vol-main/chapters/ch-main-1/scenes/sc-2.yaml";
  for (const [path, order] of [[chapterPath, "0000000009"], [firstScenePath, "0000000009"], [secondScenePath, "0000000010"]] as const) {
    const metadata = YAML.parse(files.get(path)!) as Record<string, unknown>;
    metadata.order = order;
    files.set(path, yaml(metadata));
  }
  const reader = makeReader(files);
  const proposals: Array<{ id: string; operations: ChangeOperation[] }> = [];
  const context = makeActionContext(reader, { proposals });
  context.invoke = async (actionId) => actionId === "core.proposals.get"
    ? { ok: false, snapshot: reader.snapshot, error: { code: "PROPOSAL_NOT_FOUND", message: "missing", retryable: false } }
    : { ok: false, snapshot: reader.snapshot, error: { code: "missing_action", message: "not wired", retryable: false } };
  const entities = (await invoke<Array<{ id: string; revision: string }>>("story.entities.list", {}, context)).data;
  const revisionFor = (id: string) => entities.find(entity => entity.id === id)!.revision;
  const changeSet = {
    schemaVersion: 1,
    id: "ncs-default-order",
    projectId: context.projectId,
    goal: "Append hierarchy records",
    status: "proposed",
    assessment: { confidence: 0.9, risk: "low" },
    operations: [
      { id: "chapter-create", kind: "entity.create", precondition: { kind: "absent" }, target: { entityId: "ch-appended", entityType: "chapter" }, values: { id: "ch-appended", title: "Appended chapter", volume: "vol-main" }, evidenceIds: ["evidence-one"], assessment: { confidence: 0.9, risk: "low" } },
      { id: "scene-create", kind: "scene.create", precondition: { kind: "absent" }, target: { sceneId: "sc-appended" }, values: { id: "sc-appended", title: "Appended scene", volume: "vol-main", chapter: "ch-main-1" }, evidenceIds: ["evidence-one"], assessment: { confidence: 0.9, risk: "low" } },
    ],
    evidence: [{ id: "evidence-one", sourceKind: "entity", sourceId: "char-uma", revision: revisionFor("char-uma") }],
    diagnostics: { before: null, after: null },
  };

  const result = await actionById("story.changes.propose").invoke(changeSet, context);
  assert.equal(result.ok, true, result.ok ? undefined : `${result.error.code}: ${result.error.message}`);
  if (!result.ok) return;
  const operations = result.proposals?.[0]?.operations ?? [];
  const chapterWrite = operations[0]!.writes.find(write => write.path.endsWith("/ch-appended/chapter.yaml"))!;
  const sceneWrite = operations[1]!.writes.find(write => write.path.endsWith("/sc-appended.yaml"))!;
  assert.equal(YAML.parse(chapterWrite.content!).order, "0000000010");
  assert.equal(YAML.parse(sceneWrite.content!).order, "0000000011");
  assert.equal(operations[0]!.writes.some(write => write.path === chapterPath), false);
  assert.equal(operations[1]!.writes.some(write => write.path === firstScenePath || write.path === secondScenePath), false);
  assert.equal(proposals.length, 1);
});

test("series bindings use stable repository identity and preserve unknown settings", async () => {
  const settings = {
    version: 1,
    series: [{ id: "series-main", name: "Main", ownerId: "owner:test", bibleProjectId: "repo-bible", memberProjectIds: ["repo-work"], createdAt: "2026-01-01T00:00:00.000Z", futureSeriesField: "keep" }],
    bindings: [{ projectId: "repo-work", seriesId: "series-main", futureBindingField: 12 }],
    futureRootField: { keep: true },
  };
  const reader = makeReader(fixtureFiles({ [SERIES_PATH]: JSON.stringify(settings) + "\n" }));
  const linkedReader = makeReader(fixtureFiles({
    "bible/characters/char-uma/profile.yaml": yaml({ id: "char-uma", name: "Bible Uma", type: "character", aliases: ["Bible-U"], notes: { lead: [{ type: "paragraph", text: "Bible source record." }], sections: [] } }),
  }), "repo-bible");
  const linkedIds: string[] = [];
  const context = makeActionContext(reader, { linkedReader: async (id) => { linkedIds.push(id); return linkedReader; } });
  const binding = await invoke<{ bibleProjectId: string; requiresAuthorReview: boolean }>("story.series.binding.get", {}, context);
  assert.equal(binding.data.bibleProjectId, "repo-bible");
  assert.equal(binding.data.requiresAuthorReview, false);
  const overlay = await invoke<{ workSnapshot: SnapshotId; bibleSnapshot: SnapshotId; workEntities: Array<{ id: string; name: string }>; bibleEntities: Array<{ id: string; name: string; raw: Record<string, unknown> }> }>("story.series.overlay", {}, context);
  assert.equal(overlay.data.workSnapshot.projectId, "repo-work");
  assert.equal(overlay.data.bibleSnapshot.projectId, "repo-bible");
  assert.equal(overlay.data.workEntities.find((entity) => entity.id === "char-uma")?.name, "Uma");
  assert.equal(overlay.data.bibleEntities.find((entity) => entity.id === "char-uma")?.name, "Bible Uma", "the browser can inspect the actual Bible record even when a work record has the same ID");
  assert.equal((overlay.data.bibleEntities.find((entity) => entity.id === "char-uma")?.raw.aliases as string[])[0], "Bible-U");
  assert.deepEqual(linkedIds, ["repo-bible"]);

  const proposals: Array<{ id: string; operations: ChangeOperation[] }> = [];
  const settingsContext = makeActionContext(reader, { proposals, projectId: "different-transient-id" });
  const fileRevision = revision(JSON.stringify(settings) + "\n");
  const updated = await invoke("story.series.update", { id: "series-main", patch: { name: "Renamed" }, base_revision: fileRevision, operation_id: "series-update-1" }, settingsContext);
  const written = JSON.parse(updated.proposals![0]!.operations[0]!.writes[0]!.content!);
  assert.deepEqual(written.futureRootField, { keep: true });
  assert.equal(written.series[0].futureSeriesField, "keep");
  assert.equal(written.bindings[0].futureBindingField, 12);
  assert.equal(written.bindings[0].projectId, "repo-work");
  assert.equal("repositoryId" in written.bindings[0], false);
});

test("suggested tags do not allocate NLP at module load and report optional capability absence", async () => {
  let capabilityRequests = 0;
  const moduleContext: ModuleContext = {
    ...makeModuleContext(),
    async acquireCapability() { capabilityRequests++; throw new Error("not enabled"); },
  };
  const actions = createStoryActions(moduleContext);
  assert.equal(capabilityRequests, 0);
  const result = await actions.find((item) => item.id === "story.entities.suggested-tags")!.invoke({ id: "char-uma" }, makeActionContext(makeReader(fixtureFiles())));
  assert.equal(capabilityRequests, 1);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "feature_unavailable");
});

// Compatibility hashes for the fixed Story fixtures.
const cafeManuscriptHash = "8264ef5b";

test("state-proposal lifecycle uses the source manuscript FNV hash", async () => {
  const reader = makeReader(fixtureFiles());
  const proposals: Array<{ id: string; operations: ChangeOperation[] }> = [];
  const context = makeActionContext(reader, { proposals });
  const created = await invoke<{ id: string; manuscriptHash: string }>("story.state-proposals.create", {
    id: "proposal-arrival",
    sceneId: "sc-1",
    event: { kind: "location", subject: "char-uma", object: "loc-cafe", payload: {} },
  }, context);
  assert.equal(created.data.manuscriptHash, cafeManuscriptHash);
  const row = JSON.parse(proposals[0]!.operations[0]!.writes[0]!.content!) as { manuscript_hash: string };
  assert.equal(row.manuscript_hash, cafeManuscriptHash);
});

test("NarrativeChangeSet preserves all nine source operation kinds in one identity-bound Core proposal", async () => {
  const body = "Uma enters the cafe.";
  const stateProposal = {
    id: "proposal-arrival",
    scene_id: "sc-1",
    event_json: JSON.stringify({ sceneId: "sc-1", order: 1, kind: "location", subject: "char-uma", object: "loc-cafe", payload: {}, source: "llm-draft", eventId: "draft-arrival", status: "proposed" }),
    manuscript_hash: cafeManuscriptHash,
    status: "proposed",
    conflict_event_ids_json: "[]",
    duplicate_of_proposal_id: null,
    history_json: "[]",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  };
  const stateProposalContent = `${JSON.stringify(stateProposal)}\n`;
  const files = fixtureFiles({
    "plot/threads/thread-main.yaml": yaml({ id: "thread-main", name: "A promise", type: "thread", relations: [] }),
    [STATE_PROPOSALS_PATH]: stateProposalContent,
  });
  const reader = makeReader(files);
  const proposals: Array<{ id: string; operations: ChangeOperation[] }> = [];
  const context = makeActionContext(reader, { proposals });
  context.invoke = async (actionId) => actionId === "core.proposals.get"
    ? { ok: false, snapshot: reader.snapshot, error: { code: "PROPOSAL_NOT_FOUND", message: "missing", retryable: false } }
    : { ok: false, snapshot: reader.snapshot, error: { code: "missing_action", message: "not wired", retryable: false } };
  const entities = (await invoke<Array<{ id: string; revision: string; filePath: string }>>("story.entities.list", {}, context)).data;
  const rev = (id: string) => entities.find((entity) => entity.id === id)!.revision;
  const changeSet = {
    schemaVersion: 1,
    id: "ncs-story-001",
    projectId: context.projectId,
    goal: "Preserve the source change set",
    status: "proposed",
    assessment: { confidence: 0.9, risk: "medium" },
    operations: [
      { id: "create-location", kind: "entity.create", precondition: { kind: "absent" }, target: { entityId: "loc-new", entityType: "location" }, values: { id: "loc-new", type: "location", name: "Garden" }, evidenceIds: ["evidence-one"], assessment: { confidence: 0.9, risk: "low" } },
      { id: "create-scene", kind: "scene.create", precondition: { kind: "absent" }, target: { sceneId: "sc-new" }, values: { id: "sc-new", type: "scene", title: "Garden", volume: "vol-main", chapter: "ch-main-1", order: 3 }, evidenceIds: ["evidence-one"], assessment: { confidence: 0.9, risk: "medium" } },
      { id: "insert-scene", kind: "scene.insert", precondition: { kind: "revision", value: rev("ch-main-1") }, target: { sceneId: "sc-new", chapterId: "ch-main-1" }, position: 3, expectedSiblings: [{ id: "sc-1", revision: rev("sc-1") }, { id: "sc-2", revision: rev("sc-2") }], evidenceIds: ["evidence-one"], assessment: { confidence: 0.9, risk: "medium" } },
      { id: "update-entity", kind: "entity.update", precondition: { kind: "revision", value: rev("char-uma") }, target: { entityId: "char-uma" }, changes: { name: "Uma Kato" }, evidenceIds: ["evidence-one"], assessment: { confidence: 0.9, risk: "low" } },
      { id: "update-scene", kind: "scene.update", precondition: { kind: "revision", value: rev("sc-2") }, target: { sceneId: "sc-2" }, changes: { title: "The table" }, evidenceIds: ["evidence-one"], assessment: { confidence: 0.8, risk: "medium" } },
      { id: "append-state", kind: "state.append-event", precondition: { kind: "revision", value: rev("sc-1") }, target: { sceneId: "sc-1", eventId: "event-arrival" }, event: { sceneId: "sc-1", order: 1, kind: "location", subject: "char-uma", object: "loc-cafe", payload: {}, source: "manual", eventId: "event-arrival", evidence: [{ sceneId: "sc-1", excerpt: "enters the cafe" }], confidence: 0.9, createdAt: "2026-01-01T00:00:00.000Z", status: "confirmed" }, sourceProposal: { id: stateProposal.id, manuscriptHash: stateProposal.manuscript_hash }, evidenceIds: ["evidence-one"], assessment: { confidence: 0.9, risk: "medium" } },
      { id: "link-thread", kind: "thread.link-scene", precondition: { kind: "revision", value: rev("thread-main") }, target: { threadId: "thread-main", sceneId: "sc-1" }, relation: "planted", note: "Promise introduced", evidenceIds: ["evidence-one"], assessment: { confidence: 0.8, risk: "low" } },
      { id: "link-reference", kind: "reference.link", precondition: { kind: "revision", value: rev("loc-cafe") }, target: { from: "loc-cafe", to: "loc-new", kind: "related" }, note: "Nearby places", evidenceIds: ["evidence-one"], assessment: { confidence: 0.8, risk: "low" } },
      { id: "replace-manuscript", kind: "manuscript.replace-range", precondition: { kind: "content-hash", value: cafeManuscriptHash }, target: { manuscriptId: "ms-vol-main-ch-main-1-sc-1", sceneId: "sc-1" }, range: { start: 0, end: 3 }, replacement: "She", evidenceIds: ["evidence-one"], assessment: { confidence: 0.8, risk: "medium" } },
    ],
    evidence: [{ id: "evidence-one", sourceKind: "entity", sourceId: "char-uma", revision: rev("char-uma") }],
    diagnostics: { before: null, after: null },
  };
  const result = await actionById("story.changes.propose").invoke(changeSet, context);
  assert.equal(result.ok, true, result.ok ? undefined : `${result.error.code}: ${result.error.message}`);
  if (!result.ok) return;
  assert.equal(result.proposals?.length, 1);
  assert.equal(result.proposals?.[0]?.id, changeSet.id);
  assert.equal(result.proposals?.[0]?.operations.length, 9);
  const data = result.data as {
    operationMap: Record<string, string>;
    dependencies: Record<string, string[]>;
    resultIds: Record<string, string>;
    resultPaths: Record<string, string[]>;
    resultRevisions: Record<string, string>;
    affectedEntities: Record<string, Array<{ id: string; revision: string }>>;
  };
  assert.equal(Object.keys(data.operationMap).length, 9);
  assert.deepEqual(data.dependencies["create-scene"], ["create-location"], "a later create depends on earlier Story writes represented by its virtual scope revision");
  assert.deepEqual(data.dependencies["insert-scene"], ["create-scene"]);
  assert.equal(data.resultIds["link-reference"], JSON.stringify(["loc-cafe", "loc-new", "related"]));
  const coreProposal = result.proposals![0]!;
  const sourceEvidence = coreProposal.evidence!.find((item) => item.kind === "source.narrative-change-set.v1")!;
  const details = sourceEvidence.details as { sourceChangeSet: unknown; operationMap: Record<string, string> };
  assert.deepEqual(details.sourceChangeSet, changeSet);
  assert.deepEqual(details.operationMap, data.operationMap);
  const rangeOperation = coreProposal.operations.find((operation) => operation.message.includes("replace-manuscript"));
  assert.deepEqual(rangeOperation?.writes[0]?.textChanges, [{
    fromUtf16: "---\ntitle: Door\n---\n".length,
    toUtf16: "---\ntitle: Door\n---\n".length + 3,
    insert: "She",
  }]);
  const persisted = details as unknown as Record<string, unknown>;
  assert.deepEqual(persisted.resultPaths, data.resultPaths);
  assert.deepEqual(persisted.resultRevisions, data.resultRevisions);
  assert.deepEqual(persisted.affectedEntities, data.affectedEntities);
  assert.ok(data.resultPaths["create-scene"]?.includes("plot/volumes/vol-main/chapters/ch-main-1/scenes/sc-new.yaml"));
  assert.ok(data.resultPaths["create-scene"]?.includes("manuscript/vol-main/ch-main-1/sc-new.md"));
  assert.equal(data.resultRevisions["create-scene"]?.startsWith('"sha256-'), true);
  assert.deepEqual(data.affectedEntities["insert-scene"]?.map((item) => item.id), ["sc-1", "sc-2", "sc-new"]);
  assert.deepEqual(coreProposal.operations.map((operation) => operation.id), Object.values(data.operationMap));
  const createLocation = coreProposal.operations[0]!;
  const createScene = coreProposal.operations[1]!;
  const createdScenePath = "plot/volumes/vol-main/chapters/ch-main-1/scenes/sc-new.yaml";
  assert.equal(createScene.reads.find((read) => read.path === createdScenePath)?.revision, null);
  assert.equal(createScene.writes.find((write) => write.path === createdScenePath)?.revision, null,
    "rewriting a virtual scene within one source operation keeps its original Core absence precondition");
  assert.deepEqual(createLocation.readScopes?.map((scope) => scope.prefix).sort(), ["bible", "plot"]);
  assert.deepEqual(createScene.readScopes?.map((scope) => scope.prefix).sort(), ["bible", "plot"]);
  const bibleScope = (operation: ChangeOperation) => operation.readScopes?.find((scope) => scope.prefix === "bible")?.revision;
  assert.notEqual(bibleScope(createScene), bibleScope(createLocation), "later source operations include earlier planned Story creates in their membership guard");
  assert.equal(createScene.readScopes?.find((scope) => scope.prefix === "plot")?.revision, createLocation.readScopes?.find((scope) => scope.prefix === "plot")?.revision);
  const stateCoreOperation = coreProposal.operations.find((operation) => operation.id === data.operationMap["append-state"]);
  assert.ok(stateCoreOperation?.reads.some((read) => read.path === STATE_PROPOSALS_PATH && read.revision === revision(stateProposalContent)));
  assert.equal(coreProposal.operations[0]?.writes[0]?.path, "bible/locations/loc-new.yaml");
  assert.equal(files.get("bible/locations/loc-new.yaml"), undefined, "proposal conversion does not write to the snapshot");
  assert.equal(proposals.length, 1);
});

test("state.append-event rejects stale or mismatched source proposals", async () => {
  const manuscriptHash = cafeManuscriptHash;
  const row = {
    id: "proposal-arrival",
    scene_id: "sc-1",
    event_json: JSON.stringify({ sceneId: "sc-1", order: 1, kind: "location", subject: "char-uma", object: "loc-cafe", payload: {}, source: "llm-draft", eventId: "draft-arrival", status: "proposed" }),
    manuscript_hash: manuscriptHash,
    status: "proposed",
    conflict_event_ids_json: "[]",
    duplicate_of_proposal_id: null,
    history_json: "[]",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  };
  const submit = async (label: string, proposalRow: (Omit<typeof row, "duplicate_of_proposal_id"> & { duplicate_of_proposal_id: string | null }) | null, operationHash = manuscriptHash) => {
    const files = fixtureFiles({
      [STATE_PROPOSALS_PATH]: proposalRow ? `${JSON.stringify(proposalRow)}\n` : "",
    });
    const reader = makeReader(files);
    const context = makeActionContext(reader);
    context.invoke = async () => ({
      ok: false,
      snapshot: reader.snapshot,
      error: { code: "PROPOSAL_NOT_FOUND", message: "missing", retryable: false },
    });
    const scene = (await invoke<{ revision: string }>("story.entities.get", { id: "sc-1" }, context)).data;
    const changeSet = {
      schemaVersion: 1,
      id: `ncs-state-${label}`,
      projectId: context.projectId,
      goal: "Append a proposed state event",
      status: "proposed",
      assessment: { confidence: 0.9, risk: "medium" },
      operations: [{
        id: "append-state",
        kind: "state.append-event",
        precondition: { kind: "revision", value: scene.revision },
        target: { sceneId: "sc-1", eventId: "event-arrival" },
        event: { sceneId: "sc-1", order: 1, kind: "location", subject: "char-uma", object: "loc-cafe", payload: {}, source: "manual", eventId: "event-arrival", status: "confirmed" },
        sourceProposal: { id: row.id, manuscriptHash: operationHash },
        evidenceIds: [],
        assessment: { confidence: 0.9, risk: "medium" },
      }],
      evidence: [],
      diagnostics: { before: null, after: null },
    };
    const result = await actionById("story.changes.propose").invoke(changeSet, context);
    assert.equal(result.ok, false, `${label} should not be proposed`);
    if (!result.ok) assert.equal(result.error.code, "operation_precondition_conflict", label);
  };

  await submit("missing", null);
  await submit("status", { ...row, status: "stale" });
  await submit("conflicts", { ...row, conflict_event_ids_json: '["old-event"]' });
  await submit("duplicate", { ...row, duplicate_of_proposal_id: "proposal-other" });
  await submit("event", { ...row, event_json: JSON.stringify({ sceneId: "sc-1", order: 1, kind: "location", subject: "char-uma", object: "loc-cafe", payload: { reason: "changed" }, source: "llm-draft", status: "proposed" }) });
  await submit("manuscript", { ...row, manuscript_hash: "deadbeef" }, "deadbeef");
});

test("co-occurrence action projects the selected scene scope", async () => {
  const files = fixtureFiles({
    "bible/characters/char-two/profile.yaml": yaml({ id: "char-two", name: "Two", type: "character" }),
    "plot/volumes/vol-main/chapters/ch-main-1/scenes/sc-1.yaml": yaml({ id: "sc-1", title: "Door", type: "scene", volume: "vol-main", chapter: "ch-main-1", order: 1, location: "loc-cafe", appears: ["char-uma", "char-two"], manuscript: "manuscript/vol-main/ch-main-1/sc-1.md" }),
    "plot/volumes/vol-main/chapters/ch-main-1/scenes/sc-2.yaml": yaml({ id: "sc-2", title: "Table", type: "scene", volume: "vol-main", chapter: "ch-main-1", order: 2, appears: ["char-uma", "char-two"], manuscript: "manuscript/vol-main/ch-main-1/sc-2.md" }),
  });
  const context = makeActionContext(makeReader(files));
  const all = await invoke<{ edges: Array<{ a: string; b: string; sceneCount: number; jaccard: number; pmi: number }>; gaps: unknown[] }>("story.cooccurrence", {}, context);
  assert.deepEqual(all.data.edges.map(({ a, b, sceneCount }) => [a, b, sceneCount]), [["char-two", "char-uma", 2]]);
  const scoped = await invoke<typeof all.data>("story.cooccurrence", { sceneIds: ["sc-1"] }, context);
  assert.equal(scoped.data.edges[0]?.sceneCount, 1);
  assert.equal(scoped.data.edges[0]?.jaccard, 1);
  const invalid = await actionById("story.cooccurrence").invoke({ sceneIds: "sc-1" }, context);
  assert.equal(invalid.ok, false);
});

test("reader model action derives chapter disclosures and knowledge checks from the selected snapshot", async () => {
  const context = makeActionContext(makeReader(fixtureFiles()));
  const result = await invoke<{
    chapterId: string;
    disclosures: Array<{ entityId: string; sceneId: string; evidence: string }>;
    knowledgeGaps: Array<{ kind: string }>;
    forgetRisks: Array<{ threadId: string; forgetRisk: number }>;
    firstReadReaction: null;
  }>("story.reader-model.build", { chapterId: "ch-main-1" }, context);
  assert.equal(result.data.chapterId, "ch-main-1");
  assert.ok(result.data.disclosures.some((item) => item.entityId === "char-uma" && item.sceneId === "sc-1" && item.evidence === "Uma"));
  assert.ok(Array.isArray(result.data.knowledgeGaps));
  assert.ok(Array.isArray(result.data.forgetRisks));
  assert.equal(result.data.firstReadReaction, null, "the local Story action does not invoke an optional external assistant");
});

test("NarrativeChangeSet retries return the stored proposal and reject changed source meaning", async () => {
  const reader = makeReader(fixtureFiles());
  const proposals: Array<{ id: string; operations: ChangeOperation[] }> = [];
  const context = makeActionContext(reader, { proposals });
  let stored: ChangeProposal | undefined;
  context.invoke = async (actionId) => {
    if (actionId !== "core.proposals.get") return { ok: false, snapshot: reader.snapshot, error: { code: "missing_action", message: "not wired", retryable: false } };
    return stored
      ? { ok: true, snapshot: reader.snapshot, data: { proposal: { proposal: stored } } }
      : { ok: false, snapshot: reader.snapshot, error: { code: "PROPOSAL_NOT_FOUND", message: "missing", retryable: false } };
  };
  const current = (await invoke<{ revision: string }>("story.entities.get", { id: "char-uma" }, context)).data;
  const changeSet = {
    schemaVersion: 1, id: "ncs-retry-1", projectId: context.projectId, goal: "Update a name", status: "proposed",
    assessment: { confidence: 0.8, risk: "low" },
    operations: [{ id: "update-uma", kind: "entity.update", precondition: { kind: "revision", value: current.revision }, target: { entityId: "char-uma" }, changes: { name: "Uma Retry" }, evidenceIds: [], assessment: { confidence: 0.8, risk: "low" } }],
    evidence: [], diagnostics: { before: null, after: null },
  };
  const first = await actionById("story.changes.propose").invoke(changeSet, context);
  assert.equal(first.ok, true);
  if (!first.ok) return;
  stored = first.proposals![0];
  const { schemaVersion, assessment, ...remaining } = changeSet;
  const reordered = {
    ...remaining,
    schemaVersion,
    assessment: { risk: assessment.risk, confidence: assessment.confidence },
  };
  assert.notEqual(JSON.stringify(reordered), JSON.stringify(changeSet), "the retry represents the same source with different JSON member order");
  const retry = await actionById("story.changes.propose").invoke(reordered, context);
  assert.equal(retry.ok, true, retry.ok ? undefined : retry.error.message);
  if (retry.ok) {
    assert.equal(retry.proposals?.[0]?.id, changeSet.id);
    assert.equal((retry.data as { replayed: boolean }).replayed, true);
  }

  const changed = await actionById("story.changes.propose").invoke({
    ...changeSet,
    operations: [{ ...changeSet.operations[0], changes: { name: "A different name" } }],
  }, context);
  assert.equal(changed.ok, false);
  if (!changed.ok) assert.equal(changed.error.code, "change_set_identity_conflict");
  assert.equal(proposals.length, 1, "an exact retry does not reset Core approvals by proposing again");
});

test("NarrativeChangeSet refuses to reconstruct an incomplete recovered Core proposal", async () => {
  const reader = makeReader(fixtureFiles());
  const proposals: ChangeProposal[] = [];
  const context = makeActionContext(reader, { proposals });
  let recovered: unknown;
  context.invoke = async () => recovered
    ? { ok: true, snapshot: reader.snapshot, data: { proposal: recovered } }
    : { ok: false, snapshot: reader.snapshot, error: { code: "proposal_not_found", message: "missing", retryable: false } };
  const current = (await invoke<{ revision: string }>("story.entities.get", { id: "char-uma" }, context)).data;
  const changeSet = {
    schemaVersion: 1, id: "ncs-incomplete-recovery", projectId: context.projectId, goal: "Update a name", status: "proposed",
    assessment: { confidence: 0.8, risk: "low" },
    operations: [{ id: "update-uma", kind: "entity.update", precondition: { kind: "revision", value: current.revision }, target: { entityId: "char-uma" }, changes: { name: "Uma Recovery" }, evidenceIds: [], assessment: { confidence: 0.8, risk: "low" } }],
    evidence: [], diagnostics: { before: null, after: null },
  };
  const first = await actionById("story.changes.propose").invoke(changeSet, context);
  assert.equal(first.ok, true, first.ok ? undefined : first.error.message);
  if (!first.ok) return;
  const fullProposal = first.proposals![0]!;
  recovered = {
    proposal: { ...fullProposal, evidence: undefined },
    payloadComplete: false,
    operationIds: fullProposal.operations.map((operation) => operation.id),
  };
  const retry = await actionById("story.changes.propose").invoke(changeSet, context);
  assert.equal(retry.ok, false);
  if (!retry.ok) assert.equal(retry.error.code, "PROPOSAL_PAYLOAD_UNAVAILABLE");
  assert.equal(proposals.length, 1, "Story does not fabricate a full source proposal from Core's accepted subset");
});

test("NarrativeChangeSet preserves unrestricted source IDs and maps unsafe IDs to Core-safe proposal IDs", async () => {
  const reader = makeReader(fixtureFiles());
  const proposals: ChangeProposal[] = [];
  const context = makeActionContext(reader, { proposals });
  let stored: ChangeProposal | undefined;
  context.invoke = async (actionId, input) => {
    assert.equal(actionId, "core.proposals.get");
    if (stored) assert.equal((input as { proposalId: string }).proposalId, stored.id);
    return stored
      ? { ok: true, snapshot: reader.snapshot, data: { proposal: { proposal: stored } } }
      : { ok: false, snapshot: reader.snapshot, error: { code: "proposal_not_found", message: "missing", retryable: false } };
  };
  const current = (await invoke<{ revision: string }>("story.entities.get", { id: "char-uma" }, context)).data;
  const sourceId = `legacy source / ${"作家".repeat(30)}`;
  const changeSet = {
    schemaVersion: 1, id: sourceId, projectId: context.projectId, goal: "Update a name", status: "proposed",
    assessment: { confidence: 0.8, risk: "low" },
    operations: [{ id: "update-uma-legacy", kind: "entity.update", precondition: { kind: "revision", value: current.revision }, target: { entityId: "char-uma" }, changes: { name: "Uma Legacy" }, evidenceIds: [], assessment: { confidence: 0.8, risk: "low" } }],
    evidence: [], diagnostics: { before: null, after: null },
  };
  const first = await actionById("story.changes.propose").invoke(changeSet, context);
  assert.equal(first.ok, true, first.ok ? undefined : first.error.message);
  if (!first.ok) return;
  const data = first.data as { changeSetId: string; proposalId: string; coreProposalId: string; replayed: boolean };
  assert.equal(data.changeSetId, sourceId);
  assert.equal(data.coreProposalId, data.proposalId);
  assert.match(data.coreProposalId, /^story-cs-[a-f0-9]{64}$/);
  assert.ok(data.coreProposalId.length <= 128);
  assert.equal(first.proposals?.[0]?.id, data.coreProposalId);
  stored = first.proposals?.[0];
  assert.ok(stored);
  const sourceEvidence = stored.evidence?.find((item) => item.kind === "source.narrative-change-set.v1");
  assert.equal((sourceEvidence?.details as { coreProposalId?: string }).coreProposalId, data.coreProposalId);
  assert.equal(((sourceEvidence?.details as { sourceChangeSet?: { id?: string } }).sourceChangeSet)?.id, sourceId);
  const originalRevision = ((sourceEvidence?.details as { resultRevisions?: Record<string, string> }).resultRevisions)?.["update-uma-legacy"];
  assert.equal(typeof originalRevision, "string");

  const changedSnapshotFiles = fixtureFiles();
  changedSnapshotFiles.set("bible/characters/char-uma/profile.yaml", yaml({ id: "char-uma", name: "A newer remote name", type: "character", aliases: ["U"], tags: ["lead"], notes: { daily: ["Keep the promise"] }, relations: [] }));
  const newerReader: SnapshotReader = {
    ...makeReader(changedSnapshotFiles, "repo-work"),
    snapshot: { ...reader.snapshot, projectVersion: reader.snapshot.projectVersion + 1 },
  };
  const newerContext = makeActionContext(newerReader);
  newerContext.invoke = context.invoke;
  const replay = await actionById("story.changes.propose").invoke(changeSet, newerContext);
  assert.equal(replay.ok, true, replay.ok ? undefined : replay.error.message);
  if (replay.ok) {
    assert.equal((replay.data as { replayed: boolean }).replayed, true);
    assert.equal((replay.data as { changeSetId: string }).changeSetId, sourceId);
    assert.equal((replay.data as { coreProposalId: string }).coreProposalId, data.coreProposalId);
    assert.equal((replay.data as { resultRevisions: Record<string, string> }).resultRevisions["update-uma-legacy"], originalRevision, "replay returns persisted source results even if current snapshot has advanced");
  }
  const changed = await actionById("story.changes.propose").invoke({ ...changeSet, goal: "A different goal" }, newerContext);
  assert.equal(changed.ok, false);
  if (!changed.ok) assert.equal(changed.error.code, "change_set_identity_conflict");
  assert.equal(proposals.length, 1);
});


test("temporal context respects explicit world days, competing facts, reader scope and hypothetical isolation", async () => {
  const scenePath = (id: string) => `plot/volumes/vol-main/chapters/ch-main-1/scenes/${id}.yaml`;
  const scene = (id: string, order: number, day: number | null, events: unknown[]) => yaml({
    id, type: "scene", chapter: "ch-main-1", volume: "vol-main", order,
    ...(day === null ? {} : { world_time: { earliest: day, latest: day } }),
    appears: ["char-uma"], state_events: events, manuscript: `manuscript/vol-main/ch-main-1/${id}.md`,
  });
  const fact = (sceneId: string, value: string, eventId: string, extra: Record<string, unknown> = {}) => ({
    sceneId, order: 99, kind: "attribute", subject: "char-uma", object: null,
    payload: { predicate: "rank", value }, eventId, status: "confirmed", ...extra,
  });
  const files = fixtureFiles({
    [scenePath("sc-1")]: scene("sc-1", 1, 10, [fact("sc-1", "Captain", "rank-captain"),
      { sceneId: "sc-1", kind: "knowledge", subject: "char-uma", object: "loc-cafe", payload: { layer: "reader-knowledge" }, status: "confirmed" }]),
    [scenePath("sc-2")]: scene("sc-2", 2, 1, [fact("sc-2", "Recruit", "rank-recruit"),
      fact("sc-2", "Secret", "rank-draft", { source: "llm-draft", status: "proposed" })]),
    [scenePath("sc-3")]: scene("sc-3", 3, 10, [fact("sc-3", "Major", "rank-major")]),
    [scenePath("sc-4")]: scene("sc-4", 4, null, [fact("sc-4", "Lieutenant", "rank-lieutenant")]),
    "manuscript/vol-main/ch-main-1/sc-2.md": "Uma reads an unrevealed secret.",
    "manuscript/vol-main/ch-main-1/sc-3.md": "Uma later sees a secret.",
  });
  const reader = makeReader(files);
  const proposals: Array<{ id: string; operations: ChangeOperation[] }> = [];
  const context = makeActionContext(reader, { proposals });
  type Projection = { worldTime: { earliest: number; latest: number } | null; narrativeOrder: number;
    state: Array<{ subject: string; predicate: string; status: string; facts: Array<{ value: string; sceneId: string; evidence: { path: string; revision: string } }> }>;
    candidates: unknown[]; beliefs: unknown[]; disclosed: unknown[] };
  const flashback = await invoke<Projection>("story.world-state.temporal", { sceneId: "sc-2" }, context);
  assert.deepEqual(flashback.snapshot, reader.snapshot);
  assert.equal(flashback.data.narrativeOrder, 2);
  assert.deepEqual(flashback.data.worldTime, { earliest: 1, latest: 1 });
  assert.equal(flashback.data.state.find(cell => cell.predicate === "rank")?.facts[0]?.value, "Recruit");
  assert.equal(flashback.data.candidates.length > 0, true);
  assert.equal(flashback.data.beliefs.length, 0);
  assert.equal(flashback.data.disclosed.length, 1, "reader order differs from world time");
  assert.equal(flashback.data.state[0]?.facts[0]?.evidence.revision, revision(files.get(scenePath("sc-2"))!));
  const conflict = await invoke<Projection>("story.world-state.temporal", { sceneId: "sc-3" }, context);
  assert.equal(conflict.data.state.find(cell => cell.predicate === "rank")?.status, "conflict");
  const unknown = await invoke<Projection>("story.world-state.temporal", { sceneId: "sc-4" }, context);
  assert.equal(unknown.data.worldTime, null);
  assert.equal(unknown.data.state.find(cell => cell.predicate === "rank")?.status, "unknown");
  const limited = await invoke<{ parts: unknown[] }>("story.context.package", { sceneId: "sc-2", scope: "character", characterId: "char-uma" }, context);
  assert.deepEqual(limited.data.parts, []);
  const readerContext = await invoke<{ parts: unknown[] }>("story.context.package", { sceneId: "sc-2", scope: "reader" }, context);
  assert.equal(readerContext.data.parts.length, 1);
  assert.doesNotMatch(JSON.stringify(readerContext.data), /Captain|Recruit|unrevealed secret/);
  const scenario = await invoke<{ baseline: Projection; alternatives: Array<{ projection: Projection }>; sourceFingerprint: string }>("story.scenario.compare", {
    sceneId: "sc-4",
    alternatives: ["General", "Civilian"].map(label => ({ label, events: [{ kind: "attribute", subject: "char-uma", object: null, payload: { predicate: "rank", value: label }, ...(label === "General" ? { eventId: "rank-general", replacesEventId: "rank-lieutenant" } : {}) }] })),
  }, context);
  assert.match(JSON.stringify(scenario.data.alternatives[0]), /General/);
  assert.deepEqual(scenario.data.alternatives[0]!.projection.state.find(cell => cell.predicate === "rank")?.facts.map(fact => fact.value), ["General"], "replacement hypothesis should remove the event it replaces");
  assert.doesNotMatch(JSON.stringify(scenario.data.alternatives[0]), /Civilian/);
  assert.match(JSON.stringify(scenario.data.alternatives[1]), /Civilian/);
  assert.deepEqual(scenario.data.baseline, unknown.data);
  assert.deepEqual((await invoke<Projection>("story.world-state.temporal", { sceneId: "sc-4" }, context)).data, unknown.data);
  const invalidReplacement = await actionById("story.scenario.compare").invoke({ sceneId: "sc-4", alternatives: [
    { label: "Invalid", events: [{ kind: "attribute", subject: "char-uma", object: null, payload: { predicate: "rank", value: "Marshal" }, replacesEventId: "missing-event" }] },
    { label: "Other", events: [] },
  ] }, context);
  assert.equal(invalidReplacement.ok, false, "replacement must identify a confirmed canonical event");
  const unconfirmedReplacement = await actionById("story.scenario.compare").invoke({ sceneId: "sc-4", alternatives: [
    { label: "Invalid", events: [{ kind: "attribute", subject: "char-uma", object: null, payload: { predicate: "rank", value: "Marshal" }, replacesEventId: "rank-draft" }] },
    { label: "Other", events: [] },
  ] }, context);
  assert.equal(unconfirmedReplacement.ok, false, "replacement cannot target an unconfirmed canonical event");
  const event = { kind: "attribute", subject: "char-uma", object: null, payload: { predicate: "rank", value: "Marshal" } };
  for (const events of [
    [{ ...event, eventId: "rank-lieutenant", replacesEventId: "rank-lieutenant" }],
    [{ ...event, eventId: "rank-recruit" }],
    [{ ...event, eventId: "new-event", replacesEventId: "new-event" }],
    [{ ...event, eventId: "new-event" }, { ...event, eventId: "new-event" }],
  ]) {
    const alternatives = [{ label: "Invalid", events }, { label: "Other", events: [] }];
    const comparison = await actionById("story.scenario.compare").invoke({ sceneId: "sc-4", alternatives }, context);
    assert.equal(comparison.ok, false, "colliding event identities must be rejected during comparison");
    const save = await actionById("story.scenario.save").invoke({ sceneId: "sc-4", alternatives, label: "Invalid", sourceFingerprint: scenario.data.sourceFingerprint }, context);
    assert.equal(save.ok, false, "colliding event identities must be rejected during save");
    files.set("meta/scriptorium/modules/story/v1/scenarios.json", JSON.stringify([{ id: "invalid-saved", label: "Invalid", sceneId: "sc-4", alternatives, sourceFingerprint: scenario.data.sourceFingerprint }]));
    const adoption = await actionById("story.scenario.adopt").invoke({ id: "invalid-saved", alternativeIndex: 0, sourceFingerprint: scenario.data.sourceFingerprint }, context);
    assert.equal(adoption.ok, false, "previously saved invalid identities must be rejected during adoption");
    files.delete("meta/scriptorium/modules/story/v1/scenarios.json");
  }
  const syntheticCollision = await invoke("story.scenario.compare", { sceneId: "sc-4", alternatives: [
    { label: "Two facts", events: [{ ...event }, { ...event, eventId: "hypothesis-0-0", payload: { predicate: "rank", value: "Colonel" } }] },
    { label: "Other", events: [] },
  ] }, context);
  assert.match(JSON.stringify(syntheticCollision.data), /"eventId":"hypothesis-0-0-next"/);
  assert.match(JSON.stringify(syntheticCollision.data), /"eventId":"hypothesis-0-0"/);
  assert.equal(proposals.length, 0, "compare and invalid hypotheses do not write canonical state");
  const staleSave = await actionById("story.scenario.save").invoke({ sceneId: "sc-4", label: "Stale", alternatives: [
    { label: "A", events: [] }, { label: "B", events: [] },
  ], sourceFingerprint: "stale-fingerprint" }, context);
  assert.equal(staleSave.ok, false);
  if (!staleSave.ok) assert.equal(staleSave.error.code, "stale_source");
  assert.equal(proposals.length, 0, "stale scenarios do not create saved rows");
  const saved = await invoke<{ id: string }>("story.scenario.save", {
    id: "scenario-replacement", sceneId: "sc-4", label: "Replacement", alternatives: [
      { label: "General", events: [{ kind: "attribute", subject: "char-uma", object: null, payload: { predicate: "rank", value: "General" }, eventId: "rank-general", replacesEventId: "rank-lieutenant" }] },
      { label: "Civilian", events: [{ kind: "attribute", subject: "char-uma", object: null, payload: { predicate: "rank", value: "Civilian" } }] },
    ], sourceFingerprint: scenario.data.sourceFingerprint,
  }, context);
  files.set("meta/scriptorium/modules/story/v1/scenarios.json", proposals.at(-1)!.operations[0]!.writes[0]!.content!);
  const staleAdoption = await actionById("story.scenario.adopt").invoke({
    id: saved.data.id, alternativeIndex: 0, sourceFingerprint: "stale-fingerprint",
  }, context);
  assert.equal(staleAdoption.ok, false);
  if (!staleAdoption.ok) assert.equal(staleAdoption.error.code, "stale_source");
  const adopted = await invoke<{ proposals: Array<{ id: string; event: Record<string, unknown> }> }>("story.scenario.adopt", {
    id: saved.data.id, alternativeIndex: 0, sourceFingerprint: scenario.data.sourceFingerprint,
  }, context);
  assert.equal(adopted.data.proposals[0]!.event.replacesEventId, "rank-lieutenant");
  assert.equal(adopted.data.proposals[0]!.event.eventId, "rank-general");
  assert.match(JSON.stringify(scenario.data.alternatives[0]), /"eventId":"rank-general"/);
  assert.equal(adopted.data.proposals[0]!.event.status, "proposed", "adoption submits an author review proposal without confirming canonical state");
  const adoptedRow = JSON.parse(proposals.at(-1)!.operations[0]!.writes.find(write => write.path === STATE_PROPOSALS_PATH)!.content!.trim().split("\n").at(-1)!) as { event_json: string; status: string };
  const adoptedEvent = JSON.parse(adoptedRow.event_json) as Record<string, unknown>;
  assert.equal(adoptedEvent.replacesEventId, "rank-lieutenant");
  assert.equal(adoptedRow.status, "proposed");
  files.set(STATE_PROPOSALS_PATH, proposals.at(-1)!.operations[0]!.writes.find(write => write.path === STATE_PROPOSALS_PATH)!.content!);
  const duplicateAdoption = await actionById("story.scenario.adopt").invoke({
    id: saved.data.id, alternativeIndex: 0, sourceFingerprint: scenario.data.sourceFingerprint,
  }, context);
  assert.equal(duplicateAdoption.ok, false, "pending identity must not be adopted twice");
  const otherScene = files.get(scenePath("sc-2"))!;
  files.set(scenePath("sc-2"), scene("sc-2", 2, 1, [fact("sc-2", "General", "rank-general")]));
  const collidedApproval = await actionById("story.state-proposals.approve").invoke({ id: adopted.data.proposals[0]!.id }, context);
  assert.equal(collidedApproval.ok, false, "a canonical event added after adoption must prevent duplicate approval");
  files.set(scenePath("sc-2"), otherScene);
  const approved = await invoke("story.state-proposals.approve", { id: adopted.data.proposals[0]!.id }, context);
  const approvalOperation = proposals.at(-1)!.operations[0]!;
  for (const write of approvalOperation.writes) files.set(write.path, write.content!);
  const applied = await invoke<Projection>("story.world-state.temporal", { sceneId: "sc-4" }, context);
  const semanticState = (projection: Projection) => projection.state.map(cell => ({
    subject: cell.subject,
    predicate: cell.predicate,
    status: cell.status,
    facts: cell.facts.map(fact => [fact.sceneId, fact.value]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
  })).sort((a, b) => `${a.subject}:${a.predicate}`.localeCompare(`${b.subject}:${b.predicate}`));
  assert.ok(approved.ok);
  assert.deepEqual(semanticState(applied.data), semanticState(scenario.data.alternatives[0]!.projection),
    "author-approved adoption must produce the same semantic temporal state as its comparison hypothesis");
  assert.equal((await actionById("story.context.package").invoke({sceneId:"sc-2", scope:"character", characterId:"missing"}, context)).ok, false);
});

test("direct-root scenes receive Story positions and keep their saved author context", async () => {
  const scenePath = "plot/volumes/root/chapters/root/scenes/root-scene.yaml";
  const manuscriptPath = "manuscript/root/root-scene.md";
  const files = new Map([
    ["bible/characters/char-uma/profile.yaml", yaml({ id: "char-uma", name: "Uma", type: "character" })],
    [scenePath, yaml({ id: "root-scene", title: "First root scene", type: "scene", order: "0001", manuscript: manuscriptPath })],
    [manuscriptPath, "Saved root scene body.\n"],
  ]);
  const reader = makeReader(files, "repo-root-scenes");
  const context = makeActionContext(reader);

  const temporal = await invoke<{ narrativeOrder: number; worldTime: unknown; source: { path: string; revision: string | null } }>(
    "story.world-state.temporal", { sceneId: "root-scene" }, context,
  );
  assert.deepEqual(temporal.snapshot, reader.snapshot);
  assert.equal(temporal.data.narrativeOrder, 1);
  assert.equal(temporal.data.worldTime, null);
  assert.deepEqual(temporal.data.source, { sceneId: "root-scene", path: scenePath, revision: revision(files.get(scenePath)!) });

  const author = await invoke<{ parts: Array<{ kind: string; value: { path?: string; revision?: string; text?: string } }> }>(
    "story.context.package", { sceneId: "root-scene", scope: "author", budget: 200_000 }, context,
  );
  const manuscript = author.data.parts.find((part) => part.kind === "manuscript");
  assert.deepEqual(manuscript?.value, {
    path: manuscriptPath,
    revision: revision(files.get(manuscriptPath)!),
    text: "Saved root scene body.\n",
  });
});

test("direct-root positions interleave with volume scenes without widening reader or character context", async () => {
  const rootScenePath = (id: string) => `plot/volumes/root/chapters/root/scenes/${id}.yaml`;
  const scene = (id: string, order: string, state_events: unknown[] = [], manuscript?: string) => yaml({
    id, title: id, type: "scene", order, state_events, ...(manuscript ? { manuscript } : {}),
  });
  const readerDisclosure = (sceneId: string, eventId: string, value: string) => ({
    sceneId, eventId, kind: "knowledge", subject: "char-uma", object: value,
    payload: { layer: "reader-knowledge" }, status: "confirmed",
  });
  const characterBelief = (sceneId: string, eventId: string, subject: string) => ({
    sceneId, eventId, kind: "attribute", subject, object: "secret-id",
    payload: { layer: "character-belief", predicate: "knows" }, status: "confirmed",
  });
  const manuscriptPath = "manuscript/root/target.md";
  const files = new Map([
    ["bible/characters/char-uma/profile.yaml", yaml({ id: "char-uma", name: "Uma", type: "character" })],
    ["bible/characters/char-other/profile.yaml", yaml({ id: "char-other", name: "Other", type: "character" })],
    [rootScenePath("root-first"), scene("root-first", "0001", [readerDisclosure("root-first", "reader-root", "root-secret")])],
    ["plot/volumes/vol-main/volume.yaml", yaml({ id: "vol-main", title: "Main", type: "volume", order: "0002" })],
    ["plot/volumes/vol-main/chapters/ch-main/chapter.yaml", yaml({ id: "ch-main", title: "Chapter", type: "chapter", volume: "vol-main", order: "0001" })],
    ["plot/volumes/vol-main/chapters/ch-main/scenes/nested.yaml", yaml({
      id: "nested-scene", title: "Nested scene", type: "scene", volume: "vol-main", chapter: "ch-main", order: "0001",
      state_events: [readerDisclosure("nested-scene", "reader-nested", "nested-secret")],
    })],
    [rootScenePath("root-target"), scene("root-target", "0003", [
      characterBelief("root-target", "belief-uma", "char-uma"),
      characterBelief("root-target", "belief-other", "char-other"),
    ], manuscriptPath)],
    [rootScenePath("root-later"), scene("root-later", "0004", [readerDisclosure("root-later", "reader-later", "future-secret")])],
    [manuscriptPath, "Fixed mixed-hierarchy body.\n"],
  ]);
  const reader = makeReader(files, "repo-mixed-root-scenes");
  const context = makeActionContext(reader);

  const temporal = await invoke<{ narrativeOrder: number; worldTime: unknown; source: { revision: string | null }; disclosed: Array<{ eventId?: string }> }>(
    "story.world-state.temporal", { sceneId: "root-target" }, context,
  );
  assert.equal(temporal.data.narrativeOrder, 3, "root sibling order must interleave with volume/chapter scenes");
  assert.equal(temporal.data.worldTime, null);
  assert.deepEqual(temporal.data.disclosed.map((fact) => fact.eventId), ["reader-root", "reader-nested"]);
  assert.equal(temporal.data.source.revision, revision(files.get(rootScenePath("root-target"))!));

  const readerView = await invoke<{ parts: Array<{ kind: string; value: { eventId?: string } }> }>(
    "story.context.package", { sceneId: "root-target", scope: "reader", budget: 200_000 }, context,
  );
  assert.deepEqual(readerView.data.parts.map((part) => [part.kind, part.value.eventId]), [
    ["reader-disclosure", "reader-root"], ["reader-disclosure", "reader-nested"],
  ]);
  assert.doesNotMatch(JSON.stringify(readerView.data), /future-secret|Fixed mixed-hierarchy body|secret-id/);

  const characterView = await invoke<{ parts: Array<{ kind: string; value: { eventId?: string } }> }>(
    "story.context.package", { sceneId: "root-target", scope: "character", characterId: "char-uma", budget: 200_000 }, context,
  );
  assert.deepEqual(characterView.data.parts.map((part) => [part.kind, part.value.eventId]), [["character-belief", "belief-uma"]]);
  assert.doesNotMatch(JSON.stringify(characterView.data), /belief-other|reader-root|reader-nested|Fixed mixed-hierarchy body/);
});

test("world time metadata changes remain proposals and invalid ranges fail", async () => {
  const reader = makeReader(fixtureFiles());
  const proposals: Array<{ id: string; operations: ChangeOperation[] }> = [];
  const context = makeActionContext(reader, { proposals });
  const bad = await actionById("story.scene.metadata.update").invoke({ sceneId: "sc-1", patch: { world_time: { earliest: 3, latest: 1 } } }, context);
  assert.equal(bad.ok, false);
  assert.equal(proposals.length, 0);
  await invoke("story.scene.metadata.update", { sceneId: "sc-1", patch: { world_time: { earliest: -3, latest: 0 } } }, context);
  assert.equal(proposals.length, 1);
  assert.equal((await invoke<{ worldTime: unknown }>("story.world-state.temporal", { sceneId: "sc-1" }, context)).data.worldTime, null);
});

function knowledgeEntry(id: string, values: Partial<KnowledgeProjectionEntry> = {}): KnowledgeProjectionEntry {
  return {
    node: { id, name: "Uma", type: "character", status: "confirmed", attributes: {}, deletedAt: null },
    aliases: [], relations: [], evidence: [], aliasLimitReached: false, relationLimitReached: false, evidenceLimitReached: false,
    ...values,
  };
}

function knowledgeEvidence(values: Partial<KnowledgeProjectionEvidence> = {}): KnowledgeProjectionEvidence {
  return {
    anchor: { id: "evidence-1", documentId: "doc", revisionId: "revision-1", status: "confirmed" },
    mention: { status: "confirmed" }, current: true, storySceneId: null, quote: null, assertions: [], assertionLimitReached: false,
    ...values,
  };
}

function withKnowledge(reader: SnapshotReader, entries: KnowledgeProjectionData["entries"], extras: Partial<KnowledgeProjectionData> = {}): SnapshotReader {
  return {
    ...reader,
    knowledge: { source: { kind: "knowledge-projection", snapshot: reader.snapshot, revision: "1".repeat(64) }, entries, documentMappings: [], nodeLimitReached: false, ...extras },
  };
}

test("native Knowledge uses explicit ID, preserves scope, and refuses another project or snapshot", async () => {
  const node = (id: string, attributes: Record<string, unknown>, status = "confirmed") => ({ id, name: "Uma", type: "character", status, attributes, deletedAt: null });
  const files = fixtureFiles({
    "bible/characters/char-other/profile.yaml": yaml({ id: "char-other", name: "Uma", type: "character" }),
  });
  const reader = withKnowledge(makeReader(files), [
    knowledgeEntry("explicit", { node: node("explicit", { storyEntityId: "char-uma" }) }),
    knowledgeEntry("same-name"),
    knowledgeEntry("candidate", { node: node("candidate", { storyEntityId: "char-uma" }, "proposed") }),
    knowledgeEntry("wrong-scene", { evidence: [knowledgeEvidence({ current: false })] }),
  ]);
  const context = makeActionContext(reader);
  const author = await invoke<{ parts: Array<{ kind: string; value: unknown }> }>("story.context.package", { sceneId: "sc-1", scope: "author", budget: 200000 }, context);
  const knowledge = author.data.parts.filter(part => part.kind === "native-knowledge");
  assert.equal(knowledge.length, 2);
  assert.match(JSON.stringify(knowledge), /"knowledgeId":"explicit"/u);
  assert.match(JSON.stringify(knowledge), /"knowledgeId":"candidate","name":"Uma","type":"character","status":"candidate"/u);
  assert.doesNotMatch(JSON.stringify(knowledge), /same-name|wrong-scene/u);
  for (const scope of ["reader", "character"]) {
    const result = await invoke<{ parts: Array<{ kind: string }> }>("story.context.package", { sceneId: "sc-1", scope, characterId: "char-uma" }, context);
    assert.equal(result.data.parts.some(part => part.kind === "native-knowledge"), false);
  }
  for (const snapshot of [{ ...reader.snapshot, projectId: "another-project" }, { ...reader.snapshot, projectVersion: reader.snapshot.projectVersion + 1 }]) {
    const result = await actionById("story.knowledge.links").invoke({}, makeActionContext({ ...reader, snapshot }));
    assert.equal(result.ok, false);
  }
  const unavailable = await actionById("story.knowledge.links").invoke({}, makeActionContext(makeReader(files)));
  assert.equal(unavailable.ok, false);
  assert.equal(unavailable.error.code, "snapshot_unavailable");
});

test("Story context is a snapshot-bound action with no Assistant/provider dependency", async () => {
  const reader = makeReader(fixtureFiles());
  const context = makeActionContext(reader);
  let delegated = 0;
  context.invoke = async () => {
    delegated++;
    return { ok: false, snapshot: reader.snapshot, error: { code: "missing_action", message: "not wired", retryable: false } };
  };
  const storyActions = createStoryActions(makeModuleContext());
  assert.ok(storyActions.some((candidate) => candidate.id === "story.context.package"));
  assert.equal(storyActions.some((candidate) => candidate.id.startsWith("assistant.")), false);

  const result = await invoke<{ sceneId: string; scope: string; parts: Array<{ kind: string }> }>(
    "story.context.package", { sceneId: "sc-1", scope: "reader" }, context,
  );
  assert.deepEqual(result.snapshot, reader.snapshot);
  assert.equal(result.data.sceneId, "sc-1");
  assert.equal(result.data.scope, "reader");
  assert.equal(delegated, 0);
});

test("author context maps thread relations to the target scene and matches the overview snapshot", async () => {
  const scenePath = "plot/volumes/vol-main/chapters/ch-main-1/scenes/sc-2.yaml";
  const threadPath = (id: string) => `plot/threads/${id}.yaml`;
  const files = fixtureFiles({
    [scenePath]: yaml({
      id: "sc-2", title: "Table", type: "scene", volume: "vol-main", chapter: "ch-main-1", order: 2,
      threads: { plants: ["thread-legacy-plant", "thread-duplicate"], advances: ["thread-legacy-advance"] },
      manuscript: "manuscript/vol-main/ch-main-1/sc-2.md",
    }),
    "plot/volumes/vol-main/chapters/ch-main-1/scenes/sc-1.yaml": yaml({
      id: "sc-1", title: "Door", type: "scene", volume: "vol-main", chapter: "ch-main-1", order: 1,
      threads: { plants: ["thread-other-scene"] },
      manuscript: "manuscript/vol-main/ch-main-1/sc-1.md",
    }),
    [threadPath("thread-canonical-plant")]: yaml({ id: "thread-canonical-plant", type: "thread", planted: ["sc-2"] }),
    [threadPath("thread-canonical-payoff")]: yaml({ id: "thread-canonical-payoff", type: "thread", payoff: ["sc-2"] }),
    [threadPath("thread-duplicate")]: yaml({ id: "thread-duplicate", type: "thread", planted: ["sc-2"] }),
    [threadPath("thread-legacy-plant")]: yaml({ id: "thread-legacy-plant", type: "thread" }),
    [threadPath("thread-legacy-advance")]: yaml({ id: "thread-legacy-advance", type: "thread" }),
    [threadPath("thread-other-scene")]: yaml({ id: "thread-other-scene", type: "thread" }),
  });
  const context = makeActionContext(makeReader(files));
  const overview = await invoke<Array<{
    thread: { id: string };
    planted: Array<{ scene: { id: string } }>;
    advanced: Array<{ scene: { id: string } }>;
    payoff: Array<{ scene: { id: string } }>;
  }>>("story.threads.overview", {}, context);
  const author = await invoke<{
    parts: Array<{ kind: string; value: Array<{ threadId: string; relation: string; meaning: string; revision: string | null }> }>;
  }>("story.context.package", { sceneId: "sc-2", scope: "author", budget: 200_000 }, context);

  assert.deepEqual(overview.snapshot, author.snapshot);
  assert.deepEqual(author.snapshot, context.reader.snapshot);
  const part = author.data.parts.find((item) => item.kind === "threads");
  assert.ok(part);
  const contextRelations = part.value.map(({ threadId, meaning }) => [threadId, meaning]).sort(([a], [b]) => a!.localeCompare(b!));
  const overviewRelations = overview.data.flatMap(({ thread, planted, advanced, payoff }) => [
    ...planted.filter((item) => item.scene.id === "sc-2").map(() => [thread.id, "planted"]),
    ...advanced.filter((item) => item.scene.id === "sc-2").map(() => [thread.id, "advanced"]),
    ...payoff.filter((item) => item.scene.id === "sc-2").map(() => [thread.id, "payoff"]),
  ]).sort(([a], [b]) => a!.localeCompare(b!));
  assert.deepEqual(contextRelations, overviewRelations);
  assert.deepEqual(contextRelations, [
    ["thread-canonical-payoff", "payoff"],
    ["thread-canonical-plant", "planted"],
    ["thread-duplicate", "planted"],
    ["thread-legacy-advance", "advanced"],
    ["thread-legacy-plant", "planted"],
  ]);

  const byThread = new Map(part.value.map((entry) => [entry.threadId, entry]));
  assert.equal(byThread.get("thread-canonical-plant")?.revision, revision(files.get(threadPath("thread-canonical-plant"))!));
  assert.equal(byThread.get("thread-canonical-payoff")?.revision, revision(files.get(threadPath("thread-canonical-payoff"))!));
  assert.equal(byThread.get("thread-legacy-plant")?.revision, revision(files.get(scenePath)!));
  assert.equal(byThread.get("thread-legacy-advance")?.revision, revision(files.get(scenePath)!));
  assert.equal(byThread.get("thread-duplicate")?.relation, "planted", "the canonical direction wins when the same relation is duplicated");
  assert.equal(byThread.has("thread-other-scene"), false, "relations from another scene must not leak into this package");

  for (const scope of ["reader", "character"]) {
    const restricted = await invoke<{ parts: Array<{ kind: string }> }>("story.context.package", {
      sceneId: "sc-2", scope, characterId: "char-uma", budget: 200_000,
    }, context);
    assert.equal(restricted.data.parts.some((item) => item.kind === "threads"), false);
    assert.doesNotMatch(JSON.stringify(restricted.data), /thread-canonical|thread-legacy|thread-duplicate/);
  }
});

test("native Knowledge uses anchor identities for scene mapping and revision evidence", async () => {
  const entry = (id: string, documentId: string) => knowledgeEntry(id, {
    evidence: [knowledgeEvidence({ current: false, storySceneId: "sc-1", anchor: { id: `evidence-${id}`, documentId, revisionId: "revision-1", status: "confirmed" } })],
  });
  const reader = withKnowledge(makeReader(fixtureFiles()), [entry("knowledge-1", "doc-uuid-1"), entry("other-document", "doc-uuid-2")], {
    documentMappings: [{ documentId: "doc-uuid-1", storySceneId: "sc-1", mapping: "explicit" }],
  });
  type ContextPart = { kind: string; value: { knowledgeId: string; source: unknown; evidence: Array<{
    storySceneId: string; sourceDocumentId: string; sourceRevisionId: string; quote: string | null; status: string;
  }> } };
  const result = await invoke<{ parts: ContextPart[] }>("story.context.package", {
    sceneId: "sc-1", scope: "author", budget: 200000,
  }, makeActionContext(reader));
  const knowledge = result.data.parts.filter(part => part.kind === "native-knowledge");
  assert.deepEqual(knowledge.map(part => part.value.knowledgeId), ["knowledge-1"]);
  assert.deepEqual(knowledge[0]!.value.source, { kind: "knowledge-projection", snapshot: reader.snapshot, revision: "1".repeat(64) });
  const evidence = knowledge[0]!.value.evidence[0]!;
  assert.equal(evidence.storySceneId, "sc-1");
  assert.equal(evidence.sourceDocumentId, "doc-uuid-1");
  assert.equal(evidence.sourceRevisionId, "revision-1");
  assert.equal(evidence.quote, null);
  assert.equal(evidence.status, "stale");
});

test("pinned Knowledge projections retain stale status and candidate evidence", async () => {
  const reader = withKnowledge(makeReader(fixtureFiles()), [knowledgeEntry("legacy", {
    node: { id: "legacy", name: "Legacy", type: "character", status: "confirmed", attributes: { storyEntityId: "char-uma" }, deletedAt: null },
    evidence: [knowledgeEvidence({ current: false }), knowledgeEvidence({ mention: { status: "proposed" } })],
  })]);
  const result = await invoke<{ parts: Array<{ kind: string; value: { evidence: Array<{ status: string; quote: string | null }> } }> }>(
    "story.context.package", { sceneId: "sc-1", scope: "author", budget: 200000 }, makeActionContext(reader),
  );
  const part = result.data.parts.find(item => item.kind === "native-knowledge");
  assert.deepEqual(part?.value.evidence.map(item => [item.status, item.quote]), [["stale", null], ["candidate", null]]);
});

test("restricted context does not expose omission details or unacquired facts", async () => {
  const reader = withKnowledge(makeReader(fixtureFiles()), [knowledgeEntry("secret-node", {
    node: { id: "secret-node", name: "Secret Alias", type: "lore", status: "confirmed", attributes: {}, deletedAt: null },
  })]);
  const result = await invoke("story.context.package", { sceneId: "sc-1", scope: "reader", budget: 128 }, makeActionContext(reader));
  assert.doesNotMatch(JSON.stringify(result.data), /secret-node|Secret Alias/u);
});

test("reader context includes explicitly disclosed Knowledge without its aliases or evidence", async () => {
  const files = fixtureFiles({
    "plot/volumes/vol-main/chapters/ch-main-1/scenes/sc-1.yaml": yaml({ id: "sc-1", title: "Door", type: "scene", volume: "vol-main", chapter: "ch-main-1", order: 1, appears: ["char-uma"], state_events: [{ sceneId: "sc-1", kind: "knowledge", subject: "char-uma", object: "native-id", payload: { layer: "reader-knowledge" }, status: "confirmed" }], manuscript: "manuscript/vol-main/ch-main-1/sc-1.md" }),
  });
  const reader = withKnowledge(makeReader(files), [knowledgeEntry("native-id", {
    node: { id: "native-id", name: "Secret Name", type: "lore", status: "confirmed", attributes: { storyEntityId: "char-uma" }, deletedAt: null },
    aliases: [{ nodeId: "native-id", surface: "Secret Alias", status: "confirmed", scope: null }],
  })]);
  const result = await invoke("story.context.package", { sceneId: "sc-1", scope: "reader" }, makeActionContext(reader));
  assert.match(JSON.stringify(result.data), /native-id/u);
  assert.doesNotMatch(JSON.stringify(result.data), /Secret Name|Secret Alias|"type":"lore"/u);
});

test("author manuscript quotes truncate on Unicode boundaries within the UTF-8 byte budget", async()=>{
  const original = "😀漢字".repeat(500);
  const files = fixtureFiles({ "manuscript/vol-main/ch-main-1/sc-1.md": original });
  const result=await invoke<{parts:Array<{kind:string;value:{text:string;truncated?:boolean}}>;used:number;budget:number;truncations:Array<{kind:string}>}>("story.context.package",{sceneId:"sc-1",scope:"author",budget:1024},makeActionContext(makeReader(files)));
  const manuscript=result.data.parts.find(part=>part.kind==="manuscript");
  assert.ok(manuscript,JSON.stringify(result.data));
  assert.equal(manuscript.value.truncated,true);
  assert.doesNotMatch(manuscript.value.text, /\p{Surrogate}/u);
  assert.ok(original.startsWith(manuscript.value.text), "the result contains an original manuscript prefix");
  const byteLength = Buffer.byteLength(JSON.stringify(result.data.parts), "utf8");
  const arrayPunctuation = result.data.parts.length + 1;
  assert.ok(byteLength - arrayPunctuation <= 1024, "the returned parts actually fit into the requested UTF-8 budget");
  assert.deepEqual(result.data.truncations.map(item=>item.kind),["manuscript"]);
});

test("large manuscript truncation preserves structured world state under the same budget", async()=>{
  const files=fixtureFiles({
    "plot/volumes/vol-main/chapters/ch-main-1/scenes/sc-1.yaml":yaml({id:"sc-1",title:"Door",type:"scene",volume:"vol-main",chapter:"ch-main-1",order:1,world_time:{earliest:1,latest:1},state_events:[{sceneId:"sc-1",kind:"attribute",subject:"char-uma",object:null,payload:{predicate:"rank",value:"Captain"},status:"confirmed"}],manuscript:"manuscript/vol-main/ch-main-1/sc-1.md"}),
    "manuscript/vol-main/ch-main-1/sc-1.md":"long manuscript ".repeat(1000)
  });
  const result=await invoke<{parts:Array<{kind:string;value:unknown}>;used:number;budget:number}>("story.context.package",{sceneId:"sc-1",scope:"author",budget:512},makeActionContext(makeReader(files)));
  assert.equal(result.data.parts.some(part=>part.kind==="objective"&&JSON.stringify(part).includes("Captain")),true);
  assert.equal(result.data.used<=result.data.budget,true);
});

test("author context reports native projection bounds without revealing them in restricted scopes", async () => {
  const reader = withKnowledge(makeReader(fixtureFiles()), [knowledgeEntry("bounded-node", {
    node: { id: "bounded-node", name: "Secret inventory", type: "character", status: "confirmed", attributes: { storyEntityId: "char-uma" }, deletedAt: null },
    evidence: [knowledgeEvidence({ assertionLimitReached: true })],
    aliasLimitReached: true, relationLimitReached: true, evidenceLimitReached: true,
  })], { nodeLimitReached: true });
  const context = makeActionContext(reader);
  const author = await invoke<{ knowledgeTruncated: boolean; omissions: Array<{ reason: string }> }>("story.context.package", { sceneId: "sc-1", scope: "author", budget: 200000 }, context);
  assert.equal(author.data.knowledgeTruncated, true);
  for (const reason of ["alias-inventory-limit", "relation-inventory-limit", "assertion-inventory-limit", "mention-inventory-limit", "node-inventory-limit"]) {
    assert.ok(author.data.omissions.some(item => item.reason === reason), reason);
  }
  for (const scope of ["reader", "character"]) {
    const result = await invoke("story.context.package", { sceneId: "sc-1", scope, characterId: "char-uma" }, context);
    assert.doesNotMatch(JSON.stringify(result.data), /knowledgeTruncated|inventory-limit|Secret inventory|bounded-node/u);
  }
});
