import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { Document, PersistenceReader, ProjectId, RevisionId } from "@codexia/persistence-contracts";
import { projectKnowledgeContext } from "./knowledge-context.js";

test("Knowledge projection binds evidence to Story identity and exact anchored revision", async () => {
  const documentId = "document-uuid" as Document["id"];
  const revisionId = "historical-revision" as RevisionId;
  const markdown = "Opening 😀 evidence, then edited text";
  const quote = "evidence";
  const fromUtf16 = markdown.indexOf(quote);
  let revisionReads=0;
  const reader = {
    async listKnowledgeNodes() { return ["knowledge-1","knowledge-2"].map(id=>({ id, projectId:"project-1", type:"lore", name:"The clue", attributes:{}, status:"confirmed" as const, version:1, deletedAt:null, createdAt:"", updatedAt:"" })); },
    async listKnowledgeAliases() { return []; },
    async listKnowledgeRelations() { return []; },
    async listNodeMentions() { return [{ evidenceId:"evidence-1", nodeId:"knowledge-1", status:"confirmed" }]; },
    async getEvidenceAnchor() { return { id:"evidence-1", projectId:"project-1", documentId, revisionId, fromUtf16, toUtf16:fromUtf16+quote.length,
      quoteSha256:createHash("sha256").update(quote).digest("hex"), status:"confirmed", version:1, createdAt:"", updatedAt:"" }; },
    async listEvidenceAssertions() { return []; },
    async getRevision(_projectId: ProjectId, _documentId: Document["id"], id: RevisionId) {
      revisionReads++;
      assert.equal(id, revisionId);
      return { id, projectId:"project-1" as ProjectId, documentId, parentRevisionId:null, markdown, sha256:"", authorId:"author", createdAt:"" };
    },
  } as unknown as PersistenceReader;
  const projection = await projectKnowledgeContext(reader, "project-1" as ProjectId, [
    { id:documentId, projectId:"project-1" as ProjectId, kind:"scene", parentId:null, title:"Scene", orderKey:"1", headRevisionId:"current-revision" as RevisionId, version:2, createdAt:"", updatedAt:"" },
  ], [{ documentId, storySceneId:"scene-story-id" }]);
  const evidence = projection.entries[0]!.evidence[0] as { storySceneId?: string; sourceRevisionId?: string; quote?: string | null } | undefined;
  assert.equal(projection.documentMappings[0]?.storySceneId, "scene-story-id");
  assert.equal(evidence?.storySceneId, "scene-story-id");
  assert.equal(evidence?.sourceRevisionId, revisionId);
  assert.equal(evidence?.quote, quote);
  assert.equal(revisionReads,1,"repeated evidence references share one immutable revision read");
  const ambiguous = await projectKnowledgeContext(reader, "project-1" as ProjectId, [
    { id:documentId, projectId:"project-1" as ProjectId, kind:"scene", parentId:null, title:"Scene", orderKey:"1", headRevisionId:"current-revision" as RevisionId, version:2, createdAt:"", updatedAt:"" },
  ], [{ documentId, storySceneId:"scene-story-id" }, { documentId:"other-document", storySceneId:"scene-story-id" }]);
  assert.equal(ambiguous.documentMappings.every(mapping => mapping.mapping === "ambiguous"), true);
  assert.equal((ambiguous.entries[0]!.evidence[0] as { storySceneId: string | null }).storySceneId, null);
  assert.equal(revisionReads,2,"each projection reads a source revision once even when references repeat");
});
