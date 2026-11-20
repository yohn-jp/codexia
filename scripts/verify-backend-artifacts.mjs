#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { selectLatestJobArtifact } from './ci-artifact-selection.mjs';
import { downloadArtifact, extractArtifactFiles } from './download-ci-artifacts.mjs';
import { collectGitHubPages } from './release-policy.mjs';

const REPOSITORY = 'yohn-jp/codexia';
const PROFILES = ['core', 'full'];
// Current Core/Full archives are approximately 117/250 MB. Bound the input
// and extraction separately; no unverified archive reaches docker load.
const MAX_IMAGE_ARCHIVE = 512 * 1024 * 1024;
const MAX_IMAGE_BYTES = 512 * 1024 * 1024;
const IMAGE_FILE = 'codexia-backend-image.tar.gz';

function positiveInteger(value, label) {
  const result = Number(value);
  assert.ok(Number.isSafeInteger(result) && result > 0, label + ' is invalid');
  return result;
}

/** Select the one attempt-specific artifact inside each latest successful producer job window. */
export function selectBackendArtifacts(run, artifacts, jobs, expected) {
  assert.match(expected.sourceSha, /^[a-f0-9]{40}$/u);
  const runId = positiveInteger(expected.runId, 'Backend producer run ID');
  const currentAttempt = positiveInteger(expected.currentAttempt, 'Backend workflow attempt');
  assert.equal(run.id, runId, 'Backend workflow run mismatch');
  assert.equal(run.run_attempt, currentAttempt, 'Backend workflow attempt mismatch');
  const event = expected.event ?? 'push';
  assert.ok(['push', 'pull_request'].includes(event), 'Backend producer event is invalid');
  assert.equal(run.event, event, 'Backend producer event mismatch');
  if (event === 'push') assert.equal(run.head_branch, 'main', 'Backend producer branch must be main');
  else assert.equal(run.head_branch, expected.headBranch, 'Backend PR producer branch mismatch');
  assert.equal(run.head_sha, expected.sourceSha, 'Backend producer source mismatch');
  assert.ok(Array.isArray(artifacts) && Array.isArray(jobs), 'Invalid backend artifact inventory');
  const identity = { runId, sourceSha: expected.sourceSha };
  const selected = PROFILES.map(profile => {
    const jobName = 'Build and test backend OCI image (' + profile + ')';
    const producers = jobs.filter(job => job?.name === jobName);
    assert.equal(producers.length, 1, 'Expected exactly one latest backend producer: ' + profile);
    const job = producers[0];
    const start = Date.parse(job.started_at), end = Date.parse(job.completed_at);
    assert.ok(Number.isFinite(start) && Number.isFinite(end) && start <= end, 'Invalid backend producer time window');
    const pattern = new RegExp('^codexia-backend-image-' + expected.sourceSha + '-' + profile + '-attempt-([1-9][0-9]*)$','u');
    const candidates = artifacts.filter(artifact => {
      if (!pattern.test(artifact?.name ?? '')) return false;
      const created = Date.parse(artifact.created_at);
      assert.ok(Number.isFinite(created), 'Invalid backend artifact creation timestamp');
      return created >= start && created <= end;
    });
    assert.equal(candidates.length, 1, 'Expected one fresh backend artifact: ' + profile);
    const name = candidates[0].name;
    const producerAttempt = positiveInteger(pattern.exec(name)[1], 'Backend producer attempt');
    assert.ok(producerAttempt <= currentAttempt, 'Backend artifact producer attempt is newer than current run');
    const artifact = selectLatestJobArtifact(name, jobName, artifacts, jobs, identity);
    assert.match(artifact.digest, /^sha256:[a-f0-9]{64}$/u, 'Backend artifact digest is invalid');
    assert.ok(Number.isSafeInteger(artifact.size_in_bytes) && artifact.size_in_bytes > 0 && artifact.size_in_bytes <= MAX_IMAGE_ARCHIVE,
      'Backend artifact exceeds the bounded archive size');
    return { profile, jobName, artifact, producerAttempt };
  });
  assert.notEqual(selected[0].artifact.id, selected[1].artifact.id, 'Backend profiles must use distinct artifacts');
  return selected;
}

/** GitHub may alias a reused successful job to the current attempt in filter=latest. */
export function assertBackendProducerAttempt(selected, jobs, expected) {
  const producers = jobs.filter(job => job?.name === selected.jobName);
  assert.equal(producers.length, 1, 'Expected one backend job in declared producer attempt');
  assert.equal(producers[0].run_attempt, selected.producerAttempt, 'Backend producer attempt mismatch');
  assert.equal(selectLatestJobArtifact(selected.artifact.name, selected.jobName, [selected.artifact], jobs,
    { runId: expected.runId, sourceSha: expected.sourceSha }).id, selected.artifact.id,
    'Backend artifact does not belong to its declared producer attempt');
}

async function githubJson(url, token, fetchImpl) {
  const response = await fetchImpl(url, {
    headers: { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
    redirect: 'error', signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error('Backend artifact provenance lookup failed (HTTP ' + response.status + ')');
  return response.json();
}

export async function verifyBackendArtifacts({env=process.env,fetchImpl=fetch}={}) {
  assert.equal(env.GITHUB_REPOSITORY, REPOSITORY);
  assert.equal(env.GITHUB_EVENT_NAME, 'push');
  assert.equal(env.GITHUB_REF, 'refs/heads/main');
  const expected = {runId:positiveInteger(env.GITHUB_RUN_ID,'Backend workflow run ID'),
    currentAttempt:positiveInteger(env.GITHUB_RUN_ATTEMPT,'Backend workflow attempt'),sourceSha:env.GITHUB_SHA};
  assert.match(expected.sourceSha, /^[a-f0-9]{40}$/u);
  assert.equal(execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),expected.sourceSha,'Backend publish checkout source mismatch');
  const token = env.GH_TOKEN;
  assert.ok(typeof token === 'string' && token.length > 0, 'GitHub Actions read token required');
  const destination = env.CODEXIA_BACKEND_ARTIFACT_DIR;
  assert.ok(typeof destination === 'string' && path.isAbsolute(destination), 'Backend artifact destination must be absolute');
  const api = 'https://api.github.com/repos/' + REPOSITORY + '/actions/runs/' + expected.runId;
  const read = suffix => githubJson(api + suffix, token, fetchImpl);
  const [run,artifacts,jobs] = await Promise.all([
    read(''),
    collectGitHubPages((page,perPage)=>read('/artifacts?per_page='+perPage+'&page='+page),'artifacts'),
    collectGitHubPages((page,perPage)=>read('/jobs?filter=latest&per_page='+perPage+'&page='+page),'jobs'),
  ]);
  const selected = selectBackendArtifacts(run,artifacts,jobs,expected);
  const attempts = new Map(await Promise.all([...new Set(selected.map(item=>item.producerAttempt))].map(async attempt=>[
    attempt,await collectGitHubPages((page,perPage)=>read('/attempts/'+attempt+'/jobs?per_page='+perPage+'&page='+page),'jobs'),
  ])));
  // Verify both producers before downloading; extract sequentially to keep
  // peak memory bounded by a single compressed image archive.
  for (const item of selected) assertBackendProducerAttempt(item,attempts.get(item.producerAttempt),expected);
  for (const item of selected) {
    const archive = await downloadArtifact(item.artifact,REPOSITORY,token,fetchImpl,{maxArchive:MAX_IMAGE_ARCHIVE,downloadTimeoutMs:180_000});
    const files = await extractArtifactFiles(archive,path.join(destination,item.profile),{maxArchive:MAX_IMAGE_ARCHIVE,maxUncompressed:MAX_IMAGE_BYTES});
    assert.deepEqual(files,[IMAGE_FILE],'Unexpected backend artifact contents');
    console.log('Verified '+item.profile+' backend artifact '+item.artifact.id+' from run '+expected.runId+' attempt '+item.producerAttempt+' source '+expected.sourceSha);
  }
  return selected;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  verifyBackendArtifacts().catch(error=>{
    console.error(error instanceof Error ? error.message : 'Backend artifact verification failed');
    process.exitCode=1;
  });
}
