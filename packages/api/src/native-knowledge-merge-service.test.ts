import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { test } from "node:test";
import type { AssertionId, EvidenceId, KnowledgeAliasId, KnowledgeNodeId, KnowledgeRelationId } from "@codexia/persistence-contracts";
import { PersistenceError } from "@codexia/persistence-contracts";
import { createPostgresPersistence, migratePostgresDatabase } from "@codexia/persistence-postgres";
import { approveNativeChangeSet, applyNativeChangeSet } from "./native-knowledge-service.js";
import { applyKnowledgeMerge } from "./knowledge-merge.js";
import { previewNativeKnowledgeMerge, proposeNativeKnowledgeMerge } from "./native-knowledge-merge-service.js";

const connectionString = process.env.CODEXIA_TEST_DATABASE_URL;

test("native Knowledge merge is one approved transaction with stable receipt and audit", { skip: !connectionString }, async (t) => {
  await migratePostgresDatabase(connectionString!);
  const persistence = createPostgresPersistence(connectionString!);
  const directPool = (persistence as unknown as { pool: { query: (text: string) => Promise<unknown> } }).pool;
  const cleanup: Array<() => Promise<unknown>> = [];
  t.after(async () => {
    try { for (const dispose of cleanup.reverse()) await dispose(); }
    finally { await persistence.close(); }
  });
  const project = await persistence.transaction(tx => tx.createProject({ title: `merge-${randomUUID()}` }));
  const sourceId = randomUUID() as KnowledgeNodeId;
  const targetId = randomUUID() as KnowledgeNodeId;
  const thirdId = randomUUID() as KnowledgeNodeId;
  const relationId = randomUUID() as KnowledgeRelationId;
  const evidenceId = randomUUID() as EvidenceId;
  const assertionId = randomUUID() as AssertionId;
  await persistence.transaction(async tx => {
    const document = await tx.createDocument({ projectId: project.id, kind: "scene", title: "Scene", orderKey: "0001", markdown: "The source appears.", authorId: "author", idempotencyKey: randomUUID() });
    await tx.saveKnowledgeNode({ projectId: project.id, id: sourceId, type: "character", name: "Source", attributes: { age: 5 }, status: "confirmed", expectedVersion: null });
    await tx.saveKnowledgeNode({ projectId: project.id, id: targetId, type: "character", name: "Target", attributes: {}, status: "confirmed", expectedVersion: null });
    await tx.saveKnowledgeNode({ projectId: project.id, id: thirdId, type: "character", name: "Third", attributes: {}, status: "confirmed", expectedVersion: null });
    await tx.saveKnowledgeAlias({ projectId: project.id, id: randomUUID() as KnowledgeAliasId, nodeId: sourceId, surface: "S", normalized: "s", scope: null, status: "confirmed" });
    await tx.saveKnowledgeRelation({ projectId: project.id, id: relationId, sourceId, targetId: thirdId, type: "knows", attributes: {}, validity: {}, status: "confirmed", expectedVersion: null });
    await tx.saveEvidenceAnchor({ projectId: project.id, id: evidenceId, documentId: document.document.id, revisionId: document.revision.id, fromUtf16: 0, toUtf16: 3, quoteSha256: createHash("sha256").update("The").digest("hex"), status: "confirmed", expectedVersion: null });
    await tx.saveMentionLink({ projectId: project.id, evidenceId, nodeId: sourceId, status: "confirmed", source: "extractor", confidence: 1, extractorVersion: null });
    await tx.saveAssertion({ projectId: project.id, id: assertionId, proposition: { nodeId: sourceId, predicate: "appears" }, modality: "certain", perspective: "author", narrativeTime: {}, confidence: null, status: "confirmed", expectedVersion: null });
  });
  const projectVersion = (await persistence.read(reader => reader.getProject(project.id)))!.version;
  const preview = await previewNativeKnowledgeMerge(persistence, project.id, sourceId, targetId, projectVersion);
  const proposed = await proposeNativeKnowledgeMerge({ persistence, projectId: project.id, sourceId, targetId, projectVersion, previewDigest: preview.previewDigest, actorId: "external-writer", origin: "external-agent", idempotencyKey: "native-merge-once" });
  assert.equal(proposed.changeSet.operations.length, 1);
  assert.equal(proposed.changeSet.operations[0]?.type, "knowledge.merge");
  const unchanged = await persistence.read(async reader => ({
    source: await reader.getKnowledgeNode(project.id, sourceId), target: await reader.getKnowledgeNode(project.id, targetId),
    aliases: await reader.listKnowledgeAliases(project.id, sourceId), records: await reader.listModuleRecords(project.id, "core.knowledge-merge"),
    relation: (await reader.listKnowledgeRelations(project.id, sourceId))[0],
    mentionLinks: await reader.listMentionLinks(project.id, evidenceId), assertion: await reader.getAssertion(project.id, assertionId),
  }));
  assert.equal(unchanged.source?.status, "confirmed");
  assert.equal(unchanged.target?.version, 1);
  assert.equal(unchanged.aliases.length, 1);
  assert.equal(unchanged.records.length, 0);
  assert.equal(unchanged.relation?.sourceId, sourceId);
  assert.equal(unchanged.mentionLinks.length, 1);
  assert.equal(unchanged.assertion?.proposition.nodeId, sourceId);
  const replay = await proposeNativeKnowledgeMerge({ persistence, projectId: project.id, sourceId, targetId, projectVersion, previewDigest: preview.previewDigest, actorId: "external-writer", origin: "external-agent", idempotencyKey: "native-merge-once" });
  assert.equal(replay.replayed, true);
  const approved = await approveNativeChangeSet(persistence, project.id, proposed.changeSet.id, proposed.changeSet.version, "author");
  const generatedAliasId = (proposed.changeSet.operations[0] as { command: { generatedAliasId: string } }).command.generatedAliasId;
  const suffix = randomUUID().replaceAll("-", "");
  const functionName = `reject_merge_alias_${suffix}`;
  const triggerName = `reject_merge_alias_${suffix}`;
  cleanup.push(async () => {
    await directPool.query(`DROP TRIGGER IF EXISTS ${triggerName} ON knowledge_alias`);
    await directPool.query(`DROP FUNCTION IF EXISTS ${functionName}()`);
  });
  await directPool.query(`CREATE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id = '${generatedAliasId}'::uuid THEN RAISE EXCEPTION 'injected merge failure' USING ERRCODE = '23514'; END IF; RETURN NEW; END $$`);
  await directPool.query(`CREATE TRIGGER ${triggerName} BEFORE INSERT ON knowledge_alias FOR EACH ROW EXECUTE FUNCTION ${functionName}()`);
  await assert.rejects(
    applyNativeChangeSet(persistence, project.id, approved.id, approved.version),
    error => error instanceof PersistenceError && error.code === "validation",
  );
  const rolledBack = await persistence.read(async reader => ({
    source: await reader.getKnowledgeNode(project.id, sourceId), target: await reader.getKnowledgeNode(project.id, targetId),
    sourceAliases: await reader.listKnowledgeAliases(project.id, sourceId), targetAliases: await reader.listKnowledgeAliases(project.id, targetId),
    records: await reader.listModuleRecords(project.id, "core.knowledge-merge"),
    relation: (await reader.listKnowledgeRelations(project.id, sourceId))[0], mentionLinks: await reader.listMentionLinks(project.id, evidenceId),
    assertion: await reader.getAssertion(project.id, assertionId), anchor: await reader.getEvidenceAnchor(project.id, evidenceId), history: await reader.listEvidenceHistory(project.id, evidenceId),
  }));
  assert.equal(rolledBack.source?.status, "confirmed");
  assert.equal(rolledBack.target?.version, 1);
  assert.equal(rolledBack.sourceAliases.length, 1);
  assert.equal(rolledBack.targetAliases.length, 0);
  assert.equal(rolledBack.records.length, 0);
  assert.equal(rolledBack.relation?.sourceId, sourceId);
  assert.equal(rolledBack.mentionLinks.length, 1);
  assert.equal(rolledBack.assertion?.proposition.nodeId, sourceId);
  assert.equal(rolledBack.anchor?.revisionId, rolledBack.history[0]?.revisionId);
  await directPool.query(`DROP TRIGGER ${triggerName} ON knowledge_alias`);
  await directPool.query(`DROP FUNCTION ${functionName}()`);
  const applied = await applyNativeChangeSet(persistence, project.id, approved.id, approved.version);
  assert.equal(applied.changeSet.status, "applied");
  assert.equal(applied.results.length, 1);
  const mergeResult = applied.results[0] as { auditId: string };
  const restarted = createPostgresPersistence(connectionString!);
  t.after(() => restarted.close());
  const applyReplay = await applyNativeChangeSet(restarted, project.id, approved.id, approved.version);
  assert.equal(applyReplay.replayed, true);
  assert.equal((applyReplay.results[0] as { auditId: string }).auditId, mergeResult.auditId);
  const after = await restarted.read(async reader => ({
    source: await reader.getKnowledgeNode(project.id, sourceId), target: await reader.getKnowledgeNode(project.id, targetId),
    aliases: await reader.listKnowledgeAliases(project.id, targetId), records: await reader.listModuleRecords(project.id, "core.knowledge-merge"),
    relation: (await reader.listKnowledgeRelations(project.id, targetId))[0], mentions: await reader.listMentionLinks(project.id, evidenceId),
    assertion: await reader.getAssertion(project.id, assertionId), anchor: await reader.getEvidenceAnchor(project.id, evidenceId), history: await reader.listEvidenceHistory(project.id, evidenceId),
  }));
  assert.equal(after.source?.status, "retired");
  assert.ok(after.aliases.some(alias => alias.surface === "S"));
  assert.equal(after.records.length, 1);
  assert.equal(after.records[0]?.key, mergeResult.auditId);
  assert.equal(after.records[0]?.value.authorId, "author");
  assert.equal(after.records[0]?.value.proposedBy, "external-writer");
  assert.equal(after.records[0]?.value.origin, "external-agent");
  const submissionReplay = await proposeNativeKnowledgeMerge({ persistence: restarted, projectId: project.id, sourceId, targetId, projectVersion, previewDigest: preview.previewDigest, actorId: "external-writer", origin: "external-agent", idempotencyKey: "native-merge-once" });
  assert.equal(submissionReplay.replayed, true);
  assert.equal(submissionReplay.changeSet.id, proposed.changeSet.id);
  assert.equal(submissionReplay.changeSet.status, "applied");
  assert.equal(after.relation?.sourceId, targetId);
  assert.deepEqual(after.mentions.map(link => link.nodeId).sort(), [sourceId, targetId].sort());
  assert.equal(after.assertion?.proposition.nodeId, targetId);
  assert.equal(after.anchor?.revisionId, after.history[0]?.revisionId);
});

test("native merge retries, staleness, rejection, cross-project scope and competing applies fail closed", { skip: !connectionString }, async (t) => {
  await migratePostgresDatabase(connectionString!);
  const persistence = createPostgresPersistence(connectionString!);
  t.after(() => persistence.close());
  const project = await persistence.transaction(tx => tx.createProject({ title: `merge-fences-${randomUUID()}` }));
  const other = await persistence.transaction(tx => tx.createProject({ title: `merge-other-${randomUUID()}` }));
  const sourceId = randomUUID() as KnowledgeNodeId;
  const targetId = randomUUID() as KnowledgeNodeId;
  const otherId = randomUUID() as KnowledgeNodeId;
  await persistence.transaction(async tx => {
    await tx.saveKnowledgeNode({ projectId: project.id, id: sourceId, type: "place", name: "Source", attributes: {}, status: "confirmed", expectedVersion: null });
    await tx.saveKnowledgeNode({ projectId: project.id, id: targetId, type: "place", name: "Target", attributes: {}, status: "confirmed", expectedVersion: null });
    await tx.saveKnowledgeNode({ projectId: other.id, id: otherId, type: "place", name: "Other", attributes: {}, status: "confirmed", expectedVersion: null });
  });
  const version = (await persistence.read(reader => reader.getProject(project.id)))!.version;
  await assert.rejects(proposeNativeKnowledgeMerge({ persistence, projectId: project.id, sourceId, targetId, projectVersion: version, previewDigest: "0".repeat(64), actorId: "author", origin: "author", idempotencyKey: "bad-digest" }), error => error instanceof PersistenceError && error.code === "conflict");
  await assert.rejects(previewNativeKnowledgeMerge(persistence, project.id, sourceId, otherId, version));
  const preview = await previewNativeKnowledgeMerge(persistence, project.id, sourceId, targetId, version);
  const first = await proposeNativeKnowledgeMerge({ persistence, projectId: project.id, sourceId, targetId, projectVersion: version, previewDigest: preview.previewDigest, actorId: "author", origin: "author", idempotencyKey: "compete-a" });
  await assert.rejects(proposeNativeKnowledgeMerge({ persistence, projectId: project.id, sourceId, targetId, projectVersion: version, previewDigest: preview.previewDigest, actorId: "other-author", origin: "author", idempotencyKey: "compete-a" }), error => error instanceof PersistenceError && error.code === "idempotency_conflict");
  const second = await proposeNativeKnowledgeMerge({ persistence, projectId: project.id, sourceId, targetId, projectVersion: version, previewDigest: preview.previewDigest, actorId: "author", origin: "author", idempotencyKey: "compete-b" });
  const approvedA = await approveNativeChangeSet(persistence, project.id, first.changeSet.id, first.changeSet.version, "author");
  const approvedB = await approveNativeChangeSet(persistence, project.id, second.changeSet.id, second.changeSet.version, "author");
  const settled = await Promise.allSettled([
    applyNativeChangeSet(persistence, project.id, approvedA.id, approvedA.version),
    applyNativeChangeSet(persistence, project.id, approvedB.id, approvedB.version),
  ]);
  assert.equal(settled.filter(result => result.status === "fulfilled").length, 1);
  const rejected = settled.find(result => result.status === "rejected");
  assert.ok(rejected && rejected.status === "rejected" && rejected.reason instanceof PersistenceError && rejected.reason.code === "conflict");
  assert.equal((await persistence.read(reader => reader.listModuleRecords(project.id, "core.knowledge-merge"))).length, 1);

  const staleProject = await persistence.transaction(tx => tx.createProject({ title: `merge-stale-${randomUUID()}` }));
  const staleSource = randomUUID() as KnowledgeNodeId;
  const staleTarget = randomUUID() as KnowledgeNodeId;
  await persistence.transaction(async tx => {
    await tx.saveKnowledgeNode({ projectId: staleProject.id, id: staleSource, type: "place", name: "S", attributes: {}, status: "confirmed", expectedVersion: null });
    await tx.saveKnowledgeNode({ projectId: staleProject.id, id: staleTarget, type: "place", name: "T", attributes: {}, status: "confirmed", expectedVersion: null });
  });
  const staleVersion = (await persistence.read(reader => reader.getProject(staleProject.id)))!.version;
  const stalePreview = await previewNativeKnowledgeMerge(persistence, staleProject.id, staleSource, staleTarget, staleVersion);
  const pending = await proposeNativeKnowledgeMerge({ persistence, projectId: staleProject.id, sourceId: staleSource, targetId: staleTarget, projectVersion: staleVersion, previewDigest: stalePreview.previewDigest, actorId: "author", origin: "external-agent", idempotencyKey: "stale-merge" });
  const rejectedProposal = await proposeNativeKnowledgeMerge({ persistence, projectId: staleProject.id, sourceId: staleSource, targetId: staleTarget, projectVersion: staleVersion, previewDigest: stalePreview.previewDigest, actorId: "author", origin: "author", idempotencyKey: "rejected-merge" });
  const rejectedChangeSet = await persistence.transaction(tx => tx.rejectChangeSet({ projectId: staleProject.id, changeSetId: rejectedProposal.changeSet.id, expectedVersion: rejectedProposal.changeSet.version, rejectedBy: "author" }));
  await assert.rejects(applyNativeChangeSet(persistence, staleProject.id, rejectedChangeSet.id, rejectedChangeSet.version), error => error instanceof PersistenceError && error.code === "invalid_change_set_state");
  const staleApproved = await approveNativeChangeSet(persistence, staleProject.id, pending.changeSet.id, pending.changeSet.version, "author");
  await persistence.transaction(tx => tx.saveKnowledgeNode({ projectId: staleProject.id, id: staleTarget, type: "place", name: "Changed", attributes: {}, status: "confirmed", expectedVersion: 1 }));
  await assert.rejects(proposeNativeKnowledgeMerge({ persistence, projectId: staleProject.id, sourceId: staleSource, targetId: staleTarget, projectVersion: staleVersion, previewDigest: stalePreview.previewDigest, actorId: "author", origin: "author", idempotencyKey: "stale-version" }), error => error instanceof PersistenceError && error.code === "conflict");
  await assert.rejects(applyNativeChangeSet(persistence, staleProject.id, staleApproved.id, staleApproved.version), error => error instanceof PersistenceError && error.code === "conflict");
  const staleState = await persistence.read(async reader => ({ source: await reader.getKnowledgeNode(staleProject.id, staleSource), target: await reader.getKnowledgeNode(staleProject.id, staleTarget), rejected: await reader.getChangeSet(staleProject.id, rejectedProposal.changeSet.id) }));
  assert.equal(staleState.source?.status, "confirmed");
  assert.equal(staleState.target?.name, "Changed");
  assert.equal(staleState.rejected?.status, "rejected");
});

test("direct author merge continues to use the shared planner and executor", { skip: !connectionString }, async (t) => {
  await migratePostgresDatabase(connectionString!);
  const persistence = createPostgresPersistence(connectionString!);
  t.after(() => persistence.close());
  const project = await persistence.transaction(tx => tx.createProject({ title: `merge-author-${randomUUID()}` }));
  const sourceId = randomUUID() as KnowledgeNodeId;
  const targetId = randomUUID() as KnowledgeNodeId;
  await persistence.transaction(async tx => {
    await tx.saveKnowledgeNode({ projectId: project.id, id: sourceId, type: "place", name: "Source", attributes: {}, status: "confirmed", expectedVersion: null });
    await tx.saveKnowledgeNode({ projectId: project.id, id: targetId, type: "place", name: "Target", attributes: {}, status: "confirmed", expectedVersion: null });
  });
  const version = (await persistence.read(reader => reader.getProject(project.id)))!.version;
  const preview = await previewNativeKnowledgeMerge(persistence, project.id, sourceId, targetId, version);
  const result = await persistence.transaction(tx => applyKnowledgeMerge(tx, project.id, sourceId, targetId, version, preview.previewDigest, "author"));
  assert.equal(result.source.status, "retired");
  assert.equal((await persistence.read(reader => reader.listModuleRecords(project.id, "core.knowledge-merge"))).length, 1);
});
