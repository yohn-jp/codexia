import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFileSync, lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { matchesMigrationContract, migrationContracts } from '../../deployment/cutover/transitions.mjs';
import { expectedBackendMigrationFingerprint } from '../../release/backend/image-inspection.mjs';

const compatibilityPaths = [
  'deploy/update-compatibility.json',
  'deploy/frontend-compatibility.json',
  'deploy/quadlet/codexia-api.container',
  'packages/api/src/auth-schema.ts',
  'packages/persistence-postgres/migrations/*.sql',
];
const sharedPaths = [
  '.github/workflows/epoch-cutover-fixture.yml',
  '.github/workflows/production-epoch-cutover.yml',
  '.github/workflows/production-preflight.yml',
  '.github/workflows/production-bootstrap.yml',
  'scripts/ci/impact/migration-contracts*.mjs',
  'scripts/ci/execution/deployment-fixtures.mjs',
  'scripts/deployment/cutover/*.mjs',
  'scripts/deployment/preflight/**',
  'scripts/deployment/recovery/epoch-cutover*.mjs',
  'scripts/deployment/handoff/verify-push.mjs',
  'scripts/release/cutover/**',
  'scripts/verification/infrastructure/identity-probe-client.mjs',
  'scripts/release/frontend/verify-compatibility.mjs',
  'scripts/release/backend/{update-identity,image-inspection}.mjs',
  'packages/persistence-postgres/src/migration-set.ts',
  'scripts/build/frontend/oauth-config.mjs',
  'deploy/ansible/cutover-{host.*,migrations.py,observe.*}',
  'deploy/ansible/preflight-observe.*',
  'deploy/ansible/test-cutover-observe.sh',
  'deploy/ansible/test_{cutover_host,preflight_observe}.py',
  'deploy/ansible/{deploy,host,auth-runtime}.yml',
  'deploy/ansible/auth-runtime/**',
  'deploy/ansible/{owner-setup,require-clean-api-target,prepare-deploy-ssh}.sh',
  'deploy/backup/**',
  'deploy/quadlet/*.container',
  'deploy/postgres/**',
];

const sha = /^[0-9a-f]{40}$/u;
const hash = /^sha256:[0-9a-f]{64}$/u;
const touches = (files, patterns) => files.some(file => patterns.some(pattern => path.matchesGlob(file, pattern)));
const readGit = args => execFileSync('git', args, { encoding: 'utf8', timeout: 60_000, maxBuffer: 16 * 1024 * 1024 });
const positiveInteger = value => Number.isSafeInteger(value) && value > 0;

export function deploymentMigrationContract(source, target, contracts = migrationContracts) {
  assert.ok(target.apiEpoch === target.frontendApiEpoch, 'Candidate has incompatible Backend and Frontend API epochs');
  const axes = [];
  if (source.apiEpoch !== target.apiEpoch || source.frontendApiEpoch !== target.frontendApiEpoch) axes.push('api-epoch');
  if (source.persistenceFormat !== target.persistenceFormat) axes.push('persistence-format');
  if (source.migrationFingerprint !== target.migrationFingerprint) axes.push('sql-ledger');
  if (source.authMode !== target.authMode) axes.push('auth-mode');
  if (!isDeepStrictEqual(source.authSchemas, target.authSchemas)) axes.push('auth-schema');
  if (axes.length === 0) return null;
  const matches = contracts.filter(contract => matchesMigrationContract(contract, source, target, axes));
  assert.ok(matches.length > 0, 'No migration contract for deployment compatibility change: ' + axes.join(', '));
  assert.equal(matches.length, 1, 'Ambiguous migration contracts for deployment compatibility change: ' + axes.join(', '));
  return matches[0];
}

function fixtureType(filename) {
  const testPattern = /^(?:scripts\/deployment\/cutover\/migrations\/[a-z0-9_-]+\.test\.mjs|deploy\/ansible\/test-[a-z0-9_-]+\.sh)$/u;
  assert.ok(testPattern.test(filename ?? ''), 'Missing or unsupported migration fixture path');
  assert.ok(lstatSync(filename, { throwIfNoEntry: false })?.isFile(), 'Migration fixture is missing: ' + filename);
  return filename.endsWith('.sh') ? 'rootless' : 'node';
}

export function deploymentFixtureImpact({ files, transition = null, contracts = migrationContracts, fixtureType: inspect = fixtureType }) {
  const common = files === null || touches(files, sharedPaths);
  const ids = new Set(['shared']);
  const selected = common ? [{ id: 'shared', fixture: '', kind: 'shared', candidateSource: '' }] : [];
  for (const contract of contracts) {
    assert.match(contract.id, /^[a-z0-9][a-z0-9-]{0,63}$/u, 'Invalid migration contract id');
    assert.ok(!ids.has(contract.id), 'Duplicate migration contract ID: ' + contract.id);
    ids.add(contract.id);
    const kind = inspect(contract.fixture);
    const inputs = contract.inputs ?? [];
    assert.ok(Array.isArray(inputs) && inputs.every(entry => typeof entry === 'string' && entry.length > 0 &&
      !entry.startsWith('/') && !entry.split('/').includes('..')), 'Invalid migration fixture inputs');
    assert.ok(contract.fixtureCandidateSource == null || sha.test(contract.fixtureCandidateSource),
      'Invalid pinned historical fixture source');
    if (common || transition?.id === contract.id || touches(files, [contract.fixture, ...inputs])) {
      selected.push({ id: contract.id, fixture: contract.fixture, kind, candidateSource: '' });
    }
  }
  return selected;
}

async function compatibilityAt(source, git) {
  assert.match(source, sha, 'Invalid compatibility source revision');
  const show = filename => git(['show', source + ':' + filename]);
  const backend = JSON.parse(show(compatibilityPaths[0]));
  const frontend = JSON.parse(show(compatibilityPaths[1]));
  assert.ok([backend.apiEpoch, backend.persistenceFormat, frontend.apiEpoch].every(positiveInteger),
    'Malformed deployment compatibility manifest');
  const modes = [...show(compatibilityPaths[2]).matchAll(/^Environment=CODEXIA_AUTH_MODE=([a-z][a-z0-9-]*)$/gmu)];
  assert.equal(modes.length, 1, 'Missing or ambiguous Full writer auth mode');
  const schemas = [...show(compatibilityPaths[3]).matchAll(/^const EXPECTED_(SETUP_)?AUTH_SCHEMA = "(sha256:[a-f0-9]{64})";$/gmu)];
  const installed = schemas.filter(([, setup]) => !setup).map(([, , fingerprint]) => fingerprint);
  assert.equal(installed.length, 1, 'Missing or ambiguous installed auth schema');
  const authSchemas = [...new Set(schemas.map(([, , fingerprint]) => fingerprint))].sort();
  assert.ok(authSchemas.every(fingerprint => hash.test(fingerprint)));
  return { apiEpoch: backend.apiEpoch, persistenceFormat: backend.persistenceFormat,
    frontendApiEpoch: frontend.apiEpoch, migrationFingerprint: await expectedBackendMigrationFingerprint(source),
    authMode: modes[0][1], authSchemaSha256: installed[0], authSchemas };
}

// Source snapshots and fixture admission use the event's immutable revisions.
// A missing PR or push boundary cannot silently become a compatible change.
export async function deploymentImpactForSource({ event, sha: source, base, git = readGit }) {
  assert.match(source, sha, 'Invalid deployment verification source');
  let files = null;
  let transition = null;
  if (['pull_request', 'push'].includes(event)) {
    assert.match(base ?? '', sha, 'Exact deployment comparison base is unavailable');
    const prior = event === 'pull_request' ? git(['merge-base', base, source]).trim() : base;
    assert.match(prior, sha, 'Exact deployment comparison boundary is unavailable');
    files = git(['diff', '--name-only', '--no-renames', '-z', prior, source, '--']).split('\0').filter(Boolean);
    if (touches(files, compatibilityPaths)) {
      const [before, after] = await Promise.all([compatibilityAt(prior, git), compatibilityAt(source, git)]);
      transition = deploymentMigrationContract(before, after);
    }
  }
  const selected = deploymentFixtureImpact({ files, transition });
  const historical = selected.filter(row => row.kind === 'rootless' &&
    migrationContracts.some(contract => contract.id === row.id && contract.fixtureCandidateSource));
  if (historical.length > 0) {
    const target = await compatibilityAt(source, git);
    for (const row of historical) {
      const contract = migrationContracts.find(value => value.id === row.id);
      const fullTarget = await compatibilityAt(contract.fixtureCandidateSource, git);
      if (!isDeepStrictEqual(target, fullTarget)) {
        row.candidateSource = contract.fixtureCandidateSource;
      }
    }
  }
  return selected;
}

export async function deploymentFixturesForCheckout() {
  const head = readGit(['rev-parse', 'HEAD']).trim();
  const source = process.env.CODEXIA_EXPECTED_SHA ?? head;
  assert.equal(head, source, 'Checkout is not the exact deployment verification source');
  const event = process.env.GITHUB_EVENT_NAME ?? 'workflow_dispatch';
  const payload = process.env.GITHUB_EVENT_PATH ? JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8')) : {};
  const base = payload.pull_request?.base?.sha ?? (payload.after === source ? payload.before : null);
  return deploymentImpactForSource({ event, sha: source, base });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const matrix = JSON.stringify(await deploymentFixturesForCheckout());
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `fixtures=${matrix}\n`);
  console.log(matrix);
}
