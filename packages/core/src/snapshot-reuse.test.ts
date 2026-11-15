import assert from "node:assert/strict";
import type { SnapshotReader } from "@codexia/contracts";
import { createHash, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import type {
  AssertionId,
  DocumentId,
  EvidenceId,
  JsonObject,
  KnowledgeAliasId,
  KnowledgeNodeId,
  KnowledgeRelationId,
  Persistence,
  PersistenceReader,
  PersistenceTransaction,
  ProjectId,
} from "@codexia/persistence-contracts";
import { createPostgresPersistence, migratePostgresDatabase } from "@codexia/persistence-postgres";
import { CoreStore } from "./index.js";
import YAML from "yaml";

const connectionString = process.env.CODEXIA_TEST_DATABASE_URL;
if (!connectionString) throw new Error("CODEXIA_TEST_DATABASE_URL is required for Core PostgreSQL snapshot reuse tests");
const persistence = createPostgresPersistence(connectionString);
const core = new CoreStore({ persistence });

before(() => migratePostgresDatabase(connectionString));
after(() => persistence.close());

async function createProject() {
  return core.createProject({ title: "Snapshot reuse " + randomUUID() });
}

function countSnapshotReads(base: Persistence, afterSnapshotMiss: () => Promise<void>) {
  const counts: Record<string, number> = {
    transactions: 0,
    listDocuments: 0,
    getDocumentHeadRevisions: 0,
    listModuleRecords: 0,
    snapshotMisses: 0,
  };
  const instrumented = new Proxy(base, {
    get(target, property, receiver) {
      if (property === "read") {
        return <T>(work: (reader: PersistenceReader) => Promise<T>) => target.read((reader) => {
          const trackedReader = new Proxy(reader, {
            get(readerTarget, readerProperty, readerReceiver) {
              const method = Reflect.get(readerTarget, readerProperty, readerReceiver);
              if (typeof method !== "function") return method;
              if (readerProperty === "getModuleRecord") {
                return async (...args: Parameters<PersistenceReader["getModuleRecord"]>) => {
                  const record = await readerTarget.getModuleRecord(...args);
                  if (args[1] === "core.authority.snapshots" && !record) {
                    counts.snapshotMisses = (counts.snapshotMisses ?? 0) + 1;
                    await afterSnapshotMiss();
                  }
                  return record;
                };
              }
              if (readerProperty === "listDocuments" || readerProperty === "getDocumentHeadRevisions" || readerProperty === "listModuleRecords") {
                return (...args: unknown[]) => {
                  const key = String(readerProperty);
                  counts[key] = (counts[key] ?? 0) + 1;
                  return Reflect.apply(method, readerTarget, args);
                };
              }
              return method.bind(readerTarget);
            },
          });
          return work(trackedReader);
        });
      }
      if (property === "transaction") {
        return <T>(work: (transaction: PersistenceTransaction) => Promise<T>) => {
          counts.transactions = (counts.transactions ?? 0) + 1;
          return target.transaction(work);
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as Persistence;
  return { persistence: instrumented, counts };
}

test("current reads reuse the durable snapshot, concurrent cold builders agree, and pinned reads survive restart", async () => {
  const project = await createProject();
  let releaseMisses!: () => void;
  const bothMisses = new Promise<void>((resolve) => { releaseMisses = resolve; });
  let observedMisses = 0;
  const instrumented = countSnapshotReads(persistence, async () => {
    observedMisses++;
    if (observedMisses === 2) releaseMisses();
    await bothMisses;
  });
  const store = new CoreStore({ persistence: instrumented.persistence });
  const concurrent = await Promise.all([
    store.readTreeSnapshot(project.id),
    store.readTreeSnapshot(project.id),
  ]);
  assert.deepEqual(concurrent[0], concurrent[1]);
  assert.equal(instrumented.counts.snapshotMisses, 2);
  const durable = await persistence.read((reader) =>
    reader.getModuleRecord(project.id as ProjectId, "core.authority.snapshots", "snapshot:" + concurrent[0]!.snapshot.projectVersion));
  assert.ok(durable);

  const beforeWarm = { ...instrumented.counts };
  assert.deepEqual(await store.readTreeSnapshot(project.id), concurrent[0]);
  assert.equal((await store.writingStatsSnapshot(project.id)).stats.totalCharCount, 0);
  for (const key of ["transactions", "listDocuments", "getDocumentHeadRevisions", "listModuleRecords"] as const) {
    assert.equal(instrumented.counts[key], beforeWarm[key], "warm current reads must not repeat " + key);
  }

  await persistence.transaction((transaction) => transaction.updateProject({
    projectId: project.id as ProjectId,
    expectedVersion: concurrent[0]!.snapshot.projectVersion,
    title: "Updated snapshot title",
  }));
  const current = await store.readTreeSnapshot(project.id);
  assert.equal(current.snapshot.projectVersion, concurrent[0]!.snapshot.projectVersion + 1);
  assert.equal(current.tree.title, "Updated snapshot title");

  const restartedPersistence = createPostgresPersistence(connectionString);
  try {
    const restartedStore = new CoreStore({ persistence: restartedPersistence });
    assert.deepEqual(await restartedStore.readTreeSnapshot(project.id, concurrent[0]!.snapshot), concurrent[0]);
    assert.deepEqual(await restartedStore.readTreeSnapshot(project.id), current);
  } finally {
    await restartedPersistence.close();
  }
});

test("every persisted snapshot dependency advances the project version, while authority records do not", async () => {
  const project = await createProject();
  let currentVersion = project.version;
  const commitDependency = async <T>(write: (transaction: PersistenceTransaction) => Promise<T>): Promise<T> => {
    const result = await persistence.transaction(write);
    const savedProject = await persistence.read((reader) => reader.getProject(project.id as ProjectId));
    assert.equal(savedProject?.version, currentVersion + 1);
    currentVersion = savedProject!.version;
    const snapshot = await core.reader(project.id);
    assert.equal(snapshot.snapshot.projectVersion, currentVersion);
    assert.equal((await persistence.read((reader) => reader.getProject(project.id as ProjectId)))?.version, currentVersion,
      "saving the immutable snapshot must not advance the content version");
    return result;
  };
  const createDocument = (
    transaction: PersistenceTransaction,
    kind: string,
    parentId: DocumentId | null,
    title: string,
    markdown: string,
  ) => transaction.createDocument({
    projectId: project.id as ProjectId,
    kind,
    parentId,
    title,
    orderKey: "0000000001",
    markdown,
    authorId: "synthetic-author",
    idempotencyKey: randomUUID(),
  });

  const volume = await commitDependency((transaction) => createDocument(transaction, "volume", null, "Volume", ""));
  const chapter = await commitDependency((transaction) => createDocument(transaction, "chapter", volume.document.id, "Chapter", ""));
  const scene = await commitDependency((transaction) => createDocument(transaction, "scene", chapter.document.id, "Scene", "東京 😀\n"));

  await commitDependency((transaction) => transaction.updateProject({
    projectId: project.id as ProjectId,
    expectedVersion: currentVersion,
    title: "Changed project metadata",
  }));
  await commitDependency((transaction) => transaction.updateDocument({
    projectId: project.id as ProjectId,
    documentId: scene.document.id,
    expectedVersion: scene.document.version,
    title: "Changed scene title",
  }));
  const pathRecord = await commitDependency((transaction) => transaction.saveModuleRecord({
    projectId: project.id as ProjectId,
    moduleId: "core.document-paths",
    key: scene.document.id,
    value: {
      metadataPath: "plot/volumes/v1/chapters/c1/scenes/s1.yaml",
      manuscriptPath: "manuscript/v1/c1/s1.md",
      metadata: { id: "scene-logical" },
    },
    expectedVersion: null,
  }));
  assert.equal((await (await core.reader(project.id)).read("manuscript/v1/c1/s1.md"))?.content, "東京 😀\n");
  await commitDependency((transaction) => transaction.saveModuleRecord({
    projectId: project.id as ProjectId,
    moduleId: "core.document-paths",
    key: scene.document.id,
    value: {
      metadataPath: "plot/volumes/v1/chapters/c1/scenes/s1.yaml",
      manuscriptPath: "manuscript/v1/c1/s1.md",
      metadata: { id: "scene-logical-updated" },
    },
    expectedVersion: pathRecord.version,
  }));

  const nextMarkdown = "新しい東京 😀\n";
  const saved = await commitDependency((transaction) => transaction.saveDocument({
    projectId: project.id as ProjectId,
    documentId: scene.document.id,
    baseRevisionId: scene.revision.id,
    changes: [{ fromUtf16: 0, toUtf16: scene.revision.markdown.length, insert: nextMarkdown }],
    resultingSha256: createHash("sha256").update(nextMarkdown).digest("hex"),
    authorId: "synthetic-author",
    clientId: "snapshot-reuse-test",
    idempotencyKey: randomUUID(),
  }));
  const artifactRecord = await commitDependency((transaction) => transaction.saveModuleRecord({
    projectId: project.id as ProjectId,
    moduleId: "core.artifacts",
    key: "assets/synthetic.txt",
    value: { content: "Synthetic artifact" },
    expectedVersion: null,
  }));
  assert.equal((await (await core.reader(project.id)).read("assets/synthetic.txt"))?.content, "Synthetic artifact");
  await commitDependency((transaction) => transaction.saveModuleRecord({
    projectId: project.id as ProjectId,
    moduleId: "core.artifacts",
    key: "assets/synthetic.txt",
    value: { content: "Updated synthetic artifact" },
    expectedVersion: artifactRecord.version,
  }));

  const nodeId = randomUUID() as KnowledgeNodeId;
  const otherNodeId = randomUUID() as KnowledgeNodeId;
  const node = await commitDependency((transaction) => transaction.saveKnowledgeNode({
    projectId: project.id as ProjectId, id: nodeId, type: "lore", name: "Synthetic node",
    attributes: {}, status: "confirmed", expectedVersion: null,
  }));
  await commitDependency((transaction) => transaction.saveKnowledgeNode({
    projectId: project.id as ProjectId, id: otherNodeId, type: "lore", name: "Other synthetic node",
    attributes: {}, status: "confirmed", expectedVersion: null,
  }));
  await commitDependency((transaction) => transaction.saveKnowledgeNode({
    projectId: project.id as ProjectId, id: nodeId, type: "lore", name: "Updated synthetic node",
    attributes: {}, status: "confirmed", expectedVersion: node.version,
  }));
  const aliasId = randomUUID() as KnowledgeAliasId;
  await commitDependency((transaction) => transaction.saveKnowledgeAlias({
    projectId: project.id as ProjectId, id: aliasId, nodeId,
    surface: "Synthetic alias", normalized: "synthetic alias", scope: null, status: "confirmed",
  }));
  await commitDependency((transaction) => transaction.saveKnowledgeAlias({
    projectId: project.id as ProjectId, id: aliasId, nodeId,
    surface: "Updated synthetic alias", normalized: "updated synthetic alias", scope: null, status: "confirmed",
  }));
  const relationId = randomUUID() as KnowledgeRelationId;
  const relation = await commitDependency((transaction) => transaction.saveKnowledgeRelation({
    projectId: project.id as ProjectId, id: relationId, sourceId: nodeId, targetId: otherNodeId,
    type: "related", attributes: {}, validity: {}, status: "confirmed", expectedVersion: null,
  }));
  await commitDependency((transaction) => transaction.saveKnowledgeRelation({
    projectId: project.id as ProjectId, id: relationId, sourceId: nodeId, targetId: otherNodeId,
    type: "associated", attributes: {}, validity: {}, status: "confirmed", expectedVersion: relation.version,
  }));
  const evidenceId = randomUUID() as EvidenceId;
  const anchor = await commitDependency((transaction) => transaction.saveEvidenceAnchor({
    projectId: project.id as ProjectId, id: evidenceId, documentId: scene.document.id, revisionId: saved.revision.id,
    fromUtf16: 0, toUtf16: 2, quoteSha256: createHash("sha256").update("新し").digest("hex"),
    status: "confirmed", expectedVersion: null,
  }));
  await commitDependency((transaction) => transaction.saveEvidenceAnchor({
    projectId: project.id as ProjectId, id: evidenceId, documentId: scene.document.id, revisionId: saved.revision.id,
    fromUtf16: 0, toUtf16: 2, quoteSha256: anchor.quoteSha256, status: "needs_review", expectedVersion: anchor.version,
  }));
  await commitDependency((transaction) => transaction.saveMentionLink({
    projectId: project.id as ProjectId, evidenceId, nodeId, status: "confirmed", source: "author", confidence: 1, extractorVersion: null,
  }));
  await commitDependency((transaction) => transaction.saveMentionLink({
    projectId: project.id as ProjectId, evidenceId, nodeId, status: "proposed", source: "author", confidence: 1, extractorVersion: null,
  }));
  const assertionId = randomUUID() as AssertionId;
  const assertion = await commitDependency((transaction) => transaction.saveAssertion({
    projectId: project.id as ProjectId, id: assertionId, proposition: { text: "Synthetic assertion" },
    modality: "stated", perspective: "author", narrativeTime: {}, confidence: 1, status: "confirmed", expectedVersion: null,
  }));
  await commitDependency((transaction) => transaction.saveAssertion({
    projectId: project.id as ProjectId, id: assertionId, proposition: { text: "Updated synthetic assertion" },
    modality: "stated", perspective: "author", narrativeTime: {}, confidence: 1, status: "confirmed", expectedVersion: assertion.version,
  }));
  await commitDependency((transaction) => transaction.linkAssertionEvidence({
    projectId: project.id as ProjectId, assertionId, evidenceId, role: "supports",
  }));
  await commitDependency((transaction) => transaction.linkAssertionEvidence({
    projectId: project.id as ProjectId, assertionId, evidenceId, role: "context",
  }));

  await commitDependency((transaction) => transaction.deleteDocument({
    projectId: project.id as ProjectId,
    documentId: scene.document.id,
    expectedVersion: saved.document.version,
  }));
  assert.equal((await (await core.reader(project.id)).read("manuscript/v1/c1/s1.md")), null);

  const beforeAuthority = (await persistence.read((reader) => reader.getProject(project.id as ProjectId)))!.version;
  await persistence.transaction((transaction) => transaction.saveModuleRecord({
    projectId: project.id as ProjectId,
    moduleId: "core.authority.proposals",
    key: "proposal:" + randomUUID(),
    value: { state: "proposed" },
    expectedVersion: null,
  }));
  assert.equal((await persistence.read((reader) => reader.getProject(project.id as ProjectId)))?.version, beforeAuthority);
});

test("startup certifies equivalent legacy snapshots and transitions only incompatible current projections", async () => {
  const legacyModule = "core.authority.snapshots";
  async function seedLegacy(compatible: boolean) {
    const project = await createProject();
    const snapshot = {projectId:project.id, projectVersion:project.version};
    const file = (content: string) => ({content,encoding:"utf8",revision:createHash("sha256").update(content).digest("hex")});
    const files: Record<string, ReturnType<typeof file>> = {
      "meta/project.yaml": file(YAML.stringify({title:project.title,...project.settings})),
    };
    const knowledgePath = "meta/scriptorium/knowledge-context/v1.json";
    if (compatible) files[knowledgePath] = file(JSON.stringify({version:1,projectId:project.id,documentMappings:[],entries:[],nodeLimitReached:false}));
    await persistence.transaction(tx => tx.saveModuleRecord({projectId:project.id,moduleId:legacyModule,key:`snapshot:${project.version}`,value:{snapshot,project,documents:[],files} as unknown as JsonObject,expectedVersion:null}));
    return {project,snapshot,knowledgePath};
  }
  const compatible = await seedLegacy(true);
  const incompatible = await seedLegacy(false);
  const store = new CoreStore({persistence});
  await assert.rejects(store.reader(incompatible.project.id), {code:"snapshot_unavailable"});
  assert.equal((await store.observe(incompatible.project.id)).snapshot.projectVersion, incompatible.project.version);
  const exactFiles = async (reader: SnapshotReader) => Promise.all((await reader.list("")).map(async path => ({path, file:await reader.read(path,"base64")})));
  const oldPinned = await store.reader(incompatible.project.id,incompatible.snapshot);
  const oldFiles = await exactFiles(oldPinned);
  assert.equal(await oldPinned.read(incompatible.knowledgePath), null);
  await store.prepareSnapshotReuse(compatible.project.id);
  assert.deepEqual((await store.reader(compatible.project.id)).snapshot, compatible.snapshot);
  assert.equal((await store.observe(incompatible.project.id)).snapshot.projectVersion, incompatible.project.version);
  let release!: () => void;
  const both = new Promise<void>(resolve => { release = resolve; });
  let misses = 0;
  const instrumented = countSnapshotReads(persistence, async () => {
    if (++misses === 2) release();
    await both;
  });
  const competing = new CoreStore({persistence:instrumented.persistence});
  await Promise.all([competing.prepareSnapshotReuse(incompatible.project.id),competing.prepareSnapshotReuse(incompatible.project.id)]);
  assert.ok(misses >= 2);
  const current = await store.reader(incompatible.project.id);
  assert.equal(current.snapshot.projectVersion,incompatible.project.version+1);
  assert.ok(await current.read(incompatible.knowledgePath));
  assert.equal(await (await store.reader(incompatible.project.id,incompatible.snapshot)).read(incompatible.knowledgePath),null);
  assert.deepEqual(await exactFiles(await store.reader(incompatible.project.id,incompatible.snapshot)),oldFiles);
  await store.prepareSnapshotReuse(incompatible.project.id);
  assert.equal((await store.observe(incompatible.project.id)).snapshot.projectVersion,incompatible.project.version+1);
  const restarted = new CoreStore({persistence});
  assert.deepEqual((await restarted.reader(incompatible.project.id)).snapshot,current.snapshot);
  assert.deepEqual(await exactFiles(await restarted.reader(incompatible.project.id,incompatible.snapshot)),oldFiles);
  const lazyCompatible = await seedLegacy(true);
  assert.deepEqual((await restarted.reader(lazyCompatible.project.id)).snapshot,lazyCompatible.snapshot);
  assert.equal((await restarted.observe(lazyCompatible.project.id)).snapshot.projectVersion,lazyCompatible.project.version);
});

test("writing statistics preserve a non-scene first-match logical identity collision", async () => {
  const project = await createProject();
  await persistence.transaction(async tx => {
    const create = (kind: string,parentId: DocumentId | null,title: string,markdown: string) => tx.createDocument({
      projectId:project.id,kind,parentId,title,markdown,orderKey:"01",
      authorId:"synthetic-author",idempotencyKey:randomUUID(),
    });
    const note = await create("note",null,"Note","補足 😀");
    const volume = await create("volume",null,"Volume","");
    const chapter = await create("chapter",volume.document.id,"Chapter","");
    const scene = await create("scene",chapter.document.id,"Scene","not the first match");
    for (const [document,kind] of [[note.document,"note"],[scene.document,"scene"]] as const) {
      await tx.saveModuleRecord({projectId:project.id,moduleId:"core.document-paths",key:document.id,
        value:{metadataPath:`metadata/${kind}.yaml`,manuscriptPath:`manuscript/${kind}.md`,metadata:{id:"shared-logical"}},expectedVersion:null});
    }
  });
  const {stats} = await core.writingStatsSnapshot(project.id);
  assert.equal(stats.sceneById["shared-logical"]?.charCount,3);
  assert.equal(stats.totalCharCount,3);
});

test("durable current reuse preserves hierarchy deletion write order", async () => {
  const project = await createProject();
  const {volume,chapter,scene} = await persistence.transaction(async tx => {
    const create = (kind: string,parentId: DocumentId | null) => tx.createDocument({
      projectId:project.id,kind,parentId,title:kind,markdown:"本文",orderKey:"01",
      authorId:"synthetic-author",idempotencyKey:randomUUID(),
    });
    const volume = await create("volume",null);
    const chapter = await create("chapter",volume.document.id);
    const scene = await create("scene",chapter.document.id);
    return {volume,chapter,scene};
  });
  const target = {kind:"scene" as const,id:scene.document.id,volumeId:volume.document.id,chapterId:chapter.document.id};
  const first = await core.buildDeleteHierarchyOperation(project.id,target);
  const current = await core.readSceneSnapshot(project.id,scene.document.id);
  const expected = [current.metadata.path,current.document.path];
  assert.deepEqual(first.operation.writes.map(write=>write.path),expected);
  const warm = await core.buildDeleteHierarchyOperation(project.id,target);
  assert.deepEqual(warm.operation.writes,first.operation.writes);
  const restarted = new CoreStore({persistence});
  assert.deepEqual((await restarted.buildDeleteHierarchyOperation(project.id,target)).operation.writes,first.operation.writes);
});
