import { isDeepStrictEqual } from 'node:util';
import { digestEvidence } from './evidence-digest.mjs';

// Normalized observations are produced by trusted read-only adapters, not by a
// workflow dispatch request. Unknown is distinct from positively observed absence.
export const STATES = Object.freeze({
  M: Object.freeze(['unprepared', 'ready', 'unknown']),
  H: Object.freeze(['absent', 'partial', 'ready', 'drift', 'unknown']),
  D: Object.freeze(['absent', 'pristine', 'compatible', 'incompatible', 'lost', 'unknown']),
  A: Object.freeze(['absent', 'pending', 'unprepared', 'ready', 'legacy', 'incompatible', 'recovery', 'unknown']),
  B: Object.freeze(['absent', 'setup', 'compatible', 'incompatible', 'fault', 'unknown']),
  F: Object.freeze(['absent', 'compatible', 'incompatible', 'fault', 'unknown']),
  T: Object.freeze(['none', 'resume', 'recover', 'unknown']),
});
const axes = Object.keys(STATES);
const intents = ['install', 'adopt', 'update', 'maintenance', 'restore'];
const systems = Object.freeze({
  R0: null, R1: 'recovery', R2: 'recovery', R3: 'recovery',
  R4: 'bootstrap', R5: 'bootstrap', R6: 'bootstrap', R8: 'update',
});
const hashPattern = /^[a-f0-9]{64}$/u;
const changes = Object.freeze(['backend', 'frontend', 'api-epoch', 'oauth-contract',
  'sql-ledger', 'persistence-format', 'auth-schema', 'auth-mode', 'infrastructure']);
const mutationApprovals = Object.freeze({
  R0: [], R1: ['recovery'], R2: ['recovery'], R3: ['maintenance'],
  R4: ['bootstrap'], R5: ['owner-enrollment'], R6: ['first-install', 'database-use', 'publication'],
  R8: [],
});

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}
function record(value, fields) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === fields.length && fields.every(key => Object.hasOwn(value, key));
}
function timestamp(value) {
  const ms = Date.parse(value);
  requireCondition(typeof value === 'string' && Number.isFinite(ms) &&
    new Date(ms).toISOString() === value, 'Invalid deployment timestamp');
  return ms;
}
export function assertFreshObservationTime(value, { now = new Date(), maxAgeMs = 5 * 60_000 } = {}) {
  requireCondition(Number.isSafeInteger(maxAgeMs) && maxAgeMs > 0 &&
    now instanceof Date && Number.isFinite(now.getTime()), 'Invalid observation freshness policy');
  const observed = timestamp(value);
  requireCondition(observed <= now.getTime() && now.getTime() - observed <= maxAgeMs,
    'Stale or future deployment observation');
  return observed;
}
function validAxes(state) {
  return record(state, axes) && axes.every(key => STATES[key].includes(state[key]));
}

// Ordered lifecycle decision table. Admission evidence and change details are
// checked separately; no R0 result confers permission to mutate.
export function selectRoute(state, intent, frontendAdmission, bootstrapResume = false, restored = false) {
  requireCondition(validAxes(state) && intents.includes(intent) &&
    ['allowed', 'denied', 'not-applicable', 'unknown'].includes(frontendAdmission),
  'Invalid normalized deployment observation');
  const { M, H, D, A, B, F, T } = state;
  if (M !== 'ready' || T === 'unknown') return 'R0';
  if (T !== 'none') return 'R1';
  if (D === 'lost') return intent === 'restore' ? 'R2' : 'R0';
  if (axes.some(key => state[key] === 'unknown')) return 'R0';
  if (intent === 'restore') {
    return restored && H === 'ready' && D === 'compatible' && A === 'ready' &&
      B === 'absent' && F === 'compatible' ? 'R3' : 'R0';
  }
  // A positively absent database has no prior schema or owner to migrate.
  if (intent === 'install' && D === 'absent' && A === 'absent' &&
      ['ready', 'partial'].includes(H) && ['absent', 'fault'].includes(B) && F !== 'fault') return 'R4';
  if (H === 'absent' && (['compatible', 'incompatible'].includes(D) || B !== 'absent')) return 'R0';
  // A clean database cannot substantiate an existing installed writer or owner.
  if (['absent', 'pristine'].includes(D) &&
      (['ready', 'legacy', 'unprepared'].includes(A) || ['setup', 'compatible', 'incompatible'].includes(B))) return 'R0';
  if (['compatible', 'incompatible'].includes(B) && ['absent', 'pending', 'unprepared'].includes(A)) return 'R0';
  if (D === 'incompatible' || ['legacy', 'incompatible'].includes(A) || B === 'incompatible') return 'R0';
  if (H === 'drift' || A === 'recovery' || B === 'fault' || F === 'fault') return 'R3';
  if (bootstrapResume && intent === 'install' && H === 'ready' && D === 'compatible' &&
      A === 'absent' && B === 'absent') return 'R4';
  if (['absent', 'partial'].includes(H) || ['absent', 'pristine'].includes(D) || A === 'absent') {
    if (!['install', 'adopt'].includes(intent)) return 'R0';
    if (intent === 'adopt' && ['absent', 'pristine'].includes(D)) return 'R0';
    // Existing owners may be adopted, but a missing owner on an existing
    // database is not permission to create one.
    if (A === 'absent' && (intent === 'adopt' || D === 'compatible')) return 'R0';
    return 'R4';
  }
  if (['pending', 'unprepared'].includes(A) || B === 'setup') {
    return intent === 'install' && ['pending', 'unprepared'].includes(A) &&
      ['absent', 'setup'].includes(B) ? 'R5' : 'R0';
  }
  if (A !== 'ready' || H !== 'ready' || D !== 'compatible') return 'R0';
  if (B === 'absent') return ['install', 'adopt'].includes(intent) && F === 'compatible' ? 'R6' : 'R0';
  if (F === 'absent') return 'R0';
  if (F === 'incompatible') {
    if (frontendAdmission === 'allowed') return 'R8';
    return 'R0';
  }
  return frontendAdmission === 'allowed' ? 'R8' : 'R0';
}

function validateObservation(observation) {
  const fields = ['state', 'observedAt', 'binding', 'frontendAdmission', 'changeAxes'];
  if (Object.hasOwn(observation ?? {}, 'bootstrapResume')) fields.push('bootstrapResume');
  if (Object.hasOwn(observation ?? {}, 'recoveryOperationId')) fields.push('recoveryOperationId');
  requireCondition(record(observation, fields),
    'Invalid deployment observation envelope');
  requireCondition(validAxes(observation.state), 'Invalid deployment state');
  timestamp(observation.observedAt);
  const { binding, changeAxes, bootstrapResume } = observation;
  if (fields.includes('recoveryOperationId')) {
    requireCondition(typeof observation.recoveryOperationId === 'string' &&
      /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/u.test(observation.recoveryOperationId) &&
      hashPattern.test(binding?.backupSha256 ?? ''), 'Invalid protected recovery evidence');
  }
  if (fields.includes('bootstrapResume')) {
    const resumeFields = Object.hasOwn(bootstrapResume ?? {}, 'checkpoint')
      ? ['clusterId', 'databaseOid', 'image', 'migrationFingerprint', 'checkpoint']
      : ['clusterId', 'databaseOid', 'image', 'migrationFingerprint'];
    requireCondition(record(bootstrapResume, resumeFields) &&
      typeof bootstrapResume.clusterId === 'string' && /^[1-9][0-9]{0,19}$/u.test(bootstrapResume.clusterId) &&
      typeof bootstrapResume.databaseOid === 'string' && /^[1-9][0-9]{0,9}$/u.test(bootstrapResume.databaseOid) &&
      typeof bootstrapResume.image === 'string' && /^ghcr\.io\/[a-z0-9-]+\/codexia-backend@sha256:[a-f0-9]{64}$/u.test(bootstrapResume.image) &&
      typeof bootstrapResume.migrationFingerprint === 'string' && /^sha256:[a-f0-9]{64}$/u.test(bootstrapResume.migrationFingerprint) &&
      (!Object.hasOwn(bootstrapResume, 'checkpoint') || bootstrapResume.checkpoint === 'empty-auth-schema'),
    'Invalid bootstrap continuation evidence');
  }
  // Digests refer to verified redacted evidence held by the existing owning
  // components. No credential, raw probe response or arbitrary text belongs here.
  requireCondition(record(binding, ['environment', 'hostPinSha256', 'hostId', 'databaseSha256',
    'authSha256', 'backendSha256', 'frontendSha256', 'ingressSha256', 'transactionSha256',
    'infrastructureSha256', 'backupSha256']) &&
    binding.environment === 'codexia-production' &&
    typeof binding.hostPinSha256 === 'string' && hashPattern.test(binding.hostPinSha256) &&
    Object.keys(binding).filter(key => !['environment', 'hostPinSha256'].includes(key))
      .every(key => binding[key] === null || (typeof binding[key] === 'string' && hashPattern.test(binding[key]))),
  'Invalid deployment evidence binding');
  requireCondition(Array.isArray(changeAxes) && changeAxes.every(key => changes.includes(key)) &&
    new Set(changeAxes).size === changeAxes.length, 'Invalid deployment change axes');
}
function validateTarget(target) {
  requireCondition(record(target, ['backendCertificateSha256', 'frontendArtifactSha256', 'identitySha256']) &&
    Object.values(target).every(value => typeof value === 'string' && hashPattern.test(value)),
  'Invalid candidate evidence binding');
}
function validateWindow(window) {
  requireCondition(record(window, ['id', 'notBefore', 'notAfter']) &&
    typeof window.id === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/u.test(window.id) &&
    timestamp(window.notBefore) < timestamp(window.notAfter), 'Invalid deployment window');
}

// This is a planning interface, not an approval issuer. The caller must supply
// evidence from existing authenticated release and state observers. A digest
// establishes identity, not the authenticity of evidence.
export function createDeploymentPlan({ observation, target, intent, window = null,
  now = new Date(), maxAgeMs = 5 * 60_000, evidenceBlockers = [] }) {
  validateObservation(observation);
  validateTarget(target);
  assertFreshObservationTime(observation.observedAt, { now, maxAgeMs });
  if (window !== null) validateWindow(window);
  const restored = intent === 'restore' && observation.recoveryOperationId !== undefined;
  const candidateRoute = selectRoute(observation.state, intent, observation.frontendAdmission,
    observation.bootstrapResume !== undefined, restored);
  const { binding, state } = observation;
  const knownBlockers = ['unverified-installed-backend-publication', 'stale-backend-candidate',
    'stale-or-conflicting-frontend-candidate', 'writer-ledger-identity-mismatch', 'recovery-plan-required',
    'unverified-fresh-installation'];
  requireCondition(Array.isArray(evidenceBlockers) && evidenceBlockers.every(reason => knownBlockers.includes(reason)) &&
    new Set(evidenceBlockers).size === evidenceBlockers.length, 'Invalid external evidence blockers');
  const blockers = [...evidenceBlockers].sort();
  if (candidateRoute === 'R0') blockers.push('state-or-intent-not-admitted');
  // All positive paths need a pinned host and edge observation; the adapter
  // represents verified absence by hashing the observation, not by null.
  if (!binding.hostId || !binding.ingressSha256 || !binding.infrastructureSha256 ||
      !binding.databaseSha256 || !binding.authSha256 || !binding.backendSha256 ||
      !binding.frontendSha256 || !binding.transactionSha256) blockers.push('incomplete-state-evidence');
  const changeAxes = changes.filter(key => observation.changeAxes.includes(key));
  const migrationAxes = ['api-epoch', 'oauth-contract', 'sql-ledger', 'persistence-format', 'auth-schema', 'auth-mode'];
  if (candidateRoute === 'R8' && changeAxes.some(key => migrationAxes.includes(key))) blockers.push('incompatible-ordinary-update');
  const requiresPreservation = ['R3', 'R2'].includes(candidateRoute) ||
    (candidateRoute === 'R4' && state.D === 'compatible' && state.A === 'ready') ||
    (candidateRoute === 'R6' && intent === 'adopt');
  if (requiresPreservation && !binding.backupSha256) blockers.push('missing-preservation-evidence');
  if (['R1', 'R2', 'R3', 'R6'].includes(candidateRoute) &&
      (window === null || timestamp(window.notAfter) < now.getTime())) blockers.push('missing-or-expired-window');
  const requiredApprovals = candidateRoute === 'R6' && intent === 'adopt'
    ? ['database-adoption', 'publication'] : [...mutationApprovals[candidateRoute]];
  if (candidateRoute === 'R3' && restored) requiredApprovals.push('recovery', 'publication');
  if (candidateRoute === 'R4' && (observation.bootstrapResume || ['absent', 'pristine'].includes(state.D))) {
    requiredApprovals.push('database-initialization');
  }
  const candidateSystem = systems[candidateRoute];
  if (requiredApprovals.length) blockers.push('approval-required');
  const route = blockers.length ? 'R0' : candidateRoute;
  const plan = { format: 'codexia-deployment-plan/v1', observation: { ...observation, changeAxes,
    binding: requiresPreservation ? binding : { ...binding, backupSha256: null } },
    evidenceBlockers: [...evidenceBlockers].sort(),
    target, intent, window, candidateRoute, candidateSystem, route,
    system: route === 'R0' ? null : candidateSystem,
    requiredApprovals, blockers,
    noOp: route === 'R8' && changeAxes.length === 0,
    authorization: 'pending',
    requiredAcceptance: ['identity', 'health', 'access-boundary', 'single-writer', 'data-and-auth'],
    requiresPreservation };
  return { plan, planSha256: digestEvidence(plan) };
}

// Revalidate the first mutation admission after acquiring the production queue
// and host lock. Subsequent checkpoint validation is owned by the executor;
// a changed source is never treated as a retry of this initial snapshot.
export function assertDeploymentPlanBinding({ plan, planSha256, approval,
  now = new Date(), maxAgeMs = 5 * 60_000, recover = false }) {
  const evidenceReady = value => value?.candidateRoute !== 'R0' && Array.isArray(value?.blockers) &&
    value.blockers.every(reason => reason === 'approval-required');
  requireCondition(plan?.format === 'codexia-deployment-plan/v1' && evidenceReady(plan) &&
    typeof planSha256 === 'string' && hashPattern.test(planSha256) && digestEvidence(plan) === planSha256,
  'Deployment plan is blocked or altered');
  requireCondition(record(approval, ['planSha256', 'grants']) && approval.planSha256 === planSha256 &&
    Array.isArray(approval.grants) && isDeepStrictEqual([...approval.grants].sort(), [...plan.requiredApprovals].sort()),
  'Approval does not match exact deployment plan and required grants');
  // The original plan must have been correctly generated from its own evidence.
  const expected = createDeploymentPlan({ ...plan, now: new Date(plan.observation.observedAt), maxAgeMs });
  requireCondition(expected.planSha256 === planSha256, 'Deployment plan does not match route contract');
  if (plan.window !== null) requireCondition(timestamp(plan.window.notBefore) <= now.getTime() &&
    (recover || now.getTime() <= timestamp(plan.window.notAfter)), 'Outside approved deployment window');
  return planSha256;
}

export function assertDeploymentPlanApproval({ plan, planSha256, approval, current,
  now = new Date(), maxAgeMs = 5 * 60_000 }) {
  assertDeploymentPlanBinding({ plan, planSha256, approval, now, maxAgeMs });
  const refreshed = createDeploymentPlan({ ...current, now, maxAgeMs });
  const evidenceReady = refreshed.plan.candidateRoute !== 'R0' &&
    refreshed.plan.blockers.every(reason => reason === 'approval-required');
  requireCondition(evidenceReady &&
    isDeepStrictEqual({ ...plan, observation: { ...plan.observation, observedAt: null } },
      { ...refreshed.plan, observation: { ...refreshed.plan.observation, observedAt: null } }),
  'Deployment source, candidate, intent or evidence changed after approval');
  return planSha256;
}
