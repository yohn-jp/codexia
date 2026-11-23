import { splitManuscriptMarkdown } from "@codexia/contracts/manuscript";
import YAML from "yaml";
import { assertProjectPath, SNAPSHOT_READ_MANY_LIMIT, type NativeStoryDocument, type SnapshotReader } from "@codexia/contracts";
import type { StoryEntity, StoryGraphInput, StoryLink } from "./domain/index.js";

const ENTITY_DIRS: ReadonlyArray<[string, StoryEntity["type"]]> = [
  ["bible/characters", "character"],
  ["bible/locations", "location"],
  ["bible/items", "item"],
  ["bible/factions", "faction"],
  ["bible/timeline/events", "event"],
  ["bible/lore", "lore"],
  ["plot/threads", "thread"],
  ["plot/arcs", "arc"],
  ["bible/dialogue_sketches", "dialogue_sketch"],
];

const ENTITY_TYPES = new Set<StoryEntity["type"]>([
  "character", "location", "item", "faction", "event", "thread", "scene", "chapter",
  "volume", "arc", "lore", "manuscript", "dialogue_sketch",
]);
const PRESERVATION_ARCHIVE_PATH = /^meta\/scriptorium\/modules\/[^/]+\/legacy(?:\/|$)/u;

const LINK_FIELDS: Readonly<Record<string, string>> = {
  appears: "appears",
  mentions: "mentions",
  plants: "plants",
  advances: "advances",
  related: "related",
  pov: "pov",
  affiliated: "affiliated",
  target: "target",
  first_appears: "first_appears",
  planted: "planted",
  payoff: "payoff",
};

export interface StoryFile {
  path: string;
  content: string;
  revision: string;
  documentKind?: string;
  documentOrder?: number;
}

export interface LoadedStorySnapshot extends StoryGraphInput {
  files: ReadonlyMap<string, StoryFile>;
  revisions: ReadonlyMap<string, string>;
  duplicateIds: ReadonlyMap<string, readonly string[]>;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function inferType(filePath: string, raw: Record<string, unknown>): StoryEntity["type"] | null {
  if (typeof raw.type === "string" && ENTITY_TYPES.has(raw.type as StoryEntity["type"])) {
    return raw.type as StoryEntity["type"];
  }
  for (const [prefix, type] of ENTITY_DIRS) {
    if (filePath.startsWith(`${prefix}/`)) return type;
  }
  if (/^plot\/volumes\/[^/]+\/volume\.ya?ml$/i.test(filePath)) return "volume";
  if (/^plot\/volumes\/[^/]+\/chapters\/[^/]+\/chapter\.ya?ml$/i.test(filePath)) return "chapter";
  if (/^plot\/volumes\/[^/]+\/chapters\/[^/]+\/scenes\/[^/]+\.ya?ml$/i.test(filePath)) return "scene";
  return null;
}

function appendLink(links: StoryLink[], from: string, to: unknown, kind: string, note?: unknown): void {
  if (typeof to !== "string" || !to) return;
  links.push({ from, to, kind, ...(typeof note === "string" ? { note } : {}) });
}

function extractLinks(entityId: string, raw: Record<string, unknown>, links: StoryLink[]): void {
  for (const [field, kind] of Object.entries(LINK_FIELDS)) {
    const value = raw[field];
    if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === "string") appendLink(links, entityId, item, kind);
        else {
          const ref = asRecord(item);
          if (ref) appendLink(links, entityId, ref.target ?? ref.scene ?? ref.id, kind, ref.note);
        }
      }
    } else if (typeof value === "string") {
      appendLink(links, entityId, value, kind);
    }
  }

  if (Array.isArray(raw.relations)) {
    for (const value of raw.relations) {
      const relation = asRecord(value);
      if (relation && typeof relation.target === "string") {
        appendLink(links, entityId, relation.target,
          typeof relation.kind === "string" ? relation.kind : "related", relation.note);
      }
    }
  }

  const nestedEntities = asRecord(raw.entities);
  if (nestedEntities) {
    for (const [field, kind] of Object.entries(LINK_FIELDS)) {
      const targets = nestedEntities[field];
      if (Array.isArray(targets)) {
        for (const target of targets) appendLink(links, entityId, target, kind);
      }
    }
  }

  const threads = asRecord(raw.threads);
  if (threads) {
    for (const field of ["plants", "advances"] as const) {
      const targets = threads[field];
      if (Array.isArray(targets)) {
        for (const target of targets) appendLink(links, entityId, target, field);
      }
    }
  }
}

// Core projects native PostgreSQL documents at documents/<documentId>.md.
const NATIVE_DOCUMENT_PATH = /^documents\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.md$/u;

function manuscriptId(filePath: string): string | null {
  const nativeId = NATIVE_DOCUMENT_PATH.exec(filePath)?.[1];
  // Keep the legacy manuscript ID namespace unchanged and separate from native IDs.
  if (nativeId) return `doc-ms-${nativeId}`;
  if (!filePath.startsWith("manuscript/") || !filePath.endsWith(".md")) return null;
  return filePath.replace(/^manuscript\//, "ms-").replace(/\//g, "-").replace(/\.md$/, "");
}

function entityFromMetadata(
  filePath: string,
  raw: Record<string, unknown>,
  id: unknown,
  type: StoryEntity["type"] | null,
): StoryEntity | null {
  if (typeof id !== "string" || !type) return null;
  return {
    id,
    type,
    name: typeof raw.name === "string" ? raw.name : undefined,
    aliases: Array.isArray(raw.aliases) ? raw.aliases.filter((alias): alias is string => typeof alias === "string") : undefined,
    status: typeof raw.status === "string" ? raw.status : undefined,
    tags: Array.isArray(raw.tags) ? raw.tags.filter((tag): tag is string => typeof tag === "string") : undefined,
    keywords: Array.isArray(raw.keywords) ? raw.keywords.filter((keyword): keyword is string => typeof keyword === "string") : undefined,
    resolution: typeof raw.resolution === "string" ? raw.resolution : undefined,
    filePath,
    raw,
  };
}

function parseStoryEntity(file: StoryFile): StoryEntity | null {
  const id = manuscriptId(file.path);
  if (id !== null) {
    const { metadata, body } = splitManuscriptMarkdown(file.content);
    return {
      id,
      type: "manuscript",
      name: typeof metadata.title === "string" ? metadata.title : undefined,
      status: typeof metadata.status === "string" ? metadata.status : undefined,
      tags: Array.isArray(metadata.tags) ? metadata.tags.filter((tag): tag is string => typeof tag === "string") : undefined,
      filePath: file.path,
      raw: metadata,
      body: body.trim(),
    };
  }
  // A native note has an author manuscript but its projected metadata is not a Story entity.
  if (file.documentKind === "note") return null;
  if (!file.path.endsWith(".yaml") && !file.path.endsWith(".yml")) return null;
  const raw = asRecord(YAML.parse(file.content));
  return raw ? entityFromMetadata(file.path, raw, raw.id, inferType(file.path, raw)) : null;
}

interface StorySnapshotOptions {
  includeManuscripts?: boolean;
  includeNativeDocuments?: boolean;
}

async function readFiles(
  reader: SnapshotReader,
  options: StorySnapshotOptions,
  nativeByPath: ReadonlyMap<string, NativeStoryDocument>,
): Promise<Map<string, StoryFile>> {
  const prefixes = ["bible", "plot", "meta"];
  if (options.includeManuscripts !== false) {
    prefixes.push("manuscript");
    if (options.includeNativeDocuments !== false) prefixes.push("documents");
  }
  const listed = await Promise.all(prefixes.map((prefix) => reader.list(prefix)));
  const pathSet = new Set(listed.flat().filter((filePath) =>
    (filePath.startsWith("documents/") ? NATIVE_DOCUMENT_PATH.test(filePath) :
      filePath.endsWith(".yaml") || filePath.endsWith(".yml") || manuscriptId(filePath) !== null)));
  for (const path of nativeByPath.keys()) pathSet.add(path);
  const paths = [...pathSet].filter((path) => !PRESERVATION_ARCHIVE_PATH.test(path)).sort();
  for (const filePath of paths) assertProjectPath(filePath);

  const files = new Map<string, StoryFile>();
  const batchSize = reader.readMany ? SNAPSHOT_READ_MANY_LIMIT : 12;
  for (let offset = 0; offset < paths.length; offset += batchSize) {
    const batch = paths.slice(offset, offset + batchSize);
    const filePaths = batch.filter((filePath) => !nativeByPath.has(filePath));
    const values = filePaths.length === 0 ? [] : reader.readMany
      ? await reader.readMany(filePaths)
      : await Promise.all(filePaths.map((filePath) => reader.read(filePath)));
    if (values.length !== filePaths.length) throw new TypeError("Snapshot file batch has the wrong length");
    let valueIndex = 0;
    for (const filePath of batch) {
      const document = nativeByPath.get(filePath);
      // Existing proposals still use the exact projected bytes and revision.
      const value = document ? {
        content: document.metadataContent,
        revision: document.metadataRevision,
        documentKind: document.kind,
        documentOrder: document.documentOrder,
      } : values[valueIndex++];
      if (value) files.set(filePath, {
        path: filePath,
        content: value.content,
        revision: value.revision,
        ...(value.documentKind ? { documentKind: value.documentKind } : {}),
        ...(value.documentOrder === undefined ? {} : { documentOrder: value.documentOrder }),
      });
    }
  }
  return files;
}

function parseNativeStoryEntity(document: NativeStoryDocument): StoryEntity | null {
  const kind = document.kind;
  if (kind !== "volume" && kind !== "chapter" && kind !== "scene") return null;
  return entityFromMetadata(document.metadataPath, document.metadata, document.id, kind);
}

/** Read one pinned Core snapshot, using its typed hierarchy and projected author data. */
export async function readStorySnapshot(
  reader: SnapshotReader,
  options: StorySnapshotOptions = {},
): Promise<LoadedStorySnapshot> {
  const nativeByPath = new Map((reader.nativeStoryDocuments ?? []).map((document) => [document.metadataPath, document]));
  const files = await readFiles(reader, options, nativeByPath);
  const entities = new Map<string, StoryEntity>();
  const filePathsById = new Map<string, string[]>();
  const links: StoryLink[] = [];
  const documentOrderByEntityId = new Map<string, number>();

  for (const file of files.values()) {
    const native = nativeByPath.get(file.path);
    const entity = native ? parseNativeStoryEntity(native) : parseStoryEntity(file);
    if (!entity) continue;
    entities.set(entity.id, entity);
    const order = native?.documentOrder ?? file.documentOrder;
    if (order !== undefined) documentOrderByEntityId.set(entity.id, order);
    const paths = filePathsById.get(entity.id) ?? [];
    paths.push(entity.filePath);
    filePathsById.set(entity.id, paths);
    extractLinks(entity.id, entity.raw, links);
  }

  for (const entity of entities.values()) {
    if (entity.type === "character" && entity.filePath.endsWith("/profile.yaml")) {
      const voicePath = entity.filePath.replace(/profile\.yaml$/, "voice.yaml");
      const voiceFile = files.get(voicePath);
      if (voiceFile) {
        try {
          const voice = asRecord(YAML.parse(voiceFile.content));
          if (voice) entity.raw = { ...entity.raw, voice };
        } catch {
          // The source loader keeps the profile usable when an optional voice.yaml is malformed.
        }
      }
    }
    if (entity.type !== "scene" || typeof entity.raw.manuscript !== "string") continue;
    const manuscript = [...entities.values()].find((candidate) => candidate.filePath === entity.raw.manuscript);
    if (manuscript) appendLink(links, entity.id, manuscript.id, "manuscript");
  }

  return {
    snapshot: reader.snapshot,
    entities,
    links,
    documentOrderByEntityId,
    files,
    revisions: new Map([...files].map(([filePath, file]) => [filePath, file.revision])),
    duplicateIds: new Map([...filePathsById].filter(([, paths]) => paths.length > 1)),
  };
}
