import assert from 'node:assert/strict';
import { test } from 'node:test';
import { migrationSetFingerprint } from '../../../packages/persistence-postgres/src/migration-set.ts';
import { planFromObservations } from './observe.mjs';

const h = c => c.repeat(64);
const now = new Date('2026-11-24T00:00:00.000Z');
const window = { id: 'maintenance', notBefore: '2026-11-23T23:55:00.000Z', notAfter: '2026-11-24T01:00:00.000Z' };
const ledger = [{ version: '0001-initial.sql', checksum: h('b') }];
const schema = 'sha256:' + h('c');
const image = c => 'ghcr.io/yohn-jp/codexia-backend@sha256:' + h(c);

function fixture() {
  const identity = { format: 'codexia-backend-identity/v1', version: '1.0.0', sourceSha: 'a'.repeat(40),
    profile: 'full', platform: 'linux/amd64', migrationFingerprint: migrationSetFingerprint(ledger),
    apiEpoch: 2, persistenceFormat: 2 };
  const frontend = { format: 'codexia-frontend-identity/v1', version: '1.0.0', sourceSha: 'f'.repeat(40),
    profile: 'full', apiEpoch: 2, oauthConfigIdentity: 'fixture-public-config' };
  const candidateBackend = { image: image('d'), identity, verifiedMainSha: 'a'.repeat(40) };
  return {
    host: { format: 'codexia-lifecycle-host/v1', hostId: h('a'), M: 'ready', H: 'ready',
      observedAt: now.toISOString(), topology: {}, transaction: null,
      database: { state: 'initialized', clusterId: '123', ledger, authState: 'ready',
        authSchemaSha256: schema, ownerBindingSha256: 'sha256:' + h('d') },
      backend: { state: 'running', writer: { image: image('d'), identity, authMode: 'better-auth' } } },
    edge: { observedAt: now.toISOString(), origin: 'https://example.test', ingressDigest: 'sha256:' + h('e'),
      fence: { enabled: false }, deployment: { versionId: 'version-one' }, frontendState: 'running',
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
test('verified empty and partial infrastructure, owner setup, first activation and missing UI', () => {
  const f = fixture();
  absentFrontend(f); absentBackend(f);
  f.host.H = 'absent';
  f.host.database = { state: 'absent', authState: 'absent' };
  f.intent = 'install';
  assert.equal(planFromObservations(f).plan.route, 'R4');
  f.host.H = 'partial';
  assert.equal(planFromObservations(f).plan.route, 'R4');
  f.host.H = 'ready';
  f.host.database = { ...fixture().host.database, authState: 'pending' };
  f.host.backend = { state: 'setup' };
  assert.equal(planFromObservations(f).plan.route, 'R5');
  f.host.backend = { state: 'absent' };
  f.host.database.authState = 'ready';
  const activation = planFromObservations(f).plan;
  assert.equal(activation.candidateRoute, 'R6');
  assert.equal(activation.route, 'R0');
  assert.ok(activation.blockers.includes('missing-preservation-evidence'));
  const ui = fixture();
  absentFrontend(ui);
  assert.equal(planFromObservations(ui).plan.route, 'R7');
  assert.equal(planFromObservations(ui).plan.requiresPreservation, false);
});
test('epoch-only transition is distinct from persistence, schema and auth changes', () => {
  const f = fixture();
  const prior = { ...f.priorBackend, image: image('9'),
    identity: { ...f.priorBackend.identity, version: '0.9.0', apiEpoch: 1 } };
  f.priorBackend = prior;
  f.host.backend.writer = { image: prior.image, identity: prior.identity, authMode: 'better-auth' };
  f.edge.backend = { ...f.edge.backend, apiEpoch: 1, version: '0.9.0' };
  f.edge.frontend = { ...f.edge.frontend, apiEpoch: 1, version: '0.9.0' };
  const blocked = planFromObservations(f).plan;
  assert.equal(blocked.candidateRoute, 'R7');
  assert.equal(blocked.route, 'R0');
  assert.ok(blocked.blockers.includes('unsupported-transition'));
  assert.deepEqual(blocked.observation.changeAxes, ['backend', 'frontend', 'api-epoch']);
  f.resolveTransition = () => [{ contractSha256: h('7'), dataConversion: false }];
  f.preservationReceipt = { verified: true };
  assert.equal(planFromObservations(f).plan.route, 'R7');
  f.resolveTransition = () => [{ contractSha256: h('7'), dataConversion: false }, { contractSha256: h('8'), dataConversion: false }];
  assert.ok(planFromObservations(f).plan.blockers.includes('ambiguous-transition'));
  const legacy = fixture();
  legacy.host.backend.writer = { image: prior.image, identity: { ...prior.identity, persistenceFormat: 1 }, authMode: 'legacy' };
  legacy.priorBackend = { ...prior, identity: legacy.host.backend.writer.identity };
  legacy.host.database = { ...legacy.host.database, authState: 'legacy', authSchemaSha256: null };
  legacy.edge.backend = { ...f.edge.backend, standaloneOAuth: false };
  legacy.edge.frontend = f.edge.frontend;
  const migration = planFromObservations(legacy).plan;
  assert.equal(migration.candidateRoute, 'R3');
  assert.ok(migration.observation.changeAxes.includes('persistence-format'));
  assert.ok(migration.observation.changeAxes.includes('auth-mode'));
  const changed = fixture();
  changed.host.database.authSchemaSha256 = 'sha256:' + h('6');
  assert.equal(planFromObservations(changed).plan.candidateRoute, 'R3');
  assert.ok(planFromObservations(changed).plan.observation.changeAxes.includes('auth-schema'));
});
test('unknown edge, contradictory identity, orphan fence, unverified publication and recovery never authorize changes', () => {
  for (const change of [
    f => { f.edge = null; },
    f => { f.edge.frontendState = 'unknown'; },
    f => { f.edge.backend.version = '0.1.0'; },
    f => { f.edge.fence.enabled = true; },
    f => { f.priorBackend = null; },
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
