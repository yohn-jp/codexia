import assert from 'node:assert/strict';
import test from 'node:test';
import { createActor } from 'xstate';
import { ApiError } from '../api-error';
import { backupWorkflowMachine } from './backup-workflow';

const probe = { kind: 'probe', requestId: 'verified-probe-request' } as const;
const manual = { kind: 'manual', requestId: 'verified-manual-request' } as const;

test('a probe acknowledgement is acceptance and only the matching observation can confirm it', () => {
  const actor = createActor(backupWorkflowMachine).start();
  actor.send({ type: 'START', command: probe });
  assert.equal(actor.getSnapshot().value, 'submitting');
  actor.send({ type: 'ACKNOWLEDGED' });
  assert.equal(actor.getSnapshot().value, 'accepted');
  actor.send({ type: 'OBSERVED', command: { ...probe, requestId: 'some-other-probe' }, status: 'PASSED' });
  assert.equal(actor.getSnapshot().value, 'accepted');
  actor.send({ type: 'OBSERVED', command: probe, status: 'REMOTE_VERIFIED' });
  assert.equal(actor.getSnapshot().value, 'accepted');
  actor.send({ type: 'OBSERVED', command: probe, status: 'RUNNING' });
  assert.equal(actor.getSnapshot().value, 'running');
  actor.send({ type: 'OBSERVED', command: probe, status: 'PASSED' });
  assert.equal(actor.getSnapshot().value, 'confirmed');
  actor.stop();
});

test('[TEST-UI-006-009] a lost manual response preserves identity across disconnection and needs the authoritative recheck', () => {
  const actor = createActor(backupWorkflowMachine).start();
  actor.send({ type: 'START', command: manual });
  actor.send({ type: 'FAILED', error: new TypeError('network disconnected') });
  assert.equal(actor.getSnapshot().value, 'unknown');
  assert.equal(actor.getSnapshot().can({ type: 'START', command: manual }), false);
  actor.send({ type: 'DISCONNECTED' });
  actor.send({ type: 'RECHECK' });
  assert.equal(actor.getSnapshot().value, 'rechecking');
  assert.deepEqual(actor.getSnapshot().context.command, manual);
  actor.send({ type: 'OBSERVED', command: manual, status: 'QUEUED' });
  assert.equal(actor.getSnapshot().value, 'accepted');
  actor.send({ type: 'OBSERVED', command: manual, status: 'REMOTE_VERIFIED' });
  assert.equal(actor.getSnapshot().value, 'confirmed');
  actor.stop();
});

test('an authoritative missing request permits retry of the original identity only', () => {
  const actor = createActor(backupWorkflowMachine).start();
  actor.send({ type: 'START', command: probe });
  actor.send({ type: 'FAILED', error: new TypeError('response lost') });
  actor.send({ type: 'OBSERVED', command: probe, status: 'ABSENT' });
  assert.equal(actor.getSnapshot().value, 'absent');
  assert.equal(actor.getSnapshot().can({ type: 'START', command: { ...probe, requestId: 'different' } }), false);
  assert.equal(actor.getSnapshot().can({ type: 'START', command: probe }), true);
  actor.stop();
});

test('a draft conflict holds writes until the refreshed revision is acknowledged', () => {
  const actor = createActor(backupWorkflowMachine).start();
  const draft = { kind: 'draft' } as const;
  actor.send({ type: 'START', command: draft });
  actor.send({ type: 'FAILED', error: new ApiError('revision changed', 412, 'STALE') });
  assert.equal(actor.getSnapshot().value, 'conflict');
  assert.equal(actor.getSnapshot().can({ type: 'START', command: draft }), false);
  actor.send({ type: 'REVIEW_CURRENT' });
  assert.equal(actor.getSnapshot().can({ type: 'START', command: draft }), true);
  actor.stop();
});
