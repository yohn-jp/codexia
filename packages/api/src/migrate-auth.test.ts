import assert from "node:assert/strict";
import test from "node:test";
import { requireExplicitApply } from "./migrate-auth.js";

test("auth migrations require the explicit apply flag", () => {
  assert.throws(() => requireExplicitApply([]), /explicit --apply/u);
  assert.throws(() => requireExplicitApply(["--dry-run"]), /explicit --apply/u);
  assert.throws(() => requireExplicitApply(["--apply", "unexpected"]), /explicit --apply/u);
  assert.doesNotThrow(() => requireExplicitApply(["--apply"]));
});
