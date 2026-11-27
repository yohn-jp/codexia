#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { backendPublicationFromEnvironment, buildComponentReleaseRecord, publicationInWorkflowWindow } from '../components/record-model.mjs';
import { createGitHubOctokit } from '../../github/octokit.mjs';
import { paginateActionsInventory } from '../../github/paginate-actions.mjs';

const REPOSITORY='yohn-jp/codexia';
const digestImage=/^ghcr\.io\/yohn-jp\/codexia-backend@sha256:[a-f0-9]{64}$/u;
function parseMetadata(body){
  assert.equal(typeof body,'string','Existing backend release metadata is missing');
  const blocks=[...body.matchAll(/```json\s*\n([\s\S]*?)\n```/gu)];
  assert.equal(blocks.length,1,'Existing backend release metadata block is ambiguous');
  return JSON.parse(blocks[0][1]);
}
export function assertExistingBackendReleaseBinding(release,tagRef,expected){
  assert.equal(release?.tag_name,'backend-v'+expected.version,'Existing backend release tag mismatch');
  assert.equal(release?.draft,false,'Existing backend release must be published');
  assert.equal(release?.prerelease,false,'Existing backend release cannot be a prerelease');
  assert.equal(tagRef?.object?.type,'commit','Existing backend tag must directly name its source');
  assert.equal(tagRef.object.sha,expected.mainSha,'Existing backend tag/main source mismatch');
  const metadata=parseMetadata(release.body);
  for(const image of [metadata.images?.core,metadata.images?.full]) assert.match(image??'',digestImage,'Existing backend image digest is invalid');
  assert.equal(metadata.images[expected.profile],expected.image,'Existing backend release does not bind the immutable registry digest');
  if(expected.event==='pull_request'){
    const record=buildComponentReleaseRecord('backend',expected.mainSha,null,{core:metadata.images.core,full:metadata.images.full,
      compatibility:expected.compatibility,event:'pull_request',receipt:expected.receipt,mainTree:expected.mainTree,publication:expected.publication});
    assert.deepEqual(metadata,record.metadata,'Existing backend release does not bind this exact promoted producer receipt');
  }else{
    assert.ok(['push','workflow_run'].includes(expected.event),'Main backend producer event mismatch');
    const record=buildComponentReleaseRecord('backend',expected.mainSha,null,{core:metadata.images.core,full:metadata.images.full,
      compatibility:expected.compatibility,event:expected.event,receipt:expected.receipt,mainTree:expected.mainTree,publication:expected.publication});
    assert.deepEqual(metadata,record.metadata,'Existing backend release does not bind this exact main build receipt');
  }
  return metadata;
}

export function successfulPublicationJobs(jobs,promoted,hasPromotion=promoted){
  if(!Array.isArray(jobs))return false;
  const exactJob=(name,conclusion)=>{
    const matches=jobs.filter(job=>job?.name===name);
    return matches.length===1&&matches[0].status==='completed'&&matches[0].conclusion===conclusion;
  };
  const buildPrefix='Build and test backend OCI image';
  const buildJobs=jobs.filter(job=>typeof job?.name==='string'&&job.name.startsWith(buildPrefix));
  const aggregateName='Build and test backend OCI image (${{ matrix.profile }})';
  const perProfileNames=[`${buildPrefix} (core)`,`${buildPrefix} (full)`];
  const buildPathIsValid=promoted
    ? (buildJobs.length===1&&buildJobs[0].name===aggregateName&&buildJobs[0].status==='completed'&&buildJobs[0].conclusion==='skipped') ||
      (buildJobs.length===2&&perProfileNames.every(name=>exactJob(name,'skipped')))
    : buildJobs.length===2&&perProfileNames.every(name=>exactJob(name,'success'));
  if(!buildPathIsValid||!exactJob('Publish immutable GHCR image','success'))return false;
  return !hasPromotion||exactJob('Resolve verified backend promotion','success');
}

export function backendReleaseSourceTree(sourceSha,git=execFileSync){
  assert.match(sourceSha??'',/^[a-f0-9]{40}$/u,'Backend release source SHA is invalid');
  return git('git',['rev-parse',sourceSha+'^{tree}'],{encoding:'utf8'}).trim();
}

export function publishedBackendCompatibility(sourceSha) {
  assert.match(sourceSha ?? '', /^[a-f0-9]{40}$/u, 'Backend release source SHA is invalid');
  return JSON.parse(execFileSync('git', ['show', `${sourceSha}:deploy/update-compatibility.json`], { encoding: 'utf8' }));
}

export async function verifyExistingBackendRelease({env=process.env,args=process.argv.slice(2),usePublishedSourceCompatibility=false}={}){
  const [image,mainSha,producerSha,version,profile,event]=args;
  assert.equal(env.GITHUB_REPOSITORY,REPOSITORY);
  assert.equal(env.GITHUB_REF,'refs/heads/main');
  assert.match(image??'',digestImage);assert.match(mainSha??'',/^[a-f0-9]{40}$/u);
  assert.match(producerSha??'',/^[a-f0-9]{40}$/u);assert.match(version??'',/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u);
  assert.ok(['core','full'].includes(profile));assert.ok(['push','workflow_run','pull_request'].includes(event));
  const publicationEvent=env.GITHUB_EVENT_NAME;
  assert.ok(['push','workflow_run'].includes(publicationEvent),'Invalid main publication event');
  const token=env.GH_TOKEN;assert.ok(typeof token==='string'&&token.length>0,'GitHub Actions read token required');
  const github=createGitHubOctokit({token});
  const tag='backend-v'+version;
  const [owner,repo]=REPOSITORY.split('/');
  const [{data:release},{data:tagRef}]=await Promise.all([
    github.rest.repos.getReleaseByTag({owner,repo,tag}),
    github.rest.git.getRef({owner,repo,ref:'tags/'+tag}),
  ]);
  assert.equal(tagRef?.ref,'refs/tags/'+tag,'Backend release ref does not match the exact requested tag');
  if (usePublishedSourceCompatibility) {
    assert.equal(tagRef.object?.type, 'commit', 'Existing backend tag must directly name its source');
    assert.equal(tagRef.object.sha, mainSha, 'Existing backend tag/main source mismatch');
  }
  let receipt=null,mainTree=null;
  if(event==='pull_request'){
    const directory=env.CODEXIA_BACKEND_PROMOTION_DIR;
    assert.ok(typeof directory==='string'&&path.isAbsolute(directory),'Backend promotion receipt directory is invalid');
    receipt=JSON.parse(await readFile(path.join(directory,'codexia-backend-promotion.json'),'utf8'));
    mainTree=backendReleaseSourceTree(mainSha);
  }else{
    const manifest=env.CODEXIA_BACKEND_ARTIFACT_MANIFEST;
    assert.ok(typeof manifest==='string'&&path.isAbsolute(manifest),'Backend build manifest path is invalid');
    receipt=JSON.parse(await readFile(manifest,'utf8'));
    mainTree=backendReleaseSourceTree(mainSha);
    assert.equal(receipt.workflowRunId,Number(env.GITHUB_RUN_ID),'Backend build receipt run ID mismatch');
    assert.equal(receipt.workflowRunNumber,Number(env.GITHUB_RUN_NUMBER),'Backend build receipt run number mismatch');
    assert.equal(receipt.sourceSha,mainSha,'Backend build receipt source mismatch');
    assert.equal(receipt.version,version,'Backend build receipt version mismatch');
    assert.equal(receipt.sourceTree,mainTree,'Backend build receipt tree mismatch');
  }
  const compatibility = usePublishedSourceCompatibility
    ? publishedBackendCompatibility(mainSha)
    : JSON.parse(await readFile(new URL('../../../deploy/update-compatibility.json', import.meta.url), 'utf8'));
  const publication=backendPublicationFromEnvironment(env,mainSha);
  const metadata=assertExistingBackendReleaseBinding(release,tagRef,{image,mainSha,producerSha,version,profile,event,receipt,mainTree,compatibility,publication});
  if(event==='pull_request')assert.equal(metadata.producer.sourceSha,producerSha,'Existing release producer SHA mismatch');
  else assert.equal(producerSha,mainSha,'Main producer SHA mismatch');
  const workflowHeadSha=publication?.workflowHeadSha??mainSha;
  const runs=publication ? [(await github.rest.actions.getWorkflowRun({owner,repo,run_id:publication.workflowRunId})).data] :
    await paginateActionsInventory(github,github.rest.actions.listWorkflowRuns,{
      owner,repo,workflow_id:'backend-release.yml',head_sha:workflowHeadSha,branch:'main',event:publicationEvent,
    },'workflow_runs');
  for(const run of runs){
    if(run?.path!=='.github/workflows/backend-release.yml'||run.event!==publicationEvent||run.head_branch!=='main'||run.head_sha!==workflowHeadSha||
      run.status!=='completed'||run.conclusion!=='success'||!publicationInWorkflowWindow(release,run))continue;
    if(publication&&run.id!==publication.workflowRunId)continue;
    if(event!=='pull_request'&&(run.id!==receipt.workflowRunId||run.run_number!==receipt.workflowRunNumber))continue;
    assert.ok(Number.isSafeInteger(run.id)&&run.id>0,'Backend publication run ID is invalid');
    const jobs=await paginateActionsInventory(github,github.rest.actions.listJobsForWorkflowRun,
      {owner,repo,run_id:run.id,filter:'latest'},'jobs');
    if(successfulPublicationJobs(jobs,event==='pull_request',true))return {release,metadata,publicationRunId:run.id};
  }
  throw new Error('No successful main backend publication run binds the existing immutable digest');
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  verifyExistingBackendRelease().then(()=>console.log('Existing backend digest is bound to a prior successful main publication.'))
    .catch(error=>{console.error(error instanceof Error?error.message:'Existing backend release proof failed');process.exitCode=1;});
}
