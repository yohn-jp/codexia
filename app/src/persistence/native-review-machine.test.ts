import assert from 'node:assert/strict';
import test from 'node:test';
import type { ChangeSet } from '@codexia/persistence-contracts';
import { createActor, waitFor } from 'xstate';
import { createNativeReviewMachine, type NativeReviewDetail, type NativeReviewServices } from './native-review-machine.js';

const changeSet = {
  id: 'changeset-1',
  projectId: 'project-1',
  version: 7,
  status: 'approved',
} as ChangeSet;

function harness(overrides: Partial<NativeReviewServices> = {}, initialChangeSet: ChangeSet = changeSet) {
  const calls: Array<{ action?: string; version?: number }> = [];
  let currentChangeSet = initialChangeSet;
  const services: NativeReviewServices = {
    async load() {
      return { changeSets: [currentChangeSet], coreReviews: [] };
    },
    async approve(projectId, id, version) {
      calls.push({ action: 'approve', version });
      currentChangeSet = { ...currentChangeSet, status: 'approved' };
      return { changeSet: currentChangeSet };
    },
    async reject(projectId, id, version) {
      calls.push({ action: 'reject', version });
      currentChangeSet = { ...currentChangeSet, status: 'rejected' };
      return { changeSet: currentChangeSet };
    },
    async apply(projectId, id, version) {
      calls.push({ action: 'apply', version });
      currentChangeSet = { ...currentChangeSet, status: 'applied' };
      return { changeSet: currentChangeSet, results: [], replayed: false };
    },
    async list() {
      return [currentChangeSet];
    },
    async get() {
      return { changeSet: currentChangeSet };
    },
    ...overrides,
  };
  const actor = createActor(createNativeReviewMachine(services), { input: { projectId: 'project-1' } });
  actor.start();
  const load = async () => {
    actor.send({ type: 'LOAD.REQUESTED', canWrite: true, showCoreReviews: false });
    await waitFor(actor, snapshot => snapshot.matches('idle') && snapshot.context.detail !== null, { timeout: 1_000 });
  };
  return {
    actor,
    calls,
    load,
    setChangeSet: (next: ChangeSet) => {
      currentChangeSet = next;
    },
  };
}

test('apply is rejected unless the observed ChangeSet is approved', async () => {
  const { actor, calls, load } = harness({}, { ...changeSet, status: 'proposed' });
  await load();
  actor.send({ type: 'ACTION', action: 'apply' });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, []);
  assert.equal(actor.getSnapshot().matches('idle'), true);
  actor.stop();
});

test('a lost apply response remains unknown and retries the same version', async () => {
  let attempts = 0;
  const { actor, calls, load } = harness({
    async apply(projectId, id, version) {
      calls.push({ action: 'apply', version });
      if (++attempts === 1) throw new Error('response lost');
      throw new Error('response lost again');
    },
    async get() {
      return { changeSet };
    },
  });
  await load();
  actor.send({ type: 'ACTION', action: 'apply' });
  await waitFor(actor, snapshot => snapshot.matches('unknown'), { timeout: 1_000 });
  assert.equal(actor.getSnapshot().context.detail?.changeSet.status, 'approved');
  actor.send({ type: 'ACTION', action: 'apply' });
  await waitFor(actor, () => calls.length === 2, { timeout: 1_000 });
  await waitFor(actor, snapshot => snapshot.matches('unknown'), { timeout: 1_000 });
  assert.deepEqual(calls, [
    { action: 'apply', version: 7 },
    { action: 'apply', version: 7 },
  ]);
  actor.stop();
});

test('approval and rejection are available only from proposed state', async () => {
  const { actor, calls, load, setChangeSet } = harness();
  await load();
  actor.send({ type: 'ACTION', action: 'approve' });
  assert.equal(actor.getSnapshot().matches('idle'), true);
  assert.deepEqual(calls, []);
  setChangeSet({ ...changeSet, status: 'proposed' });
  await load();
  actor.send({ type: 'ACTION', action: 'reject' });
  await waitFor(actor, snapshot => snapshot.matches('confirmed'), { timeout: 1_000 });
  assert.deepEqual(calls, [{ action: 'reject', version: 7 }]);
  actor.stop();
});

test('a failed feed refresh preserves the last native ChangeSet list', async () => {
  let fail = false;
  const { actor, calls, load } = harness({
    async load() {
      if (fail) throw new Error('feed unavailable');
      return { changeSets: [changeSet], coreReviews: [] };
    },
  });
  await load();
  fail = true;
  actor.send({ type: 'LOAD.REQUESTED' });
  const failed = await waitFor(actor, snapshot => snapshot.context.message === 'feed unavailable', { timeout: 1_000 });
  actor.send({ type: 'ACTION', action: 'apply' });

  assert.deepEqual(calls, []);
  assert.equal(failed.matches('readFailed'), true);
  assert.deepEqual(failed.context.changeSets, [changeSet]);
  actor.stop();
});

test('a detail read failure keeps the newly fetched list available', async () => {
  const fresh = { ...changeSet, id: 'changeset-new', version: 8 } as ChangeSet;
  const { actor } = harness({
    async load() {
      return { changeSets: [fresh], coreReviews: [] };
    },
    async get() {
      throw new Error('detail unavailable');
    },
  });
  actor.send({ type: 'LOAD.REQUESTED', canWrite: false, showCoreReviews: false });
  await waitFor(actor, snapshot => snapshot.matches('readFailed') && snapshot.context.message === 'detail unavailable', {
    timeout: 1_000,
  });
  assert.deepEqual(actor.getSnapshot().context.changeSets, [fresh]);
  assert.equal(actor.getSnapshot().context.selectedId, fresh.id);
  assert.equal(actor.getSnapshot().context.detail, null);
  actor.stop();
});

test('a version conflict blocks another mutation until a fresh detail is loaded', async () => {
  const conflict = Object.assign(new Error('stale version'), { status: 412 });
  const { actor, calls, load } = harness({
    async apply(projectId, id, version) {
      calls.push({ action: 'apply', version });
      throw conflict;
    },
  });
  await load();
  actor.send({ type: 'ACTION', action: 'apply' });
  await waitFor(actor, snapshot => snapshot.matches('conflict'), { timeout: 1_000 });
  assert.equal(actor.getSnapshot().context.applyVersions.has(changeSet.id), false);
  actor.send({ type: 'ACTION', action: 'apply' });
  assert.deepEqual(calls, [{ action: 'apply', version: 7 }]);
  actor.send({ type: 'LOAD.REQUESTED', canWrite: true, showCoreReviews: false });
  await waitFor(actor, snapshot => snapshot.matches('idle'), { timeout: 1_000 });
  actor.stop();
});

test('a forbidden mutation is not confirmed by a concurrent applied status', async () => {
  const denied = Object.assign(new Error('forbidden'), { status: 403 });
  const applied = {
    changeSet: { ...changeSet, status: 'applied' },
    receipt: { changeSet: { ...changeSet, status: 'applied' }, results: [], replayed: false },
  } as unknown as NativeReviewDetail;
  const { actor, calls, load } = harness({
    async apply(projectId, id, version) {
      calls.push({ action: 'apply', version });
      throw denied;
    },
    async get() {
      return calls.length ? applied : { changeSet };
    },
  });
  await load();
  actor.send({ type: 'ACTION', action: 'apply' });
  await waitFor(actor, snapshot => snapshot.matches('forbidden'), { timeout: 1_000 });
  assert.equal(actor.getSnapshot().context.outcome?.kind, 'forbidden');
  assert.equal(actor.getSnapshot().context.detail?.changeSet.status, 'applied');
  assert.equal(calls.length, 1);
  actor.send({ type: 'ACTION', action: 'apply' });
  assert.equal(calls.length, 1);
  actor.stop();
});

test('a valid apply receipt survives a failed projection refresh', async () => {
  const appliedChangeSet = { ...changeSet, status: 'applied' } as ChangeSet;
  const receipt = { changeSet: appliedChangeSet, results: [], replayed: false };
  let applied = false;
  const { actor, load } = harness({
    async apply() {
      applied = true;
      return receipt;
    },
    async list() {
      throw new Error('projection unavailable');
    },
    async get() {
      if (applied) throw new Error('receipt lookup unavailable');
      return { changeSet };
    },
  });
  await load();
  actor.send({ type: 'ACTION', action: 'apply' });
  await waitFor(actor, snapshot => snapshot.matches('confirmed'), { timeout: 1_000 });
  assert.equal(actor.getSnapshot().context.detail?.receipt, receipt);
  actor.stop();
});

test('refreshing an uncertain apply keeps its original version', async () => {
  const { actor, calls, load, setChangeSet } = harness({
    async apply(_projectId, _id, version) {
      calls.push({ action: 'apply', version });
      throw new Error('response lost');
    },
  });
  await load();
  actor.send({ type: 'ACTION', action: 'apply' });
  await waitFor(actor, snapshot => snapshot.matches('unknown'), { timeout: 1_000 });
  setChangeSet({ ...changeSet, version: 8 });
  await load();
  actor.send({ type: 'ACTION', action: 'apply' });
  await waitFor(actor, snapshot => snapshot.matches('unknown'), { timeout: 1_000 });
  assert.deepEqual(calls, [
    { action: 'apply', version: 7 },
    { action: 'apply', version: 7 },
  ]);
  actor.stop();
});

test('a reconciled apply receipt survives a failed list refresh', async () => {
  const appliedChangeSet = { ...changeSet, status: 'applied' } as ChangeSet;
  const receipt = { changeSet: appliedChangeSet, results: [], replayed: false };
  let applied = false;
  const { actor, load } = harness({
    async apply() {
      applied = true;
      throw new Error('response lost');
    },
    async list() {
      throw new Error('projection unavailable');
    },
    async get() {
      return applied ? { changeSet: appliedChangeSet, receipt } : { changeSet };
    },
  });
  await load();
  actor.send({ type: 'ACTION', action: 'apply' });
  await waitFor(actor, snapshot => snapshot.context.outcome !== null, { timeout: 1_000 });
  assert.equal(actor.getSnapshot().matches('confirmed'), true);
  assert.equal(actor.getSnapshot().context.detail?.receipt, receipt);
  actor.stop();
});

test('an uncertain apply preserves the original version after reviewing another ChangeSet', async () => {
  const other = { ...changeSet, id: 'changeset-2' as ChangeSet['id'] };
  let version = 7;
  const { actor, calls, load } = harness({
    async load() {
      return { changeSets: [{ ...changeSet, version }, other], coreReviews: [] };
    },
    async get(_projectId, id) {
      return { changeSet: id === other.id ? other : { ...changeSet, version } };
    },
    async apply(_projectId, _id, version) {
      calls.push({ action: 'apply', version });
      throw new Error('response lost');
    },
  });
  await load();
  actor.send({ type: 'ACTION', action: 'apply' });
  await waitFor(actor, snapshot => snapshot.matches('unknown'), { timeout: 1_000 });
  actor.send({ type: 'SELECT.REQUESTED', id: other.id });
  await waitFor(actor, snapshot => snapshot.context.detail?.changeSet.id === other.id, { timeout: 1_000 });
  version = 8;
  actor.send({ type: 'SELECT.REQUESTED', id: changeSet.id });
  await waitFor(actor, snapshot => snapshot.context.detail?.changeSet.id === changeSet.id, { timeout: 1_000 });
  actor.send({ type: 'ACTION', action: 'apply' });
  await waitFor(actor, snapshot => snapshot.matches('unknown'), { timeout: 1_000 });
  assert.deepEqual(calls, [
    { action: 'apply', version: 7 },
    { action: 'apply', version: 7 },
  ]);
  actor.stop();
});

test('a later detail refresh emits the recovered apply outcome once', async () => {
  const appliedChangeSet = { ...changeSet, status: 'applied' } as ChangeSet;
  const receipt = { changeSet: appliedChangeSet, results: [], replayed: false };
  let receiptAvailable = false;
  const { actor, load } = harness({
    async apply() {
      throw new Error('response lost');
    },
    async get() {
      return receiptAvailable ? { changeSet: appliedChangeSet, receipt } : { changeSet };
    },
  });
  await load();
  actor.send({ type: 'ACTION', action: 'apply' });
  const unknown = await waitFor(actor, snapshot => snapshot.matches('unknown'), { timeout: 1_000 });
  receiptAvailable = true;
  actor.send({ type: 'LOAD.REQUESTED' });
  const refreshed = await waitFor(actor, snapshot => snapshot.context.detail?.receipt === receipt, { timeout: 1_000 });
  assert.equal(refreshed.context.outcome?.kind, 'confirmed');
  assert.equal(refreshed.context.outcomeSequence, unknown.context.outcomeSequence + 1);
  actor.send({ type: 'SELECT.REQUESTED', id: changeSet.id });
  const reselected = await waitFor(actor, snapshot => snapshot.context.detail?.receipt === receipt, { timeout: 1_000 });
  assert.equal(reselected.context.outcomeSequence, refreshed.context.outcomeSequence);
  actor.stop();
});

test('an expired session during feed refresh blocks mutation on the previously loaded proposal', async () => {
  let expired = false;
  const { actor, calls, load } = harness({
    async load() {
      if (expired) throw Object.assign(new Error('Session expired'), { status: 401 });
      return { changeSets: [changeSet], coreReviews: [] };
    },
  });
  try {
    await load();
    expired = true;
    actor.send({ type: 'LOAD.REQUESTED' });
    const failed = await waitFor(actor, snapshot => Boolean(snapshot.context.message), { timeout: 1_000 });

    actor.send({ type: 'ACTION', action: 'apply' });
    assert.deepEqual(calls, []);
    assert.equal(failed.matches('unauthorized'), true);

    expired = false;
    await load();
    actor.send({ type: 'ACTION', action: 'apply' });
    assert.deepEqual(calls, [{ action: 'apply', version: 7 }]);
  } finally {
    actor.stop();
  }
});
