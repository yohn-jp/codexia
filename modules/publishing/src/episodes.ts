import {
  parsePublishingEpisodesRecord,
  parsePublishingEpisodeUpdate,
  PUBLISHING_EPISODES_KEY,
  type ModuleActionContext,
  type PublishingEpisode,
  type PublishingEpisodeDocument,
} from "@codexia/contracts";

export async function readEpisodeMap(context: ModuleActionContext): Promise<{ document: PublishingEpisodeDocument; version: number | null }> {
  if (!context.readOwnModuleRecord) throw new Error("Publishing episode record reads are unavailable");
  const record = await context.readOwnModuleRecord(PUBLISHING_EPISODES_KEY);
  if (!record) return { document: { episodes: [] }, version: null };
  return { document: parsePublishingEpisodesRecord(record.value).document, version: record.version };
}

export function mergeEpisodeMap(existing: PublishingEpisodeDocument, input: unknown[]): PublishingEpisodeDocument {
  const priorById = new Map(existing.episodes.map(episode => [episode.id, episode]));
  const seenIds = new Set<string>();
  const episodes = input.map((value, index) => {
    const episode = parsePublishingEpisodeUpdate(value, index);
    if (seenIds.has(episode.id)) throw new Error(`Duplicate publication episode ID: ${episode.id}`);
    seenIds.add(episode.id);
    const merged = { ...priorById.get(episode.id), ...episode };
    if (episode.publishedAt === null) delete merged.publishedAt;
    if (episode.sceneIds === null) delete merged.sceneIds;
    return merged as PublishingEpisode;
  }).sort((left, right) => left.number - right.number || left.id.localeCompare(right.id));
  return { ...existing, episodes };
}
