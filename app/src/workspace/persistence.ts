import { createWorkspacePreset, validateWorkspaceLayout, visiblePanelIds, type WorkspaceLayout, type WorkspacePreset } from "./layout";
import { validateFloatingPanels, type FloatingPanelLayout } from "./floating";

const MAX_WORKSPACE_RECORD_CHARACTERS = 72 * 1024 + 128;

export interface WorkspaceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface WorkspaceLoad {
  layout: WorkspaceLayout;
  floating: FloatingPanelLayout[];
  state: "missing" | "valid" | "invalid" | "unavailable";
}

export interface WorkspaceSnapshot {
  layout: WorkspaceLayout;
  floating: FloatingPanelLayout[];
}

/** One localStorage value is the commit point for a complete workspace layout. */
export function workspaceSnapshotStorageKey(scope: string, mode: "desktop"): string {
  return `scriptorium:workspace:v2:${encodeURIComponent(scope)}:${mode}`;
}

function workspacePanelIds(layout: WorkspaceLayout): string[] {
  return [...visiblePanelIds(layout.root), ...layout.hiddenPanelIds];
}

function isWorkspaceSnapshot(value: unknown): value is WorkspaceSnapshot & { version: 2 } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== 3 || !["version", "layout", "floating"].every((key) => Object.prototype.hasOwnProperty.call(record, key)) ||
      record.version !== 2 || !validateWorkspaceLayout(record.layout) || !Array.isArray(record.floating)) return false;
  return validateFloatingPanels(record.floating, workspacePanelIds(record.layout), record.layout.hiddenPanelIds);
}

/** Restore the committed layout record for this author and device. */
export function loadWorkspaceSnapshot(
  storage: WorkspaceStorage,
  scope: string,
  mode: "desktop",
  panelIds: string[],
): WorkspaceLoad {
  const fallback = createWorkspacePreset("writing", panelIds);
  let raw: string | null;
  try {
    raw = storage.getItem(workspaceSnapshotStorageKey(scope, mode));
  } catch {
    return { layout: fallback, floating: [], state: "unavailable" };
  }
  if (raw === null) return { layout: fallback, floating: [], state: "missing" };
  if (raw.length > MAX_WORKSPACE_RECORD_CHARACTERS) return { layout: fallback, floating: [], state: "invalid" };
  try {
    const value: unknown = JSON.parse(raw);
    return isWorkspaceSnapshot(value)
      ? { layout: value.layout, floating: value.floating, state: "valid" }
      : { layout: fallback, floating: [], state: "invalid" };
  } catch {
    return { layout: fallback, floating: [], state: "invalid" };
  }
}

/** Persistence happens only after an explicit user save action. */
export function saveWorkspaceSnapshot(
  storage: WorkspaceStorage,
  scope: string,
  mode: "desktop",
  snapshot: WorkspaceSnapshot,
): boolean {
  const value = { version: 2 as const, layout: snapshot.layout, floating: snapshot.floating };
  if (!isWorkspaceSnapshot(value)) return false;
  try {
    const serialized = JSON.stringify(value);
    if (serialized.length > MAX_WORKSPACE_RECORD_CHARACTERS) return false;
    storage.setItem(workspaceSnapshotStorageKey(scope, mode), serialized);
    return true;
  } catch {
    return false;
  }
}

export function presetTitle(preset: WorkspacePreset): string {
  switch (preset) {
    case "writing": return "執筆";
    case "research": return "調査";
    case "review": return "レビュー";
    case "custom": return "カスタム";
  }
}
