import type { Assertion, KnowledgeEdge, KnowledgeGraph, KnowledgeNode } from "./types.js";

export class KnowledgeGraphError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KnowledgeGraphError";
  }
}

function assertConfidence(confidence: number): void {
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    throw new KnowledgeGraphError("Confidence must be a number between 0 and 1.");
  }
}

function assertCanonicalReview(
  status: string,
  provenance: KnowledgeNode["provenance"] | KnowledgeEdge["provenance"] | Assertion["provenance"],
  confirmedBy: string | undefined,
): void {
  if (provenance.kind === "analysis") assertConfidence(provenance.confidence);
  if (status === "canonical" || status === "confirmed") {
    if (provenance.kind === "analysis" && !confirmedBy?.trim()) {
      throw new KnowledgeGraphError("Analysis results require author confirmation before becoming canonical.");
    }
  }
}

function uniqueById<T extends { id: string }>(items: readonly T[], label: string): Map<string, T> {
  const result = new Map<string, T>();
  for (const item of items) {
    if (!item.id.trim()) throw new KnowledgeGraphError(`${label} id cannot be empty.`);
    if (result.has(item.id)) throw new KnowledgeGraphError(`Duplicate ${label} id: ${item.id}.`);
    result.set(item.id, item);
  }
  return result;
}

export function validateKnowledgeGraph(graph: KnowledgeGraph): void {
  if (!graph.projectId.trim()) throw new KnowledgeGraphError("Project id cannot be empty.");
  const nodes = uniqueById(graph.nodes, "knowledge node");
  uniqueById(graph.edges, "knowledge edge");

  for (const node of graph.nodes) {
    if (!node.name.trim()) throw new KnowledgeGraphError(`Knowledge node ${node.id} needs a name.`);
    assertCanonicalReview(node.status, node.provenance, node.confirmedBy);
    if (node.status === "merged") {
      if (!node.mergedIntoId || !node.mergedBy?.trim() || !nodes.has(node.mergedIntoId) || node.mergedIntoId === node.id) {
        throw new KnowledgeGraphError(`Merged node ${node.id} needs an author and another existing node as its target.`);
      }
    } else if (node.mergedIntoId || node.mergedBy) {
      throw new KnowledgeGraphError(`Only merged nodes may have merge metadata (${node.id}).`);
    }
  }

  for (const node of graph.nodes) resolveKnowledgeNodeId(graph, node.id);

  for (const edge of graph.edges) {
    if (!nodes.has(edge.sourceNodeId) || !nodes.has(edge.targetNodeId)) {
      throw new KnowledgeGraphError(`Knowledge edge ${edge.id} references a missing node.`);
    }
    if (!edge.type.trim()) throw new KnowledgeGraphError(`Knowledge edge ${edge.id} needs a type.`);
    assertCanonicalReview(edge.status, edge.provenance, edge.confirmedBy);
  }
}

export function resolveKnowledgeNodeId(graph: KnowledgeGraph, nodeId: string): string {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const visited = new Set<string>();
  let currentId = nodeId;
  while (true) {
    if (visited.has(currentId)) throw new KnowledgeGraphError(`Knowledge merge cycle at ${currentId}.`);
    visited.add(currentId);
    const node = byId.get(currentId);
    if (!node) throw new KnowledgeGraphError(`Unknown knowledge node: ${currentId}.`);
    if (node.status !== "merged" || !node.mergedIntoId) return node.id;
    currentId = node.mergedIntoId;
  }
}

export function confirmKnowledgeNode(
  graph: KnowledgeGraph,
  nodeId: string,
  authorId: string,
): KnowledgeGraph {
  if (!authorId.trim()) throw new KnowledgeGraphError("Author id cannot be empty.");
  const nodeIdResolved = resolveKnowledgeNodeId(graph, nodeId);
  return {
    ...graph,
    nodes: graph.nodes.map((node) => node.id === nodeIdResolved && node.status === "proposed"
      ? { ...node, status: "canonical", confirmedBy: authorId }
      : node),
  };
}

export function confirmKnowledgeEdge(
  graph: KnowledgeGraph,
  edgeId: string,
  authorId: string,
): KnowledgeGraph {
  if (!authorId.trim()) throw new KnowledgeGraphError("Author id cannot be empty.");
  let found = false;
  const edges = graph.edges.map((edge) => {
    if (edge.id !== edgeId) return edge;
    found = true;
    if (edge.status !== "proposed") throw new KnowledgeGraphError(`Knowledge edge ${edgeId} is not a proposal.`);
    return { ...edge, status: "canonical" as const, confirmedBy: authorId };
  });
  if (!found) throw new KnowledgeGraphError(`Unknown knowledge edge: ${edgeId}.`);
  return { ...graph, edges };
}

export function confirmAssertion(assertion: Assertion, authorId: string): Assertion {
  if (!authorId.trim()) throw new KnowledgeGraphError("Author id cannot be empty.");
  if (assertion.status !== "proposed") throw new KnowledgeGraphError(`Assertion ${assertion.id} is not a proposal.`);
  assertCanonicalReview("confirmed", assertion.provenance, authorId);
  return { ...assertion, status: "confirmed", confirmedBy: authorId };
}
