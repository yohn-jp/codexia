import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertPushDeploymentAdmission } from './push-deployment-admission.mjs';

const sha = char => char.repeat(40);
const digest = char => `sha256:${char.repeat(64)}`;
const identity = (sourceSha, extra = {}) => ({
  format: 'codexia-backend-identity/v1', version: '0.1.2', sourceSha,
  profile: 'full', platform: 'linux/amd64', migrationFingerprint: digest('a'),
  persistenceFormat: 1, apiEpoch: 1, ...extra,
});
const installed = () => ({ image: `ghcr.io/yohn-jp/codexia-backend@${digest('a')}`, identity: identity(sha('a')) });
const certificate = (extra = {}) => ({
  format: 'codexia-backend-deployment-certificate/v1',
  verifiedMainSha: sha('b'),
  verifiedMainTree: sha('c'),
  verifyRun: { event: 'push', branch: 'main', conclusion: 'success', repository: 'yohn-jp/codexia', headSha: sha('b'), id: 100, attempt: 1 },
  producer: { sourceSha: sha('d'), sourceTree: sha('c'), runId: 101, attempt: 1, artifactId: 102, artifactDigest: digest('e') },
  image: `ghcr.io/yohn-jp/codexia-backend@${digest('f')}`,
  identity: identity(sha('d')),
  ...extra,
});

test('admits a certified immutable image only when its tree and identity match exact successful main verification', () => {
  const admitted = assertPushDeploymentAdmission(certificate(), installed(), {
    expectedMainSha: sha('b'), deployedUiEpoch: 1,
  });
  assert.equal(admitted.image, `ghcr.io/yohn-jp/codexia-backend@${digest('f')}`);
  assert.equal(admitted.identity.sourceSha, sha('d'));
});

test('rejects a certificate for a different main revision or a non-successful/non-main verification', () => {
  assert.throws(() => assertPushDeploymentAdmission(certificate(), installed(), {
    expectedMainSha: sha('9'), deployedUiEpoch: 1,
  }), /main revision/);
  for (const verifyRun of [
    { conclusion: 'failure' }, { branch: 'feature' }, { event: 'pull_request' },
    { repository: 'attacker/codexia' }, { headSha: sha('9') },
  ]) {
    assert.throws(() => assertPushDeploymentAdmission(certificate({
      verifyRun: { ...certificate().verifyRun, ...verifyRun },
    }), installed(), { expectedMainSha: sha('b'), deployedUiEpoch: 1 }));
  }
});

test('rejects producer artifacts not bound to the verified main tree and identity source', () => {
  const base = certificate();
  assert.throws(() => assertPushDeploymentAdmission({
    ...base, producer: { ...base.producer, sourceTree: sha('8') },
  }, installed(), { expectedMainSha: sha('b'), deployedUiEpoch: 1 }), /tree/);
  assert.throws(() => assertPushDeploymentAdmission({
    ...base, identity: identity(sha('8')),
  }, installed(), { expectedMainSha: sha('b'), deployedUiEpoch: 1 }), /source/);
});

test('fails closed on API epoch, persistence format, migration, profile, or platform changes', () => {
  const changes = [
    { identity: identity(sha('d'), { apiEpoch: 2 }) },
    { identity: identity(sha('d'), { persistenceFormat: 2 }) },
    { identity: identity(sha('d'), { migrationFingerprint: digest('9') }) },
    { identity: identity(sha('d'), { profile: 'core' }) },
    { identity: identity(sha('d'), { platform: 'linux/arm64' }) },
  ];
  for (const change of changes) {
    assert.throws(() => assertPushDeploymentAdmission(certificate(change), installed(), {
      expectedMainSha: sha('b'), deployedUiEpoch: 1,
    }));
  }
  assert.throws(() => assertPushDeploymentAdmission(certificate(), installed(), {
    expectedMainSha: sha('b'), deployedUiEpoch: 2,
  }), /frontend/);
});

test('rejects malformed or mutable images and incomplete provenance', () => {
  for (const bad of [
    { image: 'ghcr.io/yohn-jp/codexia-backend:latest' },
    { image: `ghcr.io/other/codexia-backend@${digest('f')}` },
    { image: `ghcr.io/yohn-jp/codexia-backend@sha256:${'F'.repeat(64)}` },
    { producer: { ...certificate().producer, artifactId: 0 } },
  ]) {
    assert.throws(() => assertPushDeploymentAdmission(certificate(bad), installed(), {
      expectedMainSha: sha('b'), deployedUiEpoch: 1,
    }));
  }
  assert.throws(() => assertPushDeploymentAdmission(certificate({ image: installed().image }), installed(), {
    expectedMainSha: sha('b'), deployedUiEpoch: 1,
  }), /differ from the installed/);
});
