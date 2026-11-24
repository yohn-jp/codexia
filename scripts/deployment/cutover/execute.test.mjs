import assert from 'node:assert/strict';
import test from 'node:test';
import { advancePair } from './execute.mjs';

const approved = 'a'.repeat(64);
const timestamp = '2026-11-23T12:00:00.000Z';
const origin = 'https://fixture.example.test';

function fixture({ first = false, changeWorker = true } = {}) {
  const calls = [];
  const plan = {
    environment: { origin },
    prior: { image: first ? null : 'installed', workerVersion: first ? null : 'old' },
    candidate: { image: 'certified', workerVersion: changeWorker ? 'new' : 'old', frontendArtifact: { artifactDigest: approved } },
  };
  let phase = null;
  let owner = null;
  let outcome;
  let fenced = false;
  let workerVersion = plan.prior.workerVersion;
  const cut = {
    operation: 'advance',
    plan, planSha256: approved, request: {},
    async host(action, request) {
      if (action === 'observe') return { phase, planSha256: owner, outcome, phaseChangedAt: timestamp };
      calls.push(action);
      if (owner && owner !== approved) throw new Error('foreign plan');
      if (action === 'admit') owner = approved;
      outcome = request.outcome ?? outcome;
      phase = { admit: 'intent', checkpoint: 'checkpointed', apply: 'candidate-ready',
        'open-tunnel': outcome + '-tunnel', publishing: outcome + '-publishing', finish: 'finished',
        'recover-quiesce': 'recovering', recover: first ? 'safe-stopped' : 'prior-ready' }[action];
      if (cut.failAfter === action) throw new Error('connection lost');
      return { status: phase };
    },
    edge: {
      async fence() { calls.push('fence'); fenced = true; },
      async unfence() { assert.match(phase, /-publishing$/u); calls.push('unfence'); fenced = false; },
      async verifyFenced() { assert.ok(fenced); },
      async verifyUnfenced() { assert.ok(!fenced); },
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
  return { cut, calls, compete() { owner = 'foreign'; phase = 'intent'; } };
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
