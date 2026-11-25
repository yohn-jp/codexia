import assert from 'node:assert/strict';
import test from 'node:test';
import { approvedMigration, migrationContracts, resolveMigrationContracts } from './transitions.mjs';

const ledger = 'sha256:' + 'a'.repeat(64);
const schema = 'sha256:' + 'b'.repeat(64);
const state = { D: 'incompatible', A: 'ready' };
const backend = (apiEpoch, persistenceFormat) => ({ profile: 'full', apiEpoch, persistenceFormat, migrationFingerprint: ledger });
const evidence = {
  source: { backend: backend(1, 1), authMode: 'better-auth', authSchemaSha256: schema },
  target: { backend: backend(2, 2), authSchemas: [schema] },
  state, changeAxes: ['backend', 'frontend', 'persistence-format', 'api-epoch', 'oauth-contract'],
};

test('the existing format conversion resolves once and binds its contract', () => {
  const matches = resolveMigrationContracts(evidence);
  assert.equal(matches.length, 1);
  assert.equal(matches[0].dataConversion, true);
  assert.match(matches[0].contractSha256, /^[a-f0-9]{64}$/u);
  assert.equal(resolveMigrationContracts(evidence, [...migrationContracts, ...migrationContracts]).length, 2);
});

test('unknown or unsupported source, ledger and auth changes fail closed', () => {
  for (const input of [
    { source: null }, { source: { ...evidence.source, authMode: 'legacy' } },
    { target: { ...evidence.target, authSchemas: [] } },
    { target: { ...evidence.target, backend: { ...evidence.target.backend, migrationFingerprint: 'sha256:' + 'c'.repeat(64) } } },
    { changeAxes: [...evidence.changeAxes, 'sql-ledger'] },
  ]) assert.deepEqual(resolveMigrationContracts({ ...evidence, ...input }), []);
});

test('a future API-only contract requires no changes to the resolver and requests no conversion', () => {
  const future = {
    id: 'fixture-api-45-to-46', source: { apiEpoch: 45 }, target: { apiEpoch: 46 },
    requiredAxes: ['api-epoch'], optionalAxes: ['oauth-contract'], handler: null,
    fixture: 'scripts/deployment/cutover/transitions.test.mjs',
  };
  const apiOnly = {
    ...evidence, state: { ...state, D: 'compatible' },
    source: { ...evidence.source, backend: backend(45, 7) },
    target: { ...evidence.target, backend: backend(46, 7) },
    changeAxes: ['backend', 'frontend', 'api-epoch'],
  };
  assert.deepEqual(resolveMigrationContracts(apiOnly), []);
  assert.equal(resolveMigrationContracts(apiOnly, [future])[0].dataConversion, false);
  assert.deepEqual(resolveMigrationContracts({ ...apiOnly, target: { ...apiOnly.target, backend: backend(46, 8) } }, [future]), []);
});

test('the registered MCP API epoch transition is exact and leaves compatible persistence untouched', () => {
  const contract = migrationContracts.find(value => value.id === 'mcp-v2-api-2-to-3');
  assert.ok(contract);
  assert.deepEqual(contract.source, { apiEpoch: 2, persistenceFormat: 2 });
  assert.deepEqual(contract.target, { apiEpoch: 3, persistenceFormat: 2 });
  assert.deepEqual(contract.requiredAxes, ['api-epoch']);
  assert.deepEqual(contract.optionalAxes, []);
  assert.equal(contract.handler, null);

  const apiOnly = {
    source: { ...evidence.source, backend: backend(2, 2) },
    target: { ...evidence.target, backend: backend(3, 2) },
    state: { A: 'ready', D: 'compatible' },
    changeAxes: ['backend', 'frontend', 'api-epoch'],
  };
  const [resolved] = resolveMigrationContracts(apiOnly);
  assert.ok(resolved);
  assert.equal(resolved.dataConversion, false);
  assert.equal(approvedMigration(resolved).handler, null);

  for (const rejected of [
    { source: { ...apiOnly.source, backend: backend(1, 2) } },
    { target: { ...apiOnly.target, backend: backend(4, 2) } },
    { source: { ...apiOnly.source, backend: backend(2, 1) } },
    { target: { ...apiOnly.target, backend: backend(3, 3) } },
    { target: { ...apiOnly.target, authSchemas: ['sha256:' + 'c'.repeat(64)] } },
    { changeAxes: [...apiOnly.changeAxes, 'auth-schema'] },
  ]) {
    assert.deepEqual(resolveMigrationContracts({ ...apiOnly, ...rejected }), []);
  }
});
