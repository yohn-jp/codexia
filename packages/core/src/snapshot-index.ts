import YAML from "yaml";
import type { Document } from "@codexia/persistence-contracts";

export interface SnapshotIndexFile {
  content: string;
  encoding: "utf8" | "base64";
  revision: string;
  documentId?: string;
  metadata?: boolean;
}

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
  sceneCharacterCountsByDocumentId: Map<string, number>;
}

const WHITESPACE = /\s/u;

function manuscriptBody(content: string): string {
  return content.replace(/^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n)?/, "");
}

function countNonWhitespaceCodePoints(content: string): number {
  let count = 0;
  for (const character of content) {
    if (!WHITESPACE.test(character)) count++;
  }
  return count;
}

/** Build metadata-only lookup tables for one immutable manifest. File contents stay in the manifest. */
export function createSnapshotIndex(
  documents: readonly Document[],
  files: Readonly<Record<string, SnapshotIndexFile>>,
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
  const sceneCharacterCountsByDocumentId = new Map<string, number>();

  for (const document of documents) {
    documentsById.set(document.id, document);
    const metadataPath = pathsByDocumentId.get(document.id)?.metadataPath;
    const metadata = metadataPath ? YAML.parse(files[metadataPath]!.content) : null;
    const logicalId = typeof metadata?.id === "string" ? metadata.id : document.id;
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
      const bodyPath = pathsByDocumentId.get(document.id)?.bodyPath;
      const bodyContent = bodyPath ? files[bodyPath]!.content : "";
      sceneCharacterCountsByDocumentId.set(document.id, countNonWhitespaceCodePoints(manuscriptBody(bodyContent)));
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
    sceneCharacterCountsByDocumentId,
  };
}

/** Approximate retained index payload; the LRU never retains manuscript or artifact bodies. */
export function estimateSnapshotIndexBytes(index: SnapshotIndex): number {
  let bytes = index.documentsById.size * 256;
  for (const [documentId, logicalId] of index.logicalIdByDocumentId) {
    bytes += 48 + Buffer.byteLength(documentId) + Buffer.byteLength(logicalId);
  }
  for (const [documentId, paths] of index.pathsByDocumentId) {
    bytes += 48 + Buffer.byteLength(documentId);
    if (paths.bodyPath) bytes += Buffer.byteLength(paths.bodyPath);
    if (paths.metadataPath) bytes += Buffer.byteLength(paths.metadataPath);
  }
  return bytes;
}
