#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectGitHubPages } from './release-policy.mjs';
import { verifyFrontendMainPromotionProof } from './verify-frontend-artifact.mjs';
import { selectBackendArtifacts, assertBackendProducerAttempt } from './verify-backend-artifacts.mjs';
import { selectBackendPromotionRun, inspectBackendImageWithoutExecution } from './resolve-backend-promotion.mjs';
import { readComponentVersion } from './component-release-version.mjs';

const REPOSITORY='yohn-jp/codexia';
const DIRECTORY=process.env.CODEXIA_BACKEND_PROMOTION_DIR;
const RECORD='codexia-backend-promotion.json';

async function githubJson(url,token){
  const response=await fetch(url,{headers:{Authorization:'Bearer '+token,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28'},
    redirect:'error',signal:AbortSignal.timeout(20_000)});
  if(!response.ok)throw new Error('Backend promotion handoff provenance lookup failed (HTTP '+response.status+')');
  return response.json();
}
async function pages(url,token,key){
  return collectGitHubPages((page,perPage)=>githubJson(url+(url.includes('?')?'&':'?')+'per_page='+perPage+'&page='+page,token),key);
}
function positive(value,label){
  assert.ok(Number.isSafeInteger(Number(value))&&Number(value)>0,label+' is invalid');
  return Number(value);
}

export async function verifyBackendPromotionHandoff({env=process.env}={}){
  assert.equal(env.GITHUB_REPOSITORY,REPOSITORY);
  assert.equal(env.GITHUB_EVENT_NAME,'push');
  assert.equal(env.GITHUB_REF,'refs/heads/main');
  assert.equal(execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),env.GITHUB_SHA);
  assert.ok(typeof env.GH_TOKEN==='string'&&env.GH_TOKEN.length>0,'GitHub Actions read token required');
  assert.ok(typeof DIRECTORY==='string'&&path.isAbsolute(DIRECTORY),'Backend promotion directory is invalid');
  const token=env.GH_TOKEN;
  const receipt=JSON.parse(await readFile(path.join(DIRECTORY,RECORD),'utf8'));
  const proof=await verifyFrontendMainPromotionProof({env});
  assert.equal(receipt.format,'codexia-backend-promotion/v1');
  assert.equal(receipt.event,'pull_request');
  assert.equal(receipt.mainSha,env.GITHUB_SHA);
  assert.equal(receipt.sourceSha,proof.headSha);
  assert.equal(receipt.sourceTree,proof.tree);
  assert.equal(receipt.mergeBaseSha,proof.baseSha);
  assert.equal(receipt.prNumber,proof.prNumber);
  assert.equal(receipt.proofRunId,proof.runId);
  assert.equal(receipt.verifyAttempt,proof.attempt);
  assert.equal(receipt.verifyRunId,proof.sourceVerifyRunId);
  assert.equal(receipt.planDigest,proof.planDigest);
  assert.equal(receipt.version,readComponentVersion('backend',String(receipt.workflowRunNumber)));
  const repositoryId=positive(env.CODEXIA_REPOSITORY_ID,'Repository ID');
  const workflow=await githubJson('https://api.github.com/repos/'+REPOSITORY+'/actions/workflows/backend-release.yml',token);
  assert.equal(workflow.path,'.github/workflows/backend-release.yml');
  assert.equal(positive(receipt.workflowId,'Producer workflow ID'),workflow.id);
  const runs=await pages('https://api.github.com/repos/'+REPOSITORY+'/actions/workflows/'+workflow.id+'/runs?head_sha='+proof.headSha+'&event=pull_request',token,'workflow_runs');
  const run=selectBackendPromotionRun(runs,proof,repositoryId,workflow.id);
  for(const [key,value] of [['workflowRunId',run.id],['workflowRunNumber',run.run_number],['workflowAttempt',run.run_attempt]]) assert.equal(receipt[key],value,'Backend producer '+key+' changed');
  const [latestJobs,artifacts]=await Promise.all([
    pages('https://api.github.com/repos/'+REPOSITORY+'/actions/runs/'+run.id+'/jobs?filter=latest',token,'jobs'),
    pages('https://api.github.com/repos/'+REPOSITORY+'/actions/runs/'+run.id+'/artifacts',token,'artifacts'),
  ]);
  const selected=selectBackendArtifacts(run,artifacts,latestJobs,{runId:run.id,currentAttempt:run.run_attempt,sourceSha:proof.headSha,event:'pull_request',headBranch:proof.headRef});
  const producerAttempts=new Map(await Promise.all([...new Set(selected.map(item=>item.producerAttempt))].map(async attempt=>[
    attempt,await pages('https://api.github.com/repos/'+REPOSITORY+'/actions/runs/'+run.id+'/attempts/'+attempt+'/jobs',token,'jobs'),
  ])));
  for(const item of selected){
    assertBackendProducerAttempt(item,producerAttempts.get(item.producerAttempt),{runId:run.id,sourceSha:proof.headSha});
    const expected=receipt.artifacts?.[item.profile];
    assert.ok(expected&&typeof expected==='object','Missing handoff artifact receipt for '+item.profile);
    assert.equal(expected.id,item.artifact.id,'Backend producer artifact ID changed');
    assert.equal(expected.digest,item.artifact.digest,'Backend producer artifact digest changed');
    assert.equal(expected.producerAttempt,item.producerAttempt,'Backend producer attempt changed');
  }
  assert.equal(Object.keys(receipt.artifacts).sort().join(','),'core,full');
  const compatibility=JSON.parse(await readFile(new URL('../deploy/update-compatibility.json',import.meta.url),'utf8'));
  const expectedFingerprint=execFileSync(process.execPath,['--experimental-strip-types','--input-type=module','-e',
    "import { readMigrationSet, migrationSetFingerprint } from './packages/persistence-postgres/src/migration-set.ts'; console.log(migrationSetFingerprint(await readMigrationSet('./packages/persistence-postgres/migrations')));"],{encoding:'utf8'}).trim();
  const scratch=await mkdtemp(path.join(env.RUNNER_TEMP||tmpdir(),'codexia-backend-promotion-check-'));
  try{
    let firstIdentity;
    for(const profile of ['core','full']){
      const item=receipt.artifacts[profile];
      const archive=path.join(DIRECTORY,profile+'-codexia-backend-image.tar.gz');
      const bytes=await readFile(archive);
      assert.equal(createHash('sha256').update(bytes).digest('hex'),item.archiveSha256,'Backend handoff archive digest mismatch');
      const identity=inspectBackendImageWithoutExecution(archive,profile,proof.headSha,receipt.version,expectedFingerprint,compatibility,scratch);
      assert.deepEqual(identity,item.identity,'Backend image identity differs from the verified receipt');
      if(firstIdentity){
        for(const key of ['version','sourceSha','platform','migrationFingerprint','apiEpoch','persistenceFormat']) assert.equal(identity[key],firstIdentity[key],'Core and Full image identities differ: '+key);
      }else firstIdentity=identity;
    }
  }finally{await rm(scratch,{recursive:true,force:true});}
  return receipt;
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  verifyBackendPromotionHandoff().then(()=>console.log('Revalidated backend promotion handoff without executing image code.'))
    .catch(error=>{console.error(error instanceof Error?error.message:'Backend promotion handoff verification failed');process.exitCode=1;});
}
