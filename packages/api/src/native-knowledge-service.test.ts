import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import type { ChangeSetOperation, KnowledgeNodeId, ProjectId } from "@codexia/persistence-contracts";
import { createPostgresPersistence, migratePostgresDatabase } from "@codexia/persistence-postgres";
import {
  NativeKnowledgeServiceError, applyNativeChangeSet, approveNativeChangeSet, getNativeChangeSet,
  proposeNativeKnowledgeChange, readNativeKnowledge, rejectNativeChangeSet,
} from "./native-knowledge-service.js";
import { handlePersistenceRoute } from "./persistence-routes.js";

const connectionString = process.env.CODEXIA_TEST_DATABASE_URL ?? "postgres://codexia:codexia@127.0.0.1:55440/codexia_test";
let persistence = createPostgresPersistence(connectionString);
before(() => migratePostgresDatabase(connectionString));
after(() => persistence.close());

async function project(title: string) {
  return persistence.transaction(tx => tx.createProject({ title: `${title}-${randomUUID()}` }));
}
type NodeOperation = Extract<ChangeSetOperation, { type: "knowledge.node.save" }>;
function nodeOperation(projectId: ProjectId, name: string, id = randomUUID() as KnowledgeNodeId): NodeOperation {
  return { type: "knowledge.node.save", command: { projectId, id, type: "person", name, attributes: {}, status: "proposed", expectedVersion: null } };
}

test("native proposals stay noncanonical until approval, apply atomically, and retain durable receipts", async () => {
  const p = await project("native-proposal");
  const operation = nodeOperation(p.id, "Luna");
  const submitted = await proposeNativeKnowledgeChange({ persistence, projectId: p.id, projectVersion: p.version, actorId: "reviewer", origin: "external-agent", idempotencyKey: "native-create-1", operations: [operation] });
  assert.equal(submitted.changeSet.provenance.details.origin, "external-agent");
  const replay = await proposeNativeKnowledgeChange({ persistence, projectId: p.id, projectVersion: p.version, actorId: "reviewer", origin: "external-agent", idempotencyKey: "native-create-1", operations: [operation] });
  assert.equal(replay.replayed, true);
  assert.equal(await persistence.read(reader => reader.getKnowledgeNode(p.id, operation.command.id)), undefined);
  const approved = await approveNativeChangeSet(persistence, p.id, submitted.changeSet.id, submitted.changeSet.version, "author");
  const applied = await applyNativeChangeSet(persistence, p.id, approved.id, approved.version);
  assert.equal(applied.changeSet.status, "applied");
  assert.equal((await persistence.read(reader => reader.getKnowledgeNode(p.id, operation.command.id)))?.name, "Luna");
  assert.equal((await applyNativeChangeSet(persistence, p.id, approved.id, approved.version)).replayed, true);
  const replayAfterApply = await proposeNativeKnowledgeChange({ persistence, projectId: p.id, projectVersion: p.version, actorId: "reviewer", origin: "external-agent", idempotencyKey: "native-create-1", operations: [operation] });
  assert.equal(replayAfterApply.replayed, true);
  assert.equal(replayAfterApply.changeSet.id, submitted.changeSet.id);
  assert.equal(replayAfterApply.changeSet.status, "applied");
  const prior = persistence;
  await prior.close();
  persistence = createPostgresPersistence(connectionString);
  const durable = await getNativeChangeSet(persistence, p.id, approved.id);
  assert.equal(durable?.receipt?.changeSet.status, "applied");
  assert.equal(durable?.receipt?.results.length, 1);
});

test("native snapshot scope, rollback, rejection, and stale source fences fail closed", async () => {
  const p = await project("native-stale");
  const foreign = await project("native-foreign");
  await assert.rejects(readNativeKnowledge(persistence, p.id, p.version + 1, async () => true), NativeKnowledgeServiceError);
  await assert.rejects(proposeNativeKnowledgeChange({ persistence, projectId: p.id, projectVersion: p.version, actorId: "actor", idempotencyKey: "mixed-project", operations: [nodeOperation(foreign.id, "foreign")] }), NativeKnowledgeServiceError);
  const forged = { ...nodeOperation(p.id, "forged"), command: { ...nodeOperation(p.id, "forged").command, authorId: "attacker" } } as unknown as ChangeSetOperation;
  await assert.rejects(proposeNativeKnowledgeChange({ persistence, projectId: p.id, projectVersion: p.version, actorId: "actor", idempotencyKey: "forged-actor", operations: [forged] }), NativeKnowledgeServiceError);

  const rejected = await proposeNativeKnowledgeChange({ persistence, projectId: p.id, projectVersion: p.version, actorId: "actor", idempotencyKey: "reject-me", operations: [nodeOperation(p.id, "rejected")] });
  await rejectNativeChangeSet(persistence, p.id, rejected.changeSet.id, rejected.changeSet.version, "author");
  assert.equal(await persistence.read(reader => reader.getKnowledgeNode(p.id, (rejected.changeSet.operations[0] as NodeOperation).command.id)), undefined);

  const rollbackNode = nodeOperation(p.id, "must-rollback");
  const source = await persistence.transaction(tx => tx.createDocument({ projectId: p.id, kind: "scene", title: "Evidence", orderKey: "1", markdown: "e", authorId: "author", idempotencyKey: "rollback-document" }));
  const evidenceId = randomUUID() as import("@codexia/persistence-contracts").EvidenceId;
  await persistence.transaction(tx => tx.saveEvidenceAnchor({ projectId: p.id, id: evidenceId, documentId: source.document.id, revisionId: source.revision.id, fromUtf16: 0, toUtf16: 1, quoteSha256: createHash("sha256").update("e").digest("hex"), status: "proposed", expectedVersion: null }));
  const current = await persistence.read(reader => reader.getProject(p.id));
  assert.ok(current);
  const badLink: ChangeSetOperation = { type: "evidence.mention.save", command: { projectId: p.id, evidenceId, nodeId: randomUUID() as KnowledgeNodeId, status: "proposed", source: "external", confidence: null, extractorVersion: null } };
  await assert.rejects(proposeNativeKnowledgeChange({ persistence, projectId: p.id, projectVersion: current.version, actorId: "actor", idempotencyKey: "bad-link", operations: [rollbackNode, badLink] }));
  const aliasCommand = { projectId: p.id, nodeId: rollbackNode.command.id, surface: "same", normalized: "same", scope: null, status: "confirmed" as const };
  const aliases: ChangeSetOperation[] = [1, 2].map(() => ({ type: "knowledge.alias.save" as const, command: { ...aliasCommand, id: randomUUID() as import("@codexia/persistence-contracts").KnowledgeAliasId } }));
  const rollback = await proposeNativeKnowledgeChange({ persistence, projectId: p.id, projectVersion: current.version, actorId: "actor", idempotencyKey: "rollback", operations: [rollbackNode, ...aliases] });
  const approved = await approveNativeChangeSet(persistence, p.id, rollback.changeSet.id, rollback.changeSet.version, "author");
  await assert.rejects(applyNativeChangeSet(persistence, p.id, approved.id, approved.version));
  assert.equal(await persistence.read(reader => reader.getKnowledgeNode(p.id, rollbackNode.command.id)), undefined);

  const beforeStale = await persistence.read(reader => reader.getProject(p.id));
  assert.ok(beforeStale);
  const stale = await proposeNativeKnowledgeChange({ persistence, projectId: p.id, projectVersion: beforeStale.version, actorId: "actor", idempotencyKey: "stale", operations: [nodeOperation(p.id, "stale")] });
  await persistence.transaction(tx => tx.saveKnowledgeNode({ projectId: p.id, id: randomUUID() as KnowledgeNodeId, type: "person", name: "intervening", attributes: {}, status: "confirmed", expectedVersion: null }));
  const staleApproved = await approveNativeChangeSet(persistence, p.id, stale.changeSet.id, stale.changeSet.version, "author");
  await assert.rejects(applyNativeChangeSet(persistence, p.id, staleApproved.id, staleApproved.version));
  assert.equal(await persistence.read(reader => reader.getKnowledgeNode(p.id, (stale.changeSet.operations[0] as NodeOperation).command.id)), undefined);
});

test("existing alias upserts capture presence and replay unchanged after application", async () => {
  const p = await project("native-upsert");
  const node = nodeOperation(p.id, "Alias node");
  const aliasId = randomUUID() as import("@codexia/persistence-contracts").KnowledgeAliasId;
  const alias: Extract<ChangeSetOperation, { type: "knowledge.alias.save" }> = { type: "knowledge.alias.save", command: { projectId: p.id, id: aliasId, nodeId: node.command.id, surface: "old", normalized: "old", scope: null, status: "proposed" } };
  await persistence.transaction(async tx => { await tx.saveKnowledgeNode(node.command); await tx.saveKnowledgeAlias(alias.command); });
  const current = await persistence.read(reader => reader.getProject(p.id));
  assert.ok(current);
  const operation: ChangeSetOperation = { ...alias, command: { ...alias.command, surface: "new", normalized: "new" } };
  const request = { persistence, projectId: p.id, projectVersion: current.version, actorId: "actor", idempotencyKey: "update-alias", operations: [operation] };
  const proposal = await proposeNativeKnowledgeChange(request);
  assert.equal(proposal.changeSet.readSet.find(entry => entry.resource === "knowledge_alias")?.expectedVersion, 1);
  const approved = await approveNativeChangeSet(persistence, p.id, proposal.changeSet.id, proposal.changeSet.version, "author");
  await applyNativeChangeSet(persistence, p.id, approved.id, approved.version);
  assert.equal((await persistence.read(reader => reader.listKnowledgeAliases(p.id, node.command.id)))[0]?.surface, "new");
  assert.equal((await proposeNativeKnowledgeChange(request)).replayed, true);
});

test("authenticated persistence routes expose the native ChangeSet review lifecycle", async () => {
  const p = await project("native-route");
  const operation = nodeOperation(p.id, "Route node");
  const base = { persistence, requestHeaders: { "idempotency-key": "route-change" }, async requireAuthor() { return "authenticated-author"; } };
  const created = await handlePersistenceRoute({ ...base, method: "POST", url: `/api/v1/persistence/projects/${p.id}/changesets`, body: { projectVersion: p.version, operations: [operation] } });
  assert.equal(created?.status, 201);
  const changeSet = (created?.body as { changeSet: { id: string; version: number } }).changeSet;
  const listed = await handlePersistenceRoute({ ...base, method: "GET", url: `/api/v1/persistence/projects/${p.id}/changesets` , body: null });
  assert.ok((listed?.body as { changeSets: readonly { id: string }[] }).changeSets.some(item => item.id === changeSet.id));
  const approved = await handlePersistenceRoute({ ...base, method: "POST", url: `/api/v1/persistence/projects/${p.id}/changesets/${changeSet.id}/approve`, body: { expectedVersion: changeSet.version } });
  const approvedSet = (approved?.body as { changeSet: { version: number } }).changeSet;
  const applied = await handlePersistenceRoute({ ...base, method: "POST", url: `/api/v1/persistence/projects/${p.id}/changesets/${changeSet.id}/apply`, body: { expectedVersion: approvedSet.version } });
  assert.equal((applied?.body as { changeSet: { status: string } }).changeSet.status, "applied");
  const fetched = await handlePersistenceRoute({ ...base, method: "GET", url: `/api/v1/persistence/projects/${p.id}/changesets/${changeSet.id}`, body: null });
  assert.equal((fetched?.body as { receipt: { results: readonly unknown[] } }).receipt.results.length, 1);
});
