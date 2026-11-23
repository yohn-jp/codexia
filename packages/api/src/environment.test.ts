import assert from "node:assert/strict";
import test from "node:test";
import { readCodexiaEnvironment } from "./environment.js";

test("reads a configured Codexia setting and returns undefined when absent", () => {
  const codexiaKey = "CODEXIA_ENVIRONMENT_TEST";
  const previousCodexia = process.env[codexiaKey];
  try {
    process.env[codexiaKey] = "codexia-value";
    assert.equal(readCodexiaEnvironment("ENVIRONMENT_TEST"), "codexia-value");
    delete process.env[codexiaKey];
    assert.equal(readCodexiaEnvironment("ENVIRONMENT_TEST"), undefined);
  } finally {
    if (previousCodexia === undefined) delete process.env[codexiaKey];
    else process.env[codexiaKey] = previousCodexia;
  }
});
