#!/usr/bin/env node
import { actionsRepository, assertReleaseRepositoryBinding, deploymentRepository, matchesRepository } from '../../github/repository.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { backendPublicationFromEnvironment, buildComponentReleaseRecord } from './record-model.mjs';
import { createGitHubOctokit } from '../../github/octokit.mjs';

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
  const context=actionsRepository(env);
  const sha=env.CODEXIA_SOURCE_SHA || env.GITHUB_SHA;
  assert.match(sha??'',/^[a-f0-9]{40}$/u,'Component release source SHA is invalid');
  const component=process.argv[2];
  assert.ok(['frontend','backend'].includes(component));
  if(component==='frontend'){
    const identity=JSON.parse(readFileSync(new URL('../../../app/dist/desktop/update-identity.json',import.meta.url),'utf8'));
    const producer=frontendProducerFromEnvironment(env,identity);
    const mainTree=execFileSync('git',['rev-parse','HEAD^{tree}'],{encoding:'utf8'}).trim();
    return buildComponentReleaseRecord(component,sha,identity,producer,mainTree,context);
  }
  const core=env.CODEXIA_CERTIFIED_IMAGE,full=env.CODEXIA_CERTIFIED_FULL_IMAGE;
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
  return buildComponentReleaseRecord(component,sha,null,producer,undefined,context);
}

async function main(){
  const env=process.env;
  const context=actionsRepository(env);
  assert.equal(env.GITHUB_REF,'refs/heads/main');
  assert.ok(['push','workflow_run'].includes(env.GITHUB_EVENT_NAME),'Component release requires main or verified completion');
  const token=env.GH_TOKEN;assert.ok(token);
  const github=createGitHubOctokit({token});
  const expectedTag=componentReleaseTagFromEnvironment(process.argv[2],env);
  const release=componentReleaseRecordFromEnvironment(env);
  assert.equal(release.tag,expectedTag,'Component release metadata differs from the trusted producer version');
  await recordComponentRelease(release,{github,context});
}

export async function assertComponentReleaseRecorded(release,{github,context}){
  assertReleaseRepositoryBinding(release.metadata, context);
  const { owner, repo } = deploymentRepository(context.repository);
  const { data: current } = await github.rest.repos.get({ owner, repo });
  assert.ok(matchesRepository(current, context), 'Component release target repository changed');
  const {data:ref}=await github.rest.git.getRef({owner,repo,ref:'tags/'+release.tag});
  assert.equal(ref?.object?.type,'commit');
  assert.equal(ref.object.sha,release.targetSha,'Component version already belongs to a different source');
  const {data:existing}=await github.rest.repos.getReleaseByTag({owner,repo,tag:release.tag});
  assert.equal(existing.tag_name,release.tag);
  assert.equal(existing.body,release.body,'Existing component release binds different metadata');
  assert.equal(existing.draft,false);
}

// Shared immutable tag and release writer. The caller must first certify the
// producer and verify the deployed identity in its protected release lane.
export async function recordComponentRelease(release,{github,context}){
  const expectedTag=release.tag;
  assert.match(expectedTag,/^(?:frontend|backend)-v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u);
  assert.match(release.targetSha,/^[a-f0-9]{40}$/u);
  assertReleaseRepositoryBinding(release.metadata, context);
  const { owner, repo } = deploymentRepository(context.repository);
  const { data: current } = await github.rest.repos.get({ owner, repo });
  assert.ok(matchesRepository(current, context), 'Component release target repository changed');
  const readOrMissing=async operation=>{
    try{return (await operation()).data;}
    catch(error){
      if(error?.status===404)return null;
      throw new Error('Component release API request failed'+(Number.isSafeInteger(error?.status)?': HTTP '+error.status:''),{cause:error});
    }
  };
  let ref=await readOrMissing(()=>github.rest.git.getRef({owner,repo,ref:'tags/'+expectedTag}));
  if(!ref){
    try{await github.rest.git.createRef({owner,repo,ref:'refs/tags/'+expectedTag,sha:release.targetSha});}
    catch(error){throw new Error('Component release API request failed'+(Number.isSafeInteger(error?.status)?': HTTP '+error.status:''),{cause:error});}
    ref=await readOrMissing(()=>github.rest.git.getRef({owner,repo,ref:'tags/'+expectedTag}));
  }
  assert.equal(ref?.object?.type,'commit');assert.equal(ref.object.sha,release.targetSha,'Component version already belongs to a different source');
  const existing=await readOrMissing(()=>github.rest.repos.getReleaseByTag({owner,repo,tag:expectedTag}));
  if(existing){
    assert.equal(existing.tag_name,release.tag);assert.equal(existing.body,release.body,'Existing component release binds different metadata');
    assert.equal(existing.draft,false);
  }else{
    try{await github.rest.repos.createRelease({owner,repo,tag_name:release.tag,target_commitish:release.targetSha,name:release.title,body:release.body,
      draft:false,prerelease:false,make_latest:'false'});}
    catch(error){throw new Error('Component release API request failed'+(Number.isSafeInteger(error?.status)?': HTTP '+error.status:''),{cause:error});}
  }
  await assertComponentReleaseRecorded(release,{github,context});
  console.log('Recorded '+release.title+' from '+release.targetSha);
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  main().catch(error=>{console.error(error instanceof Error?error.message:'Component release recording failed');process.exitCode=1;});
}
