import assert from 'node:assert/strict';
import test from 'node:test';
import { createActor } from 'xstate';
import { createOwnerGrantRevocationMachine } from './owner-grant-revocation-machine.js';
import { OwnerSecurityRequestError } from './owner-security-client.js';

const grant = {
  id: 'grant-1',
  clientId: 'desktop',
  scopes: ['codexia:api'],
  updatedAt: '2026-11-26T00:00:00Z',
  revision: 'A'.repeat(43),
};

test('a cancelled or rejected Passkey ceremony never revokes the grant', async () => {
  let revokeCalls = 0;
  const actor = createActor(
    createOwnerGrantRevocationMachine({
      reauthenticate: async () => {
        throw new DOMException('cancelled', 'NotAllowedError');
      },
      revoke: async () => {
        revokeCalls += 1;
      },
      reload: async () => ({ status: 'present' }),
    }),
  );
  actor.start();
  actor.send({ type: 'WITHDRAW', grant });
  await new Promise<void>(resolve =>
    actor.subscribe(snapshot => {
      if (snapshot.matches('cancelled')) resolve();
    }),
  );
  assert.equal(revokeCalls, 0);
  assert.equal(actor.getSnapshot().matches('cancelled'), true);
  actor.stop();
});

test('a missing fresh owner proof never reaches the revoke API', async () => {
  let revokeCalls = 0;
  const actor = createActor(
    createOwnerGrantRevocationMachine({
      reauthenticate: async () => {
        throw new Error('OWNER_SECURITY_REAUTH_REQUIRED');
      },
      revoke: async () => {
        revokeCalls += 1;
      },
      reload: async () => ({ status: 'present' }),
    }),
  );
  actor.start();
  actor.send({ type: 'WITHDRAW', grant });
  await new Promise<void>(resolve =>
    actor.subscribe(snapshot => {
      if (snapshot.matches('failed')) resolve();
    }),
  );
  assert.equal(revokeCalls, 0);
  assert.equal(actor.getSnapshot().matches('failed'), true);
  actor.stop();
});

test('[TEST-UI-006-006] an unconfirmed revoke is classified from the refreshed server identity', async () => {
  const actor = createActor(
    createOwnerGrantRevocationMachine({
      reauthenticate: async () => undefined,
      revoke: async () => {
        throw new TypeError('response lost');
      },
      reload: async () => ({ status: 'present' }),
    }),
  );
  actor.start();
  actor.send({ type: 'WITHDRAW', grant });
  await new Promise<void>(resolve =>
    actor.subscribe(snapshot => {
      if (snapshot.matches('unknown')) resolve();
    }),
  );
  assert.equal(actor.getSnapshot().matches('unknown'), true);
  actor.stop();
});

test('a successful revocation receipt stays confirmed when the identity list cannot refresh', async () => {
  const actor = createActor(
    createOwnerGrantRevocationMachine({
      reauthenticate: async () => undefined,
      revoke: async () => undefined,
      reload: async () => ({ status: 'unavailable' }),
    }),
  );
  actor.start();
  actor.send({ type: 'WITHDRAW', grant });
  await new Promise<void>(resolve =>
    actor.subscribe(snapshot => {
      if (snapshot.matches('confirmedListUnavailable')) resolve();
    }),
  );
  assert.equal(actor.getSnapshot().matches('unknown'), false);
  actor.stop();
});

test('a known server rejection plus identity refresh failure remains a failure', async () => {
  const actor = createActor(
    createOwnerGrantRevocationMachine({
      reauthenticate: async () => undefined,
      revoke: async () => {
        throw new OwnerSecurityRequestError(409, 'OWNER_SECURITY_CONSENT_CHANGED');
      },
      reload: async () => ({ status: 'unavailable' }),
    }),
  );
  actor.start();
  actor.send({ type: 'WITHDRAW', grant });
  await new Promise<void>(resolve =>
    actor.subscribe(snapshot => {
      if (snapshot.matches('failedListUnavailable')) resolve();
    }),
  );
  assert.equal(actor.getSnapshot().matches('unknown'), false);
  assert.equal((actor.getSnapshot().context.error as OwnerSecurityRequestError).code, 'OWNER_SECURITY_CONSENT_CHANGED');
  actor.stop();
});
