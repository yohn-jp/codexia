import type { PersistenceReader, ProjectId, Document } from "@codexia/persistence-contracts";
import { createHash } from "node:crypto";
import type { KnowledgeProjectionData, KnowledgeProjectionEntry, KnowledgeProjectionEvidence, SnapshotId, SnapshotKnowledgeProjection } from "@codexia/contracts";
import { canonicalJson } from "./operation-records.js";

/** Read-only snapshot projection. PostgreSQL remains the sole authority. */
export const KNOWLEDGE_CONTEXT_PATH = "meta/scriptorium/knowledge-context/v1.json";
const MAX_PROJECTED_QUOTE_BYTES = 4096;
const MAX_PROJECTED_QUOTES_TOTAL_BYTES = 256 * 1024;
const MAX_PROJECTED_ALIASES_PER_NODE = 500;
const MAX_PROJECTED_RELATIONS_PER_NODE = 500;
const MAX_PROJECTED_ASSERTIONS_PER_ANCHOR = 100;
export interface KnowledgeDocumentMapping { documentId: string; storySceneId: string }
function groupBy<T, K>(items: readonly T[], keyOf: (item: T) => K): Map<K, T[]> {
  const groups = new Map<K, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    const group = groups.get(key);
    if (group) group.push(item);
    else groups.set(key, [item]);
  }
  return groups;
}

export function makeKnowledgeProjection(snapshot: SnapshotId, data: KnowledgeProjectionData): SnapshotKnowledgeProjection {
  const revision = createHash("sha256").update(canonicalJson({ projectId: snapshot.projectId, data })).digest("hex");
  return { ...data, source: { kind: "knowledge-projection", snapshot: { ...snapshot }, revision } };
}

export async function projectKnowledgeContext(reader: PersistenceReader, projectId: ProjectId, documents: readonly Document[], documentMappings: readonly KnowledgeDocumentMapping[] = []): Promise<KnowledgeProjectionData> {
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
  const batch = ordered.length > 0 && reader.readKnowledgeProjectionBatch
    ? await reader.readKnowledgeProjectionBatch(projectId, ordered.map(node => node.id), {
      aliasesPerNode: MAX_PROJECTED_ALIASES_PER_NODE,
      relationsPerNode: MAX_PROJECTED_RELATIONS_PER_NODE,
      mentionsPerNode: 100,
      assertionsPerAnchor: MAX_PROJECTED_ASSERTIONS_PER_ANCHOR,
    })
    : null;
  const aliasesByNode = batch ? groupBy(batch.aliases, item => item.nodeId) : null;
  const relationsByNode = batch ? groupBy(batch.relations, item => item.nodeId) : null;
  const mentionsByNode = batch ? groupBy(batch.mentions, mention => mention.nodeId) : null;
  const anchorsById = batch ? new Map(batch.anchors.map(anchor => [anchor.id, anchor])) : null;
  const revisionsByKey = batch ? new Map(batch.revisions.map(revision => [JSON.stringify([revision.documentId, revision.id]), revision])) : null;
  const assertionEvidenceById = batch ? groupBy(batch.assertionEvidence, item => item.evidenceId) : null;
  const assertionsById = batch ? new Map(batch.assertions.map(assertion => [assertion.id, assertion])) : null;
  const entries: KnowledgeProjectionEntry[] = [];
  let remainingQuoteBytes = MAX_PROJECTED_QUOTES_TOTAL_BYTES;
  for (const node of ordered) {
    const aliases = (batch
      ? (aliasesByNode?.get(node.id) ?? []).map(item => item.alias)
      : [...await reader.listKnowledgeAliases(projectId,node.id,MAX_PROJECTED_ALIASES_PER_NODE)]).sort((a,b)=>a.id.localeCompare(b.id));
    const relations = (batch
      ? (relationsByNode?.get(node.id) ?? []).map(item => item.relation)
      : [...await reader.listKnowledgeRelations(projectId,node.id,MAX_PROJECTED_RELATIONS_PER_NODE)]).sort((a,b)=>a.id.localeCompare(b.id));
    const mentions = (batch
      ? mentionsByNode?.get(node.id) ?? []
      : [...await reader.listNodeMentions(projectId,node.id,100)]).sort((a,b)=>a.evidenceId.localeCompare(b.evidenceId));
    const evidence: KnowledgeProjectionEvidence[] = [];
    for (const mention of mentions) {
      const anchor = batch ? anchorsById?.get(mention.evidenceId) : await reader.getEvidenceAnchor(projectId,mention.evidenceId);
      if (!anchor) continue;
      const document = documentById.get(anchor.documentId);
      const current = document?.headRevisionId === anchor.revisionId;
      const mapping = mappingByDocument.get(anchor.documentId);
      const sourceKey=JSON.stringify([anchor.documentId,anchor.revisionId]);
      let sourceRevisionPromise=sourceRevisions.get(sourceKey);
      let sourceRevision;
      if (batch) sourceRevision = revisionsByKey?.get(sourceKey);
      else {
        if(!sourceRevisionPromise){sourceRevisionPromise=reader.getRevision(projectId,anchor.documentId,anchor.revisionId);sourceRevisions.set(sourceKey,sourceRevisionPromise);}
        sourceRevision = await sourceRevisionPromise;
      }
      const rawFrom = anchor.fromUtf16, rawTo = anchor.toUtf16;
      const bounded = Number.isSafeInteger(rawFrom) && Number.isSafeInteger(rawTo) && rawFrom >= 0 && rawTo > rawFrom && rawTo <= (sourceRevision?.markdown.length ?? -1);
      const quote = bounded && sourceRevision ? sourceRevision.markdown.slice(rawFrom,rawTo) : null;
      const quoteVerified = quote !== null && createHash("sha256").update(quote).digest("hex") === anchor.quoteSha256;
      const quoteBytes = quote === null ? 0 : Buffer.byteLength(JSON.stringify(quote), "utf8");
      const quoteAvailable = quoteVerified && quoteBytes <= MAX_PROJECTED_QUOTE_BYTES && quoteBytes <= remainingQuoteBytes;
      if (quoteAvailable) remainingQuoteBytes -= quoteBytes;
      const assertions = [];
      const assertionLinks = batch
        ? (assertionEvidenceById?.get(anchor.id) ?? []).map(item => item.link)
        : await reader.listEvidenceAssertions(projectId,anchor.id,MAX_PROJECTED_ASSERTIONS_PER_ANCHOR);
      for (const link of assertionLinks) {
        const assertion = batch ? assertionsById?.get(link.assertionId) : await reader.getAssertion(projectId,link.assertionId);
        if (assertion) assertions.push({ assertion, role:link.role });
      }
      assertions.sort((a,b)=>a.assertion.id.localeCompare(b.assertion.id)||a.role.localeCompare(b.role));
      evidence.push({ mention,anchor,current,
        storySceneId:mapping && storyIds.get(mapping.storySceneId) === 1 && documentIds.get(mapping.documentId) === 1 ? mapping.storySceneId : null,
        quote:quoteAvailable ? quote : null, ...(quoteVerified && !quoteAvailable ? {quoteOmission:"projection-budget" as const} : {}),assertions,assertionLimitReached:assertionLinks.length>=MAX_PROJECTED_ASSERTIONS_PER_ANCHOR });
    }
    entries.push({node,aliases,relations,evidence,evidenceLimitReached:mentions.length===100,aliasLimitReached:aliases.length>=MAX_PROJECTED_ALIASES_PER_NODE,relationLimitReached:relations.length>=MAX_PROJECTED_RELATIONS_PER_NODE});
  }
  return {documentMappings:mappings,entries,nodeLimitReached:nodes.length===1000};
}
