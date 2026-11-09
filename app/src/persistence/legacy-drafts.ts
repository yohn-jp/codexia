import { draftKey, type LocalDraft } from "../drafts";

export interface LegacyStorage {
  readonly length: number;
  key(index: number): string | null;
  getItem(key: string): string | null;
  removeItem(key: string): void;
}
export interface LegacyDraftSnapshot { key: string; raw: string; draft: LocalDraft }

/** Inspect only known recovery records. Malformed records stay available to manual recovery. */
export function readLegacyDraft(storage: LegacyStorage, key: string): LegacyDraftSnapshot | null {
  if (!key.startsWith("scriptorium:draft:")) return null;
  const raw = storage.getItem(key);
  if (!raw || raw.length > 8 * 1024 * 1024) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const draft = value as LocalDraft;
    if (draft.version !== 1 || typeof draft.projectId !== "string" || typeof draft.sceneId !== "string" ||
        typeof draft.text !== "string" || typeof draft.revision !== "string" || !Number.isFinite(draft.savedAt) ||
        draftKey(draft.projectId, draft.sceneId) !== key) return null;
    return { key, raw, draft };
  } catch { return null; }
}

export function listLegacyDrafts(storage: LegacyStorage): LegacyDraftSnapshot[] {
  const result: LegacyDraftSnapshot[] = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (!key) continue;
    const snapshot = readLegacyDraft(storage, key);
    if (snapshot) result.push(snapshot);
  }
  return result.sort((a, b) => b.draft.savedAt - a.draft.savedAt);
}

/** Call only after the exact imported payload is durable in the target journal. */
export function removeImportedLegacyDraft(storage: LegacyStorage, snapshot: LegacyDraftSnapshot): boolean {
  if (storage.getItem(snapshot.key) !== snapshot.raw) return false;
  storage.removeItem(snapshot.key);
  return true;
}
