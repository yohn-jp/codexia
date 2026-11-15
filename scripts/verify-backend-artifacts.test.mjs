import assert from 'node:assert/strict';
import { test } from 'node:test';
import { selectBackendArtifacts, assertBackendProducerAttempt } from './verify-backend-artifacts.mjs';

const sha='a'.repeat(40), digest='sha256:'+'b'.repeat(64);
const expected={runId:123,currentAttempt:3,sourceSha:sha};
const run={id:123,run_attempt:3,event:'push',head_branch:'main',head_sha:sha};
const window1={started_at:'2026-11-15T00:00:00Z',completed_at:'2026-11-15T00:05:00Z'};
const window3={started_at:'2026-11-15T01:00:00Z',completed_at:'2026-11-15T01:05:00Z'};
function job(profile,attempt,window){return {name:'Build and test backend OCI image ('+profile+')',head_sha:sha,run_id:123,run_attempt:attempt,status:'completed',conclusion:'success',...window};}
function artifact(profile,attempt,id,created){return {id,name:'codexia-backend-image-'+sha+'-'+profile+'-attempt-'+attempt,created_at:created,expired:false,digest,size_in_bytes:250422296,workflow_run:{id:123,head_sha:sha}};}
function fixture(){return {jobs:[job('core',3,window1),job('full',3,window3)],artifacts:[
  artifact('core',1,10,'2026-11-15T00:03:00Z'),artifact('full',1,11,'2026-11-15T00:03:00Z'),
  artifact('full',3,12,'2026-11-15T01:03:00Z')]};}

test('partial rerun selects the prior Core and newly verified Full attempt by actual producer window',()=>{
  const {jobs,artifacts}=fixture();
  const result=selectBackendArtifacts(run,artifacts,jobs,expected);
  assert.deepEqual(result.map(item=>[item.profile,item.artifact.id,item.producerAttempt]),[['core',10,1],['full',12,3]]);
  assert.doesNotThrow(()=>assertBackendProducerAttempt(result[0],[job('core',1,window1)],expected));
  assert.doesNotThrow(()=>assertBackendProducerAttempt(result[1],[job('full',3,window3)],expected));
  assert.throws(()=>assertBackendProducerAttempt(result[0],[job('core',3,window1)],expected),/attempt mismatch/);
  assert.throws(()=>assertBackendProducerAttempt(result[0],[job('core',1,window3)],expected),/Missing fresh/);
});

test('full rerun can upload new immutable names without accepting a stale previous attempt',()=>{
  const {artifacts}=fixture();
  artifacts.push(artifact('core',3,13,'2026-11-15T01:02:00Z'));
  const jobs=[job('core',3,window3),job('full',3,window3)];
  assert.deepEqual(selectBackendArtifacts(run,artifacts,jobs,expected).map(item=>item.artifact.id),[13,12]);
  assert.throws(()=>selectBackendArtifacts(run,artifacts.filter(item=>item.id!==13),jobs,expected),/one fresh/);
});

test('backend evidence fails closed on duplicate, wrong run, SHA, digest, expired or failed producer',()=>{
  const {jobs,artifacts}=fixture();
  for(const change of [
    {expired:true},{digest:'bad'},{size_in_bytes:999999999},{workflow_run:{id:456,head_sha:sha}},
    {workflow_run:{id:123,head_sha:'c'.repeat(40)}},
  ]){
    assert.throws(()=>selectBackendArtifacts(run,artifacts.map(item=>item.id===12?{...item,...change}:item),jobs,expected));
  }
  assert.throws(()=>selectBackendArtifacts(run,[...artifacts,{...artifacts[2],id:99}],jobs,expected),/one fresh/);
  assert.throws(()=>selectBackendArtifacts({...run,event:'pull_request'},artifacts,jobs,expected),/must be a push/);
  assert.throws(()=>selectBackendArtifacts({...run,run_attempt:2},artifacts,jobs,expected),/attempt mismatch/);
  assert.throws(()=>selectBackendArtifacts(run,artifacts,[jobs[0],{...jobs[1],conclusion:'failure'}],expected),/did not succeed/);
  assert.throws(()=>selectBackendArtifacts(run,artifacts,[...jobs,jobs[1]],expected),/exactly one latest/);
  assert.throws(()=>selectBackendArtifacts(run,artifacts.map(item=>item.id===12?{...item,name:item.name.replace('attempt-3','attempt-4')}:item),jobs,expected),/newer than current/);
});
