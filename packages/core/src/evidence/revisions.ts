import { EvidenceGraphError, validateEvidenceGraph, validateKnowledgeEvidenceGraphs } from "./graph.js";
import type { KnowledgeGraph } from "../knowledge/types.js";
import type {
  AnchorRevision,
  AssertionEvidence,
  EvidenceGraph,
  Mention,
  SourceRevision,
  TextAnchor,
} from "./types.js";

export interface RevisionChange {
  fromUtf16: number;
  toUtf16: number;
  insertedLengthUtf16: number;
}

export interface AdvanceSourceRevisionInput {
  graph: EvidenceGraph;
  revision: SourceRevision;
  changes: readonly RevisionChange[];
}

export interface AdvanceProjectSourceRevisionInput extends AdvanceSourceRevisionInput {
  knowledge: KnowledgeGraph;
}

export interface AdvanceProjectSourceRevisionResult {
  knowledge: KnowledgeGraph;
  evidence: EvidenceGraph;
}

export function createEvidenceGraph(projectId: string): EvidenceGraph {
  if (!projectId.trim()) throw new EvidenceGraphError("Project id cannot be empty.");
  return {
    projectId,
    sourceRevisions: [],
    sourceHeads: {},
    anchors: [],
    mentions: [],
    assertions: [],
    evidence: [],
  };
}

export function createTextAnchor(input: {
  graph: EvidenceGraph;
  id: string;
  documentId: string;
  revisionId: string;
  fromUtf16: number;
  toUtf16: number;
  quoteHash: string;
}): TextAnchor {
  const revision = input.graph.sourceRevisions.find((item) => item.id === input.revisionId);
  if (!revision || revision.documentId !== input.documentId ||
    input.graph.sourceHeads[input.documentId] !== input.revisionId) {
    throw new EvidenceGraphError("A text anchor must be created against the current source revision.");
  }
  assertTextRange(input.fromUtf16, input.toUtf16, revision.lengthUtf16, input.id);
  if (!input.quoteHash.trim()) throw new EvidenceGraphError("Anchor quote hash cannot be empty.");
  if (input.graph.anchors.some((anchor) => anchor.id === input.id)) {
    throw new EvidenceGraphError(`Duplicate text anchor id: ${input.id}.`);
  }
  const history: AnchorRevision[] = [{
    revisionId: input.revisionId,
    fromUtf16: input.fromUtf16,
    toUtf16: input.toUtf16,
    status: "current",
  }];
  return {
    id: input.id,
    documentId: input.documentId,
    currentRevisionId: input.revisionId,
    fromUtf16: input.fromUtf16,
    toUtf16: input.toUtf16,
    quoteHash: input.quoteHash,
    status: "current",
    history,
  };
}

export function advanceSourceRevision(input: AdvanceSourceRevisionInput): EvidenceGraph {
  const { graph, revision, changes } = input;
  if (graph.sourceRevisions.some((item) => item.id === revision.id)) {
    throw new EvidenceGraphError(`Source revision already exists: ${revision.id}.`);
  }
  if (!revision.id.trim() || !revision.documentId.trim() || !revision.contentHash.trim() ||
    !Number.isInteger(revision.lengthUtf16) || revision.lengthUtf16 < 0) {
    throw new EvidenceGraphError("Source revision is malformed.");
  }

  const previousRevisionId = graph.sourceHeads[revision.documentId];
  const previousRevision = previousRevisionId
    ? graph.sourceRevisions.find((item) => item.id === previousRevisionId)
    : undefined;
  if ((previousRevisionId ?? null) !== revision.parentRevisionId) {
    throw new EvidenceGraphError(`Source revision for ${revision.documentId} does not extend its current head.`);
  }
  if (!previousRevision) {
    if (revision.parentRevisionId !== null) throw new EvidenceGraphError("A first source revision cannot have a parent.");
    if (changes.length > 0) throw new EvidenceGraphError("A first source revision cannot contain change mappings.");
  } else if (previousRevision.documentId !== revision.documentId) {
    throw new EvidenceGraphError("A source revision parent must belong to the same document.");
  }

  if (previousRevision) validateChanges(changes, previousRevision.lengthUtf16, revision.lengthUtf16);

  const anchors = graph.anchors.map((anchor) => {
    if (anchor.documentId !== revision.documentId || anchor.status === "orphaned" ||
      anchor.currentRevisionId !== previousRevisionId) return anchor;
    return rebaseAnchor(anchor, revision.id, changes);
  });
  const anchorById = new Map(anchors.map((anchor) => [anchor.id, anchor]));
  const mentions = graph.mentions.map((mention) => {
    const anchor = anchorById.get(mention.anchorId);
    if (!anchor || anchor.documentId !== revision.documentId || mention.status === "rejected" || mention.status === "orphaned") return mention;
    if (anchor.status === "orphaned") return { ...mention, status: "orphaned" as const };
    if (mention.status === "stale") return mention;
    if (mention.sourceRevisionId !== previousRevisionId) return { ...mention, status: "stale" as const };
    return mentionAfterAnchorRevision(mention, anchor, revision.id);
  });

  const evidence = graph.evidence.map((item) => {
    const anchor = anchorById.get(item.anchorId);
    if (!anchor || anchor.documentId !== revision.documentId || item.status === "orphaned") return item;
    if (anchor.status === "orphaned") return { ...item, status: "orphaned" as const };
    if (item.status !== "current") return item;
    if (item.sourceRevisionId !== previousRevisionId) return { ...item, status: "stale" as const };
    return evidenceAfterAnchorRevision(item, anchor, revision.id);
  });
  const affectedAssertionIds = new Set(evidence
    .filter((item) => item.status === "stale" || item.status === "orphaned")
    .map((item) => item.assertionId));
  const assertions = graph.assertions.map((assertion) =>
    (affectedAssertionIds.has(assertion.id) ||
      (assertion.status === "proposed" && assertion.provenance.kind === "analysis" &&
        assertion.provenance.sourceRevisionId === previousRevisionId)) && assertion.status !== "rejected"
      ? { ...assertion, status: "stale" as const }
      : assertion,
  );

  const next: EvidenceGraph = {
    ...graph,
    sourceRevisions: [...graph.sourceRevisions, revision],
    sourceHeads: { ...graph.sourceHeads, [revision.documentId]: revision.id },
    anchors,
    mentions,
    assertions,
    evidence,
  };
  validateEvidenceGraph(next);
  return next;
}

/** Advances evidence and expires analysis proposals tied to the prior source revision. */
export function advanceProjectSourceRevision(input: AdvanceProjectSourceRevisionInput): AdvanceProjectSourceRevisionResult {
  const previousRevisionId = input.graph.sourceHeads[input.revision.documentId];
  validateKnowledgeEvidenceGraphs(input.knowledge, input.graph);
  const evidence = advanceSourceRevision(input);
  const knowledge: KnowledgeGraph = {
    ...input.knowledge,
    nodes: input.knowledge.nodes.map((node) =>
      node.status === "proposed" && node.provenance.kind === "analysis" &&
      node.provenance.sourceRevisionId === previousRevisionId
        ? { ...node, status: "stale" as const }
        : node,
    ),
    edges: input.knowledge.edges.map((edge) =>
      edge.status === "proposed" && edge.provenance.kind === "analysis" &&
      edge.provenance.sourceRevisionId === previousRevisionId
        ? { ...edge, status: "stale" as const }
        : edge,
    ),
  };
  validateKnowledgeEvidenceGraphs(knowledge, evidence);
  return { knowledge, evidence };
}

function assertTextRange(fromUtf16: number, toUtf16: number, lengthUtf16: number, anchorId: string): void {
  if (!Number.isInteger(fromUtf16) || !Number.isInteger(toUtf16) || fromUtf16 < 0 ||
    fromUtf16 >= toUtf16 || toUtf16 > lengthUtf16) {
    throw new EvidenceGraphError(`Anchor ${anchorId} must be a non-empty UTF-16 range within its source revision.`);
  }
}

function validateChanges(changes: readonly RevisionChange[], previousLength: number, nextLength: number): void {
  let previousEnd = -1;
  let expectedLength = previousLength;
  for (const change of changes) {
    if (!Number.isInteger(change.fromUtf16) || !Number.isInteger(change.toUtf16) ||
      !Number.isInteger(change.insertedLengthUtf16) || change.fromUtf16 < 0 ||
      change.fromUtf16 > change.toUtf16 || change.toUtf16 > previousLength || change.insertedLengthUtf16 < 0 ||
      change.fromUtf16 < previousEnd) {
      throw new EvidenceGraphError("Revision changes must be sorted, non-overlapping UTF-16 ranges.");
    }
    if (change.fromUtf16 === previousEnd && change.fromUtf16 === change.toUtf16 && previousEnd >= 0) {
      throw new EvidenceGraphError("Changes at the same UTF-16 offset must be combined.");
    }
    expectedLength += change.insertedLengthUtf16 - (change.toUtf16 - change.fromUtf16);
    previousEnd = change.toUtf16;
  }
  if (expectedLength !== nextLength) {
    throw new EvidenceGraphError(`Revision length ${nextLength} does not match mapped length ${expectedLength}.`);
  }
}

function mapOffset(offset: number, changes: readonly RevisionChange[], association: -1 | 1): number {
  let delta = 0;
  for (const change of changes) {
    const mappedStart = change.fromUtf16 + delta;
    if (offset < change.fromUtf16) return offset + delta;
    if (offset > change.toUtf16) {
      delta += change.insertedLengthUtf16 - (change.toUtf16 - change.fromUtf16);
      continue;
    }
    if (change.fromUtf16 === change.toUtf16 && offset === change.fromUtf16) {
      return mappedStart + (association > 0 ? change.insertedLengthUtf16 : 0);
    }
    if (offset === change.fromUtf16) return mappedStart + (association > 0 ? change.insertedLengthUtf16 : 0);
    return mappedStart + change.insertedLengthUtf16;
  }
  return offset + delta;
}

function rebaseAnchor(anchor: TextAnchor, revisionId: string, changes: readonly RevisionChange[]): TextAnchor {
  const affected = changes.some((change) =>
    change.fromUtf16 < anchor.toUtf16 && change.toUtf16 > anchor.fromUtf16 ||
    change.fromUtf16 === change.toUtf16 && change.fromUtf16 > anchor.fromUtf16 && change.fromUtf16 < anchor.toUtf16,
  );
  const fullyDeleted = changes.some((change) =>
    change.insertedLengthUtf16 === 0 && change.fromUtf16 <= anchor.fromUtf16 && change.toUtf16 >= anchor.toUtf16 &&
    change.toUtf16 > change.fromUtf16,
  );
  const fromUtf16 = mapOffset(anchor.fromUtf16, changes, affected ? -1 : 1);
  const toUtf16 = Math.max(fromUtf16, mapOffset(anchor.toUtf16, changes, affected ? 1 : -1));
  const status = fullyDeleted || toUtf16 === fromUtf16
    ? "orphaned"
    : anchor.status === "current" && affected
      ? "needs_review"
      : anchor.status;
  const history: AnchorRevision[] = [...anchor.history, { revisionId, fromUtf16, toUtf16, status }];
  return { ...anchor, currentRevisionId: revisionId, fromUtf16, toUtf16, status, history };
}

function mentionAfterAnchorRevision(mention: Mention, anchor: TextAnchor, revisionId: string): Mention {
  if (anchor.status === "orphaned") return { ...mention, status: "orphaned" };
  if (anchor.status === "needs_review") return { ...mention, status: "stale" };
  return { ...mention, sourceRevisionId: revisionId };
}

function evidenceAfterAnchorRevision(item: AssertionEvidence, anchor: TextAnchor, revisionId: string): AssertionEvidence {
  if (anchor.status === "orphaned") return { ...item, status: "orphaned" };
  if (anchor.status === "needs_review") return { ...item, status: "stale" };
  return {
    ...item,
    sourceRevisionId: revisionId,
    history: [...item.history, { revisionId, role: item.role }],
  };
}
