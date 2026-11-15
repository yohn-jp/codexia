import assert from "node:assert/strict";
import { test } from "node:test";
import type { Document, DocumentId, ProjectId } from "@codexia/persistence-contracts";
import { createSnapshotIndex, estimateSnapshotIndexBytes, type SnapshotIndexFile } from "./snapshot-index.js";

const projectId = "project-index" as ProjectId;

function document(
  id: string,
  kind: string,
  title: string,
  parentId: string | null,
  orderKey: string,
): Document {
  return {
    id: id as DocumentId,
    projectId,
    parentId: parentId as DocumentId | null,
    kind,
    title,
    orderKey,
    headRevisionId: null,
    version: 1,
    createdAt: "2026-11-15T00:00:00.000Z",
    updatedAt: "2026-11-15T00:00:00.000Z",
  };
}

function file(content: string, documentId?: string, metadata = false): SnapshotIndexFile {
  return { content, encoding: "utf8", revision: "revision", ...(documentId ? { documentId } : {}), ...(metadata ? { metadata: true } : {}) };
}

test("snapshot indexes keep parent order, first logical ID resolution, paths, and Unicode writing counts", () => {
  const volume = document("volume-db", "volume", "Volume", null, "01");
  const chapter = document("chapter-db", "chapter", "Chapter", volume.id, "01");
  const first = document("scene-first", "scene", "First", chapter.id, "01");
  const second = document("scene-second", "scene", "Second", chapter.id, "02");
  const documents = [volume, chapter, first, second];
  const files: Record<string, SnapshotIndexFile> = {
    "metadata/volume.yaml": file("id: volume-logical\n", volume.id, true),
    "metadata/chapter.yaml": file("id: chapter-logical\n", chapter.id, true),
    "manuscript/first.md": file("---\nid: frontmatter-is-not-the-id\n---\n本文 😀 e\u0301 \u00a0\r\n", first.id),
    "metadata/first.yaml": file("id: duplicate-logical\n", first.id, true),
    "manuscript/first-later.md": file("ignored later body", first.id),
    "metadata/first-later.yaml": file("id: ignored-later-id\n", first.id, true),
    "metadata/second.yaml": file("id: duplicate-logical\n", second.id, true),
    "manuscript/second.md": file("二番目😀", second.id),
  };

  const index = createSnapshotIndex(documents, files);
  assert.deepEqual(index.volumes.map(({ id }) => id), [volume.id]);
  assert.deepEqual(index.chaptersByVolumeId.get(volume.id)?.map(({ id }) => id), [chapter.id]);
  assert.deepEqual(index.scenesByChapterId.get(chapter.id)?.map(({ id }) => id), [first.id, second.id]);
  assert.equal(index.logicalIdByDocumentId.get(first.id), "duplicate-logical");
  assert.equal(index.pathsByDocumentId.get(first.id)?.bodyPath, "manuscript/first.md");
  assert.equal(index.pathsByDocumentId.get(first.id)?.metadataPath, "metadata/first.yaml");
  assert.equal(index.firstDocumentByLookupId.get("duplicate-logical"), first);
  assert.equal(index.firstDocumentByLookupId.get(second.id), second);
  assert.equal(index.sceneCharacterCountsByDocumentId.get(first.id), 5);
  assert.equal(index.sceneCharacterCountsByDocumentId.get(second.id), 4);
});

test("snapshot indexes preserve actual ID lookup precedence when logical IDs collide with document IDs", () => {
  const first = document("scene-first", "scene", "First", null, "01");
  const second = document("shared-id", "scene", "Second", null, "02");
  const index = createSnapshotIndex([first, second], {
    "metadata/first.yaml": file("id: shared-id\n", first.id, true),
    "body/first.md": file("First", first.id),
    "metadata/second.yaml": file("id: second-logical\n", second.id, true),
    "body/second.md": file("Second", second.id),
  });

  assert.equal(index.firstDocumentByLookupId.get("shared-id"), first);
  assert.equal(index.logicalDocumentIds.has("shared-id"), true);
  assert.equal(index.logicalDocumentIds.has("second-logical"), true);
});

test("index counts a non-scene first match and accounts for retained variable-length document data", () => {
  const note = document("note-db", "note", "補足", null, "01");
  const scene = document("scene-db", "scene", "Scene", null, "02");
  const files = {
    "metadata/note.yaml": file("id: shared-logical\n", note.id, true),
    "body/note.md": file("補足 😀", note.id),
    "metadata/scene.yaml": file("id: shared-logical\n", scene.id, true),
    "body/scene.md": file("different", scene.id),
  };
  const index = createSnapshotIndex([note, scene], files);
  assert.equal(index.firstDocumentByLookupId.get("shared-logical"), note);
  assert.equal(index.sceneCharacterCountsByDocumentId.get(note.id), 3);
  const oversizedTitle = "界".repeat(3 * 1024 * 1024);
  const oversized = createSnapshotIndex([{...note, title: oversizedTitle}, scene], files);
  assert.ok(estimateSnapshotIndexBytes(oversized) > 4 * 1024 * 1024);
  assert.ok(estimateSnapshotIndexBytes(oversized) - estimateSnapshotIndexBytes(index) >= 2 * (oversizedTitle.length - note.title.length));
});
