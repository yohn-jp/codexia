import assert from "node:assert/strict";
import test from "node:test";
import { readCodexiaEnvironment } from "./environment.js";

test("Codexia settings take precedence over retained Scriptorium aliases", () => {
  const codexiaKey = "CODEXIA_COMPATIBILITY_TEST";
  const legacyKey = "SCRIPTORIUM_COMPATIBILITY_TEST";
  const previousCodexia = process.env[codexiaKey];
  const previousLegacy = process.env[legacyKey];
  try {
    process.env[codexiaKey] = "codexia-value";
    process.env[legacyKey] = "legacy-value";
    assert.equal(readCodexiaEnvironment("COMPATIBILITY_TEST"), "codexia-value");
    delete process.env[codexiaKey];
    assert.equal(readCodexiaEnvironment("COMPATIBILITY_TEST"), "legacy-value");
  } finally {
    if (previousCodexia === undefined) delete process.env[codexiaKey];
    else process.env[codexiaKey] = previousCodexia;
    if (previousLegacy === undefined) delete process.env[legacyKey];
    else process.env[legacyKey] = previousLegacy;
  }
});
