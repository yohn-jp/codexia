import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { test } from "node:test";

import { CoreStore } from "../../packages/core/dist/index.js";
import { createPostgresPersistence, migratePostgresDatabase } from "../../packages/persistence-postgres/dist/index.js";
import { buildNarrativeChangeProposal } from "../../modules/story/dist/narrativeChangeSet.js";
import { buildSceneLocationInfos, createStoryActions, readStorySnapshot } from "../../modules/story/dist/index.js";

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

test("Story hierarchy and reader disclosures follow PostgreSQL ordering on each snapshot", async () => {
  await migratePostgresDatabase(databaseUrl);
  const persistence = createPostgresPersistence(databaseUrl);
  const core = new CoreStore({ persistence });
  try {
    const project = await core.createProject({ title: `Story order authority ${randomUUID()}` });
    const ids = {
      rootScene: "10000000-0000-4000-8000-000000000001",
      volumeLong: "30000000-0000-4000-8000-000000000001",
      volumeShort: "30000000-0000-4000-8000-000000000002",
      chapterSelected: "40000000-0000-4000-8000-000000000001",
      chapterLater: "40000000-0000-4000-8000-000000000002",
      chapterOtherVolume: "40000000-0000-4000-8000-000000000003",
      sceneEarly: "50000000-0000-4000-8000-000000000001",
      sceneShort: "50000000-0000-4000-8000-000000000002",
      sceneTieCanonicalFirst: "50000000-0000-4000-8000-000000000003",
      sceneTieCanonicalSecond: "50000000-0000-4000-8000-000000000004",
      sceneLaterChapter: "50000000-0000-4000-8000-000000000005",
      sceneOtherVolume: "50000000-0000-4000-8000-000000000006",
    };
    const logicalIds = {
      rootScene: "root-scene",
      volumeLong: "vol-long-key",
      volumeShort: "vol-short-key",
      chapterSelected: "chapter-selected",
      chapterLater: "chapter-later",
      chapterOtherVolume: "chapter-other-volume",
      sceneEarly: "scene-early",
      sceneShort: "scene-short",
      sceneTieCanonicalFirst: "scene-tie-z",
      sceneTieCanonicalSecond: "scene-tie-a",
      sceneLaterChapter: "scene-later-chapter",
      sceneOtherVolume: "scene-other-volume",
    };
    const manuscripts = new Map([
      ["sceneEarly", "Aster first appears here."],
      ["sceneShort", "Aster also appears here."],
      ["sceneTieCanonicalFirst", "Aster appears in the first database tie."],
      ["sceneTieCanonicalSecond", "Aster appears in the second database tie."],
      ["sceneLaterChapter", "Cinder appears after the selected chapter."],
      ["sceneOtherVolume", "No named entity appears here."],
      ["rootScene", "An opening with no registered name."],
    ]);
    const documentIdsByLogicalId = new Map(Object.entries(logicalIds).map(([key, logicalId]) => [logicalId, ids[key]]));

    await persistence.transaction(async (tx) => {
      const create = async ({ key, kind, title, orderKey, parentKey = null, metadataName, body = "" }) => {
        const documentId = ids[key];
        const logicalId = logicalIds[key];
        const parentId = parentKey ? ids[parentKey] : null;
        const document = (await tx.createDocument({
          projectId: project.id,
          documentId,
          ...(parentId ? { parentId } : {}),
          kind,
          title,
          orderKey,
          markdown: body,
          authorId: "story-order-owner",
          idempotencyKey: `story-order-${key}`,
        })).document;
        const volumeKey = kind === "volume"
          ? key
          : kind === "chapter"
            ? parentKey
            : parentKey === "chapterOtherVolume"
              ? "volumeShort"
              : "volumeLong";
        const volumeLogicalId = volumeKey ? logicalIds[volumeKey] : "root";
        const chapterLogicalId = kind === "chapter"
          ? logicalId
          : parentKey === "chapterSelected" || parentKey === "chapterLater" || parentKey === "chapterOtherVolume"
            ? logicalIds[parentKey]
            : null;
        const metadataPath = kind === "volume"
          ? `plot/volumes/${logicalId}/volume.yaml`
          : kind === "chapter"
            ? `plot/volumes/${volumeLogicalId}/chapters/${logicalId}/chapter.yaml`
          : parentKey
              ? `plot/volumes/${volumeLogicalId}/chapters/${chapterLogicalId}/scenes/${logicalId}.yaml`
              : `plot/volumes/root/chapters/root/scenes/${logicalId}.yaml`;
        const manuscriptPath = kind === "scene" ? `manuscript/${logicalId}.md` : undefined;
        await tx.saveModuleRecord({
          projectId: project.id,
          moduleId: "core.document-paths",
          key: document.id,
          value: {
            metadataPath,
            ...(manuscriptPath ? { manuscriptPath } : {}),
            metadata: { id: logicalId, ...(metadataName ? { name: metadataName } : {}) },
          },
          expectedVersion: null,
        });
      };

      await create({ key: "rootScene", kind: "scene", title: "Root", orderKey: "0000000002", body: manuscripts.get("rootScene") });
      await create({ key: "volumeLong", kind: "volume", title: "Long key", orderKey: "0000000002" });
      await create({ key: "volumeShort", kind: "volume", title: "Short key", orderKey: "00000001" });
      await create({ key: "chapterSelected", kind: "chapter", title: "Selected", orderKey: "0000000002", parentKey: "volumeLong" });
      await create({ key: "chapterLater", kind: "chapter", title: "Later", orderKey: "00000001", parentKey: "volumeLong" });
      await create({ key: "chapterOtherVolume", kind: "chapter", title: "Other volume", orderKey: "00000001", parentKey: "volumeShort" });
      await create({ key: "sceneEarly", kind: "scene", title: "Scene early key", orderKey: "0000000002", parentKey: "chapterSelected", body: manuscripts.get("sceneEarly") });
      await create({ key: "sceneShort", kind: "scene", title: "Scene short key", orderKey: "00000001", parentKey: "chapterSelected", body: manuscripts.get("sceneShort") });
      await create({ key: "sceneTieCanonicalFirst", kind: "scene", title: "Tie canonical first", orderKey: "same", parentKey: "chapterSelected", metadataName: "Z display title", body: manuscripts.get("sceneTieCanonicalFirst") });
      await create({ key: "sceneTieCanonicalSecond", kind: "scene", title: "Tie canonical second", orderKey: "same", parentKey: "chapterSelected", metadataName: "A display title", body: manuscripts.get("sceneTieCanonicalSecond") });
      await create({ key: "sceneLaterChapter", kind: "scene", title: "Later chapter scene", orderKey: "0000000001", parentKey: "chapterLater", body: manuscripts.get("sceneLaterChapter") });
      await create({ key: "sceneOtherVolume", kind: "scene", title: "Other volume scene", orderKey: "0000000001", parentKey: "chapterOtherVolume", body: manuscripts.get("sceneOtherVolume") });
      await tx.saveModuleRecord({
        projectId: project.id,
        moduleId: "core.artifacts",
        key: "bible/characters/char-aster/profile.yaml",
        value: { content: "id: char-aster\nname: Aster\ntype: character\n", encoding: "utf8" },
        expectedVersion: null,
      });
      await tx.saveModuleRecord({
        projectId: project.id,
        moduleId: "core.artifacts",
        key: "bible/characters/char-cinder/profile.yaml",
        value: { content: "id: char-cinder\nname: Cinder\ntype: character\n", encoding: "utf8" },
        expectedVersion: null,
      });
    });

    const moduleContext = {
      cacheDirectory: "/unused/story-order-acceptance",
      signal: new AbortController().signal,
      async acquireCapability() { throw new Error("Unexpected Story capability request"); },
      async createWorkerService() { throw new Error("Unexpected Story worker request"); },
    };
    const actions = createStoryActions(moduleContext);
    assert.ok(!actions.some((action) => action.id === "story.entities.reorder"), "hierarchy reorder is owned by Core");
    async function invoke(actionId, input, reader) {
      const action = actions.find((item) => item.id === actionId);
      assert.ok(action, `Story action is missing: ${actionId}`);
      const context = {
        projectId: project.id,
        reader,
        async invoke() { throw new Error("Unexpected delegated Story action"); },
        async listActions() { return []; },
        async linkedReader() { throw new Error("Unexpected linked project read"); },
        signal: new AbortController().signal,
        async propose() { throw new Error("Story hierarchy and reader actions are read-only"); },
        async runJob() { throw new Error("Unexpected Story job"); },
      };
      const result = await action.invoke(input, context);
      assert.equal(result.ok, true, result.ok ? undefined : `${result.error.code}: ${result.error.message}`);
      return result;
    }
    async function assertStoryMatchesPostgres(reader) {
      const database = await persistence.read(async (db) => {
        const projectRecord = await db.getProject(project.id);
        const documents = await db.listDocuments(project.id, undefined, 1000);
        return { projectRecord, documents };
      });
      assert.equal(reader.snapshot.projectVersion, database.projectRecord.version);
      const byParent = new Map();
      for (const document of database.documents) {
        const key = document.parentId ?? "<root>";
        const siblings = byParent.get(key) ?? [];
        siblings.push(document);
        byParent.set(key, siblings);
      }
      const story = await readStorySnapshot(reader, { includeManuscripts: true });
      const tree = (await invoke("story.volumes.tree", {}, reader)).data.tree;
      const rootDocuments = byParent.get("<root>") ?? [];
      assert.deepEqual(tree.map(({ volume }) => documentIdsByLogicalId.get(volume.id)),
        rootDocuments.filter((document) => document.kind === "volume").map((document) => document.id));
      for (const { volume, chapters } of tree) {
        const volumeDocumentId = documentIdsByLogicalId.get(volume.id);
        assert.ok(volumeDocumentId);
        const expectedChapters = (byParent.get(volumeDocumentId) ?? []).filter((document) => document.kind === "chapter");
        assert.deepEqual(chapters.map(({ chapter }) => documentIdsByLogicalId.get(chapter.id)), expectedChapters.map((document) => document.id));
        for (const { chapter, scenes } of chapters) {
          const chapterDocumentId = documentIdsByLogicalId.get(chapter.id);
          assert.ok(chapterDocumentId);
          const expectedScenes = (byParent.get(chapterDocumentId) ?? []).filter((document) => document.kind === "scene");
          assert.deepEqual(scenes.map((scene) => documentIdsByLogicalId.get(scene.id)), expectedScenes.map((document) => document.id));
        }
      }
      const expectedSceneIds = [];
      for (const document of rootDocuments) {
        if (document.kind === "scene") expectedSceneIds.push(document.id);
        if (document.kind !== "volume") continue;
        for (const chapter of (byParent.get(document.id) ?? []).filter((candidate) => candidate.kind === "chapter")) {
          for (const scene of (byParent.get(chapter.id) ?? []).filter((candidate) => candidate.kind === "scene")) expectedSceneIds.push(scene.id);
        }
      }
      const storySceneIds = buildSceneLocationInfos(story).data.map(({ sceneId }) => documentIdsByLogicalId.get(sceneId));
      assert.deepEqual(storySceneIds, expectedSceneIds);
      return { story, tree, database };
    }

    const initialReader = await core.reader(project.id);
    const initial = await assertStoryMatchesPostgres(initialReader);
    const selected = (await invoke("story.reader-model.build", { chapterId: logicalIds.chapterSelected }, initialReader)).data;
    assert.equal(selected.disclosures.find((item) => item.entityId === "char-aster")?.sceneId, logicalIds.sceneEarly);
    assert.ok(!selected.disclosures.some((item) => item.entityId === "char-cinder"), "later chapter disclosures stay beyond the selected chapter boundary");
    assert.equal(selected.firstReadReaction, null);

    const reorderedIds = initial.tree.find(({ volume }) => volume.id === logicalIds.volumeLong)
      .chapters.find(({ chapter }) => chapter.id === logicalIds.chapterSelected)
      .scenes.map((scene) => scene.id).reverse();
    const { snapshot, operation } = await core.buildReorderHierarchyOperation(project.id, {
      kind: "scene",
      volumeId: logicalIds.volumeLong,
      chapterId: logicalIds.chapterSelected,
      orderedIds: reorderedIds,
    }, initialReader.snapshot);
    assert.deepEqual(snapshot, initialReader.snapshot);
    const proposal = await core.propose(project.id, {
      id: randomUUID(),
      snapshot,
      operations: [operation],
      source: "author",
    });
    assert.deepEqual((await core.observe(project.id)).snapshot, initialReader.snapshot);
    await core.approve(project.id, {
      proposalId: proposal.id,
      operationIds: [operation.id],
      authorScope: "story-order-owner",
    });
    await core.apply(project.id, operation);

    const afterReader = await core.reader(project.id);
    const after = await assertStoryMatchesPostgres(afterReader);
    assert.deepEqual(after.tree.find(({ volume }) => volume.id === logicalIds.volumeLong)
      .chapters.find(({ chapter }) => chapter.id === logicalIds.chapterSelected)
      .scenes.map((scene) => scene.id), reorderedIds);
    const afterSelected = (await invoke("story.reader-model.build", { chapterId: logicalIds.chapterSelected }, afterReader)).data;
    assert.equal(afterSelected.disclosures.find((item) => item.entityId === "char-aster")?.sceneId, logicalIds.sceneTieCanonicalSecond);
    assert.ok(!afterSelected.disclosures.some((item) => item.entityId === "char-cinder"), "post-reorder reader disclosures remain inside the selected chapter boundary");
    assert.equal(afterReader.snapshot.projectVersion, initialReader.snapshot.projectVersion + 1);
  } finally {
    await persistence.close();
  }
});
