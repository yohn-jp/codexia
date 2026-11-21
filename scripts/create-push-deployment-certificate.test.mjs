import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { assertPushDeploymentAdmission } from './push-deployment-admission.mjs';
import { createPushDeploymentCertificate } from './create-push-deployment-certificate.mjs';

const sha = char => char.repeat(40);
const digest = char => `sha256:${char.repeat(64)}`;
const image = char => `ghcr.io/yohn-jp/codexia-backend@${digest(char)}`;
const identity = (sourceSha, extra = {}) => ({
  format: 'codexia-backend-identity/v1', version: '0.1.2', sourceSha,
  profile: 'full', platform: 'linux/amd64', migrationFingerprint: digest('a'),
  persistenceFormat: 1, apiEpoch: 1, ...extra,
});
const artifact = (id, artifactDigest, producerAttempt = 1) => ({ id, digest: digest(artifactDigest), producerAttempt });

function fixture({ promoted = false, producerSha = sha('b'), sourceTree = sha('c') } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'codexia-push-certificate-'));
  const promotionDir = path.join(root, 'promotion');
  mkdirSync(promotionDir);
  const manifestPath = path.join(root, 'build.json');
  const receipt = promoted ? {
    format: 'codexia-backend-promotion/v1', event: 'pull_request', mainSha: sha('b'),
    sourceSha: producerSha, sourceTree, workflowRunId: 200, workflowAttempt: 2, version: '0.1.2',
    artifacts: { core: artifact(1, 'd', 2), full: { ...artifact(2, 'e', 2), identity: identity(producerSha) } },
  } : {
    format: 'codexia-backend-build/v1', event: 'workflow_run', sourceSha: producerSha,
    sourceTree, workflowRunId: 200, workflowRunNumber: 451,
    artifacts: { core: artifact(1, 'd'), full: artifact(2, 'e') },
  };
  if (promoted) writeFileSync(path.join(promotionDir, 'codexia-backend-promotion.json'), JSON.stringify(receipt));
  else writeFileSync(manifestPath, JSON.stringify(receipt));
  return {
    root,
    env: {
      GITHUB_REPOSITORY: 'yohn-jp/codexia',
      GITHUB_EVENT_NAME: 'workflow_run',
      GITHUB_REF: 'refs/heads/main',
      CODEXIA_VERIFIED_MAIN_SHA: sha('b'),
      CODEXIA_VERIFY_EVENT: 'push',
      CODEXIA_VERIFY_BRANCH: 'main',
      CODEXIA_VERIFY_CONCLUSION: 'success',
      CODEXIA_VERIFY_REPOSITORY: 'yohn-jp/codexia',
      CODEXIA_VERIFY_HEAD_REPOSITORY: 'yohn-jp/codexia',
      CODEXIA_VERIFY_HEAD_SHA: sha('b'),
      CODEXIA_VERIFY_RUN_ID: '100',
      CODEXIA_VERIFY_RUN_ATTEMPT: '3',
      CODEXIA_CERTIFIED_FULL_IMAGE: image('f'),
      CODEXIA_PRODUCER_SHA: producerSha,
      CODEXIA_PRODUCER_VERSION: '0.1.2',
      CODEXIA_BACKEND_PRODUCER_EVENT: promoted ? 'pull_request' : 'workflow_run',
      CODEXIA_BACKEND_ARTIFACT_MANIFEST: manifestPath,
      CODEXIA_BACKEND_PROMOTION_DIR: promotionDir,
    },
    async inspectImage(reference, sourceSha, version, profile) {
      assert.equal(reference, image('f'));
      assert.equal(sourceSha, producerSha);
      assert.equal(version, '0.1.2');
      assert.equal(profile, 'full');
      return identity(producerSha);
    },
    getRevision: () => sha('b'),
    getTree: () => sourceTree,
  };
}

test('creates an admission certificate bound to exact main verification, artifact and published Full image', async () => {
  const target = fixture();
  try {
    const certificate = await createPushDeploymentCertificate(target);
    const admitted = assertPushDeploymentAdmission(certificate, {
      image: image('a'), identity: identity(sha('9')),
    }, { expectedMainSha: sha('b'), deployedUiEpoch: 1 });
    assert.equal(admitted.image, image('f'));
    assert.equal(admitted.verifyRunId, 100);
    assert.equal(admitted.artifactId, 2);
    assert.equal(admitted.producerRunId, 200);
  } finally {
    rmSync(target.root, { recursive: true, force: true });
  }
});

test('allows a promoted producer SHA only when its verified tree matches the exact main tree', async () => {
  const target = fixture({ promoted: true, producerSha: sha('d') });
  try {
    const certificate = await createPushDeploymentCertificate(target);
    assert.equal(certificate.identity.sourceSha, sha('d'));
    assert.equal(certificate.producer.sourceSha, sha('d'));
    assert.equal(certificate.producer.sourceTree, sha('c'));
    assert.equal(assertPushDeploymentAdmission(certificate, {
      image: image('a'), identity: identity(sha('9')),
    }, { expectedMainSha: sha('b'), deployedUiEpoch: 1 }).producerAttempt, 2);
  } finally {
    rmSync(target.root, { recursive: true, force: true });
  }
});

test('rejects a producer receipt whose source tree is not the verified main tree', async () => {
  const target = fixture({ sourceTree: sha('c') });
  target.getTree = () => sha('8');
  try {
    await assert.rejects(createPushDeploymentCertificate(target), /artifact receipt differs from verified main source/u);
  } finally {
    rmSync(target.root, { recursive: true, force: true });
  }
});

test('rejects a certificate checkout that is not the verified main revision', async () => {
  const target = fixture();
  target.getRevision = () => sha('9');
  try {
    await assert.rejects(createPushDeploymentCertificate(target), /checkout differs from the verified main revision/u);
  } finally {
    rmSync(target.root, { recursive: true, force: true });
  }
});

test('rejects a verification event that is not a successful exact-main push', async () => {
  const target = fixture();
  target.env.CODEXIA_VERIFY_CONCLUSION = 'failure';
  try {
    await assert.rejects(createPushDeploymentCertificate(target), /successful exact-main verification/u);
  } finally {
    rmSync(target.root, { recursive: true, force: true });
  }
});
