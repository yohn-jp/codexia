import type { Assertion, KnowledgeGraph } from "../knowledge/types.js";
import { resolveKnowledgeNodeId } from "../knowledge/graph.js";
import { validateKnowledgeEvidenceGraphs } from "./graph.js";
import type { EvidenceGraph, GraphElementKind, GraphElementReference, GraphReference } from "./types.js";

export type ReferenceIndex = ReadonlyMap<string, readonly GraphReference[]>;

export function graphElementKey(reference: GraphElementReference): string {
  return `${reference.kind}:${encodeURIComponent(reference.id)}`;
}

/** Builds reverse references for graph queries without storing a second authority. */
export function buildReferenceIndex(knowledge: KnowledgeGraph, evidence: EvidenceGraph): ReferenceIndex {
  if (knowledge.projectId !== evidence.projectId) {
    throw new Error("Knowledge and evidence graphs must belong to the same project.");
  }
  validateKnowledgeEvidenceGraphs(knowledge, evidence);

  const references = new Map<string, GraphReference[]>();
  const add = (source: GraphElementReference, target: GraphElementReference, relation: string, status: string): void => {
    const key = graphElementKey(target);
    const entries = references.get(key) ?? [];
    entries.push({ source, target, relation, status });
    references.set(key, entries);
  };

  for (const edge of knowledge.edges) {
    add({ kind: "edge", id: edge.id }, { kind: "node", id: edge.sourceNodeId }, "edge-source", edge.status);
    add({ kind: "edge", id: edge.id }, { kind: "node", id: edge.targetNodeId }, `edge:${edge.type}`, edge.status);
    if (edge.provenance.kind === "analysis") {
      add({ kind: "edge", id: edge.id }, { kind: "revision", id: edge.provenance.sourceRevisionId }, "analysis-source", edge.status);
    }
  }
  for (const node of knowledge.nodes) {
    if (node.provenance.kind === "analysis") {
      add({ kind: "node", id: node.id }, { kind: "revision", id: node.provenance.sourceRevisionId }, "analysis-source", node.status);
    }
  }
  for (const mention of evidence.mentions) {
    const nodeIds = new Set([...mention.candidateNodeIds, ...(mention.resolvedNodeId ? [mention.resolvedNodeId] : [])]);
    for (const nodeId of nodeIds) {
      add({ kind: "mention", id: mention.id }, { kind: "node", id: nodeId }, "mention", mention.status);
    }
    add({ kind: "mention", id: mention.id }, { kind: "anchor", id: mention.anchorId }, "mention-anchor", mention.status);
  }
  for (const assertion of evidence.assertions) {
    addAssertionNodeReferences(add, assertion);
    if (assertion.provenance.kind === "analysis") {
      add({ kind: "assertion", id: assertion.id }, { kind: "revision", id: assertion.provenance.sourceRevisionId }, "analysis-source", assertion.status);
    }
  }
  for (const item of evidence.evidence) {
    add({ kind: "evidence", id: item.id }, { kind: "assertion", id: item.assertionId }, `assertion-evidence:${item.role}`, item.status);
    add({ kind: "evidence", id: item.id }, { kind: "anchor", id: item.anchorId }, `evidence-anchor:${item.role}`, item.status);
  }
  for (const anchor of evidence.anchors) {
    add({ kind: "anchor", id: anchor.id }, { kind: "document", id: anchor.documentId }, "document-anchor", anchor.status);
    add({ kind: "anchor", id: anchor.id }, { kind: "revision", id: anchor.currentRevisionId }, "revision-anchor", anchor.status);
  }
  for (const revision of evidence.sourceRevisions) {
    add({ kind: "revision", id: revision.id }, { kind: "document", id: revision.documentId }, "document-revision", "current");
    if (revision.parentRevisionId) {
      add({ kind: "revision", id: revision.id }, { kind: "revision", id: revision.parentRevisionId }, "revision-parent", "historical");
    }
  }

  for (const node of knowledge.nodes) {
    if (node.status !== "merged") continue;
    const canonicalId = resolveKnowledgeNodeId(knowledge, node.id);
    references.set(
      graphElementKey({ kind: "node", id: node.id }),
      references.get(graphElementKey({ kind: "node", id: canonicalId })) ?? [],
    );
  }

  return new Map([...references].map(([key, entries]) => [key, entries.slice()]));
}

function addAssertionNodeReferences(
  add: (source: GraphElementReference, target: GraphElementReference, relation: string, status: string) => void,
  assertion: Assertion,
): void {
  add({ kind: "assertion", id: assertion.id }, { kind: "node", id: assertion.proposition.subjectEntityId }, "assertion-subject", assertion.status);
  if (assertion.proposition.object.kind === "entity") {
    add({ kind: "assertion", id: assertion.id }, { kind: "node", id: assertion.proposition.object.entityId }, "assertion-object", assertion.status);
  }
  if (assertion.perspective.kind === "character") {
    add({ kind: "assertion", id: assertion.id }, { kind: "node", id: assertion.perspective.entityId }, "assertion-perspective", assertion.status);
  }
}

export function findIncomingReferences(
  index: ReferenceIndex,
  targetKind: GraphElementKind,
  targetId: string,
): readonly GraphReference[] {
  return index.get(graphElementKey({ kind: targetKind, id: targetId })) ?? [];
}

export function findReferencesToNode(index: ReferenceIndex, nodeId: string): readonly GraphReference[] {
  return findIncomingReferences(index, "node", nodeId);
}

export function findReferencesToDocument(index: ReferenceIndex, documentId: string): readonly GraphReference[] {
  return findIncomingReferences(index, "document", documentId);
}
