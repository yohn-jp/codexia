import assert from "node:assert/strict";
import { test } from "node:test";
import { PersistenceError } from "./index.js";

test("persistence errors expose stable codes and conflict details", () => {
  const error = new PersistenceError("conflict", "Document head changed", {
    resource: "document_revision",
    id: "document-id",
    expected: "revision-a",
    actual: "revision-b",
  });

  assert.equal(error.name, "PersistenceError");
  assert.equal(error.code, "conflict");
  assert.deepEqual(error.details, {
    resource: "document_revision",
    id: "document-id",
    expected: "revision-a",
    actual: "revision-b",
  });
});
