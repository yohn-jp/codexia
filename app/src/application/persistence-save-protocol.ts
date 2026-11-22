import type { EditorEvidenceIdentity, EditorPersistenceSave, EditorPersistenceSaveResult } from "../editor/evidence.js";
import type { PersistenceDraftEntry, PersistenceDraftOperation, PersistenceDraftSaveAcknowledgement } from "../storage/journal.js";
import type { Document as PersistenceDocument, DocumentRevision } from "@codexia/persistence-contracts";

export interface PersistenceSaveRequest extends PersistenceDraftOperation {
  projectId: string;
  documentId: string;
}

export interface PersistenceSaveJournal {
  getPersistenceDraft(projectId: string, documentId: string, authorScope: string): Promise<PersistenceDraftEntry | undefined>;
  bindPersistenceDraftSave(projectId: string, documentId: string, authorScope: string, operation: PersistenceDraftOperation): Promise<boolean>;
  acknowledgePersistenceDraftSave(projectId: string, documentId: string, authorScope: string, operation: PersistenceDraftOperation, revisionId: string, rebaseNewerDraft?: boolean): Promise<PersistenceDraftSaveAcknowledgement>;
  clearPersistenceDraftSave(projectId: string, documentId: string, authorScope: string, operation: PersistenceDraftOperation): Promise<boolean>;
}

export interface PersistenceSaveProtocolInput {
  authorScope: string;
  pending: PersistenceSaveRequest;
  reconcileReplay: boolean;
  journal: PersistenceSaveJournal;
  save(identity: EditorEvidenceIdentity, request: EditorPersistenceSave, signal: AbortSignal): Promise<EditorPersistenceSaveResult | undefined>;
  readHead(projectId: string, documentId: string, signal: AbortSignal): Promise<{ document: PersistenceDocument; revision: DocumentRevision | null }>;
  signal: AbortSignal;
}

export interface PersistenceSaveProtocolResult {
  result: EditorPersistenceSaveResult & { document: PersistenceDocument; revision: DocumentRevision };
  acknowledgedDocument: PersistenceDocument;
  acknowledgedRevision: DocumentRevision;
  replayWasSuperseded: boolean;
  acknowledgement: PersistenceDraftSaveAcknowledgement;
  remainingDraft: PersistenceDraftEntry | undefined;
}

export class PersistenceSaveConflictJournalError extends Error {
  constructor(cause: unknown) {
    super("確定した保存競合を回復Journalへ記録できませんでした。下書きを保持しています。", { cause });
    this.name = "PersistenceSaveConflictJournalError";
  }
}

function isConflict(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "status" in error && (error as { status?: unknown }).status === 409);
}

/** Coordinates the single durable sequence shared by automatic, explicit and replayed saves. */
export async function runPersistenceSaveProtocol(input: PersistenceSaveProtocolInput): Promise<PersistenceSaveProtocolResult> {
  const { pending, authorScope, journal, signal } = input;
  signal.throwIfAborted();
  const operation: PersistenceDraftOperation = {
    baseRevisionId: pending.baseRevisionId,
    baseMarkdown: pending.baseMarkdown,
    markdown: pending.markdown,
    changes: pending.changes,
    generation: pending.generation,
    idempotencyKey: pending.idempotencyKey,
    clientId: pending.clientId,
  };
  const bound = await journal.bindPersistenceDraftSave(pending.projectId, pending.documentId, authorScope, operation);
  if (!bound) throw new Error("送信する保存操作をIndexedDB回復Journalへ確定できませんでした。");

  let result: EditorPersistenceSaveResult | undefined;
  try {
    result = await input.save({
      projectId: pending.projectId,
      documentId: pending.documentId,
      revisionId: pending.baseRevisionId,
      markdown: pending.baseMarkdown,
    }, operation, signal);
  } catch (error) {
    if (isConflict(error)) {
      try {
        await journal.clearPersistenceDraftSave(pending.projectId, pending.documentId, authorScope, operation);
      } catch (journalError) {
        throw new PersistenceSaveConflictJournalError(journalError);
      }
    }
    throw error;
  }
  if (!result || result.markdown !== pending.markdown || !result.document || !result.revision || result.revision.markdown !== pending.markdown ||
      result.document.projectId !== pending.projectId || result.document.id !== pending.documentId ||
      result.revision.projectId !== pending.projectId || result.revision.documentId !== pending.documentId ||
      result.document.headRevisionId !== result.revision.id || result.revision.id !== result.revisionId) {
    throw new Error("PostgreSQLの保存結果を確認できませんでした。");
  }
  const confirmed = result as EditorPersistenceSaveResult & { document: PersistenceDocument; revision: DocumentRevision };
  signal.throwIfAborted();

  const replayHead = input.reconcileReplay ? await input.readHead(pending.projectId, pending.documentId, signal) : undefined;
  if (input.reconcileReplay && (!replayHead?.revision || replayHead.document.projectId !== pending.projectId || replayHead.document.id !== pending.documentId ||
      replayHead.revision.projectId !== pending.projectId || replayHead.revision.documentId !== pending.documentId ||
      replayHead.document.headRevisionId !== replayHead.revision.id ||
      replayHead.revision.id === confirmed.revision.id && replayHead.revision.markdown !== confirmed.revision.markdown)) {
    throw new Error("再送した保存操作の最新Revisionを確認できませんでした。回復下書きは保持しています。");
  }
  const replayWasSuperseded = Boolean(replayHead?.revision && replayHead.revision.id !== confirmed.revision.id);
  const acknowledged = await journal.acknowledgePersistenceDraftSave(
    pending.projectId, pending.documentId, authorScope, operation, confirmed.revision.id, !replayWasSuperseded,
  );
  const remainingDraft = acknowledged.acknowledged
    ? acknowledged.draft
    : await journal.getPersistenceDraft(pending.projectId, pending.documentId, authorScope);
  return {
    result: confirmed,
    acknowledgedDocument: replayWasSuperseded ? replayHead!.document : confirmed.document,
    acknowledgedRevision: replayWasSuperseded ? replayHead!.revision! : confirmed.revision,
    replayWasSuperseded,
    acknowledgement: acknowledged,
    remainingDraft,
  };
}
