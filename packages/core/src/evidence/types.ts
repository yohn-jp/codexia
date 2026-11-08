import type { Assertion, AssertionStatus } from "../knowledge/types.js";

export type AnchorStatus = "current" | "needs_review" | "orphaned";

export interface AnchorRevision {
  revisionId: string;
  fromUtf16: number;
  toUtf16: number;
  status: AnchorStatus;
}

/** UTF-16 offsets match CodeMirror. History preserves every source revision position. */
export interface TextAnchor {
  id: string;
  documentId: string;
  currentRevisionId: string;
  fromUtf16: number;
  toUtf16: number;
  quoteHash: string;
  status: AnchorStatus;
  history: readonly AnchorRevision[];
}

export type MentionStatus = "candidate" | "ambiguous" | "confirmed" | "rejected" | "stale" | "orphaned";
export type MentionSource = "lexical" | "analysis" | "author";

/** A mention records a text span and possible identities; it does not assert who knows a fact. */
export interface Mention {
  id: string;
  anchorId: string;
  sourceRevisionId: string;
  surface: string;
  candidateNodeIds: readonly string[];
  resolvedNodeId?: string;
  status: MentionStatus;
  source: MentionSource;
  confidence?: number;
  confirmedBy?: string;
}

export type EvidenceRole = "supports" | "contradicts" | "quotes";
export type EvidenceStatus = "current" | "stale" | "orphaned";

export interface EvidenceRevision {
  revisionId: string;
  role: EvidenceRole;
}

/** Source for an assertion; evidence records and their assertion remain separate objects. */
export interface AssertionEvidence {
  id: string;
  assertionId: string;
  anchorId: string;
  sourceRevisionId: string;
  role: EvidenceRole;
  status: EvidenceStatus;
  history: readonly EvidenceRevision[];
}

export interface SourceRevision {
  id: string;
  documentId: string;
  parentRevisionId: string | null;
  contentHash: string;
  lengthUtf16: number;
}

export interface EvidenceGraph {
  projectId: string;
  sourceRevisions: readonly SourceRevision[];
  /** Current head revision for each document. */
  sourceHeads: Readonly<Record<string, string>>;
  anchors: readonly TextAnchor[];
  mentions: readonly Mention[];
  assertions: readonly Assertion[];
  evidence: readonly AssertionEvidence[];
}

export type GraphElementKind = "node" | "edge" | "document" | "revision" | "anchor" | "mention" | "assertion" | "evidence";

export interface GraphElementReference {
  kind: GraphElementKind;
  id: string;
}

export interface GraphReference {
  source: GraphElementReference;
  target: GraphElementReference;
  relation: string;
  status: string;
}

export type AssertionRecordStatus = AssertionStatus;
