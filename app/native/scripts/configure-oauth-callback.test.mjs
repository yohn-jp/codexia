import test from "node:test";
import assert from "node:assert/strict";
import { configureCallbackScheme } from "./configure-oauth-callback.mjs";
// Registered iOS redirect URI in app/native/README.md.
const registeredCallback = new URL("jp.yohn.codexia:/oauth2redirect");

test("registers the native OAuth scheme while preserving other URL handlers", () => {
  const existing = { CFBundleURLName: "existing.handler", CFBundleTypeRole: "Editor", CFBundleURLSchemes: ["existing.scheme"] };
  const result = configureCallbackScheme({ CFBundleURLTypes: [existing] });
  assert.deepEqual(result.CFBundleURLTypes.find(handler => handler.CFBundleURLName === "existing.handler"), existing);
  const schemes = result.CFBundleURLTypes.flatMap(handler => handler.CFBundleURLSchemes);
  assert.deepEqual(schemes.sort(), ["existing.scheme", registeredCallback.protocol.slice(0, -1)].sort());
});

test("is idempotent across generated iOS project syncs", () => {
  const configured = configureCallbackScheme({});
  const firstSync = structuredClone(configured);
  assert.deepEqual(configureCallbackScheme(configured), firstSync);
});
