export type KnowledgeNodeType =
  | "character"
  | "location"
  | "item"
  | "faction"
  | "event"
  | "thread"
  | "lore"
  | "term"
  | "custom";

export interface AuthorProvenance {
  kind: "author";
  authorId: string;
}

export interface AnalysisProvenance {
  kind: "analysis";
  extractor: string;
  extractorVersion: string;
  sourceRevisionId: string;
  confidence: number;
}

export type KnowledgeProvenance = AuthorProvenance | AnalysisProvenance;
export type KnowledgeNodeStatus = "proposed" | "canonical" | "merged" | "stale";
export type KnowledgeEdgeStatus = "proposed" | "canonical" | "rejected" | "stale";

/** A project-scoped, stable identity. Analysis-created nodes remain proposals until reviewed. */
export interface KnowledgeNode {
  id: string;
  type: KnowledgeNodeType | (string & {});
  name: string;
  aliases: readonly string[];
  attributes: Readonly<Record<string, unknown>>;
  status: KnowledgeNodeStatus;
  provenance: KnowledgeProvenance;
  confirmedBy?: string;
  mergedIntoId?: string;
  mergedBy?: string;
}

/** A directed relation. Its meaning is independent from a text mention or an assertion. */
export interface KnowledgeEdge {
  id: string;
  sourceNodeId: string;
  targetNodeId: string;
  type: string;
  attributes: Readonly<Record<string, unknown>>;
  status: KnowledgeEdgeStatus;
  provenance: KnowledgeProvenance;
  confirmedBy?: string;
}

export interface KnowledgeGraph {
  projectId: string;
  nodes: readonly KnowledgeNode[];
  edges: readonly KnowledgeEdge[];
}

export type AssertionModality =
  | "asserted"
  | "negated"
  | "possible"
  | "hypothetical"
  | "conditional"
  | "quoted"
  | "questioned";

export type AssertionPerspective =
  | { kind: "author" | "narrator" | "unknown" }
  | { kind: "character"; entityId: string };

export type AssertionObject =
  | { kind: "entity"; entityId: string }
  | { kind: "value"; value: unknown };

export interface AssertionProposition {
  subjectEntityId: string;
  predicate: string;
  object: AssertionObject;
}

export type AssertionStatus = "proposed" | "confirmed" | "rejected" | "stale";

/** A proposition is separate from its textual mentions and its supporting evidence. */
export interface Assertion {
  id: string;
  proposition: AssertionProposition;
  modality: AssertionModality;
  perspective: AssertionPerspective;
  narrativeTime?: string;
  confidence?: number;
  status: AssertionStatus;
  provenance: KnowledgeProvenance;
  confirmedBy?: string;
}
