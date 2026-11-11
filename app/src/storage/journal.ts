import {
  assertChangeOperation,
  type ChangeOperation,
  type ChangeProposal,
  type ApplyReceipt,
  type ProposalStatus,
  type SnapshotId,
} from "@codexia/contracts";

const DATABASE_NAME = "scriptorium-recovery";
const DATABASE_VERSION = 5;
const ENTRY_STORE = "pgOperations";
const SCRATCH_STORE = "pgScratch";
const PROPOSAL_STORE = "pgProposals";
const APPLICATION_STORE = "pgApplications";
const PERSISTENCE_DRAFT_STORE = "persistenceDrafts";

export type JournalState = "draft" | "applying" | "applied" | "conflict";

export interface JournalEntry {
  version: 1;
  key: string;
  projectKey: string;
  documentKey: string;
  /** null marks a legacy record whose author identity was never recorded. */
  authorScope: string | null;
  projectId: string;
  documentPath: string;
  sceneId: string;
  snapshot: SnapshotId;
  text: string;
  baseText: string;
  operation: ChangeOperation;
  proposalId?: string;
  state: JournalState;
  application?: ApplyReceipt;
  authorizedAt?: number;
  updatedAt: number;
}

export interface JournalProposal {
  key: string;
  projectKey: string;
  /** null marks a legacy proposal whose author identity was never recorded. */
  authorScope: string | null;
  projectId: string;
  proposal: ChangeProposal;
  /** Latest Core review status for a remotely submitted proposal. */
  status?: ProposalStatus;
  /** A local dismissal hides a still-pending remote proposal without deleting its source record. */
  dismissedAt?: number;
  /** Identifies the insertion that first created this private record for cancellation cleanup. */
  ownershipToken?: string;
  createdAt: number;
}

export interface JournalProposalOwnership {
  token: string;
  proposal: ChangeProposal;
}

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

interface ScratchRecord {
  key: string;
  text: string;
  updatedAt: number;
}

export class JournalError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "JournalError";
  }
}

export function projectKey(projectId: string): string {
  if (!projectId) throw new JournalError("The recovery record has no project identity.");
  return JSON.stringify([projectId]);
}

export function documentKey(projectId: string, path: string): string {
  return JSON.stringify([projectKey(projectId), path]);
}

export function journalEntryKey(entry: Pick<JournalEntry, "documentKey" | "operation"> & { authorScope?: string | null }): string {
  return JSON.stringify([entry.documentKey, entry.authorScope ?? null, entry.operation.id, entry.operation.generation]);
}

export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

export function assertApplicationReceipt(receipt: ApplyReceipt, operation: ChangeOperation): void {
  const writes = new Set(operation.writes.map((write) => write.path));
  if (receipt.operationId !== operation.id || receipt.generation !== operation.generation ||
      !Number.isSafeInteger(receipt.projectVersion) || receipt.projectVersion <= operation.baseProjectVersion ||
      !Array.isArray(receipt.revisions) || receipt.revisions.length !== writes.size ||
      new Set(receipt.revisions.map((revision) => revision.path)).size !== writes.size ||
      receipt.revisions.some((revision) => !writes.has(revision.path) ||
        !(revision.revision === null || typeof revision.revision === "string" && revision.revision.length > 0))) {
    throw new JournalError("The application receipt does not match the exact operation and write set.");
  }
}

function assertJournalEntry(entry: JournalEntry): void {
  assertChangeOperation(entry.operation);
  if (!entry.authorScope || entry.projectKey !== projectKey(entry.projectId) ||
      entry.snapshot.projectId !== entry.projectId || entry.operation.projectId !== entry.projectId ||
      entry.snapshot.projectVersion !== entry.operation.baseProjectVersion ||
      entry.documentKey !== documentKey(entry.projectId, entry.documentPath) ||
      !entry.operation.writes.some((write) => write.path === entry.documentPath)) {
    throw new JournalError("The recovery record does not match its project, author, snapshot, or document.");
  }
}

export function proposalOperationEntry(
  projectId: string,
  authorScope: string,
  proposal: ChangeProposal,
  operation: ChangeOperation,
  state: JournalState = "draft",
  application?: ApplyReceipt,
): JournalEntry {
  if (!authorScope) throw new JournalError("The proposal has no author identity scope.");
  assertChangeOperation(operation);
  const owner = projectKey(projectId);
  if (projectKey(proposal.snapshot.projectId) !== owner || projectKey(operation.projectId) !== owner || operation.baseProjectVersion !== proposal.snapshot.projectVersion ||
      !proposal.operations.some((candidate) => stableJson(candidate) === stableJson(operation))) {
    throw new JournalError("The proposal operation does not match its projectId or complete payload.");
  }
  const documentPath = operation.writes[0]?.path;
  if (!documentPath) throw new JournalError("The proposal operation has no recoverable file path.");
  const entry: JournalEntry = {
    version: 1,
    key: "",
    projectKey: owner,
    documentKey: documentKey(projectId, documentPath),
    authorScope,
    projectId,
    documentPath,
    sceneId: proposal.id,
    snapshot: proposal.snapshot,
    text: typeof operation.writes[0]?.content === "string" ? operation.writes[0].content : "",
    baseText: "",
    operation,
    proposalId: proposal.id,
    state,
    ...(application ? { application, authorizedAt: Date.now() } : {}),
    updatedAt: Date.now(),
  };
  assertJournalEntry(entry);
  if (application) assertApplicationReceipt(application, operation);
  entry.key = journalEntryKey(entry);
  return entry;
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
        const database = request.result;
        if (!database.objectStoreNames.contains(ENTRY_STORE)) {
          const entries = database.createObjectStore(ENTRY_STORE, { keyPath: "key" });
          entries.createIndex("documentKey", "documentKey", { unique: false });
          entries.createIndex("projectKey", "projectKey", { unique: false });
          entries.createIndex("state", "state", { unique: false });
        }
        if (!database.objectStoreNames.contains(SCRATCH_STORE)) {
          database.createObjectStore(SCRATCH_STORE, { keyPath: "key" });
        }
        if (!database.objectStoreNames.contains(PROPOSAL_STORE)) {
          const proposals = database.createObjectStore(PROPOSAL_STORE, { keyPath: "key" });
          proposals.createIndex("projectKey", "projectKey", { unique: false });
        }
        if (!database.objectStoreNames.contains(APPLICATION_STORE)) {
          database.createObjectStore(APPLICATION_STORE, { keyPath: "key" });
        }
        if (!database.objectStoreNames.contains(PERSISTENCE_DRAFT_STORE)) {
          database.createObjectStore(PERSISTENCE_DRAFT_STORE, { keyPath: "key" });
        }
      };
      const database = await requestValue(request);
      database.onversionchange = () => database.close();
      return new BrowserJournal(database);
    } catch (error) {
      throw storageMessage(error, "recovery journal");
    }
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
        const sameGeneration = existing.generation === entry.generation && existing.baseRevisionId === entry.baseRevisionId && existing.baseMarkdown === entry.baseMarkdown && existing.markdown === entry.markdown;
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

  async put(entry: JournalEntry): Promise<void> {
    try {
      if (!entry.authorScope) throw new JournalError("The recovery record has no author identity scope.");
      assertJournalEntry(entry);
      const transaction = this.database.transaction(ENTRY_STORE, "readwrite", { durability: "strict" });
      const done = transactionDone(transaction);
      const store = transaction.objectStore(ENTRY_STORE);
      const key = journalEntryKey(entry);
      const existing = await requestValue(store.get(key)) as JournalEntry | undefined;
      if (existing && (existing.authorScope !== entry.authorScope || JSON.stringify(existing.operation) !== JSON.stringify(entry.operation))) {
        await done;
        throw new JournalError("A journal key cannot be reused for a different author or operation.");
      }
      if (!existing) store.put({ ...entry, key, updatedAt: Date.now() });
      await done;
    } catch (error) {
      if (error instanceof JournalError) throw error;
      throw storageMessage(error, "draft");
    }
  }

  /** Keep one editable draft per document while retaining every authorized operation. */
  async putLatestDraft(entry: JournalEntry): Promise<boolean> {
    try {
      if (!entry.authorScope) throw new JournalError("The recovery record has no author identity scope.");
      if (entry.state !== "draft") throw new JournalError("Only an editable draft can replace the latest draft.");
      assertJournalEntry(entry);
      const transaction = this.database.transaction(ENTRY_STORE, "readwrite", { durability: "strict" });
      const done = transactionDone(transaction);
      const store = transaction.objectStore(ENTRY_STORE);
      const existing = await requestValue(store.index("documentKey").getAll(entry.documentKey)) as JournalEntry[];
      for (const candidate of existing) {
        if (candidate.authorScope !== entry.authorScope) continue;
        if (candidate.operation.generation > entry.operation.generation) {
          await done;
          return false;
        }
        if (candidate.operation.generation === entry.operation.generation) {
          if (candidate.operation.id !== entry.operation.id || candidate.state !== "draft") {
            await done;
            return false;
          }
          if (JSON.stringify(candidate.operation) !== JSON.stringify(entry.operation)) {
            await done;
            throw new JournalError("A journal generation cannot be replaced with different content.");
          }
        }
      }
      const key = journalEntryKey(entry);
      for (const candidate of existing) {
        if (candidate.authorScope === entry.authorScope && candidate.state === "draft" && candidate.key !== key) {
          store.delete(candidate.key);
        }
      }
      store.put({ ...entry, key, updatedAt: Date.now() });
      await done;
      return true;
    } catch (error) {
      if (error instanceof JournalError) throw error;
      throw storageMessage(error, "draft");
    }
  }

  async getDocument(projectId: string, path: string, authorScope: string): Promise<JournalEntry[]> {
    const key = documentKey(projectId, path);
    try {
      const transaction = this.database.transaction(ENTRY_STORE, "readonly");
      const done = transactionDone(transaction);
      const records = await requestValue(transaction.objectStore(ENTRY_STORE).index("documentKey").getAll(key)) as JournalEntry[];
      await done;
      return records
        .filter((entry) => entry.version === 1 && entry.documentKey === key && entry.authorScope === authorScope)
        .sort((left, right) => left.operation.generation - right.operation.generation || left.updatedAt - right.updatedAt);
    } catch (error) {
      throw storageMessage(error, "recovery journal");
    }
  }

  async getProject(projectId: string, authorScope: string): Promise<JournalEntry[]> {
    const key = projectKey(projectId);
    try {
      const transaction = this.database.transaction(ENTRY_STORE, "readonly");
      const done = transactionDone(transaction);
      const records = await requestValue(transaction.objectStore(ENTRY_STORE).index("projectKey").getAll(key)) as JournalEntry[];
      await done;
      return records
        .filter((entry) => entry.version === 1 && entry.projectKey === key && entry.authorScope === authorScope)
        .sort((left, right) => left.updatedAt - right.updatedAt);
    } catch (error) {
      throw storageMessage(error, "recovery journal");
    }
  }

  async getAllEntries(): Promise<JournalEntry[]> {
    try {
      const transaction = this.database.transaction(ENTRY_STORE, "readonly");
      const done = transactionDone(transaction);
      const entries = await requestValue(transaction.objectStore(ENTRY_STORE).getAll()) as JournalEntry[];
      await done;
      return entries
        .filter((entry) => entry.version === 1)
        .map((entry) => ({ ...entry, authorScope: typeof entry.authorScope === "string" && entry.authorScope.length > 0 ? entry.authorScope : null }));
    } catch (error) {
      throw storageMessage(error, "recovery journal");
    }
  }

  /** Return an ownership token only when this call inserted a new proposal record. */
  async putProposal(
    projectId: string,
    authorScope: string,
    proposal: ChangeProposal,
    status?: ProposalStatus,
  ): Promise<JournalProposalOwnership | null> {
    if (!authorScope) throw new JournalError("The proposal has no author identity scope.");
    if (!proposal || !/^[A-Za-z0-9_-]{1,128}$/u.test(proposal.id) || !Array.isArray(proposal.operations) || !proposal.operations.length ||
        !["author", "module", "mcp"].includes(proposal.source) || projectKey(proposal.snapshot.projectId) !== projectKey(projectId)) {
      throw new JournalError("The proposal has an invalid identity or belongs to a different projectId.");
    }
    for (const operation of proposal.operations) {
      assertChangeOperation(operation);
      if (projectKey(operation.projectId) !== projectKey(projectId) || operation.baseProjectVersion !== proposal.snapshot.projectVersion) {
        throw new JournalError("The proposal contains an operation for a different projectId snapshot.");
      }
    }
    if (status) {
      const statusProposal = status.proposal;
      if (!statusProposal || statusProposal.id !== proposal.id || projectKey(statusProposal.snapshot.projectId) !== projectKey(projectId) ||
          statusProposal.snapshot.projectVersion !== proposal.snapshot.projectVersion || statusProposal.source !== proposal.source ||
          !Array.isArray(statusProposal.operations) || !statusProposal.operations.length) {
        throw new JournalError("The review status does not match the journaled proposal identity.");
      }
      if (status.payloadComplete === false) {
        if (!/^[a-f0-9]{64}$/u.test(status.originalDigest ?? "") || !Array.isArray(status.operationIds) ||
            status.operationIds.length < statusProposal.operations.length || new Set(status.operationIds).size !== status.operationIds.length ||
            !statusProposal.operations.every((operation) => status.operationIds!.includes(operation.id))) {
          throw new JournalError("The partial review status is missing its original proposal binding.");
        }
        for (const operation of statusProposal.operations) {
          assertChangeOperation(operation);
          if (projectKey(operation.projectId) !== projectKey(projectId) || operation.baseProjectVersion !== proposal.snapshot.projectVersion) {
            throw new JournalError("The partial review status contains an operation for a different projectId snapshot.");
          }
        }
      } else if (stableJson(statusProposal) !== stableJson(proposal)) {
        throw new JournalError("The review status does not contain the complete journaled proposal.");
      }
    }
    const owner = projectKey(projectId);
    const record: JournalProposal = {
      key: JSON.stringify([owner, authorScope, proposal.id]),
      projectKey: owner,
      authorScope,
      projectId,
      proposal,
      ownershipToken: crypto.randomUUID(),
      ...(status ? { status } : {}),
      createdAt: Date.now(),
    };
    try {
      const transaction = this.database.transaction(PROPOSAL_STORE, "readwrite", { durability: "strict" });
      const done = transactionDone(transaction);
      const store = transaction.objectStore(PROPOSAL_STORE);
      const existing = await requestValue(store.get(record.key)) as JournalProposal | undefined;
      if (existing && (existing.authorScope !== authorScope || existing.projectKey !== owner)) {
        await done;
        throw new JournalError("A proposal ID cannot be reused for a different author, projectId, or payload.");
      }
      if (existing && status?.payloadComplete === false && status.proposal.operations.some((operation) =>
          !existing.proposal.operations.some((candidate) => candidate.id === operation.id && stableJson(candidate) === stableJson(operation)))) {
        await done;
        throw new JournalError("The partial status changed an immutable proposal operation payload.");
      }
      const existingWasPartial = existing?.status?.payloadComplete === false;
      const retryRestoredOriginal = Boolean(existing && existingWasPartial && status?.payloadComplete !== false &&
        JSON.stringify(proposal.operations.map((operation) => operation.id)) === JSON.stringify(existing.status?.operationIds) &&
        stableJson(status?.proposal) === stableJson(proposal));
      if (existingWasPartial && status?.payloadComplete === false &&
          (existing!.status?.originalDigest !== status.originalDigest ||
            JSON.stringify(existing!.status?.operationIds) !== JSON.stringify(status.operationIds))) {
        await done;
        throw new JournalError("The partial proposal's immutable original binding changed.");
      }
      if (existing && stableJson(existing.proposal) !== stableJson(proposal) &&
          !(status?.payloadComplete === false || retryRestoredOriginal)) {
        await done;
        throw new JournalError("A proposal ID cannot be reused for a different author, projectId, or payload.");
      }
      // A partial server recovery is only the accepted subset. Never let it replace a complete
      // browser copy; retain that private payload while updating the server review status.
      const keepCompletePrivatePayload = Boolean(existing && status?.payloadComplete === false && !existingWasPartial);
      const effectiveProposal = keepCompletePrivatePayload
        ? existing!.proposal
        : existingWasPartial && status?.payloadComplete === false
          ? {
            ...proposal,
            operations: status.operationIds!.flatMap((id) => {
              const known = existing!.proposal.operations.find((operation) => operation.id === id);
              const latest = proposal.operations.find((operation) => operation.id === id);
              return known ? [known] : latest ? [latest] : [];
            }),
            ...(existing!.proposal.evidence ? { evidence: existing!.proposal.evidence } : {}),
          }
          : proposal;
      const updated: JournalProposal = existing
        ? {
          ...existing,
          proposal: effectiveProposal,
          ...(status ? { status } : {}),
          ...(status && (status.approvedOperationIds.length > 0 || status.applications.length > 0 || status.appliedOperationIds.length > 0)
            ? { dismissedAt: undefined }
            : {}),
          createdAt: existing.createdAt,
        }
        : record;
      const inserted = !existing;
      if (inserted || (status && stableJson(existing.status) !== stableJson(status))) store.put(updated);
      await done;
      return inserted ? { token: record.ownershipToken!, proposal } : null;
    } catch (error) {
      if (error instanceof JournalError) throw error;
      throw storageMessage(error, "module proposal");
    }
  }

  async getProposals(projectId: string, authorScope: string): Promise<JournalProposal[]> {
    const key = projectKey(projectId);
    try {
      const transaction = this.database.transaction(PROPOSAL_STORE, "readonly");
      const done = transactionDone(transaction);
      const records = await requestValue(transaction.objectStore(PROPOSAL_STORE).index("projectKey").getAll(key)) as JournalProposal[];
      await done;
      return records.filter((record) => record.projectKey === key && record.authorScope === authorScope && record.dismissedAt === undefined).sort((left, right) => left.createdAt - right.createdAt);
    } catch (error) {
      throw storageMessage(error, "module proposal");
    }
  }

  async dismissProposal(projectId: string, authorScope: string, proposalId: string): Promise<void> {
    const key = JSON.stringify([projectKey(projectId), authorScope, proposalId]);
    try {
      const transaction = this.database.transaction(PROPOSAL_STORE, "readwrite", { durability: "strict" });
      const done = transactionDone(transaction);
      const store = transaction.objectStore(PROPOSAL_STORE);
      const record = await requestValue(store.get(key)) as JournalProposal | undefined;
      if (!record || record.authorScope !== authorScope || record.projectKey !== projectKey(projectId)) {
        await done;
        throw new JournalError("The exact proposal is no longer in this author recovery journal.");
      }
      store.put({ ...record, dismissedAt: Date.now() });
      await done;
    } catch (error) {
      if (error instanceof JournalError) throw error;
      throw storageMessage(error, "module proposal");
    }
  }

  async getAllProposals(): Promise<JournalProposal[]> {
    try {
      const transaction = this.database.transaction(PROPOSAL_STORE, "readonly");
      const done = transactionDone(transaction);
      const records = await requestValue(transaction.objectStore(PROPOSAL_STORE).getAll()) as JournalProposal[];
      await done;
      return records.map((record) => ({
        ...record,
        authorScope: typeof record.authorScope === "string" && record.authorScope.length > 0 ? record.authorScope : null,
      }));
    } catch (error) {
      throw storageMessage(error, "module proposal");
    }
  }

  async removeProposal(
    projectId: string,
    authorScope: string,
    proposalId: string,
    ownership?: JournalProposalOwnership,
  ): Promise<boolean> {
    try {
      const transaction = this.database.transaction(PROPOSAL_STORE, "readwrite", { durability: "strict" });
      const done = transactionDone(transaction);
      const key = JSON.stringify([projectKey(projectId), authorScope, proposalId]);
      const store = transaction.objectStore(PROPOSAL_STORE);
      if (ownership) {
        const existing = await requestValue(store.get(key)) as JournalProposal | undefined;
        if (!existing || existing.projectKey !== projectKey(projectId) || existing.authorScope !== authorScope ||
            ownership.proposal.id !== proposalId || existing.ownershipToken !== ownership.token ||
            stableJson(existing.proposal) !== stableJson(ownership.proposal) || existing.status !== undefined ||
            existing.dismissedAt !== undefined) {
          await done;
          return false;
        }
      }
      store.delete(key);
      await done;
      return true;
    } catch (error) {
      throw storageMessage(error, "module proposal");
    }
  }

  async updateState(
    entry: JournalEntry,
    state: JournalState,
    receipt?: ApplyReceipt,
  ): Promise<JournalEntry> {
    if (!entry.authorScope) throw new JournalError("The recovery record has no author identity scope.");
    assertJournalEntry(entry);
    if (receipt) assertApplicationReceipt(receipt, entry.operation);
    const key = journalEntryKey(entry);
    try {
      const transaction = this.database.transaction(ENTRY_STORE, "readwrite", { durability: "strict" });
      const done = transactionDone(transaction);
      const store = transaction.objectStore(ENTRY_STORE);
      const existing = await requestValue(store.get(key)) as JournalEntry | undefined;
      if (!existing || existing.authorScope !== entry.authorScope ||
          existing.operation.id !== entry.operation.id || existing.operation.generation !== entry.operation.generation ||
          JSON.stringify(existing.operation) !== JSON.stringify(entry.operation)) {
        await done;
        throw new JournalError("The exact journal operation was not found; refusing a stale state update.");
      }
      const rank: Record<JournalState, number> = { draft: 0, applying: 1, applied: 2, conflict: 4 };
      const nextState = rank[state] >= rank[existing.state] ? state : existing.state;
      const updated: JournalEntry = {
        ...existing,
        ...(entry.proposalId ? { proposalId: entry.proposalId } : {}),
        ...(entry.authorizedAt ? { authorizedAt: entry.authorizedAt } : {}),
        state: nextState,
        ...(receipt && nextState === "applied" ? { application: receipt } : {}),
        updatedAt: Date.now(),
      };
      store.put(updated);
      await done;
      return updated;
    } catch (error) {
      if (error instanceof JournalError) throw error;
      throw storageMessage(error, "draft state");
    }
  }

  async removeEntry(entry: JournalEntry): Promise<void> {
    try {
      const transaction = this.database.transaction(ENTRY_STORE, "readwrite", { durability: "strict" });
      const done = transactionDone(transaction);
      transaction.objectStore(ENTRY_STORE).delete(journalEntryKey(entry));
      if (entry.key && entry.key !== journalEntryKey(entry)) transaction.objectStore(ENTRY_STORE).delete(entry.key);
      await done;
    } catch (error) {
      throw storageMessage(error, "draft");
    }
  }

  /** Retain the exact durable receipt and retire only its scoped, authorized generation. */
  async acknowledgeApplication(projectId: string, authorScope: string, receipt: ApplyReceipt): Promise<number> {
    const owner = projectKey(projectId);
    if (!authorScope) throw new JournalError("The application receipt has no author scope.");
    try {
      const transaction = this.database.transaction([ENTRY_STORE, APPLICATION_STORE], "readwrite", { durability: "strict" });
      const done = transactionDone(transaction);
      const store = transaction.objectStore(ENTRY_STORE);
      const entries = await requestValue(store.index("projectKey").getAll(owner)) as JournalEntry[];
      const matches = entries.filter((entry) => entry.projectId === projectId && entry.authorScope === authorScope &&
        entry.operation.id === receipt.operationId && entry.operation.generation === receipt.generation &&
        entry.state !== "draft" && entry.state !== "conflict");
      for (const entry of matches) assertApplicationReceipt(receipt, entry.operation);
      if (matches.length) {
        transaction.objectStore(APPLICATION_STORE).put({
          key: JSON.stringify([projectId, authorScope, receipt.operationId, receipt.generation]),
          projectId, authorScope, receipt,
        });
        for (const entry of matches) store.delete(entry.key);
      }
      await done;
      return matches.length;
    } catch (error) {
      if (error instanceof JournalError) throw error;
      throw storageMessage(error, "application receipt");
    }
  }

  async getApplicationReceipts(projectId: string, authorScope: string): Promise<ApplyReceipt[]> {
    projectKey(projectId);
    if (!authorScope) throw new JournalError("The application receipt has no author scope.");
    try {
      const transaction = this.database.transaction(APPLICATION_STORE, "readonly");
      const done = transactionDone(transaction);
      const records = await requestValue(transaction.objectStore(APPLICATION_STORE).getAll()) as
        { projectId: string; authorScope: string; receipt: ApplyReceipt }[];
      await done;
      return records.filter((record) => record.projectId === projectId && record.authorScope === authorScope)
        .map((record) => record.receipt);
    } catch (error) {
      throw storageMessage(error, "application receipt");
    }
  }

  async removeDrafts(projectId: string, path: string, authorScope: string): Promise<number> {
    const entries = await this.getDocument(projectId, path, authorScope);
    const drafts = entries.filter((entry) => entry.state === "draft");
    try {
      const transaction = this.database.transaction(ENTRY_STORE, "readwrite", { durability: "strict" });
      const done = transactionDone(transaction);
      const store = transaction.objectStore(ENTRY_STORE);
      for (const entry of drafts) store.delete(entry.key);
      await done;
      return drafts.length;
    } catch (error) {
      throw storageMessage(error, "draft");
    }
  }

  async getScratch(projectId: string, path: string, authorScope: string): Promise<string> {
    if (!authorScope) throw new JournalError("The scratch note has no author identity scope.");
    const key = JSON.stringify([documentKey(projectId, path), authorScope]);
    try {
      const transaction = this.database.transaction(SCRATCH_STORE, "readonly");
      const done = transactionDone(transaction);
      const record = await requestValue(transaction.objectStore(SCRATCH_STORE).get(key)) as ScratchRecord | undefined;
      await done;
      return record?.text ?? "";
    } catch (error) {
      throw storageMessage(error, "scratch note");
    }
  }

  async putScratch(projectId: string, path: string, text: string, authorScope: string): Promise<void> {
    if (!authorScope) throw new JournalError("The scratch note has no author identity scope.");
    const record: ScratchRecord = { key: JSON.stringify([documentKey(projectId, path), authorScope]), text, updatedAt: Date.now() };
    try {
      const transaction = this.database.transaction(SCRATCH_STORE, "readwrite", { durability: "strict" });
      const done = transactionDone(transaction);
      transaction.objectStore(SCRATCH_STORE).put(record);
      await done;
    } catch (error) {
      throw storageMessage(error, "scratch note");
    }
  }
}

export async function requestPersistentStorage(): Promise<boolean | null> {
  if (!navigator.storage?.persist) return null;
  try {
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}
