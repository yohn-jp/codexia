import assert from "node:assert/strict";
import { test } from "node:test";
import { BUILTIN_MODULE_IDS } from "@codexia/contracts";
import { responseContracts } from "./api-response.js";

const snapshot = { projectId: "fixture", projectVersion: 1 };

test("browser DTO guards accept exactly the canonical built-in module IDs", () => {
  for (const id of BUILTIN_MODULE_IDS) {
    assert.equal(responseContracts.modules([{ id, availability: "disabled", activeJobs: 0 }]), true);
    assert.equal(responseContracts.contributions([{ id: "test.contribution", module: id, slot: "dock", title: "Test", action: "test.run" }]), true);
    assert.equal(responseContracts.proposal({
      id: "proposal-1", snapshot, source: "module", operations: [],
      evidence: [{ id: "evidence-1", snapshot, module: id, kind: "test", paths: [], details: {} }],
    }), true);
  }

  assert.equal(responseContracts.modules([{ id: "experimental", availability: "disabled", activeJobs: 0 }]), false);
  assert.equal(responseContracts.contributions([{ id: "test.contribution", module: "experimental", slot: "dock", title: "Test", action: "test.run" }]), false);
  assert.equal(responseContracts.proposal({
    id: "proposal-1", snapshot, source: "module", operations: [],
    evidence: [{ id: "evidence-1", snapshot, module: "experimental", kind: "test", paths: [], details: {} }],
  }), false);
});
