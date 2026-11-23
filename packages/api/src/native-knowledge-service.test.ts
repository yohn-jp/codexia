import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import type { ModuleActionContext } from "@codexia/contracts";
import { CoreStore } from "@codexia/core";
import type { ChangeSet, ChangeSetOperation, KnowledgeNodeId, ProjectId } from "@codexia/persistence-contracts";
import { createPostgresPersistence, migratePostgresDatabase } from "@codexia/persistence-postgres";
import { createNativeKnowledgeActions } from "./native-knowledge-actions.js";
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

test("only author review reads include private Publishing ChangeSets and receipts", async () => {
  const p = await project("private-publishing-review");
  const ordinary = await proposeNativeKnowledgeChange({
    persistence, projectId: p.id, projectVersion: p.version, actorId: "reviewer",
    idempotencyKey: "ordinary", operations: [nodeOperation(p.id, "Visible character")],
  });
  const share = {
    version: 1, grantVersion: 1, revocationVersion: 0, id: "private-review-grant",
    label: "Private proofreading", tokenHash: createHash("sha256").update("test share descriptor").digest("hex"),
    scope: { kind: "chapter", id: "proofreading-chapter" }, createdAt: "2026-04-01T10:00:00.000Z", expiresAt: "2026-04-02T10:00:00.000Z",
  };
  const identity = JSON.stringify(["publishing", "share-grants"]);
  const privateReview = await persistence.transaction(tx => tx.createChangeSet({
    projectId: p.id, authorId: "reviewer", idempotencyKey: "publishing-share",
    operations: [{ type: "module.record.save", command: { projectId: p.id, moduleId: "publishing", key: "share-grants", value: { version: 1, grants: [share] }, expectedVersion: null } }],
    readSet: [{ resource: "module_record", id: identity, expectedVersion: null }],
    writeSet: [{ resource: "module_record", id: identity }],
    provenance: { source: "publishing.native", actorId: "reviewer", details: { projectVersion: p.version } },
  }));
  const approved = await approveNativeChangeSet(persistence, p.id, privateReview.changeSet.id, 1, "reviewer");
  await applyNativeChangeSet(persistence, p.id, approved.id, approved.version);

  const baseUrl = `/api/v1/persistence/projects/${p.id}/changesets`;
  const route = (url: string, canReviewPrivateChangeSets: boolean) => {
    const request = { persistence, url, body: null, requestHeaders: {}, canReviewPrivateChangeSets,
      async requireAuthor() { assert.fail("GET must use the host's verified review permission"); } };
    return handlePersistenceRoute({ ...request, method: "GET" });
  };
  const externalList = await route(`${baseUrl}?limit=1`, false);
  assert.equal(externalList?.status, 200);
  assert.deepEqual((externalList.body as { changeSets: Array<{ id: string }> }).changeSets.map(set => set.id), [ordinary.changeSet.id]);
  assert.equal((await route(`${baseUrl}/${approved.id}`, false))?.status, 404);
  assert.equal((await route(`${baseUrl}/${ordinary.changeSet.id}`, false))?.status, 200);

  const authorList = await route(`${baseUrl}?limit=1`, true);
  assert.equal(authorList?.status, 200);
  assert.deepEqual((authorList.body as { changeSets: Array<{ id: string }> }).changeSets.map(set => set.id), [approved.id]);
  const authorDetail = await route(`${baseUrl}/${approved.id}`, true);
  assert.equal(authorDetail?.status, 200);
  assert.match(JSON.stringify((authorDetail.body as { receipt: unknown }).receipt), /Private proofreading/);

  const port = { persistence, projectId: p.id, actorId: "reviewer", canReviewPrivateChangeSets: true, authorizeProposal: async () => {} };
  const actions = createNativeKnowledgeActions({ ...port, origin: "external-agent" });
  const unusedAccess = async () => assert.fail("review reads do not use other module capabilities");
  const context: ModuleActionContext = {
    projectId: p.id, reader: await new CoreStore({ persistence }).reader(p.id), signal: new AbortController().signal,
    invoke: unusedAccess, listActions: unusedAccess, linkedReader: unusedAccess, propose: unusedAccess, runJob: unusedAccess,
  };
  const relevant = actions.find(action => action.id === "core.changesets.list")!;
  const externalActionList = await relevant.invoke({ limit: 1 }, context);
  assert.ok(externalActionList.ok);
  assert.deepEqual((externalActionList.data as { changeSets: Array<{ id: string }> }).changeSets.map(set => set.id), [ordinary.changeSet.id]);
  const get = actions.find(action => action.id === "core.changeset.get")!;
  const externalActionDetail = await get.invoke({ changeSetId: approved.id }, context);
  assert.ok(externalActionDetail.ok);
  assert.equal(externalActionDetail.data, null);
  const authorGet = createNativeKnowledgeActions({ ...port, origin: "author" }).find(action => action.id === "core.changeset.get")!;
  const authorActionDetail = await authorGet.invoke({ changeSetId: approved.id }, context);
  assert.ok(authorActionDetail.ok);
  assert.match(JSON.stringify((authorActionDetail.data as { receipt: unknown }).receipt), /Private proofreading/);
});

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

test("native proposal action replays the original PostgreSQL record under a newer reader", async () => {
  const p = await project("native-action-replay");
  const core = new CoreStore({ persistence });
  const unusedAccess = async () => assert.fail("native proposal does not use other module capabilities");
  const context: ModuleActionContext = {
    projectId: p.id,
    reader: await core.reader(p.id),
    signal: new AbortController().signal,
    invoke: unusedAccess, listActions: unusedAccess, linkedReader: unusedAccess, propose: unusedAccess, runJob: unusedAccess,
  };
  const actions = createNativeKnowledgeActions({
    persistence, projectId: p.id, actorId: "external-proposer", origin: "external-agent", authorizeProposal: async () => {},
  });
  const action = actions.find(action => action.id === "core.knowledge.propose")!;
  const operation = nodeOperation(p.id, "Original proposal");
  const request = { projectVersion: context.reader.snapshot.projectVersion, idempotencyKey: "action-replay", operations: [operation] };
  const original = await action.invoke(request, context);
  assert.ok(original.ok);
  const submitted = original.data as { changeSet: ChangeSet; replayed: boolean };
  assert.equal(submitted.replayed, false);
  assert.equal(submitted.changeSet.status, "proposed");
  assert.equal(submitted.changeSet.provenance.details.projectVersion, p.version);

  const updated = await persistence.transaction(tx => tx.updateProject({ projectId: p.id, expectedVersion: p.version, title: "Intervening edit" }));
  const newer = { ...context, reader: await core.reader(p.id) };
  assert.ok(updated.version > request.projectVersion);
  assert.equal(newer.reader.snapshot.projectVersion, updated.version);

  const replay = await action.invoke(request, newer);
  assert.ok(replay.ok, replay.ok ? undefined : replay.error.code);
  assert.deepEqual(replay.snapshot, newer.reader.snapshot);
  assert.deepEqual(replay.data, { changeSet: submitted.changeSet, replayed: true });

  const changed = await action.invoke({
    ...request, operations: [{ ...operation, command: { ...operation.command, name: "Changed proposal" } }],
  }, newer);
  assert.ok(!changed.ok);
  assert.equal(changed.error.code, "idempotency_conflict");
  assert.deepEqual(await persistence.read(reader => reader.listChangeSets(p.id)), [submitted.changeSet]);
  assert.equal(await persistence.read(reader => reader.getKnowledgeNode(p.id, operation.command.id)), undefined);
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

test("author review feed joins both durable proposal authorities and keeps their receipts distinct", async () => {
  const p = await project("author-review-feed");
  const legacyReceipt = { operationId: "legacy-op", generation: 0, projectVersion: p.version, revisions: [] };
  await persistence.transaction(tx => tx.saveModuleRecord({
    projectId: p.id, moduleId: "core.authority.proposals", key: "proposal:legacy",
    value: {
      proposal: { id: "legacy", snapshot: { projectId: p.id, projectVersion: p.version }, operations: [], source: "module" },
      state: "partially_approved", approvedOperationIds: ["legacy-op"], applications: [legacyReceipt], appliedOperationIds: [], stale: false,
    },
    expectedVersion: null,
  }));
  const created = await proposeNativeKnowledgeChange({
    persistence, projectId: p.id, projectVersion: p.version, actorId: "author", idempotencyKey: "feed-native",
    operations: [nodeOperation(p.id, "Feed node")],
  });
  const authCalls: string[] = [];
  const response = await handlePersistenceRoute({
    persistence, method: "GET", url: `/api/v1/persistence/projects/${p.id}/review-feed?limit=20`, body: null,
    requestHeaders: {}, async requireAuthor() { authCalls.push("author"); return "author"; },
  });
  assert.deepEqual(authCalls, ["author"], "the unified feed is restricted to authenticated authors");
  const items = (response?.body as { items: Array<Record<string, unknown>> }).items;
  assert.deepEqual(items.map(item => item.kind).sort(), ["core-proposal", "native-change-set"]);
  const legacy = items.find(item => item.kind === "core-proposal")!;
  assert.equal(legacy.state, "partially_approved");
  assert.equal((legacy.receipts as unknown[]).length, 1);
  const native = items.find(item => item.kind === "native-change-set")!;
  assert.equal(native.state, "proposed");
  assert.equal(native.approvalModel, "whole-change-set");
  assert.equal(native.applicationModel, "transaction");
  assert.equal(native.receipt, null);
  assert.equal((native.changeSet as { id: string }).id, created.changeSet.id);
});
