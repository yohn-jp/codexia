import assert from 'node:assert/strict';
import test from 'node:test';
import { advancePair, verifyReactivationWindow } from './execute.mjs';
import { digestEvidence } from './coordinator.mjs';
import { assertReactivationObservation } from './run.mjs';

const approved = 'a'.repeat(64);
const timestamp = '2026-11-23T12:00:00.000Z';
const origin = 'https://fixture.example.test';

function fixture({ first = false, changeWorker = true, retainedBackendFirstFrontend = false } = {}) {
  const calls = [];
  const priorIdentity = { epoch: 1 };
  const unitSha256 = 'b'.repeat(64);
  const containerId = 'c'.repeat(64);
  const plan = {
    environment: { origin },
    prior: { image: first ? null : 'installed', workerVersion: first || retainedBackendFirstFrontend ? null : 'old',
      identity: priorIdentity, unitSha256, containerId },
    candidate: { image: retainedBackendFirstFrontend ? 'installed' : 'certified',
      workerVersion: changeWorker ? 'new' : 'old', identity: priorIdentity,
      frontendArtifact: { artifactDigest: approved } },
  };
  let phase = null;
  let owner = null;
  let outcome;
  let fenced = false;
  let workerVersion = plan.prior.workerVersion;
  let reactivationStartedAt;
  let retainedCandidateWorker;
  let reactivationWindow;
  const cut = {
    operation: 'advance',
    plan, planSha256: approved, request: {},
    async host(action, request) {
      if (action === 'observe') return { phase, planSha256: owner, outcome, phaseChangedAt: timestamp,
        reactivationStartedAt, retainedCandidateWorker, reactivationWindow,
        ...(retainedBackendFirstFrontend ? { apiRunning: true, apiVerified: true, tunnelRunning: true,
          priorImage: plan.prior.image, priorUnitSha256: plan.prior.unitSha256,
          priorContainerId: plan.prior.containerId, priorIdentity: plan.prior.identity } : {}) };
      calls.push(action);
      if (owner && owner !== approved) throw new Error('foreign plan');
      if (action === 'admit') owner = approved;
      const frontendRetry = action === 'recover' && request.frontendRetry === true;
      if (frontendRetry) {
        retainedCandidateWorker = request.retainedCandidateWorker;
      }
      if (action === 'checkpoint' && phase === 'safe-stopped') {
        reactivationStartedAt = timestamp;
        retainedCandidateWorker = request.retainedCandidateWorker;
        reactivationWindow = request.reactivationWindow;
      }
      outcome = request.outcome ?? outcome;
      phase = { admit: 'intent', checkpoint: 'checkpointed', apply: 'candidate-ready',
        'open-tunnel': outcome + '-tunnel', publishing: outcome + '-publishing', finish: 'finished',
        'recover-quiesce': 'recovering', recover: first ? 'safe-stopped' : 'prior-ready' }[action];
      if (frontendRetry) phase = 'checkpointed';
      if (cut.failAfter === action) throw new Error('connection lost');
      return { status: phase };
    },
    edge: {
      async fence() { calls.push('fence'); fenced = true; },
      async unfence() { assert.match(phase, /-publishing$|^finished$/u); calls.push('unfence'); fenced = false; },
      async verifyFenced() { assert.ok(fenced); },
      async verifyUnfenced() { assert.ok(!fenced); },
      async assertWorkerArtifact() { assert.equal(workerVersion, 'new'); },
      async assertStaged() { assert.notEqual(workerVersion, 'new'); },
      async deploy({ fromVersionId, toVersionId }) {
        assert.ok(fenced);
        assert.equal(workerVersion, fromVersionId);
        calls.push('deploy');
        workerVersion = toVersionId;
      },
    },
    async verifyIngress() { return { fence: { enabled: fenced }, deployment: workerVersion === null ? null : { versionId: workerVersion } }; },
    async verifyPair(selected) {
      assert.equal(workerVersion, plan[selected].workerVersion);
      return { edge: { deployment: { createdAt: timestamp } } };
    },
    async admitFresh() { if (cut.drift) throw new Error('approval drift'); },
    verifyApproval() { if (cut.expired) throw new Error('expired'); },
    async checkpointProof() { return cut.independent ? { request: {} } : { request: null, binding: 'backup' }; },
    async restoreProof() { return {}; },
  };
  return { cut, calls, compete() { owner = 'foreign'; phase = 'intent'; },
    seedRetainedBackend({ journalPhase = 'candidate-tunnel', worker = null } = {}) {
      owner = approved;
      phase = journalPhase;
      workerVersion = worker;
      fenced = true;
    },
    switchWorker(version = plan.candidate.workerVersion) { workerVersion = version; } };
}

function accept(cut, outcome = 'candidate') {
  cut.acceptance = {
    format: 'codexia-cutover-functional-acceptance/v1', planSha256: approved, outcome, origin,
    image: cut.plan[outcome].image, workerVersion: cut.plan[outcome].workerVersion, verifiedAt: timestamp,
    checks: Object.fromEntries(['ownerLogin', 'passkey', 'oauth', 'manuscript', 'history', 'permissionDenial', 'accessBoundary']
      .map(key => [key, approved])),
  };
}

test('admission persists the journal before the fence and waits only at proof boundaries', async () => {
  const { cut, calls } = fixture();
  assert.equal((await advancePair(cut)).status, 'awaiting-independent-recovery-proof');
  assert.deepEqual(calls, ['admit', 'fence', 'checkpoint']);
  cut.independent = true;
  assert.equal((await advancePair(cut)).status, 'awaiting-functional-acceptance');
  assert.deepEqual(calls, ['admit', 'fence', 'checkpoint', 'apply', 'open-tunnel', 'deploy']);
  accept(cut);
  assert.equal((await advancePair(cut)).status, 'finished');
  assert.deepEqual(calls.slice(-3), ['publishing', 'unfence', 'finish']);
});

test('uncertain publication never authorizes rollback', async () => {
  const { cut, calls } = fixture();
  cut.independent = true;
  cut.failAfter = 'publishing';
  accept(cut);
  await assert.rejects(advancePair(cut), /connection lost/u);
  assert.ok(!calls.includes('unfence'));
  await assert.rejects(advancePair({ ...cut, operation: 'recover' }), /rollback is blocked/u);
  assert.ok(!calls.includes('recover-quiesce'));
  cut.failAfter = null;
  assert.equal((await advancePair({ ...cut, operation: 'reconcile' })).status, 'finished');
});

test('first pair activation without a prior release stops without recreating owner setup', async () => {
  const { cut, calls } = fixture({ first: true });
  cut.independent = true;
  await advancePair(cut);
  assert.equal((await advancePair({ ...cut, operation: 'recover' })).status, 'safe-stopped');
  assert.deepEqual(calls.slice(-2), ['recover-quiesce', 'recover']);
  assert.ok((await cut.verifyIngress()).fence.enabled);
});

test('compatible deployed Worker is retained without promotion', async () => {
  const { cut, calls } = fixture({ changeWorker: false });
  cut.independent = true;
  accept(cut);
  assert.equal((await advancePair(cut)).status, 'finished');
  assert.ok(!calls.includes('deploy'));
});

test('drift and competing journals stop before any mutation', async () => {
  const { cut, calls, compete } = fixture();
  cut.drift = true;
  await assert.rejects(advancePair(cut), /approval drift/u);
  compete();
  await assert.rejects(advancePair(cut), /conflicting or unbound/u);
  assert.deepEqual(calls, []);
});

for (const phase of ['admit', 'checkpoint', 'apply', 'open-tunnel']) {
  test(`advance resumes the observed checkpoint after losing the ${phase} response`, async () => {
    const { cut, calls } = fixture();
    cut.independent = true;
    cut.failAfter = phase;
    await assert.rejects(advancePair(cut), /connection lost/u);
    cut.failAfter = null;
    assert.equal((await advancePair(cut)).status, 'awaiting-functional-acceptance');
    assert.equal(calls.filter(action => action === 'checkpoint').length, 1);
    assert.equal(calls.filter(action => action === 'apply').length, 1);
  });
}

test('recovery repeats quiescence after an interrupted stop before returning a restore checkpoint', async () => {
  const { cut, calls } = fixture();
  cut.independent = true;
  await advancePair(cut);
  cut.failAfter = 'recover-quiesce';
  cut.restoreProof = async () => null;
  await assert.rejects(advancePair({ ...cut, operation: 'recover' }), /connection lost/u);
  cut.failAfter = null;
  assert.equal((await advancePair({ ...cut, operation: 'recover' })).status, 'awaiting-restoration');
  assert.deepEqual(calls.slice(-2), ['recover-quiesce', 'recover-quiesce']);
});

test('a recorded release behind a reclosed fence is not reported as released without acceptance', async () => {
  const { cut } = fixture();
  cut.independent = true;
  cut.failAfter = 'finish';
  accept(cut);
  await assert.rejects(advancePair(cut), /connection lost/u);
  assert.ok((await cut.verifyIngress()).fence.enabled);
  cut.failAfter = null;
  const reconcile = { ...cut, operation: 'reconcile', acceptance: null };
  assert.equal((await advancePair(reconcile)).status, 'awaiting-functional-acceptance');
  assert.equal((await advancePair({ ...reconcile, acceptance: cut.acceptance })).status, 'finished');
});

test('reconciliation must still authorize reopening the fenced candidate', async () => {
  const { cut, calls } = fixture();
  cut.independent = true;
  cut.failAfter = 'publishing';
  accept(cut);
  await assert.rejects(advancePair(cut), /connection lost/u);
  cut.failAfter = null;
  cut.verifyApproval = ({ opening } = {}) => {
    if (opening === 'candidate') throw new Error('publication expired');
  };
  await assert.rejects(advancePair({ ...cut, operation: 'reconcile' }), /publication expired/u);
  assert.ok(!calls.includes('unfence'));
});

test('candidate Worker live before the Tunnel checkpoint blocks mutation', async () => {
  const { cut, calls, switchWorker } = fixture();
  await advancePair(cut);
  switchWorker();
  cut.independent = true;
  await assert.rejects(advancePair(cut), /Worker drifted/u);
  assert.ok(!calls.includes('apply'));
});

test('recovery rejects a different healthy API at the recorded prior outcome', async () => {
  const { cut, calls } = fixture();
  cut.independent = true;
  await advancePair(cut);
  await advancePair({ ...cut, operation: 'recover' });
  const observe = cut.host;
  cut.host = async (action, request) => {
    const result = await observe(action, request);
    return action === 'observe' ? { ...result, apiRunning: true, priorImage: 'foreign' } : result;
  };
  const before = [...calls];
  await assert.rejects(advancePair({ ...cut, operation: 'recover' }), /prior API identity drifted/u);
  assert.deepEqual(calls, before);
});

test('R7 recovery pins the retained Backend and records the existing checkpoint for advance', async () => {
  const { cut, calls, seedRetainedBackend } = fixture({ retainedBackendFirstFrontend: true });
  seedRetainedBackend({ journalPhase: 'candidate-tunnel' });

  const recovered = await advancePair({ ...cut, operation: 'recover' });

  assert.equal(recovered.status, 'checkpointed');
  assert.equal(recovered.nextOperation, 'advance');
  assert.deepEqual(calls, ['recover']);
  const observed = await cut.host('observe', {});
  assert.equal(observed.phase, 'checkpointed');
  assert.equal(observed.retainedCandidateWorker, false);
  assert.ok((await cut.verifyIngress()).fence.enabled);
  await assert.rejects(advancePair({ ...cut, operation: 'reconcile' }), /No recorded publication/u);
  cut.independent = true;
  cut.expired = true;
  await assert.rejects(advancePair(cut), /expired/u);
  cut.expired = false;
  assert.deepEqual(calls, ['recover']);

  assert.equal((await advancePair(cut)).status, 'awaiting-functional-acceptance');
  assert.deepEqual(calls.slice(-3), ['apply', 'open-tunnel', 'deploy']);
  assert.ok((await cut.verifyIngress()).fence.enabled);
  accept(cut);
  assert.equal((await advancePair(cut)).status, 'finished');
  assert.ok(!(await cut.verifyIngress()).fence.enabled);
});

test('R7 recovery accepts a late candidate Worker behind the fence and retains its artifact binding', async () => {
  const { cut, calls, seedRetainedBackend } = fixture({ retainedBackendFirstFrontend: true });
  seedRetainedBackend({ journalPhase: 'candidate-tunnel', worker: 'new' });

  const recovered = await advancePair({ ...cut, operation: 'recover' });

  assert.equal(recovered.status, 'checkpointed');
  assert.equal(recovered.nextOperation, 'advance');
  assert.deepEqual(calls, ['recover']);
  assert.equal((await cut.host('observe', {})).retainedCandidateWorker, true);
  const repeated = await advancePair({ ...cut, operation: 'recover' });
  assert.equal(repeated.status, 'checkpointed');
  assert.equal(repeated.nextOperation, 'advance');
  assert.equal((await cut.host('observe', {})).retainedCandidateWorker, true);
  cut.independent = true;
  assert.equal((await advancePair(cut)).status, 'awaiting-functional-acceptance');
  assert.deepEqual(calls, ['recover', 'recover', 'apply', 'open-tunnel']);
  assert.ok((await cut.verifyIngress()).fence.enabled);
});

test('R7 recovery rejects Worker drift and recovers idempotently after a lost host response', async () => {
  const drift = fixture({ retainedBackendFirstFrontend: true });
  drift.seedRetainedBackend({ journalPhase: 'candidate-tunnel', worker: 'foreign' });
  await assert.rejects(advancePair({ ...drift.cut, operation: 'recover' }), /Worker drifted before Frontend recovery/u);
  assert.deepEqual(drift.calls, []);

  const interrupted = fixture({ retainedBackendFirstFrontend: true });
  interrupted.seedRetainedBackend({ journalPhase: 'prior-ready' });
  interrupted.cut.failAfter = 'recover';
  await assert.rejects(advancePair({ ...interrupted.cut, operation: 'recover' }), /connection lost/u);
  interrupted.cut.failAfter = null;
  const resumed = await advancePair({ ...interrupted.cut, operation: 'recover' });
  assert.equal(resumed.status, 'checkpointed');
  assert.equal(resumed.nextOperation, 'advance');
  assert.deepEqual(interrupted.calls, ['recover', 'recover']);
});

test('recovery promotes the existing prior pair and verifies acceptance before opening it', async () => {
  const { cut, calls } = fixture();
  cut.independent = true;
  await advancePair(cut);

  const recovery = { ...cut, operation: 'recover' };
  const waiting = await advancePair(recovery);
  assert.equal(waiting.status, 'awaiting-functional-acceptance');
  assert.equal(waiting.outcome, 'prior');
  assert.deepEqual(calls.slice(-4), ['recover-quiesce', 'recover', 'open-tunnel', 'deploy']);
  assert.ok((await cut.verifyIngress()).fence.enabled);
  accept(recovery, 'prior');
  assert.equal((await advancePair(recovery)).status, 'finished');
  assert.ok(!(await cut.verifyIngress()).fence.enabled);
});

test('first activation restarts from the safe stop behind the existing fence and takes a fresh checkpoint', async () => {
  const { cut, calls } = fixture({ first: true });
  cut.independent = true;
  await advancePair(cut);
  await advancePair({ ...cut, operation: 'recover' });
  cut.independent = false;
  cut.revalidateActivation = async () => { calls.push('revalidate'); };
  assert.equal((await advancePair(cut)).status, 'awaiting-independent-recovery-proof');
  assert.deepEqual(calls.slice(-2), ['revalidate', 'checkpoint']);
  assert.ok((await cut.verifyIngress()).fence.enabled);
  cut.independent = true;
  accept(cut);
  assert.equal((await advancePair(cut)).status, 'finished');
  assert.equal(calls.filter(action => action === 'deploy').length, 1);
});

test('a renewed first activation window binds the same staged plan, window and protected retry', async () => {
  const window = { id: 'second-window', notBefore: timestamp, notAfter: '2026-11-23T12:10:00.000Z' };
  const renewal = { window, approval: digestEvidence({ planSha256: approved, window }) };
  const options = { now: new Date(timestamp) };
  const request = verifyReactivationWindow(renewal, approved, options);
  assert.throws(() => verifyReactivationWindow(renewal, 'f'.repeat(64), options), /Invalid approval/u);
  assert.throws(() => verifyReactivationWindow(renewal, approved, { now: new Date('2026-11-23T12:11:00.000Z') }), /Outside approved/u);

  const { cut, calls } = fixture({ first: true });
  await assert.rejects(advancePair({ ...cut, request: { reactivationWindow: request } }), /durable checkpoint/u);
  assert.deepEqual(calls, []);
  cut.independent = true;
  await advancePair(cut);
  await advancePair({ ...cut, operation: 'recover' });
  cut.independent = false;
  const retry = { ...cut, request: { reactivationWindow: request }, revalidateActivation: async () => {} };
  // The mock response is lost after recording the new checkpoint.
  cut.failAfter = 'checkpoint';
  await assert.rejects(advancePair(retry), /connection lost/u);
  cut.failAfter = null;
  await assert.rejects(advancePair(cut), /durable checkpoint/u);
  assert.equal((await advancePair(retry)).status, 'awaiting-independent-recovery-proof');
});

test('R6 reactivation requires a ready host and the same database, owner and certified pair', () => {
  const original = { hostId: 'host', hostPinSha256: 'pin', databaseSha256: 'db', authSha256: 'owner' };
  const target = { identitySha256: 'certified-pair' };
  const candidate = { image: 'full-image', identity: { version: '1.0.0' } };
  const host = { M: 'ready', H: 'ready', transaction: { phase: 'safe-stopped' },
    backend: { state: 'absent' }, database: { authState: 'ready' } };
  const verified = { host, original, target, candidate, certified: candidate,
    current: { observation: { binding: original }, target } };
  assert.doesNotThrow(() => assertReactivationObservation(verified));
  for (const H of ['drift', 'unknown', 'partial']) {
    assert.throws(() => assertReactivationObservation({ ...verified, host: { ...host, H } }), /ready host/u);
  }
  assert.throws(() => assertReactivationObservation({ ...verified, current: {
    ...verified.current, observation: { binding: { ...original, authSha256: 'foreign-owner' } },
  } }), /prepared owner/u);
  assert.throws(() => assertReactivationObservation({ ...verified, certified: { ...candidate, image: 'different' } }),
    /certified candidate/u);
});
