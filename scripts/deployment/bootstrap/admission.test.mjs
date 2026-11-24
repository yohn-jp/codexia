import assert from 'node:assert/strict';
import test from 'node:test';
import { createDeploymentPlan } from '../preflight/plan.mjs';
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
