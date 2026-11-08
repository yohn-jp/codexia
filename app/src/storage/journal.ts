const DATABASE_NAME = "scriptorium-recovery";
const DATABASE_VERSION = 4;
const PERSISTENCE_DRAFT_STORE = "persistenceDrafts";
export interface PersistenceDraftEntry {
  version: 1;
  key: string;
  projectId: string;
  documentId: string;
  authorScope: string;
  baseRevisionId: string;
  baseMarkdown: string;
  markdown: string;
  generation: number;
  updatedAt: number;
}

export function persistenceDraftKey(projectId: string, documentId: string, authorScope: string): string {
  return JSON.stringify([authorScope, projectId, documentId]);
}
export class JournalError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "JournalError";
  }
}

function requestValue<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB transaction aborted"));
    transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB transaction failed"));
  });
}

function storageMessage(error: unknown, operation: string): JournalError {
  const name = error instanceof DOMException ? error.name : "";
  if (name === "QuotaExceededError") {
    return new JournalError(`Browser storage is full. Your ${operation} is still in this tab, but it could not be protected for recovery. Free browser storage and try again.`, error);
  }
  if (name === "SecurityError" || name === "NotAllowedError") {
    return new JournalError(`Browser storage is unavailable. Your ${operation} could not be protected for recovery.`, error);
  }
  return new JournalError(`Browser storage could not save your ${operation}. Keep this tab open and try again.`, error);
}

export class BrowserJournal {
  private constructor(private readonly database: IDBDatabase) {}
  static async open(): Promise<BrowserJournal> {
    if (typeof indexedDB === "undefined") throw new JournalError("This browser does not provide IndexedDB recovery storage.");
    try {
      const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(PERSISTENCE_DRAFT_STORE)) {
          request.result.createObjectStore(PERSISTENCE_DRAFT_STORE, { keyPath: "key" });
        }
      };
      const database = await requestValue(request);
      database.onversionchange = () => database.close();
      return new BrowserJournal(database);
    } catch (error) { throw storageMessage(error, "recovery journal"); }
  }
  close(): void {
    this.database.close();
  }

  async getPersistenceDraft(projectId: string, documentId: string, authorScope: string): Promise<PersistenceDraftEntry | undefined> {
    const key = persistenceDraftKey(projectId, documentId, authorScope);
    try {
      const transaction = this.database.transaction(PERSISTENCE_DRAFT_STORE, "readonly");
      const done = transactionDone(transaction);
      const value = await requestValue(transaction.objectStore(PERSISTENCE_DRAFT_STORE).get(key)) as PersistenceDraftEntry | undefined;
      await done;
      if (!value || value.version !== 1 || value.key !== key || value.projectId !== projectId || value.documentId !== documentId || value.authorScope !== authorScope) {
        return undefined;
      }
      return value;
    } catch (error) {
      throw storageMessage(error, "database draft");
    }
  }

  /** Persist PostgreSQL recovery state before attempting any remote write. */
  async putPersistenceDraft(entry: Omit<PersistenceDraftEntry, "version" | "key" | "updatedAt">): Promise<boolean> {
    try {
      if (!entry.projectId || !entry.documentId || !entry.authorScope || !entry.baseRevisionId ||
          !Number.isSafeInteger(entry.generation) || entry.generation < 1) {
        throw new JournalError("The database recovery record is incomplete.");
      }
      const key = persistenceDraftKey(entry.projectId, entry.documentId, entry.authorScope);
      const transaction = this.database.transaction(PERSISTENCE_DRAFT_STORE, "readwrite", { durability: "strict" });
      const done = transactionDone(transaction);
      const store = transaction.objectStore(PERSISTENCE_DRAFT_STORE);
      const existing = await requestValue(store.get(key)) as PersistenceDraftEntry | undefined;
      if (existing && existing.generation >= entry.generation) {
        const sameGeneration = existing.generation === entry.generation && existing.baseRevisionId === entry.baseRevisionId && existing.markdown === entry.markdown;
        await done;
        return sameGeneration;
      }
      store.put({ ...entry, version: 1, key, updatedAt: Date.now() } satisfies PersistenceDraftEntry);
      await done;
      return true;
    } catch (error) {
      if (error instanceof JournalError) throw error;
      throw storageMessage(error, "database draft");
    }
  }

  async removePersistenceDraft(projectId: string, documentId: string, authorScope: string, expectedGeneration?: number): Promise<boolean> {
    const key = persistenceDraftKey(projectId, documentId, authorScope);
    try {
      const transaction = this.database.transaction(PERSISTENCE_DRAFT_STORE, "readwrite", { durability: "strict" });
      const done = transactionDone(transaction);
      const store = transaction.objectStore(PERSISTENCE_DRAFT_STORE);
      const existing = await requestValue(store.get(key)) as PersistenceDraftEntry | undefined;
      if (!existing || (expectedGeneration !== undefined && existing.generation !== expectedGeneration)) {
        await done;
        return false;
      }
      store.delete(key);
      await done;
      return true;
    } catch (error) {
      throw storageMessage(error, "database draft");
    }
  }

}
