import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { Pool } from "pg";
import {
  PersistenceError,
  type ChangeSetOperation,
  type CreateDocumentCommand,
  type DocumentId,
  type EvidenceId,
  type KnowledgeNodeId,
  type ProjectId,
  type RevisionId,
  type SaveDocumentCommand,
} from "@codexia/persistence-contracts";
import { createPostgresPersistence, migratePostgresDatabase } from "./index.js";

const connectionString = process.env.CODEXIA_TEST_DATABASE_URL;
if (!connectionString) throw new Error("CODEXIA_TEST_DATABASE_URL is required for PostgreSQL integration tests");

const persistence = createPostgresPersistence(connectionString);
const directPool = new Pool({ connectionString });

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

async function createProject(title: string) {
  return persistence.transaction((transaction) => transaction.createProject({ title }));
}

async function createDocument(projectId: ProjectId, markdown: string, idempotencyKey = randomUUID()) {
  return persistence.transaction((transaction) => transaction.createDocument({
    projectId,
    kind: "scene",
    title: "Scene",
    orderKey: "0001",
    markdown,
    authorId: "author",
    idempotencyKey,
  }));
}

function saveCommand(
  projectId: ProjectId,
  documentId: DocumentId,
  baseRevisionId: RevisionId,
  markdown: string,
  changes: SaveDocumentCommand["changes"],
  idempotencyKey: string = randomUUID(),
): SaveDocumentCommand {
  return {
    projectId,
    documentId,
    baseRevisionId,
    changes,
    resultingSha256: sha256(markdown),
    authorId: "author",
    clientId: "test-client",
    idempotencyKey,
  };
}

before(async () => {
  await migratePostgresDatabase(connectionString);
  assert.deepEqual(await migratePostgresDatabase(connectionString), []);
});

after(async () => {
  await persistence.close();
  await directPool.end();
});

test("migrations are repeatable and document revisions stay immutable", async () => {
  const project = await persistence.transaction((transaction) => transaction.createProject({
    title: `migration-${randomUUID()}`,
    settings: { language: "ja" },
  }));
  assert.deepEqual((await persistence.read((reader) => reader.getProject(project.id)))?.settings, { language: "ja" });
  const initial = await createDocument(project.id, "章😀\uFE0F e\u0301\r\n");
  assert.equal(initial.revision.sha256, sha256(initial.revision.markdown));

  await assert.rejects(
    directPool.query("UPDATE document_revision SET markdown = 'changed' WHERE project_id = $1 AND id = $2", [project.id, initial.revision.id]),
    (error: unknown) => Boolean(error && typeof error === "object" && "code" in error && error.code === "55000"),
  );
});

test("PostgreSQL health checks and Knowledge lists use the canonical project records", async () => {
  const project = await createProject(`knowledge-list-${randomUUID()}`);
  const nodeIds = [randomUUID() as KnowledgeNodeId, randomUUID() as KnowledgeNodeId];
  await persistence.transaction(async (transaction) => {
    await transaction.saveKnowledgeNode({
      projectId: project.id, id: nodeIds[0]!, type: "character", name: "Zebra", attributes: {}, status: "proposed", expectedVersion: null,
    });
    await transaction.saveKnowledgeNode({
      projectId: project.id, id: nodeIds[1]!, type: "character", name: "Apple", attributes: {}, status: "confirmed", expectedVersion: null,
    });
  });

  await persistence.checkHealth();
  const nodes = await persistence.read((reader) => reader.listKnowledgeNodes(project.id));
  assert.deepEqual(nodes.map((node) => node.name), ["Apple", "Zebra"]);
  assert.deepEqual((await persistence.read((reader) => reader.listKnowledgeNodes(project.id, 1))).map((node) => node.name), ["Apple"]);
});

test("database foreign keys prevent Knowledge relations from crossing projects", async () => {
  const firstProject = await createProject(`scope-a-${randomUUID()}`);
  const secondProject = await createProject(`scope-b-${randomUUID()}`);
  const firstNodeId = randomUUID() as KnowledgeNodeId;
  const secondNodeId = randomUUID() as KnowledgeNodeId;
  await persistence.transaction(async (transaction) => {
    await transaction.saveKnowledgeNode({
      projectId: firstProject.id,
      id: firstNodeId,
      type: "character",
      name: "First",
      attributes: {},
      status: "confirmed",
      expectedVersion: null,
    });
    await transaction.saveKnowledgeNode({
      projectId: secondProject.id,
      id: secondNodeId,
      type: "character",
      name: "Second",
      attributes: {},
      status: "confirmed",
      expectedVersion: null,
    });
  });

  await assert.rejects(
    directPool.query(
      `INSERT INTO knowledge_relation(project_id, id, source_id, target_id, type, attributes, validity, status)
       VALUES ($1, $2, $3, $4, 'knows', '{}'::jsonb, '{}'::jsonb, 'proposed')`,
      [firstProject.id, randomUUID(), firstNodeId, secondNodeId],
    ),
    (error: unknown) => Boolean(error && typeof error === "object" && "code" in error && error.code === "23503"),
  );
});

test("UTF-16 edits, idempotency, revision restoration and stale-head conflicts", async () => {
  const project = await createProject(`revision-${randomUUID()}`);
  const originalMarkdown = "前😀\uFE0F章 e\u0301\r\n";
  const initial = await createDocument(project.id, originalMarkdown);
  const insertionPoint = originalMarkdown.indexOf("章");
  const editedMarkdown = `${originalMarkdown.slice(0, insertionPoint)}改${originalMarkdown.slice(insertionPoint)}`;
  const command = saveCommand(project.id, initial.document.id, initial.revision.id, editedMarkdown, [
    { fromUtf16: insertionPoint, toUtf16: insertionPoint, insert: "改" },
  ], "save-once");

  const saved = await persistence.transaction((transaction) => transaction.saveDocument(command));
  const replay = await persistence.transaction((transaction) => transaction.saveDocument(command));
  assert.equal(saved.revision.markdown, editedMarkdown);
  assert.equal(replay.replayed, true);
  assert.equal(replay.revision.id, saved.revision.id);
  assert.equal(replay.document.headRevisionId, saved.revision.id);

  const badOffset = editedMarkdown.indexOf("😀") + 1;
  const invalidCommand = saveCommand(project.id, initial.document.id, saved.revision.id,
    `${editedMarkdown.slice(0, badOffset)}?${editedMarkdown.slice(badOffset)}`,
    [{ fromUtf16: badOffset, toUtf16: badOffset, insert: "?" }], "split-surrogate");
  await assert.rejects(
    persistence.transaction((transaction) => transaction.saveDocument(invalidCommand)),
    (error: unknown) => error instanceof PersistenceError && error.code === "validation",
  );

  const restored = await persistence.transaction((transaction) => transaction.restoreDocumentRevision({
    projectId: project.id,
    documentId: initial.document.id,
    baseRevisionId: saved.revision.id,
    sourceRevisionId: initial.revision.id,
    authorId: "author",
    idempotencyKey: "restore-once",
  }));
  assert.equal(restored.revision.markdown, originalMarkdown);
  assert.equal(restored.revision.parentRevisionId, saved.revision.id);
  assert.notEqual(restored.revision.id, initial.revision.id);

  const replayAfterRestore = await persistence.transaction((transaction) => transaction.saveDocument(command));
  assert.equal(replayAfterRestore.replayed, true);
  assert.equal(replayAfterRestore.document.headRevisionId, saved.revision.id);
  assert.equal((await persistence.read((reader) => reader.getDocument(project.id, initial.document.id)))?.headRevisionId, restored.revision.id);

  const firstPage = await persistence.read((reader) => reader.listRevisions(project.id, initial.document.id, 1));
  assert.equal(firstPage.revisions.length, 1);
  assert.ok(firstPage.nextBefore);
  const secondPage = await persistence.read((reader) => reader.listRevisions(project.id, initial.document.id, 1, firstPage.nextBefore ?? undefined));
  assert.equal(secondPage.revisions.length, 1);
  assert.notEqual(firstPage.revisions[0]?.id, secondPage.revisions[0]?.id);

  await assert.rejects(
    persistence.transaction((transaction) => transaction.saveDocument({ ...command, idempotencyKey: "save-once", changes: [], resultingSha256: sha256("") })),
    (error: unknown) => error instanceof PersistenceError && error.code === "idempotency_conflict",
  );
});

test("document saves advance persistent anchors atomically and revoke stale mention confirmation", async () => {
  const project = await createProject(`anchor-follow-${randomUUID()}`);
  const initial = await createDocument(project.id, "前文 東京 の後文");
  const quoteStart = initial.revision.markdown.indexOf("東京");
  const nodeId = randomUUID() as KnowledgeNodeId;
  const evidenceId = randomUUID() as EvidenceId;
  await persistence.transaction(async (transaction) => {
    await transaction.saveKnowledgeNode({
      projectId: project.id,
      id: nodeId,
      type: "character",
      name: "東京",
      attributes: {},
      status: "confirmed",
      expectedVersion: null,
    });
    await transaction.saveEvidenceAnchor({
      projectId: project.id,
      id: evidenceId,
      documentId: initial.document.id,
      revisionId: initial.revision.id,
      fromUtf16: quoteStart,
      toUtf16: quoteStart + "東京".length,
      quoteSha256: sha256("東京"),
      status: "confirmed",
      expectedVersion: null,
    });
    await transaction.saveMentionLink({
      projectId: project.id,
      evidenceId,
      nodeId,
      status: "confirmed",
      source: "author",
      confidence: 1,
      extractorVersion: null,
    });
  });

  const prefix = "😀追記";
  const afterPrefix = `${prefix}${initial.revision.markdown}`;
  const prefixSave = saveCommand(project.id, initial.document.id, initial.revision.id, afterPrefix,
    [{ fromUtf16: 0, toUtf16: 0, insert: prefix }], "anchor-shift");
  const shifted = await persistence.transaction((transaction) => transaction.saveDocument(prefixSave));
  let evidence = await persistence.read(async (reader) => ({
    anchor: await reader.getEvidenceAnchor(project.id, evidenceId),
    links: await reader.listMentionLinks(project.id, evidenceId),
    history: await reader.listEvidenceHistory(project.id, evidenceId),
    documentAnchors: await reader.listDocumentEvidence(project.id, initial.document.id, shifted.revision.id),
  }));
  assert.equal(evidence.anchor?.revisionId, shifted.revision.id);
  assert.equal(evidence.anchor?.fromUtf16, quoteStart + prefix.length);
  assert.equal(evidence.anchor?.toUtf16, quoteStart + prefix.length + "東京".length);
  assert.equal(evidence.anchor?.status, "confirmed");
  assert.equal(evidence.links[0]?.status, "confirmed");
  assert.equal(evidence.history.length, 2);

  const range = { fromUtf16: evidence.anchor!.fromUtf16, toUtf16: evidence.anchor!.toUtf16 };
  const afterReplacement = `${afterPrefix.slice(0, range.fromUtf16)}大阪${afterPrefix.slice(range.toUtf16)}`;
  const replacementSave = saveCommand(project.id, initial.document.id, shifted.revision.id, afterReplacement,
    [{ ...range, insert: "大阪" }], "anchor-needs-review");
  const reviewed = await persistence.transaction((transaction) => transaction.saveDocument(replacementSave));
  evidence = await persistence.read(async (reader) => ({
    anchor: await reader.getEvidenceAnchor(project.id, evidenceId),
    links: await reader.listMentionLinks(project.id, evidenceId),
    history: await reader.listEvidenceHistory(project.id, evidenceId),
    documentAnchors: await reader.listDocumentEvidence(project.id, initial.document.id, reviewed.revision.id),
  }));
  assert.equal(evidence.anchor?.revisionId, reviewed.revision.id);
  assert.equal(evidence.anchor?.status, "needs_review");
  assert.equal(evidence.anchor?.quoteSha256, sha256("大阪"));
  assert.equal(evidence.links[0]?.status, "proposed");
  assert.equal(evidence.history.length, 3);

  const currentAnchor = evidence.anchor!;
  const afterDelete = `${afterReplacement.slice(0, currentAnchor.fromUtf16)}${afterReplacement.slice(currentAnchor.toUtf16)}`;
  const deleteSave = saveCommand(project.id, initial.document.id, reviewed.revision.id, afterDelete,
    [{ fromUtf16: currentAnchor.fromUtf16, toUtf16: currentAnchor.toUtf16, insert: "" }], "anchor-orphaned");
  const deleted = await persistence.transaction((transaction) => transaction.saveDocument(deleteSave));
  evidence = await persistence.read(async (reader) => ({
    anchor: await reader.getEvidenceAnchor(project.id, evidenceId),
    links: await reader.listMentionLinks(project.id, evidenceId),
    history: await reader.listEvidenceHistory(project.id, evidenceId),
    documentAnchors: await reader.listDocumentEvidence(project.id, initial.document.id, deleted.revision.id),
  }));
  assert.equal(evidence.anchor?.revisionId, deleted.revision.id);
  assert.equal(evidence.anchor?.status, "orphaned");
  assert.equal(evidence.anchor?.fromUtf16, evidence.anchor?.toUtf16);
  assert.equal(evidence.history.length, 4);
  assert.equal(evidence.documentAnchors[0]?.status, "orphaned");
});

test("concurrent exact retries replay one document creation and one edit", async () => {
  const project = await createProject(`retry-${randomUUID()}`);
  const creation: CreateDocumentCommand = {
    projectId: project.id,
    kind: "scene",
    title: "Retry-safe",
    orderKey: "0001",
    markdown: "original",
    authorId: "author",
    idempotencyKey: `create-${randomUUID()}`,
  };
  const created = await Promise.all([
    persistence.transaction((tx) => tx.createDocument(creation)),
    persistence.transaction((tx) => tx.createDocument(creation)),
  ]);
  assert.equal(created[0]!.document.id, created[1]!.document.id);
  assert.equal(created[0]!.revision.id, created[1]!.revision.id);
  assert.deepEqual(created.map((x) => x.replayed).sort(), [false, true]);

  const command = saveCommand(project.id, created[0]!.document.id, created[0]!.revision.id,
    "original edited", [{ fromUtf16: 8, toUtf16: 8, insert: " edited" }],
    `save-${randomUUID()}`);
  const saved = await Promise.all([
    persistence.transaction((tx) => tx.saveDocument(command)),
    persistence.transaction((tx) => tx.saveDocument(command)),
  ]);
  assert.equal(saved[0]!.revision.id, saved[1]!.revision.id);
  assert.deepEqual(saved.map((x) => x.replayed).sort(), [false, true]);
  const history = await persistence.read((reader) => reader.listRevisions(project.id, created[0]!.document.id, 10));
  assert.equal(history.revisions.length, 2);
});

test("concurrent document saves use compare-and-swap on the observed revision", async () => {
  const project = await createProject(`concurrency-${randomUUID()}`);
  const initial = await createDocument(project.id, "base");
  const left = saveCommand(project.id, initial.document.id, initial.revision.id, "leftbase", [
    { fromUtf16: 0, toUtf16: 0, insert: "left" },
  ]);
  const right = saveCommand(project.id, initial.document.id, initial.revision.id, "baseright", [
    { fromUtf16: 4, toUtf16: 4, insert: "right" },
  ]);
  const results = await Promise.allSettled([
    persistence.transaction((transaction) => transaction.saveDocument(left)),
    persistence.transaction((transaction) => transaction.saveDocument(right)),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  const rejected = results.find((result) => result.status === "rejected");
  assert.ok(rejected && rejected.status === "rejected");
  assert.ok(rejected.reason instanceof PersistenceError);
  assert.equal(rejected.reason.code, "conflict");
});

test("transaction failures roll back document, revision and idempotency rows", async () => {
  const project = await createProject(`rollback-${randomUUID()}`);
  const beforeProject = await persistence.read((reader) => reader.getProject(project.id));
  const documentId = randomUUID() as DocumentId;
  const command: CreateDocumentCommand = {
    projectId: project.id,
    documentId,
    kind: "scene",
    title: "Rolled back",
    orderKey: "0001",
    markdown: "rollback body",
    authorId: "author",
    idempotencyKey: "rollback-create",
  };

  await assert.rejects(persistence.transaction(async (transaction) => {
    await transaction.createDocument(command);
    throw new Error("force rollback");
  }), /force rollback/u);
  assert.equal(await persistence.read((reader) => reader.getDocument(project.id, documentId)), undefined);
  assert.equal((await persistence.read((reader) => reader.getProject(project.id)))?.version, beforeProject?.version);

  const retried = await persistence.transaction((transaction) => transaction.createDocument(command));
  assert.equal(retried.document.id, documentId);
  assert.equal(retried.replayed, false);
});

test("ChangeSet application is atomic, versioned and idempotent", async () => {
  const project = await createProject(`changeset-${randomUUID()}`);
  const document = await createDocument(project.id, "Evidence text");
  const failedNodeId = randomUUID() as KnowledgeNodeId;
  const failedChange = await persistence.transaction((transaction) => transaction.createChangeSet({
    projectId: project.id,
    authorId: "author",
    idempotencyKey: "failed-change-set",
    readSet: [],
    writeSet: [
      { resource: "knowledge_node", id: failedNodeId },
      { resource: "document", id: document.document.id },
    ],
    provenance: { source: "author", actorId: "author", details: { purpose: "rollback test" } },
    operations: [
      {
        type: "knowledge.node.save",
        command: {
          projectId: project.id,
          id: failedNodeId,
          type: "character",
          name: "Temporary",
          attributes: {},
          status: "proposed",
          expectedVersion: null,
        },
      },
      {
        type: "document.save",
        command: saveCommand(project.id, document.document.id, randomUUID() as RevisionId, "bad", [], "stale-save"),
      },
    ],
  }));
  const approvedFailure = await persistence.transaction((transaction) => transaction.approveChangeSet({
    projectId: project.id,
    changeSetId: failedChange.changeSet.id,
    expectedVersion: failedChange.changeSet.version,
    approvedBy: "author",
  }));
  await assert.rejects(
    persistence.transaction((transaction) => transaction.applyChangeSet({
      projectId: project.id,
      changeSetId: approvedFailure.id,
      expectedVersion: approvedFailure.version,
    })),
    (error: unknown) => error instanceof PersistenceError && error.code === "conflict",
  );
  assert.equal(await persistence.read((reader) => reader.getKnowledgeNode(project.id, failedNodeId)), undefined);
  assert.equal((await persistence.read((reader) => reader.getChangeSet(project.id, approvedFailure.id)))?.status, "approved");

  const staleReadNodeId = randomUUID() as KnowledgeNodeId;
  const staleReadChange = await persistence.transaction((transaction) => transaction.createChangeSet({
    projectId: project.id,
    authorId: "author",
    idempotencyKey: "stale-read-set",
    operations: [{
      type: "knowledge.node.save",
      command: {
        projectId: project.id,
        id: staleReadNodeId,
        type: "character",
        name: "Must not apply",
        attributes: {},
        status: "proposed",
        expectedVersion: null,
      },
    }],
    readSet: [{
      resource: "document",
      id: document.document.id,
      expectedVersion: document.document.version,
      expectedRevisionId: randomUUID() as RevisionId,
    }],
    writeSet: [{ resource: "knowledge_node", id: staleReadNodeId }],
    provenance: { source: "author", actorId: "author", details: {} },
  }));
  const approvedStaleRead = await persistence.transaction((transaction) => transaction.approveChangeSet({
    projectId: project.id,
    changeSetId: staleReadChange.changeSet.id,
    expectedVersion: staleReadChange.changeSet.version,
    approvedBy: "author",
  }));
  await assert.rejects(
    persistence.transaction((transaction) => transaction.applyChangeSet({
      projectId: project.id,
      changeSetId: approvedStaleRead.id,
      expectedVersion: approvedStaleRead.version,
    })),
    (error: unknown) => error instanceof PersistenceError && error.code === "conflict",
  );
  assert.equal(await persistence.read((reader) => reader.getKnowledgeNode(project.id, staleReadNodeId)), undefined);

  const nodeId = randomUUID() as KnowledgeNodeId;
  const secondNodeId = randomUUID() as KnowledgeNodeId;
  const evidenceId = randomUUID() as EvidenceId;
  const assertionId = randomUUID() as import("@codexia/persistence-contracts").AssertionId;
  const aliasId = randomUUID() as import("@codexia/persistence-contracts").KnowledgeAliasId;
  const relationId = randomUUID() as import("@codexia/persistence-contracts").KnowledgeRelationId;
  const anchorHash = sha256(document.revision.markdown);
  const operations: ChangeSetOperation[] = [
    {
      type: "knowledge.node.save",
      command: {
        projectId: project.id,
        id: nodeId,
        type: "character",
        name: "Aoi",
        attributes: { canon: true },
        status: "confirmed",
        expectedVersion: null,
      },
    },
    {
      type: "knowledge.node.save",
      command: {
        projectId: project.id,
        id: secondNodeId,
        type: "place",
        name: "Station",
        attributes: {},
        status: "proposed",
        expectedVersion: null,
      },
    },
    {
      type: "knowledge.alias.save",
      command: {
        projectId: project.id,
        id: aliasId,
        nodeId,
        surface: "あおい",
        normalized: "あおい",
        scope: null,
        status: "confirmed",
      },
    },
    {
      type: "knowledge.relation.save",
      command: {
        projectId: project.id,
        id: relationId,
        sourceId: nodeId,
        targetId: secondNodeId,
        type: "visits",
        attributes: {},
        validity: {},
        status: "confirmed",
        expectedVersion: null,
      },
    },
    {
      type: "evidence.anchor.save",
      command: {
        projectId: project.id,
        id: evidenceId,
        documentId: document.document.id,
        revisionId: document.revision.id,
        fromUtf16: 0,
        toUtf16: document.revision.markdown.length,
        quoteSha256: anchorHash,
        status: "confirmed",
        expectedVersion: null,
      },
    },
    {
      type: "evidence.mention.save",
      command: {
        projectId: project.id,
        evidenceId,
        nodeId,
        status: "confirmed",
        source: "author",
        confidence: 1,
        extractorVersion: null,
      },
    },
    {
      type: "evidence.assertion.save",
      command: {
        projectId: project.id,
        id: assertionId,
        proposition: { subject: nodeId, predicate: "visited", object: secondNodeId },
        modality: "certain",
        perspective: "author",
        narrativeTime: { scene: document.document.id },
        confidence: null,
        status: "confirmed",
        expectedVersion: null,
      },
    },
    {
      type: "evidence.assertion.link",
      command: {
        projectId: project.id,
        assertionId,
        evidenceId,
        role: "supports",
      },
    },
  ];
  const change = await persistence.transaction((transaction) => transaction.createChangeSet({
    projectId: project.id,
    authorId: "author",
    idempotencyKey: "approved-canonical-change",
    operations,
    readSet: [{
      resource: "document",
      id: document.document.id,
      expectedVersion: document.document.version,
      expectedRevisionId: document.revision.id,
    }],
    writeSet: [
      { resource: "knowledge_node", id: nodeId },
      { resource: "knowledge_node", id: secondNodeId },
      { resource: "knowledge_alias", id: aliasId },
      { resource: "knowledge_relation", id: relationId },
      { resource: "evidence_anchor", id: evidenceId },
      { resource: "mention_link", id: `${evidenceId}:${nodeId}` },
      { resource: "assertion", id: assertionId },
      { resource: "assertion_evidence", id: `${assertionId}:${evidenceId}` },
    ],
    provenance: { source: "author", actorId: "author", details: { reason: "reviewed narrative fact" } },
  }));
  const replayedProposal = await persistence.transaction((transaction) => transaction.createChangeSet({
    projectId: project.id,
    authorId: "author",
    idempotencyKey: "approved-canonical-change",
    operations,
    readSet: [{
      resource: "document",
      id: document.document.id,
      expectedVersion: document.document.version,
      expectedRevisionId: document.revision.id,
    }],
    writeSet: [
      { resource: "knowledge_node", id: nodeId },
      { resource: "knowledge_node", id: secondNodeId },
      { resource: "knowledge_alias", id: aliasId },
      { resource: "knowledge_relation", id: relationId },
      { resource: "evidence_anchor", id: evidenceId },
      { resource: "mention_link", id: `${evidenceId}:${nodeId}` },
      { resource: "assertion", id: assertionId },
      { resource: "assertion_evidence", id: `${assertionId}:${evidenceId}` },
    ],
    provenance: { source: "author", actorId: "author", details: { reason: "reviewed narrative fact" } },
  }));
  assert.equal(replayedProposal.replayed, true);

  const approved = await persistence.transaction((transaction) => transaction.approveChangeSet({
    projectId: project.id,
    changeSetId: change.changeSet.id,
    expectedVersion: change.changeSet.version,
    approvedBy: "author",
  }));
  const applied = await persistence.transaction((transaction) => transaction.applyChangeSet({
    projectId: project.id,
    changeSetId: approved.id,
    expectedVersion: approved.version,
  }));
  assert.equal(applied.changeSet.status, "applied");
  assert.equal(applied.results.length, operations.length);
  const replayedApplication = await persistence.transaction((transaction) => transaction.applyChangeSet({
    projectId: project.id,
    changeSetId: approved.id,
    expectedVersion: approved.version,
  }));
  assert.equal(replayedApplication.replayed, true);

  const readBack = await persistence.read(async (reader) => ({
    node: await reader.getKnowledgeNode(project.id, nodeId),
    aliases: await reader.listKnowledgeAliases(project.id, nodeId),
    relations: await reader.listKnowledgeRelations(project.id, nodeId),
    anchor: await reader.getEvidenceAnchor(project.id, evidenceId),
    history: await reader.listEvidenceHistory(project.id, evidenceId),
    mentions: await reader.listMentionLinks(project.id, evidenceId),
    assertion: await reader.getAssertion(project.id, assertionId),
    assertionEvidence: await reader.listAssertionEvidence(project.id, assertionId),
    appliedChangeSet: await reader.getChangeSet(project.id, change.changeSet.id),
  }));
  assert.equal(readBack.node?.status, "confirmed");
  assert.equal(readBack.aliases.length, 1);
  assert.equal(readBack.relations.length, 1);
  assert.equal(readBack.anchor?.revisionId, document.revision.id);
  assert.equal(readBack.history.length, 1);
  assert.equal(readBack.mentions[0]?.nodeId, nodeId);
  assert.equal(readBack.assertion?.status, "confirmed");
  assert.equal(readBack.assertionEvidence[0]?.role, "supports");
  assert.equal(readBack.appliedChangeSet?.provenance.source, "author");
  assert.equal(readBack.appliedChangeSet?.readSet[0]?.expectedRevisionId, document.revision.id);
  assert.equal(readBack.appliedChangeSet?.writeSet.length, operations.length);

  const reviewedAnchor = await persistence.transaction((transaction) => transaction.saveEvidenceAnchor({
    projectId: project.id,
    id: evidenceId,
    documentId: document.document.id,
    revisionId: document.revision.id,
    fromUtf16: 0,
    toUtf16: document.revision.markdown.length,
    quoteSha256: anchorHash,
    status: "needs_review",
    expectedVersion: 1,
  }));
  assert.equal(reviewedAnchor.version, 2);
  assert.equal((await persistence.read((reader) => reader.listEvidenceHistory(project.id, evidenceId))).length, 2);
  await assert.rejects(
    persistence.transaction((transaction) => transaction.saveEvidenceAnchor({
      projectId: project.id,
      id: evidenceId,
      documentId: document.document.id,
      revisionId: document.revision.id,
      fromUtf16: 0,
      toUtf16: document.revision.markdown.length,
      quoteSha256: anchorHash,
      status: "confirmed",
      expectedVersion: 1,
    })),
    (error: unknown) => error instanceof PersistenceError && error.code === "conflict",
  );

  const currentNode = readBack.node!;
  const updates = ["Aoi", "青い"].map((name) => persistence.transaction((transaction) => transaction.saveKnowledgeNode({
    projectId: project.id,
    id: nodeId,
    type: "character",
    name,
    attributes: { canon: true },
    status: "confirmed",
    expectedVersion: currentNode.version,
  })));
  const updateResults = await Promise.allSettled(updates);
  assert.equal(updateResults.filter((result) => result.status === "fulfilled").length, 1);
  const rejectedUpdate = updateResults.find((result) => result.status === "rejected");
  assert.ok(rejectedUpdate && rejectedUpdate.status === "rejected");
  assert.ok(rejectedUpdate.reason instanceof PersistenceError);
  assert.equal(rejectedUpdate.reason.code, "conflict");
});
