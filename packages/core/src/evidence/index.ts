export { EvidenceGraphError, confirmMention, validateEvidenceGraph, validateKnowledgeEvidenceGraphs } from "./graph.js";
export { buildMentionDictionary, findMentionCandidates, type MentionCandidate, type MentionDictionary, type MentionDictionaryEntry } from "./mention-index.js";
export { createMentionFromCandidate } from "./mentions.js";
export {
  advanceProjectSourceRevision,
  advanceSourceRevision,
  createEvidenceGraph,
  createTextAnchor,
  type AdvanceProjectSourceRevisionInput,
  type AdvanceProjectSourceRevisionResult,
  type AdvanceSourceRevisionInput,
  type RevisionChange,
} from "./revisions.js";
export {
  buildReferenceIndex,
  findIncomingReferences,
  findReferencesToDocument,
  findReferencesToNode,
  graphElementKey,
  type ReferenceIndex,
} from "./references.js";
export type {
  AnchorRevision,
  AnchorStatus,
  AssertionEvidence,
  EvidenceGraph,
  EvidenceRevision,
  EvidenceRole,
  EvidenceStatus,
  GraphElementKind,
  GraphElementReference,
  GraphReference,
  Mention,
  MentionSource,
  MentionStatus,
  SourceRevision,
  TextAnchor,
} from "./types.js";
