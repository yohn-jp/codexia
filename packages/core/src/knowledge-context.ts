import type { PersistenceReader, ProjectId, Document } from "@codexia/persistence-contracts";
import { createHash } from "node:crypto";

/** Read-only snapshot projection. PostgreSQL remains the sole authority. */
export const KNOWLEDGE_CONTEXT_PATH = "meta/scriptorium/knowledge-context/v1.json";
const MAX_PROJECTED_QUOTE_BYTES = 4096;
const MAX_PROJECTED_QUOTES_TOTAL_BYTES = 256 * 1024;
export interface KnowledgeDocumentMapping { documentId: string; storySceneId: string }
export async function projectKnowledgeContext(reader: PersistenceReader, projectId: ProjectId, documents: readonly Document[], documentMappings: readonly KnowledgeDocumentMapping[] = []) {
  const nodes = await reader.listKnowledgeNodes(projectId, 1000);
  const documentById = new Map(documents.map(document => [document.id, document]));
  const storyIds = new Map<string, number>();
  const documentIds = new Map<string, number>();
  for (const mapping of documentMappings) {
    storyIds.set(mapping.storySceneId, (storyIds.get(mapping.storySceneId) ?? 0) + 1);
    documentIds.set(mapping.documentId, (documentIds.get(mapping.documentId) ?? 0) + 1);
  }
  const mappingByDocument = new Map(documentMappings.map(mapping => [mapping.documentId, mapping]));
  const mappings = documentMappings.map(mapping => ({...mapping,mapping:storyIds.get(mapping.storySceneId) === 1 && documentIds.get(mapping.documentId) === 1 ? "explicit" as const : "ambiguous" as const}));
  const sourceRevisions = new Map<string, ReturnType<PersistenceReader["getRevision"]>>();
  const ordered = [...nodes].filter(node => node.deletedAt === null && node.status !== "retired").sort((a,b) => a.id.localeCompare(b.id));
  const entries = [];
  let remainingQuoteBytes = MAX_PROJECTED_QUOTES_TOTAL_BYTES;
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
      const mapping = mappingByDocument.get(anchor.documentId);
      const sourceKey=JSON.stringify([anchor.documentId,anchor.revisionId]);
      let sourceRevisionPromise=sourceRevisions.get(sourceKey);
      if(!sourceRevisionPromise){sourceRevisionPromise=reader.getRevision(projectId,anchor.documentId,anchor.revisionId);sourceRevisions.set(sourceKey,sourceRevisionPromise);}
      const sourceRevision = await sourceRevisionPromise;
      const rawFrom = anchor.fromUtf16, rawTo = anchor.toUtf16;
      const bounded = Number.isSafeInteger(rawFrom) && Number.isSafeInteger(rawTo) && rawFrom >= 0 && rawTo > rawFrom && rawTo <= (sourceRevision?.markdown.length ?? -1);
      const quote = bounded && sourceRevision ? sourceRevision.markdown.slice(rawFrom,rawTo) : null;
      const quoteVerified = quote !== null && createHash("sha256").update(quote).digest("hex") === anchor.quoteSha256;
      const quoteBytes = quote === null ? 0 : Buffer.byteLength(JSON.stringify(quote), "utf8");
      const quoteAvailable = quoteVerified && quoteBytes <= MAX_PROJECTED_QUOTE_BYTES && quoteBytes <= remainingQuoteBytes;
      if (quoteAvailable) remainingQuoteBytes -= quoteBytes;
      const assertions = [];
      for (const link of await reader.listEvidenceAssertions(projectId,anchor.id,100)) {
        const assertion = await reader.getAssertion(projectId,link.assertionId);
        if (assertion) assertions.push({ assertion, role:link.role });
      }
      assertions.sort((a,b)=>a.assertion.id.localeCompare(b.assertion.id)||a.role.localeCompare(b.role));
      evidence.push({ mention,anchor,current,stale:!current,sourceDocumentId:anchor.documentId,sourceRevisionId:anchor.revisionId,
        storySceneId:mapping && storyIds.get(mapping.storySceneId) === 1 && documentIds.get(mapping.documentId) === 1 ? mapping.storySceneId : null,
        quote:quoteAvailable ? quote : null,quoteAvailable, ...(quoteVerified && !quoteAvailable ? {quoteOmission:"projection-budget" as const} : {}),assertions });
    }
    entries.push({node,aliases,relations,evidence,evidenceLimitReached:mentions.length===100});
  }
  return {version:1,projectId,documentMappings:mappings,entries,nodeLimitReached:nodes.length===1000};
}
