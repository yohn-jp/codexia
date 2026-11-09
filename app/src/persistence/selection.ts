import { applicationPath, parseApplicationLocation } from "../application/navigation";

export interface WorkspaceSelection { projectId: string; documentId: string }
export function readWorkspaceSelection(storage: Pick<Storage, "getItem">, authorScope: string): WorkspaceSelection | null {
  try { const value: unknown = JSON.parse(storage.getItem(`codexia:postgres:selection:${authorScope}`) ?? "null"); return value && typeof value === "object" && typeof (value as WorkspaceSelection).projectId === "string" && typeof (value as WorkspaceSelection).documentId === "string" ? value as WorkspaceSelection : null; } catch { return null; }
}

/** A valid deep link takes precedence over this browser's last project/document. */
export function readWorkspaceSelectionForLocation(
  storage: Pick<Storage, "getItem">,
  authorScope: string,
  mode: "desktop" | "mobile",
  locationHref: string,
): WorkspaceSelection | null {
  const stored = readWorkspaceSelection(storage, authorScope);
  const route = parseApplicationLocation(locationHref);
  if (route?.mode !== mode || !route.resource?.projectId) return stored;
  return {
    projectId: route.resource.projectId,
    documentId: route.resource.sceneId ?? (stored?.projectId === route.resource.projectId ? stored.documentId : ""),
  };
}

export function workspaceSelectionPath(
  mode: "desktop" | "mobile",
  selection: WorkspaceSelection | null,
  currentSearch = "",
): string {
  return applicationPath(mode, selection?.projectId ? {
    projectId: selection.projectId,
    ...(selection.documentId ? { sceneId: selection.documentId } : {}),
  } : null, currentSearch);
}

export function writeWorkspaceSelection(storage: Pick<Storage, "setItem">, authorScope: string, selection: WorkspaceSelection): void {
  try { storage.setItem(`codexia:postgres:selection:${authorScope}`, JSON.stringify(selection)); } catch { /* Preferences never weaken the recovery journal. */ }
}
