import assert from 'node:assert/strict';
import test from 'node:test';
import { deploymentFixtureImpact, deploymentMigrationContract } from '../../../ci/impact/migration-contracts.mjs';
import { advancePair } from '../execute.mjs';
import { digestEvidence } from '../coordinator.mjs';
import { approvedMigration, migrationContracts, resolveMigrationContracts } from '../transitions.mjs';

const hash = digit => 'sha256:' + digit.repeat(64);
const contract = migrationContracts.find(value => value.id === 'mcp-v2-api-2-to-3');
assert.ok(contract);

const identity = (apiEpoch, persistenceFormat = 2) => ({
  profile: 'full', apiEpoch, frontendApiEpoch: apiEpoch, persistenceFormat,
  migrationFingerprint: hash('a'), authMode: 'better-auth',
  authSchemaSha256: hash('b'), authSchemas: [hash('b')],
});

function coordinatorEvidence() {
  return {
    source: { backend: identity(2), authMode: 'better-auth', authSchemaSha256: hash('b') },
    target: { backend: identity(3), authSchemas: [hash('b')] },
    state: { A: 'ready', D: 'compatible' },
    changeAxes: ['backend', 'frontend', 'api-epoch'],
  };
}

test('the coordinator accepts the known epoch 2 to 3 source with unchanged storage and authentication', () => {
  const accepted = coordinatorEvidence();
  assert.deepEqual(resolveMigrationContracts(accepted), [{
    contractSha256: digestEvidence(contract), dataConversion: false,
  }]);
  assert.equal(approvedMigration(resolveMigrationContracts(accepted)[0]).id, 'mcp-v2-api-2-to-3');

  const source = identity(2);
  const target = identity(3);
  assert.equal(deploymentMigrationContract(source, target), contract);
  assert.deepEqual(deploymentFixtureImpact({ files: [contract.fixture] }).map(row => row.id), [contract.id]);
});

test('unrelated API or persistence epochs and authentication schema changes are refused', () => {
  const accepted = coordinatorEvidence();
  for (const rejected of [
    { source: { ...accepted.source, backend: identity(1) } },
    { target: { ...accepted.target, backend: identity(4) } },
    { source: { ...accepted.source, backend: identity(2, 1) } },
    { target: { ...accepted.target, backend: identity(3, 3) } },
    { target: { ...accepted.target, authSchemas: [hash('c')] } },
  ]) {
    assert.deepEqual(resolveMigrationContracts({ ...accepted, ...rejected }), []);
  }
  assert.throws(() => deploymentMigrationContract(identity(1), identity(3)), /No migration contract/u);
  assert.throws(() => deploymentMigrationContract(identity(2, 1), identity(3, 2)), /No migration contract/u);
  assert.throws(() => deploymentMigrationContract({ ...identity(2), authSchemas: [hash('c')] }, identity(3)), /No migration contract/u);
});

test('API-only acceptance does not weaken the existing guarded rollback after publication', async () => {
  const transition = resolveMigrationContracts(coordinatorEvidence())[0];
  assert.equal(transition.dataConversion, false);
  assert.equal(approvedMigration(transition).handler, null);

  const planSha256 = 'd'.repeat(64);
  const calls = [];
  const plan = {
    prior: { image: 'prior-image', workerVersion: 'prior-worker' },
    candidate: { image: 'candidate-image', workerVersion: 'candidate-worker',
      frontendArtifact: { artifactDigest: 'e'.repeat(64) } },
  };
  await assert.rejects(advancePair({
    operation: 'recover', plan, planSha256, request: {},
    async verifyIngress() { return { fence: { enabled: true } }; },
    async host(action) {
      calls.push(action);
      return { planSha256, phase: 'candidate-publishing', outcome: 'candidate' };
    },
  }), /Publication may admit writes; destructive rollback is blocked/u);
  assert.deepEqual(calls, ['observe']);
});
