import assert from "node:assert/strict";
import test from "node:test";
import { createWorkspacePreset, hideWorkspacePanel, resizeWorkspaceSplit, visiblePanelIds } from "./layout";
import {
  loadWorkspaceSnapshot,
  saveWorkspaceSnapshot,
  workspaceSnapshotStorageKey,
  type WorkspaceLoad,
  type WorkspaceStorage,
} from "./persistence";

class MemoryStorage implements WorkspaceStorage {
  values = new Map<string, string>();
  failKey: string | null = null;
  reads: string[] = [];
  writes: string[] = [];
  getItem(key: string): string | null {
    this.reads.push(key);
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.writes.push(key);
    if (key === this.failKey) throw new Error("quota exceeded");
    this.values.set(key, value);
  }
}

const panelIds = ["editor", "outline", "inspector", "history", "review"];

function assertWritingFallback(loaded: WorkspaceLoad, state: Exclude<WorkspaceLoad["state"], "valid">): void {
  assert.equal(loaded.state, state);
  assert.equal(loaded.layout.preset, "writing");
  // Desktop Authoring specifies the Writing dock as outline 20%, editor 80%.
  const { root } = loaded.layout;
  assert.ok(root.type === "split");
  assert.equal(root.direction, "horizontal");
  assert.deepEqual(visiblePanelIds(root), ["outline", "editor"]);
  assert.deepEqual(root.sizes, [20, 80]);
  assert.ok(loaded.layout.hiddenPanelIds.includes("inspector"));
  assert.deepEqual(loaded.floating, []);
}

test("a workspace save commits dock layout and floating geometry together for one author and device", () => {
  const storage = new MemoryStorage();
  const desktop = createWorkspacePreset("writing", panelIds);
  const floatingLayout = hideWorkspacePanel(desktop, "outline");
  const floating = [{ panelId: "outline", left: 100, top: 120, width: 350, height: 390 }];
  const snapshot = { layout: floatingLayout, floating };

  assert.equal(saveWorkspaceSnapshot(storage, "author:one", "desktop", snapshot), true);
  assert.equal(storage.writes.length, 1);
  assert.equal(storage.values.size, 1);
  const reloaded = loadWorkspaceSnapshot(storage, "author:one", "desktop", panelIds);
  assert.equal(reloaded.state, "valid");
  assert.deepEqual(reloaded, { ...snapshot, state: "valid" });

  assert.equal(loadWorkspaceSnapshot(storage, "author:two", "desktop", panelIds).state, "missing");
  assert.equal(loadWorkspaceSnapshot(storage, "author:one", "mobile", panelIds).state, "missing");
  assert.equal(saveWorkspaceSnapshot(storage, "author:one", "mobile", snapshot), false);
  assert.equal(saveWorkspaceSnapshot(storage, "author:one", "mobile", { layout: desktop, floating: [] }), true);
  assert.deepEqual(loadWorkspaceSnapshot(storage, "author:one", "mobile", panelIds), { layout: desktop, floating: [], state: "valid" });
  assert.deepEqual(loadWorkspaceSnapshot(storage, "author:one", "desktop", panelIds), { ...snapshot, state: "valid" });
});

test("only the atomic record is read and an explicit save preserves bytes at retired keys", () => {
  const storage = new MemoryStorage();
  const layout = {
    version: 1,
    preset: "custom",
    root: { type: "leaf", panelId: "editor" },
    hiddenPanelIds: ["outline", "inspector", "history", "review"],
  } as const;
  const floating = [{ panelId: "outline", left: 100, top: 120, width: 350, height: 390 }];
  const legacyDockKey = "scriptorium:workspace:v1:author%3Aone:desktop";
  const legacyFloatingKey = "scriptorium:workspace:floating:v1:author%3Aone:desktop";
  const legacyDockBytes = JSON.stringify(layout);
  const legacyFloatingBytes = JSON.stringify(floating);
  storage.values.set(legacyDockKey, legacyDockBytes);
  storage.values.set(legacyFloatingKey, legacyFloatingBytes);

  const loaded = loadWorkspaceSnapshot(storage, "author:one", "desktop", panelIds);
  const currentKey = "scriptorium:workspace:v2:author%3Aone:desktop";
  assertWritingFallback(loaded, "missing");
  assert.deepEqual(storage.reads, [currentKey]);
  assert.deepEqual(storage.writes, []);

  const saved = { layout: hideWorkspacePanel(createWorkspacePreset("research", panelIds), "outline"), floating };
  assert.equal(saveWorkspaceSnapshot(storage, "author:one", "desktop", saved), true);
  assert.deepEqual(storage.writes, [currentKey]);
  assert.deepEqual(loadWorkspaceSnapshot(storage, "author:one", "desktop", panelIds), { ...saved, state: "valid" });
  assert.equal(storage.getItem(legacyDockKey), legacyDockBytes);
  assert.equal(storage.getItem(legacyFloatingKey), legacyFloatingBytes);
});

test("a failed workspace record write leaves the previous complete snapshot available after reload", () => {
  const storage = new MemoryStorage();
  const previousLayout = hideWorkspacePanel(createWorkspacePreset("writing", panelIds), "outline");
  const previousFloating = [{ panelId: "outline", left: 100, top: 120, width: 350, height: 390 }];
  const previous = { layout: previousLayout, floating: previousFloating };
  assert.equal(saveWorkspaceSnapshot(storage, "author:one", "desktop", previous), true);
  const key = workspaceSnapshotStorageKey("author:one", "desktop");
  const previousBytes = storage.getItem(key);
  assert.ok(previousBytes);

  const changedLayout = resizeWorkspaceSplit(previousLayout, previousLayout.root.type === "split" ? previousLayout.root.id : "", [72, 28]);
  const changed = { layout: changedLayout, floating: [{ ...previousFloating[0]!, left: 120 }] };
  storage.failKey = key;
  assert.equal(saveWorkspaceSnapshot(storage, "author:one", "desktop", changed), false);
  storage.failKey = null;

  assert.equal(storage.getItem(key), previousBytes);
  assert.deepEqual(loadWorkspaceSnapshot(storage, "author:one", "desktop", panelIds), { ...previous, state: "valid" });
});

test("malformed workspace records fall back without deleting their original bytes", () => {
  const storage = new MemoryStorage();
  const key = workspaceSnapshotStorageKey("author:one", "desktop");
  const malformed = '{"version":99,"layout":{"version":1},"floating":[]}';
  storage.values.set(key, malformed);

  const loaded = loadWorkspaceSnapshot(storage, "author:one", "desktop", panelIds);
  assertWritingFallback(loaded, "invalid");
  assert.deepEqual(storage.writes, []);
  assert.equal(storage.getItem(key), malformed);

  assert.equal(saveWorkspaceSnapshot(storage, "author:one", "desktop", { layout: loaded.layout, floating: [] }), true);
  assert.equal(loadWorkspaceSnapshot(storage, "author:one", "desktop", panelIds).state, "valid");
});

test("unavailable module layouts and floating panels survive Core-only restoration", () => {
  const storage = new MemoryStorage();
  const ids = [...panelIds, "module:optional.panel"];
  const layout = hideWorkspacePanel(createWorkspacePreset("writing", ids), "module:optional.panel");
  const floating = [{ panelId: "module:optional.panel", left: 100, top: 120, width: 350, height: 390 }];
  assert.equal(saveWorkspaceSnapshot(storage, "author:one", "desktop", { layout, floating }), true);

  const loaded = loadWorkspaceSnapshot(storage, "author:one", "desktop", panelIds);
  assert.equal(loaded.state, "valid");
  assert.ok(loaded.layout.hiddenPanelIds.includes("module:optional.panel"));
  assert.deepEqual(loaded.floating, floating);
});

test("oversized or non-declarative payloads are rejected without storage writes", () => {
  const storage = new MemoryStorage();
  const key = workspaceSnapshotStorageKey("author:one", "desktop");
  const layout = createWorkspacePreset("writing", panelIds);
  const atLimit = JSON.stringify({ version: 2, layout, floating: [] }).padEnd(72 * 1024 + 128, " ");
  storage.values.set(key, atLimit);
  assert.equal(loadWorkspaceSnapshot(storage, "author:one", "desktop", panelIds).state, "valid");
  const oversized = atLimit + " ";
  storage.values.set(key, oversized);
  assert.equal(loadWorkspaceSnapshot(storage, "author:one", "desktop", panelIds).state, "invalid");
  assert.equal(storage.getItem(key), oversized);

  assert.equal(saveWorkspaceSnapshot(storage, "author:one", "desktop", {
    layout: { ...layout, secret: "not allowed" } as never, floating: [],
  }), false);
  assert.equal(storage.getItem(key), oversized);
  assert.deepEqual(storage.writes, []);
});

test("storage errors fall back without pretending that persistence succeeded", () => {
  const writes: string[] = [];
  const inaccessible: WorkspaceStorage = {
    getItem() { throw new Error("blocked"); },
    setItem(key) { writes.push(key); throw new Error("blocked"); },
  };
  const desktop = loadWorkspaceSnapshot(inaccessible, "author:one", "desktop", panelIds);
  assertWritingFallback(desktop, "unavailable");
  const mobile = loadWorkspaceSnapshot(inaccessible, "author:one", "mobile", panelIds);
  assertWritingFallback(mobile, "unavailable");
  assert.deepEqual(writes, []);

  const { layout, floating } = mobile;
  assert.equal(saveWorkspaceSnapshot(inaccessible, "author:one", "mobile", { layout, floating }), false);
  assert.deepEqual(writes, [workspaceSnapshotStorageKey("author:one", "mobile")]);
});
