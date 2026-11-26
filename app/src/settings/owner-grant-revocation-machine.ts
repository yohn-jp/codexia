import { assign, fromPromise, setup } from 'xstate';
import { type OwnerConsent, outcomeWasUnconfirmed } from './owner-security-client.js';

export interface OwnerGrantRevocationServices {
  reauthenticate(grant: OwnerConsent): Promise<void>;
  revoke(grant: OwnerConsent): Promise<void>;
  reload(grant: OwnerConsent): Promise<{ readonly status: 'present' | 'absent' | 'unavailable' }>;
}

interface Context {
  readonly services: OwnerGrantRevocationServices;
  readonly grant: OwnerConsent | null;
  readonly failed: boolean;
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

function requireGrant(context: Context): OwnerConsent {
  if (!context.grant) throw new Error('A selected owner grant is required for this transition');
  return context.grant;
}

export const createOwnerGrantRevocationMachine = (services: OwnerGrantRevocationServices) =>
  setup({
    types: {
      context: {} as Context,
      events: {} as { readonly type: 'WITHDRAW'; readonly grant: OwnerConsent },
    },
    actors: {
      reauthenticate: fromPromise<void, { services: OwnerGrantRevocationServices; grant: OwnerConsent }>(({ input }) =>
        input.services.reauthenticate(input.grant),
      ),
      revoke: fromPromise<void, { services: OwnerGrantRevocationServices; grant: OwnerConsent }>(({ input }) =>
        input.services.revoke(input.grant),
      ),
      reload: fromPromise<
        { status: 'present' | 'absent' | 'unavailable' },
        { services: OwnerGrantRevocationServices; grant: OwnerConsent }
      >(({ input }) => input.services.reload(input.grant)),
    },
    guards: { wasCancelled: ({ event }) => 'error' in event && isCancellation(event.error) },
    actions: {
      selectGrant: assign(({ event }) => ({
        grant: event.type === 'WITHDRAW' ? event.grant : null,
        failed: false,
        error: null,
      })),
      markFailed: assign(({ event }) => ({ failed: true, error: 'error' in event ? event.error : null })),
    },
  }).createMachine({
    id: 'ownerGrantRevocation',
    initial: 'idle',
    context: () => ({ services, grant: null, failed: false, error: null }),
    states: {
      idle: { on: { WITHDRAW: { target: 'reauthenticating', actions: 'selectGrant' } } },
      reauthenticating: {
        invoke: {
          src: 'reauthenticate',
          input: ({ context }) => ({ services: context.services, grant: requireGrant(context) }),
          onDone: 'revoking',
          onError: [
            { guard: 'wasCancelled', target: 'cancelled', actions: 'markFailed' },
            { target: 'failed', actions: 'markFailed' },
          ],
        },
      },
      revoking: {
        invoke: {
          src: 'revoke',
          input: ({ context }) => ({ services: context.services, grant: requireGrant(context) }),
          onDone: 'reloading',
          onError: { target: 'reloading', actions: 'markFailed' },
        },
      },
      reloading: {
        invoke: {
          src: 'reload',
          input: ({ context }) => ({ services: context.services, grant: requireGrant(context) }),
          onDone: [
            { guard: ({ context, event }) => !context.failed && event.output.status === 'absent', target: 'confirmed' },
            { guard: ({ context, event }) => !context.failed && event.output.status === 'unavailable', target: 'confirmedListUnavailable' },
            {
              guard: ({ context, event }) =>
                context.failed && !outcomeWasUnconfirmed(context.error) && event.output.status === 'unavailable',
              target: 'failedListUnavailable',
            },
            { guard: ({ context }) => context.failed && !outcomeWasUnconfirmed(context.error), target: 'failed' },
            { target: 'unknown' },
          ],
          onError: { target: 'unknown' },
        },
      },
      confirmed: { on: { WITHDRAW: { target: 'reauthenticating', actions: 'selectGrant' } } },
      confirmedListUnavailable: { on: { WITHDRAW: { target: 'reauthenticating', actions: 'selectGrant' } } },
      unknown: { on: { WITHDRAW: { target: 'reauthenticating', actions: 'selectGrant' } } },
      cancelled: { on: { WITHDRAW: { target: 'reauthenticating', actions: 'selectGrant' } } },
      failed: { on: { WITHDRAW: { target: 'reauthenticating', actions: 'selectGrant' } } },
      failedListUnavailable: { on: { WITHDRAW: { target: 'reauthenticating', actions: 'selectGrant' } } },
    },
  });
