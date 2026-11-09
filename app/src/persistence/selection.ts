export interface WorkspaceSelection { projectId: string; documentId: string }
export function readWorkspaceSelection(storage: Pick<Storage, "getItem">, authorScope: string): WorkspaceSelection | null {
  try { const value: unknown = JSON.parse(storage.getItem(`codexia:postgres:selection:${authorScope}`) ?? "null"); return value && typeof value === "object" && typeof (value as WorkspaceSelection).projectId === "string" && typeof (value as WorkspaceSelection).documentId === "string" ? value as WorkspaceSelection : null; } catch { return null; }
}
export function writeWorkspaceSelection(storage: Pick<Storage, "setItem">, authorScope: string, selection: WorkspaceSelection): void {
  try { storage.setItem(`codexia:postgres:selection:${authorScope}`, JSON.stringify(selection)); } catch { /* Preferences never weaken the recovery journal. */ }
}
