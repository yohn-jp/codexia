#!/usr/bin/env node
import assert from 'node:assert/strict';
import { appendFileSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';
import { verifyBuiltBackendImageIdentity } from './verify-backend-image-identity.mjs';
import { validateBackendIdentity } from './backend-update-identity.mjs';

const repository = 'yohn-jp/codexia';
const sha = /^[a-f0-9]{40}$/u;
const imagePattern = /^ghcr\.io\/yohn-jp\/codexia-backend@sha256:[a-f0-9]{64}$/u;
const digest = /^sha256:[a-f0-9]{64}$/u;
const positive = value => Number.isSafeInteger(Number(value)) && Number(value) > 0;

function readJson(filename) {
  assert.ok(typeof filename === 'string' && path.isAbsolute(filename), 'Push certificate receipt path must be absolute');
  return JSON.parse(readFileSync(filename, 'utf8'));
}

/** Build a rollout certificate from the already-authenticated release handoff and exact pulled image. */
export async function createPushDeploymentCertificate({
  env = process.env,
  getRevision = () => execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  getTree = () => execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { encoding: 'utf8' }).trim(),
  read = readJson,
  inspectImage = (image, sourceSha, version, profile, currentEnv) =>
    verifyBuiltBackendImageIdentity({ args: [image, sourceSha, version, profile], env: currentEnv }),
} = {}) {
  if (env.GITHUB_REPOSITORY !== repository || env.GITHUB_EVENT_NAME !== 'workflow_run' || env.GITHUB_REF !== 'refs/heads/main') {
    throw new Error('Push deployment certificate requires the main backend release workflow');
  }

  const verifiedMainSha = env.CODEXIA_VERIFIED_MAIN_SHA;
  if (!sha.test(verifiedMainSha ?? '')) throw new Error('Verified main revision is invalid');
  if (getRevision() !== verifiedMainSha) throw new Error('Certificate checkout differs from the verified main revision');
  const verifiedMainTree = getTree();
  if (!sha.test(verifiedMainTree ?? '')) throw new Error('Verified main source tree is invalid');

  const verifyRun = {
    event: env.CODEXIA_VERIFY_EVENT,
    branch: env.CODEXIA_VERIFY_BRANCH,
    conclusion: env.CODEXIA_VERIFY_CONCLUSION,
    repository: env.CODEXIA_VERIFY_REPOSITORY,
    headSha: env.CODEXIA_VERIFY_HEAD_SHA,
    id: Number(env.CODEXIA_VERIFY_RUN_ID),
    attempt: Number(env.CODEXIA_VERIFY_RUN_ATTEMPT),
  };
  if (verifyRun.event !== 'push' || verifyRun.branch !== 'main' || verifyRun.conclusion !== 'success' ||
      verifyRun.repository !== repository || env.CODEXIA_VERIFY_HEAD_REPOSITORY !== repository ||
      verifyRun.headSha !== verifiedMainSha || !positive(verifyRun.id) || !positive(verifyRun.attempt)) {
    throw new Error('Certificate verification run is not a successful exact-main verification');
  }

  const producerEvent = env.CODEXIA_BACKEND_PRODUCER_EVENT;
  if (!['workflow_run', 'pull_request'].includes(producerEvent)) throw new Error('Backend producer event is invalid');
  const receipt = producerEvent === 'pull_request'
    ? read(path.join(env.CODEXIA_BACKEND_PROMOTION_DIR ?? '', 'codexia-backend-promotion.json'))
    : read(env.CODEXIA_BACKEND_ARTIFACT_MANIFEST);
  const producerSha = env.CODEXIA_PRODUCER_SHA;
  const version = env.CODEXIA_PRODUCER_VERSION;
  const candidateImage = env.CODEXIA_CERTIFIED_FULL_IMAGE;
  if (!sha.test(producerSha ?? '') || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(version ?? '') ||
      !imagePattern.test(candidateImage ?? '')) {
    throw new Error('Published Full image identity is invalid');
  }

  const expectedFormat = producerEvent === 'pull_request' ? 'codexia-backend-promotion/v1' : 'codexia-backend-build/v1';
  const artifact = receipt?.artifacts?.full;
  if (receipt?.format !== expectedFormat || receipt.sourceSha !== producerSha || receipt.sourceTree !== verifiedMainTree ||
      (producerEvent === 'pull_request' && receipt.mainSha !== verifiedMainSha) ||
      !positive(receipt.workflowRunId) || !artifact || !positive(artifact.id) ||
      !positive(artifact.producerAttempt) || !digest.test(artifact.digest ?? '')) {
    throw new Error('Backend producer artifact receipt differs from verified main source');
  }
  if (producerEvent === 'workflow_run' && receipt.event !== 'workflow_run') {
    throw new Error('Backend build receipt has the wrong producer event');
  }
  if (producerEvent === 'pull_request' && receipt.event !== 'pull_request') {
    throw new Error('Backend promotion receipt has the wrong producer event');
  }
  if (producerEvent === 'pull_request' && receipt.version !== version) {
    throw new Error('Backend promotion receipt version differs from the published image');
  }

  const identity = validateBackendIdentity(await inspectImage(candidateImage, producerSha, version, 'full', env));
  if (identity.sourceSha !== producerSha || identity.version !== version || identity.profile !== 'full') {
    throw new Error('Published Full image identity differs from its authenticated producer');
  }
  if (producerEvent === 'pull_request' && !isDeepStrictEqual(identity, artifact.identity)) {
    throw new Error('Published image identity differs from the verified promotion artifact');
  }

  return {
    format: 'codexia-backend-deployment-certificate/v1',
    verifiedMainSha,
    verifiedMainTree,
    verifyRun,
    producer: {
      sourceSha: producerSha,
      sourceTree: receipt.sourceTree,
      runId: Number(receipt.workflowRunId),
      attempt: Number(artifact.producerAttempt),
      artifactId: Number(artifact.id),
      artifactDigest: artifact.digest,
    },
    image: candidateImage,
    identity,
  };
}

async function main() {
  const certificate = await createPushDeploymentCertificate();
  const encoded = Buffer.from(JSON.stringify(certificate)).toString('base64');
  if (!process.env.GITHUB_OUTPUT) throw new Error('GitHub Actions output file is required');
  appendFileSync(process.env.GITHUB_OUTPUT, `certificate=${encoded}\n`);
  console.log(`Created a provenance-bound Full rollout certificate for ${certificate.image}.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : 'Push deployment certificate creation failed');
    process.exitCode = 1;
  });
}
