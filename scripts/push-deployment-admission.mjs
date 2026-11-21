import { validateBackendIdentity } from './backend-update-identity.mjs';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const sha = /^[a-f0-9]{40}$/u;
const digest = /^sha256:[a-f0-9]{64}$/u;
const image = /^ghcr\.io\/yohn-jp\/codexia-backend@sha256:[a-f0-9]{64}$/u;
const positive = value => Number.isSafeInteger(value) && value > 0;
const exactKeys = (value, expected) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).sort().join(',') === [...expected].sort().join(',');
const immutableImage = value => typeof value === 'string' && image.test(value);

/** Validate a deploy certificate and its complete authenticated release receipt. */
export function validatePushDeploymentCertificate(certificate, expectedMainSha) {
  if (!exactKeys(certificate, ['format', 'verifiedMainSha', 'verifiedMainTree', 'verifyRun', 'producer', 'image', 'identity']) ||
      certificate.format !== 'codexia-backend-deployment-certificate/v1') {
    throw new Error('Invalid push deployment certificate');
  }
  if (!sha.test(expectedMainSha ?? '') || certificate.verifiedMainSha !== expectedMainSha) {
    throw new Error('Certificate main revision differs from the expected main revision');
  }
  if (!sha.test(certificate.verifiedMainTree ?? '') || !immutableImage(certificate.image)) {
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
  if (!exactKeys(producer, ['event', 'sourceSha', 'sourceTree', 'runId', 'attempt', 'artifactId', 'artifactDigest', 'receipt']) ||
      !['push', 'workflow_run', 'pull_request'].includes(producer.event) ||
      !sha.test(producer.sourceSha ?? '') || producer.sourceTree !== certificate.verifiedMainTree ||
      !positive(producer.runId) || !positive(producer.attempt) || !positive(producer.artifactId) ||
      !digest.test(producer.artifactDigest ?? '')) {
    throw new Error('Producer artifact is not bound to the certified main source tree');
  }
  const receipt = producer.receipt;
  const promotion = receipt?.format === 'codexia-backend-promotion/v1';
  const expectedFormat = promotion ? 'codexia-backend-promotion/v1' : 'codexia-backend-build/v1';
  if (receipt?.format !== expectedFormat || receipt.event !== producer.event || receipt.sourceSha !== producer.sourceSha ||
      receipt.sourceTree !== producer.sourceTree || receipt.workflowRunId !== producer.runId ||
      receipt.version !== certificate.identity?.version) {
    throw new Error('Producer receipt does not match the certificate identity');
  }
  if (promotion && (receipt.mainSha !== expectedMainSha || !positive(receipt.workflowId) || !positive(receipt.prNumber))) {
    throw new Error('Producer promotion receipt is not bound to certified main');
  }
  const artifact = receipt.artifacts?.[certificate.identity?.profile];
  if (!artifact || artifact.id !== producer.artifactId || artifact.digest !== producer.artifactDigest ||
      artifact.producerAttempt !== producer.attempt || !/^[a-f0-9]{64}$/u.test(artifact.archiveSha256 ?? '')) {
    throw new Error('Producer artifact does not match the complete release receipt');
  }
  const candidate = validateBackendIdentity(certificate.identity);
  if (candidate.sourceSha !== producer.sourceSha) throw new Error('Certified image identity source differs from producer source');
  if (promotion) {
    const receiptIdentity = validateBackendIdentity(artifact.identity);
    if (JSON.stringify(receiptIdentity) !== JSON.stringify(candidate)) {
      throw new Error('Producer promotion receipt identity differs from certified image');
    }
  }
  return Object.freeze({
    format: certificate.format, verifiedMainSha: certificate.verifiedMainSha,
    verifiedMainTree: certificate.verifiedMainTree, verifyRun: Object.freeze({ ...run }),
    producer: Object.freeze({ ...producer }), image: certificate.image,
    identity: Object.freeze({ ...candidate }),
  });
}

/**
 * Admit a push-deployment candidate against the independently observed current
 * API identity. The certificate must come from an authenticated, protected
 * release workflow; this function validates its bindings but does not verify
 * GitHub's artifact provenance, OCI signatures, SSH authorization, or runtime
 * health. Success is compatibility admission, not permission to activate.
 */
export function assertPushDeploymentAdmission(certificate, installedValue, { expectedMainSha, deployedUiEpoch }) {
  const admitted = validatePushDeploymentCertificate(certificate, expectedMainSha);
  const { producer, identity: candidate, image: candidateImage, verifiedMainSha, verifyRun } = admitted;
  if (!exactKeys(installedValue, ['image', 'identity']) || !image.test(installedValue.image ?? '')) {
    throw new Error('Invalid observed installed image identity');
  }
  const installed = validateBackendIdentity(installedValue.identity);
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
  if (candidate.sourceSha === installed.sourceSha || candidateImage === installedValue.image) {
    throw new Error('Push deployment candidate must differ from the installed release');
  }

  return Object.freeze({ image: candidateImage, identity: Object.freeze({ ...candidate }),
    verifiedMainSha, verifyRunId: verifyRun.id, verifyAttempt: verifyRun.attempt,
    producerRunId: producer.runId, producerAttempt: producer.attempt, artifactId: producer.artifactId,
    artifactDigest: producer.artifactDigest });
}

function runCli() {
  const [mode, certificatePath, installedBase64, expectedMainSha, uiEpochValue] = process.argv.slice(2);
  if (mode !== '--admit' || !certificatePath || !installedBase64 || !expectedMainSha || !uiEpochValue ||
      !path.isAbsolute(certificatePath) || !/^[1-9][0-9]*$/u.test(uiEpochValue)) {
    throw new Error('Usage: push-deployment-admission.mjs --admit /absolute/certificate.json <installed-json-base64> <main-sha> <ui-epoch>');
  }
  const certificate = JSON.parse(readFileSync(certificatePath, 'utf8'));
  const installed = JSON.parse(Buffer.from(installedBase64, 'base64').toString('utf8'));
  const admitted = assertPushDeploymentAdmission(certificate, installed, {
    expectedMainSha,
    deployedUiEpoch: Number(uiEpochValue),
  });
  console.log(`Admitted certified image ${admitted.image} for verified main ${admitted.verifiedMainSha}.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    runCli();
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Push deployment admission failed');
    process.exitCode = 1;
  }
}
