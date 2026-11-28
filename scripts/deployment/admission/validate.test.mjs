import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { assertPushDeploymentAdmission as admitWithContext, validatePushDeploymentCertificate as validateWithContext } from './validate.mjs';

const context = { repository: 'yohn-jp/codexia', owner: 'yohn-jp', repo: 'codexia', repositoryId: 1450072993, ownerId: 405 };

const assertPushDeploymentAdmission = (certificate, installed, options) =>
  admitWithContext(certificate, installed, { ...options, context });
const validatePushDeploymentCertificate = (certificate, sha) => validateWithContext(certificate, sha, context);

const sha = char => char.repeat(40);
const digest = char => `sha256:${char.repeat(64)}`;
const identity = (sourceSha, extra = {}) => ({
  format: 'codexia-backend-identity/v1', version: '0.1.2', sourceSha,
  profile: 'full', platform: 'linux/amd64', migrationFingerprint: digest('a'),
  persistenceFormat: 1, apiEpoch: 1, ...extra,
});
const installed = () => ({ image: `ghcr.io/yohn-jp/codexia-backend@${digest('a')}`, identity: identity(sha('a'), { version: '0.1.1' }) });
const certificate = (extra = {}) => ({
  format: 'codexia-backend-deployment-certificate/v1',
  verifiedMainSha: sha('b'),
  verifiedMainTree: sha('c'),
  verifyRun: { event: 'push', branch: 'main', conclusion: 'success', repository: context.repository, repositoryId: context.repositoryId, ownerId: context.ownerId, headSha: sha('b'), id: 100, attempt: 1 },
  producer: { event: 'workflow_run', sourceSha: sha('d'), sourceTree: sha('c'), runId: 101, attempt: 1,
    artifactId: 102, artifactDigest: digest('e'), receipt: { format: 'codexia-backend-build/v1', repository: context.repository, repositoryId: context.repositoryId, ownerId: context.ownerId, event: 'workflow_run',
      sourceSha: sha('d'), sourceTree: sha('c'), workflowRunId: 101, workflowRunNumber: 4, version: '0.1.2',
      artifacts: { full: { id: 102, digest: digest('e'), producerAttempt: 1, archiveSha256: 'e'.repeat(64) } } } },
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

test('an older or already occupied version cannot replace the running image', () => {
  for (const version of ['0.1.2', '0.1.10']) {
    const running = installed();
    running.identity.version = version;
    assert.throws(() => assertPushDeploymentAdmission(certificate(), running, {
      expectedMainSha: sha('b'), deployedUiEpoch: 1,
    }), /newer backend version/u);
  }
});

test('validates a reusable certificate against its complete producer receipt before runtime compatibility checks', () => {
  const admitted = validatePushDeploymentCertificate(certificate(), sha('b'));
  assert.equal(admitted.identity.profile, 'full');
  assert.equal(admitted.producer.receipt.artifacts.full.id, 102);
  assert.throws(() => validatePushDeploymentCertificate(certificate({
    producer: { ...certificate().producer, receipt: { ...certificate().producer.receipt,
      artifacts: { full: { ...certificate().producer.receipt.artifacts.full, id: 999 } } } },
  }), sha('b')), /receipt/);
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
  }), /certified candidate identity/u);
});

test('admits an exact same-digest reapplication as an idempotent no-op', () => {
  const base = certificate();
  const installedValue = installed();
  const receipt = structuredClone(base.producer.receipt);
  receipt.sourceSha = sha('a');
  receipt.version = installedValue.identity.version;
  const sameRelease = {
    ...base,
    producer: { ...base.producer, sourceSha: sha('a'), receipt },
    image: installedValue.image,
    identity: installedValue.identity,
  };
  const admitted = assertPushDeploymentAdmission(sameRelease, installedValue, {
    expectedMainSha: sha('b'), deployedUiEpoch: 1,
  });
  assert.equal(admitted.unchanged, true);
  assert.throws(() => assertPushDeploymentAdmission({
    ...sameRelease,
    image: `ghcr.io/yohn-jp/codexia-backend@${digest('9')}`,
  }, installedValue, { expectedMainSha: sha('b'), deployedUiEpoch: 1 }), /differ from the installed/u);
});

test('CLI admits the same certificate and installed identity Ansible supplies', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'codexia-push-admission-'));
  try {
    const certificatePath = path.join(directory, 'certificate.json');
    writeFileSync(certificatePath, JSON.stringify(certificate()));
    const installedValue = Buffer.from(JSON.stringify(installed())).toString('base64');
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('./validate.mjs', import.meta.url)),
      '--admit', certificatePath, installedValue, sha('b'), '1'], { encoding: 'utf8', env: { ...process.env, GITHUB_REPOSITORY: context.repository, GITHUB_REPOSITORY_ID: String(context.repositoryId), GITHUB_REPOSITORY_OWNER_ID: String(context.ownerId), } });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Admitted certified image/u);
    const rejected = spawnSync(process.execPath, [fileURLToPath(new URL('./validate.mjs', import.meta.url)),
      '--admit', certificatePath, installedValue, sha('9'), '1'], { encoding: 'utf8', env: { ...process.env, GITHUB_REPOSITORY: context.repository, GITHUB_REPOSITORY_ID: String(context.repositoryId), GITHUB_REPOSITORY_OWNER_ID: String(context.ownerId), } });
    assert.equal(rejected.status, 1);
    assert.match(rejected.stderr, /main revision/u);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
