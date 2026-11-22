#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { backendPublicationFromEnvironment, buildComponentReleaseRecord, publicationInWorkflowWindow } from './component-release-record.mjs';
import { collectGitHubPages } from './release-policy.mjs';

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

async function request(resource,token){
  const response=await fetch('https://api.github.com/repos/'+REPOSITORY+'/'+resource,{headers:{Authorization:'Bearer '+token,
    Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28'},redirect:'error',signal:AbortSignal.timeout(20_000)});
  if(!response.ok)throw new Error('Existing backend release proof lookup failed (HTTP '+response.status+')');
  return response.json();
}
async function pages(resource,key,token){
  const separator=resource.includes('?')?'&':'?';
  return collectGitHubPages((page,perPage)=>request(resource+separator+'per_page='+perPage+'&page='+page,token),key);
}
async function listBackendReleases(token){
  const releases=[];
  for(let page=1;page<=20;page++){
    const response=await request('releases?per_page=100&page='+page,token);
    assert.ok(Array.isArray(response),'GitHub release inventory is invalid');
    releases.push(...response);
    if(response.length<100)return releases;
  }
  throw new Error('Backend release inventory exceeds the supported bound');
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

export async function verifyExistingBackendRelease({env=process.env,args=process.argv.slice(2)}={}){
  const [image,mainSha,producerSha,version,profile,event]=args;
  assert.equal(env.GITHUB_REPOSITORY,REPOSITORY);
  assert.equal(env.GITHUB_REF,'refs/heads/main');
  assert.match(image??'',digestImage);assert.match(mainSha??'',/^[a-f0-9]{40}$/u);
  assert.match(producerSha??'',/^[a-f0-9]{40}$/u);assert.match(version??'',/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u);
  assert.ok(['core','full'].includes(profile));assert.ok(['push','workflow_run','pull_request'].includes(event));
  const publicationEvent=env.GITHUB_EVENT_NAME;
  assert.ok(['push','workflow_run'].includes(publicationEvent),'Invalid main publication event');
  const token=env.GH_TOKEN;assert.ok(typeof token==='string'&&token.length>0,'GitHub Actions read token required');
  const compatibility=JSON.parse(await readFile(new URL('../deploy/update-compatibility.json',import.meta.url),'utf8'));
  const tag='backend-v'+version;
  const releaseMatches=(await listBackendReleases(token)).filter(item=>item?.tag_name===tag);
  assert.equal(releaseMatches.length,1,'Expected one exact backend release record');
  const release=releaseMatches[0];
  const refMatches=(await request('git/matching-refs/tags/backend-v',token))
    .filter(item=>item?.ref==='refs/tags/'+tag);
  assert.equal(refMatches.length,1,'Expected one exact backend release tag');
  const tagRef=refMatches[0];
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
  const publication=backendPublicationFromEnvironment(env,mainSha);
  const metadata=assertExistingBackendReleaseBinding(release,tagRef,{image,mainSha,producerSha,version,profile,event,receipt,mainTree,compatibility,publication});
  if(event==='pull_request')assert.equal(metadata.producer.sourceSha,producerSha,'Existing release producer SHA mismatch');
  else assert.equal(producerSha,mainSha,'Main producer SHA mismatch');
  const workflowHeadSha=publication?.workflowHeadSha??mainSha;
  const runs=publication ? [await request('actions/runs/'+publication.workflowRunId,token)] :
    await pages('actions/workflows/backend-release.yml/runs?head_sha='+workflowHeadSha+'&branch=main&event='+publicationEvent,'workflow_runs',token);
  for(const run of runs){
    if(run?.path!=='.github/workflows/backend-release.yml'||run.event!==publicationEvent||run.head_branch!=='main'||run.head_sha!==workflowHeadSha||
      run.status!=='completed'||run.conclusion!=='success'||!publicationInWorkflowWindow(release,run))continue;
    if(publication&&run.id!==publication.workflowRunId)continue;
    if(event!=='pull_request'&&(run.id!==receipt.workflowRunId||run.run_number!==receipt.workflowRunNumber))continue;
    const jobs=await pages('actions/runs/'+run.id+'/jobs?filter=latest','jobs',token);
    if(successfulPublicationJobs(jobs,event==='pull_request',true))return {release,metadata,publicationRunId:run.id};
  }
  throw new Error('No successful main backend publication run binds the existing immutable digest');
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  verifyExistingBackendRelease().then(()=>console.log('Existing backend digest is bound to a prior successful main publication.'))
    .catch(error=>{console.error(error instanceof Error?error.message:'Existing backend release proof failed');process.exitCode=1;});
}
