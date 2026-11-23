import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import type { ModuleActionContext, ModuleContext, SnapshotId } from "@codexia/contracts";
import type { DocumentId } from "@codexia/persistence-contracts";
import { createPostgresPersistence, migratePostgresDatabase } from "@codexia/persistence-postgres";
import { readCanonicalSnapshotEntities } from "@codexia/module-nlp";
import { createStoryActions } from "@codexia/module-story";
import { CoreStore } from "../../../packages/core/src/index.js";
import { createSemanticActions } from "./actions.js";
import {
  EMBEDDING_DIMENSIONS,
  EMBEDDING_MODEL_ID,
  EMBEDDING_MODEL_VERSION,
  type SemanticEmbeddingCapability,
  type SemanticPassage,
} from "./contracts.js";

const connectionString = process.env.CODEXIA_TEST_DATABASE_URL;
const persistence = connectionString ? createPostgresPersistence(connectionString) : undefined;
const core = persistence ? new CoreStore({ persistence }) : undefined;

if (connectionString && persistence) {
  before(() => migratePostgresDatabase(connectionString));
  after(() => persistence.close());
}

test("PostgreSQL semantic search and index passages include native scenes but exclude notes", {
  skip: !connectionString,
}, async () => {
  const project = await core!.createProject({ title: "Semantic Snapshot " + randomUUID() });

  const createHierarchy = async (input: Parameters<CoreStore["proposeHierarchyCreate"]>[1]) => {
    const { snapshot } = await core!.observe(project.id);
    const { changeSet } = await core!.proposeHierarchyCreate(project.id, input, {
      projectVersion: snapshot.projectVersion, actorId: "owner", idempotencyKey: randomUUID(),
    });
    const approved = await persistence!.transaction(tx => tx.approveChangeSet({
      projectId: project.id, changeSetId: changeSet.id, expectedVersion: changeSet.version, approvedBy: "owner",
    }));
    await persistence!.transaction(tx => tx.applyChangeSet({
      projectId: project.id, changeSetId: changeSet.id, expectedVersion: approved.version,
    }));
  };

  await createHierarchy({ kind: "volume", id: "legacy-volume", title: "Legacy volume" });
  await createHierarchy({ kind: "chapter", id: "legacy-chapter", title: "Legacy chapter", volumeId: "legacy-volume" });
  const legacySceneMarkdown = "---\nInterlude\n---\nQuartz legacy passage remains searchable.";
  await createHierarchy({
    kind: "scene",
    id: "legacy-scene",
    title: "Legacy scene",
    volumeId: "legacy-volume",
    chapterId: "legacy-chapter",
    manuscriptBody: legacySceneMarkdown,
  });

  const chapter = (await persistence!.read((reader) => reader.listDocuments(project.id)))
    .find((document) => document.kind === "chapter")!;
  const nativeDocumentId = randomUUID() as DocumentId;
  const noteDocumentId = randomUUID() as DocumentId;
  const nativeSceneMarkdown = "---\nInterlude\n---\nQuartz native passage is searchable too.";
  await persistence!.transaction(async (transaction) => {
    await transaction.createDocument({
      projectId: project.id,
      documentId: nativeDocumentId,
      kind: "scene",
      parentId: chapter.id,
      title: "Native scene",
      orderKey: "0002",
      markdown: nativeSceneMarkdown,
      authorId: "owner",
      idempotencyKey: randomUUID(),
    });
    await transaction.createDocument({
      projectId: project.id,
      documentId: noteDocumentId,
      kind: "note",
      parentId: nativeDocumentId,
      title: "Quartz research note",
      orderKey: "0001",
      markdown: "---\ntype: scene\n---\nQuartz private note must stay out of scene search.",
      authorId: "owner",
      idempotencyKey: randomUUID(),
    });
  });

  const reader = await core!.reader(project.id);
  const nativeStoryDocuments = reader.nativeStoryDocuments;
  assert.ok(nativeStoryDocuments);
  assert.equal(nativeStoryDocuments.length, 4, "only the volume, chapter and two scenes have typed hierarchy rows");
  const hierarchyPaths = new Set(nativeStoryDocuments.map((document) => document.metadataPath));
  const canonicalEntities = await readCanonicalSnapshotEntities({
    snapshot: reader.snapshot,
    nativeStoryDocuments,
    list: (prefix) => reader.list(prefix),
    async read(path, encoding) {
      assert.ok(!hierarchyPaths.has(path), `hierarchy metadata already came from the pinned projection: ${path}`);
      return reader.read(path, encoding);
    },
  }, new AbortController().signal);
  assert.equal(canonicalEntities.find((entity) => entity.id === nativeDocumentId)?.type, "scene");
  assert.equal(canonicalEntities.some((entity) => entity.raw.id === noteDocumentId), false,
    "a note projected under a scene-shaped path must not enter the canonical scene/entity set");
  const legacyEntityId = "ms-legacy-volume-legacy-chapter-legacy-scene";
  assert.equal(canonicalEntities.find((entity) => entity.id === legacyEntityId)?.body, legacySceneMarkdown);
  const nativeEntityId = "doc-" + nativeDocumentId;
  const notePath = "documents/" + noteDocumentId + ".md";
  const nativePath = "documents/" + nativeDocumentId + ".md";
  assert.equal(canonicalEntities.find((entity) => entity.id === nativeEntityId)?.body, nativeSceneMarkdown,
    "native Markdown that resembles a YAML front matter block must remain intact as scene body text");
  let indexedSnapshot: SnapshotId | undefined;
  let indexedPassages: readonly SemanticPassage[] = [];

  const embedding = {
    model: { id: EMBEDDING_MODEL_ID, version: EMBEDDING_MODEL_VERSION, dimensions: EMBEDDING_DIMENSIONS },
    async index(passages: readonly SemanticPassage[], snapshot: SnapshotId) {
      indexedSnapshot = snapshot;
      indexedPassages = [...passages];
      return {
        snapshot,
        model: EMBEDDING_MODEL_ID,
        modelVersion: EMBEDDING_MODEL_VERSION,
        dimensions: EMBEDDING_DIMENSIONS,
        scanned: passages.length,
        embedded: 0,
        reused: 0,
        removed: 0,
      };
    },
    async nearest(_query: string, snapshot: SnapshotId) {
      return {
        snapshot,
        model: EMBEDDING_MODEL_ID,
        modelVersion: EMBEDDING_MODEL_VERSION,
        dimensions: EMBEDDING_DIMENSIONS,
        hits: [],
      };
    },
  } as unknown as SemanticEmbeddingCapability;
  const moduleContext = {
    async acquireCapability(id: string) {
      assert.equal(id, "semantic.embedding");
      return { value: embedding, async release() {} };
    },
  } as unknown as ModuleContext;
  const actionContext = {
    projectId: project.id,
    reader,
    signal: new AbortController().signal,
  } as unknown as ModuleActionContext;
  const actions = createSemanticActions(moduleContext);
  const search = await actions.find((action) => action.id === "semantic.search")!.invoke({
    query: "quartz",
    mode: "scene",
    limit: 10,
    rerank: false,
  }, actionContext);
  assert.equal(search.ok, true, "semantic.search should use the PostgreSQL snapshot");

  const index = await actions.find((action) => action.id === "semantic.index.rebuild")!.invoke({
    taskId: "issue-373-postgres",
  }, actionContext);
  assert.equal(index.ok, true, "semantic.index.rebuild should accept the same PostgreSQL snapshot");

  const searchData = search.data as {
    results: Array<{ sceneId: string; filePath?: string; snippet?: string }>;
  };
  const searched = new Map(searchData.results.map((result) => [result.sceneId, result]));
  assert.deepEqual([...searched.keys()].sort(), [legacyEntityId, nativeEntityId].sort());
  assert.match(searched.get(legacyEntityId)?.snippet ?? "", /Quartz legacy passage/);
  assert.equal(searched.get(nativeEntityId)?.filePath, nativePath);
  assert.match(searched.get(nativeEntityId)?.snippet ?? "", /Quartz native passage/);
  assert.equal([...searched.values()].some((result) => result.filePath === notePath), false);

  assert.deepEqual(search.snapshot, reader.snapshot);
  assert.deepEqual(index.snapshot, reader.snapshot);
  assert.deepEqual(indexedSnapshot, reader.snapshot);
  const indexedIds = [...new Set(indexedPassages.map((passage) => passage.entityId))].sort();
  assert.deepEqual(indexedIds, [legacyEntityId, nativeEntityId].sort());
  assert.equal(new Set(indexedIds).size, 2, "legacy and native scene IDs must not collide");
  const nativePassage = indexedPassages.find((passage) => passage.filePath === nativePath && /Quartz native passage/.test(passage.text));
  assert.ok(nativePassage && /Quartz native passage/.test(nativePassage.text));
  assert.equal(nativePassage.type, "scene");
  assert.equal(indexedPassages.some((passage) => passage.filePath === notePath || /private note/.test(passage.text)), false);
});

test("Story edits only current characters and NLP excludes preserved characters", {
  skip: !connectionString,
}, async () => {
  const project = await core!.createProject({ title: "Story archive isolation " + randomUUID() });
  const currentPath = "bible/characters/char-collision/profile.yaml";
  const separatePath = "bible/characters/char-separate/profile.yaml";
  const archiveRoot = "meta/scriptorium/modules/story/legacy/files/bible/characters/";
  const archivedCollisionPath = archiveRoot + "char-collision/profile.yaml";
  const archiveOnlyPath = archiveRoot + "char-archive-only/profile.yaml";
  const files = new Map([
    [currentPath, "id: char-collision\ntype: character\nname: Current character\n"],
    [separatePath, "id: char-separate\ntype: character\nname: Separate character\n"],
    [archivedCollisionPath, "id: char-collision\ntype: character\nname: Preserved old character\n"],
    [archiveOnlyPath, "id: char-archive-only\ntype: character\nname: Preserved only character\n"],
  ]);
  const moduleId = "core.artifacts";
  await persistence!.transaction(async (transaction) => {
    for (const [key, content] of files) {
      await transaction.saveModuleRecord({
        projectId: project.id, moduleId, key, value: { content, encoding: "utf8" }, expectedVersion: null,
      });
    }
  });

  const signal = new AbortController().signal;
  const actions = createStoryActions({
    cacheDirectory: "/unused/story-archive-test",
    signal,
    async acquireCapability() { throw new Error("Story character actions require no capability"); },
    async createWorkerService() { throw new Error("Story character actions require no worker"); },
  });
  async function invoke(actionId: string, input: unknown) {
    const reader = await core!.reader(project.id);
    const context: ModuleActionContext = {
      projectId: project.id,
      reader,
      signal,
      async invoke() { throw new Error("Unexpected delegated action"); },
      async linkedReader() { throw new Error("Unexpected linked reader"); },
      async listActions() { return []; },
      async runJob() { throw new Error("Unexpected job"); },
      async propose(operations) {
        return core!.propose(project.id, { id: randomUUID(), snapshot: reader.snapshot, source: "module", operations });
      },
    };
    return actions.find((action) => action.id === actionId)!.invoke(input, context);
  }
  const artifact = (path: string) => persistence!.read((reader) => reader.getModuleRecord(project.id, moduleId, path));
  const archivedCollision = await artifact(archivedCollisionPath);
  const archiveOnly = await artifact(archiveOnlyPath);
  assert.ok(archivedCollision && archiveOnly);

  for (const [id, path, name] of [
    ["char-collision", currentPath, "Edited current character"],
    ["char-separate", separatePath, "Edited separate character"],
  ] as const) {
    const prior = await invoke("story.entities.get", { id });
    assert.ok(prior.ok && prior.data);
    const { revision } = prior.data as { revision: string };
    const proposed = await invoke("story.entities.update", { id, patch: { name }, base_revision: revision });
    assert.ok(proposed.ok && proposed.proposals?.length === 1);
    const proposal = proposed.proposals[0]!;
    const operation = proposal.operations[0]!;
    await core!.approve(project.id, { proposalId: proposal.id, operationIds: [operation.id], authorScope: "owner" });
    await core!.apply(project.id, operation);
    assert.deepEqual(operation.writes.map((write) => write.path), [path]);
    assert.match(String((await artifact(path))?.value.content), new RegExp(`^name: ${name}$`, "m"));
    const updated = await invoke("story.entities.get", { id });
    assert.ok(updated.ok);
    assert.equal((updated.data as { name: string }).name, name);
  }

  const missing = await invoke("story.entities.get", { id: "char-archive-only" });
  assert.ok(missing.ok);
  assert.equal(missing.data, null);
  const blocked = await invoke("story.entities.update", { id: "char-archive-only", patch: { name: "Must not be written" } });
  assert.ok(!blocked.ok);
  assert.match(blocked.error.message, /Entity not found/);
  assert.deepEqual(await artifact(archivedCollisionPath), archivedCollision);
  assert.deepEqual(await artifact(archiveOnlyPath), archiveOnly);

  const entities = await readCanonicalSnapshotEntities(await core!.reader(project.id), signal);
  assert.deepEqual(entities.filter((entity) => entity.type === "character").map(({ id, name, filePath }) => ({ id, name, filePath })), [
    { id: "char-collision", name: "Edited current character", filePath: currentPath },
    { id: "char-separate", name: "Edited separate character", filePath: separatePath },
  ]);
});
