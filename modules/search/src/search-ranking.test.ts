import assert from "node:assert/strict";
import { test } from "node:test";
import { createSearchDocument, searchDocuments, searchTerms } from "./search-ranking.js";

test("lexical search ranks exact names and full text, applies scope and result bounds", () => {
  const documents = [
    createSearchDocument("manuscript/vol-1/ch-1/harbor.md", "a".repeat(64), "The moonlit harbor was quiet."),
    createSearchDocument("manuscript/vol-1/ch-2/market.md", "b".repeat(64), "A market near the harbor."),
    createSearchDocument("bible/locations/harbor.yaml", "c".repeat(64), "name: Harbor\ndescription: Moonlit waters"),
  ];
  const hits = searchDocuments(documents, "moonlit harbor", "fulltext", 1);
  assert.equal(hits.length, 1);
  assert.equal(hits[0]?.path, "manuscript/vol-1/ch-1/harbor.md");
  assert.match(hits[0]?.snippet ?? "", /moonlit harbor/u);
  assert.deepEqual(searchDocuments(documents, "har", "prefix", 10, "manuscript/vol-1/ch-2").map(({ path }) => path), [
    "manuscript/vol-1/ch-2/market.md",
  ]);
  assert.equal(searchDocuments(documents, "harbor", "exact", 10).some(({ path }) => path === "bible/locations/harbor.yaml"), true);
});

test("lexical search materializes snippets only for the highest ranked documents", () => {
  const reads: string[] = [];
  const documents = ["z", "a", "harbor"].map((name) => {
    const path = `manuscript/${name}.md`;
    const content = `Ships in the harbor: ${name}.`;
    return {
      ...createSearchDocument(path, name, content),
      get content() { reads.push(path); return content; },
    };
  });
  const hits = searchDocuments(documents, "harbor", "fulltext", 2);
  assert.deepEqual(hits.map(({ path, snippet }) => [path, snippet]), [
    ["manuscript/harbor.md", "Ships in the harbor: harbor."],
    ["manuscript/a.md", "Ships in the harbor: a."],
  ]);
  assert.deepEqual(reads, ["manuscript/harbor.md", "manuscript/a.md"]);
});

test("Japanese lexical search finds an unspaced prefix and uses explicit word hints", () => {
  const station = createSearchDocument("manuscript/a.md", "station-revision", "青い駅前で待つ");
  const harbor = createSearchDocument("manuscript/b.md", "harbor-revision", "青い港を散歩する");
  const documents = [station, harbor];

  assert.deepEqual(searchDocuments(documents, "駅前", "prefix", 10).map((hit) => hit.path), [station.path]);
  assert.deepEqual(searchDocuments(documents, "待ち合わせ", "fulltext", 10), []);
  assert.deepEqual(
    searchDocuments(documents, "待ち合わせ", "fulltext", 10, undefined, ["待つ"]).map((hit) => hit.path),
    [station.path],
  );
});

test("exact and prefix terminology lookups return only available scoped targets", () => {
  const terms = [
    { id: "term-blue", canonical: "Blue Lantern", aliases: ["Lantern"], targetPath: "bible/items/lantern.yaml" },
    { id: "term-old", canonical: "Blue Lining", aliases: [], targetPath: "bible/items/missing.yaml" },
  ];
  const revisions = new Map([["bible/items/lantern.yaml", "e".repeat(64)]]);
  assert.deepEqual(searchTerms(terms, revisions, "lantern", "exact").map(({ termId }) => termId), ["term-blue"]);
  assert.deepEqual(searchTerms(terms, revisions, "blue", "prefix").map(({ title }) => title), ["Blue Lantern"]);
});

test("lexical snippets retain original text after Unicode normalization", () => {
  for (const body of [
    "㍿".repeat(100) + "検索対象",
    "㍿".repeat(100) + "検索対象" + "e\u0301".repeat(300),
    "e\u0301".repeat(100) + "検索対象",
  ]) {
    const document = createSearchDocument("manuscript/scene.md", "a", body);
    const hit = searchDocuments([document], "検索対象", "fulltext", 1)[0];
    assert.ok(hit);
    assert.match(hit.snippet, /検索対象/u);
  }
});
