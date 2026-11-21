#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { backendPublicationFromEnvironment, buildComponentReleaseRecord } from './component-release-record.mjs';
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
export function successfulPublicationJobs(jobs,promoted,hasPromotion=promoted){
  const expectations=[['Publish immutable GHCR image','success'],
    ['Build and test backend OCI image (core)',promoted?'skipped':'success'],
    ['Build and test backend OCI image (full)',promoted?'skipped':'success']];
  if(hasPromotion)expectations.push(['Resolve verified backend promotion','success']);
  return expectations.every(([name,conclusion])=>{
    const matches=jobs.filter(job=>job?.name===name);
    return matches.length===1&&matches[0].status==='completed'&&matches[0].conclusion===conclusion;
  });
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
  const release=await request('releases/tags/backend-v'+version,token);
  const tagRef=await request('git/ref/tags/backend-v'+version,token);
  let receipt=null,mainTree=null;
  if(event==='pull_request'){
    const directory=env.CODEXIA_BACKEND_PROMOTION_DIR;
    assert.ok(typeof directory==='string'&&path.isAbsolute(directory),'Backend promotion receipt directory is invalid');
    receipt=JSON.parse(await readFile(path.join(directory,'codexia-backend-promotion.json'),'utf8'));
    mainTree=execFileSync('git',['rev-parse','HEAD^{tree}'],{encoding:'utf8'}).trim();
  }else{
    const manifest=env.CODEXIA_BACKEND_ARTIFACT_MANIFEST;
    assert.ok(typeof manifest==='string'&&path.isAbsolute(manifest),'Backend build manifest path is invalid');
    receipt=JSON.parse(await readFile(manifest,'utf8'));
    mainTree=execFileSync('git',['rev-parse','HEAD^{tree}'],{encoding:'utf8'}).trim();
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
  const created=Date.parse(release.created_at);
  assert.ok(Number.isFinite(created),'Existing backend release creation time is invalid');
  const workflowHeadSha=publication?.workflowHeadSha??mainSha;
  const runs=publication ? [await request('actions/runs/'+publication.workflowRunId,token)] :
    await pages('actions/workflows/backend-release.yml/runs?head_sha='+workflowHeadSha+'&branch=main&event='+publicationEvent,'workflow_runs',token);
  for(const run of runs){
    if(run?.path!=='.github/workflows/backend-release.yml'||run.event!==publicationEvent||run.head_branch!=='main'||run.head_sha!==workflowHeadSha||
      run.status!=='completed'||run.conclusion!=='success'||!Number.isFinite(Date.parse(run.created_at))||!Number.isFinite(Date.parse(run.updated_at))||
      Date.parse(run.created_at)>created||created>Date.parse(run.updated_at))continue;
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
