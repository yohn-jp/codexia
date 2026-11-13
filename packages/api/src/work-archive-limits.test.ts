import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { test } from "node:test";
import type { Persistence, ProjectId, KnowledgeNodeId, EvidenceId } from "@codexia/persistence-contracts";
import { exportWorkArchive } from "./work-archive.js";

const projectId = randomUUID() as ProjectId;
const nodeId = randomUUID() as KnowledgeNodeId;
const documentId = randomUUID();
const revisionId = randomUUID();
const evidenceId = randomUUID() as EvidenceId;
const quoteSha256 = createHash("sha256").update("x").digest("hex");
const records = (count: number, build: (index: number) => Record<string, unknown>) =>
  Array.from({ length: count }, (_, index) => build(index));
const mentionNodeIds = Array.from({ length: 999 }, () => randomUUID());

function persistence(overrides: Record<string, unknown>): Persistence {
  const reader = {
    getProject: async () => ({ id: projectId, title: "Fixture", settings: {}, version: 1, createdAt: "", updatedAt: "" }),
    listDocuments: async () => [{ id: documentId, parentId: null, kind: "scene", title: "Scene", orderKey: "0", headRevisionId: revisionId }],
    getRevision: async () => ({ id: revisionId, markdown: "x" }),
    listAllKnowledgeNodes: async () => [{ id: nodeId, type: "person", name: "A", attributes: {}, status: "confirmed" }],
    listKnowledgeAliases: async () => [],
    listKnowledgeRelations: async () => [],
    listDocumentEvidence: async () => [{ id: evidenceId, documentId, revisionId, fromUtf16: 0, toUtf16: 1, quoteSha256, status: "confirmed" }],
    listMentionLinks: async () => [],
    listEvidenceAssertions: async () => [],
    listAssertions: async () => [],
    listModuleRecords: async () => [],
    ...overrides,
  };
  return { read: (work) => work(reader as never), transaction: async () => { throw new Error("unused"); }, close: async () => {} } as Persistence;
}

test("archive export fails when alias, relation, or assertion evidence reads may be truncated", async (t) => {
  const assertionIds = records(201, () => ({ id: randomUUID(), proposition: {}, modality: "stated", perspective: "narrator", narrativeTime: {}, confidence: null, status: "confirmed" }));
  const tests = [
    ["aliases", persistence({
      listKnowledgeAliases: async (_project: unknown, _node: unknown, limit = 500) => records(1001, (i) => ({ id: randomUUID(), nodeId, surface: `a${i}`, normalized: `a${i}`, scope: null, status: "confirmed" })).slice(0, limit),
    })],
    ["relations", persistence({
      listKnowledgeRelations: async (_project: unknown, _node: unknown, limit = 500) => records(1001, (i) => ({ id: randomUUID(), sourceId: nodeId, targetId: nodeId, type: `r${i}`, attributes: {}, validity: {}, status: "confirmed" })).slice(0, limit),
    })],
    ["assertion evidence overflow", persistence({
      listAssertions: async () => assertionIds,
      listEvidenceAssertions: async (_project: unknown, _evidence: unknown, limit = 100) => records(201, (i) => ({ assertionId: assertionIds[i]!.id, evidenceId, role: "supports" })).slice(0, limit),
    })],
  ] as const;
  for (const [name, store] of tests) {
    await t.test(name, async () => {
      await assert.rejects(exportWorkArchive(store, projectId), { code: "WORK_ARCHIVE_LIMIT" });
    });
  }
});

test("archive export reads every mention within the bounded node inventory", async () => {
  const store = persistence({
    listAllKnowledgeNodes: async () => mentionNodeIds.map((id) => ({ id, type: "person", name: "A", attributes: {}, status: "confirmed" })),
    listMentionLinks: async (_project: unknown, _evidence: unknown, limit = 500) => records(mentionNodeIds.length, (i) => ({ evidenceId, nodeId: mentionNodeIds[i]!, status: "confirmed", source: `s${i}`, confidence: null, extractorVersion: null })).slice(0, limit),
  });
  const archive = await exportWorkArchive(store, projectId);
  assert.equal(archive.evidence.mentions.length, mentionNodeIds.length);
});
