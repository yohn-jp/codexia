import test from "node:test";
import assert from "node:assert/strict";
import { configureCallbackScheme } from "./configure-oauth-callback.mjs";
import { CALLBACK_SCHEME } from "../plugins/codexia-auth/src/constants.mjs";

test("registers the native OAuth scheme while preserving other URL handlers", () => {
  const result = configureCallbackScheme({
    CFBundleURLTypes: [{ CFBundleTypeRole: "Editor", CFBundleURLSchemes: ["existing.scheme"] }],
  });
  assert.equal(result.CFBundleURLTypes.length, 2);
  assert.deepEqual(result.CFBundleURLTypes[0].CFBundleURLSchemes, ["existing.scheme"]);
  assert.deepEqual(result.CFBundleURLTypes[1].CFBundleURLSchemes, [CALLBACK_SCHEME]);
});

test("is idempotent across generated iOS project syncs", () => {
  const configured = configureCallbackScheme({});
  const again = configureCallbackScheme(configured);
  assert.equal(again.CFBundleURLTypes.length, 1);
  assert.deepEqual(again.CFBundleURLTypes[0].CFBundleURLSchemes, [CALLBACK_SCHEME]);
});
