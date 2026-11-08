import { validateKnowledgeGraph } from "../knowledge/graph.js";
import type { KnowledgeGraph } from "../knowledge/types.js";
import type { EvidenceGraph, Mention, TextAnchor } from "./types.js";

export class EvidenceGraphError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvidenceGraphError";
  }
}

function uniqueById<T extends { id: string }>(items: readonly T[], label: string): Map<string, T> {
  const result = new Map<string, T>();
  for (const item of items) {
    if (!item.id.trim()) throw new EvidenceGraphError(`${label} id cannot be empty.`);
    if (result.has(item.id)) throw new EvidenceGraphError(`Duplicate ${label} id: ${item.id}.`);
    result.set(item.id, item);
  }
  return result;
}

function assertRange(fromUtf16: number, toUtf16: number, lengthUtf16: number, label: string, allowEmpty = false): void {
  if (!Number.isInteger(fromUtf16) || !Number.isInteger(toUtf16) || fromUtf16 < 0 ||
    fromUtf16 > toUtf16 || (!allowEmpty && fromUtf16 === toUtf16) || toUtf16 > lengthUtf16) {
    throw new EvidenceGraphError(`${label} must be a valid UTF-16 range within its source revision.`);
  }
}

export function validateEvidenceGraph(graph: EvidenceGraph, knowledge?: KnowledgeGraph): void {
  if (!graph.projectId.trim()) throw new EvidenceGraphError("Project id cannot be empty.");
  if (knowledge && knowledge.projectId !== graph.projectId) {
    throw new EvidenceGraphError("Knowledge and evidence graphs must belong to the same project.");
  }

  const revisions = uniqueById(graph.sourceRevisions, "source revision");
  const anchors = uniqueById(graph.anchors, "text anchor");
  const mentions = uniqueById(graph.mentions, "mention");
  const assertions = uniqueById(graph.assertions, "assertion");
  const evidenceItems = uniqueById(graph.evidence, "assertion evidence");
  const nodes = knowledge ? new Set(knowledge.nodes.map((node) => node.id)) : undefined;
  const headByDocument = new Map<string, string>();

  for (const [documentId, revisionId] of Object.entries(graph.sourceHeads)) {
    const revision = revisions.get(revisionId);
    if (!revision || revision.documentId !== documentId) {
      throw new EvidenceGraphError(`Source head for ${documentId} must name one of its revisions.`);
    }
    headByDocument.set(documentId, revisionId);
  }

  for (const revision of graph.sourceRevisions) {
    if (!revision.documentId.trim() || !revision.contentHash.trim() || !Number.isInteger(revision.lengthUtf16) || revision.lengthUtf16 < 0) {
      throw new EvidenceGraphError(`Source revision ${revision.id} is malformed.`);
    }
    if (revision.parentRevisionId) {
      const parent = revisions.get(revision.parentRevisionId);
      if (!parent || parent.documentId !== revision.documentId) {
        throw new EvidenceGraphError(`Parent revision for ${revision.id} must belong to the same document.`);
      }
    }
  }

  for (const anchor of graph.anchors) {
    const revision = revisions.get(anchor.currentRevisionId);
    if (!revision || revision.documentId !== anchor.documentId) {
      throw new EvidenceGraphError(`Anchor ${anchor.id} must reference a revision of its document.`);
    }
    assertRange(anchor.fromUtf16, anchor.toUtf16, revision.lengthUtf16, `Anchor ${anchor.id}`, anchor.status === "orphaned");
    if (anchor.status === "current" && headByDocument.get(anchor.documentId) !== anchor.currentRevisionId) {
      throw new EvidenceGraphError(`Current anchor ${anchor.id} must point at the document head.`);
    }
    if (!anchor.quoteHash.trim()) throw new EvidenceGraphError(`Anchor ${anchor.id} needs a quote hash.`);
    for (const history of anchor.history) {
      const historicalRevision = revisions.get(history.revisionId);
      if (!historicalRevision || historicalRevision.documentId !== anchor.documentId) {
        throw new EvidenceGraphError(`Anchor ${anchor.id} history must reference its document's revisions.`);
      }
      assertRange(history.fromUtf16, history.toUtf16, historicalRevision.lengthUtf16, `Anchor ${anchor.id} history`, history.status === "orphaned");
    }
  }

  for (const mention of graph.mentions) validateMention(mention, anchors, revisions, nodes);

  for (const assertion of graph.assertions) {
    if (knowledge) {
      const knownIds = new Set(knowledge.nodes.map((node) => node.id));
      const object = assertion.proposition.object;
      const perspective = assertion.perspective;
      if (!knownIds.has(assertion.proposition.subjectEntityId) ||
        (object.kind === "entity" && !knownIds.has(object.entityId)) ||
        (perspective.kind === "character" && !knownIds.has(perspective.entityId))) {
        throw new EvidenceGraphError(`Assertion ${assertion.id} references a missing knowledge node.`);
      }
    }
    if (assertion.provenance.kind === "analysis" &&
      (!Number.isFinite(assertion.provenance.confidence) || assertion.provenance.confidence < 0 || assertion.provenance.confidence > 1)) {
      throw new EvidenceGraphError(`Assertion ${assertion.id} has an invalid analysis confidence.`);
    }
    if (assertion.provenance.kind === "analysis" && !revisions.has(assertion.provenance.sourceRevisionId)) {
      throw new EvidenceGraphError(`Assertion ${assertion.id} references a missing source revision.`);
    }
    if (assertion.status === "confirmed" && assertion.provenance.kind === "analysis" && !assertion.confirmedBy?.trim()) {
      throw new EvidenceGraphError(`Analysis assertion ${assertion.id} needs author confirmation.`);
    }
  }

  for (const item of graph.evidence) {
    const assertion = assertions.get(item.assertionId);
    const anchor = anchors.get(item.anchorId);
    const sourceRevision = revisions.get(item.sourceRevisionId);
    if (!assertion || !anchor || !sourceRevision || sourceRevision.documentId !== anchor.documentId) {
      throw new EvidenceGraphError(`Evidence ${item.id} must reference an assertion and an anchor in the same document revision.`);
    }
    if (item.status === "current" &&
      (anchor.status !== "current" || anchor.currentRevisionId !== item.sourceRevisionId)) {
      throw new EvidenceGraphError(`Current evidence ${item.id} must match a current anchor revision.`);
    }
    if (!item.history.some((entry) => entry.revisionId === item.sourceRevisionId)) {
      throw new EvidenceGraphError(`Evidence ${item.id} history must include its source revision.`);
    }
  }
}

export function validateKnowledgeEvidenceGraphs(knowledge: KnowledgeGraph, evidence: EvidenceGraph): void {
  validateKnowledgeGraph(knowledge);
  validateEvidenceGraph(evidence, knowledge);
  const revisionIds = new Set(evidence.sourceRevisions.map((revision) => revision.id));
  for (const record of [...knowledge.nodes, ...knowledge.edges]) {
    if (record.provenance.kind === "analysis" && !revisionIds.has(record.provenance.sourceRevisionId)) {
      throw new EvidenceGraphError(`${record.id} references a missing source revision.`);
    }
  }
}

function validateMention(
  mention: Mention,
  anchors: ReadonlyMap<string, TextAnchor>,
  revisions: ReadonlyMap<string, EvidenceGraph["sourceRevisions"][number]>,
  nodes: ReadonlySet<string> | undefined,
): void {
  const anchor = anchors.get(mention.anchorId);
  const revision = revisions.get(mention.sourceRevisionId);
  if (!anchor || !revision || revision.documentId !== anchor.documentId) {
    throw new EvidenceGraphError(`Mention ${mention.id} must reference an anchor and its source revision.`);
  }
  if (new Set(mention.candidateNodeIds).size !== mention.candidateNodeIds.length) {
    throw new EvidenceGraphError(`Mention ${mention.id} cannot repeat candidate nodes.`);
  }
  if (nodes && (mention.candidateNodeIds.some((nodeId) => !nodes.has(nodeId)) ||
    (mention.resolvedNodeId && !nodes.has(mention.resolvedNodeId)))) {
    throw new EvidenceGraphError(`Mention ${mention.id} references a missing knowledge node.`);
  }
  if (mention.status === "ambiguous" && mention.candidateNodeIds.length < 2) {
    throw new EvidenceGraphError(`Ambiguous mention ${mention.id} needs multiple candidates.`);
  }
  if (mention.status === "confirmed" && (!mention.resolvedNodeId || !mention.confirmedBy?.trim())) {
    throw new EvidenceGraphError(`Confirmed mention ${mention.id} needs an author-selected node.`);
  }
  if (mention.status === "confirmed" && mention.source === "analysis" && !mention.confirmedBy?.trim()) {
    throw new EvidenceGraphError(`Analysis mention ${mention.id} needs author confirmation.`);
  }
  if (mention.confidence !== undefined && (!Number.isFinite(mention.confidence) || mention.confidence < 0 || mention.confidence > 1)) {
    throw new EvidenceGraphError(`Mention ${mention.id} has an invalid confidence.`);
  }
}

export function confirmMention(mention: Mention, nodeId: string, authorId: string): Mention {
  if (!authorId.trim()) throw new EvidenceGraphError("Author id cannot be empty.");
  if (mention.status !== "candidate" && mention.status !== "ambiguous") {
    throw new EvidenceGraphError(`Mention ${mention.id} is not awaiting author resolution.`);
  }
  if (!mention.candidateNodeIds.includes(nodeId)) {
    throw new EvidenceGraphError(`Node ${nodeId} is not a candidate for mention ${mention.id}.`);
  }
  return { ...mention, status: "confirmed", source: "author", resolvedNodeId: nodeId, confirmedBy: authorId };
}
