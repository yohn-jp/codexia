import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { CoreStore } from "../../../packages/core/dist/index.js";
import { ModuleRuntime } from "../../../packages/module-runtime/dist/index.js";
import { createPostgresPersistence } from "../../../packages/persistence-postgres/dist/index.js";
import { postgresFixture } from "../../test-support/postgres-fixture.mjs";

const workFiles = {
  "meta/project.yaml": "title: Work Uma\nownerNote: preserve-project-metadata\n",
  "bible/characters/char-uma/profile.yaml": "id: char-uma\ntype: character\nname: Work Uma\naliases: [Uma]\nnotes:\n  lead:\n    - type: paragraph\n      text: Work record.\n  sections: []\n",
  "bible/locations/loc-cafe.yaml": "id: loc-cafe\ntype: location\nname: Work Cafe\n",
  "bible/locations/loc-park.yaml": "id: loc-park\ntype: location\nname: Work Park\n",
  "plot/volumes/vol-main/volume.yaml": "id: vol-main\ntype: volume\nname: Main\norder: 1\n",
  "plot/volumes/vol-main/chapters/ch-main-1/chapter.yaml": "id: ch-main-1\ntype: chapter\nname: Arrival\nvolume: vol-main\norder: 1\n",
  "plot/volumes/vol-main/chapters/ch-main-1/scenes/sc-1.yaml": "id: sc-1\ntype: scene\nname: Door\nvolume: vol-main\nchapter: ch-main-1\norder: 1\npov: char-uma\nlocation: loc-cafe\nrelations:\n  - to: char-uma\n    kind: appears\nmanuscript: manuscript/vol-main/ch-main-1/sc-1.md\n",
  "manuscript/vol-main/ch-main-1/sc-1.md": "---\ntitle: Door\nstatus: draft\n---\nUma enters the cafe.\n",
};

const bibleFiles = {
  "bible/characters/char-uma/profile.yaml": "id: char-uma\ntype: character\nname: Bible Uma\naliases: [Bible-U]\nnotes:\n  lead:\n    - type: paragraph\n      text: Bible source record.\n  sections: []\n",
  "bible/locations/loc-cafe.yaml": "id: loc-cafe\ntype: location\nname: Bible Cafe\n",
  "bible/lore/lore-river.yaml": "id: lore-river\ntype: lore\nname: Silver River\n",
};

const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const storyManifest = packageJson.codexiaModule;
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
        if (typeof input?.proposalId !== "string") throw new TypeError("proposalId is required");
        const proposal = await store.getProposal(projectId, input.proposalId);
        if (!proposal) throw Object.assign(new Error("Proposal not found"), { code: "PROPOSAL_NOT_FOUND" });
        return { ok: true, snapshot: context.reader.snapshot, data: { proposal } };
      },
    },
  };
}

function makeHost(store, projectId, reader, knownProjectIds) {
  return {
    projectId,
    reader,
    signal: new AbortController().signal,
    access: "owner",
    actions: [proposalReaderAction(store, projectId)],
    async linkedReader(linkedProjectId) {
      if (!knownProjectIds.has(linkedProjectId)) throw Object.assign(new Error("Unknown linked PostgreSQL project"), { code: "linked_project_unavailable" });
      return store.reader(linkedProjectId);
    },
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

function startRuntime(cacheDirectory) {
  return new ModuleRuntime({
    manifests: [storyManifest],
    enabled: ["story"],
    cacheDirectory,
    loaders: { story: async (context) => (await import(storyEntry)).createModule(context) },
  });
}

function assertAction(result, actionId) {
  assert.equal(result.ok, true, `${actionId} failed: ${JSON.stringify(result.error)}`);
  return result.data;
}

async function approveAndApply(store, projectId, proposal, operationIds = proposal.operations.map((operation) => operation.id)) {
  await store.approve(projectId, { proposalId: proposal.id, operationIds, authorScope: "story-production-acceptance-owner" });
  const receipts = [];
  for (const operation of proposal.operations.filter((candidate) => operationIds.includes(candidate.id))) {
    receipts.push(await store.apply(projectId, operation));
  }
  return receipts;
}

test("Story actions preserve review, linked-project, concurrency, and recovery behavior in PostgreSQL", { timeout: 180_000 }, async (t) => {
  const tempRoot = await mkdtemp(join(tmpdir(), "codexia-story-production-pg-"));
  const fixtures = [];
  let runtime;
  let persistence;
  try {
    const work = await postgresFixture(workFiles, "Work Uma");
    fixtures.push(work);
    const bible = await postgresFixture(bibleFiles, "Bible Uma");
    fixtures.push(bible);
    const { project: workProject, store } = work;
    const { project: bibleProject } = bible;
    const projectIds = new Set([workProject.id, bibleProject.id]);
    assert.notEqual(workProject.id, bibleProject.id, "linked Story work and Bible data use separate PostgreSQL projects");
    const bibleBefore = await store.observe(bibleProject.id);
    runtime = startRuntime(join(tempRoot, "runtime-before-restart"));

    const invoke = async (projectId, actionId, input = {}) => {
      const reader = await store.reader(projectId);
      const result = await runtime.invokeAction("story", actionId, input, makeHost(store, projectId, reader, projectIds));
      assert.deepEqual(result.snapshot, reader.snapshot, `${actionId} reports the exact PostgreSQL snapshot it read`);
      return result;
    };

    const available = new Set((await runtime.listActions(makeHost(store, workProject.id, await store.reader(workProject.id), projectIds))).map((action) => action.id));
    for (const actionId of ["story.entities.list", "story.entities.get", "story.zukan-suggestions.create", "story.zukan-suggestions.list", "story.changes.propose", "story.series.create", "story.series.binding.update", "story.series.overlay"]) {
      assert.ok(available.has(actionId), `Composed module is missing ${actionId}`);
    }

    const workEntities = assertAction(await invoke(workProject.id, "story.entities.list"), "story.entities.list");
    assert.ok(Array.isArray(workEntities));
    const workCharacter = workEntities.find((entity) => entity.id === "char-uma");
    assert.equal(workCharacter?.name, "Work Uma");
    assert.ok(workCharacter?.fileRevision);
    const character = assertAction(await invoke(workProject.id, "story.entities.get", { id: "char-uma" }), "story.entities.get");
    assert.equal(character.revision, workCharacter.revision);

    const zukanOperationId = `story-zukan-${randomUUID().replaceAll("-", "")}`;
    const zukanInput = {
      entityId: "char-uma",
      proposedText: "Uma enters the cafe.",
      evidence: [{ quote: "Uma enters the cafe.", sceneId: "sc-1" }],
      source: "manuscript",
      kind: "fact",
      confidence: "high",
      operation_id: zukanOperationId,
    };
    const createdResult = await invoke(workProject.id, "story.zukan-suggestions.create", zukanInput);
    const created = assertAction(createdResult, "story.zukan-suggestions.create");
    assert.equal(created.created, true);
    assert.equal(created.suggestion.status, "pending", "assistant-created facts remain pending until an author applies the proposal");
    assert.equal(createdResult.proposals?.length, 1);
    const originalZukanProposal = createdResult.proposals[0];
    await approveAndApply(store, workProject.id, originalZukanProposal);
    const persistedZukan = assertAction(await invoke(workProject.id, "story.zukan-suggestions.list", { entityId: "char-uma", status: "pending" }), "story.zukan-suggestions.list");
    assert.ok(persistedZukan.suggestions.some((suggestion) => suggestion.id === created.suggestion.id));

    await work.applyFiles({ "meta/scriptorium/modules/story/unrelated-acceptance-note.txt": "Separate durable PostgreSQL project revision.\n" });
    const retriedResult = await invoke(workProject.id, "story.zukan-suggestions.create", zukanInput);
    const retried = assertAction(retriedResult, "story.zukan-suggestions.create retry");
    assert.equal(retried.created, false);
    assert.equal(retried.replayed, true);
    assert.equal(retried.proposalStatus.proposal.id, originalZukanProposal.id);
    assert.equal(retried.proposalStatus.proposal.snapshot.projectVersion, createdResult.proposals[0].snapshot.projectVersion);
    assert.equal(retriedResult.proposals, undefined, "a retry never rebases the old operation onto the newer PostgreSQL snapshot");
    const changedMeaning = assertAction(await invoke(workProject.id, "story.zukan-suggestions.create", {
      ...zukanInput,
      proposedText: "Changed meaning under the same operation identity.",
    }).then((result) => { assert.equal(result.ok, false); return { ...result, ok: true, data: result.error }; }), "changed Zukan retry");
    assert.equal(changedMeaning.code, "suggestion_identity_conflict");

    await work.applyFiles({ "meta/scriptorium/modules/story/zukan-suggestions.jsonl": "" });
    const newZukanResult = await invoke(workProject.id, "story.zukan-suggestions.create", {
      ...zukanInput,
      operation_id: `story-zukan-${randomUUID().replaceAll("-", "")}`,
    });
    const newZukan = assertAction(newZukanResult, "story.zukan-suggestions.create after row removal");
    assert.equal(newZukan.created, true);
    assert.notEqual(newZukanResult.proposals?.[0]?.id, originalZukanProposal.id);
    assert.notEqual(newZukan.suggestion.id, created.suggestion.id);

    const seriesResult = await invoke(workProject.id, "story.series.create", {
      name: "PostgreSQL Story Acceptance",
      bibleProjectId: bibleProject.id,
      operation_id: `story-series-${randomUUID().replaceAll("-", "")}`,
    });
    const series = assertAction(seriesResult, "story.series.create");
    const seriesProposal = seriesResult.proposals?.[0];
    assert.ok(seriesProposal);
    await approveAndApply(store, workProject.id, seriesProposal);
    const bindingResult = await invoke(workProject.id, "story.series.binding.update", {
      seriesId: series.id,
      operation_id: `story-series-bind-${randomUUID().replaceAll("-", "")}`,
    });
    const binding = assertAction(bindingResult, "story.series.binding.update");
    assert.equal(binding.bibleProjectId, bibleProject.id);
    await approveAndApply(store, workProject.id, bindingResult.proposals[0]);
    const overlay = assertAction(await invoke(workProject.id, "story.series.overlay"), "story.series.overlay");
    assert.equal(overlay.workSnapshot.projectId, workProject.id);
    assert.equal(overlay.bibleSnapshot.projectId, bibleProject.id);
    assert.deepEqual(overlay.bibleSnapshot, bibleBefore.snapshot, "the linked Bible snapshot stays read-only while the work project changes");
    assert.equal(overlay.workEntities.find((entity) => entity.id === "char-uma")?.name, "Work Uma");
    assert.equal(overlay.bibleEntities.find((entity) => entity.id === "char-uma")?.name, "Bible Uma");
    assert.equal(overlay.entities.find((entity) => entity.id === "char-uma")?.name, "Work Uma", "the merged view keeps work precedence and preserves the Bible entity");
    assert.ok(overlay.bibleEntities.some((entity) => entity.id === "lore-river"));

    const currentEntities = assertAction(await invoke(workProject.id, "story.entities.list"), "story.entities.list before changeset");
    const entityRevision = (id) => currentEntities.find((entity) => entity.id === id)?.revision;
    const changeSet = {
      schemaVersion: 1,
      id: `story-ncs-${randomUUID().replaceAll("-", "")}`,
      projectId: workProject.id,
      goal: "Create a location and scene with a reviewed reference relation",
      status: "proposed",
      assessment: { confidence: 0.95, risk: "medium" },
      operations: [
        { id: "create-garden", kind: "entity.create", precondition: { kind: "absent" }, target: { entityId: "loc-pg-garden", entityType: "location" }, values: { id: "loc-pg-garden", type: "location", name: "Acceptance Garden" }, evidenceIds: ["fixture-source"], assessment: { confidence: 0.95, risk: "low" } },
        { id: "create-scene", kind: "scene.create", precondition: { kind: "absent" }, target: { sceneId: "sc-pg-garden" }, values: { id: "sc-pg-garden", type: "scene", title: "Garden Visit", volume: "vol-main", chapter: "ch-main-1", order: 2, pov: "char-uma", location: "loc-pg-garden" }, evidenceIds: ["fixture-source"], assessment: { confidence: 0.9, risk: "medium" } },
        { id: "link-character-location", kind: "reference.link", precondition: { kind: "revision", value: entityRevision("char-uma") }, target: { from: "char-uma", to: "loc-cafe", kind: "related" }, note: "Acceptance relation", evidenceIds: ["fixture-source"], assessment: { confidence: 0.85, risk: "low" } },
      ],
      evidence: [{ id: "fixture-source", sourceKind: "entity", sourceId: "char-uma", revision: entityRevision("char-uma") }],
      diagnostics: { before: null, after: null },
    };
    const submittedResult = await invoke(workProject.id, "story.changes.propose", changeSet);
    const submitted = assertAction(submittedResult, "story.changes.propose");
    assert.equal(submitted.replayed, false);
    assert.equal(submitted.dependencies["create-scene"]?.[0], "create-garden", "the scene precondition includes the preceding virtual Bible write");
    assert.equal(submittedResult.proposals?.length, 1, "the complete source change set becomes one atomic Core proposal");
    const coreProposalId = submitted.data?.coreProposalId ?? submitted.coreProposalId;
    const persistedProposal = await store.getProposal(workProject.id, coreProposalId);
    assert.equal(persistedProposal?.proposal.id, coreProposalId);
    const sourceEvidence = persistedProposal.proposal.evidence.find((item) => item.kind === "source.narrative-change-set.v1");
    assert.deepEqual(sourceEvidence.details.sourceChangeSet, changeSet);
    const coreOperations = persistedProposal.proposal.operations;
    assert.equal(coreOperations.length, 3);
    const firstScopes = new Map(coreOperations[0].readScopes.map((scope) => [scope.prefix, scope.revision]));
    const sceneScopes = new Map(coreOperations[1].readScopes.map((scope) => [scope.prefix, scope.revision]));
    assert.notEqual(sceneScopes.get("bible"), firstScopes.get("bible"), "the second operation hashes the first virtual Bible write");
    assert.equal(sceneScopes.get("plot"), firstScopes.get("plot"), "virtual scene creation retains the original plot membership");
    assert.ok(coreOperations[1].reads.some((read) => read.path === "plot/volumes/vol-main/chapters/ch-main-1/chapter.yaml" && read.revision));
    assert.ok(coreOperations[1].reads.some((read) => read.path === "bible/characters/char-uma/profile.yaml" && read.revision));
    assert.ok(coreOperations[2].reads.some((read) => read.path === "bible/locations/loc-cafe.yaml" && read.revision));

    const replayed = assertAction(await invoke(workProject.id, "story.changes.propose", changeSet), "story.changes.propose exact retry");
    assert.equal(replayed.replayed, true);
    assert.equal(replayed.coreProposalId, coreProposalId);
    const changedChangeSet = assertAction(await invoke(workProject.id, "story.changes.propose", {
      ...changeSet,
      goal: `${changeSet.goal} with a changed meaning`,
    }).then((result) => { assert.equal(result.ok, false); return { ...result, ok: true, data: result.error }; }), "changed Story changeset retry");
    assert.equal(changedChangeSet.code, "change_set_identity_conflict");

    await store.approve(workProject.id, { proposalId: coreProposalId, operationIds: [coreOperations[0].id], authorScope: "story-production-acceptance-owner" });
    await store.apply(workProject.id, coreOperations[0]);
    let partial = await store.getProposal(workProject.id, coreProposalId);
    assert.equal(partial.state, "partially_approved");
    assert.deepEqual(partial.approvedOperationIds, [coreOperations[0].id]);
    await approveAndApply(store, workProject.id, persistedProposal.proposal, coreOperations.slice(1).map((operation) => operation.id));
    partial = await store.getProposal(workProject.id, coreProposalId);
    assert.equal(partial.state, "applied");
    assert.deepEqual(partial.applications.map((receipt) => receipt.operationId), coreOperations.map((operation) => operation.id));

    const postApplyEntities = assertAction(await invoke(workProject.id, "story.entities.list"), "story.entities.list after apply");
    assert.ok(postApplyEntities.some((entity) => entity.id === "loc-pg-garden"));
    assert.ok(postApplyEntities.some((entity) => entity.id === "sc-pg-garden"));

    const charEntity = postApplyEntities.find((entity) => entity.id === "char-uma");
    const guardChangeSet = {
      ...changeSet,
      id: `story-reference-guard-${randomUUID().replaceAll("-", "")}`,
      goal: "Guard a target file revision before applying a relationship",
      operations: [{
        id: "link-park",
        kind: "reference.link",
        precondition: { kind: "revision", value: charEntity.revision },
        target: { from: "char-uma", to: "loc-park", kind: "related" },
        note: "Target location remains stable until apply",
        evidenceIds: ["fixture-source"],
        assessment: { confidence: 0.9, risk: "low" },
      }],
      evidence: [{ id: "fixture-source", sourceKind: "entity", sourceId: "char-uma", revision: charEntity.revision }],
    };
    const guardResult = await invoke(workProject.id, "story.changes.propose", guardChangeSet);
    assert.equal(guardResult.ok, true, guardResult.ok ? undefined : guardResult.error.message);
    const guardProposal = guardResult.proposals[0];
    const guardOperation = guardProposal.operations[0];
    assert.ok(guardOperation.reads.some((read) => read.path === "bible/locations/loc-park.yaml" && read.revision));
    await store.approve(workProject.id, { proposalId: guardProposal.id, operationIds: [guardOperation.id], authorScope: "story-production-acceptance-owner" });
    const currentPark = await (await store.reader(workProject.id)).read("bible/locations/loc-park.yaml");
    await work.applyFiles({ "bible/locations/loc-park.yaml": `${currentPark.content}\n# changed after author approval\n` });
    await assert.rejects(store.apply(workProject.id, guardOperation), (error) => ["conflict", "revision_conflict"].includes(error?.code));
    assert.equal((await store.getProposal(workProject.id, guardProposal.id))?.state, "approved", "a stale approved operation remains unapplied and reviewable");

    const workVersionBeforeRestart = (await store.observe(workProject.id)).snapshot.projectVersion;
    const bibleVersionBeforeRestart = (await store.observe(bibleProject.id)).snapshot.projectVersion;
    await runtime.shutdown();
    runtime = undefined;
    for (const fixture of fixtures.splice(0)) await fixture.close();

    persistence = createPostgresPersistence(process.env.CODEXIA_TEST_DATABASE_URL);
    const recoveredStore = new CoreStore({ persistence });
    runtime = startRuntime(join(tempRoot, "runtime-after-restart"));
    const recoveredHost = async (projectId, actionId, input = {}) => {
      const reader = await recoveredStore.reader(projectId);
      const result = await runtime.invokeAction("story", actionId, input, makeHost(recoveredStore, projectId, reader, projectIds));
      assert.deepEqual(result.snapshot, reader.snapshot);
      return result;
    };
    const recoveredWork = assertAction(await recoveredHost(workProject.id, "story.entities.list"), "recovered story.entities.list");
    assert.ok(recoveredWork.some((entity) => entity.id === "sc-pg-garden"), "the hierarchy and manuscript remain durable after a fresh Core connection");
    const recoveredOverlay = assertAction(await recoveredHost(workProject.id, "story.series.overlay"), "recovered story.series.overlay");
    assert.equal(recoveredOverlay.workSnapshot.projectVersion, workVersionBeforeRestart);
    assert.equal(recoveredOverlay.bibleSnapshot.projectVersion, bibleVersionBeforeRestart);
    assert.equal(recoveredOverlay.bibleEntities.find((entity) => entity.id === "char-uma")?.name, "Bible Uma");
    const recoveredStatuses = await recoveredStore.listProposals(workProject.id);
    assert.equal(recoveredStatuses.find((status) => status.proposal.id === originalZukanProposal.id)?.state, "applied");
    assert.equal(recoveredStatuses.find((status) => status.proposal.id === coreProposalId)?.state, "applied");
    assert.equal(recoveredStatuses.find((status) => status.proposal.id === guardProposal.id)?.state, "approved");
    assert.equal((await recoveredStore.observe(bibleProject.id)).snapshot.projectVersion, bibleBefore.snapshot.projectVersion,
      "linked Bible state stays unchanged after the work project is applied and recovered");

    t.diagnostic("Verified Story module behavior, proposal approvals and apply, linked PostgreSQL project reads, stale-operation rejection, and recovery after reconnecting Core.");
  } finally {
    await runtime?.shutdown().catch(() => {});
    await persistence?.close().catch(() => {});
    for (const fixture of fixtures.splice(0)) await fixture.close().catch(() => {});
    await rm(tempRoot, { recursive: true, force: true });
  }
});
