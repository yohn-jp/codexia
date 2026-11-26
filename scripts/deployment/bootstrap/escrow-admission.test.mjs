import assert from 'node:assert/strict';
import test from 'node:test';
import { digestEvidence } from '../preflight/evidence-digest.mjs';
import { admitExistingEscrow } from './escrow-admission.mjs';

const now = new Date('2026-11-26T00:00:00.000Z');

function fixture(route) {
  const hostPinSha256 = 'a'.repeat(64);
  const host = {format: 'codexia-lifecycle-host/v1', hostId: 'b'.repeat(64), observedAt: now.toISOString(),
    H: 'ready', transaction: null, topology: {secretHashes: {id: 'c'.repeat(64)}},
    database: {state: 'initialized', authState: route === 'R6' ? 'ready' : 'pending'},
    backend: {state: route === 'R6' ? 'absent' : 'setup'}};
  const plan = {format: 'codexia-deployment-plan/v1', candidateRoute: route, intent: 'install',
    blockers: route === 'R6' ? ['missing-preservation-evidence', 'missing-or-expired-window', 'approval-required'] : ['approval-required'],
    observation: {observedAt: now.toISOString(), binding: {hostPinSha256, hostId: host.hostId, databaseSha256: digestEvidence(host.database),
      transactionSha256: digestEvidence(null), infrastructureSha256: digestEvidence({state: host.H, topology: host.topology})}}};
  return {reviewed: {management: 'bootstrap', plan, planSha256: digestEvidence(plan)}, live: {hostPinSha256, host}};
}

test('a reviewed R5 or R6 host may escrow its current identities before activation', () => {
  for (const route of ['R5', 'R6']) {
    const {reviewed, live} = fixture(route);
    assert.deepEqual(admitExistingEscrow(reviewed, live, now), {codexia_escrow_adopt_ids: live.host.topology.secretHashes});
  }
});

test('bootstrap, normal writer, changed secrets, transaction, DB, pin and stale host cannot enter adoption', () => {
  const rejected = [
    ({reviewed}) => { reviewed.plan.candidateRoute = 'R4'; reviewed.planSha256 = digestEvidence(reviewed.plan); },
    ({live}) => { live.host.backend.state = 'running'; },
    ({live}) => { live.host.topology.secretHashes = {}; },
    ({live}) => { live.host.transaction = {phase: 'recovering'}; },
    ({live}) => { live.host.database.authState = 'ready'; },
    ({live}) => { live.hostPinSha256 = 'd'.repeat(64); },
    ({live}) => { live.host.observedAt = '2025-11-26T00:00:00.000Z'; },
    ({reviewed}) => { reviewed.plan.blockers.push('incomplete-state-evidence'); reviewed.planSha256 = digestEvidence(reviewed.plan); },
  ];
  for (const mutate of rejected) {
    const state = fixture('R5');
    mutate(state);
    assert.throws(() => admitExistingEscrow(state.reviewed, state.live, now));
  }
});
