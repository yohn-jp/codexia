import assert from "node:assert/strict";
import { test } from "node:test";
import { BUILTIN_MODULE_IDS } from "@codexia/contracts";
import { responseContracts } from "./api-response.js";

const snapshot = { projectId: "fixture", projectVersion: 1 };

test("browser DTO guards accept exactly the canonical built-in module IDs", () => {
  for (const id of BUILTIN_MODULE_IDS) {
    assert.equal(responseContracts.modules([{ id, availability: "disabled", activeJobs: 0 }]), true);
    assert.equal(responseContracts.contributions([{ id: "test.contribution", module: id, slot: "dock", title: "Test", action: "test.run" }]), true);
    assert.equal(responseContracts.proposal({
      id: "proposal-1", snapshot, source: "module", operations: [],
      evidence: [{ id: "evidence-1", snapshot, module: id, kind: "test", paths: [], details: {} }],
    }), true);
  }

  assert.equal(responseContracts.modules([{ id: "experimental", availability: "disabled", activeJobs: 0 }]), false);
  assert.equal(responseContracts.contributions([{ id: "test.contribution", module: "experimental", slot: "dock", title: "Test", action: "test.run" }]), false);
  assert.equal(responseContracts.proposal({
    id: "proposal-1", snapshot, source: "module", operations: [],
    evidence: [{ id: "evidence-1", snapshot, module: "experimental", kind: "test", paths: [], details: {} }],
  }), false);
});

test("native ChangeSet guards preserve wire operation variants and reject inconsistent payloads", () => {
  const projectId = "project-1";
  const operations = [
    { type: "knowledge.node.save", command: { projectId, id: "node-1", type: "person", name: "人物", attributes: {}, status: "proposed", expectedVersion: null } },
    { type: "knowledge.alias.save", command: { projectId, id: "alias-1", nodeId: "node-1", surface: "主人公", normalized: "主人公", scope: null, status: "proposed" } },
    { type: "knowledge.relation.save", command: { projectId, id: "relation-1", sourceId: "node-1", targetId: "node-2", type: "knows", attributes: {}, validity: {}, status: "proposed", expectedVersion: null } },
    { type: "evidence.anchor.save", command: { projectId, id: "evidence-1", documentId: "doc-1", revisionId: "rev-1", fromUtf16: 2, toUtf16: 4, quoteSha256: "a".repeat(64), status: "proposed", expectedVersion: null } },
    { type: "evidence.mention.save", command: { projectId, evidenceId: "evidence-1", nodeId: "node-1", source: "manual", confidence: null, extractorVersion: null, status: "proposed" } },
    { type: "evidence.assertion.save", command: { projectId, id: "assertion-1", proposition: { statement: "人物" }, modality: "fact", perspective: "narrator", narrativeTime: {}, confidence: null, status: "proposed", expectedVersion: null } },
    { type: "evidence.assertion.link", command: { projectId, assertionId: "assertion-1", evidenceId: "evidence-1", role: "supports" } },
  ];
  const changeSet = {
    id: "change-1", projectId, authorId: "actor-1", status: "proposed", version: 1,
    idempotencyKey: "request-1", operations,
    readSet: [{ resource: "knowledge_node", id: "node-1", expectedVersion: null }],
    writeSet: [{ resource: "knowledge_node", id: "node-1" }],
    provenance: { source: "native-knowledge-service", actorId: "actor-1", details: { projectVersion: 4 } },
    createdAt: "2026-01-01T00:00:00.000Z", approvedAt: null, approvedBy: null, appliedAt: null, rejectedAt: null, rejectedBy: null,
  };
  assert.equal(responseContracts.nativeChangeSets({ changeSets: [changeSet] }), true);
  assert.equal(responseContracts.nativeChangeSet({ changeSet, receipt: undefined }), true);
  const merge = { type: "knowledge.merge", command: {
    projectId: "project-1", sourceId: "source-1", targetId: "target-1", projectVersion: 4, previewDigest: "a".repeat(64),
    actorId: "external-actor", origin: "external-agent", auditId: "audit-1", generatedAliasId: "alias-1",
    plan: { source: { id: "source-1", name: "Source" }, target: { id: "target-1", name: "Target" }, sourceAliases: [], targetAliases: [], sourceRelations: [], targetRelations: [], sourceMentions: [], targetMentions: [], assertions: [], conflicts: [] },
  } };
  assert.equal(responseContracts.nativeChangeSets({ changeSets: [{ ...changeSet, operations: [merge] }] }), true);
  const foreignMerge = { ...merge, command: { ...merge.command, projectId: "different-project" } };
  assert.equal(responseContracts.nativeChangeSet({ changeSet: { ...changeSet, operations: [foreignMerge] } }), false);
  assert.equal(responseContracts.nativeChangeSets({ changeSets: [{ ...changeSet, operations: [{ type: "knowledge.merge", command: { ...merge.command, previewDigest: "stale" } }] }] }), false);
  assert.equal(responseContracts.nativeChangeSets({ changeSets: [{ ...changeSet, operations: [{ type: "knowledge.future", command: {} }] }] }), false);
  assert.equal(responseContracts.nativeChangeSets({ changeSets: [{ ...changeSet, readSet: [{ resource: "knowledge_node", id: "node-1", expectedVersion: "1" }] }] }), false);
});

test("unified author review guard preserves the two receipt and approval models", () => {
  const reviewSnapshot = { projectId: "project-1", projectVersion: 1 };
  const status = {
    proposal: { id: "legacy-1", snapshot: reviewSnapshot, source: "module", operations: [] },
    state: "partially_approved", approvedOperationIds: ["op-1"], applications: [], appliedOperationIds: [], stale: false,
  };
  const native = {
    kind: "native-change-set",
    id: "change-1", projectId: "project-1", createdAt: "2026-01-01T00:00:00.000Z", state: "proposed",
    approvalModel: "whole-change-set", applicationModel: "transaction",
    changeSet: {
      id: "change-1", projectId: "project-1", authorId: "author-1", status: "proposed", version: 1,
      idempotencyKey: "request-1", operations: [], readSet: [], writeSet: [],
      provenance: { source: "native-knowledge-service", actorId: "author-1", details: {} },
      createdAt: "2026-01-01T00:00:00.000Z", approvedAt: null, approvedBy: null, appliedAt: null, rejectedAt: null, rejectedBy: null,
    },
    receipt: null,
  };
  const core = {
    kind: "core-proposal",
    id: "legacy-1", projectId: "project-1", createdAt: "2026-01-01T00:00:00.000Z", state: "partially_approved",
    approvalModel: "per-operation", applicationModel: "per-operation", status, receipts: [], stale: false,
  };
  assert.equal(responseContracts.authorReviewFeed({ items: [core, native] }), true);
  assert.equal(responseContracts.authorReviewFeed({ items: [{ ...native, changeSet: { ...native.changeSet, operations: [{ type: "knowledge.future", command: {} }] } }] }), false);
  assert.equal(responseContracts.authorReviewFeed({ items: [{ ...native, approvalModel: "per-operation" }] }), false);
  assert.equal(responseContracts.authorReviewFeed({ items: [{ ...core, status: { ...status, proposal: { ...status.proposal, source: "future" } } }] }), false);
});
