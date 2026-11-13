import assert from "node:assert/strict";
import test from "node:test";
import type { ActionResult, ModuleActionContext, SnapshotId } from "@codexia/contracts";
import type { Persistence, ProjectId } from "@codexia/persistence-contracts";
import { createNativeKnowledgeActions } from "./native-knowledge-actions.js";

const projectId = "11111111-1111-4111-8111-111111111111" as ProjectId;
const actorId = "author-from-host";
const snapshot: SnapshotId = { projectId, projectVersion: 4 };
const context = { projectId, reader: { snapshot }, signal: new AbortController().signal } as unknown as ModuleActionContext;

test("native Knowledge catalog exposes the stable read and proposal action contract", () => {
  const actions = createNativeKnowledgeActions({ persistence: {} as Persistence, projectId, actorId, origin: "external-agent", authorizeProposal: async () => {} });
  assert.deepEqual(actions.map(action => [action.id, action.effect]), [
    ["core.knowledge.nodes.list", "read"], ["core.knowledge.node.get", "read"],
    ["core.knowledge.aliases.list", "read"], ["core.knowledge.relations.list", "read"],
    ["core.evidence.anchor.get", "read"], ["core.evidence.document.list", "read"],
    ["core.evidence.node.list", "read"], ["core.evidence.assertion.get", "read"],
    ["core.evidence.assertion.list", "read"], ["core.changesets.list", "read"],
    ["core.changeset.get", "read"], ["core.knowledge.propose", "propose"],
  ]);
});

test("proposal action binds host actor and project and rechecks host authorization", async () => {
  let command: Record<string, unknown> | undefined;
  let authorizations = 0;
  const persistence = {
    transaction: async (work: (transaction: unknown) => Promise<unknown>) => work({ createChangeSet: async (value: Record<string, unknown>) => { command = value; return { changeSet: { id: "native-change-set", projectId, status: "proposed" }, replayed: false }; } }),
  } as unknown as Persistence;
  const action = createNativeKnowledgeActions({ persistence, projectId, actorId, origin: "external-agent", authorizeProposal: async () => { authorizations++; } }).find(item => item.id === "core.knowledge.propose")!;
  const result = await action.invoke({ projectVersion: 4, idempotencyKey: "retry-1", operations: [{ type: "knowledge.node.save", command: { projectId, id: "22222222-2222-4222-8222-222222222222", type: "person", name: "A", attributes: {}, status: "proposed", expectedVersion: null } }] }, context) as ActionResult;
  assert.equal(result.ok, true);
  assert.equal(authorizations, 1);
  assert.equal(command?.projectId, projectId);
  assert.equal(command?.authorId, actorId);
  assert.equal((command?.provenance as { details: { origin: string } }).details.origin, "external-agent");
});

test("native read refuses a projectVersion different from its selected reader", async () => {
  const action = createNativeKnowledgeActions({ persistence: {} as Persistence, projectId, actorId, origin: "author", authorizeProposal: async () => {} }).find(item => item.id === "core.knowledge.nodes.list")!;
  const result = await action.invoke({ projectVersion: 3 }, context) as ActionResult;
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "snapshot_unavailable");
});

test("proposal accepts original source version for exact retry under a newer action reader", async () => {
  let sourceVersion = 0;
  const persistence = {
    transaction: async (work: (transaction: unknown) => Promise<unknown>) => work({ createChangeSet: async (value: Record<string, unknown>) => {
      sourceVersion = ((value.provenance as { details: { projectVersion: number } }).details.projectVersion);
      return { changeSet: { id: "native-change-set", projectId, status: "proposed" }, replayed: true };
    } }),
  } as unknown as Persistence;
  const action = createNativeKnowledgeActions({ persistence, projectId, actorId, origin: "external-agent", authorizeProposal: async () => {} }).find(item => item.id === "core.knowledge.propose")!;
  const operation = { type: "knowledge.node.save", command: { projectId, id: "22222222-2222-4222-8222-222222222222", type: "person", name: "A", attributes: {}, status: "proposed", expectedVersion: null } };
  const result = await action.invoke({ projectVersion: 3, idempotencyKey: "retry-1", operations: [operation] }, context) as ActionResult;
  assert.equal(result.ok, true);
  assert.equal(sourceVersion, 3);
});

test("proposal authorization denial prevents the native transaction", async () => {
  let transactions = 0;
  const persistence = { async transaction() { transactions++; throw new Error("transaction must not run"); } } as unknown as Persistence;
  const action = createNativeKnowledgeActions({
    persistence, projectId, actorId, origin: "external-agent",
    authorizeProposal: async () => { throw Object.assign(new Error("write grant required"), { code: "WRITE_PERMISSION_REQUIRED" }); },
  }).find(item => item.id === "core.knowledge.propose")!;
  const result = await action.invoke({ projectVersion: 4, idempotencyKey: "denied", operations: [] }, context) as ActionResult;
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "WRITE_PERMISSION_REQUIRED");
  assert.equal(transactions, 0);
});
