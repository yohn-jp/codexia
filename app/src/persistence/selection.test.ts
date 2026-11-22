import assert from "node:assert/strict";
import { test } from "node:test";
import { readWorkspaceSelection, readWorkspaceSelectionForLocation, writeWorkspaceSelection } from "./selection";

function workspacePreferences() {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
  };
}

test("browser selection survives reload without crossing author scopes", () => {
  const storage = workspacePreferences();
  const selection = { projectId: "project", documentId: "scene-two" };
  writeWorkspaceSelection(storage, "author:one", selection);
  assert.deepEqual(readWorkspaceSelection(storage, "author:one"), selection);
  assert.equal(readWorkspaceSelection(storage, "author:two"), null);
  storage.values.set("codexia:postgres:selection:author:two", "bad");
  assert.equal(readWorkspaceSelection(storage, "author:two"), null);
});

test("opening a shared link takes precedence over the browser's remembered scene", () => {
  const storage = workspacePreferences();
  writeWorkspaceSelection(storage, "author:one", { projectId: "last-project", documentId: "last-scene" });
  assert.deepEqual(
    readWorkspaceSelectionForLocation(storage, "author:one", "desktop", "/desktop/projects/shared-project/scenes/shared-scene"),
    { projectId: "shared-project", documentId: "shared-scene" },
  );
  assert.deepEqual(
    readWorkspaceSelectionForLocation(storage, "author:one", "desktop", "/desktop/projects/shared-project"),
    { projectId: "shared-project", documentId: "" },
  );
  assert.deepEqual(
    readWorkspaceSelectionForLocation(storage, "author:one", "desktop", "/desktop/"),
    { projectId: "last-project", documentId: "last-scene" },
  );
});
