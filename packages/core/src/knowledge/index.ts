export { KnowledgeGraphError, confirmAssertion, confirmKnowledgeEdge, confirmKnowledgeNode, resolveKnowledgeNodeId, validateKnowledgeGraph } from "./graph.js";
export { normalizeKnowledgeName, normalizeKnowledgeSurface } from "./identity.js";
export { mergeKnowledgeEntities, type MergeKnowledgeEntitiesInput, type MergeKnowledgeEntitiesResult } from "./merge.js";
export type {
  AnalysisProvenance,
  Assertion,
  AssertionModality,
  AssertionObject,
  AssertionPerspective,
  AssertionProposition,
  AssertionStatus,
  AuthorProvenance,
  KnowledgeEdge,
  KnowledgeEdgeStatus,
  KnowledgeGraph,
  KnowledgeNode,
  KnowledgeNodeStatus,
  KnowledgeNodeType,
  KnowledgeProvenance,
} from "./types.js";
