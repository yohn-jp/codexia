import assert from "node:assert/strict";
import { test } from "node:test";
import { protectEditorTransition } from "./transition";

test("composition denial does not persist or authorize an unmount", async () => {
  let writes = 0;
  await assert.rejects(protectEditorTransition(() => ({ generation: 1 }), () => { throw new Error("IME active"); }, async () => { writes++; return true; }), /IME active/);
  assert.equal(writes, 0);
});
test("navigation requires the exact latest editor generation to be durable", async () => {
  let current = { generation: 1 };
  await assert.rejects(protectEditorTransition(() => current, () => {}, async () => { current = { generation: 2 }; return true; }), /本文が更新/);
  await assert.rejects(protectEditorTransition(() => current, () => {}, async () => false), /別タブ/);
  await protectEditorTransition(() => current, () => {}, async () => true);
});
test("journal failures propagate and prevent navigation", async () => {
  await assert.rejects(protectEditorTransition(() => ({ generation: 1 }), () => {}, async () => { throw new Error("quota"); }), /quota/);
});
