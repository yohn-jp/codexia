#!/usr/bin/env node
import { actionsRepository, assertArtifactRunRepository, matchesRunRepository } from '../../github/repository.mjs';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { appendFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareComponentVersions, readComponentVersion } from '../../release/components/version.mjs';
import { selectLatestJobArtifact } from '../../ci/evidence/artifact-selection.mjs';
import { downloadArtifact, extractArtifactFiles, extractJsonEntry, readArtifactFiles, MAX_ASSET_ARCHIVE, MAX_ASSET_BYTES } from '../../ci/evidence/download-artifacts.mjs';
import { assertFrontendOAuthConfigIdentity, readFrontendOAuthConfig } from '../../build/frontend/oauth-config.mjs';
import { assertVerificationRunJobs, verifiedSourceRun } from '../../release/components/policy.mjs';
import { assertFrontendIdentity } from '../../release/frontend/verify-compatibility.mjs';
import { verifyReusableMainProof } from '../../ci/certification/reuse-merged-pr.mjs';
import { createGitHubOctokit } from '../../github/octokit.mjs';
import { paginateActionsInventory } from '../../github/paginate-actions.mjs';

const shaPattern = /^[a-f0-9]{40}$/u;
const digestPattern = /^[a-f0-9]{64}$/u;
const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;

export async function readFrontendPromotionProofArtifact(artifact, filename, repository, token, fetchImpl = fetch) {
  const archive = await downloadArtifact(artifact, repository, token, fetchImpl);
  return JSON.parse(await extractJsonEntry(archive, filename));
}

function positiveInteger(value, label) {
  const number = Number(value);
  assert.ok(Number.isSafeInteger(number) && number > 0, `${label} is invalid`);
  return number;
}

function assertOptionalFrontendPRAssociation(run,expected){
  const associations=Array.isArray(run.pull_requests)?run.pull_requests:[];
  if(associations.length===0)return;
  assert.equal(associations.length,1,'Frontend producer PR association is ambiguous');
  const pr=associations[0];
  assert.equal(pr?.number,expected.prNumber,'Frontend producer PR association number mismatch');
  assert.equal(pr?.head?.sha,expected.sourceSha,'Frontend producer PR association head mismatch');
  assert.equal(pr?.head?.ref,expected.headBranch,'Frontend producer PR association branch mismatch');
  assert.equal(pr?.head?.repo?.id,expected.repositoryId,'Frontend producer PR association repository mismatch');
  assert.equal(pr?.base?.ref,'main','Frontend producer PR association base branch mismatch');
  assert.equal(pr?.base?.repo?.id,expected.repositoryId,'Frontend producer PR association base repository mismatch');
}

/**
 * Confirms the current workflow run and uploaded artifact are the exact producer
 * selected by the build job output, including partial and full reruns.
 * @param {unknown} run
 * @param {unknown} artifact
 * @param {unknown[]} jobs
 * @param {unknown[]} producerAttemptJobs
 * @param {{runId:string|number,currentAttempt:string|number,producerAttempt:string|number,sourceSha:string,artifactId:string|number,artifactName:string,artifactDigest:string,event?:string,workflowSha?:string}} expected
 */
export function assertFrontendArtifactEvidence(run, artifact, jobs, expected, producerAttemptJobs = jobs) {
  assert.ok(run && typeof run === 'object' && !Array.isArray(run), 'Frontend producer workflow run metadata is invalid');
  assert.ok(artifact && typeof artifact === 'object' && !Array.isArray(artifact), 'Frontend artifact metadata is invalid');
  assert.match(expected.sourceSha, shaPattern, 'Frontend source SHA is invalid');
  assert.match(expected.artifactDigest, digestPattern, 'Frontend artifact digest is invalid');
  const runId = String(positiveInteger(expected.runId, 'Frontend producer run ID'));
  const currentAttempt = positiveInteger(expected.currentAttempt, 'Frontend workflow run attempt');
  const producerAttempt = positiveInteger(expected.producerAttempt, 'Frontend producer job attempt');
  const artifactId = positiveInteger(expected.artifactId, 'Frontend artifact ID');
  const workflowSha = expected.event === 'workflow_run' ? expected.workflowSha : expected.sourceSha;
  assert.match(workflowSha ?? '', shaPattern, 'Frontend producer workflow SHA is invalid');

  assert.equal(String(run.id), runId, 'Frontend producer run ID mismatch');
  assert.ok(producerAttempt <= currentAttempt, 'Frontend producer attempt is newer than the workflow attempt');
  assert.equal(run.run_attempt, currentAttempt, 'Frontend workflow run attempt mismatch');
  assert.equal(run.event, expected.event || 'push', 'Frontend producer event mismatch');
  assert.equal(run.head_branch, 'main', 'Frontend producer branch must be main');
  assert.equal(run.head_sha, workflowSha, 'Frontend producer workflow SHA mismatch');

  assert.equal(expected.artifactName, `codexia-frontend-${expected.sourceSha}-attempt-${producerAttempt}`, 'Frontend artifact name does not bind the producer attempt');
  const selected = selectLatestJobArtifact(expected.artifactName, 'Build and verify UI assets', [artifact], jobs, {
    runId,
    sourceSha: workflowSha,
  });
  assert.equal(selected.id, artifactId, 'Frontend artifact ID does not match the build job output');
  const producerJobs = producerAttemptJobs.filter(job => job && typeof job === 'object' && job.name === 'Build and verify UI assets');
  assert.equal(producerJobs.length, 1, 'Expected exactly one latest frontend artifact producer job');
  assert.equal(producerJobs[0].run_attempt, producerAttempt, 'Frontend artifact producer attempt mismatch');
  assert.equal(selectLatestJobArtifact(expected.artifactName, 'Build and verify UI assets', [artifact], producerAttemptJobs, {runId, sourceSha: workflowSha}).id, artifactId, 'Frontend artifact does not belong to the declared producer attempt');
  assert.equal(artifact.digest, `sha256:${expected.artifactDigest}`, 'Frontend artifact digest mismatch');
}

/**
 * Accepts only the exact frontend workflow artifact produced by the merged PR's
 * latest successful, pre-merge UI build. `proof` must be the receipt returned by
 * verifyReusableMainProof; its full-plan check is deliberately repeated by the
 * protected consumer before it trusts this artifact.
 * @param {unknown} run
 * @param {unknown[]} jobs
 * @param {unknown[]} artifacts
 * @param {Record<string, unknown>} proof
 * @param {{repositoryId:number,workflowId:number,sourceSha:string,mainSha:string,mainTree:string,baseSha:string,headBranch:string,prNumber:number,mergedAt:string,artifactName?:string}} expected
 */
export function assertFrontendPromotionArtifactEvidence(run, jobs, artifacts, proof, expected) {
  assert.ok(run && typeof run === 'object' && !Array.isArray(run), 'Frontend promotion run metadata is invalid');
  assert.match(expected.sourceSha, shaPattern, 'Frontend producer source SHA is invalid');
  assert.match(expected.mainSha, shaPattern, 'Frontend main source SHA is invalid');
  assert.match(expected.mainTree, shaPattern, 'Frontend main tree is invalid');
  assert.match(expected.baseSha, shaPattern, 'Frontend merge base is invalid');
  assert.ok(Number.isSafeInteger(expected.repositoryId) && expected.repositoryId > 0, 'Frontend repository identity is invalid');
  assert.ok(Number.isSafeInteger(expected.workflowId) && expected.workflowId > 0, 'Frontend producer workflow identity is invalid');
  assert.ok(Number.isSafeInteger(expected.prNumber) && expected.prNumber > 0, 'Frontend merged PR number is invalid');
  assert.equal(proof?.sourceSha, expected.mainSha, 'Frontend promotion proof main source mismatch');
  assert.equal(proof?.tree, expected.mainTree, 'Frontend promotion proof tree mismatch');
  assert.equal(proof?.baseSha, expected.baseSha, 'Frontend promotion proof base mismatch');
  assert.equal(proof?.headSha, expected.sourceSha, 'Frontend promotion proof PR source mismatch');
  assert.equal(proof?.headRef, expected.headBranch, 'Frontend promotion proof PR branch mismatch');
  assert.equal(proof?.prNumber, expected.prNumber, 'Frontend promotion proof PR association mismatch');
  assert.equal(proof?.mode, 'full', 'Frontend promotion requires a full-plan PR proof');
  assert.ok(Number.isSafeInteger(proof?.runId) && proof.runId > 0, 'Frontend PR verification run identity is invalid');
  assert.ok(Number.isSafeInteger(proof?.attempt) && proof.attempt > 0, 'Frontend PR verification attempt is invalid');
  assert.match(proof?.planDigest ?? '', digestPattern, 'Frontend PR plan digest is invalid');

  const runId = positiveInteger(run.id, 'Frontend producer run ID');
  const runAttempt = positiveInteger(run.run_attempt, 'Frontend producer run attempt');
  assert.equal(run.workflow_id, expected.workflowId, 'Unexpected frontend producer workflow');
  assert.equal(run.path, '.github/workflows/frontend-release.yml', 'Unexpected frontend producer workflow path');
  assert.equal(run.event, 'pull_request', 'Frontend promotion producer must be a PR run');
  assert.equal(run.status, 'completed', 'Frontend producer workflow is unfinished');
  assert.equal(run.conclusion, 'success', 'Frontend producer workflow did not succeed');
  assert.equal(run.head_sha, expected.sourceSha, 'Frontend producer source mismatch');
  assert.equal(run.head_branch, expected.headBranch, 'Frontend producer branch does not match the merged PR head');
  assert.equal(run.repository?.id, expected.repositoryId, 'Frontend producer repository mismatch');
  assert.equal(run.head_repository?.id, expected.repositoryId, 'Foreign frontend producer repository');
  assertOptionalFrontendPRAssociation(run,expected);
  const mergedAt = Date.parse(expected.mergedAt);
  const completedAt = Date.parse(run.updated_at);
  assert.ok(Number.isFinite(mergedAt) && Number.isFinite(completedAt) && completedAt <= mergedAt,
    'Frontend producer workflow did not finish before merge');

  assert.ok(Array.isArray(jobs), 'Invalid frontend producer jobs');
  const jobName = 'Build and verify UI assets';
  const producerJobs = jobs.filter(job => job && typeof job === 'object' && job.name === jobName);
  assert.equal(producerJobs.length, 1, 'Expected exactly one latest frontend UI producer job');
  const job = producerJobs[0];
  assert.equal(job.head_sha, expected.sourceSha, 'Frontend UI producer source mismatch');
  assert.equal(String(job.run_id), String(runId), 'Frontend UI producer run mismatch');
  assert.equal(job.run_attempt, runAttempt, 'Frontend UI producer must be from the current run attempt');
  assert.equal(job.status, 'completed', 'Frontend UI producer is unfinished');
  assert.equal(job.conclusion, 'success', 'Frontend UI producer did not succeed');
  const jobStarted = Date.parse(job.started_at), jobCompleted = Date.parse(job.completed_at);
  assert.ok(Number.isFinite(jobStarted) && Number.isFinite(jobCompleted) && jobStarted <= jobCompleted && jobCompleted <= mergedAt,
    'Frontend UI producer did not finish before merge');

  const artifactName = `codexia-frontend-pr-${expected.prNumber}-${runId}-${expected.sourceSha}-attempt-${runAttempt}`;
  assert.equal(expected.artifactName, artifactName, 'Frontend PR artifact name does not bind its run, source and attempt');
  const artifact = selectLatestJobArtifact(artifactName, jobName, artifacts, jobs, {runId, sourceSha:expected.sourceSha});
  assert.equal(artifact.workflow_run?.head_branch, run.head_branch, 'Frontend artifact branch mismatch');
  assert.match(artifact.digest ?? '', /^sha256:[a-f0-9]{64}$/u, 'Frontend artifact digest is invalid');
  assert.ok(Number.isSafeInteger(artifact.size_in_bytes) && artifact.size_in_bytes > 0 && artifact.size_in_bytes <= MAX_ASSET_ARCHIVE,
    'Frontend artifact exceeds the bounded archive size');
  return artifact;
}

/** Older or equal PR artifact SemVer falls back to the exact main source build. */
export function shouldPromoteFrontendArtifact(candidate, deployed) {
  assertFrontendIdentity(candidate);
  assertFrontendIdentity(deployed);
  return compareComponentVersions(candidate.version, deployed.version) > 0;
}

/** Select the newest matching UI workflow run; a newer failed attempt cannot
 * be replaced by an older green producer for the same PR head. */
export function selectFrontendProducerRun(runs, expected) {
  assert.ok(Array.isArray(runs), 'Invalid frontend producer run inventory');
  assert.ok(Number.isSafeInteger(expected.repositoryId) && expected.repositoryId > 0, 'Frontend repository identity is invalid');
  assert.ok(Number.isSafeInteger(expected.workflowId) && expected.workflowId > 0, 'Frontend workflow identity is invalid');
  assert.match(expected.sourceSha, shaPattern, 'Frontend producer source SHA is invalid');
  const matches = runs.filter(run => run && typeof run === 'object' && !Array.isArray(run) &&
    run.workflow_id === expected.workflowId && run.path === '.github/workflows/frontend-release.yml' &&
    run.event === 'pull_request' && run.head_sha === expected.sourceSha &&
    run.repository?.id === expected.repositoryId && run.head_repository?.id === expected.repositoryId);
  assert.ok(matches.length > 0, 'No exact frontend producer run');
  const ids = new Set(), numbers = new Set();
  for (const run of matches) {
    assert.ok(Number.isSafeInteger(run.id) && run.id > 0 && Number.isSafeInteger(run.run_number) && run.run_number > 0,
      'Invalid frontend producer run identity');
    assert.ok(!ids.has(run.id) && !numbers.has(run.run_number), 'Ambiguous frontend producer run inventory');
    ids.add(run.id); numbers.add(run.run_number);
  }
  const selected = [...matches].sort((left, right) => right.run_number - left.run_number)[0];
  assert.equal(selected.status, 'completed', 'Latest frontend producer run is unfinished');
  assert.equal(selected.conclusion, 'success', 'Latest frontend producer run did not succeed');
  assert.ok(Number.isSafeInteger(selected.run_attempt) && selected.run_attempt > 0, 'Latest frontend producer attempt is invalid');
  if (expected.prNumber !== undefined) assertOptionalFrontendPRAssociation(selected,expected);
  return selected;
}

/** One bounded, non-polling lookup for a completed exact-SHA main Verify run. */
export function selectExactMainVerifyRun(runs, expected) {
  assert.ok(Array.isArray(runs), 'Invalid main Verify run inventory');
  assert.match(expected.sourceSha,shaPattern,'Main Verify source SHA is invalid');
  assert.ok(Number.isSafeInteger(expected.repositoryId)&&expected.repositoryId>0&&Number.isSafeInteger(expected.ownerId)&&expected.ownerId>0,
    'Main Verify repository identity is invalid');
  const matches=runs.filter(run=>run&&typeof run==='object'&&!Array.isArray(run)&&run.path==='.github/workflows/verify.yml'&&
    run.event==='push'&&run.head_branch==='main'&&run.head_sha===expected.sourceSha&&matchesRunRepository(run,expected));
  assert.ok(matches.length>0,'No exact-source main Verify run is available yet');
  const ids=new Set(),numbers=new Set();
  for(const run of matches){
    assert.ok(Number.isSafeInteger(run.id)&&run.id>0&&Number.isSafeInteger(run.run_number)&&run.run_number>0,'Invalid main Verify run identity');
    assert.ok(!ids.has(run.id)&&!numbers.has(run.run_number),'Ambiguous main Verify run inventory');
    ids.add(run.id);numbers.add(run.run_number);
  }
  const selected=[...matches].sort((a,b)=>b.run_number-a.run_number)[0];
  if(selected.status==='completed') assert.equal(selected.conclusion,'success','Latest exact-source main Verify run did not succeed');
  else {
    assert.ok(['queued','in_progress','requested','waiting','pending'].includes(selected.status),'Latest exact-source main Verify run is in a terminal state');
    assert.equal(selected.conclusion,null,'Incomplete exact-source main Verify run has a conclusion');
  }
  return selected;
}

function createFrontendApi(context, token, fetchImpl) {
  const { owner, repo } = context;
  const octokit = createGitHubOctokit({ ...context, token, fetchImpl });
  const request = async endpoint => {
    const commit = /^commits\/([a-f0-9]{40})$/u.exec(endpoint);
    const run = /^actions\/runs\/([1-9]\d*)$/u.exec(endpoint);
    const artifact = /^actions\/artifacts\/([1-9]\d*)$/u.exec(endpoint);
    const workflow = /^actions\/workflows\/(verify\.yml|frontend-release\.yml)$/u.exec(endpoint);
    if (commit) return (await octokit.rest.repos.getCommit({ owner, repo, ref: commit[1] })).data;
    if (run) return (await octokit.rest.actions.getWorkflowRun({ owner, repo, run_id: Number(run[1]) })).data;
    if (artifact) return (await octokit.rest.actions.getArtifact({ owner, repo, artifact_id: Number(artifact[1]) })).data;
    if (workflow) return (await octokit.rest.actions.getWorkflow({ owner, repo, workflow_id: workflow[1] })).data;
    throw new Error('Unapproved frontend artifact provenance endpoint');
  };
  request.paginate = (endpoint, parameters = {}, key) => {
    const workflowRuns = /^actions\/workflows\/(verify\.yml|frontend-release\.yml|[1-9]\d*)\/runs$/u.exec(endpoint);
    const jobs = /^actions\/runs\/([1-9]\d*)\/jobs$/u.exec(endpoint);
    const artifacts = /^actions\/runs\/([1-9]\d*)\/artifacts$/u.exec(endpoint);
    const attemptJobs = /^actions\/runs\/([1-9]\d*)\/attempts\/([1-9]\d*)\/jobs$/u.exec(endpoint);
    if (workflowRuns) return paginateActionsInventory(octokit, octokit.rest.actions.listWorkflowRuns,
      { owner, repo, workflow_id: workflowRuns[1], ...parameters }, key);
    if (jobs) return paginateActionsInventory(octokit, octokit.rest.actions.listJobsForWorkflowRun,
      { owner, repo, run_id: Number(jobs[1]), ...parameters }, key);
    if (artifacts) return paginateActionsInventory(octokit, octokit.rest.actions.listWorkflowRunArtifacts,
      { owner, repo, run_id: Number(artifacts[1]), ...parameters }, key);
    if (attemptJobs) return paginateActionsInventory(octokit, octokit.rest.actions.listJobsForWorkflowRunAttempt,
      { owner, repo, run_id: Number(attemptJobs[1]), attempt_number: Number(attemptJobs[2]), ...parameters }, key);
    throw new Error('Unapproved frontend artifact pagination endpoint');
  };
  return request;
}

const apiPages = (request, endpoint, key, parameters = {}) => request.paginate(endpoint, parameters, key);

/** Re-run the canonical merged-tree/full-plan resolver from the exact current main Verify run. */
export async function verifyFrontendMainPromotionProof({env=process.env,fetchImpl=fetch}={}) {
  const context = actionsRepository(env);
  assert.ok(['push','workflow_run'].includes(env.GITHUB_EVENT_NAME), 'Frontend promotion requires verified main source');
  assert.equal(env.GITHUB_REF, 'refs/heads/main', 'Frontend promotion requires main');
  const sourceSha = env.CODEXIA_SOURCE_SHA || env.GITHUB_SHA;
  assert.match(sourceSha ?? '', shaPattern, 'Frontend main source SHA is invalid');
  assert.equal(execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),sourceSha,'Frontend promotion checkout source mismatch');
  const configuredRunId=env.CODEXIA_VERIFY_RUN_ID;
  const token=env.GH_TOKEN;assert.ok(typeof token==='string'&&token.length>0,'GitHub Actions read token required for frontend promotion');
  const request=createFrontendApi(context,token,fetchImpl);
  const payload=JSON.parse(await readFile(env.GITHUB_EVENT_PATH,'utf8'));
  let before;
  if(env.GITHUB_EVENT_NAME==='push'){
    assert.equal(payload.ref,'refs/heads/main');
    assert.equal(payload.after,sourceSha);
    assert.equal(payload.forced,false);
    assert.equal(payload.deleted,false);
    before=payload.before;
  }else{
    const eventRun=payload.workflow_run;
    assert.equal(eventRun?.id,Number(configuredRunId),'Frontend promotion verification event mismatch');
    assert.equal(eventRun?.path,'.github/workflows/verify.yml','Unexpected frontend promotion workflow');
    assert.equal(eventRun?.event,'push','Frontend promotion requires a main Verify push');
    assert.equal(eventRun?.head_branch,'main','Frontend promotion requires main');
    assert.equal(eventRun?.head_sha,sourceSha,'Frontend promotion event source mismatch');
    assert.equal(eventRun?.status,'completed');
    assert.equal(eventRun?.conclusion,'success');
    assert.ok(matchesRunRepository(eventRun,context), 'Frontend promotion event repository mismatch');
    const commit=await request('commits/'+sourceSha);
    assert.equal(commit.sha,sourceSha,'Frontend promotion main commit mismatch');
    assert.ok(Array.isArray(commit.parents)&&commit.parents.length>0,'Main commit has no first parent');
    before=commit.parents[0].sha;
  }
  assert.match(before??'',shaPattern,'Main push first parent is invalid');
  let currentRun;
  const protectedConsumer=Boolean(configuredRunId);
  if(configuredRunId){
    const verifyRunId=positiveInteger(configuredRunId,'Exact main Verify run ID');
    currentRun=await request('actions/runs/'+verifyRunId);
    assert.equal(String(currentRun.id),String(verifyRunId));
  }else{
    const runInventory=await apiPages(request,'actions/workflows/verify.yml/runs','workflow_runs',{head_sha:sourceSha,event:'push'});
    currentRun=selectExactMainVerifyRun(runInventory,{...context,sourceSha});
  }
  const verifyRunId=positiveInteger(currentRun.id,'Exact main Verify run ID');
  if(protectedConsumer) verifiedSourceRun([currentRun],sourceSha);
  else {
    assert.equal(currentRun.path,'.github/workflows/verify.yml','Exact source proof is not from Verify');
    assert.equal(currentRun.head_branch,'main','Exact source proof branch is not main');
    assert.equal(currentRun.head_sha,sourceSha,'Exact source proof SHA mismatch');
    assert.equal(currentRun.event,'push','Exact source proof event mismatch');
    if(currentRun.status==='completed') assert.equal(currentRun.conclusion,'success','Latest exact-source main Verify run did not succeed');
    else assert.equal(currentRun.conclusion,null,'Incomplete exact-source main Verify run has a conclusion');
  }
  assert.equal(currentRun.path,'.github/workflows/verify.yml','Exact source proof is not from Verify');
  assert.ok(matchesRunRepository(currentRun, context), 'Exact source proof repository mismatch');
  if(protectedConsumer){
    const jobs=await apiPages(request,'actions/runs/'+verifyRunId+'/jobs','jobs',{filter:'latest'});
    assertVerificationRunJobs(jobs, currentRun);
  }
  const proof=await verifyReusableMainProof({sourceSha:sourceSha,before,repository:env.GITHUB_REPOSITORY,currentRun,request,
    git:args=>execFileSync('git',args,{encoding:'utf8',maxBuffer:16*1024*1024,timeout:15000}),
    readArtifact:(artifact,filename)=>readFrontendPromotionProofArtifact(artifact,filename,context.repository,token,fetchImpl)});
  return {...proof,sourceVerifyRunId:verifyRunId};
}

async function selectMergedFrontendArtifact({proof,env,fetchImpl}) {
  const context=actionsRepository(env);
  const request=createFrontendApi(context,env.GH_TOKEN,fetchImpl);
  const workflow=await request('actions/workflows/frontend-release.yml');
  assert.equal(workflow.path,'.github/workflows/frontend-release.yml','Frontend producer workflow path mismatch');
  assert.ok(Number.isSafeInteger(workflow.id)&&workflow.id>0,'Frontend producer workflow ID is invalid');
  const { repositoryId }=context;
  const runs=await apiPages(request,'actions/workflows/'+workflow.id+'/runs','workflow_runs',{head_sha:proof.headSha,event:'pull_request'});
  const producerRun=selectFrontendProducerRun(runs,{repositoryId,workflowId:workflow.id,sourceSha:proof.headSha,prNumber:proof.prNumber});
  assert.ok(matchesRunRepository(producerRun, context), 'Frontend PR producer repository mismatch');
  const [producerJobs,artifacts]=await Promise.all([
    apiPages(request,'actions/runs/'+producerRun.id+'/attempts/'+producerRun.run_attempt+'/jobs','jobs'),
    apiPages(request,'actions/runs/'+producerRun.id+'/artifacts','artifacts'),
  ]);
  const artifactName='codexia-frontend-pr-'+proof.prNumber+'-'+producerRun.id+'-'+proof.headSha+'-attempt-'+producerRun.run_attempt;
  const artifact=assertFrontendPromotionArtifactEvidence(producerRun,producerJobs,artifacts,proof,{repositoryId,workflowId:workflow.id,
    sourceSha:proof.headSha,mainSha:env.CODEXIA_SOURCE_SHA || env.GITHUB_SHA,mainTree:proof.tree,baseSha:proof.baseSha,headBranch:proof.headRef,prNumber:proof.prNumber,
    mergedAt:proof.mergedAt,artifactName});
  assertArtifactRunRepository(artifact, producerRun);
  return {workflow,producerRun,producerJobs,artifactName,artifact};
}

/** Select, digest-check and validate a PR frontend artifact. No downloaded file is executed. */
export async function resolveFrontendPromotion({env=process.env,fetchImpl=fetch}={}) {
  let output={promoted:false};
  let scratch;
  try {
    const proof=await verifyFrontendMainPromotionProof({env,fetchImpl});
    const {workflow,producerRun,artifact}=await selectMergedFrontendArtifact({proof,env,fetchImpl});
    const archive=await downloadArtifact(artifact,actionsRepository(env).repository,env.GH_TOKEN,fetchImpl,{maxArchive:MAX_ASSET_ARCHIVE});
    scratch=await mkdtemp(path.join(env.RUNNER_TEMP||tmpdir(),'codexia-frontend-promotion-'));
    const files=await extractArtifactFiles(archive,scratch,{maxArchive:MAX_ASSET_ARCHIVE,maxUncompressed:MAX_ASSET_BYTES});
    for(const required of ['index.html','desktop/index.html','desktop/update-identity.json']) assert.ok(files.includes(required),'Promoted frontend artifact is missing '+required);
    assert.ok(!files.some(file=>file.startsWith('mobile/')),'Retired Mobile Web output in promoted frontend artifact');
    const identity=assertFrontendIdentity(JSON.parse(await readFile(path.join(scratch,'desktop/update-identity.json'),'utf8')));
    assertFrontendOAuthConfigIdentity(identity,env);
    const apiEpoch=JSON.parse(readFileSync(new URL('../../../deploy/frontend-compatibility.json',import.meta.url),'utf8')).apiEpoch;
    assert.equal(identity.sourceSha,proof.headSha,'Promoted frontend artifact source mismatch');
    assert.equal(identity.version,readComponentVersion('frontend',String(producerRun.run_number)),'Promoted frontend artifact version mismatch');
    assert.equal(identity.profile,'full','Promoted frontend artifact must contain the Full profile');
    assert.equal(identity.apiEpoch,apiEpoch,'Promoted frontend artifact API epoch mismatch');
    const deployed={format:'codexia-frontend-identity/v1',version:env.CODEXIA_LIVE_FRONTEND_VERSION,
      sourceSha:env.CODEXIA_LIVE_FRONTEND_SOURCE_SHA,profile:env.CODEXIA_LIVE_FRONTEND_PROFILE,apiEpoch:Number(env.CODEXIA_LIVE_FRONTEND_API_EPOCH)};
    assertFrontendIdentity(deployed);
    if(!shouldPromoteFrontendArtifact(identity,deployed)) return fallback('PR artifact SemVer is older than or equal to the deployed frontend');
    output.promoted=true;
    output.artifactId=String(artifact.id);
    output.artifactDigest=artifact.digest.slice('sha256:'.length);
    output.artifactName=artifact.name;
    output.producerRunId=String(producerRun.id);
    output.producerAttempt=String(producerRun.run_attempt);
    output.producerSha=proof.headSha;
    output.producerVersion=identity.version;
    output.producerPrNumber=String(proof.prNumber);
    output.producerWorkflowId=String(workflow.id);
    output.producerVerifyRunId=String(proof.sourceVerifyRunId);
    output.producerProofRunId=String(proof.runId);
    output.producerTree=proof.tree;
    output.producerBaseSha=proof.baseSha;
    output.producerPlanDigest=proof.planDigest;
    output.producerVerifyAttempt=String(proof.attempt);
    output.reason='Promoted tested frontend bytes from full-plan PR #'+proof.prNumber;
    if(env.GITHUB_STEP_SUMMARY) await appendFile(env.GITHUB_STEP_SUMMARY,output.reason+'; producer source '+proof.headSha+', version '+identity.version+', artifact '+artifact.id+'.\n');
    await writePromotionOutputs(env.GITHUB_OUTPUT,output);
    return output;
  } catch(error) {
    return fallback(error instanceof Error?error.message:'Frontend promotion proof unavailable');
  } finally {
    if(scratch) await rm(scratch,{recursive:true,force:true});
  }

  function fallback(reason){
    output={promoted:false,reason:'Using exact main-source frontend build: '+String(reason).replace(/[\r\n]/gu,' ').slice(0,300)};
    return writePromotionOutputs(env.GITHUB_OUTPUT,output).then(()=>{
      if(env.GITHUB_STEP_SUMMARY) return appendFile(env.GITHUB_STEP_SUMMARY,output.reason+'\n').then(()=>output);
      return output;
    });
  }
}

async function verifyPromotedFrontendArtifact(expected,{env,fetchImpl}){
  assert.equal(env.CODEXIA_FRONTEND_PRODUCER_EVENT,'pull_request','Promoted frontend producer event mismatch');
  const proof=await verifyFrontendMainPromotionProof({env,fetchImpl});
  assert.equal(String(proof.prNumber),String(expected.prNumber),'Promoted frontend PR number changed');
  assert.equal(proof.headSha,expected.sourceSha,'Promoted frontend PR source changed');
  assert.equal(proof.tree,expected.tree,'Promoted frontend source tree changed');
  assert.equal(proof.baseSha,expected.baseSha,'Promoted frontend merge base changed');
  assert.equal(proof.planDigest,expected.planDigest,'Promoted frontend full-plan proof changed');
  assert.equal(String(proof.runId),String(expected.proofRunId),'Promoted frontend PR verification run changed');
  assert.equal(String(proof.attempt),String(expected.verifyAttempt),'Promoted frontend PR verification attempt changed');
  const selected=await selectMergedFrontendArtifact({proof,env,fetchImpl});
  assert.equal(String(selected.workflow.id),String(expected.workflowId),'Promoted frontend workflow changed');
  assert.equal(String(selected.producerRun.id),String(expected.runId),'Promoted frontend producer run changed');
  assert.equal(String(selected.producerRun.run_attempt),String(expected.producerAttempt),'Promoted frontend producer attempt changed');
  assert.equal(expected.version,readComponentVersion('frontend',String(selected.producerRun.run_number)),'Promoted frontend producer version changed');
  assert.equal(selected.artifact.name,expected.artifactName,'Promoted frontend artifact name changed');
  assert.equal(String(selected.artifact.id),String(expected.artifactId),'Promoted frontend artifact ID changed');
  assert.equal(selected.artifact.digest,'sha256:'+expected.artifactDigest,'Promoted frontend artifact digest changed');
  return selected.artifact;
}

async function writePromotionOutputs(file,output){
  assert.ok(typeof file==='string'&&file.length>0,'GitHub output path is required');
  const entries=[['promoted',String(output.promoted)]];
  for(const key of ['artifactId','artifactDigest','artifactName','producerRunId','producerAttempt','producerSha','producerVersion',
    'producerPrNumber','producerWorkflowId','producerVerifyRunId','producerProofRunId','producerTree','producerBaseSha','producerPlanDigest','producerVerifyAttempt','reason']){
    if(output[key]!==undefined) entries.push([key,output[key]]);
  }
  await appendFile(file,entries.map(([key,value])=>key+'='+String(value).replace(/[\r\n]/gu,' ')+'\n').join(''));
  return output;
}

/** Read the independently built main archive when ordinary deployment is paused. */
export async function verifyLifecycleFrontendArtifact(input, { env = process.env, fetchImpl = fetch, expectedEpoch, readPublicAssets = false } = {}) {
  assert.ok(Number.isSafeInteger(expectedEpoch) && expectedEpoch > 0, 'Expected frontend API epoch is invalid');
  const context=actionsRepository(env);
  assert.equal(env.GITHUB_REF, 'refs/heads/main', 'Lifecycle frontend verification requires main');
  assert.ok(readFrontendOAuthConfig(env), 'Lifecycle requires the approved public frontend OAuth configuration');
  const id = positiveInteger(input.artifactId, 'Frontend artifact ID');
  const runId = positiveInteger(input.runId, 'Frontend producer run ID');
  const verifyRunId = positiveInteger(input.verifyRunId, 'Frontend Verify run ID');
  const token = env.GH_TOKEN;
  assert.ok(token, 'Actions read token is required');
  const request = createFrontendApi(context,token,fetchImpl);
  const [run, artifact, verifyRun, jobs, verifyJobs] = await Promise.all([
    request('actions/runs/' + runId),
    request('actions/artifacts/' + id),
    request('actions/runs/' + verifyRunId),
    apiPages(request, 'actions/runs/' + runId + '/jobs', 'jobs', { filter: 'latest' }),
    apiPages(request, 'actions/runs/' + verifyRunId + '/jobs', 'jobs', { filter: 'latest' }),
  ]);
  assert.equal(run.path, '.github/workflows/frontend-release.yml', 'Unexpected frontend producer workflow');
  assert.ok(matchesRunRepository(run, context), 'Frontend producer repository mismatch');
  assert.equal(run.status, 'completed', 'Frontend producer has not completed');
  assert.equal(verifyRun.path, '.github/workflows/verify.yml', 'Unexpected Verify workflow');
  assert.ok(matchesRunRepository(verifyRun, context), 'Frontend Verify repository mismatch');
  assert.equal(verifyRun.id, verifyRunId, 'Frontend Verify run ID mismatch');
  const workflowSha = run.head_sha;
  assert.match(workflowSha ?? '', shaPattern, 'Frontend producer workflow SHA is invalid');
  const sourceMatch = /^codexia-frontend-([a-f0-9]{40})-attempt-([1-9][0-9]*)$/u.exec(artifact.name ?? '');
  assert.ok(sourceMatch, 'Frontend archive has no certified component source');
  const sourceSha = sourceMatch[1];
  verifiedSourceRun([verifyRun], sourceSha);
  assertVerificationRunJobs(verifyJobs, verifyRun);
  execFileSync('git', ['merge-base', '--is-ancestor', sourceSha, workflowSha], { stdio: 'ignore' });
  execFileSync('git', ['merge-base', '--is-ancestor', workflowSha, 'HEAD'], { stdio: 'ignore' });
  const producerJobs = jobs.filter(job => job?.name === 'Build and verify UI assets');
  assert.equal(producerJobs.length, 1, 'Frontend producer job is ambiguous');
  const attempt = positiveInteger(producerJobs[0].run_attempt, 'Frontend producer attempt');
  const producerAttemptJobs = await apiPages(request, 'actions/runs/' + runId + '/attempts/' + attempt + '/jobs', 'jobs');
  assert.equal(artifact.expired, false, 'Frontend archive is expired');
  assert.equal(artifact.workflow_run?.id, runId, 'Frontend archive belongs to another run');
  assert.equal(artifact.workflow_run?.head_sha, workflowSha, 'Frontend archive belongs to another workflow');
  assertFrontendArtifactEvidence(run, artifact, jobs, {
    sourceSha, workflowSha, artifactId: id, runId, producerAttempt: attempt,
    currentAttempt: run.run_attempt, event: 'workflow_run', artifactDigest: input.artifactDigest,
    artifactName: 'codexia-frontend-' + sourceSha + '-attempt-' + attempt,
  }, producerAttemptJobs);
  assertArtifactRunRepository(artifact, run);
  const bytes = await downloadArtifact(artifact, context.repository, token, fetchImpl, { maxArchive: MAX_ASSET_ARCHIVE });
  const destination = fileURLToPath(new URL('../../../app/dist/', import.meta.url));
  const assets = readPublicAssets ? await readArtifactFiles(bytes) : undefined;
  const files = assets ? [...assets.keys()] : await extractArtifactFiles(bytes, destination, {
    maxArchive: MAX_ASSET_ARCHIVE, maxUncompressed: MAX_ASSET_BYTES,
  });
  assert.ok(!files.some(file => file.startsWith('mobile/')), 'Retired Mobile Web output in lifecycle artifact');
  const identityPath = 'desktop/update-identity.json';
  assert.ok(files.includes(identityPath), 'Lifecycle frontend archive is missing its identity');
  const identityBytes = assets ? assets.get(identityPath) : readFileSync(path.join(destination, identityPath));
  const identity = assertFrontendIdentity(JSON.parse(identityBytes.toString('utf8')));
  assertFrontendOAuthConfigIdentity(identity, env);
  assert.equal(identity.version, readComponentVersion('frontend', String(run.run_number)), 'Frontend version differs from the producer');
  assert.equal(identity.sourceSha, sourceSha, 'Frontend archive source differs from the producer');
  assert.equal(identity.profile, 'full', 'Lifecycle requires a Full frontend');
  assert.equal(identity.apiEpoch, expectedEpoch, 'Lifecycle requires the selected frontend API epoch');
  return { identity, artifactId: id, artifactDigest: input.artifactDigest, runId, verifyRunId, producerAttempt: attempt,
    ...(assets && { assets }),
  };
}

/** @param {{env?:NodeJS.ProcessEnv,fetchImpl?:typeof fetch}} options */
export async function verifyFrontendArtifact({ env = process.env, fetchImpl = fetch } = {}) {
  const context=actionsRepository(env);
  assert.ok(['push','workflow_run'].includes(env.GITHUB_EVENT_NAME), 'Frontend artifact must come from a verified main release');
  assert.equal(env.GITHUB_REF, 'refs/heads/main', 'Frontend artifact must come from main');
  const sourceSha = env.CODEXIA_SOURCE_SHA || env.GITHUB_SHA;
  assert.match(sourceSha ?? '', shaPattern, 'Frontend artifact source SHA is invalid');
  assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), sourceSha, 'Frontend deploy checkout source mismatch');
  if(env.CODEXIA_FRONTEND_SOURCE_VERIFY_RUN_ID) assert.equal(String(env.CODEXIA_FRONTEND_SOURCE_VERIFY_RUN_ID),String(env.CODEXIA_VERIFY_RUN_ID),'Selected main Verify run differs from deploy certification');
  if(env.CODEXIA_FRONTEND_SOURCE_VERIFY_RUN_ID&&env.CODEXIA_FRONTEND_CERTIFIED_VERIFY_RUN_ID) assert.equal(String(env.CODEXIA_FRONTEND_SOURCE_VERIFY_RUN_ID),String(env.CODEXIA_FRONTEND_CERTIFIED_VERIFY_RUN_ID),'Promoted artifact used a different main Verify run than deployment certification');
  const token = env.GH_TOKEN;
  assert.ok(typeof token === 'string' && token.length > 0, 'GitHub Actions read token is required for frontend artifact provenance');

  const expected = {
    runId: positiveInteger(env.CODEXIA_FRONTEND_PRODUCER_RUN_ID, 'Frontend producer run ID'),
    producerAttempt: positiveInteger(env.CODEXIA_FRONTEND_PRODUCER_ATTEMPT, 'Frontend producer job attempt'),
    sourceSha: env.CODEXIA_FRONTEND_PRODUCER_SHA,
    artifactId: positiveInteger(env.CODEXIA_FRONTEND_ARTIFACT_ID, 'Frontend artifact ID'),
    artifactName: env.CODEXIA_FRONTEND_ARTIFACT_NAME,
    artifactDigest: env.CODEXIA_FRONTEND_ARTIFACT_DIGEST,
    version: env.CODEXIA_FRONTEND_PRODUCER_VERSION,
  };
  assert.match(expected.sourceSha ?? '',shaPattern,'Frontend producer source SHA is invalid');
  assert.ok(typeof expected.version==='string'&&semver.test(expected.version),'Frontend producer version is invalid');
  assert.match(expected.artifactDigest ?? '', digestPattern, 'Frontend artifact digest is invalid');

  let artifact;
  if(env.CODEXIA_FRONTEND_PRODUCER_EVENT==='pull_request'){
    artifact=await verifyPromotedFrontendArtifact({
      ...expected,prNumber:positiveInteger(env.CODEXIA_FRONTEND_PRODUCER_PR_NUMBER,'Frontend producer PR number'),
      workflowId:positiveInteger(env.CODEXIA_FRONTEND_PRODUCER_WORKFLOW_ID,'Frontend producer workflow ID'),
      proofRunId:positiveInteger(env.CODEXIA_FRONTEND_PR_VERIFY_RUN_ID,'Frontend PR Verify run ID'),
      verifyAttempt:positiveInteger(env.CODEXIA_FRONTEND_VERIFY_ATTEMPT,'Frontend Verify attempt'),
      tree:env.CODEXIA_FRONTEND_PRODUCER_TREE,baseSha:env.CODEXIA_FRONTEND_PRODUCER_BASE_SHA,
      planDigest:env.CODEXIA_FRONTEND_VERIFY_PLAN_DIGEST,
    },{env,fetchImpl});
  }else{
    assert.equal(env.CODEXIA_FRONTEND_PRODUCER_EVENT,env.GITHUB_EVENT_NAME,'Frontend artifact producer event mismatch');
    assert.equal(expected.runId,positiveInteger(env.GITHUB_RUN_ID,'Frontend release workflow run ID'),'Main frontend artifact must be built by the current release run');
    assert.equal(expected.sourceSha,sourceSha,'Main frontend artifact producer source mismatch');
    assert.equal(expected.artifactName,`codexia-frontend-${expected.sourceSha}-attempt-${expected.producerAttempt}`,'Frontend artifact name does not bind source and producer attempt');
    expected.event=env.GITHUB_EVENT_NAME;
    expected.workflowSha=env.GITHUB_SHA;
    const request=createFrontendApi(context,token,fetchImpl);
    const [run,selectedArtifact,jobs,producerAttemptJobs]=await Promise.all([
      request('actions/runs/'+expected.runId),request('actions/artifacts/'+expected.artifactId),
      apiPages(request,'actions/runs/'+expected.runId+'/jobs','jobs',{filter:'latest'}),
      apiPages(request,'actions/runs/'+expected.runId+'/attempts/'+expected.producerAttempt+'/jobs','jobs'),
    ]);
    assert.ok(matchesRunRepository(run, context), 'Frontend producer repository mismatch');
    assertArtifactRunRepository(selectedArtifact, run);
    expected.currentAttempt=positiveInteger(run.run_attempt,'Frontend producer workflow attempt');
    assert.equal(expected.currentAttempt,positiveInteger(env.GITHUB_RUN_ATTEMPT,'Current frontend release attempt'),'Frontend release attempt mismatch');
    assert.equal(expected.version,readComponentVersion('frontend',String(run.run_number)),'Main frontend producer version mismatch');
    assertFrontendArtifactEvidence(run,selectedArtifact,jobs,expected,producerAttemptJobs);
    artifact=selectedArtifact;
  }

  const artifactBytes = await downloadArtifact(artifact, context.repository, token, fetchImpl, {maxArchive:MAX_ASSET_ARCHIVE});
  const extracted = await extractArtifactFiles(artifactBytes, fileURLToPath(new URL('../../../app/dist/', import.meta.url)), {
    maxArchive:MAX_ASSET_ARCHIVE,
    maxUncompressed:MAX_ASSET_BYTES,
  });

  const identity = assertFrontendIdentity(JSON.parse(readFileSync(new URL('../../../app/dist/desktop/update-identity.json', import.meta.url), 'utf8')));
  assertFrontendOAuthConfigIdentity(identity,env);
  const apiEpoch = JSON.parse(readFileSync(new URL('../../../deploy/frontend-compatibility.json', import.meta.url), 'utf8')).apiEpoch;
  assert.equal(identity.version, expected.version, 'Frontend artifact version does not match its producer receipt');
  assert.equal(identity.sourceSha, expected.sourceSha, 'Frontend artifact source SHA mismatch');
  assert.equal(identity.profile, 'full', 'Frontend artifact must contain the Full profile');
  assert.equal(identity.apiEpoch, apiEpoch, 'Frontend artifact API epoch mismatch');
  return { artifactId: expected.artifactId, sourceSha: expected.sourceSha, version: identity.version,producerRunId:expected.runId };
}

async function main() {
  if(process.argv[2]==='select-promotion'){
    const result=await resolveFrontendPromotion();
    console.log(result.reason);
    return;
  }
  const artifact = await verifyFrontendArtifact();
  console.log(`Verified frontend artifact ${artifact.artifactId} from producer run ${artifact.producerRunId} attempt ${process.env.CODEXIA_FRONTEND_PRODUCER_ATTEMPT}, source ${artifact.sourceSha}, version ${artifact.version}.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : 'Frontend artifact provenance verification failed');
    process.exitCode = 1;
  });
}
