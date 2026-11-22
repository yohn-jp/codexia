import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import type { ChangeProposal, ModuleActionContext, ModuleContext, SnapshotId } from "@codexia/contracts";
import type { DocumentId } from "@codexia/persistence-contracts";
import { createPostgresPersistence, migratePostgresDatabase } from "@codexia/persistence-postgres";
import { readCanonicalSnapshotEntities } from "@codexia/module-nlp";
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

  const createHierarchy = async (input: Parameters<CoreStore["buildCreateHierarchyOperation"]>[1]) => {
    const built = await core!.buildCreateHierarchyOperation(project.id, input);
    const proposal: ChangeProposal = {
      id: randomUUID(),
      snapshot: built.snapshot,
      source: "author",
      operations: [built.operation],
    };
    await core!.propose(project.id, proposal);
    await core!.approve(project.id, {
      proposalId: proposal.id,
      operationIds: [built.operation.id],
      authorScope: "owner",
    });
    await core!.apply(project.id, built.operation);
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
