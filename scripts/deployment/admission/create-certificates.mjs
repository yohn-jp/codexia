#!/usr/bin/env node
import assert from 'node:assert/strict';
import { actionsRepository, assertBackendImageDigest } from '../../github/repository.mjs';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expectedBackendMigrationFingerprint, inspectBackendImageWithoutExecution } from '../../release/backend/image-inspection.mjs';
import { verifiedReleaseEvent } from '../../release/components/source-gate.mjs';
import { buildPushDeploymentCertificate } from './certificate.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const positive = value => Number.isSafeInteger(Number(value)) && Number(value) > 0;

export async function createBackendDeploymentCertificates({ env = process.env, payload } = {}) {
  const context = actionsRepository(env);
  assert.equal(env.GITHUB_EVENT_NAME, 'workflow_run');
  assert.equal(env.GITHUB_REF, 'refs/heads/main');
  const sourceSha = env.CODEXIA_SOURCE_SHA || env.GITHUB_SHA;
  assert.match(sourceSha ?? '', /^[a-f0-9]{40}$/u);
  const checkoutSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const event = payload || JSON.parse(await readFile(env.GITHUB_EVENT_PATH, 'utf8'));
  const verifyRun = verifiedReleaseEvent(event, env, checkoutSha);
  const verifiedMainTree = execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: root, encoding: 'utf8' }).trim();
  const promoted = env.CODEXIA_BACKEND_PRODUCER_EVENT === 'pull_request';
  assert.ok(promoted || env.CODEXIA_BACKEND_PRODUCER_EVENT === 'workflow_run', 'Backend producer event is invalid');
  const receiptFile = promoted
    ? path.join(env.CODEXIA_BACKEND_PROMOTION_DIR || '', 'codexia-backend-promotion.json')
    : env.CODEXIA_BACKEND_ARTIFACT_MANIFEST;
  assert.ok(typeof receiptFile === 'string' && path.isAbsolute(receiptFile), 'Backend producer receipt path is invalid');
  const receipt = JSON.parse(await readFile(receiptFile, 'utf8'));
  assert.equal(receipt.event, env.CODEXIA_BACKEND_PRODUCER_EVENT, 'Backend producer receipt event mismatch');
  assert.equal(receipt.sourceSha, env.CODEXIA_BACKEND_PRODUCER_SHA, 'Backend producer receipt source mismatch');
  assert.equal(receipt.sourceTree, verifiedMainTree, 'Backend producer receipt tree differs from exact main source');
  const version = env.CODEXIA_BACKEND_PRODUCER_VERSION;
  assert.match(version ?? '', /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u, 'Backend producer version is invalid');
  assert.equal(receipt.version, version, 'Backend producer receipt version mismatch');
  const destination = env.CODEXIA_DEPLOYMENT_CERTIFICATE_DIR;
  assert.ok(typeof destination === 'string' && path.isAbsolute(destination), 'Deployment certificate output directory must be absolute');
  const compatibility = JSON.parse(await readFile(path.join(root, 'deploy/update-compatibility.json'), 'utf8'));
  const migrationFingerprint = await expectedBackendMigrationFingerprint();
  await mkdir(destination, { recursive: true, mode: 0o700 });

  const certificates = [];
  for (const profile of ['core', 'full']) {
    const image = profile === 'core' ? env.CODEXIA_CERTIFIED_IMAGE : env.CODEXIA_CERTIFIED_FULL_IMAGE;
    assert.ok(positive(env.GITHUB_RUN_ID), 'Backend publication run ID is invalid');
    assertBackendImageDigest(image, context.repository);
    const identity = await inspectBackendImageWithoutExecution(image, {
      sourceSha: receipt.sourceSha, version, profile, migrationFingerprint, compatibility,
    }, { tempRoot: env.RUNNER_TEMP || undefined });
    const certificate = buildPushDeploymentCertificate({
      verifiedMainSha: sourceSha, verifiedMainTree, verifyRun, producerReceipt: receipt, profile, image, identity, context,
    });
    await writeFile(path.join(destination, profile + '.json'), JSON.stringify(certificate, null, 2) + '\n',
      { mode: 0o600, flag: 'wx' });
    certificates.push(certificate);
  }
  return certificates;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  createBackendDeploymentCertificates().then(certificates => {
    console.log(`Prepared ${certificates.length} authenticated backend deployment handoff certificates`);
  }).catch(error => {
    console.error(error instanceof Error ? error.message : 'Backend deployment certificate creation failed');
    process.exitCode = 1;
  });
}
