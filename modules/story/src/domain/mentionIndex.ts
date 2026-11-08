import {
  buildMentionDictionary as buildKnowledgeMentionDictionary,
  findMentionCandidates,
  type MentionDictionary,
} from "@codexia/core/evidence";
import type { StoryEntity } from "./types.js";

export type { MentionDictionary };

/** Keeps Story's source-derived entity API while using Core's shared candidate index. */
export function buildMentionDictionary(entities: Iterable<StoryEntity>): MentionDictionary {
  return buildKnowledgeMentionDictionary([...entities].map((entity) => ({
    id: entity.id,
    name: entity.name,
    aliases: entity.aliases,
    status: "canonical" as const,
  })));
}

/** Story's reader projection needs entity IDs; source spans remain owned by Evidence. */
export function findMentions(dictionary: MentionDictionary, text: string): string[] {
  const found = new Set<string>();
  for (const candidate of findMentionCandidates(dictionary, text)) {
    for (const nodeId of candidate.nodeIds) found.add(nodeId);
  }
  return [...found];
}
