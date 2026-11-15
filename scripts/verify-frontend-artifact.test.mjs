import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertFrontendArtifactEvidence } from './verify-frontend-artifact.mjs';

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
