import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { ActionResult, ModuleActionContext, ModuleContext } from "@codexia/contracts";
import { createSemanticActions } from "@codexia/module-semantic";
import { readStorySnapshot } from "@codexia/module-story";
import { postgresFixture } from "../../../tests/helpers/postgres-fixture.mjs";
import { createAssistantActions, resolveZukanEvidenceSources } from "./actions.js";

const databaseUrl = process.env.CODEXIA_TEST_DATABASE_URL;

test("Zukan resolves real Semantic lexical manuscript hits through the Core snapshot without a provider", {
  skip: !databaseUrl,
}, async () => {
  const suffix = randomUUID().replaceAll("-", "");
  const volumeId = `vol-${suffix}`;
  const chapterId = `ch-${suffix}`;
  const sceneId = `sc-${suffix}`;
  const sourceCharacterId = `char-source-${suffix}`;
  const isolatedCharacterId = `char-isolated-${suffix}`;
  const manuscriptPath = `manuscript/${volumeId}/${chapterId}/${sceneId}.md`;
  const scenePath = `plot/volumes/${volumeId}/chapters/${chapterId}/scenes/${sceneId}.yaml`;
  const characterPath = `bible/characters/${sourceCharacterId}/profile.yaml`;
  const isolatedCharacterPath = `bible/characters/${isolatedCharacterId}/profile.yaml`;
  const quote = "アリスは青い傘を開いた。";
  const fixture = await postgresFixture({
    [`plot/volumes/${volumeId}/volume.yaml`]: `id: ${volumeId}\ntype: volume\nname: Source volume\norder: 1\n`,
    [`plot/volumes/${volumeId}/chapters/${chapterId}/chapter.yaml`]: `id: ${chapterId}\ntype: chapter\nname: Source chapter\nvolume: ${volumeId}\norder: 1\n`,
    [scenePath]: `id: ${sceneId}\ntype: scene\nname: Source scene\nchapter: ${chapterId}\norder: 1\nmanuscript: ${manuscriptPath}\n`,
    [manuscriptPath]: quote,
    [characterPath]: `id: ${sourceCharacterId}\ntype: character\nname: アリス\nnotes:\n  lead: []\n  sections: []\n`,
    [isolatedCharacterPath]: `id: ${isolatedCharacterId}\ntype: character\nname: ノア\nnotes:\n  lead: []\n  sections: []\n`,
  }, `Assistant Zukan ${suffix}`);

  const originalProvider = process.env.ARCADIA_LLM_PROVIDER;
  process.env.ARCADIA_LLM_PROVIDER = "none";
  const providerCapabilityRequests: string[] = [];
  try {
    const reader = await fixture.store.reader(fixture.project.id);
    const semanticContext = { projectId: fixture.project.id, reader, signal: new AbortController().signal } as ModuleActionContext;
    const semanticModuleContext = {
      async acquireCapability(id: string) { throw Object.assign(new Error(`Unavailable in lexical fallback: ${id}`), { code: "not_available" }); },
    } as unknown as ModuleContext;
    const semanticAction = createSemanticActions(semanticModuleContext).find((candidate) => candidate.id === "semantic.search");
    assert.ok(semanticAction);

    const search = await semanticAction.invoke({ query: "アリス", mode: "sentence", limit: 12, rerank: false }, semanticContext);
    assert.equal(search.ok, true, search.ok ? undefined : `${search.error.code}: ${search.error.message}`);
    if (!search.ok) return;
    assert.deepEqual(search.snapshot, reader.snapshot);
    assert.equal((search.data as Record<string, unknown>).warning, "semantic_index_missing_or_model_unavailable",
      "the observed hits must come from Semantic's ordinary lexical fallback");
    const hits = (search.data as { results: Array<Record<string, unknown>> }).results;
    assert.equal(hits[0]?.sceneId, sourceCharacterId, "the character's lexical hit is the leading result");
    assert.equal(hits[0]?.type, "character");
    assert.ok(hits.some((hit) => hit.sceneId === `ms-${volumeId}-${chapterId}-${sceneId}` && hit.type === "manuscript"));

    const story = await readStorySnapshot(reader, { includeManuscripts: true });
    const eligible = resolveZukanEvidenceSources(story, hits);
    assert.equal(eligible.length, 1, "the character hit is omitted and the manuscript hit resolves to its unique scene");
    const resolved = eligible[0]!;
    const projectedManuscript = await reader.read(manuscriptPath);
    assert.ok(projectedManuscript);
    assert.deepEqual({
      sceneId: resolved.source.scene.id,
      path: resolved.source.manuscript.path,
      revision: resolved.source.manuscript.revision,
      quote: resolved.quote,
    }, {
      sceneId,
      path: manuscriptPath,
      revision: projectedManuscript.revision,
      quote,
    });
    assert.equal(resolved.source.manuscript.revision, projectedManuscript.revision,
      "citations bind to the revision returned by Core's PostgreSQL projection");

    const unsupported = resolveZukanEvidenceSources(story, [
      hits[0]!,
      { sceneId: `ms-${volumeId}-${chapterId}-${sceneId}`, type: "manuscript", filePath: manuscriptPath, snippet: "not present in the manuscript" },
    ]);
    assert.deepEqual(unsupported, [], "non-scene and non-exact quote hits cannot become proposal evidence");

    const assistantModuleContext = {
      cacheDirectory: "/tmp/codexia-558-no-provider",
      signal: new AbortController().signal,
      async acquireCapability<T>(id: string) {
        providerCapabilityRequests.push(id);
        throw new Error("Assistant capabilities must not be acquired before source evidence is verified");
      },
      async createWorkerService() { throw new Error("Assistant must not create workers for this source check"); },
    } as unknown as ModuleContext;
    const assistantContext = {
      projectId: fixture.project.id,
      reader,
      signal: new AbortController().signal,
      async invoke(actionId: string, input: unknown): Promise<ActionResult> {
        if (actionId === "nlp.features") return { ok: true, snapshot: reader.snapshot, data: { features: [{ id: "zukan-proposal", locality: "external", enabled: true }] } };
        if (actionId === "semantic.search") return semanticAction.invoke(input, assistantContext as ModuleActionContext);
        return { ok: false, snapshot: reader.snapshot, error: { code: "unexpected_action", message: actionId, retryable: false } };
      },
      async listActions() { return []; },
      async linkedReader() { return reader; },
      async propose() { throw new Error("An unsupported source must not create a proposal"); },
      async runJob() { throw new Error("Assistant must not create a job for this source check"); },
    } as unknown as ModuleActionContext;
    const assistantAction = createAssistantActions(assistantModuleContext).find((candidate) => candidate.id === "assistant.zukan.suggestions");
    assert.ok(assistantAction);
    const unsupportedResult = await assistantAction.invoke({ entityId: isolatedCharacterId, source: "manuscript" }, assistantContext);
    assert.equal(unsupportedResult.ok, false);
    if (!unsupportedResult.ok) assert.equal(unsupportedResult.error.code, "assistant_evidence_missing");
    assert.deepEqual(providerCapabilityRequests, [], "no provider usage capability is acquired for unsupported evidence");
  } finally {
    if (originalProvider === undefined) delete process.env.ARCADIA_LLM_PROVIDER;
    else process.env.ARCADIA_LLM_PROVIDER = originalProvider;
    await fixture.close();
  }
});
