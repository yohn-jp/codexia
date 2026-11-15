#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readComponentVersion } from './component-release-version.mjs';
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
 * selected by the build job output.
 * @param {unknown} run
 * @param {unknown} artifact
 * @param {{runId:string|number,runAttempt:string|number,sourceSha:string,artifactId:string|number,artifactName:string,artifactDigest:string}} expected
 */
export function assertFrontendArtifactEvidence(run, artifact, expected) {
  assert.ok(run && typeof run === 'object' && !Array.isArray(run), 'Frontend producer workflow run metadata is invalid');
  assert.ok(artifact && typeof artifact === 'object' && !Array.isArray(artifact), 'Frontend artifact metadata is invalid');
  assert.match(expected.sourceSha, shaPattern, 'Frontend source SHA is invalid');
  assert.match(expected.artifactDigest, digestPattern, 'Frontend artifact digest is invalid');
  const runId = String(positiveInteger(expected.runId, 'Frontend producer run ID'));
  const runAttempt = positiveInteger(expected.runAttempt, 'Frontend producer run attempt');
  const artifactId = positiveInteger(expected.artifactId, 'Frontend artifact ID');

  assert.equal(String(run.id), runId, 'Frontend producer run ID mismatch');
  assert.equal(run.run_attempt, runAttempt, 'Frontend producer run attempt mismatch');
  assert.equal(run.event, 'push', 'Frontend producer event must be a main push');
  assert.equal(run.head_branch, 'main', 'Frontend producer branch must be main');
  assert.equal(run.head_sha, expected.sourceSha, 'Frontend producer source SHA mismatch');

  assert.equal(artifact.id, artifactId, 'Frontend artifact ID mismatch');
  assert.equal(artifact.name, expected.artifactName, 'Frontend artifact name mismatch');
  assert.equal(artifact.expired, false, 'Frontend artifact is expired');
  assert.ok(Number.isSafeInteger(artifact.size_in_bytes) && artifact.size_in_bytes > 0, 'Frontend artifact is empty or has invalid size');
  assert.equal(artifact.digest, `sha256:${expected.artifactDigest}`, 'Frontend artifact digest mismatch');
  assert.ok(artifact.workflow_run && typeof artifact.workflow_run === 'object' && !Array.isArray(artifact.workflow_run), 'Frontend artifact producer binding is missing');
  assert.equal(String(artifact.workflow_run.id), runId, 'Frontend artifact belongs to a different producer run');
  assert.equal(artifact.workflow_run.head_branch, 'main', 'Frontend artifact producer branch mismatch');
  assert.equal(artifact.workflow_run.head_sha, expected.sourceSha, 'Frontend artifact source SHA mismatch');
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
    runAttempt: positiveInteger(env.GITHUB_RUN_ATTEMPT, 'Frontend producer run attempt'),
    sourceSha: env.GITHUB_SHA,
    artifactId: positiveInteger(env.CODEXIA_FRONTEND_ARTIFACT_ID, 'Frontend artifact ID'),
    artifactName: env.CODEXIA_FRONTEND_ARTIFACT_NAME,
    artifactDigest: env.CODEXIA_FRONTEND_ARTIFACT_DIGEST,
  };
  assert.equal(expected.artifactName, `codexia-frontend-${expected.sourceSha}`, 'Frontend artifact name is not source-addressed');
  assert.match(expected.artifactDigest ?? '', digestPattern, 'Frontend artifact digest is invalid');

  const apiBase = `https://api.github.com/repos/${repository}/actions`;
  const [run, artifact] = await Promise.all([
    githubJson(`${apiBase}/runs/${expected.runId}`, token, fetchImpl),
    githubJson(`${apiBase}/artifacts/${expected.artifactId}`, token, fetchImpl),
  ]);
  assertFrontendArtifactEvidence(run, artifact, expected);

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
  console.log(`Verified frontend artifact ${artifact.artifactId} from producer run ${process.env.GITHUB_RUN_ID}, source ${artifact.sourceSha}, version ${artifact.version}.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : 'Frontend artifact provenance verification failed');
    process.exitCode = 1;
  });
}
