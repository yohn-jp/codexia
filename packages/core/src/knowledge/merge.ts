import { EvidenceGraphError, validateKnowledgeEvidenceGraphs } from "../evidence/graph.js";
import type { EvidenceGraph } from "../evidence/types.js";
import { normalizeKnowledgeName } from "./identity.js";
import { KnowledgeGraphError, resolveKnowledgeNodeId } from "./graph.js";
import type { Assertion, KnowledgeGraph } from "./types.js";

export interface MergeKnowledgeEntitiesInput {
  knowledge: KnowledgeGraph;
  evidence: EvidenceGraph;
  fromNodeId: string;
  intoNodeId: string;
  authorId: string;
}

export interface MergeKnowledgeEntitiesResult {
  knowledge: KnowledgeGraph;
  evidence: EvidenceGraph;
  mergedNodeId: string;
  canonicalNodeId: string;
}

/** Explicit author action. Name/alias collisions never call this function automatically. */
export function mergeKnowledgeEntities(input: MergeKnowledgeEntitiesInput): MergeKnowledgeEntitiesResult {
  const { knowledge, evidence, authorId } = input;
  if (!authorId.trim()) throw new KnowledgeGraphError("An author must perform entity merges.");
  if (knowledge.projectId !== evidence.projectId) {
    throw new EvidenceGraphError("Knowledge and evidence graphs must belong to the same project.");
  }
  validateKnowledgeEvidenceGraphs(knowledge, evidence);

  const fromNode = knowledge.nodes.find((node) => node.id === input.fromNodeId);
  if (!fromNode || fromNode.status === "merged") {
    throw new KnowledgeGraphError(`Merge source must be an active knowledge node: ${input.fromNodeId}.`);
  }
  const canonicalNodeId = resolveKnowledgeNodeId(knowledge, input.intoNodeId);
  if (fromNode.id === canonicalNodeId) throw new KnowledgeGraphError("A knowledge node cannot be merged into itself.");
  const target = knowledge.nodes.find((node) => node.id === canonicalNodeId)!;

  const aliases = mergeAliases(target.name, target.aliases, fromNode.name, fromNode.aliases);
  const nodes = knowledge.nodes.map((node) => {
    if (node.id === fromNode.id) return { ...node, status: "merged" as const, mergedIntoId: target.id, mergedBy: authorId };
    if (node.id === target.id) return { ...node, aliases };
    if (node.status === "merged" && node.mergedIntoId === fromNode.id) {
      return { ...node, mergedIntoId: target.id };
    }
    return node;
  });
  const edges = knowledge.edges.map((edge) => ({
    ...edge,
    sourceNodeId: edge.sourceNodeId === fromNode.id ? target.id : edge.sourceNodeId,
    targetNodeId: edge.targetNodeId === fromNode.id ? target.id : edge.targetNodeId,
  }));
  const nextKnowledge: KnowledgeGraph = { ...knowledge, nodes, edges };
  const nextEvidence: EvidenceGraph = {
    ...evidence,
    mentions: evidence.mentions.map((mention) => {
      const candidateNodeIds = unique(mention.candidateNodeIds.map((nodeId) =>
        nodeId === fromNode.id ? target.id : nodeId,
      ));
      const resolvedNodeId = mention.resolvedNodeId === fromNode.id ? target.id : mention.resolvedNodeId;
      const status = mention.status === "ambiguous" && candidateNodeIds.length === 1 ? "candidate" : mention.status;
      return { ...mention, candidateNodeIds, resolvedNodeId, status };
    }),
    assertions: evidence.assertions.map((assertion) => remapAssertion(assertion, fromNode.id, target.id)),
  };
  validateKnowledgeEvidenceGraphs(nextKnowledge, nextEvidence);
  return {
    knowledge: nextKnowledge,
    evidence: nextEvidence,
    mergedNodeId: fromNode.id,
    canonicalNodeId: target.id,
  };
}

function mergeAliases(
  targetName: string,
  targetAliases: readonly string[],
  sourceName: string,
  sourceAliases: readonly string[],
): string[] {
  const seen = new Set([normalizeKnowledgeName(targetName)]);
  const aliases: string[] = [];
  for (const alias of [...targetAliases, sourceName, ...sourceAliases]) {
    const normalized = normalizeKnowledgeName(alias);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    aliases.push(alias.trim());
  }
  return aliases;
}

function unique<T>(items: readonly T[]): T[] {
  return [...new Set(items)];
}

function remapAssertion(assertion: Assertion, fromNodeId: string, intoNodeId: string): Assertion {
  const proposition = assertion.proposition;
  return {
    ...assertion,
    proposition: {
      ...proposition,
      subjectEntityId: proposition.subjectEntityId === fromNodeId ? intoNodeId : proposition.subjectEntityId,
      object: proposition.object.kind === "entity" && proposition.object.entityId === fromNodeId
        ? { ...proposition.object, entityId: intoNodeId }
        : proposition.object,
    },
    perspective: assertion.perspective.kind === "character" && assertion.perspective.entityId === fromNodeId
      ? { ...assertion.perspective, entityId: intoNodeId }
      : assertion.perspective,
  };
}
