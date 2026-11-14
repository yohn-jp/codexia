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

const aliasRows = (count: number) => records(count, (i) => ({
  id: randomUUID(), nodeId, surface: `a${i}`, normalized: `a${i}`, scope: null, status: "confirmed",
}));
const relationRows = (count: number) => records(count, (i) => ({
  id: randomUUID(), sourceId: nodeId, targetId: nodeId, type: `r${i}`, attributes: {}, validity: {}, status: "confirmed",
}));
const mentionRows = (count: number) => records(count, (i) => ({
  evidenceId, nodeId: mentionNodeIds[i] ?? randomUUID(), status: "confirmed", source: `s${i}`,
  confidence: null, extractorVersion: null,
}));
const assertionRows = (count: number) => records(count, () => ({
  id: randomUUID(), proposition: {}, modality: "stated", perspective: "narrator", narrativeTime: {},
  confidence: null, status: "confirmed",
}));

function mentionStore(count: number): Persistence {
  return persistence({
    listAllKnowledgeNodes: async () => mentionNodeIds.map((id) => ({ id, type: "person", name: "A", attributes: {}, status: "confirmed" })),
    listMentionLinks: async (_project: unknown, _evidence: unknown, limit = 500) => mentionRows(count).slice(0, limit),
  });
}

function assertionStore(count: number): Persistence {
  const assertions = assertionRows(count);
  return persistence({
    listAssertions: async () => assertions,
    listEvidenceAssertions: async (_project: unknown, _evidence: unknown, limit = 100) =>
      records(count, (i) => ({ assertionId: assertions[i]!.id, evidenceId, role: "supports" })).slice(0, limit),
  });
}

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

test("archive export rejects full alias, relation, mention, and assertion-evidence pages", async (t) => {
  const cases = [
    ["aliases", [1000, 1001], (count: number) => persistence({ listKnowledgeAliases: async (_project: unknown, _node: unknown, limit = 500) => aliasRows(count).slice(0, limit) })],
    ["relations", [1000, 1001], (count: number) => persistence({ listKnowledgeRelations: async (_project: unknown, _node: unknown, limit = 500) => relationRows(count).slice(0, limit) })],
    ["mentions", [1000, 1001], (count: number) => mentionStore(count)],
    ["assertion evidence", [200, 201], (count: number) => assertionStore(count)],
  ] as const;
  for (const [name, counts, createStore] of cases) for (const count of counts) {
    await t.test(`${name} at ${count}`, async () => {
      await assert.rejects(exportWorkArchive(createStore(count), projectId), { code: "WORK_ARCHIVE_LIMIT" });
    });
  }
});

test("archive export returns every row immediately below each bounded page limit", async (t) => {
  const cases: readonly [string, Persistence, (archive: Awaited<ReturnType<typeof exportWorkArchive>>) => number, number][] = [
    ["999 aliases", persistence({ listKnowledgeAliases: async (_project: unknown, _node: unknown, limit = 500) => aliasRows(999).slice(0, limit) }), (archive) => archive.knowledge.aliases.length, 999],
    ["999 relations", persistence({ listKnowledgeRelations: async (_project: unknown, _node: unknown, limit = 500) => relationRows(999).slice(0, limit) }), (archive) => archive.knowledge.relations.length, 999],
    ["999 mentions", mentionStore(999), (archive) => archive.evidence.mentions.length, 999],
    ["199 assertion evidence links", assertionStore(199), (archive) => archive.evidence.assertionEvidence.length, 199],
  ];
  for (const [name, store, countOf, expected] of cases) await t.test(name, async () => {
    assert.equal(countOf(await exportWorkArchive(store, projectId)), expected);
  });
});
