import YAML from "yaml";
import type { ModuleRecordJsonObject, ModuleRecordJsonValue } from "./index.js";

export const PUBLISHING_EPISODES_KEY = "episodes";

type EpisodeIdentity = {
  id: string;
  number: number;
  title: string;
  scope: "volume" | "chapter";
  scopeId: string;
};
export type PublishingEpisode = ModuleRecordJsonObject & EpisodeIdentity & { publishedAt?: string; sceneIds?: string[] };
type PublishingEpisodeUpdate = ModuleRecordJsonObject & EpisodeIdentity & { publishedAt?: string | null; sceneIds?: string[] | null };
export type PublishingEpisodeDocument = ModuleRecordJsonObject & { episodes: PublishingEpisode[] };
type PublishingEpisodesRecord = ModuleRecordJsonObject & { version: 1; document: PublishingEpisodeDocument };

function plainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isJson(value: unknown, parents = new Set<object>()): value is ModuleRecordJsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (!Array.isArray(value) && !plainObject(value)) return false;
  if (parents.has(value)) return false;
  parents.add(value);
  const fields = Array.isArray(value) ? Array.from(value) : Object.values(value);
  const valid = fields.every(field => isJson(field, parents));
  parents.delete(value);
  return valid;
}

function validateEpisode(value: ModuleRecordJsonValue, index: number, allowClear = false): PublishingEpisodeUpdate {
  if (!plainObject(value) || typeof value.id !== "string" || !value.id.trim() ||
      typeof value.number !== "number" || !Number.isSafeInteger(value.number) || value.number < 1 ||
      typeof value.title !== "string" || (value.scope !== "volume" && value.scope !== "chapter") ||
      typeof value.scopeId !== "string" || !value.scopeId.trim() ||
      (value.publishedAt !== undefined && typeof value.publishedAt !== "string" && !(allowClear && value.publishedAt === null)) ||
      (value.sceneIds !== undefined && !(allowClear && value.sceneIds === null) &&
        (!Array.isArray(value.sceneIds) || value.sceneIds.some(id => typeof id !== "string")))) {
    throw new Error(`Invalid publication episode at index ${index}`);
  }
  return value as PublishingEpisodeUpdate;
}

export function parsePublishingEpisodeUpdate(value: unknown, index: number): PublishingEpisodeUpdate {
  if (!isJson(value)) throw new Error(`Publication episode at index ${index} contains non-JSON data`);
  return validateEpisode(value, index, true);
}

function episodeDocument(value: ModuleRecordJsonValue | undefined): PublishingEpisodeDocument {
  if (!plainObject(value) || (value.episodes !== undefined && !Array.isArray(value.episodes))) {
    throw new Error("Publication episode map must contain an episodes array");
  }
  const document = value as ModuleRecordJsonObject;
  const episodes = (document.episodes as ModuleRecordJsonValue[] | undefined ?? [])
    .map((episode, index) => validateEpisode(episode, index) as PublishingEpisode);
  return { ...document, episodes };
}

export function parsePublishingEpisodesRecord(value: ModuleRecordJsonObject): PublishingEpisodesRecord {
  if (value.version !== 1 || !plainObject(value.document) || !Array.isArray(value.document.episodes)) {
    throw new Error("Invalid publishing episodes record");
  }
  return { version: 1, document: episodeDocument(value.document) };
}

/** Convert exactly once during maintenance or portable import. Reject values JSON cannot preserve. */
export function convertPublishingEpisodesYaml(content: string): PublishingEpisodesRecord {
  let parsed: unknown;
  try { parsed = YAML.parse(content); } catch { throw new Error("Invalid publication episode YAML"); }
  if (!isJson(parsed)) throw new Error("Publication episode map contains non-JSON data");
  return { version: 1, document: episodeDocument(parsed) };
}
