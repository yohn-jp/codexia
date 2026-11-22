import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { buildComponentReleaseRecord } from './component-release-record.mjs';
import { assertExistingBackendReleaseBinding, backendReleaseSourceTree, successfulPublicationJobs } from './verify-existing-backend-release.mjs';
import { readComponentVersion } from './component-release-version.mjs';

const sha=char=>char.repeat(40),image=char=>'ghcr.io/yohn-jp/codexia-backend@sha256:'+char.repeat(64);
const compatibility={apiEpoch:1,persistenceFormat:1};

test('resolves the historical Git tree bound to a release even after a newer checkout', async t => {
  const repository = await mkdtemp(path.join(tmpdir(), 'codexia-release-tree-'));
  t.after(() => rm(repository, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: repository, encoding: 'utf8' }).trim();
  git('init', '-q');
  git('config', 'user.name', 'Release Test');
  git('config', 'user.email', 'release-test@example.invalid');
  const file = path.join(repository, 'artifact-input.txt');
  await writeFile(file, 'certified source\n');
  git('add', 'artifact-input.txt');
  const certifiedTree = git('write-tree');
  git('commit', '-qm', 'Certified source');
  const certifiedSha = git('rev-parse', 'HEAD');
  await writeFile(file, 'newer source\n');
  git('add', 'artifact-input.txt');
  assert.notEqual(git('write-tree'), certifiedTree);
  git('commit', '-qm', 'Newer source');

  const module = new URL('./verify-existing-backend-release.mjs', import.meta.url);
  const result = execFileSync(process.execPath, ['--input-type=module', '-e', `
    import { backendReleaseSourceTree } from ${JSON.stringify(module.href)};
    console.log(backendReleaseSourceTree(process.argv[1]));
  `, certifiedSha], { cwd: repository, encoding: 'utf8' });
  assert.equal(result.trim(), certifiedTree);
  assert.throws(() => backendReleaseSourceTree('HEAD'), /source SHA is invalid/u);
});

function promotedFixture(){
  const mainSha=sha('a'),sourceSha=sha('b'),tree=sha('c'),version=readComponentVersion('backend','450');
  const identity=profile=>({format:'codexia-backend-identity/v1',version,sourceSha,profile,platform:'linux/amd64',
    migrationFingerprint:'sha256:'+'d'.repeat(64),apiEpoch:1,persistenceFormat:1});
  const receipt={format:'codexia-backend-promotion/v1',event:'pull_request',sourceSha,version,workflowRunId:451,workflowRunNumber:450,
    workflowAttempt:2,workflowId:31,prNumber:8,verifyRunId:452,proofRunId:453,verifyAttempt:1,planDigest:'e'.repeat(64),sourceTree:tree,
    mergeBaseSha:sha('f'),mainSha,artifacts:{core:{id:454,digest:'sha256:'+'1'.repeat(64),producerAttempt:2,archiveSha256:'2'.repeat(64),identity:identity('core')},
      full:{id:455,digest:'sha256:'+'3'.repeat(64),producerAttempt:2,archiveSha256:'4'.repeat(64),identity:identity('full')}}};
  const record=buildComponentReleaseRecord('backend',mainSha,null,{core:image('5'),full:image('6'),compatibility,event:'pull_request',receipt,mainTree:tree});
  return {mainSha,sourceSha,version,receipt,record,release:{tag_name:record.tag,draft:false,prerelease:false,body:record.body},tagRef:{object:{type:'commit',sha:mainSha}}};
}

test('immutable digest retry requires a prior release with the exact producer receipt and main tag',()=>{
  const fixture=promotedFixture();
  const expected={image:fixture.record.metadata.images.core,mainSha:fixture.mainSha,producerSha:fixture.sourceSha,version:fixture.version,
    profile:'core',event:'pull_request',receipt:fixture.receipt,mainTree:fixture.receipt.sourceTree,compatibility};
  assert.deepEqual(assertExistingBackendReleaseBinding(fixture.release,fixture.tagRef,expected),fixture.record.metadata);
  const changed=JSON.parse(fixture.release.body.match(/```json\s*\n([\s\S]*?)\n```/u)[1]);
  changed.producer.artifacts.core.id+=100;
  const forged={...fixture.release,body:'Certified component release.\n\n```json\n'+JSON.stringify(changed)+'\n```'};
  assert.throws(()=>assertExistingBackendReleaseBinding(forged,fixture.tagRef,expected),/exact promoted producer receipt/);
  assert.throws(()=>assertExistingBackendReleaseBinding(fixture.release,{object:{type:'commit',sha:sha('9')}},expected),/main source mismatch/);
  assert.throws(()=>assertExistingBackendReleaseBinding(fixture.release,fixture.tagRef,{...expected,image:image('8')}),/immutable registry digest/);
});

test('main fallback digest retry requires the exact build artifact receipt',()=>{
  const mainSha=sha('a'),tree=sha('b'),version=readComponentVersion('backend','450');
  const receipt={format:'codexia-backend-build/v1',event:'push',sourceSha:mainSha,version,workflowRunId:451,workflowRunNumber:450,
    sourceTree:tree,artifacts:{core:{id:452,digest:'sha256:'+'1'.repeat(64),producerAttempt:2,archiveSha256:'2'.repeat(64)},
      full:{id:453,digest:'sha256:'+'3'.repeat(64),producerAttempt:2,archiveSha256:'4'.repeat(64)}}};
  const core=image('5'),full=image('6');
  const record=buildComponentReleaseRecord('backend',mainSha,null,{core,full,compatibility,event:'push',receipt,mainTree:tree});
  const release={tag_name:record.tag,draft:false,prerelease:false,body:record.body},tagRef={object:{type:'commit',sha:mainSha}};
  const expected={image:core,mainSha,producerSha:mainSha,version,profile:'core',event:'push',receipt,mainTree:tree,compatibility};
  assert.deepEqual(assertExistingBackendReleaseBinding(release,tagRef,expected),record.metadata);
  const completedReceipt={...receipt,event:'workflow_run'};
  const completedRecord=buildComponentReleaseRecord('backend',mainSha,null,{core,full,compatibility,event:'workflow_run',receipt:completedReceipt,mainTree:tree});
  const completedRelease={...release,body:completedRecord.body};
  assert.deepEqual(assertExistingBackendReleaseBinding(completedRelease,tagRef,{...expected,event:'workflow_run',receipt:completedReceipt}),completedRecord.metadata);
  const changed=structuredClone(receipt);changed.artifacts.core.digest='sha256:'+'7'.repeat(64);
  assert.throws(()=>assertExistingBackendReleaseBinding(release,tagRef,{...expected,receipt:changed}),/exact main build receipt/);
  assert.throws(()=>assertExistingBackendReleaseBinding(release,tagRef,{...expected,mainTree:sha('9')}),/tree differs/);
});

test('existing digest requires successful prior main publication jobs for its path',()=>{
  const main=[
    {name:'Resolve verified backend promotion',status:'completed',conclusion:'success'},
    {name:'Build and test backend OCI image (core)',status:'completed',conclusion:'success'},
    {name:'Build and test backend OCI image (full)',status:'completed',conclusion:'success'},
    {name:'Publish immutable GHCR image',status:'completed',conclusion:'success'},
  ];
  const promoted=[
    {name:'Resolve verified backend promotion',status:'completed',conclusion:'success'},
    {name:'Build and test backend OCI image (core)',status:'completed',conclusion:'skipped'},
    {name:'Build and test backend OCI image (full)',status:'completed',conclusion:'skipped'},
    {name:'Publish immutable GHCR image',status:'completed',conclusion:'success'},
  ];
  assert.equal(successfulPublicationJobs(main,false,true),true);
  assert.equal(successfulPublicationJobs(promoted,true),true);
  assert.equal(successfulPublicationJobs(promoted,false),false);
  assert.equal(successfulPublicationJobs(main.map(job=>job.name.includes('(core)')?{...job,conclusion:'failure'}:job),false),false);
});

test('promoted publication accepts the REST aggregate for a skipped matrix without weakening producer checks',()=>{
  const promotedAggregate=[
    {name:'Resolve verified backend promotion',status:'completed',conclusion:'success'},
    {name:'Build and test backend OCI image (${{ matrix.profile }})',status:'completed',conclusion:'skipped'},
    {name:'Publish immutable GHCR image',status:'completed',conclusion:'success'},
  ];
  assert.equal(successfulPublicationJobs(promotedAggregate,true,true),true);
  assert.equal(successfulPublicationJobs(promotedAggregate,false,true),false,
    'the skipped aggregate cannot stand in for main Core and Full build jobs');
  assert.equal(successfulPublicationJobs(promotedAggregate,true,false),true);
  assert.equal(successfulPublicationJobs(promotedAggregate.map(job=>job.name.startsWith('Build and test')
    ? {...job,conclusion:'failure'} : job),true,true),false);
  assert.equal(successfulPublicationJobs([...promotedAggregate,
    {...promotedAggregate[1]}],true,true),false,'duplicate aggregate jobs must fail');
});
