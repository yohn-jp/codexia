import assert from 'node:assert/strict';
import test from 'node:test';
import { createDeploymentPlan } from '../preflight/plan.mjs';
import { admitBackendActivation } from './activate-backend.mjs';

const hash = 'a'.repeat(64);
const now = new Date('2026-11-24T06:00:00.000Z');
const window = { id: 'r6', notBefore: '2026-11-24T05:58:00.000Z', notAfter: '2026-11-24T06:05:00.000Z' };
const flags = { initialInstall: true, databaseUse: true };

function fixture(state = {}, binding = {}) {
  const current = createDeploymentPlan({
    observation: {
      state: { M: 'ready', H: 'ready', D: 'compatible', A: 'ready', B: 'absent', F: 'compatible', T: 'none', ...state },
      observedAt: now.toISOString(), frontendAdmission: 'denied', changeAxes: ['backend'],
      binding: {
        environment: 'codexia-production', hostPinSha256: hash, hostId: hash, databaseSha256: hash, authSha256: hash,
        backendSha256: hash, frontendSha256: hash, ingressSha256: hash, transactionSha256: hash,
        infrastructureSha256: hash, backupSha256: hash, ...binding,
      },
    },
    target: { backendCertificateSha256: hash, frontendArtifactSha256: hash, identitySha256: hash },
    intent: 'install', window, now,
  });
  const { plan, planSha256 } = current;
  return {
    current: plan, now, flags,
    deployment: { plan, planSha256, approval: { planSha256, grants: ['first-install', 'database-use', 'publication'] } },
    host: { hostId: hash, database: { clusterId: '123', databaseOid: '456', settingsSha256: hash,
      ownerBindingSha256: 'sha256:' + hash } },
  };
}

test('R6 admits only a preserved clean first Backend with a compatible live Frontend', () => {
  assert.deepEqual(admitBackendActivation(fixture()), {
    hostId: hash, clusterId: '123', databaseOid: '456', settingsSha256: hash,
    ownerBindingSha256: 'sha256:' + hash,
    notBeforeMs: Date.parse(window.notBefore), notAfterMs: Date.parse(window.notAfter),
  });
  for (const F of ['absent', 'incompatible', 'fault', 'unknown']) {
    assert.throws(() => admitBackendActivation(fixture({ F })), /compatible deployed Frontend/);
  }
  assert.throws(() => admitBackendActivation(fixture({ B: 'compatible' })), /compatible deployed Frontend/);
  assert.throws(() => admitBackendActivation(fixture({}, { backupSha256: null })), /blocked or altered/);
});

test('R6 rejects missing approvals, stale binding and mismatched source', () => {
  const input = fixture();
  assert.throws(() => admitBackendActivation({ ...input, flags: { ...flags, databaseUse: false } }), /protected approvals/);
  assert.throws(() => admitBackendActivation({ ...input, deployment: {
    ...input.deployment, approval: { ...input.deployment.approval, grants: ['first-install', 'database-use'] },
  } }), /Approval/);
  assert.throws(() => admitBackendActivation({ ...input, current: fixture({}, { frontendSha256: 'b'.repeat(64) }).current }), /changed after approval/);
  assert.throws(() => admitBackendActivation({ ...input, now: new Date(Date.parse(window.notAfter) + 1) }), /window/);
});
