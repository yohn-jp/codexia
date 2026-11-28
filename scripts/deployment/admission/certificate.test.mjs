import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildPushDeploymentCertificate } from './certificate.mjs';
import { validatePushDeploymentCertificate } from './validate.mjs';

const context = { repository: 'yohn-jp/codexia', owner: 'yohn-jp', repo: 'codexia', repositoryId: 1450072993, ownerId: 405 };

const sha = char => char.repeat(40);
const digest = char => `sha256:${char.repeat(64)}`;
const identity = (sourceSha = sha('a')) => ({ format: 'codexia-backend-identity/v1', version: '0.1.3', sourceSha,
  profile: 'full', platform: 'linux/amd64', migrationFingerprint: digest('a'), persistenceFormat: 1, apiEpoch: 1 });
const verifyRun = () => ({ path: '.github/workflows/verify.yml', event: 'push', head_branch: 'main', status: 'completed',
  conclusion: 'success', repository: { full_name: context.repository, id: context.repositoryId, owner: { id: context.ownerId } }, head_repository: { full_name: context.repository, id: context.repositoryId, owner: { id: context.ownerId } },
  head_sha: sha('a'), id: 200, run_attempt: 2 });
const receipt = () => ({ format: 'codexia-backend-build/v1', repository: context.repository, repositoryId: context.repositoryId, ownerId: context.ownerId, event: 'workflow_run', sourceSha: sha('a'), version: '0.1.3',
  workflowRunId: 201, workflowRunNumber: 88, sourceTree: sha('c'), artifacts: {
    full: { id: 202, digest: digest('d'), producerAttempt: 1, archiveSha256: 'e'.repeat(64) },
  } });
const input = (extra = {}) => ({ context, verifiedMainSha: sha('a'), verifiedMainTree: sha('c'), verifyRun: verifyRun(),
  producerReceipt: receipt(), profile: 'full', image: `ghcr.io/yohn-jp/codexia-backend@${digest('f')}`,
  identity: identity(), ...extra });

test('builds a handoff certificate bound to the successful exact-main Verify run and artifact receipt', () => {
  const certificate = buildPushDeploymentCertificate(input());
  const validated = validatePushDeploymentCertificate(certificate, sha('a'), context);
  assert.equal(validated.verifyRun.id, 200);
  assert.equal(validated.producer.runId, 201);
  assert.equal(validated.producer.artifactId, 202);
  assert.equal(validated.image, `ghcr.io/yohn-jp/codexia-backend@${digest('f')}`);
});

test('[TEST-OPS-002-001] rejects unsuccessful, foreign, non-main, stale, or wrong-workflow Verify evidence', () => {
  for (const override of [
    { conclusion: 'failure' }, { event: 'pull_request' }, { head_branch: 'feature' },
    { repository: { full_name: 'fork/codexia' } }, { head_repository: { full_name: 'fork/codexia' } },
    { path: '.github/workflows/other.yml' }, { head_sha: sha('9') }, { run_attempt: 0 },
  ]) {
    assert.throws(() => buildPushDeploymentCertificate(input({ verifyRun: { ...verifyRun(), ...override } })));
  }
});

test('rejects a producer receipt with an unbound main tree, digest, or source image identity', () => {
  const base = receipt();
  assert.throws(() => buildPushDeploymentCertificate(input({ producerReceipt: { ...base, sourceTree: sha('9') } })));
  assert.throws(() => buildPushDeploymentCertificate(input({ producerReceipt: { ...base, artifacts: {
    full: { ...base.artifacts.full, digest: 'mutable-tag' },
  } } })));
  assert.throws(() => buildPushDeploymentCertificate(input({ identity: identity(sha('9')) })));
});

test('binds a promoted PR artifact to exact main tree and its PR producer attempt', () => {
  const promotedIdentity = identity(sha('b'));
  const promotionReceipt = { format: 'codexia-backend-promotion/v1', repository: context.repository, repositoryId: context.repositoryId, ownerId: context.ownerId, event: 'pull_request', sourceSha: sha('b'),
    version: '0.1.3', workflowRunId: 301, workflowRunNumber: 99, workflowAttempt: 2, workflowId: 401,
    prNumber: 55, mainSha: sha('a'), sourceTree: sha('c'), mergeBaseSha: sha('8'),
    artifacts: { full: { id: 302, digest: digest('d'), producerAttempt: 1, archiveSha256: 'e'.repeat(64),
      identity: promotedIdentity } } };
  const certificate = buildPushDeploymentCertificate(input({ producerReceipt: promotionReceipt, identity: promotedIdentity }));
  assert.equal(validatePushDeploymentCertificate(certificate, sha('a'), context).producer.event, 'pull_request');
  assert.throws(() => buildPushDeploymentCertificate(input({ producerReceipt: { ...promotionReceipt, sourceTree: sha('9') },
    identity: promotedIdentity })));
});

test('CLI-10 accepts a Fork certificate only under its immutable repository identity', () => {
  const context = { repository: 'Fork-Owner/codexia', owner: 'Fork-Owner', repo: 'codexia', repositoryId: 405, ownerId: 506 };
  const repository = { full_name: context.repository, id: context.repositoryId, owner: { id: context.ownerId } };
  const certificate = buildPushDeploymentCertificate(input({
    context, verifyRun: { ...verifyRun(), repository, head_repository: repository },
    producerReceipt: { ...receipt(), repository: context.repository, repositoryId: context.repositoryId, ownerId: context.ownerId, },
    image: `ghcr.io/fork-owner/codexia-backend@${digest('f')}`,
  }));
  assert.equal(validatePushDeploymentCertificate(certificate, sha('a'), context).verifyRun.repositoryId, 405);
  for (const mismatched of [{ ...context, repositoryId: 406 }, { ...context, ownerId: 507 }]) {
    assert.throws(() => validatePushDeploymentCertificate(certificate, sha('a'), mismatched));
  }
  assert.throws(() => buildPushDeploymentCertificate(input({
    context, verifyRun: { ...verifyRun(), repository, head_repository: repository },
    producerReceipt: { ...receipt(), repository: context.repository, repositoryId: context.repositoryId, ownerId: context.ownerId, },
  })));
});
