import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { test } from "node:test";

import { CoreStore } from "../../packages/core/dist/index.js";
import { createPostgresPersistence, migratePostgresDatabase } from "../../packages/persistence-postgres/dist/index.js";
import { buildNarrativeChangeProposal } from "../../modules/story/dist/narrativeChangeSet.js";

const databaseUrl = process.env.CODEXIA_TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("CODEXIA_TEST_DATABASE_URL is required for Story range evidence acceptance");

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function storyHash(value) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

test("Story range approval applies exact PostgreSQL edits and preserves unrelated confirmed evidence", async () => {
  await migratePostgresDatabase(databaseUrl);
  const persistence = createPostgresPersistence(databaseUrl);
  const core = new CoreStore({ persistence });
  try {
    const project = await core.createProject({ title: `Story range evidence ${randomUUID()}` });
    async function accept(operation, snapshot) {
      const proposal = { id: randomUUID(), snapshot, operations: [operation], source: "author" };
      await core.propose(project.id, proposal);
      await core.approve(project.id, { proposalId: proposal.id, operationIds: [operation.id], authorScope: "story-range-owner" });
      return core.apply(project.id, operation);
    }
    for (const input of [
      { kind: "volume", id: "v1", title: "Volume" },
      { kind: "chapter", id: "c1", title: "Chapter", volumeId: "v1" },
      { kind: "scene", id: "s1", title: "Scene", volumeId: "v1", chapterId: "c1", manuscriptBody: "  BEFORE confirmed evidence MID changed target AFTER confirmed evidence  \n" },
    ]) {
      const built = await core.buildCreateHierarchyOperation(project.id, input);
      await accept(built.operation, built.snapshot);
    }

    const documents = await persistence.read((reader) => reader.listDocuments(project.id));
    const scene = documents.find((document) => document.kind === "scene");
    assert.ok(scene?.headRevisionId);
    const baseRevision = await persistence.read((reader) => reader.getRevision(project.id, scene.id, scene.headRevisionId));
    assert.ok(baseRevision);
    const baseText = baseRevision.markdown;
    const manuscriptPath = "manuscript/v1/c1/s1.md";
    const beforeQuote = "BEFORE confirmed evidence";
    const overlapQuote = "changed target";
    const afterQuote = "AFTER confirmed evidence";
    const nodeId = randomUUID();
    const anchors = [
      { id: randomUUID(), quote: beforeQuote },
      { id: randomUUID(), quote: overlapQuote },
      { id: randomUUID(), quote: afterQuote },
    ];
    await persistence.transaction(async (tx) => {
      await tx.saveKnowledgeNode({ projectId: project.id, id: nodeId, type: "lore", name: "Confirmed clue", attributes: {}, status: "confirmed", expectedVersion: null });
      for (const item of anchors) {
        const fromUtf16 = baseText.indexOf(item.quote);
        assert.notEqual(fromUtf16, -1);
        await tx.saveEvidenceAnchor({
          projectId: project.id,
          id: item.id,
          documentId: scene.id,
          revisionId: baseRevision.id,
          fromUtf16,
          toUtf16: fromUtf16 + item.quote.length,
          quoteSha256: sha256(item.quote),
          status: "confirmed",
          expectedVersion: null,
        });
        await tx.saveMentionLink({ projectId: project.id, evidenceId: item.id, nodeId, status: "confirmed", source: "author", confidence: 1, extractorVersion: null });
      }
    });

    const reader = await core.reader(project.id);
    const source = await reader.read(manuscriptPath);
    assert.equal(source?.content, baseText);
    const target = baseText.trim();
    const rangeStart = target.indexOf(overlapQuote);
    const rangeEnd = rangeStart + overlapQuote.length;
    const replacement = "revised longer target";
    const rawChangeSet = {
      schemaVersion: 1,
      id: `range-${randomUUID()}`,
      projectId: project.id,
      goal: "Revise one range without rechecking unrelated evidence",
      status: "proposed",
      assessment: { confidence: 0.9, risk: "low" },
      operations: [{
        id: "replace-range",
        kind: "manuscript.replace-range",
        precondition: { kind: "content-hash", value: storyHash(target) },
        target: { manuscriptId: "ms-v1-c1-s1", sceneId: "s1" },
        range: { start: rangeStart, end: rangeEnd },
        replacement,
        evidenceIds: ["range-evidence"],
        assessment: { confidence: 0.9, risk: "low" },
      }],
      evidence: [{ id: "range-evidence", sourceKind: "manuscript", sourceId: "ms-v1-c1-s1", revision: source.revision }],
      diagnostics: { before: null, after: null },
    };
    const context = {
      projectId: project.id,
      reader,
      signal: new AbortController().signal,
      async invoke() { throw new Error("Unexpected Story action delegation"); },
      async listActions() { return []; },
      async linkedReader() { throw new Error("Unexpected linked project read"); },
      async propose(operations, evidence, proposalId) { return { id: proposalId, snapshot: reader.snapshot, operations, source: "module", evidence }; },
      async runJob() { throw new Error("Unexpected Story job"); },
    };
    const generated = await buildNarrativeChangeProposal(context, rawChangeSet);
    const operation = generated.operations[0];
    assert.deepEqual(operation.writes[0].textChanges, [{
      fromUtf16: baseText.indexOf(overlapQuote),
      toUtf16: baseText.indexOf(overlapQuote) + overlapQuote.length,
      insert: replacement,
    }]);
    const proposal = {
      id: generated.coreProposalId,
      snapshot: reader.snapshot,
      operations: generated.operations,
      source: "module",
      evidence: generated.evidence,
    };
    await core.propose(project.id, proposal);
    await core.approve(project.id, { proposalId: proposal.id, operationIds: [operation.id], authorScope: "story-range-owner" });

    const forged = structuredClone(operation);
    forged.writes[0].textChanges[0].fromUtf16 += 1;
    await assert.rejects(core.apply(project.id, forged), /exact operation must be approved/u);
    await core.apply(project.id, operation);

    const currentReader = await core.reader(project.id);
    const current = await currentReader.read(manuscriptPath);
    const expectedText = baseText.slice(0, baseText.indexOf(overlapQuote)) + replacement + baseText.slice(baseText.indexOf(overlapQuote) + overlapQuote.length);
    assert.equal(current?.content, expectedText);
    const currentDocuments = await persistence.read((db) => db.listDocuments(project.id));
    const currentScene = currentDocuments.find((document) => document.id === scene.id);
    assert.ok(currentScene?.headRevisionId);
    const states = await Promise.all(anchors.map(async (item) => ({
      item,
      anchor: await persistence.read((db) => db.getEvidenceAnchor(project.id, item.id)),
      mention: (await persistence.read((db) => db.listMentionLinks(project.id, item.id)))[0],
    })));
    for (const { anchor, mention } of states.filter(({ item }) => item.id !== anchors[1].id)) {
      assert.equal(anchor?.revisionId, currentScene.headRevisionId);
      assert.equal(anchor?.status, "confirmed");
      assert.equal(mention?.status, "confirmed");
      assert.equal(anchor?.quoteSha256, sha256(anchor === undefined ? "" : expectedText.slice(anchor.fromUtf16, anchor.toUtf16)));
    }
    const overlap = states.find(({ item }) => item.id === anchors[1].id);
    assert.equal(overlap?.anchor?.revisionId, currentScene.headRevisionId);
    assert.equal(overlap?.anchor?.status, "needs_review");
    assert.equal(overlap?.anchor?.quoteSha256, sha256(replacement));
    assert.equal(overlap?.mention?.status, "proposed");

    const unchangedRevisionId = currentScene.headRevisionId;
    const makeNextProposal = async (range, replacementText, id, mutateOperation) => {
      const nextReader = await core.reader(project.id);
      const nextContent = (await nextReader.read(manuscriptPath)).content;
      const trimmed = nextContent.trim();
      const nextInput = structuredClone(rawChangeSet);
      nextInput.id = `range-${id}`;
      nextInput.operations[0].id = `replace-${id}`;
      nextInput.operations[0].precondition.value = storyHash(trimmed);
      nextInput.operations[0].range = range;
      nextInput.operations[0].replacement = replacementText;
      nextInput.evidence[0].revision = (await nextReader.read(manuscriptPath)).revision;
      const nextGenerated = await buildNarrativeChangeProposal({ ...context, reader: nextReader }, nextInput);
      mutateOperation?.(nextGenerated.operations[0], nextContent);
      const nextProposal = { id: nextGenerated.coreProposalId, snapshot: nextReader.snapshot, operations: nextGenerated.operations, source: "module", evidence: nextGenerated.evidence };
      await core.propose(project.id, nextProposal);
      await core.approve(project.id, { proposalId: nextProposal.id, operationIds: [nextGenerated.operations[0].id], authorScope: "story-range-owner" });
      return nextGenerated.operations[0];
    };

    const latestText = current.content.trim();
    const invalidResult = await makeNextProposal(
      { start: latestText.indexOf("AFTER"), end: latestText.indexOf("AFTER") + 5 },
      "LATER",
      "invalid-result",
      (operation) => { operation.writes[0].content += "!"; },
    );
    await assert.rejects(core.apply(project.id, invalidResult), /supplied changes do not produce resultingSha256/u);
    assert.equal((await persistence.read((db) => db.getDocument(project.id, scene.id)))?.headRevisionId, unchangedRevisionId);

    const invalidOffset = await makeNextProposal(
      { start: latestText.indexOf("AFTER"), end: latestText.indexOf("AFTER") + 5 },
      "LATER",
      "invalid-offset",
      (operation, nextContent) => {
        operation.writes[0].textChanges[0] = {
          fromUtf16: nextContent.length + 2,
          toUtf16: nextContent.length + 2,
          insert: "LATER",
        };
      },
    );
    await assert.rejects(core.apply(project.id, invalidOffset), /Text offset is outside the revision/u);
    assert.equal((await persistence.read((db) => db.getDocument(project.id, scene.id)))?.headRevisionId, unchangedRevisionId);

    const legacyReader = await core.reader(project.id);
    const legacyBase = await legacyReader.read(manuscriptPath);
    const legacyOperation = {
      id: `legacy-${randomUUID()}`,
      generation: 0,
      projectId: project.id,
      baseProjectVersion: legacyReader.snapshot.projectVersion,
      effect: "manuscript",
      reads: [{ path: manuscriptPath, revision: legacyBase.revision }],
      writes: [{ path: manuscriptPath, revision: legacyBase.revision, content: "Legacy full-document proposal" }],
      message: "Legacy Story proposal",
    };
    const legacyProposalId = `legacy-${randomUUID()}`;
    await persistence.transaction((tx) => tx.saveModuleRecord({
      projectId: project.id,
      moduleId: "core.authority.proposals",
      key: `proposal:${legacyProposalId}`,
      value: {
        proposal: { id: legacyProposalId, snapshot: legacyReader.snapshot, operations: [legacyOperation], source: "module" },
        state: "approved",
        approvedOperationIds: [legacyOperation.id],
        approvedByOperationId: { [legacyOperation.id]: "legacy-owner" },
        applications: [],
        appliedOperationIds: [],
        stale: false,
      },
      expectedVersion: null,
    }));
    await core.apply(project.id, legacyOperation);
    assert.equal((await core.readScene(project.id, "s1")).text, "Legacy full-document proposal");
  } finally {
    await persistence.close();
  }
});
