import assert from 'node:assert/strict';
import test from 'node:test';
import { migrationSetFingerprint } from '../../../packages/persistence-postgres/src/migration-set.ts';
import { createDeploymentPlan } from '../preflight/plan.mjs';
import { planFromObservations } from '../preflight/observe.mjs';
import { frontendOAuthConfigIdentity } from '../../build/frontend/oauth-config.mjs';
import { admitBootstrap, ownerSetupFrontendBindings } from './admission.mjs';

const hash = 'a'.repeat(64);
const now = new Date('2026-11-24T06:00:00.000Z');
const observedAt = '2026-11-24T05:59:00.000Z';

function fixture(state = {}, overrides = {}) {
  const current = {
    observation: {
      state: { M: 'ready', H: 'partial', D: 'absent', A: 'absent', B: 'absent', F: 'absent', T: 'none', ...state },
      observedAt: now.toISOString(),
      binding: {
        environment: 'codexia-production', hostPinSha256: hash, hostId: hash,
        databaseSha256: hash, authSha256: hash, backendSha256: hash, frontendSha256: hash,
        ingressSha256: hash, transactionSha256: hash, infrastructureSha256: hash, backupSha256: null,
      },
      frontendAdmission: 'not-applicable',
      changeAxes: [],
    },
    target: { backendCertificateSha256: hash, frontendArtifactSha256: hash, identitySha256: hash },
    intent: 'install',
    ...overrides,
  };
  const reviewed = createDeploymentPlan({
    ...current, observation: { ...current.observation, observedAt }, now: new Date(observedAt),
  });
  return { now, ...reviewed, current };
}

test('R4 enables only wholly separate base stages still required by observed state', () => {
  const input = { ...fixture(), mode: 'bootstrap', initializeDatabase: true };
  assert.deepEqual(admitBootstrap({ ...input, topology: {} }), {
    route: 'R4', stages: ['host', 'secrets', 'base', 'auth-runtime'],
    installIntent: true,
  });
  assert.deepEqual(admitBootstrap({
    ...input, topology: { hostReady: true, secrets: {
      'codexia-tunnel-token': true, 'codexia-postgres-admin-password': true, 'codexia-postgres-app-password': true,
    } },
  }).stages, ['base', 'auth-runtime']);
  assert.deepEqual(admitBootstrap({
    ...fixture({ D: 'compatible', A: 'ready' }, { intent: 'adopt' }), mode: 'bootstrap',
    initializeDatabase: false, topology: { hostReady: true, secrets: {
      'codexia-tunnel-token': true, 'codexia-postgres-admin-password': true, 'codexia-postgres-app-password': true,
    } },
  }), { route: 'R4', stages: ['base'], installIntent: false });
});

test('R4 refuses unapproved initialization, wrong approvals, drift and stale fresh evidence', () => {
  const input = { ...fixture(), mode: 'bootstrap', topology: {} };
  assert.throws(() => admitBootstrap(input), /Approval/);
  assert.throws(() => admitBootstrap({ ...input, initializeDatabase: true, planSha256: 'b'.repeat(64) }), /blocked or altered/);
  assert.throws(() => admitBootstrap({
    ...input, initializeDatabase: true, current: { ...input.current, target: { ...input.current.target, identitySha256: 'b'.repeat(64) } },
  }), /changed after approval/);
  assert.throws(() => admitBootstrap({
    ...input, initializeDatabase: true, now: new Date('2026-11-24T06:06:00.000Z'),
  }), /Stale/);
});

test('R5 separates enrollment start from preparation, and rejects existing owner reissuance', () => {
  const pending = fixture({ H: 'ready', D: 'compatible', A: 'pending' });
  const enrolled = fixture({ H: 'ready', D: 'compatible', A: 'unprepared', B: 'setup' });
  assert.deepEqual(admitBootstrap({ ...pending, mode: 'owner-setup' }), {
    route: 'R5', stages: [], installIntent: false,
  });
  assert.deepEqual(admitBootstrap({ ...enrolled, mode: 'prepare-activation' }), {
    route: 'R5', stages: [], installIntent: false,
  });
  assert.throws(() => admitBootstrap({ ...enrolled, mode: 'owner-setup' }), /owner state/);
  assert.throws(() => admitBootstrap({ ...pending, mode: 'prepare-activation' }), /owner state/);
  assert.throws(() => admitBootstrap({
    ...fixture({ H: 'ready', D: 'compatible', A: 'ready' }), mode: 'owner-setup',
  }), /route/);
});

test('owner setup uses the exact certified browser origin, client and return URIs', () => {
  const origin = 'https://example.invalid';
  const identity = frontendOAuthConfigIdentity({
    VITE_CODEXIA_OAUTH_ISSUER: origin + '/api/auth',
    VITE_CODEXIA_OAUTH_CLIENT_ID: 'codexia-web',
    VITE_CODEXIA_API_AUDIENCE: origin + '/api',
    VITE_CODEXIA_OAUTH_DESKTOP_REDIRECT_URI: origin + '/desktop/',
    VITE_CODEXIA_OAUTH_MOBILE_REDIRECT_URI: origin + '/mobile/',
  });
  assert.deepEqual(ownerSetupFrontendBindings(identity, origin), {
    codexia_owner_setup_expected_origin: origin,
    codexia_owner_setup_expected_web_client_id: 'codexia-web',
    codexia_owner_setup_expected_web_redirect_uris: [origin + '/desktop/', origin + '/mobile/'],
  });
  assert.throws(() => ownerSetupFrontendBindings(identity, 'https://another.invalid'), /origin and audience/);
  assert.throws(() => ownerSetupFrontendBindings(undefined, origin), /origin and audience/);
});

const schema = 'sha256:' + 'b'.repeat(64);
const backendImage = 'ghcr.io/yohn-jp/codexia-backend@sha256:' + 'c'.repeat(64);
const ledger = [{ version: '0001-initial.sql', checksum: 'd'.repeat(64) }];
const installation = { clusterId: '123', databaseOid: '456', image: backendImage };

function observedSetup(database, backend = { state: 'absent' }, intent = 'install') {
  const origin = 'https://example.invalid';
  const publicConfig = frontendOAuthConfigIdentity({
    VITE_CODEXIA_OAUTH_ISSUER: origin + '/api/auth',
    VITE_CODEXIA_OAUTH_CLIENT_ID: 'codexia-web',
    VITE_CODEXIA_API_AUDIENCE: origin + '/api',
    VITE_CODEXIA_OAUTH_DESKTOP_REDIRECT_URI: origin + '/desktop/',
    VITE_CODEXIA_OAUTH_MOBILE_REDIRECT_URI: origin + '/mobile/',
  });
  const topology = {
    hostReady: true,
    secrets: {
      'codexia-tunnel-token': true,
      'codexia-postgres-admin-password': true,
      'codexia-postgres-app-password': true,
    },
  };
  const snapshots = at => planFromObservations({
    now: new Date(at), intent, hostPinSha256: hash,
    host: {
      format: 'codexia-lifecycle-host/v1', hostId: hash, M: 'ready', H: 'ready',
      observedAt: at, topology, backend, transaction: null,
      database: { state: 'initialized', clusterId: installation.clusterId, ledger, ...database },
    },
    edge: { observedAt: at, origin, ingressDigest: 'sha256:' + hash, fence: { enabled: false },
      deployment: null, frontendState: 'absent', frontend: null, backend: null },
    candidateBackend: { image: backendImage, verifiedMainSha: 'a'.repeat(40), identity: {
      format: 'codexia-backend-identity/v1', version: '1.0.0', sourceSha: 'a'.repeat(40),
      profile: 'full', platform: 'linux/amd64', migrationFingerprint: migrationSetFingerprint(ledger),
      apiEpoch: 2, persistenceFormat: 2,
    } },
    candidateFrontend: { runId: 1, verifyRunId: 2, artifactId: 3, artifactDigest: hash, identity: {
      format: 'codexia-frontend-identity/v1', version: '1.0.0', sourceSha: 'b'.repeat(40),
      profile: 'full', apiEpoch: 2, oauthConfigIdentity: publicConfig,
    } },
    authSchemas: [schema],
  });
  return { ...snapshots(observedAt), now, current: snapshots(now.toISOString()).plan, topology };
}

const schemaWithoutMarker = {
  authState: 'absent', authSchemaSha256: null, ownerBindingSha256: null,
  databaseOid: installation.databaseOid, bootstrapIntent: installation,
};
const setupBeforeGrant = {
  authState: 'pending', authSchemaSha256: schema, ownerBindingSha256: null,
  databaseOid: installation.databaseOid, setupImage: backendImage,
};

test('Preflight and R4 restart interrupted schema initialization only with exact installation intent and database approval', () => {
  const input = observedSetup(schemaWithoutMarker);
  assert.deepEqual(input.plan.observation.bootstrapResume, {
    ...installation, migrationFingerprint: migrationSetFingerprint(ledger),
  });
  assert.deepEqual(input.plan.requiredApprovals, ['bootstrap', 'database-initialization']);
  assert.deepEqual(input.plan.blockers, ['approval-required']);
  assert.throws(() => admitBootstrap({ ...input, mode: 'bootstrap' }), /Approval/u);
  assert.deepEqual(admitBootstrap({ ...input, mode: 'bootstrap', initializeDatabase: true }), {
    route: 'R4', stages: ['auth-runtime'], installIntent: true,
  });
});

test('Preflight stops at R0 when an initialized database lacks matching installation intent', () => {
  for (const [checkpoint, bootstrapIntent] of Object.entries({
    'missing intent': undefined,
    'different PostgreSQL system identifier': { ...installation, clusterId: '999' },
    'different database OID': { ...installation, databaseOid: '999' },
    'different image digest': { ...installation, image: backendImage.slice(0, -1) + 'f' },
  })) {
    const input = observedSetup({ ...schemaWithoutMarker, bootstrapIntent });
    assert.equal(input.plan.route, 'R0', checkpoint);
    assert.deepEqual(input.plan.blockers, ['state-or-intent-not-admitted'], checkpoint);
    assert.throws(() => admitBootstrap({ ...input, mode: 'bootstrap', initializeDatabase: true }), /does not admit/u);
  }
  const adopting = observedSetup(schemaWithoutMarker, { state: 'absent' }, 'adopt');
  assert.equal(adopting.plan.route, 'R0');
  assert.deepEqual(adopting.plan.blockers, ['state-or-intent-not-admitted']);
  const changedLedger = observedSetup({ ...schemaWithoutMarker, ledger: [
    { ...ledger[0], checksum: 'f'.repeat(64) },
  ] });
  assert.equal(changedLedger.plan.route, 'R0');
  assert.ok(changedLedger.plan.blockers.includes('unsupported-transition'));
  assert.throws(() => admitBootstrap({ ...changedLedger, mode: 'bootstrap', initializeDatabase: true }), /does not admit/u);
});

test('Preflight admits setup after the schema/marker boundary and resumes an intact grant or staged setup API', () => {
  // Before the setup unit is installed the observer reports the same pending
  // state for a missing grant and a complete encrypted grant handoff.
  for (const [checkpoint, backend] of Object.entries({
    'before setup Quadlet installation': { state: 'absent' },
    'after setup Quadlet installation': { state: 'setup', unitSha256: hash },
    'after setup API start': { state: 'setup', containerSha256: hash },
  })) {
    const input = observedSetup(setupBeforeGrant, backend);
    assert.equal(input.plan.candidateRoute, 'R5', checkpoint);
    assert.deepEqual(admitBootstrap({ ...input, mode: 'owner-setup' }), {
      route: 'R5', stages: [], installIntent: false,
    });
  }
});

test('Preflight stops when grant issuance is incomplete and invalidates earlier approval after observation changes', () => {
  const before = observedSetup(setupBeforeGrant);
  const interrupted = observedSetup({ ...setupBeforeGrant, authState: 'recovery' });
  assert.equal(interrupted.plan.route, 'R0');
  assert.throws(() => admitBootstrap({ ...interrupted, mode: 'owner-setup' }), /does not admit/u);
  assert.throws(() => admitBootstrap({ ...before, current: interrupted.current, mode: 'owner-setup' }),
    /changed after approval/u);
});

test('Preflight admits resuming activation preparation without owner reissuance across setup shutdown', () => {
  const enrolled = { ...setupBeforeGrant, authState: 'unprepared', ownerBindingSha256: 'sha256:' + hash };
  for (const [checkpoint, backend] of Object.entries({
    'after owner enrolls and before setup shutdown': { state: 'setup', containerSha256: hash },
    'after setup shutdown and before preparation marker': { state: 'absent' },
  })) {
    const interrupted = observedSetup(enrolled, backend);
    assert.equal(interrupted.plan.candidateRoute, 'R5', checkpoint);
    assert.throws(() => admitBootstrap({ ...interrupted, mode: 'owner-setup' }), /owner state/u);
    assert.deepEqual(admitBootstrap({ ...interrupted, mode: 'prepare-activation' }), {
      route: 'R5', stages: [], installIntent: false,
    });
  }
  const prepared = observedSetup({ ...enrolled, authState: 'ready', settingsSha256: hash });
  assert.equal(prepared.plan.candidateRoute, 'R6');
  assert.equal(prepared.plan.route, 'R0');
  assert.ok(prepared.plan.blockers.includes('missing-preservation-evidence'));
  assert.throws(() => admitBootstrap({ ...prepared, mode: 'prepare-activation' }), /does not admit/u);
});
