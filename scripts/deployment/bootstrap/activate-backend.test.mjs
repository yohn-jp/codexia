import assert from 'node:assert/strict';
import test from 'node:test';
import { digestEvidence } from '../preflight/evidence-digest.mjs';
import { createDeploymentPlan } from '../preflight/plan.mjs';
import { admitBackendActivation, admitBackendAdoption, admitBackendRecovery, assertManualActivationSource } from './activate-backend.mjs';

const hash = 'a'.repeat(64);
const now = new Date('2026-11-24T06:00:00.000Z');
const window = { id: 'r6', notBefore: '2026-11-24T05:58:00.000Z', notAfter: '2026-11-24T06:05:00.000Z' };
const flags = { initialInstall: true, databaseUse: true };

test('manual activation keeps a still-current certified Backend on the reviewed live main', () => {
  const certified = 'a'.repeat(40), reviewed = 'b'.repeat(40), advanced = 'c'.repeat(40);
  const git = (checkout, files) => (operation, ...args) => {
    if (operation === 'rev-parse') {
      assert.deepEqual(args, ['HEAD']);
      return checkout + '\n';
    }
    if (operation === 'rev-list') {
      assert.deepEqual(args, ['--first-parent', reviewed]);
      return reviewed + '\n' + certified + '\n';
    }
    assert.equal(operation, 'diff');
    assert.deepEqual(args, ['--name-only', '--no-renames', '-z', certified, reviewed, '--']);
    return files.join('\0');
  };
  assert.doesNotThrow(() => assertManualActivationSource(certified, reviewed, reviewed, git(reviewed, ['docs/notes.md'])));
  assert.throws(() => assertManualActivationSource(certified, reviewed, reviewed, git(reviewed, ['packages/api/src/server.ts'])),
    /newer Backend inputs/);
  assert.throws(() => assertManualActivationSource(certified, reviewed, advanced, git(reviewed, [])), /live main/);
  assert.throws(() => assertManualActivationSource(certified, reviewed, reviewed, git(certified, [])), /checkout/);
});

function fixture(state = {}, binding = {}, intent = 'install') {
  const current = createDeploymentPlan({
    observation: {
      state: { M: 'ready', H: 'ready', D: 'compatible', A: 'ready', B: 'absent', F: 'compatible', T: 'none', ...state },
      observedAt: now.toISOString(), frontendAdmission: 'denied', changeAxes: ['backend'],
      binding: {
        environment: 'codexia-production', hostPinSha256: hash, hostId: hash, databaseSha256: hash, authSha256: hash,
        backendSha256: hash, frontendSha256: hash, ingressSha256: hash, transactionSha256: hash,
        infrastructureSha256: hash, backupSha256: null, ...binding,
      },
    },
    target: { backendCertificateSha256: hash, frontendArtifactSha256: hash, identitySha256: hash },
    intent, window, now,
  });
  const { plan, planSha256 } = current;
  return {
    current: plan, now, flags,
    deployment: { plan, planSha256, approval: { planSha256, grants: ['first-install', 'database-use', 'publication'] } },
    host: { hostId: hash, topology: { secretHashes: { 'codexia-auth-secret': hash } }, database: { clusterId: '123', databaseOid: '456', settingsSha256: hash,
      ownerBindingSha256: 'sha256:' + hash } },
  };
}

test('R6 admits only a clean first Backend with a compatible live Frontend', () => {
  assert.deepEqual(admitBackendActivation(fixture()), {
    hostId: hash, clusterId: '123', databaseOid: '456', settingsSha256: hash,
    ownerBindingSha256: 'sha256:' + hash,
    secretSetSha256: digestEvidence(fixture().host.topology.secretHashes),
    notBeforeMs: Date.parse(window.notBefore), notAfterMs: Date.parse(window.notAfter),
  });
  for (const F of ['absent', 'incompatible', 'fault', 'unknown']) {
    assert.throws(() => admitBackendActivation(fixture({ F })), /compatible deployed Frontend/);
  }
  assert.throws(() => admitBackendActivation(fixture({ B: 'compatible' })), /compatible deployed Frontend/);
  assert.throws(() => admitBackendActivation(fixture({}, {}, 'adopt')), /compatible deployed Frontend/);
  const unobserved = fixture();
  delete unobserved.host.topology;
  assert.throws(() => admitBackendActivation(unobserved), /observed Podman credential identities/);
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

test('R6 adoption requires distinct protected approval, preserved data and existing owner', () => {
  const input = fixture({}, { backupSha256: 'b'.repeat(64) }, 'adopt');
  input.deployment.approval.grants = ['database-adoption', 'publication'];
  const approved = { databaseAdoption: true, initialInstall: false, databaseInitialization: false };
  const result = admitBackendAdoption({ ...input, flags: approved });
  assert.equal(result.clusterId, '123');
  assert.equal(result.ownerBindingSha256, 'sha256:' + hash);
  assert.equal(result.preservationSha256, 'b'.repeat(64));
  for (const flags of [
    { ...approved, databaseAdoption: false },
    { ...approved, initialInstall: true },
    { ...approved, databaseInitialization: true },
  ]) assert.throws(() => admitBackendAdoption({ ...input, flags }), /distinct protected approval/);
  assert.throws(() => admitBackendAdoption({ ...input,
    current: fixture({}, { frontendSha256: 'c'.repeat(64) }, 'adopt').current,
    flags: approved }), /changed after approval/);
  assert.throws(() => admitBackendAdoption({ ...fixture({}, {}, 'adopt'), flags: approved }),
    /preservation evidence/);
});

test('R3 binds manual publication to the same observed restore operation and evidence', () => {
  const input = fixture();
  const operationId = 'recovery-one', evidenceSha256 = 'b'.repeat(64);
  const { plan, planSha256 } = createDeploymentPlan({
    ...input.current, intent: 'restore', now,
    observation: { ...input.current.observation, recoveryOperationId: operationId,
      binding: { ...input.current.observation.binding, backupSha256: evidenceSha256 } },
  });
  const host = { ...input.host, recovery: { operationId, evidenceSha256 } };
  const deployment = { plan, planSha256, approval: {
    planSha256, grants: ['maintenance', 'recovery', 'publication'],
  } };
  const args = { ...input, current: plan, host, deployment };
  const admission = admitBackendRecovery(args);
  assert.equal(admission.operationId, operationId);
  assert.equal(admission.evidenceSha256, evidenceSha256);
  assert.equal(admission.databaseOid, '456');
  assert.throws(() => admitBackendRecovery({ ...args, host: {
    ...host, recovery: { ...host.recovery, evidenceSha256: hash },
  } }), /protected recovery evidence/u);
  assert.throws(() => admitBackendRecovery(input), /approved R3/u);
  assert.throws(() => admitBackendActivation(args), /first activation/u);
});
