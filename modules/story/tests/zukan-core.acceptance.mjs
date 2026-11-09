import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import { ModuleRuntime } from "../../../packages/module-runtime/dist/index.js";
import { postgresFixture } from "../../test-support/postgres-fixture.mjs";

const storyPackage = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const manifest = storyPackage.codexiaModule;
const storyEntry = new URL("../dist/index.js", import.meta.url).href;

function proposalReaderAction(store, projectId) {
  const passthrough = { parse(value) { return value; } };
  return {
    module: "core",
    action: {
      id: "core.proposals.get",
      effect: "read",
      inputSchema: passthrough,
      outputSchema: passthrough,
      async invoke(input, context) {
        const proposalId = input?.proposalId;
        if (typeof proposalId !== "string") throw new TypeError("proposalId is required");
        const proposal = await store.getProposal(projectId, proposalId);
        if (!proposal) throw Object.assign(new Error("Proposal not found"), { code: "PROPOSAL_NOT_FOUND" });
        return { ok: true, snapshot: context.reader.snapshot, data: { proposal } };
      },
    },
  };
}

function actionHost(store, projectId, reader, linkedReader) {
  return {
    projectId,
    reader,
    signal: new AbortController().signal,
    access: "owner",
    actions: [proposalReaderAction(store, projectId)],
    async linkedReader(id) { return linkedReader(id); },
    async propose(operations, evidence, proposalId, signal) {
      if (signal?.aborted) throw Object.assign(new Error("Acceptance proposal was cancelled"), { code: "action_cancelled" });
      return store.propose(projectId, {
        id: proposalId ?? `story-acceptance-${randomUUID()}`,
        snapshot: reader.snapshot,
        operations,
        source: "module",
        ...(evidence ? { evidence } : {}),
      });
    },
  };
}

async function applyProposal(store, projectId, proposal) {
  const operationIds = proposal.operations.map((operation) => operation.id);
  await store.approve(projectId, { proposalId: proposal.id, operationIds, authorScope: "story-acceptance-owner" });
  for (const operation of proposal.operations) await store.apply(projectId, operation);
}

test("Story Zukan actions read and apply durable PostgreSQL proposals", async (t) => {
  const tempRoot = await mkdtemp(join(tmpdir(), "codexia-story-zukan-pg-"));
  const files = {
    "meta/project.yaml": "id: zukan-acceptance\ntitle: Zukan Acceptance\n",
    "bible/characters/char-uma/profile.yaml": "id: char-uma\ntype: character\nname: Uma\nnotes:\n  lead:\n    - type: paragraph\n      text: Character notes.\n  sections: []\n",
    "plot/volumes/vol-main/volume.yaml": "id: vol-main\ntype: volume\nname: Main\norder: 1\n",
    "plot/volumes/vol-main/chapters/ch-main-1/chapter.yaml": "id: ch-main-1\ntype: chapter\nname: Arrival\nvolume: vol-main\norder: 1\n",
    "plot/volumes/vol-main/chapters/ch-main-1/scenes/sc-1.yaml": "id: sc-1\ntype: scene\nname: Door\nvolume: vol-main\nchapter: ch-main-1\norder: 1\npov: char-uma\nlocation: null\nrelations: []\nmanuscript: manuscript/vol-main/ch-main-1/sc-1.md\n",
    "manuscript/vol-main/ch-main-1/sc-1.md": "---\ntitle: Door\nstatus: draft\n---\nUma enters the cafe.\n",
  };
  let fixture;
  let runtime;
  try {
    fixture = await postgresFixture(files, "Zukan Acceptance");
    runtime = new ModuleRuntime({
      manifests: [manifest],
      enabled: ["story"],
      cacheDirectory: join(tempRoot, "module-cache"),
      loaders: { story: async (context) => (await import(storyEntry)).createModule(context) },
    });
    const { store, project } = fixture;
    const linkedReader = async (projectId) => {
      if (projectId !== project.id) throw Object.assign(new Error("Unknown linked PostgreSQL project"), { code: "linked_project_unavailable" });
      return store.reader(projectId);
    };
    const invoke = async (actionId, input) => runtime.invokeAction(
      "story", actionId, input,
      actionHost(store, project.id, await store.reader(project.id), linkedReader),
    );

    const actions = await runtime.listActions(actionHost(store, project.id, await store.reader(project.id), linkedReader));
    assert.ok(actions.some((action) => action.id === "story.zukan-suggestions.create"));
    assert.ok(actions.some((action) => action.id === "story.snapshot.materialize"));

    const initial = await store.observe(project.id);
    const entityList = await invoke("story.entities.list", {});
    assert.equal(entityList.ok, true, JSON.stringify(entityList.error));
    assert.ok(entityList.data.some((entity) => entity.id === "char-uma"));
    const materialized = await invoke("story.snapshot.materialize", {});
    assert.equal(materialized.ok, true, JSON.stringify(materialized.error));
    assert.deepEqual(materialized.data, { entities: entityList.data.length, links: 2 });
    assert.deepEqual(materialized.snapshot, entityList.snapshot, "materialization reports its pinned PostgreSQL reader snapshot");
    assert.deepEqual((await store.observe(project.id)).snapshot, initial.snapshot, "Story read actions do not mutate the PostgreSQL project");
    const graph = await invoke("story.graph.query", { types: ["character"] });
    assert.equal(graph.ok, true, JSON.stringify(graph.error));
    assert.deepEqual(graph.data.nodes.map((node) => node.type), ["character"]);
    const invalidGraph = await invoke("story.graph.query", { types: "character" });
    assert.equal(invalidGraph.ok, false);
    assert.equal(invalidGraph.error.code, "invalid_input");

    const input = {
      entityId: "char-uma",
      proposedText: "Uma enters the cafe.",
      evidence: [{ quote: "Uma enters the cafe.", sceneId: "sc-1" }],
      source: "manuscript",
      kind: "fact",
      confidence: "high",
      operation_id: `acceptance-${randomUUID()}`,
    };
    const created = await invoke("story.zukan-suggestions.create", input);
    assert.equal(created.ok, true, JSON.stringify(created.error));
    assert.equal(created.data.created, true);
    assert.equal(created.data.suggestion.status, "pending");
    assert.equal(created.proposals.length, 1, "Zukan creation remains a reviewable Core proposal");
    const retried = await invoke("story.zukan-suggestions.create", input);
    assert.equal(retried.ok, true, JSON.stringify(retried.error));
    assert.equal(retried.proposals.length, 1, "an exact retry returns the same pending Core proposal");
    assert.equal(retried.proposals[0].id, created.proposals[0].id);

    const proposal = created.proposals[0];
    await applyProposal(store, project.id, proposal);
    const status = await store.getProposal(project.id, proposal.id);
    assert.equal(status?.state, "applied");
    const persisted = await invoke("story.zukan-suggestions.list", { entityId: "char-uma", status: "pending" });
    assert.equal(persisted.ok, true, JSON.stringify(persisted.error));
    assert.ok(persisted.data.suggestions.some((suggestion) => suggestion.id === created.data.suggestion.id));
    const durableRecord = await fixture.persistence.read((reader) => reader.getModuleRecord(project.id, "core.artifacts", "meta/scriptorium/modules/story/zukan-suggestions.jsonl"));
    assert.ok(durableRecord?.value.content?.includes(created.data.suggestion.id), "the applied module artifact is stored by PostgreSQL");

    t.diagnostic("Verified Story actions, exact retry identity, author approval, apply, and durable Zukan state against the PostgreSQL Core store.");
  } finally {
    await runtime?.shutdown();
    await fixture?.close();
    await rm(tempRoot, { recursive: true, force: true });
  }
});
