import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import { digestEvidence } from './evidence-digest.mjs';
import { parsePublicFrontendConfigIdentity } from '../../build/frontend/oauth-config.mjs';
import { validateBackendIdentity } from '../../release/backend/update-identity.mjs';
import { assertFrontendIdentity, assertFrontendReleaseAdmission } from '../../release/frontend/verify-compatibility.mjs';
import { compareComponentVersions } from '../../release/components/version.mjs';
import { migrationSetFingerprint } from '../../../packages/persistence-postgres/src/migration-set.ts';
import { assertFreshObservationTime, createDeploymentPlan } from './plan.mjs';

const rawHash = /^[a-f0-9]{64}$/u;
const taggedHash = /^sha256:[a-f0-9]{64}$/u;
import { actionsRepository, assertBackendImageDigest } from '../../github/repository.mjs';
const unknown = { M: 'unknown', H: 'unknown', D: 'unknown', A: 'unknown', B: 'unknown', F: 'unknown', T: 'unknown' };
const hash = value => value == null ? null : digestEvidence(value);
const fields = ['format', 'sourceSha', 'version', 'profile', 'apiEpoch', 'oauthConfigIdentity'];

function frontendIdentity(value) {
  assertFrontendIdentity(value);
  assert.equal(value.profile, 'full');
  return Object.fromEntries(fields.filter(key => value[key] !== undefined).map(key => [key, value[key]]));
}

function candidateIdentity(backend, frontend, authSchemas, context) {
  const identity = validateBackendIdentity(backend.identity);
  const ui = frontendIdentity(frontend.identity);
  assert.equal(identity.profile, 'full');
  assertBackendImageDigest(backend.image, context.repository);
  assert.equal(identity.apiEpoch, ui.apiEpoch, 'Candidate artifacts do not form a compatible Full pair');
  assert.ok(parsePublicFrontendConfigIdentity(ui.oauthConfigIdentity), 'Candidate frontend has no certified OAuth contract');
  assert.ok(Array.isArray(authSchemas) && authSchemas.length > 0 &&
    authSchemas.every(value => taggedHash.test(value)), 'Candidate auth schema contract is missing');
  assert.ok(rawHash.test(frontend.artifactDigest ?? ''), 'Invalid candidate frontend archive digest');
  return { backend: identity, image: backend.image, frontend: ui, authSchemas: [...new Set(authSchemas)].sort() };
}

export function publicFrontendEvidence(value) {
  if (!value) return null;
  const { format, sourceSha, version, profile, apiEpoch, oauthConfigIdentity } = assertFrontendIdentity(value);
  assert.equal(profile, 'full');
  parsePublicFrontendConfigIdentity(oauthConfigIdentity);
  // The exact archive digest or immutable Worker deployment binds these
  // public settings. Keep only release identity fields in the plan evidence.
  return { format, sourceSha, version, profile, apiEpoch };
}

function hasSameFrontendOAuthContract(deployed, desired) {
  const prior = parsePublicFrontendConfigIdentity(deployed);
  const next = parsePublicFrontendConfigIdentity(desired);
  if (deployed === desired) return true;
  // A newer Desktop-only artifact may drop the retired callback from the
  // public record without changing the Desktop client's OAuth contract.
  if (!prior?.mobileRedirectUri || !next || next.mobileRedirectUri) return false;
  const { mobileRedirectUri, ...desktopConfig } = prior;
  return isDeepStrictEqual(desktopConfig, next);
}

function stateDatabase(database, target, intent) {
  if (!database) return 'unknown';
  if (database.state === 'absent') return intent === 'restore' ? 'lost' : 'absent';
  if (database.state === 'missing') return intent === 'restore' ? 'lost' : intent === 'install' ? 'absent' : 'unknown';
  if (database.state === 'pristine') return 'pristine';
  if (database.state !== 'initialized') return 'unknown';
  return migrationSetFingerprint(database.ledger) === target.backend.migrationFingerprint ? 'compatible' : 'incompatible';
}

// Called only with observations from the protected Ansible/Cloudflare readers
// and authenticated publication/artifact verification. Never accept an operator-
// supplied state, certificate body, digest-only backup claim or transition.
export function planFromObservations({ host, edge, hostPinSha256, candidateBackend,
  candidateFrontend, authSchemas, priorBackend = null, intent, window = null,
  preservationReceipt = null, now = new Date(), context = actionsRepository() }) {
  assert.ok(rawHash.test(hostPinSha256));
  const installed = host?.backend;
  const installedCertificate = installed?.state === 'running' && installed.writer.image === candidateBackend.image
    ? candidateBackend : priorBackend;
  const targetIdentity = candidateIdentity(candidateBackend, candidateFrontend, authSchemas, context);
  const target = {
    backendCertificateSha256: digestEvidence(candidateBackend),
    frontendArtifactSha256: candidateFrontend.artifactDigest,
    identitySha256: digestEvidence({ backend: targetIdentity.backend, image: targetIdentity.image,
      frontend: publicFrontendEvidence(targetIdentity.frontend), authSchemas: targetIdentity.authSchemas }),
  };
  const state = { ...unknown };
  const changeAxes = [];
  let frontendAdmission = 'unknown';
  const blockers = [];
  if (host?.format === 'codexia-lifecycle-host/v1' && rawHash.test(host.hostId ?? '')) {
    state.M = host.M;
    state.H = host.H;
    state.D = stateDatabase(host.database, targetIdentity, intent);
    state.A = host.database?.authState ?? 'unknown';
    // Only a trusted host observation of a missing database can establish this
    // fresh install; old DB-bound owner state cannot be used as an identity.
    if (intent === 'install' && state.D === 'absent') state.A = 'absent';
    state.T = host.transaction ? (['recovering', 'pending'].includes(host.transaction.phase) ? 'recover' : 'resume') : 'none';
    if (state.T !== 'none') blockers.push('recovery-plan-required');
    if (installed?.state === 'running') {
      const writer = installed.writer;
      const identity = validateBackendIdentity(writer.identity);
      assert.equal(identity.profile, 'full');
      assertBackendImageDigest(writer.image, context.repository);
      if (!installedCertificate || installedCertificate.image !== writer.image ||
          !isDeepStrictEqual(installedCertificate.identity, identity)) {
        blockers.push('unverified-installed-backend-publication');
      }
      if (writer.image !== targetIdentity.image) {
        changeAxes.push('backend');
        if (compareComponentVersions(targetIdentity.backend.version, identity.version) <= 0) blockers.push('stale-backend-candidate');
      }
      if (identity.apiEpoch !== targetIdentity.backend.apiEpoch) changeAxes.push('api-epoch');
      if (identity.persistenceFormat !== targetIdentity.backend.persistenceFormat) {
        changeAxes.push('persistence-format');
        if (host.database?.state === 'initialized') state.D = 'incompatible';
      }
      if (identity.migrationFingerprint !== targetIdentity.backend.migrationFingerprint) changeAxes.push('sql-ledger');
      if (writer.authMode !== 'better-auth') changeAxes.push('auth-mode');
      const publicIdentity = edge?.backend;
      if (!publicIdentity || publicIdentity.apiEpoch !== identity.apiEpoch || publicIdentity.version !== identity.version ||
          publicIdentity.profile !== identity.profile) {
        state.B = 'unknown';
      } else {
        if (!publicIdentity.standaloneOAuth) changeAxes.push('oauth-contract');
        state.B = identity.apiEpoch === targetIdentity.backend.apiEpoch &&
          identity.persistenceFormat === targetIdentity.backend.persistenceFormat &&
          identity.migrationFingerprint === targetIdentity.backend.migrationFingerprint &&
          writer.authMode === 'better-auth' && publicIdentity.standaloneOAuth ? 'compatible' : 'incompatible';
      }
    } else if (['absent', 'setup', 'fault'].includes(installed?.state)) {
      state.B = installed.state;
      if (state.B === 'absent') changeAxes.push('backend');
    }
    if (host.database?.state === 'initialized' &&
        migrationSetFingerprint(host.database.ledger) !== targetIdentity.backend.migrationFingerprint &&
        !changeAxes.includes('sql-ledger')) changeAxes.push('sql-ledger');
    if (['ready', 'pending', 'unprepared'].includes(state.A)) {
      if (!taggedHash.test(host.database.authSchemaSha256 ?? '')) {
        state.A = 'unknown';
      } else if (!targetIdentity.authSchemas.includes(host.database.authSchemaSha256)) {
        state.A = 'incompatible';
        changeAxes.push('auth-schema');
      }
    }
    if (state.H !== 'ready' && state.H !== 'unknown') changeAxes.push('infrastructure');
  }
  if (edge && taggedHash.test(edge.ingressDigest ?? '')) {
    if (edge.frontendState === 'absent' && edge.deployment === null) {
      state.F = 'absent';
      changeAxes.push('frontend');
      frontendAdmission = 'not-applicable';
    } else if (edge.frontendState === 'running' && edge.frontend && edge.deployment) {
      const deployed = frontendIdentity(edge.frontend);
      const desired = targetIdentity.frontend;
      if (!isDeepStrictEqual(deployed, desired)) changeAxes.push('frontend');
      const compatibleOAuth = hasSameFrontendOAuthContract(deployed.oauthConfigIdentity, desired.oauthConfigIdentity);
      if (!compatibleOAuth && !changeAxes.includes('oauth-contract')) {
        changeAxes.push('oauth-contract');
      }
      state.F = deployed.apiEpoch === desired.apiEpoch && compatibleOAuth
        ? 'compatible' : 'incompatible';
      try {
        assertFrontendReleaseAdmission(deployed, desired);
        frontendAdmission = state.B === 'compatible' && compatibleOAuth
          ? 'allowed' : 'denied';
      } catch {
        blockers.push('stale-or-conflicting-frontend-candidate');
        frontendAdmission = 'denied';
      }
    }
  }
  const times = [host, edge].filter(value => value != null)
    .map(value => assertFreshObservationTime(value.observedAt, { now }));
  const observedAt = times.length ? new Date(Math.min(...times)).toISOString() : now.toISOString();
  const database = host?.database;
  const recovery = host?.recovery;
  const restored = intent === 'restore' && recovery && state.D === 'compatible' && state.A === 'ready' &&
    rawHash.test(recovery.evidenceSha256 ?? '') &&
    isDeepStrictEqual(recovery.release, {
      image: targetIdentity.image,
      sourceSha: targetIdentity.backend.sourceSha,
      frontendArtifactSha256: candidateFrontend.artifactDigest,
    }) &&
    window !== null && isDeepStrictEqual(recovery.window, window);
  const bootstrapIntent = database?.bootstrapIntent;
  const matchesFreshInstallation = bootstrapIntent &&
    typeof database.clusterId === 'string' && /^[1-9][0-9]{0,19}$/u.test(database.clusterId) &&
    typeof database.databaseOid === 'string' && /^[1-9][0-9]{0,9}$/u.test(database.databaseOid) &&
    bootstrapIntent.clusterId === database.clusterId && bootstrapIntent.databaseOid === database.databaseOid &&
    bootstrapIntent.image === targetIdentity.image;
  if (intent === 'install' && state.B === 'absent' && state.A === 'ready' &&
      state.F === 'compatible' && !matchesFreshInstallation) {
    blockers.push('unverified-fresh-installation');
  }
  const emptyAuthResume = database?.emptyAuthSchema === true;
  const bootstrapResume = intent === 'install' && state.H === 'ready' && state.D === 'compatible' &&
    state.A === 'absent' && state.B === 'absent' && state.T === 'none' && matchesFreshInstallation &&
    (emptyAuthResume || database.emptyAuthSchema === undefined);
  const observation = {
    state, observedAt, frontendAdmission, changeAxes: [...new Set(changeAxes)],
    ...(restored ? { recoveryOperationId: recovery.operationId } : {}),
    ...(bootstrapResume ? { bootstrapResume: {
      ...(emptyAuthResume ? { checkpoint: 'empty-auth-schema' } : {}),
      clusterId: database.clusterId, databaseOid: database.databaseOid, image: targetIdentity.image,
      migrationFingerprint: targetIdentity.backend.migrationFingerprint,
    } } : {}),
    binding: {
      environment: 'codexia-production', hostPinSha256,
      hostId: host?.hostId ?? null, databaseSha256: hash(host?.database),
      authSha256: hash(host?.database ? { state: host.database.authState, schema: host.database.authSchemaSha256 ?? null,
        owner: host.database.ownerBindingSha256 ?? null, settings: host.database.settingsSha256 ?? null } : null),
      backendSha256: hash(host ? { observed: host.backend, publication: hash(installedCertificate) } : null), frontendSha256: hash(edge ? {
        state: edge.frontendState, deployment: edge.deployment, identity: publicFrontendEvidence(edge.frontend) } : null),
      ingressSha256: hash(edge ? { origin: edge.origin, ingressDigest: edge.ingressDigest } : null),
      transactionSha256: host ? digestEvidence(host.transaction) : null,
      infrastructureSha256: host ? digestEvidence({ state: host.H, topology: host.topology }) : null,
      // Only an authenticated preservation receipt can be supplied by the
      // owning recovery adapter. A request hash is not a receipt.
      backupSha256: restored ? recovery.evidenceSha256 : hash(preservationReceipt),
    },
  };
  if (host && host.database?.state === 'initialized' && host.backend?.state === 'running' &&
      host.backend.writer.identity.migrationFingerprint !== migrationSetFingerprint(host.database.ledger)) {
    blockers.push('writer-ledger-identity-mismatch');
  }
  const result = createDeploymentPlan({ observation, target, intent, window, now, evidenceBlockers: blockers });
  return { ...result, evidence: {
    host, edge: edge ? { observedAt: edge.observedAt, origin: edge.origin, deployment: edge.deployment,
      ingressDigest: edge.ingressDigest, frontendState: edge.frontendState,
      routesReady: edge.routesReady, publicProtocolEnabled: edge.publicProtocolEnabled,
      frontend: publicFrontendEvidence(edge.frontend), backend: edge.backend } : null,
    sourceBackendCertificateSha256: hash(installedCertificate),
    candidate: { backendImage: targetIdentity.image, backendIdentity: targetIdentity.backend,
      backendVerifiedMainSha: candidateBackend.verifiedMainSha, frontend: publicFrontendEvidence(targetIdentity.frontend),
      frontendRunId: candidateFrontend.runId, frontendVerifyRunId: candidateFrontend.verifyRunId,
      frontendArtifactId: candidateFrontend.artifactId, authSchemas: targetIdentity.authSchemas },
  }};
}
