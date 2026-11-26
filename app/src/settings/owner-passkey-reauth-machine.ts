import { assign, fromPromise, setup } from 'xstate';

export type OwnerPasskeyReauthenticate = () => Promise<void>;
interface Context {
  readonly reauthenticate: OwnerPasskeyReauthenticate;
  readonly error: unknown;
}

function isCancellation(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const value = error as { name?: unknown; message?: unknown; code?: unknown };
  const details = [value.name, value.message, value.code]
    .filter(item => typeof item === 'string')
    .join(' ')
    .toLowerCase();
  return /notallowederror|cancel|aborted/u.test(details);
}

export const createOwnerPasskeyReauthMachine = (reauthenticate: OwnerPasskeyReauthenticate) =>
  setup({
    types: {
      context: {} as Context,
      events: {} as { readonly type: 'REAUTHENTICATE' },
    },
    actors: {
      reauthenticate: fromPromise<void, { reauthenticate: OwnerPasskeyReauthenticate }>(({ input }) => input.reauthenticate()),
    },
    guards: {
      wasCancelled: ({ event }) => 'error' in event && isCancellation(event.error),
    },
    actions: {
      begin: assign({ error: null }),
      saveError: assign(({ event }) => ({ error: 'error' in event ? event.error : null })),
    },
  }).createMachine({
    id: 'ownerPasskeyReauthentication',
    initial: 'idle',
    context: () => ({ reauthenticate, error: null }),
    states: {
      idle: { on: { REAUTHENTICATE: { target: 'authenticating', actions: 'begin' } } },
      authenticating: {
        invoke: {
          src: 'reauthenticate',
          input: ({ context }) => ({ reauthenticate: context.reauthenticate }),
          onDone: { target: 'success' },
          onError: [
            { guard: 'wasCancelled', target: 'cancelled', actions: 'saveError' },
            { target: 'failed', actions: 'saveError' },
          ],
        },
      },
      success: { on: { REAUTHENTICATE: { target: 'authenticating', actions: 'begin' } } },
      cancelled: { on: { REAUTHENTICATE: { target: 'authenticating', actions: 'begin' } } },
      failed: { on: { REAUTHENTICATE: { target: 'authenticating', actions: 'begin' } } },
    },
  });
