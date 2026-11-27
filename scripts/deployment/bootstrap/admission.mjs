import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import { assertFrontendReleaseAdmission } from '../../release/frontend/verify-compatibility.mjs';
import { parsePublicFrontendConfigIdentity } from '../../build/frontend/oauth-config.mjs';
import { assertDeploymentPlanApproval, assertFreshObservationTime } from '../preflight/plan.mjs';

const stages = ['host', 'secrets', 'base', 'auth-runtime'];

export function admitBootstrap({ mode, plan, planSha256, current, topology,
  initializeDatabase = false, resumeAuthOnly = false, now = new Date() }) {
  const route = { bootstrap: 'R4', 'publish-frontend': 'R5', 'owner-setup': 'R5', 'prepare-activation': 'R5' }[mode];
  assert.ok(route, 'Unsupported bootstrap admission mode');
  assertFreshObservationTime(current.observation.observedAt, { now });
  assert.ok(Date.parse(plan?.observation?.observedAt) <= Date.parse(current.observation.observedAt),
    'Invalid approved observation timestamp');
  assert.equal(plan.candidateRoute, route, 'Observed deployment route does not admit this operation');
  const grants = route === 'R4' ? ['bootstrap'] : ['owner-enrollment'];
  if (resumeAuthOnly) {
    assert.ok(route === 'R4' && plan.observation.bootstrapResume && !initializeDatabase,
      'Auth-only continuation requires the verified R4 checkpoint and no database initialization request');
  }
  if (initializeDatabase || resumeAuthOnly) {
    assert.equal(route, 'R4', 'Only bootstrap can authorize database initialization or continuation');
    grants.push('database-initialization');
  }
  assertDeploymentPlanApproval({ plan, planSha256, approval: { planSha256, grants }, current, now });

  const state = plan.observation.state;
  if (route === 'R5') {
    const expected = mode === 'prepare-activation' ? 'unprepared' : 'pending';
    assert.equal(state.A, expected, 'Observed owner state does not admit this operation');
    assert.ok(state.H === 'ready' && state.D === 'compatible' && ['absent', 'setup'].includes(state.B),
      'Owner operation requires a ready host, compatible database and no ordinary API writer');
    return { route, stages: [], installIntent: false };
  }
  if (plan.observation.bootstrapResume) return { route, stages: ['auth-runtime'], installIntent: true };
  const needsHost = topology?.hostReady !== true;
  const needsSecrets = ['codexia-tunnel-token', 'codexia-postgres-admin-password', 'codexia-postgres-app-password']
    .some(secret => topology?.secrets?.[secret] !== true);
  const needsBase = state.H !== 'ready' || state.D !== 'compatible';
  const needsAuth = state.A === 'absent';
  const required = [needsHost, needsSecrets, needsBase, needsAuth];
  return {
    route, stages: stages.filter((_, index) => required[index]),
    installIntent: needsAuth && plan.intent === 'install' && initializeDatabase,
  };
}

export function ownerSetupFrontendBindings(identity, origin) {
  const settings = parsePublicFrontendConfigIdentity(identity);
  assert.ok(settings && settings.issuer === origin + '/api/auth' && settings.apiAudience === origin + '/api',
    'Certified frontend OAuth issuer must match the observed origin and audience');
  const redirects = [settings.desktopRedirectUri];
  if (settings.mobileRedirectUri && settings.mobileRedirectUri !== settings.desktopRedirectUri) {
    redirects.push(settings.mobileRedirectUri);
  }
  return {
    codexia_owner_setup_expected_origin: origin,
    codexia_owner_setup_expected_web_client_id: settings.clientId,
    codexia_owner_setup_expected_web_redirect_uris: redirects,
  };
}

/** R5 has its own exact-plan admission; the ordinary release gate is unchanged. */
export function initialFrontendNeedsPublication(edge, candidate) {
  assert.ok(edge?.routesReady && edge.publicProtocolEnabled === false &&
    edge.backend === null,
  'Initial frontend requires protected canonical ingress and no ordinary API writer');
  if (edge.frontendState === 'absent') {
    assert.equal(edge.deployment, null, 'Frontend absence must be positively observed');
    return true;
  }
  assert.ok(edge.frontendState === 'running' && edge.deployment && edge.frontend,
    'Existing frontend identity must be observed');
  return assertFrontendReleaseAdmission(edge.frontend, candidate);
}

export function assertInitialFrontendReady(edge, candidate) {
  assert.equal(initialFrontendNeedsPublication(edge, candidate), false,
    'The canonical frontend must serve the certified candidate');
  assert.ok(isDeepStrictEqual(edge.frontend, candidate), 'Live frontend differs from the certified identity');
}
