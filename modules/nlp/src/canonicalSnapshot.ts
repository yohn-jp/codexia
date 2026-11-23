import { splitManuscriptMarkdown } from "@codexia/contracts/manuscript";
import { SNAPSHOT_READ_MANY_LIMIT, type SnapshotFile, type SnapshotReader } from "@codexia/contracts";
import YAML from "yaml";

export interface CanonicalSnapshotEntity {
  id: string;
  type: string;
  filePath: string;
  name?: string;
  aliases?: string[];
  raw: Record<string, unknown>;
  body?: string;
}

const ENTITY_PREFIXES = ["bible", "plot", "meta", "manuscript"] as const;
const PRESERVATION_ARCHIVE_PATH = /^meta\/scriptorium\/modules\/[^/]+\/legacy(?:\/|$)/u;
const MAX_ENTITY_FILES = 20_000;
const FRONT_MATTER_RE = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

function inferredType(path: string, data: Record<string, unknown>): string {
  if (typeof data.type === "string") return data.type;
  const normalized = `/${path.replaceAll("\\", "/")}`;
  const directoryTypes: Array<[string, string]> = [
    ["/bible/characters/", "character"], ["/bible/locations/", "location"],
    ["/bible/items/", "item"], ["/bible/factions/", "faction"],
    ["/bible/timeline/events/", "event"], ["/bible/lore/", "lore"],
    ["/plot/threads/", "thread"], ["/plot/arcs/", "arc"],
    ["/bible/dialogue_sketches/", "dialogue_sketch"],
  ];
  for (const [prefix, type] of directoryTypes) if (normalized.includes(prefix)) return type;
  if (normalized.includes("/plot/volumes/") && normalized.endsWith("volume.yaml")) return "volume";
  if (normalized.includes("/plot/volumes/") && normalized.endsWith("chapter.yaml")) return "chapter";
  if (normalized.includes("/scenes/") && /\.ya?ml$/i.test(path)) return "scene";
  if (normalized.includes("/manuscript/") && /\.md$/i.test(path)) return "manuscript";
  return "character";
}

function frontMatter(content: string): { raw: Record<string, unknown>; body: string } | null {
  const match = FRONT_MATTER_RE.exec(content);
  if (!match) return { raw: {}, body: content.trim() };
  let parsed: unknown;
  try { parsed = YAML.parse(match[1]); } catch { return null; }
  if (parsed === null || parsed === undefined) return { raw: {}, body: content.slice(match[0].length).trim() };
  if (typeof parsed !== "object" || Array.isArray(parsed)) return null;
  return { raw: parsed as Record<string, unknown>, body: content.slice(match[0].length).trim() };
}

function nativeSceneBodyPath(path: unknown): string | undefined {
  return typeof path === "string" && path.startsWith("documents/") && /\.md$/i.test(path) ? path : undefined;
}

function canonicalEntity(
  id: string, type: string, filePath: string, raw: Record<string, unknown>, body?: string,
): CanonicalSnapshotEntity {
  const aliases = Array.isArray(raw.aliases) ? raw.aliases.filter((alias): alias is string => typeof alias === "string") : undefined;
  return {
    id,
    type,
    filePath,
    ...(typeof raw.name === "string" ? { name: raw.name } : typeof raw.title === "string" && body !== undefined ? { name: raw.title } : {}),
    ...(aliases ? { aliases } : {}),
    raw,
    ...(body !== undefined ? { body } : {}),
  };
}

function parseFileEntity(path: string, file: SnapshotFile, isNativeSceneBody: boolean): CanonicalSnapshotEntity | undefined {
  if (file.documentKind === "note") return;
  const isMarkdown = /\.md$/i.test(path);
  let raw: Record<string, unknown>;
  let body: string | undefined;
  if (isMarkdown && (isNativeSceneBody || path.startsWith("manuscript/"))) {
    const manuscript = splitManuscriptMarkdown(file.content);
    raw = manuscript.metadata;
    body = manuscript.body.trim();
  } else if (isMarkdown) {
    const parsed = frontMatter(file.content);
    if (!parsed) return;
    raw = parsed.raw;
    body = parsed.body;
  } else {
    let parsed: unknown;
    try { parsed = YAML.parse(file.content); } catch { return; }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
    raw = parsed as Record<string, unknown>;
    if (typeof raw.id !== "string") return;
  }
  const id = isNativeSceneBody
    ? `doc-${path.slice("documents/".length).replaceAll("/", "-").replace(/\.md$/i, "")}`
    : isMarkdown
      ? `ms-${path.slice("manuscript/".length).replaceAll("/", "-").replace(/\.md$/i, "")}`
      : raw.id as string;
  return canonicalEntity(id, isNativeSceneBody ? "scene" : inferredType(path, raw), path, raw, body);
}

/** Read the pinned hierarchy and file-backed entity inputs without activating Story. */
export async function readCanonicalSnapshotEntities(
  reader: SnapshotReader,
  signal: AbortSignal,
): Promise<CanonicalSnapshotEntity[]> {
  const assertActive = () => {
    if (signal.aborted) throw Object.assign(new Error("Snapshot entity read was cancelled"), { code: "job_cancelled" });
  };
  assertActive();
  const hierarchy = new Map((reader.nativeStoryDocuments ?? [])
    .filter((document) => !PRESERVATION_ARCHIVE_PATH.test(document.metadataPath))
    .map((document) => [document.metadataPath, document]));
  const nativeSceneBodyPaths = new Set<string>();
  for (const document of hierarchy.values()) {
    if (document.kind !== "scene") continue;
    const path = nativeSceneBodyPath(document.metadata.manuscript);
    if (path) nativeSceneBodyPaths.add(path);
  }
  // Native document bodies are selected by the pinned scene links, not a path inventory.
  const listedPaths = (await Promise.all(ENTITY_PREFIXES.map((prefix) => reader.list(prefix)))).flat();
  assertActive();
  const listedEntities = listedPaths.filter((path) => !PRESERVATION_ARCHIVE_PATH.test(path) && /\.(?:ya?ml|md)$/i.test(path));
  const paths = [...new Set([...listedEntities, ...hierarchy.keys(), ...nativeSceneBodyPaths])].sort();
  if (paths.length > MAX_ENTITY_FILES) throw new TypeError(`Project analysis exceeds ${MAX_ENTITY_FILES} canonical entity files`);

  const entities: CanonicalSnapshotEntity[] = [];
  const batchSize = reader.readMany ? SNAPSHOT_READ_MANY_LIMIT : 1;
  for (let offset = 0; offset < paths.length; offset += batchSize) {
    assertActive();
    const batch = paths.slice(offset, offset + batchSize).filter((path) =>
      hierarchy.has(path) || !path.startsWith("documents/") || nativeSceneBodyPaths.has(path));
    const filePaths = batch.filter((path) => !hierarchy.has(path));
    const files = filePaths.length === 0 ? [] : reader.readMany
      ? await reader.readMany(filePaths)
      : await Promise.all(filePaths.map((path) => reader.read(path)));
    assertActive();
    if (files.length !== filePaths.length) throw new TypeError("Snapshot file batch has the wrong length");
    let fileIndex = 0;
    for (const path of batch) {
      const document = hierarchy.get(path);
      if (document) {
        const raw = document.metadata;
        const type = typeof raw.type === "string" ? raw.type : document.kind;
        entities.push(canonicalEntity(document.id, type, path, raw));
        continue;
      }
      const file = files[fileIndex++];
      const entity = file && parseFileEntity(path, file, nativeSceneBodyPaths.has(path));
      if (entity) entities.push(entity);
    }
  }
  return entities;
}
