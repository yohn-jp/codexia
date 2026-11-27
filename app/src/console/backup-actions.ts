import { useActorRef, useSelector } from '@xstate/react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { ApiError } from '../api-error';
import { authClient } from '../auth-client';
import { type BackupOperation, backupConsoleClient, backupId } from './backup-client';
import { type BackupCommand, type BackupObservation, backupWorkflowMachine, isBackupConnectionError } from './backup-workflow';
import { checkOwnerSession, type OwnerSessionState } from './console-session';

const requestIdentity = z.object({
  requestId: backupId,
  resultId: backupId.optional(),
});
const configIdentity = requestIdentity.extend({ revision: z.number().int().positive() });
const pendingAction = z.discriminatedUnion('kind', [
  configIdentity.extend({ kind: z.literal('probe') }),
  configIdentity.extend({ kind: z.literal('activate'), probeId: backupId }),
  configIdentity.extend({ kind: z.literal('disable') }),
  requestIdentity.extend({ kind: z.literal('manual'), maintenanceWindowId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/u) }),
]);
export type PendingBackupAction = z.infer<typeof pendingAction>;
type Kind = PendingBackupAction['kind'];
type Input<T> = T extends PendingBackupAction ? Omit<T, 'requestId' | 'resultId'> : never;

function actionKey(kind: Kind) {
  return 'codexia:backup-console:' + kind;
}

export function readBackupAction(kind: Kind): PendingBackupAction | null {
  try {
    const value = pendingAction.safeParse(JSON.parse(sessionStorage.getItem(actionKey(kind)) ?? 'null'));
    return value.success && value.data.kind === kind ? value.data : null;
  } catch {
    return null;
  }
}

function writeBackupAction(action: PendingBackupAction) {
  sessionStorage.setItem(actionKey(action.kind), JSON.stringify(action));
}

export function beginBackupAction(input: Input<PendingBackupAction>) {
  return { ...input, requestId: crypto.randomUUID() } satisfies PendingBackupAction;
}

export class BackupPasskeyError extends Error {
  constructor() {
    super('Passkey confirmation did not complete');
  }
}

interface OwnerPasskeyProof {
  readToken(): Promise<string | null>;
  signIn(): Promise<void>;
  confirm(): Promise<OwnerSessionState>;
}

const browserPasskeyProof: OwnerPasskeyProof = {
  async readToken() {
    const result = await authClient.getSession();
    if (result.error) throw new BackupPasskeyError();
    return result.data?.session.token ?? null;
  },
  async signIn() {
    const result = await authClient.signIn.passkey();
    if (result.error) throw new BackupPasskeyError();
  },
  confirm: checkOwnerSession,
};

export async function requireFreshBackupOwner(proof = browserPasskeyProof) {
  try {
    const previous = await proof.readToken();
    await proof.signIn();
    const current = await proof.readToken();
    if (!current || current === previous || (await proof.confirm()) !== 'owner') throw new BackupPasskeyError();
  } catch {
    throw new BackupPasskeyError();
  }
}

export async function readConfigOperation(action: PendingBackupAction, signal?: AbortSignal): Promise<BackupOperation> {
  if (action.kind === 'manual') throw new TypeError('Manual backup is read through run history');
  const operation =
    action.kind === 'probe' && action.resultId
      ? await backupConsoleClient.probe(action.resultId, signal)
      : (await backupConsoleClient.status(action.requestId, signal)).operation;
  if (
    !operation ||
    operation.requestId !== action.requestId ||
    (action.resultId && operation.operationId !== action.resultId) ||
    operation.revision !== action.revision ||
    operation.phase !== action.kind
  ) {
    throw new ApiError('Invalid backup operation receipt', 502, 'INVALID_RESPONSE');
  }
  if (action.kind === 'probe' && !action.resultId) {
    const recovered = { ...action, resultId: operation.operationId };
    writeBackupAction(recovered);
    return readConfigOperation(recovered, signal);
  }
  return operation;
}

/** Remember only identities needed for reconciliation before any write can leave the browser. */
export async function submitBackupAction(action: PendingBackupAction) {
  writeBackupAction(action);
  if (action.kind !== 'probe') await requireFreshBackupOwner();
  let resultId: string;
  try {
    if (action.kind === 'probe') {
      resultId = (await backupConsoleClient.probeRequest(action.revision, action.requestId)).probeId;
    } else if (action.kind === 'activate') {
      resultId = (await backupConsoleClient.activate(action.revision, action.probeId, action.requestId)).operationId;
    } else if (action.kind === 'disable') {
      resultId = (await backupConsoleClient.disable(action.revision, action.requestId)).operationId;
    } else {
      resultId = (await backupConsoleClient.runRequest(action.maintenanceWindowId, action.requestId)).runId;
    }
    if (!backupId.safeParse(resultId).success || (action.resultId && action.resultId !== resultId)) {
      throw new ApiError('Invalid backup request receipt', 502, 'INVALID_RESPONSE');
    }
  } catch (error) {
    // These are definitive refusals of this request from the backup API.
    // Connection errors and an unavailable control plane preserve the key.
    if (error instanceof ApiError && [409, 412, 422].includes(error.status) && !action.resultId) {
      sessionStorage.removeItem(actionKey(action.kind));
    }
    throw error;
  }
  const accepted = { ...action, resultId };
  writeBackupAction(accepted);
  return accepted;
}

type ReadState<T> = { state: 'loading' } | { state: 'ready'; value: T } | { state: 'error'; error: unknown };

export function backupObservation(
  action: PendingBackupAction | null | undefined,
  result: { status: Exclude<BackupObservation['status'], 'ABSENT' | 'UNREACHABLE'> } | null | undefined,
  error: unknown,
): BackupObservation | undefined {
  if (!action) return undefined;
  const command = { kind: action.kind, requestId: action.requestId };
  if (result) return { command, status: result.status };
  if (error instanceof ApiError && error.status === 404) return { command, status: 'ABSENT' };
  if (isBackupConnectionError(error)) return { command, status: 'UNREACHABLE' };
  return undefined;
}

export function useBackupWorkflow(read?: ReadState<unknown>, observations: readonly (BackupObservation | undefined)[] = []) {
  const actor = useActorRef(backupWorkflowMachine);
  const current = useSelector(actor, snapshot => snapshot);
  const tracked = current.context.command;
  const observation = tracked
    ? observations.find(
        item => item && 'requestId' in tracked && tracked.kind === item.command.kind && tracked.requestId === item.command.requestId,
      )
    : (observations.find(item => item && ['QUEUED', 'RUNNING', 'UNKNOWN', 'UNREACHABLE', 'ABSENT'].includes(item.status)) ??
      observations.find(item => item !== undefined));
  const kind = observation?.command.kind;
  const requestId = observation?.command.requestId;
  const status = observation?.status;
  useEffect(() => {
    if (read?.state === 'loading') actor.send({ type: 'RECHECK' });
    if (read?.state === 'error' && isBackupConnectionError(read.error)) actor.send({ type: 'DISCONNECTED' });
    if (read?.state === 'ready') {
      if (kind && requestId && status) actor.send({ type: 'OBSERVED', command: { kind, requestId }, status });
      actor.send({ type: 'CURRENT_READ' });
    }
  }, [actor, kind, read, requestId, status]);

  return {
    busy: current.matches('submitting'),
    error: current.context.error,
    state: current.value,
    canStart: (kind: BackupCommand['kind'], pending?: PendingBackupAction | null) =>
      current.can({ type: 'START', command: kind === 'draft' ? { kind } : { kind, requestId: pending?.requestId ?? '' } }),
    reviewCurrent: () => actor.send({ type: 'REVIEW_CURRENT' }),
    async submit(command: BackupCommand, send: () => Promise<unknown>) {
      // The draft data, including write-only credentials, stays in the event handler.
      // The feature actor retains only command identity and server observations.
      const event = { type: 'START', command } as const;
      if (!actor.getSnapshot().can(event)) return;
      actor.send(event);
      try {
        await send();
        actor.send({ type: 'ACKNOWLEDGED' });
      } catch (error) {
        actor.send({ type: 'FAILED', error });
      }
    },
  };
}

export function useBackupRead<T>(load: (signal: AbortSignal) => Promise<T>, recheckOnline = true) {
  const [read, setRead] = useState<ReadState<T>>({ state: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const controller = useRef<AbortController | null>(null);
  const refresh = useCallback(() => {
    controller.current?.abort();
    setAttempt(previous => previous + 1);
  }, []);
  useEffect(() => {
    if (!recheckOnline) return;
    window.addEventListener('online', refresh);
    return () => window.removeEventListener('online', refresh);
  }, [recheckOnline, refresh]);
  useEffect(() => {
    const current = new AbortController();
    controller.current = current;
    setRead({ state: 'loading' });
    void load(current.signal).then(
      value => {
        if (!current.signal.aborted) setRead({ state: 'ready', value });
      },
      error => {
        if (!current.signal.aborted) setRead({ state: 'error', error });
      },
    );
    return () => current.abort();
  }, [attempt, load]);
  return { read, refresh };
}
