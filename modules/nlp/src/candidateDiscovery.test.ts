import assert from "node:assert/strict";
import { test } from "node:test";
import { readCanonicalSnapshotEntities } from "./canonicalSnapshot.js";
import { aggregateCandidateTerms, extractCompoundNounsWithReading } from "./candidateDiscovery.js";
import { expandSearchTerms, suggestTermVariants } from "./termVariants.js";
import type { Token } from "./tokenizer/types.js";

function noun(surface: string, reading: string, start: number): Token {
  return { surface, reading, pos: "名詞", start, end: start + surface.length };
}

test("candidate aggregation preserves source reading, per-entity occurrence count, and known-name exclusions", () => {
  const firstText = [noun("銀", "ギン", 0), noun("河", "カワ", 1), { surface: "。", pos: "記号", start: 2, end: 3 }];
  const secondText = [noun("銀", "ギン", 0), noun("河", "カワ", 1)];
  const otherTerm = [noun("大", "ダイ", 0), noun("河", "カワ", 1)];
  assert.deepEqual(extractCompoundNounsWithReading(firstText), [{ term: "銀河", reading: "ギンカワ" }]);

  const candidates = aggregateCandidateTerms([
    { id: "character-1", tokenizedTexts: [firstText, secondText, otherTerm] },
    { id: "scene-1", tokenizedTexts: [firstText] },
  ], new Set(["大河"]));
  assert.deepEqual(candidates, [{ term: "銀河", reading: "ギンカワ", sourceEntityIds: ["character-1", "scene-1"], occurrenceCount: 3 }]);
});

test("candidate discovery only reads native manuscript bodies linked by the pinned hierarchy", async () => {
  const metadataPath = "plot/volumes/root/scenes/scene-a.yaml";
  const manuscriptPath = "documents/native-a.md";
  const privateNotePath = "documents/private-note.md";
  const entities = await readCanonicalSnapshotEntities({
    snapshot: { projectId: "project-a", projectVersion: 8 },
    nativeStoryDocuments: [{
      id: "scene-a", kind: "scene", title: "夜更け", orderKey: "01", documentOrder: 0,
      metadataPath, metadataRevision: "scene-v8", metadataContent: "manuscript: documents/native-a.md\n",
      metadata: { manuscript: manuscriptPath },
    }],
    async list(prefix) { return prefix === "documents" ? [manuscriptPath, privateNotePath] : []; },
    async read(path) {
      assert.notEqual(path, privateNotePath, "the candidate scanner must not open an unlinked note");
      return path === manuscriptPath ? { content: "銀河が見える。", revision: "manuscript-v8", documentKind: "scene" } : null;
    },
  }, new AbortController().signal);

  assert.deepEqual(entities.map(({ id, type, filePath, body }) => ({ id, type, filePath, body })), [
    { id: "doc-native-a", type: "scene", filePath: manuscriptPath, body: "銀河が見える。" },
    { id: "scene-a", type: "scene", filePath: metadataPath, body: undefined },
  ]);
});

test("candidate discovery does not infer native manuscripts when the pinned hierarchy is empty", async () => {
  const unexpectedPath = "documents/unlinked.md";
  const entities = await readCanonicalSnapshotEntities({
    snapshot: { projectId: "project-a", projectVersion: 9 },
    async list(prefix) { return prefix === "documents" ? [unexpectedPath] : []; },
    async read(path) {
      assert.notEqual(path, unexpectedPath, "an unlinked document is not part of the candidate corpus");
      return null;
    },
  }, new AbortController().signal);

  assert.deepEqual(entities, []);
});

test("term variants prefer a known canonical term even when an unknown variant is more frequent", () => {
  assert.deepEqual(
    suggestTermVariants([{ term: "王都街道筋", count: 20 }], new Set(["王都街道", "王都街道筋線"])),
    [{ candidate: "王都街道筋", canonical: "王都街道", count: 20 }],
  );
});

test("an unknown variant cluster uses its most frequent member as the canonical term", () => {
  assert.deepEqual(suggestTermVariants([
    { term: "王都街道筋", count: 2 },
    { term: "王都街道", count: 5 },
    { term: "王都街道脇", count: 3 },
    { term: "銀色飛行艇", count: 10 },
  ], new Set()), [
    { candidate: "王都街道筋", canonical: "王都街道", count: 2 },
    { candidate: "王都街道脇", canonical: "王都街道", count: 3 },
  ]);
});

test("search term expansion trims literals and adds only known source-style variants", () => {
  assert.deepEqual(expandSearchTerms("  サーベル剣  ", ["サーベル", "サーベル剣", "短剣", ""]), ["サーベル剣", "サーベル"]);
  assert.deepEqual(expandSearchTerms("   ", ["a"]), []);
});
