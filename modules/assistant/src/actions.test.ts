import assert from "node:assert/strict";
import test from "node:test";
import {
  type ActionResult,
  type BrowserEditorDocument,
  type ChangeOperation,
  type ChangeProposal,
  type KnowledgeProjectionRef,
  type ModuleActionContext,
  type SnapshotId,
} from "@codexia/contracts";
import { createAssistantActions } from "./actions.js";
import { createModule } from "./index.js";

const repository = "assistant-actions-test";
const snapshot: SnapshotId = { projectId: repository, projectVersion: 13 };
const revision = "a".repeat(64);

function reader(files: Record<string, string> = {}) {
  return {
    snapshot,
    async read(filePath: string) {
      const content = files[filePath];
      return content === undefined ? null : { content, revision };
    },
    async list(prefix: string) { return Object.keys(files).filter((filePath) => filePath.startsWith(prefix)).sort(); },
  };
}

function context(options: {
  files?: Record<string, string>;
  invoke?: (actionId: string, input: unknown) => Promise<ActionResult>;
  onPropose?: (operations: ChangeOperation[]) => void;
  onProgress?: (progress: number) => void;
} = {}): ModuleActionContext {
  const selectedReader = reader(options.files);
  const controller = new AbortController();
  return {
    projectId: "assistant-actions-test",
    reader: selectedReader,
    async invoke(actionId, input) {
      if (options.invoke) return options.invoke(actionId, input);
      return { ok: false, snapshot, error: { code: "not_available", message: `Unexpected action ${actionId}`, retryable: false } };
    },
    async listActions() { return []; },
    async linkedReader() { return selectedReader; },
    signal: controller.signal,
    async reportProgress(progress) { options.onProgress?.(progress); },
    async propose(operations, proposalEvidence, proposalId) {
      options.onPropose?.(operations);
      return {
        id: proposalId ?? "proposal-test",
        snapshot,
        operations,
        source: "module",
        ...(proposalEvidence ? { evidence: proposalEvidence } : {}),
      } satisfies ChangeProposal;
    },
    async runJob(request) {
      return { ok: false, id: request.id, snapshot, error: { code: "unused", message: "No jobs are expected", retryable: false } };
    },
  };
}

function getAction(module: ReturnType<typeof createAssistantActions>, id: string) {
  const found = module.find((item) => item.id === id);
  assert.ok(found, `missing action ${id}`);
  return found;
}



test("retired provider API, queues and model settings are absent while local review remains", async () => {
  const oldEnv = process.env.ARCADIA_LLM_PROVIDER;
  process.env.ARCADIA_LLM_PROVIDER = "openai-compatible";
  const previousFetch = globalThis.fetch;
  let outbound = 0;
  globalThis.fetch = (async () => { outbound++; throw new Error("external fetch forbidden"); }) as typeof fetch;
  try {
    const definition = await createModule();
    assert.equal(definition.manifest.locality, "local");
    assert.deepEqual(definition.http ?? [], []);
    const ids = new Set(definition.actions.map((entry) => entry.id));
    assert.ok(ids.has("assistant.rewrite"));
    assert.ok(ids.has("assistant.rewrite.propose"));
    assert.ok(ids.has("assistant.context.preview"));
    assert.ok(ids.has("assistant.context.prompt.preview"));
    assert.ok(ids.has("assistant.aspect.review"));
    assert.equal(ids.has("assistant.usage.read"), false);
    for (const retired of [
      "assistant.health", "assistant.queue.status", "assistant.settings.read",
      "assistant.settings.propose", "assistant.context.generate", "assistant.qa",
      "assistant.summary.scene", "assistant.summary.chapter", "assistant.continuation",
      "assistant.dialogue.topics", "assistant.dialogue.turns", "assistant.reader.reaction",
      "assistant.zukan.suggestions", "assistant.synonyms.suggestions",
      "assistant.contradictions.assist", "assistant.stateEvents.draft", "assistant.speaker.attribute",
    ]) assert.equal(ids.has(retired), false, retired + " must not remain callable");
    await definition.dispose();
    assert.equal(outbound, 0);
  } finally {
    globalThis.fetch = previousFetch;
    if (oldEnv === undefined) delete process.env.ARCADIA_LLM_PROVIDER;
    else process.env.ARCADIA_LLM_PROVIDER = oldEnv;
  }
});


test("local rewrite returns source-grounded candidates without external API or model usage lease", async () => {
  const scenePath = "plot/volumes/vol-main/chapters/ch-local/scenes/sc-local.yaml";
  const manuscriptPath = "manuscript/vol-main/ch-local/sc-local.md";
  const previousFetch = globalThis.fetch;
  let outbound = 0;
  globalThis.fetch = (async () => { outbound++; throw new Error("provider request forbidden"); }) as typeof fetch;
  try {
    const action = getAction(createAssistantActions(), "assistant.rewrite");
    const result = await action.invoke({ sceneId: "sc-local", sentenceIndex: 0 }, context({
      files: {
        "plot/volumes/vol-main/volume.yaml": "id: vol-main\ntype: volume\nname: Main\norder: 1\n",
        "plot/volumes/vol-main/chapters/ch-local/chapter.yaml": "id: ch-local\ntype: chapter\nname: Local\nvolume: vol-main\norder: 1\n",
        [scenePath]: `id: sc-local\ntype: scene\nchapter: ch-local\norder: 1\nmanuscript: ${manuscriptPath}\n`,
        [manuscriptPath]: "彼は夜の駅を歩いた。",
      },
      async invoke(actionId) {
        if (actionId === "semantic.search") return { ok: true, snapshot, data: { results: [] } };
        throw new Error("unexpected action " + actionId);
      },
      onPropose() { assert.fail("local suggestions must not apply an unapproved proposal"); },
    }));
    assert.equal(result.ok, true, result.ok ? undefined : result.error.message);
    if (!result.ok) return;
    const data = result.data as Record<string, unknown>;
    assert.equal(data.provider, "local");
    assert.equal(data.model, "codexia-rewrite-heuristics");
    assert.equal(data.text, "彼は夜の駅を歩いた。");
    assert.equal((data.suggestions as unknown[]).length, 3);
    assert.equal(outbound, 0);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("aspect review runs the deterministic local source implementation without consent or model access", async () => {
  const previous = process.env.ARCADIA_LLM_PROVIDER;
  process.env.ARCADIA_LLM_PROVIDER = "none";
  let actionInvocations = 0;
  let proposals = 0;
  const chapterPath = "plot/volumes/vol-main/chapters/ch-1/chapter.yaml";
  const sceneBase = "plot/volumes/vol-main/chapters/ch-1/scenes";
  const files: Record<string, string> = {
    [chapterPath]: "id: ch-1\ntype: chapter\nname: First chapter\nvolume: vol-main\norder: 1\n",
    [`${sceneBase}/sc-1.yaml`]: "id: sc-1\ntype: scene\nchapter: ch-1\norder: 1\ntitle: Long scene\npov: char-one\nmanuscript: manuscript/vol-main/ch-1/sc-1.md\n",
    [`${sceneBase}/sc-2.yaml`]: "id: sc-2\ntype: scene\nchapter: ch-1\norder: 2\ntitle: Short scene\npov: char-two\nmanuscript: manuscript/vol-main/ch-1/sc-2.md\n",
    "bible/characters/char-one/profile.yaml": "id: char-one\ntype: character\nname: One\n",
    "bible/characters/char-two/profile.yaml": "id: char-two\ntype: character\nname: Two\n",
    "manuscript/vol-main/ch-1/sc-1.md": `${"a".repeat(600)} 私は振り返った。彼女は先へ進んだ。`,
    "manuscript/vol-main/ch-1/sc-2.md": "短い場面。",
  };
  try {
    const module = createAssistantActions();
    const action = getAction(module, "assistant.aspect.review");
    const result = await action.invoke({ chapterId: "ch-1", aspects: ["tempo", "pov-shift"] }, context({
      files,
      async invoke() {
        actionInvocations += 1;
        return { ok: false, snapshot, error: { code: "unexpected", message: "No action should be needed", retryable: false } };
      },
      onPropose() { proposals += 1; },
    }));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const data = result.data as Record<string, unknown>;
    assert.equal(data.proposal, true);
    assert.equal(data.sceneCount, 2);
    const findings = data.findings as Array<Record<string, unknown>>;
    assert.ok(findings.some((finding) => finding.aspect === "tempo" && typeof finding.sceneId === "string"));
    assert.ok(findings.some((finding) => finding.aspect === "pov-shift" && String(finding.finding).includes("POV")));
    assert.equal(actionInvocations, 0);
    assert.equal(proposals, 0);
  } finally {
    if (previous === undefined) delete process.env.ARCADIA_LLM_PROVIDER;
    else process.env.ARCADIA_LLM_PROVIDER = previous;
  }
});

test("implemented prompt previews return their actual prompts locally without consent, usage, or proposal effects", async () => {
  const previous = process.env.ARCADIA_LLM_PROVIDER;
  process.env.ARCADIA_LLM_PROVIDER = "none";
  let consentReads = 0;
  let proposals = 0;
  const chapterPath = "plot/volumes/vol-main/chapters/ch-preview/chapter.yaml";
  const scenePath = "plot/volumes/vol-main/chapters/ch-preview/scenes/sc-preview.yaml";
  const sketchPath = "bible/dialogue_sketches/ds-preview.yaml";
  const files: Record<string, string> = {
    "plot/volumes/vol-main/volume.yaml": "id: vol-main\ntype: volume\nname: Main\norder: 1\n",
    [chapterPath]: "id: ch-preview\ntype: chapter\nname: Preview chapter\nvolume: vol-main\norder: 1\n",
    [scenePath]: "id: sc-preview\ntype: scene\nchapter: ch-preview\norder: 1\ntitle: Preview scene\nappears: [char-one, char-two]\nmanuscript: manuscript/vol-main/ch-preview/sc-preview.md\n",
    "bible/characters/char-one/profile.yaml": "id: char-one\ntype: character\nname: One\nvoice:\n  tone: calm\n",
    "bible/characters/char-two/profile.yaml": "id: char-two\ntype: character\nname: Two\n",
    [sketchPath]: "id: ds-preview\ntype: dialogue_sketch\nparticipantEntityIds: [char-one, char-two]\ntopic: Tea\nsituation: At a station\nlines:\n  - speakerEntityId: char-one\n    text: Tea is ready.\n",
    "manuscript/vol-main/ch-preview/sc-preview.md": "彼女は駅へ来た。「お茶ができたわ。」",
  };
  try {
    const actions = createAssistantActions();
    const actionContext = context({
      files,
      async invoke(actionId, payload) {
        if (actionId === "nlp.features") consentReads += 1;
        if (actionId === "semantic.search") return { ok: true, snapshot, data: { results: [] } };
        if (actionId === "nlp.countTokens") {
          const request = payload as { texts: string[] };
          return { ok: true, snapshot, data: {
            snapshot, counts: request.texts.map(() => 1),
            counter: { modelId: "test", exact: false, engine: "test", engineVersion: "1" },
          } };
        }
        return { ok: false, snapshot, error: { code: "not_available", message: "Preview must not need domain actions", retryable: false } };
      },
      onPropose() { proposals += 1; },
    });
    const previews: Array<[string, unknown]> = [
      ["assistant.summary.scene.preview", { sceneId: "sc-preview" }],
      ["assistant.summary.chapter.preview", { chapterId: "ch-preview" }],
      ["assistant.qa.preview", { sceneId: "sc-preview" }],
      ["assistant.qa.preview", { sceneId: "missing-scene" }],
      ["assistant.continuation.preview", { recentSentences: ["彼女は駅へ来た。"] }],
      ["assistant.aspect.review.preview", { chapterId: "ch-preview", aspects: ["tempo", "pov-shift"] }],
      ["assistant.dialogue.topics.preview", { participantEntityIds: ["char-one", "char-two"] }],
      ["assistant.dialogue.turn.preview", { participantEntityIds: ["char-one", "char-two"], speakerEntityId: "char-one", topic: "Tea", situation: "At a station", precedingLines: [] }],
      ["assistant.dialogue.turns.preview", { participantEntityIds: ["char-one", "char-two"], lineCount: 2, topic: "Tea", situation: "At a station", precedingLines: [] }],
      ["assistant.reader.reaction.preview", { chapterId: "ch-preview" }],
      ["assistant.synonyms.preview", { original: "駅", sentence: "駅へ向かう。", reason: "繰り返し" }],
      ["assistant.zukan.sandbox.preview", { sketchId: "ds-preview", turnRange: { start: 0, end: 0 } }],
    ];
    for (const [id, input] of previews) {
      const result = await getAction(actions, id).invoke(input, actionContext);
      assert.equal(result.ok, true, `${id} should be available with provider NONE: ${JSON.stringify(result)}`);
      if (result.ok) assert.equal(typeof (result.data as Record<string, unknown>).prompt, "string", `${id} should return a populated prompt`);
    }
    const savedSceneContinuation = await getAction(actions, "assistant.continuation.preview").invoke({ sceneId: "sc-preview", chapterId: "ch-preview", k: 8 }, actionContext);
    assert.equal(savedSceneContinuation.ok, true);
    if (savedSceneContinuation.ok) {
      const prompt = (savedSceneContinuation.data as Record<string, unknown>).prompt as string;
      assert.match(prompt, /彼女は駅へ来た。/u, "saved-scene preview must read the current manuscript");
    }
    assert.equal(consentReads, 0);
    assert.equal(proposals, 0);
  } finally {
    if (previous === undefined) delete process.env.ARCADIA_LLM_PROVIDER;
    else process.env.ARCADIA_LLM_PROVIDER = previous;
  }
});


test("dialogue topic seeds retain manual relations and related links while excluding automatic and non-related links", async () => {
  const action = getAction(createAssistantActions(), "assistant.dialogue.topics.preview");
  const result = await action.invoke({ participantEntityIds: ["char-one", "char-two"] }, context({
    files: {
      "bible/characters/char-one/profile.yaml": [
        "id: char-one",
        "type: character",
        "name: One",
        "relations:",
        "  - target: char-two",
        "    kind: ally",
        "    note: trusted",
        "  - target: char-two",
        "    kind: related",
        "    note: automatic tie",
        "    auto: true",
        "affiliated: [char-two]",
        "related:",
        "  - target: char-two",
        "    note: linked note",
        "",
      ].join("\n"),
      "bible/characters/char-two/profile.yaml": "id: char-two\ntype: character\nname: Two\n",
    },
  }));

  assert.equal(result.ok, true);
  if (!result.ok) return;
  const prompt = (result.data as Record<string, unknown>).prompt as string;
  assert.match(prompt, /One ↔ Two: ally: trusted/u);
  assert.match(prompt, /One ↔ Two: related: linked note/u);
  assert.doesNotMatch(prompt, /automatic tie/u);
  assert.doesNotMatch(prompt, /affiliated/u);
});


test("rewrite proposal preserves all candidates until the author chooses one and pins the manuscript selection", async () => {
  const scenePath = "plot/volumes/vol-main/chapters/ch-rewrite/scenes/sc-rewrite.yaml";
  const manuscriptPath = "manuscript/vol-main/ch-rewrite/sc-rewrite.md";
  const files = {
    "plot/volumes/vol-main/volume.yaml": "id: vol-main\ntype: volume\nname: Main\norder: 1\n",
    "plot/volumes/vol-main/chapters/ch-rewrite/chapter.yaml": "id: ch-rewrite\ntype: chapter\nname: Rewrite\nvolume: vol-main\norder: 1\n",
    [scenePath]: `id: sc-rewrite\ntype: scene\nchapter: ch-rewrite\norder: 1\ntitle: Rewrite\nmanuscript: ${manuscriptPath}\n`,
    [manuscriptPath]: "---\ntitle: Rewrite\n---\n彼は夜の駅で彼女を見つけた。",
  };
  let proposed: ChangeOperation[] = [];
  const action = getAction(createAssistantActions(), "assistant.rewrite.propose");
  const result = await action.invoke({
    sceneId: "sc-rewrite",
    selectedText: "彼は夜の駅で彼女を見つけた。",
    replacementText: "夜の駅で、彼は彼女へ目を向けた。",
  }, context({ files, onPropose(operations) { proposed = operations; } }));
  assert.equal(result.ok, true);
  assert.equal(proposed.length, 1);
  assert.equal(proposed[0]?.effect, "manuscript");
  assert.deepEqual(proposed[0]?.reads.map((item) => item.path).sort(), [scenePath, manuscriptPath].sort());
  assert.equal(proposed[0]?.writes[0]?.content, "---\ntitle: Rewrite\n---\n夜の駅で、彼は彼女へ目を向けた。");
  if (result.ok) assert.equal((result.data as Record<string, unknown>).replacementText, "夜の駅で、彼は彼女へ目を向けた。");
});


test("context preview delegates to the shared Story action without provider acquisition or proposals", async () => {
  const input = { sceneId: "sc-a", scope: "reader", budget: 1000 };
  const data = { sceneId: "sc-a", scope: "reader", parts: [], budget: 1000, used: 0, omitted: 0 };
  const action = getAction(createAssistantActions(), "assistant.context.preview");
  const result = await action.invoke(input, context({
    onPropose() { assert.fail("preview must not propose changes"); },
    async invoke(id, value) {
      assert.equal(id, "story.context.package");
      assert.deepEqual(value, input);
      return { ok: true, snapshot, data };
    },
  }));
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(result.data, data);
  const stale = await action.invoke(input, context({
    async invoke() { return { ok: true, snapshot: { ...snapshot, projectVersion: snapshot.projectVersion + 1 }, data }; },
  }));
  assert.equal(stale.ok, false);
});


test("prompt preview binds file evidence and the native Knowledge revision to the same pin", async () => {
  const actions = createAssistantActions();
  const preview = getAction(actions, "assistant.context.prompt.preview");
  const input = { sceneId: "sc-a", scope: "author", purpose: "setting-qa", question: "Where is the station?" };
  const selected: KnowledgeProjectionRef = { kind: "knowledge-projection", snapshot, revision: "1".repeat(64) };
  const changed = { ...selected, revision: "2".repeat(64) };
  const documentPath = "documents/station.md";
  let tokenCalls = 0;
  function boundContext(source?: KnowledgeProjectionRef, expected = selected) {
    const base = context({
      files: {
        [documentPath]: "The station is next to the sea.",
      },
      async invoke(id) {
        if (id === "story.context.package") {
          return { ok: true, snapshot, data: { parts: [
            { kind: "manuscript", value: { path: documentPath, revision, body: "The station is next to the sea." } },
            { kind: "native-knowledge", value: { source } },
          ] } };
        }
        assert.equal(id, "nlp.countTokens");
        tokenCalls++;
        return { ok: true, snapshot, data: { snapshot, counts: [10, 20], counter: { exact: false } } };
      },
    });
    return { ...base, reader: { ...base.reader, knowledge: { source: expected, entries: [], documentMappings: [], nodeLimitReached: false } } };
  }
  const accepted = await preview.invoke(input, boundContext(selected));
  assert.equal(accepted.ok, true, accepted.ok ? undefined : accepted.error.message);
  const { previewDigest, sourceRevisions, knowledgeSource } = accepted.data as {
    previewDigest: string; sourceRevisions: unknown; knowledgeSource: unknown;
  };
  assert.deepEqual(sourceRevisions, [{ path: documentPath, revision }]);
  assert.deepEqual(knowledgeSource, selected);
  for (const invalid of [
    undefined,
    changed,
    { ...selected, snapshot: { ...snapshot, projectId: "another-project" } },
    { ...selected, snapshot: { ...snapshot, projectVersion: snapshot.projectVersion - 1 } },
  ]) {
    const stale = await preview.invoke(input, boundContext(invalid));
    assert.equal(stale.ok, false);
    assert.equal(stale.error.code, "stale_source");
  }
  assert.equal(tokenCalls, 1);
});
