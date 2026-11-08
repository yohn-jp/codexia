import type { Mention } from "./types.js";
import type { MentionCandidate } from "./mention-index.js";

export function createMentionFromCandidate(input: {
  id: string;
  anchorId: string;
  sourceRevisionId: string;
  candidate: MentionCandidate;
}): Mention {
  return {
    id: input.id,
    anchorId: input.anchorId,
    sourceRevisionId: input.sourceRevisionId,
    surface: input.candidate.surface,
    candidateNodeIds: input.candidate.nodeIds,
    status: input.candidate.status,
    source: "lexical",
  };
}
