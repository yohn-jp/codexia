import assert from "node:assert/strict";
import { test } from "node:test";
import { readWorkspaceSelection, writeWorkspaceSelection } from "./selection";
test("PostgreSQL selection survives reload without crossing author scopes", () => {
  const values = new Map<string, string>(); const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
  writeWorkspaceSelection(storage, "author:one", { projectId: "project", documentId: "scene-two" });
  assert.deepEqual(readWorkspaceSelection(storage, "author:one"), { projectId: "project", documentId: "scene-two" });
  assert.equal(readWorkspaceSelection(storage, "author:two"), null);
  values.set("codexia:postgres:selection:author:two", "bad"); assert.equal(readWorkspaceSelection(storage, "author:two"), null);
});
