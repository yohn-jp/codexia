import assert from 'node:assert/strict';
import test from 'node:test';
import { createActor } from 'xstate';
import { createOwnerPasskeyReauthMachine } from './owner-passkey-reauth-machine.js';

test('[TEST-UI-006-005] a cancelled WebAuthn ceremony cannot report reauthentication success', async () => {
  let calls = 0;
  const actor = createActor(
    createOwnerPasskeyReauthMachine(async () => {
      calls += 1;
      throw new DOMException('cancelled', 'NotAllowedError');
    }),
  );
  actor.start();
  actor.send({ type: 'REAUTHENTICATE' });
  await new Promise<void>(resolve =>
    actor.subscribe(snapshot => {
      if (snapshot.matches('cancelled')) resolve();
    }),
  );
  assert.equal(calls, 1);
  assert.equal('token' in actor.getSnapshot().context, false);
  actor.stop();
});

test('the actor reports success without storing authentication credentials', async () => {
  const actor = createActor(createOwnerPasskeyReauthMachine(async () => undefined));
  actor.start();
  actor.send({ type: 'REAUTHENTICATE' });
  await new Promise<void>(resolve =>
    actor.subscribe(snapshot => {
      if (snapshot.matches('success')) resolve();
    }),
  );
  assert.equal(actor.getSnapshot().matches('success'), true);
  assert.equal('token' in actor.getSnapshot().context, false);
  actor.stop();
});
