import assert from 'node:assert/strict';
import test from 'node:test';
import * as releaseRecord from './component-release-record.mjs';

test('frontend release metadata separates the merge source from immutable promoted asset identity',()=>{
  assert.equal(typeof releaseRecord.buildComponentReleaseRecord,'function','frontend release record builder is missing');
  const mainSha='a'.repeat(40),producerSha='b'.repeat(40),digest='c'.repeat(64),tree='d'.repeat(40);
  const identity={format:'codexia-frontend-identity/v1',version:'0.1.77',sourceSha:producerSha,profile:'full',apiEpoch:1};
  const producer={event:'pull_request',sourceSha:producerSha,version:'0.1.77',workflowRunId:123,workflowAttempt:2,
    workflowId:72,artifactId:456,artifactDigest:digest,profile:'full',apiEpoch:1,prNumber:17,verifyRunId:789,proofRunId:790,verifyAttempt:1,planDigest:'e'.repeat(64),
    sourceTree:tree,mergeBaseSha:'f'.repeat(40)};
  const release=releaseRecord.buildComponentReleaseRecord('frontend',mainSha,identity,producer,tree);
  assert.equal(release.tag,'frontend-v0.1.77');
  assert.equal(release.targetSha,mainSha);
  assert.equal(release.metadata.sourceSha,mainSha);
  assert.equal(release.metadata.version,identity.version);
  assert.deepEqual(release.metadata.producer,{event:'pull_request',sourceSha:producerSha,version:'0.1.77',workflowRunId:123,workflowAttempt:2,
    artifactId:456,artifactDigest:'sha256:'+digest,profile:'full',apiEpoch:1,prNumber:17,workflowId:72,verifyRunId:789,proofRunId:790,
    verifyAttempt:1,planDigest:'e'.repeat(64),sourceTree:tree,mergeBaseSha:'f'.repeat(40)});
  assert.throws(()=>releaseRecord.buildComponentReleaseRecord('frontend',mainSha,identity,{...producer,sourceSha:'9'.repeat(40)}),/producer source/);
  assert.throws(()=>releaseRecord.buildComponentReleaseRecord('frontend',mainSha,identity,{...producer,version:'0.1.76'}),/producer version/);
});
