#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readComponentVersion } from './component-release-version.mjs';
import { selectLatestJobArtifact } from './ci-artifact-selection.mjs';
import { downloadArtifact, extractArtifactFiles, MAX_ASSET_ARCHIVE, MAX_ASSET_BYTES } from './download-ci-artifacts.mjs';
import { collectGitHubPages } from './release-policy.mjs';
import { assertFrontendIdentity } from './verify-frontend-compatibility.mjs';

const repository = 'yohn-jp/codexia';
const shaPattern = /^[a-f0-9]{40}$/u;
const digestPattern = /^[a-f0-9]{64}$/u;

function positiveInteger(value, label) {
  const number = Number(value);
  assert.ok(Number.isSafeInteger(number) && number > 0, `${label} is invalid`);
  return number;
}

/**
 * Confirms the current workflow run and uploaded artifact are the exact producer
 * selected by the build job output, including partial and full reruns.
 * @param {unknown} run
 * @param {unknown} artifact
 * @param {unknown[]} jobs
 * @param {{runId:string|number,currentAttempt:string|number,producerAttempt:string|number,sourceSha:string,artifactId:string|number,artifactName:string,artifactDigest:string}} expected
 */
export function assertFrontendArtifactEvidence(run, artifact, jobs, expected) {
  assert.ok(run && typeof run === 'object' && !Array.isArray(run), 'Frontend producer workflow run metadata is invalid');
  assert.ok(artifact && typeof artifact === 'object' && !Array.isArray(artifact), 'Frontend artifact metadata is invalid');
  assert.match(expected.sourceSha, shaPattern, 'Frontend source SHA is invalid');
  assert.match(expected.artifactDigest, digestPattern, 'Frontend artifact digest is invalid');
  const runId = String(positiveInteger(expected.runId, 'Frontend producer run ID'));
  const currentAttempt = positiveInteger(expected.currentAttempt, 'Frontend workflow run attempt');
  const producerAttempt = positiveInteger(expected.producerAttempt, 'Frontend producer job attempt');
  const artifactId = positiveInteger(expected.artifactId, 'Frontend artifact ID');

  assert.equal(String(run.id), runId, 'Frontend producer run ID mismatch');
  assert.equal(run.run_attempt, currentAttempt, 'Frontend workflow run attempt mismatch');
  assert.equal(run.event, 'push', 'Frontend producer event must be a main push');
  assert.equal(run.head_branch, 'main', 'Frontend producer branch must be main');
  assert.equal(run.head_sha, expected.sourceSha, 'Frontend producer source SHA mismatch');

  assert.equal(expected.artifactName, `codexia-frontend-${expected.sourceSha}-attempt-${producerAttempt}`, 'Frontend artifact name does not bind the producer attempt');
  const selected = selectLatestJobArtifact(expected.artifactName, 'Build and verify UI assets', [artifact], jobs, {
    runId,
    sourceSha: expected.sourceSha,
  });
  assert.equal(selected.id, artifactId, 'Frontend artifact ID does not match the build job output');
  const producerJobs = jobs.filter(job => job && typeof job === 'object' && job.name === 'Build and verify UI assets');
  assert.equal(producerJobs.length, 1, 'Expected exactly one latest frontend artifact producer job');
  assert.equal(producerJobs[0].run_attempt, producerAttempt, 'Frontend artifact producer attempt mismatch');
  assert.equal(artifact.digest, `sha256:${expected.artifactDigest}`, 'Frontend artifact digest mismatch');
}

/** @param {string} url @param {string} token @param {typeof fetch} fetchImpl */
async function githubJson(url, token, fetchImpl) {
  let response;
  try {
    response = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new Error('Could not verify frontend artifact provenance with the GitHub Actions API.');
  }
  if (!response.ok) throw new Error(`Frontend artifact provenance lookup failed (HTTP ${response.status}).`);
  try {
    return await response.json();
  } catch {
    throw new Error('GitHub returned invalid frontend artifact provenance metadata.');
  }
}

/** @param {{env?:NodeJS.ProcessEnv,fetchImpl?:typeof fetch}} options */
export async function verifyFrontendArtifact({ env = process.env, fetchImpl = fetch } = {}) {
  assert.equal(env.GITHUB_REPOSITORY, repository, 'Frontend artifact repository mismatch');
  assert.equal(env.GITHUB_EVENT_NAME, 'push', 'Frontend artifact must come from a push event');
  assert.equal(env.GITHUB_REF, 'refs/heads/main', 'Frontend artifact must come from main');
  assert.match(env.GITHUB_SHA ?? '', shaPattern, 'Frontend artifact source SHA is invalid');
  assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), env.GITHUB_SHA, 'Frontend deploy checkout source mismatch');
  const token = env.GH_TOKEN;
  assert.ok(typeof token === 'string' && token.length > 0, 'GitHub Actions read token is required for frontend artifact provenance');

  const expected = {
    runId: positiveInteger(env.GITHUB_RUN_ID, 'Frontend producer run ID'),
    currentAttempt: positiveInteger(env.GITHUB_RUN_ATTEMPT, 'Frontend workflow run attempt'),
    producerAttempt: positiveInteger(env.CODEXIA_FRONTEND_PRODUCER_ATTEMPT, 'Frontend producer job attempt'),
    sourceSha: env.GITHUB_SHA,
    artifactId: positiveInteger(env.CODEXIA_FRONTEND_ARTIFACT_ID, 'Frontend artifact ID'),
    artifactName: env.CODEXIA_FRONTEND_ARTIFACT_NAME,
    artifactDigest: env.CODEXIA_FRONTEND_ARTIFACT_DIGEST,
  };
  assert.equal(expected.artifactName, `codexia-frontend-${expected.sourceSha}-attempt-${expected.producerAttempt}`, 'Frontend artifact name does not bind its source and producer attempt');
  assert.match(expected.artifactDigest ?? '', digestPattern, 'Frontend artifact digest is invalid');

  const apiBase = `https://api.github.com/repos/${repository}/actions`;
  const [run, artifact, jobs] = await Promise.all([
    githubJson(`${apiBase}/runs/${expected.runId}`, token, fetchImpl),
    githubJson(`${apiBase}/artifacts/${expected.artifactId}`, token, fetchImpl),
    collectGitHubPages((page, perPage) => githubJson(`${apiBase}/runs/${expected.runId}/jobs?filter=latest&per_page=${perPage}&page=${page}`, token, fetchImpl), 'jobs'),
  ]);
  assertFrontendArtifactEvidence(run, artifact, jobs, expected);

  const artifactBytes = await downloadArtifact(artifact, repository, token, fetchImpl, {maxArchive:MAX_ASSET_ARCHIVE});
  await extractArtifactFiles(artifactBytes, fileURLToPath(new URL('../app/dist/', import.meta.url)), {
    maxArchive:MAX_ASSET_ARCHIVE,
    maxUncompressed:MAX_ASSET_BYTES,
  });

  const identity = assertFrontendIdentity(JSON.parse(readFileSync(new URL('../app/dist/desktop/update-identity.json', import.meta.url), 'utf8')));
  const apiEpoch = JSON.parse(readFileSync(new URL('../deploy/frontend-compatibility.json', import.meta.url), 'utf8')).apiEpoch;
  assert.equal(identity.version, readComponentVersion('frontend'), 'Frontend artifact version does not match this workflow run');
  assert.equal(identity.sourceSha, expected.sourceSha, 'Frontend artifact source SHA mismatch');
  assert.equal(identity.profile, 'full', 'Frontend artifact must contain the Full profile');
  assert.equal(identity.apiEpoch, apiEpoch, 'Frontend artifact API epoch mismatch');
  return { artifactId: expected.artifactId, sourceSha: expected.sourceSha, version: identity.version };
}

async function main() {
  const artifact = await verifyFrontendArtifact();
  console.log(`Verified frontend artifact ${artifact.artifactId} from producer run ${process.env.GITHUB_RUN_ID} attempt ${process.env.CODEXIA_FRONTEND_PRODUCER_ATTEMPT}, source ${artifact.sourceSha}, version ${artifact.version}.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : 'Frontend artifact provenance verification failed');
    process.exitCode = 1;
  });
}
