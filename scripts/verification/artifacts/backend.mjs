#!/usr/bin/env node
import { actionsRepository, assertArtifactRunRepository, matchesRunRepository, releaseRepositoryBinding } from '../../github/repository.mjs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { selectLatestJobArtifact } from '../../ci/evidence/artifact-selection.mjs';
import { downloadArtifact, extractArtifactFiles } from '../../ci/evidence/download-artifacts.mjs';
import { readComponentVersion } from '../../release/components/version.mjs';
import { createGitHubOctokit } from '../../github/octokit.mjs';
import { paginateActionsInventory } from '../../github/paginate-actions.mjs';

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
  const workflowSha = expected.event === 'workflow_run' ? expected.workflowSha : expected.sourceSha;
  assert.match(workflowSha ?? '', /^[a-f0-9]{40}$/u, 'Backend producer workflow SHA is invalid');
  assert.equal(run.id, runId, 'Backend workflow run mismatch');
  assert.equal(run.run_attempt, currentAttempt, 'Backend workflow attempt mismatch');
  const event = expected.event ?? 'push';
  assert.ok(['push', 'workflow_run', 'pull_request'].includes(event), 'Backend producer event is invalid');
  assert.equal(run.event, event, 'Backend producer event mismatch');
  if (event !== 'pull_request') assert.equal(run.head_branch, 'main', 'Backend producer branch must be main');
  else assert.equal(run.head_branch, expected.headBranch, 'Backend PR producer branch mismatch');
  assert.equal(run.head_sha, workflowSha, 'Backend producer workflow SHA mismatch');
  assert.ok(Array.isArray(artifacts) && Array.isArray(jobs), 'Invalid backend artifact inventory');
  const identity = { runId, sourceSha: workflowSha };
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
  const workflowSha = expected.event === 'workflow_run' ? expected.workflowSha : expected.sourceSha;
  assert.equal(selectLatestJobArtifact(selected.artifact.name, selected.jobName, [selected.artifact], jobs,
    { runId: expected.runId, sourceSha: workflowSha }).id, selected.artifact.id,
    'Backend artifact does not belong to its declared producer attempt');
}

export function buildBackendBuildReceipt({sourceSha,workflowRunId,workflowRunNumber,sourceTree,artifacts,event='push'},context){
  assert.ok(['push','workflow_run'].includes(event),'Invalid main backend artifact producer event');
  assert.match(sourceSha??'',/^[a-f0-9]{40}$/u);
  assert.match(sourceTree??'',/^[a-f0-9]{40}$/u);
  for(const [value,label] of [[workflowRunId,'Backend workflow run ID'],[workflowRunNumber,'Backend workflow run number']])
    assert.ok(Number.isSafeInteger(value)&&value>0,label+' is invalid');
  assert.ok(Array.isArray(artifacts)&&artifacts.length===2,'Expected Core and Full backend artifacts');
  const receipt={format:'codexia-backend-build/v1',event,sourceSha,version:readComponentVersion('backend',String(workflowRunNumber)),
    workflowRunId,workflowRunNumber,sourceTree,...releaseRepositoryBinding(context),artifacts:{}};
  for(const artifact of artifacts){
    assert.ok(['core','full'].includes(artifact.profile),'Invalid backend artifact profile');
    assert.ok(!receipt.artifacts[artifact.profile],'Duplicate backend artifact profile');
    assert.ok(Number.isSafeInteger(artifact.id)&&artifact.id>0,'Backend artifact ID is invalid');
    assert.match(artifact.digest??'',/^sha256:[a-f0-9]{64}$/u,'Backend artifact digest is invalid');
    assert.ok(Number.isSafeInteger(artifact.producerAttempt)&&artifact.producerAttempt>0,'Backend producer attempt is invalid');
    assert.match(artifact.archiveSha256??'',/^[a-f0-9]{64}$/u,'Backend archive digest is invalid');
    receipt.artifacts[artifact.profile]={id:artifact.id,digest:artifact.digest,producerAttempt:artifact.producerAttempt,archiveSha256:artifact.archiveSha256};
  }
  assert.deepEqual(Object.keys(receipt.artifacts).sort(),['core','full']);
  assert.notEqual(receipt.artifacts.core.id,receipt.artifacts.full.id);
  assert.notEqual(receipt.artifacts.core.digest,receipt.artifacts.full.digest);
  return receipt;
}

async function sha256File(filename){
  const hash=createHash('sha256');
  for await(const chunk of createReadStream(filename))hash.update(chunk);
  return hash.digest('hex');
}

export async function verifyBackendArtifacts({env=process.env,fetchImpl=fetch}={}) {
  const context = actionsRepository(env);
  assert.ok(['push','workflow_run'].includes(env.GITHUB_EVENT_NAME),'Backend publication must use verified main source');
  assert.equal(env.GITHUB_REF, 'refs/heads/main');
  const expected = {runId:positiveInteger(env.GITHUB_RUN_ID,'Backend workflow run ID'),
    currentAttempt:positiveInteger(env.GITHUB_RUN_ATTEMPT,'Backend workflow attempt'),sourceSha:env.CODEXIA_SOURCE_SHA || env.GITHUB_SHA,
    event:env.GITHUB_EVENT_NAME,workflowSha:env.GITHUB_SHA};
  assert.match(expected.sourceSha, /^[a-f0-9]{40}$/u);
  assert.equal(execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),expected.sourceSha,'Backend publish checkout source mismatch');
  const token = env.GH_TOKEN;
  assert.ok(typeof token === 'string' && token.length > 0, 'GitHub Actions read token required');
  const github = createGitHubOctokit({ ...context, token, fetchImpl });
  const destination = env.CODEXIA_BACKEND_ARTIFACT_DIR;
  assert.ok(typeof destination === 'string' && path.isAbsolute(destination), 'Backend artifact destination must be absolute');
  const manifestPath=env.CODEXIA_BACKEND_ARTIFACT_MANIFEST;
  assert.ok(typeof manifestPath==='string'&&path.isAbsolute(manifestPath),'Backend artifact manifest path must be absolute');
  const { owner, repo, repository } = context;
  const [run,artifacts,jobs] = await Promise.all([
    github.rest.actions.getWorkflowRun({ owner, repo, run_id: expected.runId }).then(response => response.data),
    paginateActionsInventory(github, github.rest.actions.listWorkflowRunArtifacts,
      { owner, repo, run_id: expected.runId }, 'artifacts'),
    paginateActionsInventory(github, github.rest.actions.listJobsForWorkflowRun,
      { owner, repo, run_id: expected.runId, filter: 'latest' }, 'jobs'),
  ]);
  assert.ok(matchesRunRepository(run, context), 'Backend build repository mismatch');
  assert.equal(run.path, '.github/workflows/backend-release.yml', 'Backend build workflow mismatch');
  const selected = selectBackendArtifacts(run,artifacts,jobs,expected);
  const attempts = new Map(await Promise.all([...new Set(selected.map(item=>item.producerAttempt))].map(async attempt=>[
    attempt,await paginateActionsInventory(github, github.rest.actions.listJobsForWorkflowRunAttempt,
      { owner, repo, run_id: expected.runId, attempt_number: attempt }, 'jobs'),
  ])));
  // Verify both producers before downloading; extract sequentially to keep
  // peak memory bounded by a single compressed image archive.
  for (const item of selected) assertBackendProducerAttempt(item,attempts.get(item.producerAttempt),expected);
  for (const item of selected) {
    assertArtifactRunRepository(item.artifact, run);
    const archive = await downloadArtifact(item.artifact,repository,token,fetchImpl,{maxArchive:MAX_IMAGE_ARCHIVE,downloadTimeoutMs:180_000});
    const files = await extractArtifactFiles(archive,path.join(destination,item.profile),{maxArchive:MAX_IMAGE_ARCHIVE,maxUncompressed:MAX_IMAGE_BYTES});
    assert.deepEqual(files,[IMAGE_FILE],'Unexpected backend artifact contents');
    item.archiveSha256=await sha256File(path.join(destination,item.profile,IMAGE_FILE));
    console.log('Verified '+item.profile+' backend artifact '+item.artifact.id+' from run '+expected.runId+' attempt '+item.producerAttempt+' source '+expected.sourceSha);
  }
  const manifest=buildBackendBuildReceipt({sourceSha:expected.sourceSha,workflowRunId:expected.runId,
    workflowRunNumber:positiveInteger(env.GITHUB_RUN_NUMBER,'Backend workflow run number'),
    sourceTree:execFileSync('git',['rev-parse','HEAD^{tree}'],{encoding:'utf8'}).trim(),
    event:env.GITHUB_EVENT_NAME,artifacts:selected.map(item=>({profile:item.profile,id:item.artifact.id,digest:item.artifact.digest,
      producerAttempt:item.producerAttempt,archiveSha256:item.archiveSha256}))},context);
  await mkdir(path.dirname(manifestPath),{recursive:true});
  await writeFile(manifestPath,JSON.stringify(manifest,null,2)+'\n',{mode:0o600});
  return selected;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  verifyBackendArtifacts().catch(error=>{
    console.error(error instanceof Error ? error.message : 'Backend artifact verification failed');
    process.exitCode=1;
  });
}
