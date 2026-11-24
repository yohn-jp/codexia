import assert from 'node:assert/strict';
import { assertDeploymentPlanApproval, assertFreshObservationTime } from '../preflight/plan.mjs';

const stages = ['host', 'secrets', 'base', 'auth-runtime'];

export function admitBootstrap({ mode, plan, planSha256, current, topology,
  initializeDatabase = false, now = new Date() }) {
  const route = { bootstrap: 'R4', 'owner-setup': 'R5', 'prepare-activation': 'R5' }[mode];
  assert.ok(route, 'Unsupported bootstrap admission mode');
  assertFreshObservationTime(current.observation.observedAt, { now });
  assert.ok(Date.parse(plan?.observation?.observedAt) <= Date.parse(current.observation.observedAt),
    'Invalid approved observation timestamp');
  assert.equal(plan.candidateRoute, route, 'Observed deployment route does not admit this operation');
  const grants = route === 'R4' ? ['bootstrap'] : ['owner-enrollment'];
  if (initializeDatabase) {
    assert.equal(route, 'R4', 'Only bootstrap can initialize the database');
    grants.push('database-initialization');
  }
  assertDeploymentPlanApproval({ plan, planSha256, approval: { planSha256, grants }, current, now });

  const state = plan.observation.state;
  if (route === 'R5') {
    const expected = mode === 'owner-setup' ? 'pending' : 'unprepared';
    assert.equal(state.A, expected, 'Observed owner state does not admit this operation');
    return { route, stages: [], installIntent: false };
  }
  const needsHost = topology?.hostReady !== true;
  const needsSecrets = ['codexia-tunnel-token', 'codexia-postgres-admin-password', 'codexia-postgres-app-password']
    .some(secret => topology?.secrets?.[secret] !== true);
  const needsBase = state.H !== 'ready' || state.D !== 'compatible';
  const needsAuth = state.A === 'absent';
  const required = [needsHost, needsSecrets, needsBase, needsAuth];
  return {
    route, stages: stages.filter((_, index) => required[index]),
    installIntent: needsAuth && plan.intent === 'install' && initializeDatabase,
  };
}
