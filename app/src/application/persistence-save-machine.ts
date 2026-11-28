import { assign, fromPromise, setup } from 'xstate';

export interface PersistenceSaveIdentity {
  projectId: string;
  documentId: string;
}

export interface PersistenceSaveMachineInput {
  identity: PersistenceSaveIdentity;
}

export interface PersistenceSaveMachineServices {
  protectDraft(
    input: { identity: PersistenceSaveIdentity; generation: number; dirty: boolean },
    signal: AbortSignal,
  ): Promise<'protected' | 'other-tab'>;
  saveOperation(
    input: { identity: PersistenceSaveIdentity; operationId: string; generation: number; reconcileReplay: boolean },
    signal: AbortSignal,
  ): Promise<
    | { kind: 'confirmed'; operationId: string; generation: number; receiptId: string }
    | { kind: 'conflict'; operationId: string; generation: number }
    | { kind: 'unknown'; operationId: string; generation: number }
  >;
}

type RecoveryKind = 'clean' | 'draft' | 'pending-save';

type SaveOperationOutcome =
  | { kind: 'confirmed'; identity: PersistenceSaveIdentity; operationId: string; generation: number; receiptId: string }
  | { kind: 'conflict'; identity: PersistenceSaveIdentity; operationId: string; generation: number }
  | { kind: 'unknown'; identity: PersistenceSaveIdentity; operationId: string; generation: number };

interface PersistenceSaveMachineContext {
  identity: PersistenceSaveIdentity;
  generation: number;
  dirty: boolean;
  remoteConflict: boolean;
  protectedIdentity: PersistenceSaveIdentity | null;
  protectedGeneration: number | null;
  operationIdentity: PersistenceSaveIdentity | null;
  operationId: string | null;
  operationGeneration: number | null;
  reconcileReplay: boolean;
  receiptId: string | null;
  receiptGeneration: number | null;
  error: string;
  navigationRequestId: string | null;
}

type PersistenceSaveMachineEvent =
  | {
      type: 'RECOVERY.READY';
      identity: PersistenceSaveIdentity;
      recovery: RecoveryKind;
      generation: number;
      draftProtected?: boolean;
      remoteConflict?: boolean;
      operationId?: string;
      operationGeneration?: number;
    }
  | { type: 'DRAFT.CHANGED'; identity?: PersistenceSaveIdentity; generation: number; dirty: boolean }
  | { type: 'DRAFT.PROTECTED'; identity?: PersistenceSaveIdentity; generation: number; dirty: boolean }
  | { type: 'DRAFT.FAILED'; identity?: PersistenceSaveIdentity; generation: number; message?: string }
  | { type: 'DRAFT.OTHER_TAB'; identity?: PersistenceSaveIdentity; generation: number }
  | { type: 'SAVE.MANUAL'; identity?: PersistenceSaveIdentity; operationId?: string; generation?: number; reconcileReplay?: boolean }
  | { type: 'SAVE.RETRY' }
  | { type: 'SAVE.CONFLICT.OBSERVED'; identity: PersistenceSaveIdentity }
  | { type: 'SAVE.CONFLICT.RESOLVED' }
  | { type: 'NAVIGATION.REQUESTED'; requestId: string }
  | { type: 'NAVIGATION.BLOCKED'; requestId: string }
  | { type: 'NAVIGATION.ALLOWED'; requestId: string };

function sameIdentity(left: PersistenceSaveIdentity | null | undefined, right: PersistenceSaveIdentity | null | undefined): boolean {
  return Boolean(left && right && left.projectId === right.projectId && left.documentId === right.documentId);
}

function conflictStatus(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === 'object' &&
      'status' in error &&
      ((error as { status?: unknown }).status === 409 || (error as { status?: unknown }).status === 412),
  );
}

function generatedOperationId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `save-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function matchesOperation(context: PersistenceSaveMachineContext, outcome: SaveOperationOutcome): boolean {
  return (
    sameIdentity(context.operationIdentity, outcome.identity) &&
    context.operationId === outcome.operationId &&
    context.operationGeneration === outcome.generation
  );
}

function outcomeIsCurrent(context: PersistenceSaveMachineContext, outcome: SaveOperationOutcome): boolean {
  return sameIdentity(context.identity, outcome.identity) && matchesOperation(context, outcome);
}

/**
 * Executable WRT-01 / REC-01 coordination. IndexedDB and PostgreSQL remain the
 * authorities; this actor holds only the current identity, generations,
 * operation identity, and observed receipt.
 */
export function createPersistenceSaveMachine(services: PersistenceSaveMachineServices) {
  return setup({
    types: {
      context: {} as PersistenceSaveMachineContext,
      events: {} as PersistenceSaveMachineEvent,
      input: {} as PersistenceSaveMachineInput,
    },
    actors: {
      protectDraft: fromPromise(
        async ({
          input,
          signal,
        }: {
          input: { identity: PersistenceSaveIdentity; generation: number; dirty: boolean };
          signal: AbortSignal;
        }) => services.protectDraft(input, signal),
      ),
      saveOperation: fromPromise(
        async ({
          input,
          signal,
        }: {
          input: { identity: PersistenceSaveIdentity; operationId: string; generation: number; reconcileReplay: boolean };
          signal: AbortSignal;
        }): Promise<SaveOperationOutcome> => {
          try {
            const result = await services.saveOperation(input, signal);
            return { ...result, identity: input.identity, operationId: input.operationId, generation: input.generation };
          } catch (error) {
            return {
              kind: conflictStatus(error) ? 'conflict' : 'unknown',
              identity: input.identity,
              operationId: input.operationId,
              generation: input.generation,
            };
          }
        },
      ),
    },
    guards: {
      readyDraftProtected: ({ event }) => event.type === 'RECOVERY.READY' && (event.recovery === 'clean' || event.draftProtected === true),
      readyNeedsProtection: ({ event }) => event.type === 'RECOVERY.READY' && event.recovery === 'draft' && event.draftProtected !== true,
      matchingIdentity: ({ context, event }) => !('identity' in event) || !event.identity || sameIdentity(context.identity, event.identity),
      recoveredConflict: ({ event }) => event.type === 'RECOVERY.READY' && event.remoteConflict === true,
      canSaveCurrentGeneration: ({ context, event }) =>
        event.type === 'SAVE.MANUAL' &&
        sameIdentity(context.identity, event.identity ?? context.identity) &&
        context.dirty &&
        !context.remoteConflict &&
        sameIdentity(context.protectedIdentity, event.identity ?? context.identity) &&
        context.protectedGeneration === (event.generation ?? context.generation),
      hasPendingOperation: ({ context }) =>
        Boolean(context.operationIdentity && context.operationId && context.operationGeneration !== null),
    },
    actions: {
      acceptReady: assign(({ context, event }) =>
        event.type === 'RECOVERY.READY'
          ? {
              identity: event.identity,
              generation: event.generation,
              dirty: event.recovery !== 'clean',
              remoteConflict: event.remoteConflict ?? false,
              protectedIdentity: event.recovery === 'clean' || event.draftProtected ? event.identity : context.protectedIdentity,
              protectedGeneration: event.recovery === 'clean' || event.draftProtected ? event.generation : context.protectedGeneration,
              operationIdentity: event.recovery === 'pending-save' && event.operationId ? event.identity : context.operationIdentity,
              operationId: event.recovery === 'pending-save' ? (event.operationId ?? context.operationId) : context.operationId,
              operationGeneration:
                event.recovery === 'pending-save' ? (event.operationGeneration ?? event.generation) : context.operationGeneration,
              reconcileReplay: event.recovery === 'pending-save' || context.reconcileReplay,
              error: '',
            }
          : {},
      ),
      acceptDraftChange: assign(({ context, event }) =>
        event.type === 'DRAFT.CHANGED'
          ? {
              identity: event.identity ?? context.identity,
              generation: event.generation,
              dirty: event.dirty,
              remoteConflict: context.remoteConflict,
              error: '',
            }
          : {},
      ),
      markDraftProtected: assign(({ context, event }) =>
        event.type === 'DRAFT.PROTECTED'
          ? {
              identity: event.identity ?? context.identity,
              generation: event.generation,
              dirty: event.dirty,
              protectedIdentity: event.identity ?? context.identity,
              protectedGeneration: event.generation,
              error: '',
            }
          : {},
      ),
      markProtectionFailed: assign(({ context, event }) => ({
        error: event.type === 'DRAFT.FAILED' ? (event.message ?? 'IndexedDB protection failed') : context.error,
      })),
      markOtherTab: assign(({ context, event }) => ({
        protectedIdentity: event.type === 'DRAFT.OTHER_TAB' ? (event.identity ?? context.identity) : context.identity,
        protectedGeneration: null,
        error: 'A newer recovery draft belongs to another tab',
      })),
      setManualOperation: assign(({ context, event }) =>
        event.type === 'SAVE.MANUAL'
          ? {
              operationIdentity: event.identity ?? context.identity,
              operationId: event.operationId ?? generatedOperationId(),
              operationGeneration: event.generation ?? context.generation,
              reconcileReplay: event.reconcileReplay ?? false,
              receiptId: null,
              receiptGeneration: null,
              error: '',
            }
          : {},
      ),
      clearSupersededOperation: assign(() => ({
        operationIdentity: null,
        operationId: null,
        operationGeneration: null,
        reconcileReplay: false,
      })),
      clearConflict: assign(() => ({
        error: '',
        remoteConflict: false,
        operationIdentity: null,
        operationId: null,
        operationGeneration: null,
        reconcileReplay: false,
      })),
      observeConflict: assign(({ context, event }) =>
        event.type === 'SAVE.CONFLICT.OBSERVED' && sameIdentity(context.identity, event.identity)
          ? { remoteConflict: true, error: 'PostgreSQL has a newer revision' }
          : {},
      ),
      setNavigationRequest: assign(({ event }) => (event.type === 'NAVIGATION.REQUESTED' ? { navigationRequestId: event.requestId } : {})),
    },
  }).createMachine({
    id: 'persistenceSave',
    initial: 'active',
    context: ({ input }) => ({
      identity: input.identity,
      generation: 0,
      dirty: false,
      remoteConflict: false,
      protectedIdentity: null,
      protectedGeneration: null,
      operationIdentity: null,
      operationId: null,
      operationGeneration: null,
      reconcileReplay: false,
      receiptId: null,
      receiptGeneration: null,
      error: '',
      navigationRequestId: null,
    }),
    states: {
      active: {
        type: 'parallel',
        states: {
          journal: {
            initial: 'unprotected',
            states: {
              unprotected: {
                on: {
                  'RECOVERY.READY': [
                    { guard: 'readyDraftProtected', target: 'protected', actions: 'acceptReady' },
                    { guard: 'readyNeedsProtection', target: 'protecting', actions: 'acceptReady' },
                    { actions: 'acceptReady' },
                  ],
                  'DRAFT.CHANGED': { guard: 'matchingIdentity', target: 'protecting', actions: 'acceptDraftChange' },
                  'DRAFT.PROTECTED': { guard: 'matchingIdentity', target: 'protected', actions: 'markDraftProtected' },
                  'DRAFT.FAILED': { guard: 'matchingIdentity', target: 'failed', actions: 'markProtectionFailed' },
                  'DRAFT.OTHER_TAB': { guard: 'matchingIdentity', target: 'other-tab', actions: 'markOtherTab' },
                },
              },
              protecting: {
                invoke: {
                  src: 'protectDraft',
                  input: ({ context }) => ({ identity: context.identity, generation: context.generation, dirty: context.dirty }),
                  onDone: [
                    {
                      guard: ({ event }) => event.output === 'other-tab',
                      target: 'other-tab',
                      actions: assign(({ context }) => ({
                        protectedIdentity: context.identity,
                        protectedGeneration: null,
                        error: 'A newer recovery draft belongs to another tab',
                      })),
                    },
                    {
                      target: 'protected',
                      actions: assign(({ context }) => ({
                        protectedIdentity: context.identity,
                        protectedGeneration: context.generation,
                        error: '',
                      })),
                    },
                  ],
                  onError: { target: 'failed', actions: assign(({ event }) => ({ error: String(event.error) })) },
                },
                on: {
                  'RECOVERY.READY': [
                    { guard: 'readyDraftProtected', target: 'protected', actions: 'acceptReady' },
                    { guard: 'readyNeedsProtection', target: 'protecting', reenter: true, actions: 'acceptReady' },
                    { target: 'unprotected', actions: 'acceptReady' },
                  ],
                  'DRAFT.CHANGED': { guard: 'matchingIdentity', target: 'protecting', reenter: true, actions: 'acceptDraftChange' },
                  'DRAFT.PROTECTED': { guard: 'matchingIdentity', target: 'protected', actions: 'markDraftProtected' },
                  'DRAFT.FAILED': { guard: 'matchingIdentity', target: 'failed', actions: 'markProtectionFailed' },
                  'DRAFT.OTHER_TAB': { guard: 'matchingIdentity', target: 'other-tab', actions: 'markOtherTab' },
                },
              },
              protected: {
                on: {
                  'RECOVERY.READY': [
                    { guard: 'readyDraftProtected', actions: 'acceptReady' },
                    { guard: 'readyNeedsProtection', target: 'protecting', actions: 'acceptReady' },
                    { target: 'unprotected', actions: 'acceptReady' },
                  ],
                  'DRAFT.CHANGED': { guard: 'matchingIdentity', target: 'protecting', actions: 'acceptDraftChange' },
                  'DRAFT.PROTECTED': { guard: 'matchingIdentity', target: 'protected', actions: 'markDraftProtected' },
                  'DRAFT.FAILED': { guard: 'matchingIdentity', target: 'failed', actions: 'markProtectionFailed' },
                  'DRAFT.OTHER_TAB': { guard: 'matchingIdentity', target: 'other-tab', actions: 'markOtherTab' },
                },
              },
              failed: {
                on: {
                  'RECOVERY.READY': [
                    { guard: 'readyDraftProtected', target: 'protected', actions: 'acceptReady' },
                    { guard: 'readyNeedsProtection', target: 'protecting', actions: 'acceptReady' },
                    { target: 'unprotected', actions: 'acceptReady' },
                  ],
                  'DRAFT.CHANGED': { guard: 'matchingIdentity', target: 'protecting', actions: 'acceptDraftChange' },
                  'DRAFT.PROTECTED': { guard: 'matchingIdentity', target: 'protected', actions: 'markDraftProtected' },
                  'DRAFT.OTHER_TAB': { guard: 'matchingIdentity', target: 'other-tab', actions: 'markOtherTab' },
                  'DRAFT.FAILED': { guard: 'matchingIdentity', actions: 'markProtectionFailed' },
                },
              },
              'other-tab': {
                on: {
                  'RECOVERY.READY': [
                    { guard: 'readyDraftProtected', target: 'protected', actions: 'acceptReady' },
                    { guard: 'readyNeedsProtection', target: 'protecting', actions: 'acceptReady' },
                    { target: 'unprotected', actions: 'acceptReady' },
                  ],
                  'DRAFT.CHANGED': { guard: 'matchingIdentity', actions: 'acceptDraftChange' },
                  'DRAFT.PROTECTED': { guard: 'matchingIdentity', target: 'protected', actions: 'markDraftProtected' },
                  'DRAFT.FAILED': { guard: 'matchingIdentity', target: 'failed', actions: 'markProtectionFailed' },
                  'DRAFT.OTHER_TAB': { guard: 'matchingIdentity', actions: 'markOtherTab' },
                },
              },
            },
          },
          server: {
            initial: 'idle',
            states: {
              idle: {
                on: {
                  'RECOVERY.READY': [
                    {
                      guard: ({ event }) =>
                        event.type === 'RECOVERY.READY' && event.recovery === 'pending-save' && Boolean(event.operationId),
                      target: 'saving',
                      actions: 'acceptReady',
                    },
                    { guard: 'recoveredConflict', target: 'conflict', actions: 'acceptReady' },
                    { actions: 'acceptReady' },
                  ],
                  'SAVE.CONFLICT.OBSERVED': { target: 'conflict', actions: 'observeConflict' },
                  'SAVE.MANUAL': { guard: 'canSaveCurrentGeneration', target: 'saving', actions: 'setManualOperation' },
                },
              },
              saving: {
                invoke: {
                  src: 'saveOperation',
                  input: ({ context }) => ({
                    identity: context.operationIdentity ?? context.identity,
                    operationId: context.operationId ?? generatedOperationId(),
                    generation: context.operationGeneration ?? context.generation,
                    reconcileReplay: context.reconcileReplay,
                  }),
                  onDone: [
                    {
                      guard: ({ context, event }) => outcomeIsCurrent(context, event.output) && event.output.kind === 'confirmed',
                      target: 'confirmed',
                      actions: assign(({ context, event }) =>
                        event.output.kind === 'confirmed'
                          ? {
                              operationIdentity: event.output.identity,
                              operationId: event.output.operationId,
                              operationGeneration: event.output.generation,
                              receiptId: event.output.receiptId,
                              receiptGeneration: event.output.generation,
                              error: '',
                            }
                          : {},
                      ),
                    },
                    {
                      guard: ({ context, event }) => outcomeIsCurrent(context, event.output) && event.output.kind === 'conflict',
                      target: 'conflict',
                      actions: assign(() => ({ error: 'PostgreSQL reported a revision conflict' })),
                    },
                    {
                      guard: ({ context, event }) => outcomeIsCurrent(context, event.output) && event.output.kind === 'unknown',
                      target: 'unknown',
                      actions: assign(() => ({ error: 'Save result is unknown; retry the same operation identity' })),
                    },
                    {
                      guard: ({ context, event }) => context.remoteConflict && matchesOperation(context, event.output),
                      target: 'conflict',
                      actions: 'clearSupersededOperation',
                    },
                    {
                      guard: ({ context, event }) =>
                        Boolean(
                          context.operationIdentity &&
                            context.operationId &&
                            context.operationGeneration !== null &&
                            sameIdentity(context.identity, context.operationIdentity) &&
                            !matchesOperation(context, event.output),
                        ),
                      target: 'saving',
                      reenter: true,
                    },
                    {
                      target: 'idle',
                      actions: assign(({ context, event }) =>
                        matchesOperation(context, event.output)
                          ? { operationIdentity: null, operationId: null, operationGeneration: null, reconcileReplay: false }
                          : {},
                      ),
                    },
                  ],
                },
                on: {
                  'RECOVERY.READY': { actions: 'acceptReady' },
                  'SAVE.CONFLICT.OBSERVED': { actions: 'observeConflict' },
                },
              },
              confirmed: {
                on: {
                  'DRAFT.CHANGED': { target: 'idle', actions: 'acceptDraftChange' },
                  'SAVE.MANUAL': { guard: 'canSaveCurrentGeneration', target: 'saving', actions: 'setManualOperation' },
                  'SAVE.CONFLICT.OBSERVED': { target: 'conflict', actions: 'observeConflict' },
                  'RECOVERY.READY': [
                    {
                      guard: ({ event }) =>
                        event.type === 'RECOVERY.READY' && event.recovery === 'pending-save' && Boolean(event.operationId),
                      target: 'saving',
                      actions: 'acceptReady',
                    },
                    { guard: 'recoveredConflict', target: 'conflict', actions: 'acceptReady' },
                    { target: 'idle', actions: 'acceptReady' },
                  ],
                },
              },
              unknown: {
                on: {
                  'SAVE.RETRY': { guard: 'hasPendingOperation', target: 'saving', actions: assign({ reconcileReplay: true }) },
                  'SAVE.MANUAL': { guard: 'canSaveCurrentGeneration', target: 'saving', actions: 'setManualOperation' },
                  'DRAFT.CHANGED': { actions: 'acceptDraftChange' },
                  'RECOVERY.READY': [
                    {
                      guard: ({ event }) =>
                        event.type === 'RECOVERY.READY' && event.recovery === 'pending-save' && Boolean(event.operationId),
                      target: 'saving',
                      actions: 'acceptReady',
                    },
                    { guard: 'recoveredConflict', target: 'conflict', actions: 'acceptReady' },
                    { target: 'idle', actions: 'acceptReady' },
                  ],
                  'SAVE.CONFLICT.OBSERVED': { actions: 'observeConflict' },
                },
              },
              conflict: {
                on: {
                  'SAVE.CONFLICT.OBSERVED': { actions: 'observeConflict' },
                  'SAVE.CONFLICT.RESOLVED': { target: 'idle', actions: 'clearConflict' },
                  'DRAFT.CHANGED': { actions: 'acceptDraftChange' },
                  'RECOVERY.READY': [
                    {
                      guard: ({ event }) =>
                        event.type === 'RECOVERY.READY' && event.recovery === 'pending-save' && Boolean(event.operationId),
                      target: 'saving',
                      actions: 'acceptReady',
                    },
                    { guard: 'recoveredConflict', target: 'conflict', actions: 'acceptReady' },
                    { target: 'idle', actions: 'acceptReady' },
                  ],
                },
              },
            },
          },
          navigation: {
            initial: 'idle',
            states: {
              idle: { on: { 'NAVIGATION.REQUESTED': { target: 'requested', actions: 'setNavigationRequest' } } },
              requested: {
                on: {
                  'NAVIGATION.BLOCKED': {
                    guard: ({ context, event }) => event.type === 'NAVIGATION.BLOCKED' && event.requestId === context.navigationRequestId,
                    target: 'blocked',
                  },
                  'NAVIGATION.ALLOWED': {
                    guard: ({ context, event }) => event.type === 'NAVIGATION.ALLOWED' && event.requestId === context.navigationRequestId,
                    target: 'allowed',
                  },
                  'NAVIGATION.REQUESTED': { target: 'requested', reenter: true, actions: 'setNavigationRequest' },
                },
              },
              blocked: { on: { 'NAVIGATION.REQUESTED': { target: 'requested', actions: 'setNavigationRequest' } } },
              allowed: { on: { 'NAVIGATION.REQUESTED': { target: 'requested', actions: 'setNavigationRequest' } } },
            },
          },
        },
      },
    },
  });
}
