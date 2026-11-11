import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { createPostgresPersistence, migratePostgresDatabase } from "@codexia/persistence-postgres";
import type { DocumentId, EvidenceId, KnowledgeNodeId } from "@codexia/persistence-contracts";
import { exportWorkArchive, importWorkArchive } from "./work-archive.js";

const connectionString = process.env.CODEXIA_TEST_DATABASE_URL;
if (!connectionString) throw new Error("CODEXIA_TEST_DATABASE_URL is required for portable work integration tests");
const persistence = createPostgresPersistence(connectionString);
before(async () => { await migratePostgresDatabase(connectionString); });
after(() => persistence.close());

test("a portable work round trip reconstitutes manuscript, hierarchy, knowledge, evidence and author state", async () => {
  const projectId = randomUUID() as import("@codexia/persistence-contracts").ProjectId;
  const documentId = randomUUID() as DocumentId;
  const parentId = randomUUID() as DocumentId;
  const nodeId = randomUUID() as KnowledgeNodeId;
  const otherNodeId = randomUUID() as KnowledgeNodeId;
  const evidenceId = randomUUID() as EvidenceId;
  const quote = "東京";
  const markdown = "序章 😀 東京の朝\n";
  await persistence.transaction(async (tx) => {
    await tx.createProject({ id: projectId, title: "日本語の作品", settings: { theme: "night" } });
    await tx.createDocument({ projectId, documentId: parentId, kind: "chapter", title: "第一章", orderKey: "0001", markdown: "", authorId: "owner", idempotencyKey: "fixture-parent-" + parentId });
    const scene = await tx.createDocument({ projectId, documentId, parentId, kind: "scene", title: "始まり", orderKey: "0002", markdown, authorId: "owner", idempotencyKey: "fixture-scene-" + documentId });
    for (const [id, name] of [[nodeId, "東京"], [otherNodeId, "都市"]] as const) {
      await tx.saveKnowledgeNode({ projectId, id, name, type: "place", attributes: { locale: "ja" }, status: "confirmed", expectedVersion: null });
    }
    await tx.saveKnowledgeAlias({ projectId, id: randomUUID() as import("@codexia/persistence-contracts").KnowledgeAliasId, nodeId, surface: "東都", normalized: "東都", scope: null, status: "confirmed" });
    await tx.saveKnowledgeRelation({ projectId, id: randomUUID() as import("@codexia/persistence-contracts").KnowledgeRelationId, sourceId: nodeId, targetId: otherNodeId, type: "is-a", attributes: {}, validity: {}, status: "confirmed", expectedVersion: null });
    const fromUtf16 = markdown.indexOf(quote);
    await tx.saveEvidenceAnchor({ projectId, id: evidenceId, documentId, revisionId: scene.revision.id, fromUtf16, toUtf16: fromUtf16 + quote.length, quoteSha256: createHash("sha256").update(quote).digest("hex"), status: "confirmed", expectedVersion: null });
    await tx.saveMentionLink({ projectId, evidenceId, nodeId, status: "confirmed", source: "author", confidence: null, extractorVersion: null });
    const assertionId = randomUUID() as import("@codexia/persistence-contracts").AssertionId;
    await tx.saveAssertion({ projectId, id: assertionId, proposition: { text: "東京は都市" }, modality: "stated", perspective: "narrator", narrativeTime: {}, confidence: 1, status: "confirmed", expectedVersion: null });
    await tx.linkAssertionEvidence({ projectId, assertionId, evidenceId, role: "supports" });
    await tx.saveModuleRecord({ projectId, moduleId: "story", key: "character-corrections", value: { editorNote: "保持" }, expectedVersion: null });
    await tx.saveModuleRecord({ projectId, moduleId: "assistant", key: "settings", value: { provider: "local", credentials: { apiKey: "private-api-key" } }, expectedVersion: null });
    await tx.saveModuleRecord({ projectId, moduleId: "core.artifacts", key: "meta/scriptorium/modules/publishing/share-grants.jsonl", value: { content: "sensitive-grant" }, expectedVersion: null });
    await tx.saveModuleRecord({ projectId, moduleId: "core.authority.proposals", key: "proposal:private", value: { draft: "not portable" }, expectedVersion: null });
  });
  const archive = await exportWorkArchive(persistence, projectId);
  assert.equal(archive.format, "codexia-work/v1");
  assert.equal(archive.documents.find((d) => d.id === documentId)?.markdown, markdown);
  assert.equal(archive.knowledge.nodes.length, 2);
  assert.equal(archive.evidence.anchors.length, 1);
  assert.equal(archive.moduleRecords.length, 1);
  assert.ok(archive.omittedRecords.some((item) => item.includes("share-grants")));
  assert.equal(JSON.stringify(archive).includes("sensitive-grant"), false);
  assert.equal(JSON.stringify(archive).includes("not portable"), false);
  assert.equal(JSON.stringify(archive).includes("private-api-key"), false);
  assert.ok(archive.omittedRecords.some((item) => item.includes("assistant:settings")));
  const result = await importWorkArchive(persistence, archive, "owner");
  assert.equal(result.replayed, false);
  assert.notEqual(result.project.id, projectId);
  assert.deepEqual(result.project, await persistence.read((reader) => reader.getProject(result.project.id)), "import response must expose the committed version");
  const repeat = await importWorkArchive(persistence, archive, "owner");
  assert.equal(repeat.replayed, true);
  assert.equal(repeat.project.id, result.project.id);
  const restored = await exportWorkArchive(persistence, result.project.id);
  assert.equal(restored.project.title, archive.project.title);
  assert.deepEqual(restored.project.settings, archive.project.settings);
  assert.deepEqual(restored.documents.map((d) => [d.id, d.parentId, d.kind, d.title, d.orderKey, d.markdown]),
    archive.documents.map((d) => [d.id, d.parentId, d.kind, d.title, d.orderKey, d.markdown]));
  assert.deepEqual(restored.knowledge, archive.knowledge);
  assert.deepEqual(restored.evidence.mentions, archive.evidence.mentions);
  assert.deepEqual(restored.evidence.assertionEvidence, archive.evidence.assertionEvidence);
  assert.equal(restored.evidence.anchors[0]?.id, evidenceId);
  assert.equal(restored.moduleRecords[0]?.value.editorNote, "保持");
});

test("invalid imported references fail without creating a partial work", async () => {
  const projectId = randomUUID() as import("@codexia/persistence-contracts").ProjectId;
  await persistence.transaction((tx) => tx.createProject({ id: projectId, title: "Source" }));
  const archive = await exportWorkArchive(persistence, projectId);
  const corrupt = structuredClone(archive);
  corrupt.documents.push({
    id: randomUUID(), parentId: randomUUID(), kind: "scene", title: "Broken", orderKey: "0",
    markdown: "x", revisionId: randomUUID(),
  });
  await assert.rejects(importWorkArchive(persistence, corrupt, "owner"), /parent|reference|archive/i);
  assert.equal((await exportWorkArchive(persistence, projectId)).documents.length, 0);
});

test("superseded evidence remains in an explicit unresolved archive section", async () => {
  const projectId = randomUUID() as import("@codexia/persistence-contracts").ProjectId;
  const documentId = randomUUID() as DocumentId;
  const evidenceId = randomUUID() as EvidenceId;
  await persistence.transaction(async (tx) => {
    await tx.createProject({ id: projectId, title: "Evidence history" });
    const first = await tx.createDocument({ projectId, documentId, kind: "scene", title: "Evidence", orderKey: "0", markdown: "猫", authorId: "owner", idempotencyKey: "fixture-stale-first-" + documentId });
    await tx.saveEvidenceAnchor({ projectId, id: evidenceId, documentId, revisionId: first.revision.id, fromUtf16: 0, toUtf16: 1, quoteSha256: createHash("sha256").update("猫").digest("hex"), status: "confirmed", expectedVersion: null });
    await tx.saveDocument({ projectId, documentId, baseRevisionId: first.revision.id, changes: [{ fromUtf16: 0, toUtf16: 1, insert: "" }], resultingSha256: createHash("sha256").update("").digest("hex"), authorId: "owner", clientId: "test", idempotencyKey: "fixture-stale-second-" + documentId });
  });
  const archive = await exportWorkArchive(persistence, projectId);
  assert.equal(archive.evidence.anchors.length, 0);
  assert.equal(archive.evidence.unresolved.anchors.length, 1);
  const imported = await importWorkArchive(persistence, archive, "owner");
  assert.equal(imported.unresolvedAnchors, 1);
  const again = await exportWorkArchive(persistence, imported.project.id);
  assert.equal(again.evidence.unresolved.anchors[0]?.id, evidenceId);
});