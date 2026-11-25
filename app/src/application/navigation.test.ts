import assert from "node:assert/strict";
import test from "node:test";
import { applicationPath, parseApplicationLocation, readUiModePreference, rememberUiMode } from "./navigation.js";

test("Desktop application paths retain exact resource identity and reject the retired route", () => {
  const resource = { projectId: "owner/work one", volumeId: "volume-1", chapterId: "chapter-2", sceneId: "scene/3" };
  const path = applicationPath("desktop", resource, "theme=dark");
  assert.equal(path, "/desktop/projects/owner%2Fwork%20one/scenes/scene%2F3?theme=dark&volume=volume-1&chapter=chapter-2");
  assert.deepEqual(parseApplicationLocation(path), { mode: "desktop", resource });
  assert.deepEqual(parseApplicationLocation("/desktop"), { mode: "desktop", resource: null });
  assert.equal(parseApplicationLocation("/mobile/projects/p/scenes/s"), null);
});

test("retired Mobile preference cannot select an authoring route", () => {
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
  values.set("scriptorium:ui-mode", "mobile");
  assert.equal(readUiModePreference(storage), null);
  assert.equal(rememberUiMode("desktop", storage), true);
  assert.equal(readUiModePreference(storage), "desktop");
});
