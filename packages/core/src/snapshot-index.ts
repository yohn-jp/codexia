import YAML from "yaml";
import { splitManuscriptMarkdown } from "@codexia/contracts/manuscript";
import type { Document, DocumentRevisionKey } from "@codexia/persistence-contracts";

export interface InlineSnapshotFile {
  content: string;
  encoding: "utf8" | "base64";
  revision: string;
  documentId?: string;
  metadata?: boolean;
}

export interface SnapshotRevisionFile extends DocumentRevisionKey {
  revision: string;
  metadata?: false;
}

export type SnapshotIndexFile = InlineSnapshotFile | SnapshotRevisionFile;

export interface SnapshotDocumentPaths {
  bodyPath?: string;
  metadataPath?: string;
}

export interface SnapshotIndex {
  documentsById: Map<string, Document>;
  firstDocumentByLookupId: Map<string, Document>;
  logicalIdByDocumentId: Map<string, string>;
  logicalDocumentIds: Set<string>;
  pathsByDocumentId: Map<string, SnapshotDocumentPaths>;
  documentsByParentId: Map<string | null, Document[]>;
  volumes: Document[];
  chaptersByVolumeId: Map<string, Document[]>;
  scenesByChapterId: Map<string, Document[]>;
  writingCharacterCountsByDocumentId: Map<string, number>;
}

const WHITESPACE = /\s/u;

export function manuscriptBody(content: string): string {
  return splitManuscriptMarkdown(content).body;
}

export function manuscriptCharacterCount(content: string): number {
  let count = 0;
  for (const character of manuscriptBody(content)) {
    if (!WHITESPACE.test(character)) count++;
  }
  return count;
}

/** Build metadata-only lookup tables for one immutable manifest. File contents stay in the manifest. */
export function createSnapshotIndex(
  documents: readonly Document[],
  files: Readonly<Record<string, SnapshotIndexFile>>,
  logicalDocumentIdsWithoutFiles?: Readonly<Record<string, string>>,
): SnapshotIndex {
  const pathsByDocumentId = new Map<string, SnapshotDocumentPaths>();
  for (const [path, file] of Object.entries(files)) {
    if (!file.documentId) continue;
    let paths = pathsByDocumentId.get(file.documentId);
    if (!paths) {
      paths = {};
      pathsByDocumentId.set(file.documentId, paths);
    }
    if (file.metadata) paths.metadataPath ??= path;
    else paths.bodyPath ??= path;
  }

  const documentsById = new Map<string, Document>();
  const firstDocumentByLookupId = new Map<string, Document>();
  const logicalIdByDocumentId = new Map<string, string>();
  const logicalDocumentIds = new Set<string>();
  const documentsByParentId = new Map<string | null, Document[]>();
  const volumes: Document[] = [];
  const chaptersByVolumeId = new Map<string, Document[]>();
  const scenesByChapterId = new Map<string, Document[]>();

  for (const document of documents) {
    documentsById.set(document.id, document);
    const metadataPath = pathsByDocumentId.get(document.id)?.metadataPath;
    const metadataFile = metadataPath ? files[metadataPath] : undefined;
    const metadata = metadataFile && "content" in metadataFile ? YAML.parse(metadataFile.content) : null;
    const logicalId = typeof metadata?.id === "string" ? metadata.id : logicalDocumentIdsWithoutFiles?.[document.id] ?? document.id;
    logicalIdByDocumentId.set(document.id, logicalId);
    logicalDocumentIds.add(logicalId);
    if (!firstDocumentByLookupId.has(document.id)) firstDocumentByLookupId.set(document.id, document);
    if (!firstDocumentByLookupId.has(logicalId)) firstDocumentByLookupId.set(logicalId, document);

    const children = documentsByParentId.get(document.parentId) ?? [];
    children.push(document);
    documentsByParentId.set(document.parentId, children);
    if (document.kind === "volume") volumes.push(document);
    if (document.kind === "chapter" && document.parentId !== null) {
      const chapters = chaptersByVolumeId.get(document.parentId) ?? [];
      chapters.push(document);
      chaptersByVolumeId.set(document.parentId, chapters);
    }
    if (document.kind === "scene") {
      if (document.parentId !== null) {
        const scenes = scenesByChapterId.get(document.parentId) ?? [];
        scenes.push(document);
        scenesByChapterId.set(document.parentId, scenes);
      }
    }
  }

  return {
    documentsById,
    firstDocumentByLookupId,
    logicalIdByDocumentId,
    logicalDocumentIds,
    pathsByDocumentId,
    documentsByParentId,
    volumes,
    chaptersByVolumeId,
    scenesByChapterId,
    writingCharacterCountsByDocumentId: new Map(),
  };
}

/** Approximate retained index payload; the LRU never retains manuscript or artifact bodies. */
export function estimateSnapshotIndexBytes(index: SnapshotIndex): number {
  // Account for retained Document strings as well as lookup keys. Use a
  // conservative UTF-16 payload estimate and fixed map/object overhead.
  const stringBytes = (value: string): number => value.length * 2;
  let bytes = 1024;
  for (const document of index.documentsById.values()) {
    bytes += 512;
    for (const value of Object.values(document)) {
      if (typeof value === "string") bytes += stringBytes(value);
    }
  }
  for (const [documentId, logicalId] of index.logicalIdByDocumentId) {
    bytes += 96 + stringBytes(documentId) + stringBytes(logicalId);
  }
  for (const [documentId, paths] of index.pathsByDocumentId) {
    bytes += 96 + stringBytes(documentId);
    if (paths.bodyPath) bytes += stringBytes(paths.bodyPath);
    if (paths.metadataPath) bytes += stringBytes(paths.metadataPath);
  }
  return bytes;
}
