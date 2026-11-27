import { assign, setup } from 'xstate';
import { ApiError } from '../api-error';
import type { BackupOperation, BackupRun } from './backup-client';

export type BackupRequest = {
  kind: 'probe' | 'activate' | 'disable' | 'manual';
  requestId: string;
};
export type BackupCommand = BackupRequest | { kind: 'draft' };
export type BackupObservation = {
  command: BackupRequest;
  status: BackupOperation['status'] | BackupRun['status'] | 'ABSENT' | 'UNREACHABLE';
};

type BackupEvent =
  | { type: 'START'; command: BackupCommand }
  | { type: 'ACKNOWLEDGED' }
  | { type: 'FAILED'; error: unknown }
  | { type: 'DISCONNECTED' }
  | { type: 'RECHECK' }
  | { type: 'CURRENT_READ' }
  | { type: 'REVIEW_CURRENT' }
  | ({ type: 'OBSERVED' } & BackupObservation);

const sameRequest = (left: BackupCommand | null, right: BackupCommand) =>
  left?.kind === right.kind && 'requestId' in left && 'requestId' in right && left.requestId === right.requestId;

const matchesObservation = (command: BackupCommand | null, event: BackupEvent, statuses: readonly BackupObservation['status'][]) =>
  event.type === 'OBSERVED' && (command === null || sameRequest(command, event.command)) && statuses.includes(event.status);

function confirmedObservation(command: BackupCommand | null, event: BackupEvent) {
  if (event.type !== 'OBSERVED') return false;
  const { kind } = event.command;
  const expected = kind === 'probe' ? 'PASSED' : kind === 'manual' ? 'REMOTE_VERIFIED' : 'APPLIED';
  return matchesObservation(command, event, [expected]);
}

export function isBackupConnectionError(error: unknown) {
  return (
    error instanceof TypeError ||
    (error instanceof ApiError && error.status >= 500) ||
    (error instanceof Error && ['TimeoutError', 'NetworkError', 'AbortError'].includes(error.name))
  );
}

export const backupWorkflowMachine = setup({
  types: {
    context: {} as { command: BackupCommand | null; error: unknown },
    events: {} as BackupEvent,
  },
  actions: {
    remember: assign({
      command: ({ context, event }) => {
        if (event.type !== 'START' && event.type !== 'OBSERVED') return context.command;
        if (event.command.kind === 'draft') return { kind: 'draft' };
        return { kind: event.command.kind, requestId: event.command.requestId };
      },
      error: null,
    }),
    recordFailure: assign({ error: ({ event }) => (event.type === 'FAILED' ? event.error : null) }),
    clear: assign({ command: null, error: null }),
  },
}).createMachine({
  context: { command: null, error: null },
  initial: 'ready',
  on: {
    DISCONNECTED: { target: '.disconnected' },
    OBSERVED: [
      { guard: ({ context, event }) => matchesObservation(context.command, event, ['QUEUED']), target: '.accepted', actions: 'remember' },
      { guard: ({ context, event }) => matchesObservation(context.command, event, ['RUNNING']), target: '.running', actions: 'remember' },
      {
        guard: ({ context, event }) => confirmedObservation(context.command, event),
        target: '.confirmed',
        actions: 'remember',
      },
      { guard: ({ context, event }) => matchesObservation(context.command, event, ['UNKNOWN']), target: '.unknown', actions: 'remember' },
      { guard: ({ context, event }) => matchesObservation(context.command, event, ['ABSENT']), target: '.absent', actions: 'remember' },
      {
        guard: ({ context, event }) => matchesObservation(context.command, event, ['UNREACHABLE']),
        target: '.disconnected',
        actions: 'remember',
      },
      {
        guard: ({ context, event }) => matchesObservation(context.command, event, ['FAILED', 'BLOCKED']),
        target: '.rejected',
        actions: 'remember',
      },
    ],
  },
  states: {
    ready: { on: { START: { target: 'submitting', actions: 'remember' } } },
    submitting: {
      on: {
        DISCONNECTED: {},
        OBSERVED: {},
        ACKNOWLEDGED: [{ guard: ({ context }) => context.command?.kind === 'draft', target: 'confirmed' }, { target: 'accepted' }],
        FAILED: [
          {
            guard: ({ event }) => event.error instanceof ApiError && [409, 412].includes(event.error.status),
            target: 'conflict',
            actions: 'recordFailure',
          },
          {
            guard: ({ event }) => event.error instanceof ApiError && event.error.status === 503,
            target: 'disconnected',
            actions: 'recordFailure',
          },
          { guard: ({ event }) => isBackupConnectionError(event.error), target: 'unknown', actions: 'recordFailure' },
          { target: 'rejected', actions: 'recordFailure' },
        ],
      },
    },
    accepted: { on: { RECHECK: 'rechecking' } },
    running: { on: { RECHECK: 'rechecking' } },
    unknown: {
      on: {
        RECHECK: 'rechecking',
        REVIEW_CURRENT: { guard: ({ context }) => context.command?.kind === 'draft', target: 'ready', actions: 'clear' },
      },
    },
    disconnected: {
      on: {
        RECHECK: 'rechecking',
        REVIEW_CURRENT: { guard: ({ context }) => context.command?.kind === 'draft', target: 'ready', actions: 'clear' },
      },
    },
    rechecking: {
      on: {
        CURRENT_READ: {
          guard: ({ context }) => context.command === null,
          target: 'ready',
          actions: 'clear',
        },
      },
    },
    absent: {
      on: {
        START: {
          guard: ({ context, event }) => sameRequest(context.command, event.command),
          target: 'submitting',
          actions: 'remember',
        },
        RECHECK: 'rechecking',
      },
    },
    conflict: {
      on: {
        CURRENT_READ: { guard: ({ context }) => context.command?.kind !== 'draft', target: 'ready', actions: 'clear' },
        REVIEW_CURRENT: { target: 'ready', actions: 'clear' },
      },
    },
    rejected: { on: { START: { target: 'submitting', actions: 'remember' } } },
    confirmed: { on: { START: { target: 'submitting', actions: 'remember' } } },
  },
});
