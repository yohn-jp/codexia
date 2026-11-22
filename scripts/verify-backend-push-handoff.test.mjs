import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as handoff from './verify-backend-push-handoff.mjs';
import {
  assertTrustedBackendPublicationRun,
  createHandoffDeploymentOutputs,
  selectPushDeploymentCertificateArtifact,
  validatePushDeploymentCertificatePair,
} from './verify-backend-push-handoff.mjs';

const sha = char => char.repeat(40);
const digest = char => `sha256:${char.repeat(64)}`;
const mainSha = sha('a'), mainTree = sha('b'), sourceSha = sha('c');
const buildRun = () => ({ id: 100, run_attempt: 2, path: '.github/workflows/backend-release.yml', event: 'workflow_run',
  run_number: 773, head_branch: 'main', head_sha: mainSha, status: 'completed', conclusion: 'success',
  repository: { full_name: 'yohn-jp/codexia' }, head_repository: { full_name: 'yohn-jp/codexia' } });
const receipt = () => ({ format: 'codexia-backend-build/v1', event: 'workflow_run', sourceSha, version: '0.1.3',
  workflowRunId: 101, workflowRunNumber: 4, sourceTree: mainTree, artifacts: {
    core: { id: 201, digest: digest('d'), producerAttempt: 1, archiveSha256: 'e'.repeat(64) },
    full: { id: 202, digest: digest('e'), producerAttempt: 1, archiveSha256: 'f'.repeat(64) },
  } });
const cert = profile => ({ format: 'codexia-backend-deployment-certificate/v1', verifiedMainSha: mainSha, verifiedMainTree: mainTree,
  verifyRun: { event: 'push', branch: 'main', conclusion: 'success', repository: 'yohn-jp/codexia', headSha: mainSha, id: 90, attempt: 1 },
  producer: { event: 'workflow_run', sourceSha, sourceTree: mainTree, runId: 101, attempt: 1, artifactId: profile === 'core' ? 201 : 202,
    artifactDigest: digest(profile === 'core' ? 'd' : 'e'), receipt: receipt() },
  image: `ghcr.io/yohn-jp/codexia-backend@${digest(profile === 'core' ? 'f' : '9')}`,
  identity: { format: 'codexia-backend-identity/v1', version: '0.1.3', sourceSha, profile, platform: 'linux/amd64',
    migrationFingerprint: digest('a'), persistenceFormat: 1, apiEpoch: 1 } });
const artifact = (run = buildRun()) => ({ id: 303, name: `codexia-backend-deployment-certificate-${mainSha}-run-${run.id}-attempt-${run.run_attempt}`,
  digest: digest('1'), size_in_bytes: 500, expired: false,
  workflow_run: { id: run.id, head_sha: run.head_sha } });

test('accepts only the completed successful main backend publisher run with exact repository and source', () => {
  assert.equal(assertTrustedBackendPublicationRun(buildRun(), { id: 100, attempt: 2, runNumber: 773, headSha: mainSha }).id, 100);
  for (const patch of [
    { path: '.github/workflows/other.yml' }, { event: 'pull_request' }, { head_branch: 'feature' },
    { status: 'in_progress' }, { conclusion: 'failure' }, { repository: { full_name: 'fork/codexia' } },
    { head_repository: { full_name: 'fork/codexia' } }, { head_sha: sha('9') }, { run_attempt: 1 },
  ]) assert.throws(() => assertTrustedBackendPublicationRun({ ...buildRun(), ...patch }, { id: 100, attempt: 2, runNumber: 773, headSha: mainSha }));
});

test('rejects a verified publisher run whose run number differs from its workflow_run event', () => {
  const publisher = { ...buildRun(), id: 44907163228, run_number: 41 };
  assert.throws(() => assertTrustedBackendPublicationRun(publisher, {
    id: 44907163228, attempt: 2, runNumber: 773, headSha: mainSha,
  }), /Backend publication run number mismatch/u);
});

test('passes the verified backend publisher run identity instead of the handoff run identity', () => {
  const publisher = { ...buildRun(), id: 44907163228, run_number: 773 };
  const trusted = assertTrustedBackendPublicationRun(publisher, {
    id: 44907163228, attempt: 2, runNumber: 773, headSha: mainSha,
  });
  assert.equal(typeof handoff.backendReleaseValidationEnvironment, 'function');
  assert.deepEqual(handoff.backendReleaseValidationEnvironment({
    GITHUB_RUN_ID: '44907575858', GITHUB_RUN_NUMBER: '41',
  }, trusted), {
    GITHUB_RUN_ID: '44907163228', GITHUB_RUN_NUMBER: '773',
  });
});

test('selects the single unexpired digest-bound certificate artifact for the exact publisher run attempt', () => {
  assert.equal(selectPushDeploymentCertificateArtifact([artifact()], buildRun()).id, 303);
  for (const bad of [
    { ...artifact(), expired: true }, { ...artifact(), digest: 'mutable' }, { ...artifact(), workflow_run: { id: 999, head_sha: mainSha } },
    { ...artifact(), name: 'codexia-backend-deployment-certificate-stale' },
  ]) assert.throws(() => selectPushDeploymentCertificateArtifact([bad], buildRun()));
  assert.throws(() => selectPushDeploymentCertificateArtifact([artifact(), artifact()], buildRun()), /one/);
});

test('binds promotion artifact name to its source SHA and workflow association to publication head SHA', () => {
  const publicationRun = { ...buildRun(), head_sha: mainSha };
  const promotedSourceSha = sourceSha;
  const promotedArtifact = {
    ...artifact(publicationRun),
    name: `codexia-backend-deployment-certificate-${promotedSourceSha}-run-${publicationRun.id}-attempt-${publicationRun.run_attempt}`,
  };
  assert.equal(selectPushDeploymentCertificateArtifact([promotedArtifact], publicationRun, { sourceSha: promotedSourceSha }).id, 303);
  assert.throws(() => selectPushDeploymentCertificateArtifact([promotedArtifact], publicationRun), /one/u);
  assert.throws(() => selectPushDeploymentCertificateArtifact([
    { ...promotedArtifact, workflow_run: { ...promotedArtifact.workflow_run, head_sha: promotedSourceSha } },
  ], publicationRun, { sourceSha: promotedSourceSha }), /workflow head/u);
});

test('requires both independently certified profiles from the same verified producer and compatible release', () => {
  const [core, full] = validatePushDeploymentCertificatePair([cert('core'), cert('full')], mainSha);
  assert.equal(core.identity.profile, 'core');
  assert.equal(full.identity.profile, 'full');
  assert.throws(() => validatePushDeploymentCertificatePair([cert('core')], mainSha), /Core and Full/);
  assert.throws(() => validatePushDeploymentCertificatePair([cert('core'), cert('core')], mainSha), /one certificate/);
  assert.throws(() => validatePushDeploymentCertificatePair([cert('core'), { ...cert('full'), verifiedMainSha: sha('9') }], mainSha));
  assert.throws(() => validatePushDeploymentCertificatePair([cert('core'), { ...cert('full'), producer: { ...cert('full').producer, attempt: 2 } }], mainSha));
});

test('exposes only a validated Full digest and certificate as bounded job outputs', () => {
  const [, full] = validatePushDeploymentCertificatePair([cert('core'), cert('full')], mainSha);
  const outputs = createHandoffDeploymentOutputs({
    fullImage: full.image,
    producerSha: full.producer.sourceSha,
    fullCertificate: full,
  });
  assert.equal(outputs.fullImage, full.image);
  assert.equal(outputs.producerSha, sourceSha);
  assert.equal(outputs.fullApiEpoch, '1');
  assert.deepEqual(JSON.parse(Buffer.from(outputs.fullCertificate, 'base64').toString('utf8')), full);
  assert.throws(() => createHandoffDeploymentOutputs({
    fullImage: `ghcr.io/yohn-jp/codexia-backend@${digest('1')}`,
    producerSha: full.producer.sourceSha,
    fullCertificate: full,
  }));
});
