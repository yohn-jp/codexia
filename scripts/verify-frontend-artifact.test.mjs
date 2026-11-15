import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertFrontendArtifactEvidence } from './verify-frontend-artifact.mjs';

const sourceSha='a'.repeat(40);
const artifactDigest='b'.repeat(64);
const expected={runId:'12345',runAttempt:'2',sourceSha,artifactId:'67890',artifactName:`codexia-frontend-${sourceSha}`,artifactDigest};
const producerRun={id:12345,run_attempt:2,event:'push',head_branch:'main',head_sha:sourceSha};
const artifact={id:67890,name:expected.artifactName,expired:false,size_in_bytes:1024,digest:`sha256:${artifactDigest}`,workflow_run:{id:12345,head_branch:'main',head_sha:sourceSha}};

test('frontend artifact must come from this exact main-push producer run and match its digest',()=>{
  assert.doesNotThrow(()=>assertFrontendArtifactEvidence(producerRun,artifact,expected));
});

test('frontend artifact provenance rejects wrong source, event, attempt, run, ID, digest, expiry, or binding',()=>{
  const rejected=[
    ()=>assertFrontendArtifactEvidence({...producerRun,head_sha:'c'.repeat(40)},artifact,expected),
    ()=>assertFrontendArtifactEvidence({...producerRun,event:'pull_request'},artifact,expected),
    ()=>assertFrontendArtifactEvidence({...producerRun,run_attempt:1},artifact,expected),
    ()=>assertFrontendArtifactEvidence({...producerRun,id:12346},artifact,expected),
    ()=>assertFrontendArtifactEvidence(producerRun,{...artifact,id:67891},expected),
    ()=>assertFrontendArtifactEvidence(producerRun,{...artifact,digest:`sha256:${'c'.repeat(64)}`},expected),
    ()=>assertFrontendArtifactEvidence(producerRun,{...artifact,expired:true},expected),
    ()=>assertFrontendArtifactEvidence(producerRun,{...artifact,workflow_run:{...artifact.workflow_run,id:12346}},expected),
    ()=>assertFrontendArtifactEvidence(producerRun,{...artifact,workflow_run:{...artifact.workflow_run,head_sha:'c'.repeat(40)}},expected),
    ()=>assertFrontendArtifactEvidence(producerRun,artifact,{...expected,artifactId:'bad'}),
  ];
  for(const check of rejected) assert.throws(check);
});
