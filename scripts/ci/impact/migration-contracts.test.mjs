import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deploymentFixtureImpact, deploymentMigrationContract } from './migration-contracts.mjs';

const hash = digit => 'sha256:' + digit.repeat(64);
const checked = (apiEpoch = 11, persistenceFormat = 5) => ({
  apiEpoch, frontendApiEpoch: apiEpoch, persistenceFormat, migrationFingerprint: hash('1'),
  authMode: 'better-auth', authSchemaSha256: hash('2'), authSchemas: [hash('2')],
});
const fixture = {
  id: 'api-11-to-12',
  source: { apiEpoch: 11 },
  target: { apiEpoch: 12 },
  requiredAxes: ['api-epoch'],
  optionalAxes: [],
  handler: null,
  fixture: 'scripts/deployment/cutover/migrations/api-11-to-12.test.mjs',
  inputs: ['scripts/deployment/cutover/migrations/api-11-to-12.mjs'],
};

test('a different epoch with unchanged storage and auth requires an explicit no-conversion contract', () => {
  const source = checked();
  const target = checked(12);
  assert.throws(() => deploymentMigrationContract(source, target, []), /No migration contract/);
  assert.equal(deploymentMigrationContract(source, target, [fixture]), fixture);
  assert.throws(() => deploymentMigrationContract(source, target, [fixture, { ...fixture, id: 'other' }]),
    /Ambiguous migration contracts/);
  assert.throws(() => deploymentMigrationContract(source, { ...target, frontendApiEpoch: 11 }, [fixture]),
    /incompatible Backend and Frontend/);
});

test('unsupported format, ledger, and auth changes fail closed', () => {
  const source = checked();
  for (const next of [
    { ...source, persistenceFormat: 6 },
    { ...source, migrationFingerprint: hash('3') },
    { ...source, authMode: 'new-auth-mode' },
    { ...source, authSchemaSha256: hash('4'), authSchemas: [hash('4')] },
  ]) assert.throws(() => deploymentMigrationContract(source, next, [fixture]), /No migration contract/);
  assert.equal(deploymentMigrationContract(source, { ...source }, []), null);
});

test('a contract change selects its own fixture and a common change selects all fixtures', () => {
  const other = {
    ...fixture, id: 'api-12-to-13', fixture: 'scripts/deployment/cutover/migrations/api-12-to-13.test.mjs',
    inputs: ['scripts/deployment/cutover/migrations/api-12-to-13.mjs'],
  };
  const options = { contracts: [fixture, other], fixtureType: () => 'node' };
  assert.deepEqual(deploymentFixtureImpact({ ...options, files: ['packages/api/src/manuscript.ts',
    'docs/deployment/DEPLOYMENT-LIFECYCLE.md'] }), []);
  assert.deepEqual(deploymentFixtureImpact({ ...options, files: fixture.inputs }).map(row => row.id), [fixture.id]);
  assert.deepEqual(deploymentFixtureImpact({ ...options,
    files: ['scripts/deployment/cutover/coordinator.mjs'] }).map(row => row.id), ['shared', fixture.id, other.id]);
  assert.deepEqual(deploymentFixtureImpact({ ...options,
    files: ['deploy/update-compatibility.json'], transition: fixture }).map(row => row.id), [fixture.id]);
  assert.throws(() => deploymentFixtureImpact({ ...options, files: null, fixtureType: () => { throw new Error('Missing test'); } }),
    /Missing test/);
});

test('certification requires each selected migration proof once at the normal source-bound job boundary', async () => {
  const { assertDeploymentFixtureJobs } = await import('../evidence/validation.mjs');
  const job = { name: 'deployment-cutover / Verify selected deployment fixtures', status: 'completed', conclusion: 'success',
    steps: [{ name: 'Run selected deployment fixtures', status: 'completed', conclusion: 'success' }] };
  const selected = [{ id: 'api-11-to-12', kind: 'node' }];
  assert.doesNotThrow(() => assertDeploymentFixtureJobs([job], selected));
  for (const jobs of [[], [job, job], [{ ...job, conclusion: 'skipped' }], [{ ...job, steps: [] }]]) {
    assert.throws(() => assertDeploymentFixtureJobs(jobs, selected));
  }
  assert.throws(() => assertDeploymentFixtureJobs([job], []), /selected deployment fixture jobs/);
});
