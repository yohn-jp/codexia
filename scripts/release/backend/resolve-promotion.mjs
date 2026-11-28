#!/usr/bin/env node
import { actionsRepository, assertArtifactRunRepository, matchesRunRepository, releaseRepositoryBinding } from '../../github/repository.mjs';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareComponentVersions, readComponentVersion } from '../components/version.mjs';
import { selectBackendArtifacts, assertBackendProducerAttempt } from '../../verification/artifacts/backend.mjs';
import { downloadArtifact, extractArtifactFiles } from '../../ci/evidence/download-artifacts.mjs';
import { verifyFrontendMainPromotionProof } from '../../verification/artifacts/frontend.mjs';
import { expectedBackendMigrationFingerprint, inspectBackendImageWithoutExecution as inspectDockerImage } from './image-inspection.mjs';
import { validateBackendIdentity } from './update-identity.mjs';
import { createGitHubOctokit } from '../../github/octokit.mjs';
import { paginateActionsInventory, paginateGitHubArray } from '../../github/paginate-actions.mjs';

const IMAGE_FILE = 'codexia-backend-image.tar.gz';
const IMAGE = 'codexia-backend-ci';
const RECORD = 'codexia-backend-promotion.json';
const MAX_IMAGE_BYTES = 512 * 1024 * 1024;

function positive(value, label) {
  const number = Number(value);
  assert.ok(Number.isSafeInteger(number) && number > 0, label + ' is invalid');
  return number;
}

export function backendPromotionReceiptIdentity(identity) {
  return { ...validateBackendIdentity(identity) };
}

export function selectBackendPromotionRun(runs, proof, repositoryId, workflowId) {
  assert.ok(Array.isArray(runs), 'Invalid backend PR producer run inventory');
  const matches = runs.filter(run => run && run.workflow_id === workflowId && run.path === '.github/workflows/backend-release.yml' &&
    run.event === 'pull_request' && run.head_sha === proof.headSha && run.head_branch === proof.headRef &&
    run.repository?.id === repositoryId && run.head_repository?.id === repositoryId);
  assert.ok(matches.length > 0, 'No same-repository backend PR producer run');
  const ids = new Set(), numbers = new Set();
  for (const run of matches) {
    positive(run.id, 'Backend PR producer run ID');
    positive(run.run_number, 'Backend PR producer run number');
    assert.ok(!ids.has(run.id) && !numbers.has(run.run_number), 'Ambiguous backend PR producer run inventory');
    ids.add(run.id); numbers.add(run.run_number);
  }
  const run = [...matches].sort((a, b) => b.run_number - a.run_number)[0];
  assert.equal(run.status, 'completed', 'Latest backend PR producer run is unfinished');
  assert.equal(run.conclusion, 'success', 'Latest backend PR producer run failed');
  positive(run.run_attempt, 'Backend PR producer attempt');
  const completed = Date.parse(run.updated_at), merged = Date.parse(proof.mergedAt);
  assert.ok(Number.isFinite(completed) && Number.isFinite(merged) && completed <= merged,
    'Backend PR producer did not finish before merge');
  return run;
}

export function assertBackendPromotionVersion(candidate, existing) {
  assert.match(candidate, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u, 'Backend producer version is invalid');
  if (existing !== null) {
    assert.match(existing, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u, 'Existing backend release version is invalid');
    assert.ok(compareComponentVersions(candidate, existing) > 0, 'Backend PR version is not strictly newer than published backend releases');
  }
  return true;
}

async function latestBackendReleaseVersion(github,{owner,repo}) {
  const releases = await paginateGitHubArray(github, github.rest.repos.listReleases,
    { owner, repo }, { maxItems: 9_999 });
  assert.ok(Array.isArray(releases) && releases.length <= 9_999, 'Invalid or over-limit backend release inventory');
  const versions = releases.filter(value => value &&
    typeof value.tag_name === 'string' && /^backend-v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u.test(value.tag_name))
    .map(value=>value.tag_name.slice('backend-v'.length));
  return versions.reduce((latest, value)=>latest===null||compareComponentVersions(value,latest)>0?value:latest,null);
}

async function assertBackendVersionTagFree(version,github,{owner,repo}){
  try {
    await github.rest.git.getRef({owner,repo,ref:`tags/backend-v${version}`});
  } catch(error) {
    if(error?.status===404)return;
    throw new Error('Backend release tag availability lookup failed'+(Number.isSafeInteger(error?.status)?` (HTTP ${error.status})`:''),{cause:error});
  }
  throw new Error('Backend producer version tag is already reserved');
}

export async function inspectBackendImageWithoutExecution(archivePath, profile, sourceSha, version, migrationFingerprint, compatibility, destination) {
  execFileSync('docker',['load','--input',archivePath],{stdio:'inherit'});
  return inspectDockerImage(IMAGE,{sourceSha,version,profile,migrationFingerprint,compatibility},{tempRoot:destination});
}

async function resolve({env=process.env,fetchImpl=fetch}={}) {
  const context=actionsRepository(env);
  const {owner,repo,repository,repositoryId}=context;
  assert.equal(env.GITHUB_EVENT_NAME,'workflow_run','Backend promotion requires completed Verify');
  assert.equal(env.GITHUB_REF,'refs/heads/main','Backend promotion requires main');
  assert.equal(execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),(env.CODEXIA_SOURCE_SHA || env.GITHUB_SHA),'Backend promotion checkout differs from verified main');
  const token=env.GH_TOKEN;
  assert.ok(typeof token==='string'&&token.length>0,'GitHub Actions read token required');
  const github=createGitHubOctokit({...context,token,fetchImpl,timeout:20_000});
  const proof=await verifyFrontendMainPromotionProof({env,fetchImpl});
  const workflow=(await github.rest.actions.getWorkflow({owner,repo,workflow_id:'backend-release.yml'})).data;
  assert.equal(workflow.path,'.github/workflows/backend-release.yml','Backend producer workflow path mismatch');
  const runs=await paginateActionsInventory(github,github.rest.actions.listWorkflowRuns,
    {owner,repo,workflow_id:workflow.id,head_sha:proof.headSha,event:'pull_request'},'workflow_runs');
  const run=selectBackendPromotionRun(runs,proof,repositoryId,positive(workflow.id,'Backend producer workflow ID'));
  assert.ok(matchesRunRepository(run, context), 'Backend PR producer repository mismatch');
  const [latestJobs,artifacts]=await Promise.all([
    paginateActionsInventory(github,github.rest.actions.listJobsForWorkflowRun,
      {owner,repo,run_id:run.id,filter:'latest'},'jobs'),
    paginateActionsInventory(github,github.rest.actions.listWorkflowRunArtifacts,
      {owner,repo,run_id:run.id},'artifacts'),
  ]);
  const selected=selectBackendArtifacts(run,artifacts,latestJobs,{runId:run.id,currentAttempt:run.run_attempt,sourceSha:proof.headSha,
    event:'pull_request',headBranch:proof.headRef});
  const producerAttempts=new Map(await Promise.all([...new Set(selected.map(item=>item.producerAttempt))].map(async attempt=>[
    attempt,await paginateActionsInventory(github,github.rest.actions.listJobsForWorkflowRunAttempt,
      {owner,repo,run_id:run.id,attempt_number:attempt},'jobs'),
  ])));
  for(const item of selected) assertBackendProducerAttempt(item,producerAttempts.get(item.producerAttempt),{runId:run.id,sourceSha:proof.headSha});
  const version=readComponentVersion('backend',String(run.run_number));
  const latest=await latestBackendReleaseVersion(github,context);
  assertBackendPromotionVersion(version,latest);
  await assertBackendVersionTagFree(version,github,context);
  const compatibility=JSON.parse(await readFile(new URL('../../../deploy/update-compatibility.json',import.meta.url),'utf8'));
  const migrationFingerprint=await expectedBackendMigrationFingerprint();
  const outputDir=env.CODEXIA_BACKEND_PROMOTION_DIR;
  assert.ok(typeof outputDir==='string'&&path.isAbsolute(outputDir),'Backend promotion handoff directory must be absolute');
  await mkdir(outputDir,{recursive:true});
  const scratch=await mkdtemp(path.join(env.RUNNER_TEMP||tmpdir(),'codexia-backend-promotion-'));
  try {
    const receipt={...releaseRepositoryBinding(context),format:'codexia-backend-promotion/v1',event:'pull_request',sourceSha:proof.headSha,version,
      workflowRunId:run.id,workflowRunNumber:run.run_number,workflowAttempt:run.run_attempt,workflowId:workflow.id,prNumber:proof.prNumber,
      verifyRunId:proof.sourceVerifyRunId,proofRunId:proof.runId,verifyAttempt:proof.attempt,planDigest:proof.planDigest,
      sourceTree:proof.tree,mergeBaseSha:proof.baseSha,mainSha:env.CODEXIA_SOURCE_SHA || env.GITHUB_SHA,artifacts:{}};
    for(const item of selected){
      assertArtifactRunRepository(item.artifact, run);
      const bytes=await downloadArtifact(item.artifact,repository,token,fetchImpl,{maxArchive:MAX_IMAGE_BYTES,downloadTimeoutMs:180_000});
      const extracted=path.join(scratch,item.profile);
      const files=await extractArtifactFiles(bytes,extracted,{maxArchive:MAX_IMAGE_BYTES,maxUncompressed:MAX_IMAGE_BYTES});
      assert.deepEqual(files,[IMAGE_FILE],'Backend producer artifact contains unexpected files');
      const archive=path.join(extracted,IMAGE_FILE);
      const identity=await inspectBackendImageWithoutExecution(archive,item.profile,proof.headSha,version,migrationFingerprint,compatibility,scratch);
      const handoffArchive=path.join(outputDir,item.profile+'-'+IMAGE_FILE);
      await rename(archive,handoffArchive);
      receipt.artifacts[item.profile]={id:item.artifact.id,digest:item.artifact.digest,producerAttempt:item.producerAttempt,
        archiveSha256:createHash('sha256').update(await readFile(handoffArchive)).digest('hex'),
        identity:backendPromotionReceiptIdentity(identity)};
    }
    await writeFile(path.join(outputDir,RECORD),JSON.stringify(receipt,null,2)+'\n',{mode:0o600});
    return {promoted:true,receipt,reason:'Promoted tested Core and Full backend images from PR #'+proof.prNumber};
  } finally { await rm(scratch,{recursive:true,force:true}); }
}

async function main(){
  const env=process.env;
  let result;
  try {
    if(env.GITHUB_EVENT_NAME!=='workflow_run') throw new Error('Backend promotion is only selected after completed Verify');
    result=await resolve({env});
  } catch(error) {
    result={promoted:false,reason:'Using exact main-source backend build: '+String(error instanceof Error?error.message:'promotion proof unavailable').replace(/[\r\n]/gu,' ').slice(0,300)};
  }
  const output=env.GITHUB_OUTPUT;
  assert.ok(typeof output==='string'&&output.length>0,'GitHub output path required');
  const lines=[['promoted',String(result.promoted)],['reason',result.reason]];
  if(result.promoted) for(const key of ['sourceSha','version','workflowRunId','workflowAttempt','workflowId','prNumber','verifyRunId','proofRunId','verifyAttempt','planDigest','sourceTree','mergeBaseSha']){
    const receiptKey=key==='sourceSha'?'sourceSha':key;
    lines.push([key,String(result.receipt[receiptKey])]);
  }
  await appendFile(output,lines.map(([key,value])=>key+'='+value.replace(/[\r\n]/gu,' ')+'\n').join(''));
  if(env.GITHUB_STEP_SUMMARY) await appendFile(env.GITHUB_STEP_SUMMARY,result.reason+'\n');
  console.log(result.reason);
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) await main();
