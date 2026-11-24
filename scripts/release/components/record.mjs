#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { backendPublicationFromEnvironment, buildComponentReleaseRecord } from './record-model.mjs';
import { createGitHubRestClient } from '../../github/rest-client.mjs';

const repository='yohn-jp/codexia';
const digest=/^ghcr\.io\/yohn-jp\/codexia-backend@sha256:[a-f0-9]{64}$/u;
const semver=/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;

export function componentReleaseTagFromEnvironment(component,env=process.env){
  assert.ok(['frontend','backend'].includes(component),'Unknown component');
  const version=component==='frontend'?env.CODEXIA_FRONTEND_PRODUCER_VERSION:env.CODEXIA_BACKEND_PRODUCER_VERSION;
  assert.match(version??'',semver,'Trusted component producer version is invalid');
  return component+'-v'+version;
}

export function frontendProducerFromEnvironment(env=process.env,identity){
  const producer={event:env.CODEXIA_FRONTEND_PRODUCER_EVENT,sourceSha:env.CODEXIA_FRONTEND_PRODUCER_SHA,
    version:env.CODEXIA_FRONTEND_PRODUCER_VERSION,workflowRunId:Number(env.CODEXIA_FRONTEND_PRODUCER_RUN_ID),
    workflowAttempt:Number(env.CODEXIA_FRONTEND_PRODUCER_ATTEMPT),artifactId:Number(env.CODEXIA_FRONTEND_ARTIFACT_ID),
    artifactDigest:env.CODEXIA_FRONTEND_ARTIFACT_DIGEST,profile:identity.profile,apiEpoch:identity.apiEpoch};
  if(producer.event==='pull_request') Object.assign(producer,{prNumber:Number(env.CODEXIA_FRONTEND_PRODUCER_PR_NUMBER),
    workflowId:Number(env.CODEXIA_FRONTEND_PRODUCER_WORKFLOW_ID),verifyRunId:Number(env.CODEXIA_FRONTEND_VERIFY_RUN_ID),
    proofRunId:Number(env.CODEXIA_FRONTEND_PR_VERIFY_RUN_ID),verifyAttempt:Number(env.CODEXIA_FRONTEND_VERIFY_ATTEMPT),
    planDigest:env.CODEXIA_FRONTEND_VERIFY_PLAN_DIGEST,sourceTree:env.CODEXIA_FRONTEND_PRODUCER_TREE,
    mergeBaseSha:env.CODEXIA_FRONTEND_PRODUCER_BASE_SHA});
  return producer;
}

export function componentReleaseRecordFromEnvironment(env=process.env){
  const sha=env.CODEXIA_SOURCE_SHA || env.GITHUB_SHA;
  assert.match(sha??'',/^[a-f0-9]{40}$/u,'Component release source SHA is invalid');
  const component=process.argv[2];
  assert.ok(['frontend','backend'].includes(component));
  if(component==='frontend'){
    const identity=JSON.parse(readFileSync(new URL('../../../app/dist/desktop/update-identity.json',import.meta.url),'utf8'));
    const producer=frontendProducerFromEnvironment(env,identity);
    const mainTree=execFileSync('git',['rev-parse','HEAD^{tree}'],{encoding:'utf8'}).trim();
    return buildComponentReleaseRecord(component,sha,identity,producer,mainTree);
  }
  const core=env.CODEXIA_CERTIFIED_IMAGE,full=env.CODEXIA_CERTIFIED_FULL_IMAGE;
  assert.match(core??'',digest);assert.match(full??'',digest);assert.notEqual(core,full);
  const compatibility=JSON.parse(readFileSync(new URL('../../../deploy/update-compatibility.json',import.meta.url),'utf8'));
  const producer={core,full,compatibility,event:env.CODEXIA_BACKEND_PRODUCER_EVENT,publication:backendPublicationFromEnvironment(env,sha)};
  if(producer.event==='pull_request'){
    const directory=env.CODEXIA_BACKEND_PROMOTION_DIR;
    assert.ok(typeof directory==='string'&&path.isAbsolute(directory),'Backend promotion receipt directory is invalid');
    producer.receipt=JSON.parse(readFileSync(path.join(directory,'codexia-backend-promotion.json'),'utf8'));
    producer.mainTree=execFileSync('git',['rev-parse','HEAD^{tree}'],{encoding:'utf8'}).trim();
  }else{
    assert.ok(['push','workflow_run'].includes(producer.event),'Backend producer event is invalid');
    const manifest=env.CODEXIA_BACKEND_ARTIFACT_MANIFEST;
    assert.ok(typeof manifest==='string'&&path.isAbsolute(manifest),'Backend build manifest path is invalid');
    producer.receipt=JSON.parse(readFileSync(manifest,'utf8'));
    producer.mainTree=execFileSync('git',['rev-parse','HEAD^{tree}'],{encoding:'utf8'}).trim();
  }
  return buildComponentReleaseRecord(component,sha,null,producer);
}

async function main(){
  const env=process.env;
  assert.equal(env.GITHUB_REPOSITORY,repository);
  assert.equal(env.GITHUB_REF,'refs/heads/main');
  assert.ok(['push','workflow_run'].includes(env.GITHUB_EVENT_NAME),'Component release requires main or verified completion');
  const token=env.GH_TOKEN;assert.ok(token);
  const github=createGitHubRestClient({token});
  const expectedTag=componentReleaseTagFromEnvironment(process.argv[2],env);
  const release=componentReleaseRecordFromEnvironment(env);
  assert.equal(release.tag,expectedTag,'Component release metadata differs from the trusted producer version');
  async function api(resource,method='GET',data){
    const response=await github.request(method,`/repos/${repository}/${resource}`,{
      ...(data?{data}:{}),headers:{'X-GitHub-Api-Version':'2022-11-28'},
    });
    if(response.status===404&&method==='GET')return null;
    if(response.status<200||response.status>=300)throw Error('Component release API request failed: HTTP '+response.status);
    return response.data;
  }
  const resource='git/ref/tags/'+expectedTag;
  let ref=await api(resource);
  if(!ref){
    await api('git/refs','POST',{ref:'refs/tags/'+expectedTag,sha:release.targetSha});
    ref=await api(resource);
  }
  assert.equal(ref?.object?.type,'commit');assert.equal(ref.object.sha,release.targetSha,'Component version already belongs to a different source');
  const existing=await api('releases/tags/'+expectedTag);
  if(existing){
    assert.equal(existing.tag_name,release.tag);assert.equal(existing.body,release.body,'Existing component release binds different metadata');
    assert.equal(existing.draft,false);
  }else{
    await api('releases','POST',{tag_name:release.tag,target_commitish:release.targetSha,name:release.title,body:release.body,
      draft:false,prerelease:false,make_latest:'false'});
  }
  console.log('Recorded '+release.title+' from '+release.targetSha);
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  main().catch(error=>{console.error(error instanceof Error?error.message:'Component release recording failed');process.exitCode=1;});
}
