import assert from 'node:assert/strict';
import { test } from 'node:test';
import { verifiedSourceRun } from '../../release/components/policy.mjs';
import { assertFrontendArtifactEvidence, assertFrontendPromotionArtifactEvidence, shouldPromoteFrontendArtifact, selectFrontendProducerRun, selectExactMainVerifyRun } from './frontend.mjs';

const sourceSha='a'.repeat(40);
const artifactDigest='b'.repeat(64);

function evidence({currentAttempt=2,producerAttempt=2,jobStartedAt='2026-11-15T00:00:00Z',jobCompletedAt='2026-11-15T00:05:00Z',artifactCreatedAt='2026-11-15T00:03:00Z'}={}) {
  const expected={runId:'12345',currentAttempt,producerAttempt,sourceSha,artifactId:'67890',artifactName:`codexia-frontend-${sourceSha}-attempt-${producerAttempt}`,artifactDigest};
  const run={id:12345,run_attempt:currentAttempt,event:'push',head_branch:'main',head_sha:sourceSha};
  const artifact={id:67890,name:expected.artifactName,created_at:artifactCreatedAt,expired:false,size_in_bytes:1024,digest:`sha256:${artifactDigest}`,workflow_run:{id:12345,head_branch:'main',head_sha:sourceSha}};
  const job={name:'Build and verify UI assets',head_sha:sourceSha,run_id:12345,run_attempt:producerAttempt,status:'completed',conclusion:'success',started_at:jobStartedAt,completed_at:jobCompletedAt};
  return {run,artifact,jobs:[job],expected};
}

test('frontend artifact binds its ID and digest to the producer run and exact build attempt',()=>{
  const result=evidence();
  assert.doesNotThrow(()=>assertFrontendArtifactEvidence(result.run,result.artifact,result.jobs,result.expected));
});

test('Verify completion can build an exact source behind the workflow engine head',()=>{
  const result=evidence();
  const workflowSha='c'.repeat(40);
  const run={...result.run,event:'workflow_run',head_sha:workflowSha};
  const artifact={...result.artifact,workflow_run:{...result.artifact.workflow_run,head_sha:workflowSha}};
  const jobs=result.jobs.map(job=>({...job,head_sha:workflowSha}));
  const expected={...result.expected,event:'workflow_run',workflowSha};
  assert.doesNotThrow(()=>assertFrontendArtifactEvidence(run,artifact,jobs,expected));
  assert.throws(()=>assertFrontendArtifactEvidence(run,artifact,jobs,{...expected,workflowSha:'d'.repeat(40)}));
  assert.throws(()=>assertFrontendArtifactEvidence(run,artifact,jobs,{...expected,sourceSha:workflowSha}));
});

test('frontend promotion accepts a full-plan merged-tree PR producer only from its current successful UI attempt',()=>{
  const producerSha='c'.repeat(40), tree='d'.repeat(40), mergeSha='e'.repeat(40);
  const run={id:12345,run_number:91,run_attempt:2,workflow_id:72,path:'.github/workflows/frontend-release.yml',
    event:'pull_request',head_branch:'feature/ui',head_sha:producerSha,status:'completed',conclusion:'success',
    updated_at:'2026-11-19T00:05:00Z',
    repository:{id:42},head_repository:{id:42},pull_requests:[{number:17,head:{sha:producerSha,ref:'feature/ui',repo:{id:42}},base:{ref:'main',repo:{id:42}}}]};
  const job={name:'Build and verify UI assets',head_sha:producerSha,run_id:12345,run_attempt:2,status:'completed',conclusion:'success',
    started_at:'2026-11-19T00:00:00Z',completed_at:'2026-11-19T00:05:00Z'};
  const artifact={id:987,name:`codexia-frontend-pr-17-12345-${producerSha}-attempt-2`,created_at:'2026-11-19T00:03:00Z',
    expired:false,digest:`sha256:${artifactDigest}`,size_in_bytes:4096,
    workflow_run:{id:12345,head_sha:producerSha,head_branch:'feature/ui'}};
  const proof={sourceSha:mergeSha,tree,baseSha:'b'.repeat(40),headSha:producerSha,headRef:'feature/ui',prNumber:17,runId:333,attempt:1,mode:'full',planDigest:'f'.repeat(64)};
  const expected={repositoryId:42,workflowId:72,runId:12345,runAttempt:2,sourceSha:producerSha,mainSha:mergeSha,
    mainTree:tree,baseSha:'b'.repeat(40),headBranch:'feature/ui',prNumber:17,mergedAt:'2026-11-19T00:10:00Z',artifactName:artifact.name};
  assert.equal(assertFrontendPromotionArtifactEvidence(run,[job],[artifact],proof,expected).id,artifact.id);
  for (const bad of [
    { run: { ...run, head_repository: { id: 99 } } },
    { run: { ...run, conclusion: 'failure' } },
    { run: { ...run, run_attempt: 3 } },
    { run: { ...run, head_branch: 'another-feature' } },
    { run: { ...run, pull_requests: [...run.pull_requests,{number:99}] } },
    { job: { ...job, run_attempt: 1 } },
    { proof: { ...proof, mode: 'affected' } },
    { proof: { ...proof, tree: 'f'.repeat(40) } },
    { expected: { ...expected, mergedAt: '2026-11-19T00:04:00Z' } },
    { artifacts: [{ ...artifact, expired: true }] },
  ]) {
    assert.throws(() => assertFrontendPromotionArtifactEvidence(bad.run ?? run, [bad.job ?? job], bad.artifacts ?? [artifact], bad.proof ?? proof, bad.expected ?? expected));
  }
});

test('frontend promotion falls back for stale semver and rejects equal-version source conflicts',()=>{
  const deployed={format:'codexia-frontend-identity/v1',version:'0.1.20',sourceSha:'a'.repeat(40),profile:'full',apiEpoch:1};
  const newer={...deployed,version:'0.1.21',sourceSha:'b'.repeat(40)};
  assert.equal(shouldPromoteFrontendArtifact(newer,deployed),true);
  assert.equal(shouldPromoteFrontendArtifact({...deployed,version:'0.1.19'},deployed),false);
  assert.equal(shouldPromoteFrontendArtifact({...deployed,sourceSha:'c'.repeat(40)},deployed),false);
});

test('frontend promotion selects only the newest same-repository workflow run and never revives an older success',()=>{
  const sourceSha='c'.repeat(40), common={workflow_id:72,path:'.github/workflows/frontend-release.yml',event:'pull_request',
    head_sha:sourceSha,repository:{id:42},head_repository:{id:42}};
  const successful={...common,id:10,run_number:10,run_attempt:1,status:'completed',conclusion:'success'};
  const failed={...common,id:11,run_number:11,run_attempt:1,status:'completed',conclusion:'failure'};
  assert.throws(()=>selectFrontendProducerRun([successful,failed],{repositoryId:42,workflowId:72,sourceSha}),/Latest frontend producer run/);
  assert.throws(()=>selectFrontendProducerRun([{...successful,head_repository:{id:99}}],{repositoryId:42,workflowId:72,sourceSha}),/No exact frontend producer run/);
  assert.equal(selectFrontendProducerRun([successful],{repositoryId:42,workflowId:72,sourceSha}).id,10);
});

test('frontend selector preselects exact pending main proof, but pending proof cannot satisfy deployment',()=>{
  const current={id:51,run_number:9,path:'.github/workflows/verify.yml',event:'push',head_branch:'main',head_sha:sourceSha,status:'completed',conclusion:'success',repository:{id:42,full_name:'yohn-jp/codexia',owner:{id:10}},head_repository:{id:42,full_name:'yohn-jp/codexia',owner:{id:10}}};
  const expected={sourceSha,repository:'yohn-jp/codexia',repositoryId:42,ownerId:10};
  assert.equal(selectExactMainVerifyRun([current],expected),current);
  const pending={...current,status:'in_progress',conclusion:null};
  assert.equal(selectExactMainVerifyRun([pending],expected),pending);
  assert.throws(()=>verifiedSourceRun([pending],sourceSha));
  assert.throws(()=>selectExactMainVerifyRun([{...current,conclusion:'failure'}],expected),/did not succeed/u);
  assert.throws(()=>selectExactMainVerifyRun([],expected),/available yet/u);
});

test('partial reruns may reuse a successful earlier build only when its artifact falls inside that attempt window',()=>{
  const result=evidence({currentAttempt:3,producerAttempt:2});
  assert.doesNotThrow(()=>assertFrontendArtifactEvidence(result.run,result.artifact,result.jobs,result.expected));
  const fullRerun=evidence({currentAttempt:3,producerAttempt:3,jobStartedAt:'2026-11-15T01:00:00Z',jobCompletedAt:'2026-11-15T01:05:00Z',artifactCreatedAt:'2026-11-15T01:03:00Z'});
  assert.doesNotThrow(()=>assertFrontendArtifactEvidence(fullRerun.run,fullRerun.artifact,fullRerun.jobs,fullRerun.expected));
});

test('frontend artifact provenance rejects wrong SHA, event, run, ID, digest, expiry, attempt, and stale producer output',()=>{
  const result=evidence({currentAttempt:3,producerAttempt:2});
  const {run,artifact,jobs,expected}=result;
  const rejected=[
    ()=>assertFrontendArtifactEvidence({...run,head_sha:'c'.repeat(40)},artifact,jobs,expected),
    ()=>assertFrontendArtifactEvidence({...run,event:'pull_request'},artifact,jobs,expected),
    ()=>assertFrontendArtifactEvidence({...run,run_attempt:2},artifact,jobs,expected),
    ()=>assertFrontendArtifactEvidence({...run,id:12346},artifact,jobs,expected),
    ()=>assertFrontendArtifactEvidence(run,{...artifact,id:67891},jobs,expected),
    ()=>assertFrontendArtifactEvidence(run,{...artifact,digest:`sha256:${'c'.repeat(64)}`},jobs,expected),
    ()=>assertFrontendArtifactEvidence(run,{...artifact,expired:true},jobs,expected),
    ()=>assertFrontendArtifactEvidence(run,{...artifact,workflow_run:{...artifact.workflow_run,id:12346}},jobs,expected),
    ()=>assertFrontendArtifactEvidence(run,{...artifact,workflow_run:{...artifact.workflow_run,head_sha:'c'.repeat(40)}},jobs,expected),
    ()=>assertFrontendArtifactEvidence(run,artifact,[{...jobs[0],run_attempt:1}],expected),
    ()=>assertFrontendArtifactEvidence(run,{...artifact,created_at:'2026-11-15T00:08:00Z'},jobs,expected),
    ()=>assertFrontendArtifactEvidence(run,artifact,jobs,{...expected,artifactId:'bad'}),
  ];
  for(const check of rejected) assert.throws(check);
});

 test('GitHub partial rerun aliases the reused successful job to the current attempt',()=>{
  const {run,artifact,jobs,expected}=evidence({currentAttempt:2,producerAttempt:1});
  const latest=[{...jobs[0],run_attempt:2}];
  assert.doesNotThrow(()=>assertFrontendArtifactEvidence(run,artifact,latest,expected,jobs));
  assert.throws(()=>assertFrontendArtifactEvidence(run,artifact,latest,expected,latest));
  assert.throws(()=>assertFrontendArtifactEvidence(run,artifact,[{...latest[0],started_at:'2026-11-15T01:00:00Z',completed_at:'2026-11-15T01:05:00Z'}],expected,jobs));
});
