import { digestEvidence } from './coordinator.mjs';
import { migrationContracts } from './migrations/catalog.mjs';
export { migrationContracts } from './migrations/catalog.mjs';
const compatibilityAxes = ['api-epoch', 'oauth-contract', 'sql-ledger', 'persistence-format', 'auth-schema', 'auth-mode'];
const taggedHash = /^sha256:[a-f0-9]{64}$/u;

export function matchesMigrationContract(contract, sourceBackend, targetBackend, changeAxes) {
  if (!sourceBackend || !targetBackend) return false;
  const axes = changeAxes.filter(axis => compatibilityAxes.includes(axis));
  return contract.requiredAxes.every(axis => axes.includes(axis)) &&
    axes.every(axis => contract.requiredAxes.includes(axis) || contract.optionalAxes.includes(axis)) &&
    Object.entries(contract.source).every(([key, value]) => sourceBackend[key] === value) &&
    Object.entries(contract.target).every(([key, value]) => targetBackend[key] === value);
}

function matchingContracts({ source, target, state, changeAxes }, contracts) {
  if (!source?.backend || !target?.backend || source.backend.profile !== 'full' || target.backend.profile !== 'full' ||
      source.authMode !== 'better-auth' || state?.A !== 'ready' ||
      !['compatible', 'incompatible'].includes(state.D) ||
      !taggedHash.test(source.authSchemaSha256 ?? '') || !target.authSchemas?.includes(source.authSchemaSha256) ||
      !taggedHash.test(source.backend.migrationFingerprint ?? '') ||
      source.backend.migrationFingerprint !== target.backend.migrationFingerprint ||
      changeAxes.includes('infrastructure')) return [];
  const formatChanged = source.backend.persistenceFormat !== target.backend.persistenceFormat;
  return contracts.filter(contract =>
    formatChanged === (contract.handler !== null) &&
    matchesMigrationContract(contract, source.backend, target.backend, changeAxes));
}

export function resolveMigrationContracts(input, contracts = migrationContracts) {
  return matchingContracts(input, contracts).map(contract => ({
    contractSha256: digestEvidence(contract),
    dataConversion: contract.handler !== null,
  }));
}

export function approvedMigration(transition) {
  if (transition === null) return null;
  const matches = migrationContracts.filter(contract => digestEvidence(contract) === transition?.contractSha256);
  if (matches.length !== 1 || transition.dataConversion !== (matches[0].handler !== null)) {
    throw new Error('Unregistered or ambiguous approved migration');
  }
  return matches[0];
}
