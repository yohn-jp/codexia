import assert from 'node:assert/strict';
import test from 'node:test';
import * as releaseRecord from './record-model.mjs';
import { readComponentVersion } from './version.mjs';
const context = { repository: 'yohn-jp/codexia', repositoryId: 100, ownerId: 50 };
const buildRecord = (component, source, identity, producer, tree) =>
  releaseRecord.buildComponentReleaseRecord(component, source, identity, producer, tree, context);


test('backend source proof uses the release publication time and the workflow windows', () => {
  const release = { created_at:'2026-11-15T16:24:04Z', published_at:'2026-11-15T16:33:36Z' };
  const run = { created_at:'2026-11-15T16:24:07Z', updated_at:'2026-11-15T16:33:40Z' };
  assert.equal(releaseRecord.publicationInWorkflowWindow(release, run), true);
  assert.equal(releaseRecord.publicationInWorkflowWindow({ ...release, published_at: null }, run), false);
  assert.equal(releaseRecord.publicationInWorkflowWindow({ ...release, published_at: '2026-11-15T16:33:41Z' }, run), false);
});

test('frontend release metadata separates the merge source from immutable promoted asset identity',()=>{
  assert.equal(typeof releaseRecord.buildComponentReleaseRecord,'function','frontend release record builder is missing');
  const mainSha='a'.repeat(40),producerSha='b'.repeat(40),digest='c'.repeat(64),tree='d'.repeat(40);
  const identity={format:'codexia-frontend-identity/v1',version:'0.1.77',sourceSha:producerSha,profile:'full',apiEpoch:1};
  const producer={event:'pull_request',sourceSha:producerSha,version:'0.1.77',workflowRunId:123,workflowAttempt:2,
    workflowId:72,artifactId:456,artifactDigest:digest,profile:'full',apiEpoch:1,prNumber:17,verifyRunId:789,proofRunId:790,verifyAttempt:1,planDigest:'e'.repeat(64),
    sourceTree:tree,mergeBaseSha:'f'.repeat(40)};
  const release=buildRecord('frontend',mainSha,identity,producer,tree);
  assert.equal(release.tag,'frontend-v0.1.77');
  assert.equal(release.targetSha,mainSha);
  assert.equal(release.metadata.sourceSha,mainSha);
  assert.equal(release.metadata.version,identity.version);
  assert.deepEqual(release.metadata.producer,{event:'pull_request',sourceSha:producerSha,version:'0.1.77',workflowRunId:123,workflowAttempt:2,
    artifactId:456,artifactDigest:'sha256:'+digest,profile:'full',apiEpoch:1,prNumber:17,workflowId:72,verifyRunId:789,proofRunId:790,
    verifyAttempt:1,planDigest:'e'.repeat(64),sourceTree:tree,mergeBaseSha:'f'.repeat(40)});
  assert.throws(()=>buildRecord('frontend',mainSha,identity,{...producer,sourceSha:'9'.repeat(40)}),/producer source/);
  assert.throws(()=>buildRecord('frontend',mainSha,identity,{...producer,version:'0.1.76'}),/producer version/);
});

test('main-built frontend release binds the target and keeps its lowercase release title',()=>{
  const sourceSha='9'.repeat(40),digest='8'.repeat(64);
  const identity={format:'codexia-frontend-identity/v1',version:'0.1.77',sourceSha,profile:'full',apiEpoch:1};
  const producer={event:'push',sourceSha,version:identity.version,workflowRunId:123,workflowAttempt:2,artifactId:456,
    artifactDigest:digest,profile:'full',apiEpoch:1};
  const release=buildRecord('frontend',sourceSha,identity,producer,'7'.repeat(40));
  const metadata={component:'frontend',version:identity.version,sourceSha,profile:'full',requiredApiEpoch:1,worker:'codexia-frontend',...context};
  assert.equal(release.title,'frontend v0.1.77');
  assert.deepEqual(release.metadata,metadata);
  assert.equal(release.body,'Certified component release.\n\n```json\n'+JSON.stringify(metadata,null,2)+'\n```');
});

test('backend promotion records main authority separately from both immutable image producers',()=>{
  const mainSha='1'.repeat(40),producerSha='2'.repeat(40),tree='3'.repeat(40),base='4'.repeat(40);
  const version=readComponentVersion('backend','450');
  const compatibility={apiEpoch:1,persistenceFormat:1};
  const image=char=>'ghcr.io/yohn-jp/codexia-backend@sha256:'+char.repeat(64);
  const identity=profile=>({format:'codexia-backend-identity/v1',version,sourceSha:producerSha,profile,platform:'linux/amd64',
    migrationFingerprint:'sha256:'+'5'.repeat(64),apiEpoch:1,persistenceFormat:1});
  const receipt={...context,format:'codexia-backend-promotion/v1',event:'pull_request',sourceSha:producerSha,version,workflowRunId:600,
    workflowRunNumber:450,workflowAttempt:2,workflowId:72,prNumber:23,verifyRunId:610,proofRunId:611,verifyAttempt:1,
    planDigest:'6'.repeat(64),sourceTree:tree,mergeBaseSha:base,mainSha,
    artifacts:{core:{id:701,digest:'sha256:'+'7'.repeat(64),producerAttempt:2,archiveSha256:'8'.repeat(64),identity:identity('core')},
      full:{id:702,digest:'sha256:'+'9'.repeat(64),producerAttempt:2,archiveSha256:'a'.repeat(64),identity:identity('full')}}};
  const release=buildRecord('backend',mainSha,null,{core:image('b'),full:image('c'),compatibility,event:'pull_request',receipt,mainTree:tree});
  assert.equal(release.targetSha,mainSha);
  assert.equal(release.tag,'backend-v'+version);
  assert.equal(release.metadata.sourceSha,mainSha);
  assert.deepEqual(release.metadata.images,{core:image('b'),full:image('c')});
  assert.deepEqual(release.metadata.producer,{event:'pull_request',sourceSha:producerSha,version,workflowRunId:600,workflowRunNumber:450,
    workflowAttempt:2,workflowId:72,prNumber:23,verifyRunId:610,proofRunId:611,verifyAttempt:1,planDigest:'6'.repeat(64),sourceTree:tree,
    mergeBaseSha:base,artifacts:{core:{id:701,digest:'sha256:'+'7'.repeat(64),producerAttempt:2,archiveSha256:'8'.repeat(64)},
      full:{id:702,digest:'sha256:'+'9'.repeat(64),producerAttempt:2,archiveSha256:'a'.repeat(64)}}});
  assert.throws(()=>buildRecord('backend',mainSha,null,{core:image('b'),full:image('c'),compatibility,event:'pull_request',
    receipt:{...receipt,sourceTree:'f'.repeat(40)},mainTree:tree}),/tree differs/);
});

test('main-built backend release binds the target and version',()=>{
  const sourceSha='a'.repeat(40),compatibility={apiEpoch:1,persistenceFormat:1};
  const version=readComponentVersion('backend');
  const image=char=>'ghcr.io/yohn-jp/codexia-backend@sha256:'+char.repeat(64);
  const release=buildRecord('backend',sourceSha,null,{core:image('b'),full:image('c'),compatibility});
  assert.equal(release.tag,'backend-v'+version);
  assert.equal(release.targetSha,sourceSha);
  assert.deepEqual(release.metadata,{component:'backend',version,sourceSha,providedApiEpoch:1,persistenceFormat:1,images:{core:image('b'),full:image('c')},...context});
});

test('main fallback release records the exact build artifacts separately from main authority',()=>{
  const sourceSha='b'.repeat(40),tree='c'.repeat(40),compatibility={apiEpoch:1,persistenceFormat:1};
  const version=readComponentVersion('backend','451'),image=char=>'ghcr.io/yohn-jp/codexia-backend@sha256:'+char.repeat(64);
  const receipt={...context,format:'codexia-backend-build/v1',event:'push',sourceSha,version,workflowRunId:700,workflowRunNumber:451,sourceTree:tree,
    artifacts:{core:{id:701,digest:'sha256:'+'1'.repeat(64),producerAttempt:2,archiveSha256:'2'.repeat(64)},
      full:{id:702,digest:'sha256:'+'3'.repeat(64),producerAttempt:2,archiveSha256:'4'.repeat(64)}}};
  const record=buildRecord('backend',sourceSha,null,{core:image('5'),full:image('6'),compatibility,event:'push',receipt,mainTree:tree});
  assert.equal(record.targetSha,sourceSha);
  assert.equal(record.metadata.sourceSha,sourceSha);
  assert.equal(record.metadata.version,version);
  assert.deepEqual(record.metadata.producer,{event:'push',sourceSha,version,workflowRunId:700,workflowRunNumber:451,sourceTree:tree,
    artifacts:{core:{id:701,digest:'sha256:'+'1'.repeat(64),producerAttempt:2,archiveSha256:'2'.repeat(64)},
      full:{id:702,digest:'sha256:'+'3'.repeat(64),producerAttempt:2,archiveSha256:'4'.repeat(64)}}});
  const completion=buildRecord('backend',sourceSha,null,{core:image('5'),full:image('6'),compatibility,event:'workflow_run',receipt:{...receipt,event:'workflow_run'},mainTree:tree});
  assert.equal(completion.metadata.producer.event,'workflow_run');
  const completionEnv={GITHUB_EVENT_NAME:'workflow_run',GITHUB_SHA:'d'.repeat(40),GITHUB_RUN_ID:'700',CODEXIA_VERIFY_RUN_ID:'702'};
  const publication=releaseRecord.backendPublicationFromEnvironment(completionEnv,sourceSha);
  const historicalProducer={core:image('5'),full:image('6'),compatibility,event:'workflow_run',receipt:{...receipt,event:'workflow_run'},mainTree:tree,publication};
  const historical=buildRecord('backend',sourceSha,null,historicalProducer);
  assert.equal(historical.targetSha,sourceSha);
  assert.deepEqual(historical.metadata.publication,{event:'workflow_run',workflowHeadSha:'d'.repeat(40),workflowRunId:700,verifyRunId:702});
  assert.throws(()=>buildRecord('backend',sourceSha,null,{
    ...historicalProducer,publication:{...publication,workflowRunId:703},
  }),/another publication workflow/);
  assert.equal(releaseRecord.backendPublicationFromEnvironment({...completionEnv,GITHUB_SHA:sourceSha},sourceSha),undefined);
  assert.throws(()=>buildRecord('backend',sourceSha,null,{core:image('5'),full:image('6'),compatibility,
    event:'push',receipt:{...receipt,artifacts:{...receipt.artifacts,core:{...receipt.artifacts.core,id:702}}},mainTree:tree}),/distinct/);
});

test('a fork publishes only Backend digests in its own owner namespace', () => {
  const fork = { repository: 'Fork-Owner/codexia', repositoryId: 200, ownerId: 60 };
  const producer = {
    core: 'ghcr.io/fork-owner/codexia-backend@sha256:' + 'a'.repeat(64),
    full: 'ghcr.io/fork-owner/codexia-backend@sha256:' + 'b'.repeat(64),
    compatibility: { apiEpoch: 1, persistenceFormat: 1 },
  };
  const source = 'a'.repeat(40);
  const release = releaseRecord.buildComponentReleaseRecord('backend', source, null, producer, undefined, fork);
  assert.equal(release.metadata.repositoryId, fork.repositoryId);
  assert.equal(release.metadata.images.full, producer.full);
  assert.throws(() => buildRecord('backend', source, null, producer), /deployment repository owner/);
});
