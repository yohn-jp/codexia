import assert from "node:assert/strict";
import { test } from "node:test";
import { listLegacyDrafts, readLegacyDraft, removeImportedLegacyDraft } from "./legacy-drafts";

function storage() {
  const entries = new Map<string, string>();
  return { entries, get length() { return entries.size; }, key(index: number) { return [...entries.keys()][index] ?? null; }, getItem(key: string) { return entries.get(key) ?? null; }, setItem(key: string, value: string) { entries.set(key, value); }, removeItem(key: string) { entries.delete(key); } };
}
const record = { version: 1, projectId: "old-project", sceneId: "old-scene", text: "回復する原稿😀", revision: "legacy-base", savedAt: 100 };
const key = "scriptorium:draft:old-project:old-scene";

test("malformed legacy records cannot hide later valid drafts or enter their payload", () => {
  const store = storage(); store.setItem("scriptorium:draft:broken", "{"); store.setItem(key, JSON.stringify(record));
  const drafts = listLegacyDrafts(store);
  assert.equal(drafts.length, 1); assert.equal(drafts[0]?.draft.text, record.text);
  assert.equal(store.length, 2);
});
test("source payload is reread for each explicit preview and remains untouched", () => {
  const store = storage(); store.setItem(key, JSON.stringify(record));
  const first = readLegacyDraft(store, key)!;
  store.setItem(key, JSON.stringify({ ...record, text: "新しい元原稿" }));
  assert.equal(readLegacyDraft(store, key)?.draft.text, "新しい元原稿");
  assert.equal(first.draft.text, record.text);
});
test("cleanup removes only the exact source version that became durable", () => {
  const store = storage(); store.setItem(key, JSON.stringify(record));
  const snapshot = readLegacyDraft(store, key)!;
  store.setItem(key, JSON.stringify({ ...record, text: "別タブからの変更" }));
  assert.equal(removeImportedLegacyDraft(store, snapshot), false);
  assert.ok(store.getItem(key));
  const newest = readLegacyDraft(store, key)!;
  assert.equal(removeImportedLegacyDraft(store, newest), true); assert.equal(store.getItem(key), null);
});
test("mismatched key identities and unsupported payloads remain unimported", () => {
  const store = storage(); store.setItem(key, JSON.stringify({ ...record, sceneId: "different" }));
  assert.equal(readLegacyDraft(store, key), null);
  store.setItem(key, JSON.stringify({ ...record, text: null }));
  assert.deepEqual(listLegacyDrafts(store), []); assert.equal(store.length, 1);
});
