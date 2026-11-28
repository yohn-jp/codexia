#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyFrontendMainPromotionProof } from '../../verification/artifacts/frontend.mjs';
import { selectBackendArtifacts, assertBackendProducerAttempt } from '../../verification/artifacts/backend.mjs';
import { selectBackendPromotionRun, inspectBackendImageWithoutExecution } from '../../release/backend/resolve-promotion.mjs';
import { readComponentVersion } from '../../release/components/version.mjs';
import { expectedBackendMigrationFingerprint } from '../../release/backend/image-inspection.mjs';
import { createGitHubOctokit } from '../../github/octokit.mjs';
import { paginateActionsInventory } from '../../github/paginate-actions.mjs';

import { actionsRepository } from '../../github/repository.mjs';
const DIRECTORY=process.env.CODEXIA_BACKEND_PROMOTION_DIR;
const RECORD='codexia-backend-promotion.json';

function positive(value,label){
  assert.ok(Number.isSafeInteger(Number(value))&&Number(value)>0,label+' is invalid');
  return Number(value);
}

export async function verifyBackendPromotionHandoff({env=process.env}={}){
  const { owner, repo, repository, repositoryId, ownerId } = actionsRepository(env);
  assert.equal(env.GITHUB_EVENT_NAME,'workflow_run');
  assert.equal(env.GITHUB_REF,'refs/heads/main');
  assert.equal(execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),env.CODEXIA_SOURCE_SHA || env.GITHUB_SHA);
  assert.ok(typeof env.GH_TOKEN==='string'&&env.GH_TOKEN.length>0,'GitHub Actions read token required');
  assert.ok(typeof DIRECTORY==='string'&&path.isAbsolute(DIRECTORY),'Backend promotion directory is invalid');
  const token=env.GH_TOKEN;
  const receipt=JSON.parse(await readFile(path.join(DIRECTORY,RECORD),'utf8'));
  const github=createGitHubOctokit({token,repository,repositoryId,timeout:20_000});
  const proof=await verifyFrontendMainPromotionProof({env});
  assert.equal(receipt.format,'codexia-backend-promotion/v1');
  assert.equal(receipt.event,'pull_request');
  assert.equal(receipt.repository, repository);
  assert.equal(receipt.repositoryId, repositoryId);
  assert.equal(receipt.ownerId, ownerId);
  assert.equal(receipt.mainSha,env.CODEXIA_SOURCE_SHA || env.GITHUB_SHA);
  assert.equal(receipt.sourceSha,proof.headSha);
  assert.equal(receipt.sourceTree,proof.tree);
  assert.equal(receipt.mergeBaseSha,proof.baseSha);
  assert.equal(receipt.prNumber,proof.prNumber);
  assert.equal(receipt.proofRunId,proof.runId);
  assert.equal(receipt.verifyAttempt,proof.attempt);
  assert.equal(receipt.verifyRunId,proof.sourceVerifyRunId);
  assert.equal(receipt.planDigest,proof.planDigest);
  assert.equal(receipt.version,readComponentVersion('backend',String(receipt.workflowRunNumber)));
  const workflow=(await github.rest.actions.getWorkflow({owner,repo,workflow_id:'backend-release.yml'})).data;
  assert.equal(workflow.path,'.github/workflows/backend-release.yml');
  assert.equal(positive(receipt.workflowId,'Producer workflow ID'),workflow.id);
  const runs=await paginateActionsInventory(github,github.rest.actions.listWorkflowRuns,
    {owner,repo,workflow_id:workflow.id,head_sha:proof.headSha,event:'pull_request'},'workflow_runs');
  const run=selectBackendPromotionRun(runs,proof,repositoryId,workflow.id);
  for(const [key,value] of [['workflowRunId',run.id],['workflowRunNumber',run.run_number],['workflowAttempt',run.run_attempt]]) assert.equal(receipt[key],value,'Backend producer '+key+' changed');
  const [latestJobs,artifacts]=await Promise.all([
    paginateActionsInventory(github,github.rest.actions.listJobsForWorkflowRun,{owner,repo,run_id:run.id,filter:'latest'},'jobs'),
    paginateActionsInventory(github,github.rest.actions.listWorkflowRunArtifacts,{owner,repo,run_id:run.id},'artifacts'),
  ]);
  const selected=selectBackendArtifacts(run,artifacts,latestJobs,{runId:run.id,currentAttempt:run.run_attempt,sourceSha:proof.headSha,event:'pull_request',headBranch:proof.headRef});
  const producerAttempts=new Map(await Promise.all([...new Set(selected.map(item=>item.producerAttempt))].map(async attempt=>[
    attempt,await paginateActionsInventory(github,github.rest.actions.listJobsForWorkflowRunAttempt,
      {owner,repo,run_id:run.id,attempt_number:attempt},'jobs'),
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
  const compatibility=JSON.parse(await readFile(new URL('../../../deploy/update-compatibility.json',import.meta.url),'utf8'));
  const expectedFingerprint=await expectedBackendMigrationFingerprint();
  const scratch=await mkdtemp(path.join(env.RUNNER_TEMP||tmpdir(),'codexia-backend-promotion-check-'));
  try{
    let firstIdentity;
    for(const profile of ['core','full']){
      const item=receipt.artifacts[profile];
      const archive=path.join(DIRECTORY,profile+'-codexia-backend-image.tar.gz');
      const bytes=await readFile(archive);
      assert.equal(createHash('sha256').update(bytes).digest('hex'),item.archiveSha256,'Backend handoff archive digest mismatch');
      const identity=await inspectBackendImageWithoutExecution(archive,profile,proof.headSha,receipt.version,expectedFingerprint,compatibility,scratch);
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
