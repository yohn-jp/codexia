import assert from "node:assert/strict";
import test from "node:test";
import {
  applicationPath,
  parseApplicationLocation,
  readUiModePreference,
  rememberUiMode,
  switchApplicationPath,
} from "./navigation.js";

test("application paths retain resource identity when switching shells", () => {
  const resource = {
    projectId: "owner/work one",
    volumeId: "volume-1",
    chapterId: "chapter-2",
    sceneId: "scene/3",
  };
  const mobilePath = applicationPath("mobile", resource);
  assert.equal(mobilePath, "/mobile/projects/owner%2Fwork%20one/scenes/scene%2F3?volume=volume-1&chapter=chapter-2");
  assert.deepEqual(parseApplicationLocation(mobilePath), { mode: "mobile", resource });
  const desktopPath = new URL(switchApplicationPath(`${mobilePath}&view=settings&theme=dark`, "desktop"), "https://author.example.test");
  assert.equal(desktopPath.pathname, "/desktop/projects/owner%2Fwork%20one/scenes/scene%2F3");
  assert.deepEqual(Object.fromEntries(desktopPath.searchParams), { theme: "dark", volume: "volume-1", chapter: "chapter-2" });
  const writingPath = new URL(switchApplicationPath(
    "/desktop/projects/owner%2Fwork%20one/scenes/scene%2F3?view=settings&theme=dark&volume=volume-1&chapter=chapter-2",
    "mobile",
  ), "https://author.example.test");
  assert.equal(writingPath.pathname, "/mobile/projects/owner%2Fwork%20one/scenes/scene%2F3");
  assert.deepEqual(Object.fromEntries(writingPath.searchParams), { view: "writing", theme: "dark", volume: "volume-1", chapter: "chapter-2" });
  const projectLibraryPath = switchApplicationPath("/desktop/projects/project-1?view=settings&theme=dark", "mobile");
  assert.equal(new URL(projectLibraryPath, "http://codexia.invalid").searchParams.get("view"), "library");
  assert.equal(new URL(projectLibraryPath, "http://codexia.invalid").searchParams.get("theme"), "dark");
  assert.deepEqual(parseApplicationLocation("/desktop"), { mode: "desktop", resource: null });
});

test("explicit UI preference is read and remembered without selecting from paths", () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
  };
  assert.equal(readUiModePreference(storage), null);
  assert.equal(rememberUiMode("mobile", storage), true);
  assert.equal(values.get("scriptorium:ui-mode"), "mobile");
  assert.equal(readUiModePreference(storage), "mobile");
  values.set("scriptorium:ui-mode", "tablet");
  assert.equal(readUiModePreference(storage), null);
});
