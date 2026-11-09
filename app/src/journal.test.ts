import assert from "node:assert/strict";
import test from "node:test";
import type { ChangeOperation } from "@codexia/contracts";
import { documentKey, journalEntryKey, projectKey } from "./storage/journal";

const projectId = "project-1";

function operation(id: string, generation: number): ChangeOperation {
  return {
    id,
    generation,
    projectId,
    baseProjectVersion: 1,
    effect: "manuscript",
    reads: [],
    writes: [],
    message: "test",
  };
}

test("journal keys isolate author scopes and retain each operation generation", () => {
  const pathKey = documentKey(projectId, "manuscript/scene.md");
  const generationOne = journalEntryKey({ documentKey: pathKey, authorScope: "owner", operation: operation("operation-a", 1) });
  const generationTwo = journalEntryKey({ documentKey: pathKey, authorScope: "owner", operation: operation("operation-a", 2) });
  const otherAuthor = journalEntryKey({ documentKey: pathKey, authorScope: "guest", operation: operation("operation-a", 1) });

  assert.notEqual(generationOne, generationTwo);
  assert.notEqual(generationOne, otherAuthor);
});

test("project document keys cannot collide across projects or paths", () => {
  assert.equal(projectKey(projectId), projectKey("project-1"));
  assert.notEqual(documentKey(projectId, "a"), documentKey("project-2", "a"));
  assert.notEqual(documentKey(projectId, "a"), documentKey(projectId, "b"));
});

test("proposal recovery binds complete operation payload and project revision", async () => {
  const { proposalOperationEntry } = await import("./storage/journal");
  const op = { ...operation("operation-a", 1), writes: [{ path: "a.md", revision: null, content: "draft" }] };
  const proposal = { id: "proposal-1", source: "module" as const, snapshot: { projectId, projectVersion: 1 }, operations: [op] };
  const entry = proposalOperationEntry(projectId, "author-1", proposal, op);
  assert.equal(entry.projectId, projectId);
  assert.equal(entry.authorScope, "author-1");
  assert.throws(() => proposalOperationEntry("other-project", "author-1", proposal, op), /match/u);
  assert.throws(() => proposalOperationEntry(projectId, "", proposal, op), /author/u);
  assert.throws(() => proposalOperationEntry(projectId, "author-1", proposal, { ...op, baseProjectVersion: 2 }), /match/u);
  assert.throws(() => proposalOperationEntry(projectId, "author-1", proposal, { ...op, message: "changed payload" }), /match/u);
});

test("application receipt must confirm the exact generation, advancing project version and full write set", async () => {
  const { assertApplicationReceipt } = await import("./storage/journal");
  const op = { ...operation("operation-a", 1), writes: [{ path: "a.md", revision: null, content: "draft" }] };
  const receipt = { operationId: op.id, generation: 1, projectVersion: 2, revisions: [{ path: "a.md", revision: "revision-2" }] };
  assert.doesNotThrow(() => assertApplicationReceipt(receipt, op));
  for (const invalid of [
    { ...receipt, generation: 2 }, { ...receipt, projectVersion: 1 }, { ...receipt, revisions: [] },
    { ...receipt, revisions: [{ path: "other.md", revision: "revision-2" }] },
  ]) assert.throws(() => assertApplicationReceipt(invalid, op), /receipt/u);
});
