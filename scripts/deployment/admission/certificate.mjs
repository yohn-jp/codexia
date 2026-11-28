import assert from 'node:assert/strict';
import { actionsRepository, matchesRunRepository, assertBackendImageDigest } from '../../github/repository.mjs';
import { validateBackendIdentity } from '../../release/backend/update-identity.mjs';
import { validatePushDeploymentCertificate } from './validate.mjs';

const sha = /^[a-f0-9]{40}$/u;
const digest = /^sha256:[a-f0-9]{64}$/u;
const positive = value => Number.isSafeInteger(value) && value > 0;

/** Create the credential-free artifact that a later protected deploy workflow consumes. */
export function buildPushDeploymentCertificate({ verifiedMainSha, verifiedMainTree, verifyRun, producerReceipt, profile, image: imageRef, identity, context = actionsRepository() }) {
  assert.match(verifiedMainSha ?? '', sha, 'Verified main revision is invalid');
  assert.match(verifiedMainTree ?? '', sha, 'Verified main tree is invalid');
  assert.ok(verifyRun && typeof verifyRun === 'object', 'Verify run evidence is missing');
  assert.equal(verifyRun.path, '.github/workflows/verify.yml', 'Unexpected Verify workflow');
  assert.equal(verifyRun.event, 'push', 'PR verification cannot certify a deployment image');
  assert.equal(verifyRun.head_branch, 'main', 'Verify source must be main');
  assert.equal(verifyRun.status, 'completed', 'Verify run is not complete');
  assert.equal(verifyRun.conclusion, 'success', 'Unsuccessful Verify run cannot certify deployment');
  assert.ok(matchesRunRepository(verifyRun, context), 'Verify repository mismatch');
  assert.equal(verifyRun.head_sha, verifiedMainSha, 'Verified main SHA differs from Verify run');
  assert.ok(positive(verifyRun.id) && positive(verifyRun.run_attempt), 'Verify run identity is invalid');
  assertBackendImageDigest(imageRef, context.repository);

  const candidate = validateBackendIdentity(identity);
  assert.ok(['core', 'full'].includes(profile), 'Deployment profile is invalid');
  assert.equal(candidate.profile, profile, 'OCI image profile differs from selected profile');
  const receipt = producerReceipt;
  const promotion = receipt?.format === 'codexia-backend-promotion/v1';
  assert.equal(receipt?.format, promotion ? 'codexia-backend-promotion/v1' : 'codexia-backend-build/v1', 'Producer receipt format is invalid');
  assert.equal(receipt.event, promotion ? 'pull_request' : receipt.event, 'Producer receipt event is invalid');
  if (!promotion) assert.ok(['push', 'workflow_run'].includes(receipt.event), 'Main producer event is invalid');
  assert.match(receipt.sourceSha ?? '', sha, 'Producer source SHA is invalid');
  assert.equal(receipt.sourceTree, verifiedMainTree, 'Producer artifact tree differs from verified main tree');
  assert.equal(candidate.sourceSha, receipt.sourceSha, 'OCI identity source differs from producer receipt');
  assert.equal(candidate.version, receipt.version, 'OCI identity version differs from producer receipt');
  assert.ok(positive(receipt.workflowRunId), 'Producer workflow run ID is invalid');
  const producerArtifact = receipt.artifacts?.[profile];
  assert.ok(producerArtifact && typeof producerArtifact === 'object', 'Producer profile artifact is missing');
  assert.ok(positive(producerArtifact.id), 'Producer artifact ID is invalid');
  assert.ok(positive(producerArtifact.producerAttempt), 'Producer artifact attempt is invalid');
  assert.match(producerArtifact.digest ?? '', digest, 'Producer artifact digest is invalid');
  assert.match(producerArtifact.archiveSha256 ?? '', /^[a-f0-9]{64}$/u, 'Producer archive digest is invalid');
  if (promotion) {
    assert.equal(receipt.mainSha, verifiedMainSha, 'Promotion receipt main authority mismatch');
    assert.ok(positive(receipt.workflowId) && positive(receipt.prNumber) && positive(receipt.workflowAttempt), 'PR producer provenance is incomplete');
    assert.deepEqual(validateBackendIdentity(producerArtifact.identity), candidate, 'Promoted artifact identity differs from inspected OCI image');
  }

  const certificate = {
    format: 'codexia-backend-deployment-certificate/v1',
    verifiedMainSha,
    verifiedMainTree,
    verifyRun: {
      event: verifyRun.event,
      branch: verifyRun.head_branch,
      conclusion: verifyRun.conclusion,
      repository: context.repository,
      repositoryId: context.repositoryId,
      ownerId: context.ownerId,
      headSha: verifyRun.head_sha,
      id: verifyRun.id,
      attempt: verifyRun.run_attempt,
    },
    producer: {
      event: promotion ? 'pull_request' : receipt.event,
      sourceSha: receipt.sourceSha,
      sourceTree: receipt.sourceTree,
      runId: receipt.workflowRunId,
      attempt: producerArtifact.producerAttempt,
      artifactId: producerArtifact.id,
      artifactDigest: producerArtifact.digest,
      receipt,
    },
    image: imageRef,
    identity: candidate,
  };
  return validatePushDeploymentCertificate(certificate, verifiedMainSha, context);
}
