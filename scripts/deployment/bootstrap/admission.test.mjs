import assert from 'node:assert/strict';
import test from 'node:test';
import { migrationSetFingerprint } from '../../../packages/persistence-postgres/src/migration-set.ts';
import { createDeploymentPlan } from '../preflight/plan.mjs';
import { planFromObservations } from '../preflight/observe.mjs';
import { frontendOAuthConfigIdentity } from '../../build/frontend/oauth-config.mjs';
import { admitBootstrap, ownerSetupFrontendBindings, initialFrontendNeedsPublication, assertInitialFrontendReady } from './admission.mjs';

const hash = 'a'.repeat(64);
const now = new Date('2026-11-24T06:00:00.000Z');
const observedAt = '2026-11-24T05:59:00.000Z';

function fixture(state = {}, overrides = {}, backupSha256 = null) {
  const current = {
    observation: {
      state: { M: 'ready', H: 'partial', D: 'absent', A: 'absent', B: 'absent', F: 'absent', T: 'none', ...state },
      observedAt: now.toISOString(),
      binding: {
        environment: 'codexia-production', hostPinSha256: hash, hostId: hash,
        databaseSha256: hash, authSha256: hash, backendSha256: hash, frontendSha256: hash,
        ingressSha256: hash, transactionSha256: hash, infrastructureSha256: hash, backupSha256,
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
    ...fixture({ D: 'compatible', A: 'ready' }, { intent: 'adopt' }, hash), mode: 'bootstrap',
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

test('[TEST-OPS-001-001] R5 separates enrollment start from preparation, and rejects existing owner reissuance', () => {
  const pending = fixture({ H: 'ready', D: 'compatible', A: 'pending' });
  const enrolled = fixture({ H: 'ready', D: 'compatible', A: 'unprepared', B: 'setup' });
  assert.deepEqual(admitBootstrap({ ...pending, mode: 'owner-setup' }), {
    route: 'R5', stages: [], installIntent: false,
  });
  assert.deepEqual(admitBootstrap({ ...enrolled, mode: 'prepare-activation' }), {
    route: 'R5', stages: [], installIntent: false,
  });
  assert.deepEqual(admitBootstrap({ ...pending, mode: 'publish-frontend' }), {
    route: 'R5', stages: [], installIntent: false,
  });
  assert.throws(() => admitBootstrap({ ...enrolled, mode: 'publish-frontend' }), /owner state/);
  assert.throws(() => admitBootstrap({ ...enrolled, mode: 'owner-setup' }), /owner state/);
  assert.throws(() => admitBootstrap({ ...pending, mode: 'prepare-activation' }), /owner state/);
  assert.throws(() => admitBootstrap({
    ...fixture({ H: 'ready', D: 'compatible', A: 'ready' }), mode: 'owner-setup',
  }), /route/);
});

test('owner setup resumes a legacy artifact with its exact client and registered callbacks', () => {
  const origin = 'https://example.invalid';
  const current = JSON.parse(frontendOAuthConfigIdentity({
    VITE_CODEXIA_OAUTH_ISSUER: origin + '/api/auth',
    VITE_CODEXIA_OAUTH_CLIENT_ID: 'codexia-web',
    VITE_CODEXIA_API_AUDIENCE: origin + '/api',
    VITE_CODEXIA_OAUTH_DESKTOP_REDIRECT_URI: origin + '/desktop/',
  }));
  const { scopes, ...desktopSettings } = current.settings;
  const legacyIdentity = JSON.stringify({
    format: 'codexia-web-oauth-config/v1',
    settings: { ...desktopSettings, mobileRedirectUri: origin + '/mobile/', scopes },
  });

  assert.deepEqual(ownerSetupFrontendBindings(legacyIdentity, origin), {
    codexia_owner_setup_expected_origin: origin,
    codexia_owner_setup_expected_web_client_id: 'codexia-web',
    codexia_owner_setup_expected_web_redirect_uris: [origin + '/desktop/', origin + '/mobile/'],
  });
});

test('owner setup uses the exact certified browser origin, client and return URIs', () => {
  const origin = 'https://example.invalid';
  const identity = frontendOAuthConfigIdentity({
    VITE_CODEXIA_OAUTH_ISSUER: origin + '/api/auth',
    VITE_CODEXIA_OAUTH_CLIENT_ID: 'codexia-web',
    VITE_CODEXIA_API_AUDIENCE: origin + '/api',
    VITE_CODEXIA_OAUTH_DESKTOP_REDIRECT_URI: origin + '/desktop/',
  });
  assert.deepEqual(ownerSetupFrontendBindings(identity, origin), {
    codexia_owner_setup_expected_origin: origin,
    codexia_owner_setup_expected_web_client_id: 'codexia-web',
    codexia_owner_setup_expected_web_redirect_uris: [origin + '/desktop/'],
  });
  assert.throws(() => ownerSetupFrontendBindings(identity, 'https://another.invalid'), /origin and audience/);
  assert.throws(() => ownerSetupFrontendBindings(undefined, origin), /origin and audience/);
});

const schema = 'sha256:' + 'b'.repeat(64);
const backendImage = 'ghcr.io/yohn-jp/codexia-backend@sha256:' + 'c'.repeat(64);
const ledger = [{ version: '0001-initial.sql', checksum: 'd'.repeat(64) }];
const installation = { clusterId: '123', databaseOid: '456', image: backendImage };

function observedSetup(database, backend = { state: 'absent' }, intent = 'install', frontendReady = false) {
  const origin = 'https://example.invalid';
  const publicConfig = frontendOAuthConfigIdentity({
    VITE_CODEXIA_OAUTH_ISSUER: origin + '/api/auth',
    VITE_CODEXIA_OAUTH_CLIENT_ID: 'codexia-web',
    VITE_CODEXIA_API_AUDIENCE: origin + '/api',
    VITE_CODEXIA_OAUTH_DESKTOP_REDIRECT_URI: origin + '/desktop/',
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
    window: { id: 'first-activation', notBefore: observedAt, notAfter: '2026-11-24T06:05:00.000Z' },
    host: {
      format: 'codexia-lifecycle-host/v1', hostId: hash, M: 'ready', H: 'ready',
      observedAt: at, topology, backend, transaction: null,
      database: { state: 'initialized', clusterId: installation.clusterId, ledger, ...database },
    },
    edge: { observedAt: at, origin, ingressDigest: 'sha256:' + hash,
      deployment: frontendReady ? { versionId: 'version' } : null, frontendState: frontendReady ? 'running' : 'absent',
      frontend: frontendReady ? { format: 'codexia-frontend-identity/v1', version: '1.0.0', sourceSha: 'b'.repeat(40),
        profile: 'full', apiEpoch: 2, oauthConfigIdentity: publicConfig } : null, backend: null },
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
  ownerSetupCheckpoint: {
    setupMarkerPresent: false, grantBindingSha256: null,
    pendingHandoff: false, encryptedHandoffPresent: false,
  },
};
const setupWithMarker = {
  ...setupBeforeGrant, ownerSetupCheckpoint: { ...setupBeforeGrant.ownerSetupCheckpoint, setupMarkerPresent: true },
};
const setupWithGrant = {
  ...setupWithMarker, ownerSetupCheckpoint: {
    ...setupWithMarker.ownerSetupCheckpoint, grantBindingSha256: 'e'.repeat(64), encryptedHandoffPresent: true,
  },
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
  assert.deepEqual(admitBootstrap({ ...input, mode: 'bootstrap', resumeAuthOnly: true }), {
    route: 'R4', stages: ['auth-runtime'], installIntent: true,
  });
  assert.throws(() => admitBootstrap({
    ...input, mode: 'bootstrap', resumeAuthOnly: true, initializeDatabase: true,
  }), /no database initialization request/u);
  const altered = structuredClone(input);
  altered.plan.observation.bootstrapResume.checkpoint = 'auth-schema-with-tables';
  assert.throws(() => admitBootstrap({ ...altered, mode: 'bootstrap', initializeDatabase: true }), /altered|Invalid/u);
});

test('R4 admits only the explicit empty-auth checkpoint and binds its distinct resume mode', () => {
  const input = observedSetup({ ...schemaWithoutMarker, emptyAuthSchema: true,
    bootstrapIntent: installation, authSchemaSha256: schema });
  assert.deepEqual(input.plan.observation.bootstrapResume, {
    ...installation, migrationFingerprint: migrationSetFingerprint(ledger), checkpoint: 'empty-auth-schema',
  });
  assert.equal(input.plan.candidateRoute, 'R4');
  assert.deepEqual(input.plan.requiredApprovals, ['bootstrap', 'database-initialization']);
  assert.deepEqual(admitBootstrap({ ...input, mode: 'bootstrap', initializeDatabase: true }), {
    route: 'R4', stages: ['auth-runtime'], installIntent: true,
  });
  const dirty = observedSetup({ ...schemaWithoutMarker, emptyAuthSchema: false,
    authState: 'unknown', bootstrapIntent: installation });
  assert.equal(dirty.plan.route, 'R0');
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
  assert.ok(changedLedger.plan.blockers.includes('state-or-intent-not-admitted'));
  assert.throws(() => admitBootstrap({ ...changedLedger, mode: 'bootstrap', initializeDatabase: true }), /does not admit/u);
});

test('Preflight resumes an intact grant or staged setup API through newly approved R5 evidence', () => {
  for (const [checkpoint, backend] of Object.entries({
    'before setup Quadlet installation': { state: 'absent' },
    'after setup Quadlet installation': { state: 'setup', unitSha256: hash },
    'after setup API start': { state: 'setup', containerSha256: hash },
  })) {
    const input = observedSetup(setupWithGrant, backend);
    assert.equal(input.plan.candidateRoute, 'R5', checkpoint);
    assert.deepEqual(admitBootstrap({ ...input, mode: 'owner-setup' }), {
      route: 'R5', stages: [], installIntent: false,
    });
  }
});

test('R5 rejects reusing approvals across marker, grant issuance and grant replacement', () => {
  const checkpoints = [
    observedSetup(setupBeforeGrant),
    observedSetup(setupWithMarker),
    observedSetup(setupWithGrant),
    observedSetup({ ...setupWithGrant, ownerSetupCheckpoint: {
      ...setupWithGrant.ownerSetupCheckpoint, grantBindingSha256: 'f'.repeat(64),
    } }),
  ];
  assert.equal(new Set(checkpoints.map(({ plan }) => plan.observation.binding.databaseSha256)).size, checkpoints.length);
  for (const [index, reviewed] of checkpoints.entries()) {
    assert.equal(reviewed.plan.candidateRoute, 'R5');
    assert.deepEqual(admitBootstrap({ ...reviewed, mode: 'owner-setup' }), {
      route: 'R5', stages: [], installIntent: false,
    });
    for (const later of checkpoints.slice(index + 1)) {
      assert.throws(() => admitBootstrap({ ...reviewed, current: later.current, mode: 'owner-setup' }),
        /changed after approval/u);
    }
  }
});

test('Preflight stops when grant issuance is incomplete and invalidates earlier approval after observation changes', () => {
  const before = observedSetup(setupWithMarker);
  const interrupted = observedSetup({ ...setupWithGrant, authState: 'recovery', ownerSetupCheckpoint: {
    ...setupWithGrant.ownerSetupCheckpoint, pendingHandoff: true, encryptedHandoffPresent: false,
  } });
  assert.equal(interrupted.plan.route, 'R0');
  assert.throws(() => admitBootstrap({ ...interrupted, mode: 'owner-setup' }), /does not admit/u);
  assert.throws(() => admitBootstrap({ ...before, current: interrupted.current, mode: 'owner-setup' }),
    /changed after approval/u);
});

test('Preflight admits resuming activation preparation without owner reissuance across setup shutdown', () => {
  const enrolled = { ...setupWithGrant, authState: 'unprepared', ownerBindingSha256: 'sha256:' + hash };
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
  const beforeSettings = observedSetup(enrolled);
  const afterSettings = observedSetup({ ...enrolled, settingsSha256: hash });
  assert.equal(afterSettings.plan.candidateRoute, 'R5');
  assert.throws(() => admitBootstrap({ ...beforeSettings, current: afterSettings.current, mode: 'prepare-activation' }),
    /changed after approval/u);
  assert.deepEqual(admitBootstrap({ ...afterSettings, mode: 'prepare-activation' }), {
    route: 'R5', stages: [], installIntent: false,
  });
  const prepared = observedSetup({ ...enrolled, authState: 'ready', settingsSha256: hash, bootstrapIntent: installation }, { state: 'absent' }, 'install', true);
  assert.equal(prepared.plan.candidateRoute, 'R6');
  assert.equal(prepared.plan.route, 'R0');
  assert.deepEqual(prepared.plan.blockers, ['approval-required']);
  assert.throws(() => admitBootstrap({ ...prepared, mode: 'prepare-activation' }), /does not admit/u);
});

test('R5 normal frontend publication requires protected canonical ingress and an observed identity', () => {
  const candidate = { format: 'codexia-frontend-identity/v1', sourceSha: 'a'.repeat(40),
    version: '1.2.3', profile: 'full', apiEpoch: 3 };
  const empty = { routesReady: true, publicProtocolEnabled: false, 
    backend: null, frontendState: 'absent', deployment: null, frontend: null };
  assert.equal(initialFrontendNeedsPublication(empty, candidate), true);
  assert.throws(() => assertInitialFrontendReady(empty, candidate), /certified candidate/u);
  const deployed = { ...empty, frontendState: 'running', deployment: { versionId: 'version' }, frontend: candidate };
  assert.equal(initialFrontendNeedsPublication(deployed, candidate), false);
  assertInitialFrontendReady(deployed, candidate);
  assert.equal(initialFrontendNeedsPublication({ ...deployed, frontend: { ...candidate, version: '1.2.2' } }, candidate), true);
  assert.throws(() => initialFrontendNeedsPublication({ ...deployed, frontend: { ...candidate, version: '1.2.4' } }, candidate), /older/u);
  for (const changed of [
    { routesReady: false }, { publicProtocolEnabled: true },
    { backend: {} }, { frontendState: 'unknown' },
  ]) assert.throws(() => initialFrontendNeedsPublication({ ...empty, ...changed }, candidate));
});
