import assert from "node:assert/strict";
import test from "node:test";
import { shouldProtectBeforeUnload } from "./unload-protection.js";

test("blocks departure while an IME composition is uncommitted", () => {
  assert.equal(shouldProtectBeforeUnload({
    isComposing: true,
    dirty: false,
    recovery: "stored",
    unsafeUndo: false,
  }), true);
});

test("allows departure after a clean editor has no active composition", () => {
  assert.equal(shouldProtectBeforeUnload({
    isComposing: false,
    dirty: false,
    recovery: "stored",
    unsafeUndo: false,
  }), false);
});

test("continues to block departure when a dirty draft or undo is not protected", () => {
  assert.equal(shouldProtectBeforeUnload({
    isComposing: false,
    dirty: true,
    recovery: "pending",
    unsafeUndo: false,
  }), true);
  assert.equal(shouldProtectBeforeUnload({
    isComposing: false,
    dirty: false,
    recovery: "stored",
    unsafeUndo: true,
  }), true);
});
