import type { DocumentRevision, Document as PersistenceDocument } from '@codexia/persistence-contracts';
import type { PersistenceDraftEntry, PersistenceDraftTextChanges } from '../storage/journal.js';

export interface ActiveDocument<TEvidence = unknown> {
  document: PersistenceDocument;
  revision: DocumentRevision;
  baseRevisionId: string;
  baseMarkdown: string;
  markdown: string;
  textChanges?: PersistenceDraftTextChanges;
  generation: number;
  dirty: boolean;
  requiresExplicitSave?: true;
  recovery: 'pending' | 'stored' | 'failed' | 'other-tab';
  save: 'idle' | 'saving' | 'saved' | 'failed';
  error: string;
  remoteConflict: DocumentRevision | null;
  evidence: TEvidence;
  evidenceLoadKey: number;
}

export interface PendingSaveState {
  baseRevisionId: string;
  baseMarkdown: string;
  markdown: string;
  generation: number;
  idempotencyKey: string;
}

export interface SaveSuccessStateInput<TEvidence = unknown> {
  current: ActiveDocument<TEvidence> | null;
  pending: PendingSaveState;
  acknowledgedDocument: PersistenceDocument;
  acknowledgedRevision: DocumentRevision;
  replayWasSuperseded: boolean;
  journalAcknowledged: boolean;
  remainingDraft: PersistenceDraftEntry | undefined;
}

export type SaveSuccessState<TEvidence = unknown> =
  | { kind: 'publish'; active: ActiveDocument<TEvidence> }
  | { kind: 'superseded' }
  | { kind: 'no-current' };

/** Purely decides the active editor projection after the durable save protocol completes. */
export function resolvePersistenceSaveSuccess<TEvidence>(input: SaveSuccessStateInput<TEvidence>): SaveSuccessState<TEvidence> {
  const { current, pending, acknowledgedDocument, acknowledgedRevision, replayWasSuperseded, journalAcknowledged, remainingDraft } = input;
  if (!current) return { kind: 'no-current' };

  if (!journalAcknowledged) {
    return {
      kind: 'publish',
      active: {
        ...current,
        ...(replayWasSuperseded
          ? { document: acknowledgedDocument, revision: acknowledgedRevision, remoteConflict: acknowledgedRevision }
          : {}),
        recovery: 'failed',
        save: 'failed',
        error: 'PostgreSQLの保存結果を回復Journalへ照合できませんでした。下書きを保持して再確認してください。',
      },
    };
  }

  if (replayWasSuperseded) {
    const hasNewerText = current.generation > pending.generation || current.markdown !== pending.markdown;
    if (!hasNewerText) {
      return {
        kind: 'publish',
        active: {
          ...current,
          document: acknowledgedDocument,
          revision: acknowledgedRevision,
          baseRevisionId: acknowledgedRevision.id,
          baseMarkdown: acknowledgedRevision.markdown,
          markdown: acknowledgedRevision.markdown,
          textChanges: undefined,
          dirty: false,
          requiresExplicitSave: undefined,
          recovery: 'stored',
          save: 'saved',
          error: '',
          remoteConflict: null,
        },
      };
    }
    return {
      kind: 'publish',
      active: {
        ...current,
        document: acknowledgedDocument,
        revision: acknowledgedRevision,
        dirty: true,
        recovery: remainingDraft ? 'stored' : 'pending',
        save: 'failed',
        error: '保存操作の後にPostgreSQL上のRevisionが更新されました。回復Draftを保持し、比較してから適用してください。',
        remoteConflict: acknowledgedRevision,
      },
    };
  }

  const hasNewerText = current.generation > pending.generation || current.markdown !== pending.markdown;
  const ownNewerDraft =
    hasNewerText &&
    remainingDraft !== undefined &&
    remainingDraft.generation === current.generation + 1 &&
    remainingDraft.markdown === current.markdown &&
    remainingDraft.baseRevisionId === acknowledgedRevision.id &&
    remainingDraft.baseMarkdown === pending.markdown;
  if (remainingDraft && !ownNewerDraft) {
    return {
      kind: 'publish',
      active: {
        ...current,
        document: acknowledgedDocument,
        revision: acknowledgedRevision,
        baseRevisionId: acknowledgedRevision.id,
        baseMarkdown: pending.markdown,
        textChanges: undefined,
        dirty: hasNewerText,
        recovery: 'other-tab',
        save: 'failed',
        error: 'この文書のより新しい回復記録が別タブに残っています。自動保存を停止しました。',
        remoteConflict: null,
      },
    };
  }
  return {
    kind: 'publish',
    active: {
      ...current,
      document: acknowledgedDocument,
      revision: acknowledgedRevision,
      baseRevisionId: acknowledgedRevision.id,
      baseMarkdown: pending.markdown,
      textChanges:
        hasNewerText && current.textChanges?.afterSaveKey === pending.idempotencyKey ? { changes: current.textChanges.changes } : undefined,
      dirty: hasNewerText,
      requiresExplicitSave: undefined,
      generation: hasNewerText ? current.generation + 1 : current.generation,
      recovery: hasNewerText ? 'pending' : 'stored',
      save: hasNewerText ? 'idle' : 'saved',
      error: '',
      remoteConflict: null,
    },
  };
}

export function resolvePersistenceSaveConflict<TEvidence>(
  current: ActiveDocument<TEvidence>,
  latestRevision: DocumentRevision | null,
): ActiveDocument<TEvidence> {
  return {
    ...current,
    remoteConflict: latestRevision,
    save: 'failed',
    error: latestRevision
      ? 'PostgreSQL上のRevisionが先に更新されました。下書きはIndexedDBに残しています。'
      : '競合した最新Revisionを確認できません。下書きは保持しています。',
  };
}

export function resolvePersistenceConflictReadFailure<TEvidence>(
  current: ActiveDocument<TEvidence>,
  message: string,
): ActiveDocument<TEvidence> {
  return { ...current, save: 'failed', error: message };
}
