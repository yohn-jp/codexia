import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { assertFrontendIdentity } from '../../release/frontend/verify-compatibility.mjs';
import { hasStandaloneOAuthIdentity, validateBackendIdentity } from '../../release/backend/update-identity.mjs';

const sha256 = /^[a-f0-9]{64}$/u;
const immutableImage = /^ghcr\.io\/yohn-jp\/codexia-backend@sha256:[a-f0-9]{64}$/u;
const checks = ['ownerLogin', 'passkey', 'oauth', 'manuscript', 'history', 'permissionDenial', 'accessBoundary'];
const comparableIdentity = ['format', 'sourceSha', 'version', 'profile', 'apiEpoch'];

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

function sorted(value) {
  if (Array.isArray(value)) return value.map(sorted);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted(value[key])]));
  }
  return value;
}

export function digestEvidence(value) {
  return createHash('sha256').update(JSON.stringify(sorted(value))).digest('hex');
}

function timestamp(value) {
  const milliseconds = Date.parse(value);
  requireCondition(typeof value === 'string' && Number.isFinite(milliseconds) &&
    new Date(milliseconds).toISOString() === value, 'Invalid evidence timestamp');
  return milliseconds;
}

function verifyTime(value, since, now) {
  const observed = timestamp(value);
  requireCondition(observed >= timestamp(since) && observed <= now.getTime(), 'Evidence is stale or in the future');
}

export function assertPairedObservation({ edge, host, pinned, environment, now = new Date() }) {
  const since = new Date(now.getTime() - 5 * 60_000).toISOString();
  verifyTime(edge.observedAt, since, now);
  verifyTime(host.observedAt, since, now);
  const expected = validateBackendIdentity(pinned.identity);
  validateBackendIdentity(host.writer?.identity);
  assertFrontendIdentity(pinned.frontend);
  assertFrontendIdentity(edge.frontend);

  requireCondition(edge.origin === environment.origin && edge.ingressDigest === environment.ingressDigest,
    'Public origin or Access/Tunnel topology changed');
  requireCondition(edge.deployment.versionId === pinned.workerVersion &&
    comparableIdentity.every(key => edge.frontend[key] === pinned.frontend[key]),
  'Live Worker deployment or frontend identity differs from the pinned release');
  requireCondition(expected.profile === 'full' && pinned.frontend.profile === 'full' &&
    pinned.frontend.apiEpoch === expected.apiEpoch && edge.backend?.name === 'codexia' &&
    ['version', 'profile', 'apiEpoch'].every(key => edge.backend[key] === expected[key]),
  'Public backend version does not match the pinned Full release');
  requireCondition((pinned.protocol === 'legacy' ? !hasStandaloneOAuthIdentity(edge.backend) : hasStandaloneOAuthIdentity(edge.backend)),
    'Public backend OAuth contract differs from the reviewed release');
  requireCondition(immutableImage.test(pinned.image) && pinned.image === host.writer.image &&
    isDeepStrictEqual(expected, host.writer.identity) && host.writer.authMode === 'better-auth',
  'Running writer does not match the pinned image and Better Auth configuration');

  requireCondition(sha256.test(environment.hostId) && host.hostId === environment.hostId &&
    /^\d+$/u.test(environment.clusterId) && host.database.clusterId === environment.clusterId &&
    host.database.migrationLedgerSha256 === expected.migrationFingerprint,
  'Host, database cluster, or migration ledger differs from the reviewed release');
  requireCondition(/^sha256:[a-f0-9]{64}$/u.test(environment.ownerBindingSha256) &&
    host.writer.ownerBindingSha256 === environment.ownerBindingSha256,
  'Existing Better Auth owner identity could not be verified');
  requireCondition(host.tunnel.unitState === 'active' && host.tunnel.containerRunning === true,
    'Canonical Tunnel is not running');
}

export function assertFunctionalAcceptance(evidence, expected, { since, now = new Date() }) {
  requireCondition(evidence?.format === 'codexia-cutover-functional-acceptance/v1' &&
    Object.entries(expected).every(([key, value]) => evidence[key] === value),
  'Functional acceptance does not identify this plan, origin and exact release pair');
  verifyTime(evidence.verifiedAt, since, now);
  requireCondition(evidence.checks && Object.keys(evidence.checks).length === checks.length &&
    checks.every(key => sha256.test(evidence.checks[key] ?? '')),
  'Functional acceptance is missing required evidence digests');
}
