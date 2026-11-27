import assert from 'node:assert/strict';
import test from 'node:test';
import { STATES, selectRoute, createDeploymentPlan, assertDeploymentPlanApproval } from './plan.mjs';

const ready = { M: 'ready', H: 'ready', D: 'compatible', A: 'ready', B: 'compatible', F: 'compatible', T: 'none' };
const select = (state, intent = 'update', admission = 'allowed') => selectRoute({ ...ready, ...state }, intent, admission);
test('lifecycle route table preserves absence, recovery and ordinary admission', () => {
  const empty = { H: 'absent', D: 'absent', A: 'absent', B: 'absent', F: 'absent' };
  const cases = [
    [{ M: 'unknown' }, 'update', 'allowed', 'R0'],
    [{ T: 'resume', B: 'fault' }, 'update', 'denied', 'R1'],
    [{ T: 'recover', H: 'drift' }, 'restore', 'unknown', 'R1'],
    [{ T: 'unknown' }, 'restore', 'allowed', 'R0'],
    [{ D: 'lost' }, 'restore', 'unknown', 'R2'],
    [{ D: 'lost' }, 'install', 'allowed', 'R0'],
    [{ D: 'incompatible', B: 'incompatible' }, 'maintenance', 'denied', 'R0'],
    [{ A: 'legacy', B: 'incompatible' }, 'maintenance', 'denied', 'R0'],
    [{ F: 'fault', B: 'absent' }, 'install', 'denied', 'R3'],
    [empty, 'install', 'not-applicable', 'R4'],
    [{ ...empty, H: 'partial' }, 'install', 'not-applicable', 'R4'],
    [{ H: 'ready', D: 'absent', A: 'absent', B: 'fault', F: 'incompatible' }, 'install', 'denied', 'R4'],
    [{ H: 'ready', D: 'absent', A: 'absent', B: 'fault', F: 'incompatible', T: 'recover' }, 'install', 'denied', 'R1'],
    [{ H: 'drift', D: 'absent', A: 'absent', B: 'fault' }, 'install', 'denied', 'R3'],
    [{ D: 'unknown', A: 'absent', B: 'fault' }, 'install', 'denied', 'R0'],
    [empty, 'restore', 'not-applicable', 'R0'],
    [empty, 'update', 'not-applicable', 'R0'],
    [{ A: 'pending', B: 'setup', F: 'absent' }, 'install', 'not-applicable', 'R5'],
    [{ A: 'unprepared', B: 'absent' }, 'install', 'not-applicable', 'R5'],
    [{ A: 'pending', B: 'absent' }, 'adopt', 'not-applicable', 'R0'],
    [{ B: 'absent', F: 'absent' }, 'install', 'not-applicable', 'R0'],
    [{ B: 'absent', F: 'incompatible' }, 'install', 'denied', 'R0'],
    [{ B: 'absent' }, 'install', 'allowed', 'R6'],
    [{ B: 'absent' }, 'adopt', 'allowed', 'R6'],
    [{ B: 'absent' }, 'update', 'allowed', 'R0'],
    [{ B: 'incompatible' }, 'update', 'denied', 'R0'],
    [{ F: 'absent' }, 'update', 'not-applicable', 'R0'],
    [{ F: 'incompatible' }, 'update', 'denied', 'R0'],
    [{ F: 'incompatible' }, 'update', 'allowed', 'R8'],
    [{ F: 'incompatible' }, 'update', 'unknown', 'R0'],
    [{}, 'update', 'allowed', 'R8'],
    [{}, 'update', 'denied', 'R0'],
    [{ D: 'pristine' }, 'install', 'allowed', 'R0'],
  ];
  for (const [state, intent, admission, expected] of cases) {
    assert.equal(select(state, intent, admission), expected, JSON.stringify({state, intent, admission}));
  }
});

test('every combination of observation axes has exactly one route or safe stop', () => {
  const keys = Object.keys(STATES);
  const reached = new Set();
  let count = 0;
  function visit(state, i) {
    if (i < keys.length) {
      for (const value of STATES[keys[i]]) visit({ ...state, [keys[i]]: value }, i + 1);
      return;
    }
    for (const intent of ['install', 'adopt', 'update', 'maintenance', 'restore']) {
      for (const admission of ['allowed', 'denied', 'not-applicable', 'unknown']) {
        const result = selectRoute(state, intent, admission);
        count++;
        assert.match(result, /^R[0-68]$/u);
        if (state.M !== 'ready' || state.T === 'unknown') assert.equal(result, 'R0');
        else if (state.T !== 'none') assert.equal(result, 'R1');
        else if (state.D === 'lost') assert.equal(result, intent === 'restore' ? 'R2' : 'R0');
        else if (Object.values(state).includes('unknown')) assert.equal(result, 'R0');
        if (result === 'R5') assert.equal(intent, 'install');
        if (result === 'R6') assert.ok(['install', 'adopt'].includes(intent));
        if (result === 'R8') {
          assert.equal(state.B, 'compatible');
          assert.equal(admission, 'allowed');
        }
        reached.add(result);
      }
    }
  }
  visit({}, 0);
  assert.equal(count, Object.values(STATES).reduce((n, values) => n * values.length, 20));
  assert.deepEqual([...reached].sort(), ['R0','R1','R2','R3','R4','R5','R6','R8']);
});

const h = char => char.repeat(64);
const now = new Date('2026-11-24T04:00:00.000Z');
const baseline = () => ({
  observation: { state: { ...ready, B: 'absent' }, observedAt: now.toISOString(),
    binding: { environment: 'codexia-production', hostPinSha256: h('a'), hostId: h('b'),
      databaseSha256: h('c'), authSha256: h('d'), backendSha256: h('e'), frontendSha256: h('f'),
      ingressSha256: h('1'), transactionSha256: h('2'), infrastructureSha256: h('3'), backupSha256: h('4') },
    frontendAdmission: 'denied', changeAxes: ['backend'] },
  target: { backendCertificateSha256: h('5'), frontendArtifactSha256: h('6'), identitySha256: h('7') },
  intent: 'install', window: { id: 'window-1', notBefore: now.toISOString(),
    notAfter: '2026-11-24T05:00:00.000Z' }, now,
});

test('adoption of an existing Better Auth owner demands independent preservation evidence', () => {
  const input = { ...baseline(), intent: 'adopt', observation: {
    ...baseline().observation, binding: { ...baseline().observation.binding, backupSha256: null },
  } };
  const withoutProof = createDeploymentPlan(input);
  assert.equal(withoutProof.plan.candidateRoute, 'R6');
  assert.ok(withoutProof.plan.blockers.includes('missing-preservation-evidence'));
  const withProof = createDeploymentPlan({ ...input, observation: {
    ...input.observation, binding: { ...input.observation.binding, backupSha256: h('9') },
  } });
  assert.equal(withProof.plan.candidateRoute, 'R6');
  assert.deepEqual(withProof.plan.requiredApprovals, ['database-adoption', 'publication']);
  assert.ok(withProof.plan.requiresPreservation);
});

test('incompatible installed states and missing frontend stop without mutation admission', () => {
  const input = baseline();
  for (const state of [
    { B: 'incompatible', F: 'incompatible' },
    { B: 'compatible', F: 'absent' },
    { B: 'compatible', D: 'incompatible' },
    { B: 'compatible', A: 'legacy' },
    { B: 'absent', F: 'absent' },
    { B: 'absent', F: 'incompatible' },
  ]) {
    const { plan, planSha256 } = createDeploymentPlan({
      ...input, observation: { ...input.observation, state: { ...ready, ...state } },
    });
    assert.equal(plan.candidateRoute, 'R0');
    assert.equal(plan.route, 'R0');
    assert.deepEqual(plan.requiredApprovals, []);
    assert.ok(plan.blockers.includes('state-or-intent-not-admitted'));
    assert.throws(() => assertDeploymentPlanApproval({ plan, planSha256,
      approval: { planSha256, grants: [] }, current: plan, now }), /blocked or altered/);
  }
});

test('first activation keeps exact evidence and freshness requirements without a backup receipt', () => {
  const input = baseline();
  const { plan, planSha256 } = createDeploymentPlan(input);
  assert.equal(plan.candidateRoute, 'R6');
  assert.equal(plan.route, 'R0');
  assert.deepEqual(plan.blockers, ['approval-required']);
  assert.deepEqual(plan.requiredApprovals, ['first-install', 'database-use', 'publication']);
  assert.match(planSha256, /^[a-f0-9]{64}$/u);
  const missing = baseline();
  missing.observation.binding.backupSha256 = null;
  const fresh = createDeploymentPlan(missing).plan;
  assert.deepEqual(fresh.blockers, ['approval-required']);
  assert.equal(fresh.requiresPreservation, false);
  for (const [state, intent, route] of [
    [{ B: 'absent', H: 'partial' }, 'adopt', 'R4'],
    [{ B: 'absent', H: 'partial' }, 'install', 'R4'],
    [{ D: 'lost' }, 'restore', 'R2'],
    [{ H: 'drift' }, 'maintenance', 'R3'],
  ]) {
    const { plan: protectedPlan } = createDeploymentPlan({ ...missing, intent,
      observation: { ...missing.observation, state: { ...ready, ...state } } });
    assert.equal(protectedPlan.candidateRoute, route);
    assert.equal(protectedPlan.requiresPreservation, true);
    assert.ok(protectedPlan.blockers.includes('missing-preservation-evidence'));
  }
  assert.throws(() => createDeploymentPlan({ ...input, now: new Date('2026-11-24T04:06:00.000Z') }), /Stale/);
  assert.throws(() => createDeploymentPlan({ ...input, target: { ...input.target, token: 'secret' } }), /candidate evidence/);
});

test('approval is bound to the exact plan and fresh post-queue observation', () => {
  const input = baseline();
  const result = createDeploymentPlan(input);
  const later = new Date('2026-11-24T04:01:00.000Z');
  const request = () => ({ ...structuredClone(result), approval: { planSha256: result.planSha256, grants: ['first-install', 'database-use', 'publication'] },
    current: { ...structuredClone(input), observation: { ...structuredClone(input.observation), observedAt: later.toISOString() } },
    now: later });
  assert.equal(assertDeploymentPlanApproval(request()), result.planSha256);
  for (const mutate of [
    r => { r.plan.intent = 'update'; },
    r => { r.approval.grants = []; },
    r => { r.approval.planSha256 = h('9'); },
    r => { r.current.observation.binding.hostId = h('9'); },
    r => { r.current.observation.binding.databaseSha256 = h('9'); },
    r => { r.current.observation.binding.transactionSha256 = h('9'); },
    r => { r.current.target.identitySha256 = h('9'); },
    r => { r.current.window.id = 'other'; },
    r => { r.current.observation.state.T = 'resume'; },
    r => { r.now = new Date('2026-11-24T04:10:00.000Z'); },
  ]) {
    const value = request();
    mutate(value);
    assert.throws(() => assertDeploymentPlanApproval(value));
  }
});
