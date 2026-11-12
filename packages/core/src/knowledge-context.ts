import type { PersistenceReader, ProjectId, Document } from "@codexia/persistence-contracts";

/** Read-only snapshot projection. PostgreSQL remains the sole authority. */
export const KNOWLEDGE_CONTEXT_PATH = "meta/scriptorium/knowledge-context/v1.json";
export async function projectKnowledgeContext(reader: PersistenceReader, projectId: ProjectId, documents: readonly Document[]) {
  const nodes = await reader.listKnowledgeNodes(projectId, 1000);
  const documentById = new Map(documents.map(document => [document.id, document]));
  const ordered = [...nodes].filter(node => node.deletedAt === null && node.status !== "retired").sort((a,b) => a.id.localeCompare(b.id));
  const entries = [];
  for (const node of ordered) {
    const aliases = [...await reader.listKnowledgeAliases(projectId,node.id)].sort((a,b)=>a.id.localeCompare(b.id));
    const relations = [...await reader.listKnowledgeRelations(projectId,node.id)].sort((a,b)=>a.id.localeCompare(b.id));
    const mentions = [...await reader.listNodeMentions(projectId,node.id,100)].sort((a,b)=>a.evidenceId.localeCompare(b.evidenceId));
    const evidence = [];
    for (const mention of mentions) {
      const anchor = await reader.getEvidenceAnchor(projectId,mention.evidenceId);
      if (!anchor) continue;
      const document = documentById.get(anchor.documentId);
      const current = document?.headRevisionId === anchor.revisionId;
      const assertions = [];
      for (const link of await reader.listEvidenceAssertions(projectId,anchor.id,100)) {
        const assertion = await reader.getAssertion(projectId,link.assertionId);
        if (assertion) assertions.push({ assertion, role:link.role });
      }
      assertions.sort((a,b)=>a.assertion.id.localeCompare(b.assertion.id)||a.role.localeCompare(b.role));
      evidence.push({ mention,anchor,current,assertions });
    }
    entries.push({node,aliases,relations,evidence,evidenceLimitReached:mentions.length===100});
  }
  return {version:1,projectId,entries,nodeLimitReached:nodes.length===1000};
}
