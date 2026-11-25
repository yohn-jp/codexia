import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveMigrationContracts } from './transitions.mjs';

const ledger = 'sha256:' + 'a'.repeat(64);
const schema = 'sha256:' + 'b'.repeat(64);
const state = { D: 'incompatible', A: 'ready' };
const backend = (apiEpoch, persistenceFormat) => ({ profile: 'full', apiEpoch, persistenceFormat, migrationFingerprint: ledger });
const retiredConversion = {
  source: { backend: backend(1, 1), authMode: 'better-auth', authSchemaSha256: schema },
  target: { backend: backend(2, 2), authSchemas: [schema] },
  state, changeAxes: ['backend', 'frontend', 'persistence-format', 'api-epoch', 'oauth-contract'],
};

test('the retired persistence and API-only transitions have no deployment contract', () => {
  assert.deepEqual(resolveMigrationContracts(retiredConversion), []);
  assert.deepEqual(resolveMigrationContracts({
    ...retiredConversion,
    source: { ...retiredConversion.source, backend: backend(2, 2) },
    target: { ...retiredConversion.target, backend: backend(3, 2) },
    state: { ...state, D: 'compatible' },
    changeAxes: ['backend', 'frontend', 'api-epoch'],
  }), []);
});

const future = {
  id: 'fixture-api-45-to-46', source: { apiEpoch: 45 }, target: { apiEpoch: 46 },
  requiredAxes: ['api-epoch'], optionalAxes: ['oauth-contract'], handler: null,
  fixture: 'scripts/deployment/cutover/transitions.test.mjs',
};
const evidence = {
  ...retiredConversion, state: { ...state, D: 'compatible' },
  source: { ...retiredConversion.source, backend: backend(45, 7) },
  target: { ...retiredConversion.target, backend: backend(46, 7) },
  changeAxes: ['backend', 'frontend', 'api-epoch'],
};

test('unknown or unsupported source, ledger and auth changes fail closed', () => {
  for (const input of [
    { source: null }, { source: { ...evidence.source, authMode: 'legacy' } },
    { target: { ...evidence.target, authSchemas: [] } },
    { target: { ...evidence.target, backend: { ...evidence.target.backend, migrationFingerprint: 'sha256:' + 'c'.repeat(64) } } },
    { changeAxes: [...evidence.changeAxes, 'sql-ledger'] },
  ]) assert.deepEqual(resolveMigrationContracts({ ...evidence, ...input }, [future]), []);
});

test('a future API-only contract requires no changes to the resolver and requests no conversion', () => {
  assert.deepEqual(resolveMigrationContracts(evidence), []);
  assert.equal(resolveMigrationContracts(evidence, [future])[0].dataConversion, false);
  assert.deepEqual(resolveMigrationContracts({ ...evidence, target: { ...evidence.target, backend: backend(46, 8) } }, [future]), []);
});
