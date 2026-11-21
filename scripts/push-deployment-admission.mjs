import { validateBackendIdentity } from './backend-update-identity.mjs';

const sha = /^[a-f0-9]{40}$/u;
const digest = /^sha256:[a-f0-9]{64}$/u;
const image = /^ghcr\.io\/yohn-jp\/codexia-backend@sha256:[a-f0-9]{64}$/u;
const positive = value => Number.isSafeInteger(value) && value > 0;
const exactKeys = (value, expected) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).sort().join(',') === [...expected].sort().join(',');

/**
 * Admit a push-deployment candidate against the independently observed current
 * API identity. The certificate must come from an authenticated, protected
 * release workflow; this function validates its bindings but does not verify
 * GitHub's artifact provenance, OCI signatures, SSH authorization, or runtime
 * health. Success is compatibility admission, not permission to activate.
 */
export function assertPushDeploymentAdmission(certificate, installedValue, { expectedMainSha, deployedUiEpoch }) {
  if (!exactKeys(certificate, ['format', 'verifiedMainSha', 'verifiedMainTree', 'verifyRun', 'producer', 'image', 'identity']) ||
      certificate.format !== 'codexia-backend-deployment-certificate/v1') {
    throw new Error('Invalid push deployment certificate');
  }
  if (!sha.test(expectedMainSha ?? '') || certificate.verifiedMainSha !== expectedMainSha) {
    throw new Error('Certificate main revision differs from the expected main revision');
  }
  if (!sha.test(certificate.verifiedMainTree ?? '') || !image.test(certificate.image ?? '')) {
    throw new Error('Invalid certified source tree or immutable image');
  }

  const run = certificate.verifyRun;
  if (!exactKeys(run, ['event', 'branch', 'conclusion', 'repository', 'headSha', 'id', 'attempt']) ||
      run.event !== 'push' || run.branch !== 'main' || run.conclusion !== 'success' ||
      run.repository !== 'yohn-jp/codexia' || run.headSha !== expectedMainSha ||
      !positive(run.id) || !positive(run.attempt)) {
    throw new Error('Certificate is not bound to successful exact-main verification');
  }

  const producer = certificate.producer;
  if (!exactKeys(producer, ['sourceSha', 'sourceTree', 'runId', 'attempt', 'artifactId', 'artifactDigest']) ||
      !sha.test(producer.sourceSha ?? '') || producer.sourceTree !== certificate.verifiedMainTree ||
      !positive(producer.runId) || !positive(producer.attempt) || !positive(producer.artifactId) ||
      !digest.test(producer.artifactDigest ?? '')) {
    throw new Error('Producer artifact is not bound to the certified main source tree');
  }

  if (!exactKeys(installedValue, ['image', 'identity']) || !image.test(installedValue.image ?? '')) {
    throw new Error('Invalid observed installed image identity');
  }
  const installed = validateBackendIdentity(installedValue.identity);
  const candidate = validateBackendIdentity(certificate.identity);
  if (candidate.sourceSha !== producer.sourceSha) throw new Error('Certified image identity source differs from producer source');
  if (!positive(deployedUiEpoch) || installed.apiEpoch !== deployedUiEpoch || candidate.apiEpoch !== deployedUiEpoch) {
    throw new Error('Push deployment frontend/API epoch mismatch');
  }
  if (candidate.profile !== installed.profile || candidate.platform !== installed.platform) {
    throw new Error('Push deployment profile or platform changed');
  }
  if (candidate.persistenceFormat !== installed.persistenceFormat) {
    throw new Error('Manual persistent-format migration required');
  }
  if (candidate.migrationFingerprint !== installed.migrationFingerprint) {
    throw new Error('Manual database migration required');
  }
  if (candidate.sourceSha === installed.sourceSha || certificate.image === installedValue.image) {
    throw new Error('Push deployment candidate must differ from the installed release');
  }

  return Object.freeze({ image: certificate.image, identity: Object.freeze({ ...candidate }),
    verifiedMainSha: certificate.verifiedMainSha, verifyRunId: run.id, verifyAttempt: run.attempt,
    producerRunId: producer.runId, producerAttempt: producer.attempt, artifactId: producer.artifactId,
    artifactDigest: producer.artifactDigest });
}
