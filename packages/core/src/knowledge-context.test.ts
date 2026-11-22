import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { Document, KnowledgeNodeId, KnowledgeProjectionBatch, PersistenceReader, ProjectId, RevisionId } from "@codexia/persistence-contracts";
import { projectKnowledgeContext } from "./knowledge-context.js";

test("Knowledge projection binds evidence to Story identity and exact anchored revision", async () => {
  const documentId = "document-uuid" as Document["id"];
  const revisionId = "historical-revision" as RevisionId;
  let markdown = "Opening 😀 evidence, then edited text";
  let quote = "evidence";
  let fromUtf16 = markdown.indexOf(quote);
  let revisionReads = 0;
  let batchReads = 0;
  const knowledgeIds = ["knowledge-1", "knowledge-2"] as KnowledgeNodeId[];
  const evidenceId = "evidence-1";
  const mention = { evidenceId, nodeId: knowledgeIds[0]!, status: "confirmed" };
  const sourceRevision = () => ({
    id: revisionId, projectId: "project-1" as ProjectId, documentId, parentRevisionId: null,
    markdown, sha256: "", authorId: "author", createdAt: "",
  });
  let aliasRows: Array<{id:string}> = [];
  let relationRows: Array<{id:string}> = [];
  let assertionLinks: Array<{assertionId:string;role:string}> = [];
  const reader = {
    async listKnowledgeNodes() { return knowledgeIds.map(id=>({ id, projectId:"project-1", type:"lore", name:"The clue", attributes:{}, status:"confirmed" as const, version:1, deletedAt:null, createdAt:"", updatedAt:"" })); },
    async listKnowledgeAliases(_projectId: ProjectId, _nodeId: string, limit?: number) { assert.equal(limit,500); return aliasRows; },
    async listKnowledgeRelations(_projectId: ProjectId, _nodeId: string, limit?: number) { assert.equal(limit,500); return relationRows; },
    async listNodeMentions(_projectId: ProjectId, nodeId: KnowledgeNodeId) {
      return nodeId === knowledgeIds[0] ? [mention] : [];
    },
    async getEvidenceAnchor() { return { id:"evidence-1", projectId:"project-1", documentId, revisionId, fromUtf16, toUtf16:fromUtf16+quote.length,
      quoteSha256:createHash("sha256").update(quote).digest("hex"), status:"confirmed", version:1, createdAt:"", updatedAt:"" }; },
    async listEvidenceAssertions(_projectId: ProjectId, _anchorId: string, limit?: number) { assert.equal(limit,100); return assertionLinks; },
    async getAssertion(_projectId: ProjectId, id: string) { return {id,status:"confirmed"}; },
    async getRevision(_projectId: ProjectId, _documentId: Document["id"], id: RevisionId) {
      revisionReads++;
      assert.equal(id, revisionId);
      return sourceRevision();
    },
  } as unknown as PersistenceReader;
  const documents = [
    { id:documentId, projectId:"project-1" as ProjectId, kind:"scene", parentId:null, title:"Scene", orderKey:"1", headRevisionId:"current-revision" as RevisionId, version:2, createdAt:"", updatedAt:"" },
  ];
  const documentMappings = [{ documentId, storySceneId:"scene-story-id" }];
  const projection = await projectKnowledgeContext(reader, "project-1" as ProjectId, documents, documentMappings);
  const evidence = projection.entries[0]!.evidence[0] as { storySceneId?: string; sourceRevisionId?: string; quote?: string | null } | undefined;
  assert.equal(projection.documentMappings[0]?.storySceneId, "scene-story-id");
  assert.equal(evidence?.storySceneId, "scene-story-id");
  assert.equal(evidence?.sourceRevisionId, revisionId);
  assert.equal(evidence?.quote, quote);
  assert.equal(revisionReads,1,"repeated evidence references share one immutable revision read");
  const batchReader = {
    ...reader,
    async readKnowledgeProjectionBatch(projectId: ProjectId, nodeIds: readonly KnowledgeNodeId[], limits: {
      aliasesPerNode: number; relationsPerNode: number; mentionsPerNode: number; assertionsPerAnchor: number;
    }): Promise<KnowledgeProjectionBatch> {
      assert.deepEqual(limits, { aliasesPerNode: 500, relationsPerNode: 500, mentionsPerNode: 100, assertionsPerAnchor: 100 });
      assert.deepEqual(nodeIds, knowledgeIds);
      batchReads++;
      return {
        aliases: knowledgeIds.flatMap(nodeId => aliasRows.map(alias => ({ nodeId, alias }))),
        relations: knowledgeIds.flatMap(nodeId => relationRows.map(relation => ({ nodeId, relation }))),
        mentions: [mention],
        anchors: [await reader.getEvidenceAnchor(projectId, evidenceId as Parameters<PersistenceReader["getEvidenceAnchor"]>[1])],
        revisions: [sourceRevision()],
        assertionEvidence: assertionLinks.map(link => ({ evidenceId, link })),
        assertions: assertionLinks.map(link => ({ id: link.assertionId, status: "confirmed" })),
      } as unknown as KnowledgeProjectionBatch;
    },
  } as unknown as PersistenceReader;
  const batchedProjection = await projectKnowledgeContext(batchReader, "project-1" as ProjectId, documents, documentMappings);
  assert.deepEqual(batchedProjection, projection, "batch and single-record reads produce identical projection output");
  assert.equal(batchReads, 1);
  assert.equal(revisionReads, 1, "batch resolution does not fall back to fetching revisions");
  const ambiguous = await projectKnowledgeContext(reader, "project-1" as ProjectId, [
    { id:documentId, projectId:"project-1" as ProjectId, kind:"scene", parentId:null, title:"Scene", orderKey:"1", headRevisionId:"current-revision" as RevisionId, version:2, createdAt:"", updatedAt:"" },
  ], [{ documentId, storySceneId:"scene-story-id" }, { documentId:"other-document", storySceneId:"scene-story-id" }]);
  const ambiguousBatch = await projectKnowledgeContext(batchReader, "project-1" as ProjectId, [
    { id:documentId, projectId:"project-1" as ProjectId, kind:"scene", parentId:null, title:"Scene", orderKey:"1", headRevisionId:"current-revision" as RevisionId, version:2, createdAt:"", updatedAt:"" },
  ], [{ documentId, storySceneId:"scene-story-id" }, { documentId:"other-document", storySceneId:"scene-story-id" }]);
  assert.deepEqual(ambiguousBatch, ambiguous, "batch reads preserve ambiguous mapping omission");
  assert.equal(ambiguous.documentMappings.every(mapping => mapping.mapping === "ambiguous"), true);
  assert.equal((ambiguous.entries[0]!.evidence[0] as { storySceneId: string | null }).storySceneId, null);
  assert.equal(revisionReads, 2, "only the two single-record projections fetch a revision");
  quote = "漢".repeat(2000); markdown = quote; fromUtf16 = 0;
  const oversizedDocuments = [
    { id:documentId, projectId:"project-1" as ProjectId, kind:"scene", parentId:null, title:"Scene", orderKey:"1", headRevisionId:revisionId, version:2, createdAt:"", updatedAt:"" },
  ];
  const oversizedMappings = [{documentId,storySceneId:"scene-story-id"}];
  const oversized = await projectKnowledgeContext(reader, "project-1" as ProjectId, oversizedDocuments, oversizedMappings);
  const oversizedBatch = await projectKnowledgeContext(batchReader, "project-1" as ProjectId, oversizedDocuments, oversizedMappings);
  assert.deepEqual(oversizedBatch, oversized, "batch reads preserve quote verification and byte-budget omission");
  const oversizedEvidence = oversized.entries[0]!.evidence[0]!;
  assert.equal(oversizedEvidence.quote,null);
  assert.equal(oversizedEvidence.quoteAvailable,false);
  assert.equal(oversizedEvidence.quoteOmission,"projection-budget");
  aliasRows=Array.from({length:500},(_,index)=>({id:`alias-${index}`}));
  const boundedAliases=await projectKnowledgeContext(reader,"project-1" as ProjectId,[]);
  const boundedAliasesBatch=await projectKnowledgeContext(batchReader,"project-1" as ProjectId,[]);
  assert.deepEqual(boundedAliasesBatch,boundedAliases,"batch reads retain the per-node alias limit and truncation flag");
  assert.equal(boundedAliases.entries[0]!.aliases.length,500);
  assert.equal(boundedAliases.entries[0]!.aliasLimitReached,true);
  relationRows=Array.from({length:500},(_,index)=>({id:`relation-${index}`}));
  assertionLinks=Array.from({length:100},(_,index)=>({assertionId:`assertion-${index}`,role:"supports"}));
  const bounded=await projectKnowledgeContext(reader,"project-1" as ProjectId,[]);
  const boundedBatch=await projectKnowledgeContext(batchReader,"project-1" as ProjectId,[]);
  assert.deepEqual(boundedBatch,bounded,"batch reads retain relation and assertion truncation flags");
  assert.equal(bounded.entries[0]!.relationLimitReached,true);
  assert.equal(bounded.entries[0]!.evidence[0]!.assertionLimitReached,true);
  assert.equal(batchReads, 5, "each batched projection requests one bounded batch");
});
