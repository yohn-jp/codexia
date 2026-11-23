import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { AssertionId, Document, EvidenceId, KnowledgeAliasId, KnowledgeNodeId, KnowledgeProjectionBatch, KnowledgeRelationId, PersistenceReader, ProjectId, RevisionId } from "@codexia/persistence-contracts";
import { makeKnowledgeProjection, projectKnowledgeContext } from "./knowledge-context.js";

test("Knowledge projection binds evidence to Story identity and exact anchored revision", async () => {
  const documentId = "document-uuid" as Document["id"];
  const revisionId = "historical-revision" as RevisionId;
  let markdown = "Opening 😀 evidence, then edited text";
  let quote = "evidence";
  const evidenceDigest = "ee8250fb76e094b34b471f13a73dbbe51d1ae142e9df59d7c0d31ec20f0a0a8e";
  let quoteSha256 = evidenceDigest;
  let fromUtf16 = markdown.indexOf(quote);
  let batchReads = 0;
  const knowledgeIds = ["knowledge-1", "knowledge-2"] as KnowledgeNodeId[];
  const evidenceId = "evidence-1" as EvidenceId;
  const times = { createdAt: "", updatedAt: "" };
  const sourceRevision = () => ({
    id: revisionId, projectId: "project-1" as ProjectId, documentId, parentRevisionId: null,
    markdown, sha256: "", authorId: "author", createdAt: "",
  });
  let aliasCount = 0;
  let relationCount = 0;
  let assertionCount = 0;
  const reader: Pick<PersistenceReader, "listKnowledgeNodes" | "readKnowledgeProjectionBatch"> = {
    async listKnowledgeNodes(projectId) {
      return knowledgeIds.map(id => ({ id, projectId, type: "lore", name: "The clue", attributes: {},
        status: "confirmed", version: 1, deletedAt: null, createdAt: "", updatedAt: "" }));
    },
    async readKnowledgeProjectionBatch(projectId, nodeIds, limits): Promise<KnowledgeProjectionBatch> {
      assert.equal(projectId, "project-1");
      assert.deepEqual(nodeIds, knowledgeIds);
      assert.deepEqual(limits, { aliasesPerNode: 500, relationsPerNode: 500, mentionsPerNode: 100, assertionsPerAnchor: 100 });
      batchReads++;
      const assertionIds = Array.from({ length: assertionCount }, (_, index) => `assertion-${index}` as AssertionId);
      return {
        aliases: Array.from({ length: aliasCount }, (_, index) => ({
          nodeId: knowledgeIds[0]!,
          alias: { id: `alias-${index}` as KnowledgeAliasId, projectId, nodeId: knowledgeIds[0]!,
            surface: `Alias ${index}`, normalized: `alias ${index}`, scope: null, status: "confirmed", ...times },
        })),
        relations: Array.from({ length: relationCount }, (_, index) => ({
          nodeId: knowledgeIds[0]!,
          relation: { id: `relation-${index}` as KnowledgeRelationId, projectId, sourceId: knowledgeIds[0]!, targetId: knowledgeIds[1]!,
            type: "visits", attributes: {}, validity: {}, status: "confirmed", version: 1, ...times },
        })),
        mentions: [{ projectId, evidenceId, nodeId: knowledgeIds[0]!, status: "confirmed", source: "author",
          confidence: null, extractorVersion: null, ...times }],
        anchors: [{ id: evidenceId, projectId, documentId, revisionId, fromUtf16, toUtf16: fromUtf16 + quote.length,
          quoteSha256, status: "confirmed", version: 1,
          createdAt: "", updatedAt: "" }],
        revisions: [sourceRevision()],
        assertionEvidence: assertionIds.map(assertionId => ({
          evidenceId, link: { projectId, assertionId, evidenceId, role: "supports", createdAt: "" },
        })),
        assertions: assertionIds.map(id => ({
          id, projectId, proposition: { subject: "The clue" }, modality: "certain", perspective: "author",
          narrativeTime: {}, confidence: null, status: "confirmed", version: 1, ...times,
        })),
      };
    },
  };
  const documents = [
    { id:documentId, projectId:"project-1" as ProjectId, kind:"scene", parentId:null, title:"Scene", orderKey:"1", headRevisionId:"current-revision" as RevisionId, version:2, createdAt:"", updatedAt:"" },
  ];
  const documentMappings = [{ documentId, storySceneId:"scene-story-id" }];
  const projection = await projectKnowledgeContext(reader, "project-1" as ProjectId, documents, documentMappings);
  const evidence = projection.entries[0]!.evidence[0];
  assert.equal(projection.documentMappings[0]?.storySceneId, "scene-story-id");
  assert.equal(evidence?.storySceneId, "scene-story-id");
  assert.equal(evidence?.anchor.revisionId, revisionId);
  assert.equal(evidence?.quote, "evidence");
  assert.equal(evidence?.current, false);

  // SHA-256 of "sentence", a different eight-byte quote.
  quoteSha256 = "821119d79af8b9fcf86d782863d55861708cc4040673f905f9e3b616cfb71199";
  const mismatched = await projectKnowledgeContext(reader, "project-1" as ProjectId, documents, documentMappings);
  const unverified = mismatched.entries[0]!.evidence[0];
  assert.ok(unverified);
  assert.equal(unverified.anchor.id, evidenceId);
  assert.equal(unverified.anchor.revisionId, revisionId);
  assert.equal(unverified.quote, null);
  assert.equal(Object.hasOwn(unverified, "quoteOmission"), false);
  quoteSha256 = evidenceDigest;

  const initial = makeKnowledgeProjection({ projectId: "project-1", projectVersion: 5 }, projection);
  const advanced = makeKnowledgeProjection({ projectId: "project-1", projectVersion: 6 }, {
    nodeLimitReached: projection.nodeLimitReached, entries: projection.entries, documentMappings: projection.documentMappings,
  });
  assert.equal(initial.source.revision, advanced.source.revision, "the same projection survives key order and unrelated project version changes");
  assert.equal(advanced.source.snapshot.projectVersion, 6, "the read identity remains bound to the selected project version");
  assert.notEqual(initial.source.revision, makeKnowledgeProjection({ projectId: "project-1", projectVersion: 5 }, {
    ...projection, nodeLimitReached: true,
  }).source.revision, "the completeness of Knowledge is part of the projection revision");
  const ambiguous = await projectKnowledgeContext(reader, "project-1" as ProjectId, [
    { id:documentId, projectId:"project-1" as ProjectId, kind:"scene", parentId:null, title:"Scene", orderKey:"1", headRevisionId:"current-revision" as RevisionId, version:2, createdAt:"", updatedAt:"" },
  ], [{ documentId, storySceneId:"scene-story-id" }, { documentId:"other-document", storySceneId:"scene-story-id" }]);
  assert.equal(ambiguous.documentMappings.every(mapping => mapping.mapping === "ambiguous"), true);
  assert.equal(ambiguous.entries[0]!.evidence[0]!.storySceneId, null);
  quote = "漢".repeat(2000); markdown = quote; fromUtf16 = 0;
  quoteSha256 = createHash("sha256").update(quote).digest("hex");
  const oversizedDocuments = [
    { id:documentId, projectId:"project-1" as ProjectId, kind:"scene", parentId:null, title:"Scene", orderKey:"1", headRevisionId:revisionId, version:2, createdAt:"", updatedAt:"" },
  ];
  const oversizedMappings = [{documentId,storySceneId:"scene-story-id"}];
  const oversized = await projectKnowledgeContext(reader, "project-1" as ProjectId, oversizedDocuments, oversizedMappings);
  const oversizedEvidence = oversized.entries[0]!.evidence[0]!;
  assert.equal(oversizedEvidence.quote,null);
  assert.equal(oversizedEvidence.quoteOmission,"projection-budget");
  aliasCount = 500;
  const boundedAliases=await projectKnowledgeContext(reader,"project-1" as ProjectId,[]);
  assert.equal(boundedAliases.entries[0]!.aliases.length,500);
  assert.equal(boundedAliases.entries[0]!.aliasLimitReached,true);
  relationCount = 500;
  assertionCount = 100;
  const bounded=await projectKnowledgeContext(reader,"project-1" as ProjectId,[]);
  assert.equal(bounded.entries[0]!.relations.length, 500);
  assert.equal(bounded.entries[0]!.relationLimitReached, true);
  assert.equal(bounded.entries[0]!.evidence[0]!.assertions.length, 100);
  assert.equal(bounded.entries[0]!.evidence[0]!.assertionLimitReached, true);
  assert.equal(batchReads, 6, "each batched projection requests one bounded batch");
});
