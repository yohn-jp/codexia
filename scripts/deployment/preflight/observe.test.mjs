import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { migrationSetFingerprint } from '../../../packages/persistence-postgres/src/migration-set.ts';
import { planFromObservations } from './observe.mjs';
import { parsePreflightRequest } from './run.mjs';
import { frontendOAuthConfigIdentity } from '../../build/frontend/oauth-config.mjs';

test('the host observation entrypoint loads from a clean checkout without evidence-reader dependencies', () => {
  const root = mkdtempSync(join(tmpdir(), 'codexia-preflight-import-'));
  try {
    for (const path of [
      'scripts/deployment/preflight/run.mjs',
      'scripts/deployment/preflight/preservation.mjs',
      'scripts/deployment/preflight/evidence-digest.mjs',
      'packages/api/src/auth-schema.ts',
    ]) {
      const target = join(root, path);
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(new URL('../../../' + path, import.meta.url), target);
    }
    execFileSync(process.execPath, ['--input-type=module', '--eval',
      "const entry = await import('./scripts/deployment/preflight/run.mjs'); if (typeof entry.readLifecycleHost !== 'function') process.exit(1);"],
    { cwd: root });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

const h = c => c.repeat(64);
const now = new Date('2026-11-24T00:00:00.000Z');
const window = { id: 'maintenance', notBefore: '2026-11-23T23:55:00.000Z', notAfter: '2026-11-24T01:00:00.000Z' };
const ledger = [{ version: '0001-initial.sql', checksum: h('b') }];
const schema = 'sha256:' + h('c');
const image = c => 'ghcr.io/yohn-jp/codexia-backend@sha256:' + h(c);
const publicSettings = {
  VITE_CODEXIA_OAUTH_ISSUER: 'https://example.test/api/auth',
  VITE_CODEXIA_OAUTH_CLIENT_ID: 'fixture-public-config',
  VITE_CODEXIA_API_AUDIENCE: 'https://example.test/api',
  VITE_CODEXIA_OAUTH_DESKTOP_REDIRECT_URI: 'https://example.test/desktop',
};

function fixture() {
  const identity = { format: 'codexia-backend-identity/v1', version: '1.0.0', sourceSha: 'a'.repeat(40),
    profile: 'full', platform: 'linux/amd64', migrationFingerprint: migrationSetFingerprint(ledger),
    apiEpoch: 2, persistenceFormat: 2 };
  const frontend = { format: 'codexia-frontend-identity/v1', version: '1.0.0', sourceSha: 'f'.repeat(40),
    profile: 'full', apiEpoch: 2, oauthConfigIdentity: frontendOAuthConfigIdentity(publicSettings) };
  const candidateBackend = { image: image('d'), identity, verifiedMainSha: 'a'.repeat(40) };
  return {
    host: { format: 'codexia-lifecycle-host/v1', hostId: h('a'), M: 'ready', H: 'ready',
      observedAt: now.toISOString(), topology: {}, transaction: null,
      database: { state: 'initialized', clusterId: '123', ledger, authState: 'ready',
        authSchemaSha256: schema, ownerBindingSha256: 'sha256:' + h('d') },
      backend: { state: 'running', writer: { image: image('d'), identity, authMode: 'better-auth' } } },
    edge: { observedAt: now.toISOString(), origin: 'https://example.test', ingressDigest: 'sha256:' + h('e'),
      deployment: { versionId: 'version-one' }, frontendState: 'running',
      frontend, backend: { name: 'codexia', version: '1.0.0', profile: 'full', apiEpoch: 2, standaloneOAuth: true } },
    hostPinSha256: h('f'), candidateBackend, candidateFrontend: { identity: frontend, artifactDigest: h('1'),
      runId: 1, verifyRunId: 2, artifactId: 3 }, priorBackend: candidateBackend, authSchemas: [schema],
    intent: 'update', window, now,
  };
}
function absentFrontend(f) {
  Object.assign(f.edge, { deployment: null, frontendState: 'absent', frontend: null });
}
function absentBackend(f) {
  f.host.backend = { state: 'absent' };
  f.edge.backend = null;
  f.priorBackend = null;
}

test('a verified R2 restoration can only continue through an explicitly approved R3 plan', () => {
  const f = fixture();
  absentBackend(f);
  f.intent = 'restore';
  Object.assign(f.host.database, { databaseOid: '456', settingsSha256: h('e') });
  const ready = {
    operationId: 'restore-20261124-01', evidenceSha256: h('2'),
    release: { image: f.candidateBackend.image, sourceSha: f.candidateBackend.identity.sourceSha,
      frontendArtifactSha256: f.candidateFrontend.artifactDigest },
    window: f.window,
  };
  f.host.recovery = ready;
  const { plan } = planFromObservations(f);
  assert.equal(plan.candidateRoute, 'R3');
  assert.deepEqual(plan.requiredApprovals, ['maintenance', 'recovery', 'publication']);
  assert.deepEqual(plan.blockers, ['approval-required']);
  assert.equal(plan.observation.binding.backupSha256, ready.evidenceSha256);
  assert.equal(plan.observation.recoveryOperationId, ready.operationId);

  for (const recovery of [
    undefined,
    { ...ready, release: { ...ready.release, image: image('7') } },
    { ...ready, release: { ...ready.release, frontendArtifactSha256: h('3') } },
    { ...ready, window: { ...f.window, id: 'different-approval' } },
  ]) {
    f.host.recovery = recovery;
    assert.equal(planFromObservations(f).plan.candidateRoute, 'R0');
  }
  f.host.recovery = ready;
  f.intent = 'install';
  assert.ok(planFromObservations(f).plan.blockers.includes('unverified-fresh-installation'));
});
test('observed pair: exact no-op, backend-only and frontend-only updates', () => {
  const f = fixture();
  const exact = planFromObservations(f);
  assert.equal(exact.plan.route, 'R8');
  assert.equal(exact.plan.noOp, true);
  assert.equal(exact.plan.authorization, 'pending');
  assert.ok(!JSON.stringify(exact).includes('fixture-public-config'));
  f.candidateBackend = { ...f.candidateBackend, image: image('9'),
    identity: { ...f.candidateBackend.identity, version: '1.0.1' } };
  assert.deepEqual(planFromObservations(f).plan.observation.changeAxes, ['backend']);
  const ui = fixture();
  ui.candidateFrontend.identity = { ...ui.candidateFrontend.identity, version: '1.0.1' };
  assert.equal(planFromObservations(ui).plan.route, 'R8');
  assert.deepEqual(planFromObservations(ui).plan.observation.changeAxes, ['frontend']);
});
test('verified missing logical database selects approved fresh bootstrap, not an epoch transition', () => {
  const f = fixture();
  f.candidateBackend = { ...f.candidateBackend, identity: { ...f.candidateBackend.identity, apiEpoch: 3, version: '2.0.0' } };
  f.candidateFrontend.identity = { ...f.candidateFrontend.identity, apiEpoch: 3, version: '2.0.0' };
  f.host.database = { state: 'missing', authState: 'absent', clusterId: '123' };
  f.host.backend = { state: 'fault', databaseAbsent: true };
  f.edge.backend = null;
  f.priorBackend = null;
  f.intent = 'install';
  const { plan } = planFromObservations(f);
  assert.equal(plan.candidateRoute, 'R4');
  assert.deepEqual(plan.blockers, ['approval-required']);
  assert.deepEqual(plan.requiredApprovals, ['bootstrap', 'database-initialization']);
  assert.equal(plan.observation.state.F, 'incompatible');
  f.intent = 'update';
  assert.equal(planFromObservations(f).plan.candidateRoute, 'R0');
  f.intent = 'restore';
  assert.equal(planFromObservations(f).plan.candidateRoute, 'R2');
  f.intent = 'install';
  f.host.database = { state: 'unknown', authState: 'unknown' };
  assert.equal(planFromObservations(f).plan.candidateRoute, 'R0');
});

test('verified empty and partial infrastructure, owner setup, first activation and missing UI', () => {
  const f = fixture();
  absentFrontend(f); absentBackend(f);
  f.host.H = 'absent';
  f.host.database = { state: 'absent', authState: 'absent' };
  f.intent = 'install';
  assert.equal(planFromObservations(f).plan.candidateRoute, 'R4');
  assert.deepEqual(planFromObservations(f).plan.blockers, ['approval-required']);
  f.host.H = 'partial';
  assert.equal(planFromObservations(f).plan.candidateRoute, 'R4');
  assert.deepEqual(planFromObservations(f).plan.blockers, ['approval-required']);
  f.host.H = 'ready';
  f.host.database = { ...fixture().host.database, authState: 'pending' };
  f.host.backend = { state: 'setup' };
  assert.equal(planFromObservations(f).plan.candidateRoute, 'R5');
  assert.deepEqual(planFromObservations(f).plan.blockers, ['approval-required']);
  f.host.backend = { state: 'absent' };
  f.host.database.authState = 'ready';
  assert.equal(planFromObservations(f).plan.candidateRoute, 'R0');
  f.edge = { ...fixture().edge, backend: null };
  const unverified = planFromObservations(f).plan;
  assert.ok(unverified.blockers.includes('unverified-fresh-installation'));
  f.host.database.databaseOid = '456';
  f.host.database.bootstrapIntent = { clusterId: '123', databaseOid: '999', image: f.candidateBackend.image };
  assert.ok(planFromObservations(f).plan.blockers.includes('unverified-fresh-installation'));
  f.host.database.bootstrapIntent.databaseOid = '456';
  const activation = planFromObservations(f).plan;
  assert.equal(activation.candidateRoute, 'R6');
  assert.equal(activation.route, 'R0');
  assert.deepEqual(activation.blockers, ['approval-required']);
  assert.equal(activation.observation.binding.backupSha256, null);
  const ui = fixture();
  absentFrontend(ui);
  ui.priorBackend = null;
  assert.equal(planFromObservations(ui).plan.candidateRoute, 'R0');
  assert.ok(planFromObservations(ui).plan.blockers.includes('state-or-intent-not-admitted'));
  assert.equal(planFromObservations(ui).plan.requiresPreservation, false);
});
test('noncompatible epoch, persistence and auth changes are observed but never admitted', () => {
  const f = fixture();
  const prior = { ...f.priorBackend, image: image('9'),
    identity: { ...f.priorBackend.identity, version: '0.9.0', apiEpoch: 1 } };
  f.priorBackend = prior;
  f.host.backend.writer = { image: prior.image, identity: prior.identity, authMode: 'better-auth' };
  f.edge.backend = { ...f.edge.backend, apiEpoch: 1, version: '0.9.0' };
  f.edge.frontend = { ...f.edge.frontend, apiEpoch: 1, version: '0.9.0' };
  const blocked = planFromObservations(f).plan;
  assert.equal(blocked.candidateRoute, 'R0');
  assert.equal(blocked.route, 'R0');
  assert.ok(blocked.blockers.includes('state-or-intent-not-admitted'));
  assert.deepEqual(blocked.observation.changeAxes, ['backend', 'frontend', 'api-epoch']);
  f.preservationReceipt = { verified: true };
  assert.equal(planFromObservations(f).plan.candidateRoute, 'R0');
  const legacy = fixture();
  legacy.host.backend.writer = { image: prior.image, identity: { ...prior.identity, persistenceFormat: 1 }, authMode: 'legacy' };
  legacy.priorBackend = { ...prior, identity: legacy.host.backend.writer.identity };
  legacy.host.database = { ...legacy.host.database, authState: 'legacy', authSchemaSha256: null };
  legacy.edge.backend = { ...f.edge.backend, standaloneOAuth: false };
  legacy.edge.frontend = f.edge.frontend;
  const migration = planFromObservations(legacy).plan;
  assert.equal(migration.candidateRoute, 'R0');
  assert.ok(migration.observation.changeAxes.includes('persistence-format'));
  assert.ok(!migration.observation.changeAxes.includes('sql-ledger'));
  assert.equal(migration.observation.state.D, 'incompatible');
  assert.ok(migration.observation.changeAxes.includes('auth-mode'));
  const changed = fixture();
  changed.host.database.authSchemaSha256 = 'sha256:' + h('6');
  assert.equal(planFromObservations(changed).plan.candidateRoute, 'R0');
  assert.ok(planFromObservations(changed).plan.observation.changeAxes.includes('auth-schema'));
});
test('unknown edge, contradictory identity, unverified publication and recovery never authorize changes', () => {
  for (const change of [
    f => { f.edge = null; },
    f => { f.edge.frontendState = 'unknown'; },
    f => { f.edge.backend.version = '0.1.0'; },
    f => { f.edge.ingressDigest = null; },
    f => {
      f.priorBackend = null;
      f.candidateBackend = { ...f.candidateBackend, image: image('9'),
        identity: { ...f.candidateBackend.identity, version: '1.0.1' } };
    },
    f => { f.host.transaction = { phase: 'pending' }; },
  ]) {
    const f = fixture();
    change(f);
    assert.equal(planFromObservations(f).plan.route, 'R0');
  }
  const stale = fixture();
  stale.host.observedAt = '2026-11-23T23:00:00.000Z';
  assert.throws(() => planFromObservations(stale), /Stale/);
});

test('candidate pair must be Full, epoch compatible and carry an approved schema and archive identity', () => {
  for (const change of [
    f => { f.candidateFrontend.identity = { ...f.candidateFrontend.identity, apiEpoch: 3 }; },
    f => { f.candidateBackend.identity = { ...f.candidateBackend.identity, profile: 'core' }; },
    f => { f.authSchemas = []; },
    f => { f.candidateFrontend.artifactDigest = 'unverified'; },
  ]) {
    const f = fixture();
    change(f);
    assert.throws(() => planFromObservations(f));
  }
});

test('dispatch accepts only artifact references and explicit intent, not fabricated observations or approvals', () => {
  const request = { backendPublisherRunId: 123, priorBackendPublisherRunId: 122,
    frontend: { runId: 2, verifyRunId: 3, artifactId: 4, artifactDigest: h('a') },
    intent: 'maintenance', window };
  assert.deepEqual(parsePreflightRequest(JSON.stringify(request)), request);
  for (const extra of [
    { host: {} }, { edge: {} }, { preservationReceipt: {} }, { approval: {} }, { transition: {} },
    { frontend: { ...request.frontend, artifactDigest: 'unverified' } },
    { intent: 'guess' }, { window: { ...window, notAfter: window.notBefore } },
  ]) assert.throws(() => parsePreflightRequest(JSON.stringify({ ...request, ...extra })));
});


test('each present observation must have its own fresh canonical timestamp', () => {
  for (const side of ['host', 'edge']) {
    for (const observedAt of [undefined, '2026-11-24T00:00:01.000Z', '2026-11-23T23:54:59.000Z', '2026-11-24T00:00:00Z']) {
      const f = fixture();
      f[side].observedAt = observedAt;
      assert.throws(() => planFromObservations(f), /timestamp|Stale or future/u, side + ': ' + observedAt);
    }
  }
  const f = fixture();
  f.host.observedAt = '2026-11-23T23:59:00.000Z';
  assert.equal(planFromObservations(f).plan.observation.observedAt, f.host.observedAt);
});


test('frontend evidence binds immutable deployment and archive while validating public settings', () => {
  const baseline = fixture();
  const before = planFromObservations(baseline);
  const changed = fixture();
  changed.edge.deployment = { versionId: 'version-older' };
  changed.edge.frontend = { ...changed.edge.frontend, version: '0.9.0',
    oauthConfigIdentity: frontendOAuthConfigIdentity({ ...publicSettings, VITE_CODEXIA_OAUTH_CLIENT_ID: 'other-public-client' }) };
  const after = planFromObservations(changed);
  assert.ok(after.plan.observation.changeAxes.includes('oauth-contract'));
  assert.notEqual(after.plan.observation.binding.frontendSha256, before.plan.observation.binding.frontendSha256);
  assert.ok(!JSON.stringify(after).includes('other-public-client'));
  for (const invalid of ['arbitrary-untrusted-value',
    JSON.stringify({ format: 'codexia-web-oauth-config/v1', settings: { clientSecret: 'not-public' } })]) {
    const f = fixture();
    f.edge.frontend = { ...f.edge.frontend, oauthConfigIdentity: invalid };
    assert.throws(() => planFromObservations(f), /Invalid public frontend configuration identity/u);
  }
  const absent = fixture();
  absent.candidateFrontend.identity = { ...absent.candidateFrontend.identity,
    oauthConfigIdentity: frontendOAuthConfigIdentity({}) };
  assert.throws(() => planFromObservations(absent), /no certified OAuth contract/u);
});

test('an installed legacy identity admits a newer frontend with the same Desktop OAuth contract', () => {
  const f = fixture();
  const { scopes, ...settings } = JSON.parse(f.edge.frontend.oauthConfigIdentity).settings;
  f.edge.frontend = { ...f.edge.frontend, oauthConfigIdentity: JSON.stringify({
    format: 'codexia-web-oauth-config/v1',
    settings: { ...settings, mobileRedirectUri: 'https://example.test/mobile', scopes },
  }) };
  f.candidateFrontend.identity = { ...f.candidateFrontend.identity, version: '1.0.1' };
  const { plan } = planFromObservations(f);
  assert.equal(plan.route, 'R8');
  assert.deepEqual(plan.observation.changeAxes, ['frontend']);
  assert.equal(plan.observation.frontendAdmission, 'allowed');
});
