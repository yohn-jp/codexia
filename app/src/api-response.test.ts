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

test("native ChangeSet guards accept only the seven integrated Knowledge and Evidence operations", () => {
  const types = ["knowledge.node.save", "knowledge.alias.save", "knowledge.relation.save", "evidence.anchor.save", "evidence.mention.save", "evidence.assertion.save", "evidence.assertion.link"];
  const changeSet = {
    id: "change-1", projectId: "project-1", authorId: "actor-1", status: "proposed", version: 1,
    idempotencyKey: "request-1", operations: types.map((type) => ({ type, command: {
      projectId: "project-1", id: "node-1", type: "person", name: "人物", nodeId: "node-1", surface: "人物", normalized: "人物", scope: null,
      sourceId: "node-1", targetId: "node-2", attributes: {}, validity: {}, documentId: "doc-1", revisionId: "rev-1", fromUtf16: 0, toUtf16: 1,
      quoteSha256: "a".repeat(64), evidenceId: "evidence-1", assertionId: "assertion-1", source: "manual", confidence: null, extractorVersion: null,
      proposition: { statement: "人物" }, modality: "fact", perspective: "narrator", narrativeTime: {}, role: "supports", status: "proposed", expectedVersion: null,
    } })),
    readSet: [{ resource: "knowledge_node", id: "node-1", expectedVersion: null }],
    writeSet: [{ resource: "knowledge_node", id: "node-1" }],
    provenance: { source: "native-knowledge-service", actorId: "actor-1", details: { projectVersion: 4 } },
    createdAt: "2026-01-01T00:00:00.000Z", approvedAt: null, approvedBy: null, appliedAt: null, rejectedAt: null, rejectedBy: null,
  };
  assert.equal(responseContracts.nativeChangeSets({ changeSets: [changeSet] }), true);
  assert.equal(responseContracts.nativeChangeSet({ changeSet, receipt: undefined }), true);
  assert.equal(responseContracts.nativeChangeSets({ changeSets: [{ ...changeSet, operations: [{ type: "knowledge.merge", command: {} }] }] }), false);
  assert.equal(responseContracts.nativeChangeSets({ changeSets: [{ ...changeSet, readSet: [{ resource: "knowledge_node", id: "node-1", expectedVersion: "1" }] }] }), false);
});
